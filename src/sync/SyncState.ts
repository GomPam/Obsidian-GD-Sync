import { App } from 'obsidian';

export interface FileSyncData {
    driveId: string;
    lastSyncTime: number; // 로컬 파일의 마지막 동기화 시간 (mtime)
    mimeType?: string;
}

export interface SyncLog {
    timestamp: number;
    action: 'upload' | 'download' | 'conflict' | 'error';
    fileName: string;
    details?: string;
}

export interface SyncIndex {
    files: Record<string, FileSyncData>;
    folders?: Record<string, string>; // 폴더 경로 -> Drive ID 매핑 추가
    lastFullSyncMs?: number;
    targetFolderId?: string;
    trashFolderId?: string;
    syncHistory?: SyncLog[];
    startPageToken?: string; // Delta Sync용 토큰
    localQueue?: {
        action: 'upload' | 'delete' | 'rename';
        path: string;
        oldPath?: string;
        timestamp: number;
        _retryCount?: number;
    }[];
}

// 로컬 파일과 구글 드라이브 ID 사이의 매핑 및 상태를 관리하는 파일(DB) 인터페이스
export class SyncState {
    private indexPath: string;
    private index: SyncIndex = { files: {} };
    // SEC-H04: Serialized write queue to prevent race conditions from concurrent save() calls.
    private _saveQueue: Promise<void> = Promise.resolve();

    constructor(private app: App, pluginId: string = 'gd-sync') {
        // 플러그인 루트 경로 (예: .obsidian/plugins/gd-sync/.gd-sync.db)
        this.indexPath = `${this.app.vault.configDir}/plugins/${pluginId}/.gd-sync.db`;
    }

    async load(): Promise<void> {
        if (await this.app.vault.adapter.exists(this.indexPath)) {
            const data = await this.app.vault.adapter.read(this.indexPath);
            try {
                this.index = JSON.parse(data) as SyncIndex;
                if (!this.index.files) this.index.files = {};
                if (!this.index.folders) this.index.folders = {};
            } catch (err) {
                console.error("GD Sync: Failed to parse .gd-sync.db", err);
                // 파싱 에러시 초기화
                this.index = { files: {}, folders: {} };
            }
        }
    }

    async save(): Promise<void> {
        // Chain onto the previous save operation so writes are serialized.
        // Each call captures the latest in-memory index at execution time (not at enqueue time),
        // ensuring the most recent state is always persisted.
        this._saveQueue = this._saveQueue.then(async () => {
            await this.app.vault.adapter.write(this.indexPath, JSON.stringify(this.index, null, 2));
        }).catch(err => {
            console.error("[GD Sync] save() failed:", err);
        });
        await this._saveQueue;
    }

    // 접근자 메서드들
    getFileData(localPath: string): FileSyncData | undefined {
        return this.index.files[localPath];
    }

    setFileData(localPath: string, data: FileSyncData) {
        this.index.files[localPath] = data;
    }

    removeFileData(localPath: string) {
        delete this.index.files[localPath];
    }

    renameFileData(oldPath: string, newPath: string) {
        if (this.index.files[oldPath]) {
            this.index.files[newPath] = this.index.files[oldPath]!;
            delete this.index.files[oldPath];
        }
    }

    getAllFiles(): Record<string, FileSyncData> {
        return this.index.files;
    }

    getAllFolders(): Record<string, string> {
        return this.index.folders || {};
    }

    getFolderId(localPath: string): string | undefined {
        return this.index.folders?.[localPath];
    }

    setFolderId(localPath: string, driveId: string) {
        if (!this.index.folders) this.index.folders = {};
        this.index.folders[localPath] = driveId;
    }

    removeFolderData(localPath: string) {
        if (this.index.folders) {
            delete this.index.folders[localPath];
        }
    }

    renameFolderData(oldPath: string, newPath: string) {
        if (this.index.folders && this.index.folders[oldPath]) {
            this.index.folders[newPath] = this.index.folders[oldPath]!;
            delete this.index.folders[oldPath];
        }
    }

    getTargetFolderId(): string | undefined {
        return this.index.targetFolderId;
    }

    setTargetFolderId(id: string) {
        this.index.targetFolderId = id;
    }

    getTrashFolderId(): string | undefined {
        return this.index.trashFolderId;
    }

    setTrashFolderId(id: string) {
        this.index.trashFolderId = id;
    }

    getStartPageToken(): string | undefined {
        return this.index.startPageToken;
    }

    setStartPageToken(token: string) {
        this.index.startPageToken = token;
    }

    // ─── Local Queue (Offline Support) ───

    addToLocalQueue(item: Omit<NonNullable<SyncIndex['localQueue']>[0], 'timestamp'> & { _retryCount?: number }) {
        if (!this.index.localQueue) this.index.localQueue = [];
        
        // V2-L05: Remove duplicate action/path combination to avoid unbounded growth
        const existingIdx = this.index.localQueue.findIndex(q => q.action === item.action && q.path === item.path);
        
        let retryCount = item._retryCount || 0;
        if (existingIdx !== -1) {
            // Inherit retry count if replacing an old item
            retryCount = Math.max(retryCount, this.index.localQueue[existingIdx]?._retryCount || 0);
            // remove old one
            this.index.localQueue.splice(existingIdx, 1);
        }
        
        // V2-M03: Limit retry count to 3
        if (retryCount > 3) {
            this.addSyncLog({ action: 'error', fileName: item.path, details: `Queue item dropped after 3 retries (${item.action})` });
            return; // Drop it
        }

        this.index.localQueue.push({
            ...item,
            _retryCount: retryCount,
            timestamp: Date.now()
        });
    }

    getLocalQueue() {
        return this.index.localQueue || [];
    }

    clearLocalQueue() {
        this.index.localQueue = [];
    }

    addSyncLog(log: Omit<SyncLog, 'timestamp'>) {
        if (!this.index.syncHistory) this.index.syncHistory = [];
        this.index.syncHistory.unshift({
            ...log,
            timestamp: Date.now()
        });
        // 최대 100개까지만 보관
        if (this.index.syncHistory.length > 100) {
            this.index.syncHistory = this.index.syncHistory.slice(0, 100);
        }
    }

    async clearAll() {
        this.index = { files: {}, folders: {} };
        await this.save();
    }

    async clearSyncIndex() {
        const { targetFolderId, trashFolderId } = this.index;
        this.index = {
            files: {},
            folders: {},
            targetFolderId,
            trashFolderId
        };
        await this.save();
    }

    getSyncHistory(): SyncLog[] {
        return this.index.syncHistory || [];
    }
}
