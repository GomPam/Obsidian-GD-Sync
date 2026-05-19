import { Notice, TFile, TFolder, TAbstractFile } from 'obsidian';
import { GoogleDriveClient, GoogleDriveFile } from '../api/GoogleDriveClient';
import { SyncState, FileSyncData } from './SyncState';
import { t } from '../lang/helpers';
import GDSyncPlugin from '../main';

interface UploadOptions {
    skipPrepare?: boolean;   // prepareFolders 스킵 (Full Sync에서 이미 완료)
    skipMove?: boolean;      // renameAndMove 스킵 (경로 미변경 시)
    skipSave?: boolean;      // state.save 스킵 (배치 저장용)
    skipNotice?: boolean;    // 파일별 Notice 알림 스킵
}

const FULL_SYNC_OPTS: UploadOptions = {
    skipPrepare: true,
    skipMove: true,
    skipSave: true,
    skipNotice: true
};

export class SyncManager {
    public driveClient: GoogleDriveClient;
    public state: SyncState;
    private isSyncing: boolean = false;
    private folderIdCache: Map<string, string> = new Map();
    private errorCount: number = 0; // SEC-H01: Track continuous errors
    
    // Concurrency locks for folder creation
    private remoteFolderLocks: Map<string, Promise<string>> = new Map();
    private localFolderLocks: Map<string, Promise<void>> = new Map();
    private resolvedRootId: string | null = null;

    constructor(private plugin: GDSyncPlugin) {
        this.driveClient = new GoogleDriveClient(plugin);
        this.state = new SyncState(plugin.app);
    }

    private recentlyDownloaded: Set<string> = new Set();
    private foldersReady: boolean = false;
    public customExtsCache: Set<string> = new Set();

    public updateCustomExtensionsCache() {
        const extList = (this.plugin.settings.customExtensions || '')
            .split(',')
            .map(s => s.trim().toLowerCase().replace(/^\./, ''))
            .filter(s => s.length > 0);
        this.customExtsCache = new Set(extList);
    }

    async initialize() {
        await this.state.load();

        this.updateCustomExtensionsCache();

        // 폴더 캐시 워밍업 (API 절약)
        const folders = this.state.getAllFolders();
        for (const [path, id] of Object.entries(folders)) {
            this.folderIdCache.set(path, id);
        }
        this.plugin.updateSyncStatus(t("STATUS_READY"));
    }

    private async getTargetFolderIdResolved(): Promise<string> {
        let targetId = this.state.getTargetFolderId()!;
        if (targetId === 'root') {
            if (this.resolvedRootId) {
                targetId = this.resolvedRootId;
            } else {
                const rootFile = await this.driveClient.getFile('root');
                if (rootFile) {
                    targetId = rootFile.id;
                    this.resolvedRootId = targetId;
                    this.state.setTargetFolderId(targetId);
                    await this.state.save();
                }
            }
        }
        return targetId;
    }

    // 동기화에 필요한 최상위 타겟 폴더와 휴지통 폴더 준비
    private async prepareFolders(): Promise<boolean> {
        if (this.foldersReady) return true;

        try {
            const folderName = this.plugin.settings.syncFolderName || 'GD_Sync';
            let targetId = this.state.getTargetFolderId();

            // 1. 최상위 백업 폴더 준비
            if (!targetId) {
                // 구글 드라이브 루트(root)에서 이름으로 검색
                let foundId = await this.driveClient.findFolder(folderName, 'root');
                if (!foundId) {
                    console.debug(`[GD Sync] Creating target folder: ${folderName}`);
                    foundId = await this.driveClient.createFolder(folderName, 'root');
                }
                targetId = foundId;
                this.state.setTargetFolderId(targetId);
            }

            // 2. 휴지통 폴더 준비
            let trashId = this.state.getTrashFolderId();
            if (!trashId) {
                let foundTrashId = await this.driveClient.findFolder('.trash', targetId);
                if (!foundTrashId) {
                    console.debug(`[GD Sync] 휴지통 폴더('.trash') 생성 중...`);
                    foundTrashId = await this.driveClient.createFolder('.trash', targetId);
                }
                trashId = foundTrashId;
                this.state.setTrashFolderId(trashId);
            }

            await this.state.save();
            this.foldersReady = true;
            return true;
        } catch (e) {
            console.error("[GD Sync] Folder preparation failed:", e);
            new Notice(t("NOTICE_SETUP_FAILED"));
            return false;
        }
    }

    // 로컬 상대 경로를 기반으로 구글 드라이브 내 폴더 생성/추적
    // skipFind: true일 때 findFolder 생략하고 바로 createFolder (원격에 없는 것이 확실한 경우)
    private async getOrCreateDrivePath(targetPath: string, isFolder: boolean = false, skipFind: boolean = false): Promise<string> {
        const targetRootId = await this.getTargetFolderIdResolved();

        const parts = targetPath.split('/');

        if (!isFolder) {
            parts.pop(); // 제일 끝 파일명 제거
        }

        if (parts.length === 0 || (parts.length === 1 && parts[0] === "")) {
            return targetRootId; // 루트 레벨
        }

        let currentParentId = targetRootId;
        let currentPath = "";

        for (const folderName of parts) {
            currentPath += (currentPath ? "/" : "") + folderName;

            if (this.folderIdCache.has(currentPath)) {
                currentParentId = this.folderIdCache.get(currentPath)!;
                continue;
            }

            if (this.remoteFolderLocks.has(currentPath)) {
                currentParentId = await this.remoteFolderLocks.get(currentPath)!;
                continue;
            }

            const createPromise = (async () => {
                let foundId: string | null = null;
                if (!skipFind) {
                    foundId = await this.driveClient.findFolder(folderName, currentParentId);
                }
                if (!foundId) {
                    console.debug(`[GD Sync] Creating folder: ${currentPath}`);
                    foundId = await this.driveClient.createFolder(folderName, currentParentId);
                }
                
                // 폴더 ID 상태 저장 (삭제/이름변경 추적용)
                this.state.setFolderId(currentPath, foundId);
                this.folderIdCache.set(currentPath, foundId);
                return foundId;
            })();

            this.remoteFolderLocks.set(currentPath, createPromise);
            try {
                currentParentId = await createPromise;
            } finally {
                this.remoteFolderLocks.delete(currentPath);
            }
        }

        return currentParentId;
    }

    // 동기화 제외 대상 (.trash 등) 판별
    private isIgnoredPath(filePath: string): boolean {
        return filePath === '.trash' || filePath.startsWith('.trash/')
            || filePath === this.plugin.app.vault.configDir || filePath.startsWith(this.plugin.app.vault.configDir + '/');
    }

    // 파일 확장자 필터링 (기본 지원 포맷 + 사용자 지정 포맷)
    public isAllowedExtension(filename: string): boolean {
        const defaultExtensions = ['md', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'mp3', 'webm', 'wav', 'm4a', 'ogg', '3gp', 'flac', 'mp4', 'ogv', 'mov', 'mkv', 'pdf', 'canvas'];
        
        const extMatch = filename.match(/\.([^.]+)$/);
        if (!extMatch || !extMatch[1]) return false; // 확장자가 없는 파일은 동기화 제외
        const ext = extMatch[1].toLowerCase();
        
        if (defaultExtensions.includes(ext)) return true;
        
        return this.customExtsCache.has(ext);
    }

    // 파일 확장자기반 MIME 반환 (V2-M02)
    private getMimeType(filename: string): string {
        const ext = filename.split('.').pop()?.toLowerCase();
        const mimeMap: Record<string, string> = {
            'md': 'text/markdown', 'txt': 'text/plain',
            'json': 'application/json', 'css': 'text/css',
            'js': 'text/javascript', 'html': 'text/html',
            'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
            'gif': 'image/gif', 'svg': 'image/svg+xml',
            'pdf': 'application/pdf', 'mp3': 'audio/mpeg',
            'mp4': 'video/mp4', 'webp': 'image/webp',
        };
        return mimeMap[ext || ''] || 'application/octet-stream';
    }

    // 로컬 단일 파일 업로드 (즉시 동기화 트리거용)
    async uploadFileImmediate(file: TFile, isFromFullSync: boolean = false, retryCount: number = 0, options: UploadOptions = {}) {
        if (this.isIgnoredPath(file.path) || !this.isAllowedExtension(file.name)) return;
        if (this.recentlyDownloaded.has(file.path)) return;

        // SEC-M07: 방어적 mtime 비교 (모바일 스크롤 자동저장으로 인한 불필요한 업로드 방지)
        if (!isFromFullSync) {
            const existingData = this.state.getFileData(file.path);
            if (existingData && file.stat.mtime <= existingData.lastSyncTime) {
                return;
            }
        }

        // If already syncing, and this isn't part of the current sync process, queue it.
        if (this.isSyncing && !isFromFullSync) {
            this.state.addToLocalQueue({ action: 'upload', path: file.path, _retryCount: retryCount });
            await this.state.save();
            return;
        }

        // Mark as syncing to prevent concurrent syncDelta or other uploads
        const originallySyncing = this.isSyncing;
        if (!originallySyncing) {
            this.isSyncing = true;
            this.plugin.setSyncBusy(true);
        }

        try {
            if (!options.skipPrepare) {
                const ready = await this.prepareFolders();
                if (!ready) {
                    this.state.addToLocalQueue({ action: 'upload', path: file.path, _retryCount: retryCount });
                    await this.state.save();
                    return;
                }
            }

            const targetFolderId = await this.getOrCreateDrivePath(file.path);

            // TODO: 10MB 초과 파일은 일단 베타에서 제외 (Multipart 업로드 제한 및 성능 고려)
            const fileSizeMB = file.stat.size / (1024 * 1024);
            if (fileSizeMB > 10) {
                new Notice(t('NOTICE_LARGE_FILE', { size: fileSizeMB.toFixed(1), name: file.name }));
                return;
            }

            const content = await this.plugin.app.vault.readBinary(file);

            let fileData = this.state.getFileData(file.path);

            if (fileData && fileData.driveId) {
                if (options.skipMove) {
                    // 콘텐츠 + modifiedTime만 한 번에 업데이트 (API 1회)
                    await this.driveClient.updateFile(fileData.driveId, content, this.getMimeType(file.name), file.stat.mtime);
                } else {
                    // 단건 업로드: 이름/위치 변경 가능성이 있으므로 renameAndMove 포함 (API 3회)
                    await this.driveClient.updateFile(fileData.driveId, content, this.getMimeType(file.name));
                    await this.driveClient.renameAndMove(fileData.driveId, file.name, targetFolderId, file.stat.mtime);
                }
                fileData.lastSyncTime = file.stat.mtime;
                this.state.setFileData(file.path, fileData);
            } else {
                const driveId = await this.driveClient.uploadFile(content, file.name, targetFolderId, this.getMimeType(file.name), file.stat.mtime);
                this.state.setFileData(file.path, {
                    driveId: driveId,
                    lastSyncTime: file.stat.mtime
                });
            }

            if (!options.skipSave) {
                await this.state.save();
            }

            if (!options.skipNotice) {
                new Notice(t("NOTICE_UPLOAD_COMPLETE", { name: file.name }));
            }

            this.plugin.updateSyncStatus(t("STATUS_LAST_SYNC", { time: new Date().toLocaleTimeString() }));
            this.state.addSyncLog({ action: 'upload', fileName: file.path });
        } catch (e) {
            console.error("[GD Sync] Single file upload failed:", e);
            this.state.addToLocalQueue({ action: 'upload', path: file.path, _retryCount: retryCount + 1 });
            await this.state.save();
        } finally {
            if (!originallySyncing) {
                this.isSyncing = false;
                this.plugin.setSyncBusy(false);
            }
        }
    }

    // 로컬 파일/폴더 삭제 시 구글 드라이브쪽 `.trash`로 이동
    async handleLocalDeleteImmediate(filePath: string, retryCount: number = 0) {
        if (this.isIgnoredPath(filePath)) return;
        if (this.isSyncing) {
            this.state.addToLocalQueue({ action: 'delete', path: filePath, _retryCount: retryCount });
            await this.state.save();
            return;
        }
        const ready = await this.prepareFolders();
        if (!ready) {
            this.state.addToLocalQueue({ action: 'delete', path: filePath, _retryCount: retryCount });
            await this.state.save();
            return;
        }

        // 1. 파일인지 확인
        let fileData = this.state.getFileData(filePath);
        if (fileData) {
            const trashId = this.state.getTrashFolderId()!;
            try {
                await this.driveClient.moveToFolder(fileData.driveId, trashId);
                this.state.removeFileData(filePath);
                await this.state.save();
                new Notice(t("NOTICE_DELETE_FILE", { name: filePath.split('/').pop() || 'unknown' }));
            } catch (e) {
                console.error("[GD Sync] Failed to move file to trash:", e);
                this.state.addToLocalQueue({ action: 'delete', path: filePath, _retryCount: retryCount + 1 });
                await this.state.save();
            }
            return;
        }

        // 2. 폴더인지 확인
        let folderId = this.state.getFolderId(filePath);
        if (folderId) {
            const trashId = this.state.getTrashFolderId()!;
            try {
                await this.driveClient.moveToFolder(folderId, trashId);
                this.state.removeFolderData(filePath);

                const prefix = filePath + '/';
                for (const key of Object.keys(this.state.getAllFiles())) {
                    if (key.startsWith(prefix)) this.state.removeFileData(key);
                }

                // V2-L04: Clean up subfolder indexes
                for (const key of Object.keys(this.state.getAllFolders())) {
                    if (key.startsWith(prefix)) {
                        this.state.removeFolderData(key);
                        this.folderIdCache.delete(key);
                    }
                }
                this.folderIdCache.delete(filePath);

                await this.state.save();
                new Notice(t("NOTICE_DELETE_FOLDER", { name: filePath.split('/').pop() || 'unknown' }));
            } catch (e) {
                console.error("[GD Sync] Failed to move folder to trash:", e);
                this.state.addToLocalQueue({ action: 'delete', path: filePath, _retryCount: retryCount + 1 });
                await this.state.save();
            }
        }
    }

    // 파일/폴더 이름/경로 변경 처리 (조용히 메타데이터만 변경)
    async handleRenameImmediate(file: TAbstractFile, oldPath: string, retryCount: number = 0) {
        // SEC-H05: changed from && to || so it handles cases where file enters or leaves ignored folder
        if (this.isIgnoredPath(file.path) || this.isIgnoredPath(oldPath)) return;
        if (this.isSyncing) {
            this.state.addToLocalQueue({ action: 'rename', path: file.path, oldPath, _retryCount: retryCount });
            await this.state.save();
            return;
        }
        const ready = await this.prepareFolders();
        if (!ready) {
            this.state.addToLocalQueue({ action: 'rename', path: file.path, oldPath, _retryCount: retryCount });
            await this.state.save();
            return;
        }

        // 1. 파일인 경우 처리
        let fileData = this.state.getFileData(oldPath);
        if (fileData) {
            if (!this.isAllowedExtension(file.name)) {
                // 확장자가 지원되지 않는 포맷으로 변경된 경우 원격에서 삭제
                await this.handleLocalDeleteImmediate(oldPath, retryCount);
                return;
            }

            try {
                const newParentFolderId = await this.getOrCreateDrivePath(file.path);
                await this.driveClient.renameAndMove(fileData.driveId, file.name, newParentFolderId);
                this.state.renameFileData(oldPath, file.path);
                await this.state.save();
                new Notice(t("NOTICE_RENAME_FILE", { name: file.name }));
            } catch (e) {
                console.error("[GD Sync] File rename failed:", e);
                this.state.addToLocalQueue({ action: 'rename', path: file.path, oldPath, _retryCount: retryCount + 1 });
                await this.state.save();
            }
            return;
        } else if (file instanceof TFile && this.isAllowedExtension(file.name)) {
            // 이전에 동기화되지 않던 파일이 동기화 대상 확장자로 변경된 경우 업로드 처리
            await this.uploadFileImmediate(file, false, retryCount);
            return;
        }

        // 2. 폴더인 경우 처리
        let folderId = this.state.getFolderId(oldPath);
        if (folderId) {
            try {
                const newParentFolderId = await this.getOrCreateDrivePath(file.path);
                await this.driveClient.renameAndMove(folderId, file.name, newParentFolderId);
                this.state.renameFolderData(oldPath, file.path);
                this.folderIdCache.set(file.path, folderId);
                this.folderIdCache.delete(oldPath);

                const oldPrefix = oldPath + '/';
                const newPrefix = file.path + '/';

                const files = this.state.getAllFiles();
                for (const key of Object.keys(files)) {
                    if (key.startsWith(oldPrefix)) {
                        const newKey = newPrefix + key.substring(oldPrefix.length);
                        this.state.renameFileData(key, newKey);
                    }
                }

                const folders = this.state.getAllFolders();
                for (const key of Object.keys(folders)) {
                    if (key.startsWith(oldPrefix)) {
                        const newKey = newPrefix + key.substring(oldPrefix.length);
                        this.state.renameFolderData(key, newKey);

                        const childFolderId = this.folderIdCache.get(key);
                        if (childFolderId) {
                            this.folderIdCache.set(newKey, childFolderId);
                            this.folderIdCache.delete(key);
                        }
                    }
                }

                await this.state.save();
                new Notice(t("NOTICE_RENAME_FOLDER", { name: file.name }));
            } catch (e) {
                console.error("[GD Sync] Folder rename failed:", e);
                this.state.addToLocalQueue({ action: 'rename', path: file.path, oldPath, _retryCount: retryCount + 1 });
                await this.state.save();
            }
        }
    }

    // 로컬 폴더 신규 생성 처리
    async handleFolderCreateImmediate(folderPath: string) {
        if (this.isIgnoredPath(folderPath)) return;
        if (this.isSyncing) return;
        const ready = await this.prepareFolders();
        if (!ready) return;

        try {
            await this.getOrCreateDrivePath(folderPath, true);
        } catch (e) {
            console.error("[GD Sync] Folder create sync failed:", e);
        }
    }

    // ─── Phase 7: Local Queue & Delta Sync ───

    private async processLocalQueue() {
        const queue = this.state.getLocalQueue();
        if (queue.length === 0) return;

        console.debug(`[GD Sync] Processing local queue... (${queue.length} items)`);
        this.state.clearLocalQueue();

        for (const item of queue) {
            try {
                const rCount = item._retryCount || 0;
                if (item.action === 'upload') {
                    const file = this.plugin.app.vault.getAbstractFileByPath(item.path);
                    if (file instanceof TFile) {
                        await this.uploadFileImmediate(file, true, rCount);
                    }
                } else if (item.action === 'delete') {
                    await this.handleLocalDeleteImmediate(item.path, rCount);
                } else if (item.action === 'rename') {
                    const file = this.plugin.app.vault.getAbstractFileByPath(item.path);
                    if (file) {
                        await this.handleRenameImmediate(file, item.oldPath!, rCount);
                    }
                }
            } catch (e) {
                console.error(`[GD Sync] Unexpected error processing queue item (${item.action}: ${item.path}):`, e);
                // Internal error beyond individual handler recovery
            }
        }
        await this.state.save();
    }

    async syncDelta() {
        if (this.isSyncing) return;

        const token = this.state.getStartPageToken();
        if (!token) {
            // 토큰이 없으면 첫 전체 동기화 시도
            return this.syncWholeVault();
        }

        this.isSyncing = true;
        this.plugin.setSyncBusy(true);
        this.plugin.updateSyncStatus(t("STATUS_DELTA_SYNC"));

        try {
            const ready = await this.prepareFolders();
            if (!ready) throw new Error("Folders not ready");

            await this.processLocalQueue();

            const { changes, newStartPageToken } = await this.driveClient.listChanges(token);

            let uploadCount = 0;
            let downloadCount = 0;

            if (changes.length === 0) {
                console.debug("[GD Sync] No remote changes detected (Delta).");
                this.state.setStartPageToken(newStartPageToken);
                await this.state.save();
                this.plugin.updateSyncStatus(t("STATUS_LAST_SYNC", { time: new Date().toLocaleTimeString() }));
                return;
            }

            console.debug(`[GD Sync] Detected ${changes.length} remote changes.`);

            const targetFolderId = await this.getTargetFolderIdResolved();

            for (const change of changes) {
                const file = change.file;
                if (change.removed || (file && file.trashed)) {
                    // 1. 파일 삭제 확인
                    const allFiles = this.state.getAllFiles();
                    const filePath = Object.keys(allFiles).find(k => allFiles[k]?.driveId === change.fileId);
                    if (filePath) {
                        const localFile = this.plugin.app.vault.getAbstractFileByPath(filePath);
                        if (localFile) {
                            await this.plugin.app.vault.adapter.remove(filePath);
                            this.state.removeFileData(filePath);
                            downloadCount++;
                        }
                        continue;
                    }

                    // 2. 폴더 삭제 확인 (Cascade)
                    const allFolders = this.state.getAllFolders();
                    const folderPath = Object.keys(allFolders).find(k => allFolders[k] === change.fileId);
                    if (folderPath) {
                        const localFolder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
                        if (localFolder) {
                            // 옵시디언의 trash API를 사용하여 로컬 폴더 및 하위 항목 제거
                            await this.plugin.app.vault.adapter.remove(folderPath);

                            this.state.removeFolderData(folderPath);
                            this.folderIdCache.delete(folderPath);

                            // 하위 상태 일괄 제거
                            const prefix = folderPath + '/';
                            for (const key of Object.keys(this.state.getAllFiles())) {
                                if (key.startsWith(prefix)) this.state.removeFileData(key);
                            }
                            for (const key of Object.keys(this.state.getAllFolders())) {
                                if (key.startsWith(prefix)) {
                                    this.state.removeFolderData(key);
                                    this.folderIdCache.delete(key);
                                }
                            }
                            downloadCount++;
                        }
                    }
                    continue;
                }

                if (!file) continue;

                const allFiles = this.state.getAllFiles();
                const allFolders = this.state.getAllFolders();

                // 1. ID 기반으로 기존 로컬 경로 탐색 (이름 변경/이동 추적용)
                let localPath: string | null | undefined = null;
                const isFolder = file.mimeType === 'application/vnd.google-apps.folder';

                if (isFolder) {
                    localPath = Object.keys(allFolders).find(k => allFolders[k] === file.id);
                } else {
                    localPath = Object.keys(allFiles).find(k => allFiles[k]?.driveId === file.id);
                }

                // 2. 현재 원격의 실제 경로 계산
                const currentRemotePath = await this.resolveRemotePath(file, targetFolderId);
                if (!currentRemotePath) continue;

                // 3. 경로가 바뀌었다면 로컬 이름변경/이동 수행
                if (localPath && localPath !== currentRemotePath) {
                    console.debug(`[GD Sync] Remote rename detected: ${localPath} -> ${currentRemotePath}`);
                    const existingFile = this.plugin.app.vault.getAbstractFileByPath(localPath);
                    if (existingFile) {
                        // 중간 폴더가 없을 경우 생성
                        const folders = currentRemotePath.split('/');
                        folders.pop();
                        let pPath = '';
                        for (const p of folders) {
                            pPath += (pPath ? '/' : '') + p;
                            if (!this.plugin.app.vault.getAbstractFileByPath(pPath)) {
                                await this.plugin.app.vault.createFolder(pPath);
                            }
                        }

                        await this.plugin.app.vault.rename(existingFile, currentRemotePath);

                        if (isFolder) {
                            this.state.renameFolderData(localPath, currentRemotePath);
                            // 하위 항목 경로 갱신
                            const oldPrefix = localPath + '/';
                            const newPrefix = currentRemotePath + '/';
                            for (const k of Object.keys(this.state.getAllFiles())) {
                                if (k.startsWith(oldPrefix)) this.state.renameFileData(k, newPrefix + k.substring(oldPrefix.length));
                            }
                            for (const k of Object.keys(this.state.getAllFolders())) {
                                if (k.startsWith(oldPrefix)) this.state.renameFolderData(k, newPrefix + k.substring(oldPrefix.length));
                            }
                        } else {
                            this.state.renameFileData(localPath, currentRemotePath);
                        }
                    }
                    localPath = currentRemotePath;
                }

                if (!localPath) localPath = currentRemotePath;
                if (this.isIgnoredPath(localPath)) continue;

                if (isFolder) {
            this.state.setFolderId(localPath, file.id);
            if (!this.plugin.app.vault.getAbstractFileByPath(localPath)) {
                await this.plugin.app.vault.createFolder(localPath);
            }
            continue;
        }

        if (!file.name || !this.isAllowedExtension(file.name)) continue;

                const localFile = this.plugin.app.vault.getAbstractFileByPath(localPath);
                const localMtime = (localFile instanceof TFile) ? localFile.stat.mtime : 0;
                const remoteMtime = file.modifiedTime ? new Date(file.modifiedTime).getTime() : 0;
                const lastSyncTime = this.state.getFileData(localPath)?.lastSyncTime || 0;

                if (remoteMtime > lastSyncTime + 1000) {
                    if (localMtime > lastSyncTime + 1000) {
                        // 사용자가 현재 수정 중인 파일(데바운스 대기 중)은 충돌 처리를 뒤로 미룸
                        if (this.plugin.modifyDebounceTimers.has(localPath)) {
                            console.debug(`[GD Sync] Skipping conflict resolution for actively edited/debouncing file: ${localPath}`);
                            continue;
                        }
                        const abstractFile = localFile; // name change to avoid shadowing or confusion
                        if (abstractFile instanceof TFile) {
                            const resolved = await this.handleConflict(abstractFile, file);
                            if (resolved === 'upload') uploadCount++;
                            else if (resolved === 'download') downloadCount++;
                            else if (resolved === 'both') { uploadCount++; downloadCount++; }
                        }
                    } else {
                        // 현재 에디터에서 열려 있고 수정 중일 수도 있으므로 체크
                        if (this.plugin.modifyDebounceTimers.has(localPath)) {
                            console.debug(`[GD Sync] Skipping download for actively edited file to avoid overwrite: ${localPath}`);
                            continue;
                        }
                        await this.downloadFile(localPath, file);
                        downloadCount++;
                    }
                }
            }

            this.state.setStartPageToken(newStartPageToken);
            await this.state.save();

            const msg = (uploadCount > 0 || downloadCount > 0)
                ? t("STATUS_SYNCED", { up: uploadCount, down: downloadCount })
                : t("STATUS_UP_TO_DATE", { time: new Date().toLocaleTimeString() });

            new Notice(t("NOTICE_SYNC_COMPLETE", { result: msg }));
            this.plugin.updateSyncStatus(msg);
            this.errorCount = 0; // Reset error count on success

        } catch (e) {
            console.error("[GD Sync] Delta Sync failed:", e);
            this.errorCount++;
            // SEC-H01: Prevents infinite recursion
            if (this.errorCount >= 3) {
                new Notice(t("NOTICE_DELTA_ERROR_RETRY"));
            } else {
                new Notice(t("NOTICE_DELTA_ERROR"));
                this.isSyncing = false;
                await this.syncWholeVault();
            }
        } finally {
            this.isSyncing = false;
            this.plugin.setSyncBusy(false);

            // 에러 발생 등으로 상태가 멈춰있는 경우에만 Idle로 복구
            const currentStatus = this.plugin.statusBarEl.getText();
            if (currentStatus.includes(t("STATUS_SCANNING")) || currentStatus.includes(t("STATUS_DELTA_SYNC"))) {
                this.plugin.updateSyncStatus(t("STATUS_LAST_SYNC", { time: new Date().toLocaleTimeString() }));
            }
        }
    }

    private async resolveRemotePath(file: GoogleDriveFile, targetRootId: string): Promise<string | null> {
        let actualTargetRootId = targetRootId;
        if (actualTargetRootId === 'root') {
            actualTargetRootId = await this.getTargetFolderIdResolved();
        }

        let current = file;
        const pathParts: string[] = [current.name];

        while (current.parents && current.parents.length > 0) {
            // Check all parents
            const hasTargetParent = current.parents.some(id => id === actualTargetRootId);
            if (hasTargetParent) return pathParts.join('/');

            const parentId = current.parents[0]!;
            
            // folderIdCache 확인 (가장 빠름)
            for (const [path, id] of this.folderIdCache.entries()) {
                if (id === parentId) {
                    return path + '/' + pathParts.join('/');
                }
            }

            // SyncState 폴더 캐시 확인
            const cachedPath = Object.keys(this.state.getAllFolders()).find(k => this.state.getFolderId(k) === parentId);
            if (cachedPath) {
                this.folderIdCache.set(cachedPath, parentId); // 메모리 캐시에도 저장
                return cachedPath + '/' + pathParts.join('/');
            }

            // API로 부모 정보 가져오기
            const parentFile = await this.driveClient.getFile(parentId);
            if (!parentFile || parentFile.trashed) return null;
            current = parentFile;
            pathParts.unshift(current.name);
        }
        
        // If we reached the end of parent chain without hitting actualTargetRootId, it's not in the sync folder
        return null;
    }

    // 전체 동기화 로직 (Full Sync) - Phase 5, 6: UI 상태 및 충돌 해결 강화
    async syncWholeVault() {
        if (this.isSyncing) {
            new Notice(t("NOTICE_ALREADY_SYNCING"));
            return;
        }
        this.isSyncing = true;
        this.errorCount = 0; // V2-M05: Reset error count on manual full sync
        this.plugin.setSyncBusy(true);
        this.plugin.updateSyncStatus(t("STATUS_SCANNING"));
        new Notice(t("NOTICE_FULL_SYNC_START"));

        try {
            // .trash 폴더 자동 정리 (설정된 경우)
            await this.cleanupTrash();

            // SEC-M04: Cache invalidation
            this.folderIdCache.clear();
            this.foldersReady = false;

            const ready = await this.prepareFolders();
            if (!ready) {
                this.plugin.setSyncBusy(false);
                this.plugin.updateSyncStatus(t("STATUS_SETUP_FAILED"));
                return;
            }

            // 0. Delta Sync용 토큰 초기화
            const startToken = await this.driveClient.getStartPageToken();
            this.state.setStartPageToken(startToken);

            await this.processLocalQueue();

            const targetFolderId = await this.getTargetFolderIdResolved();

            // 1. 구글 드라이브 내 전체 트리 구조 스캔
            this.plugin.updateSyncStatus(t("STATUS_LISTING"));
            const remoteFilesArray = await this.driveClient.listAllFilesInTree(targetFolderId);
            const remoteMap = new Map<string, GoogleDriveFile>();
            remoteFilesArray.forEach(f => remoteMap.set(f.id, f));

            const remoteFilesByPath = new Map<string, GoogleDriveFile>();
            const remoteFoldersByPath = new Map<string, GoogleDriveFile>();

            for (const f of remoteFilesArray) {
                const localPath = this.buildLocalPathFromRemote(f.id, remoteMap, targetFolderId);
                if (!localPath || this.isIgnoredPath(localPath)) continue;

                if (f.mimeType === 'application/vnd.google-apps.folder') {
                    remoteFoldersByPath.set(localPath, f);
                    continue;
                }

                if (!f.name || !this.isAllowedExtension(f.name)) continue;
                
                if (f.mimeType && f.mimeType.startsWith('application/vnd.google-apps.')) continue;
                remoteFilesByPath.set(localPath, f);
            }

            // 2. 동기화 계획 수립 (Sync Plan)
            let uploadCount = 0;
            let downloadCount = 0;

            const localFiles = this.plugin.app.vault.getFiles();
            const processedPaths = new Set<string>();
            const processedDriveIds = new Set<string>();

            // 2.1 원격 폴더 동기화 (우선 처리) + 캐시 워밍업
            let folderIdx = 0;
            const totalRemoteFolders = remoteFoldersByPath.size;
            for (const [remotePath, remoteFolder] of remoteFoldersByPath.entries()) {
                folderIdx++;
                this.plugin.updateSyncStatus(t('STATUS_SYNCING_FOLDERS', { current: folderIdx, total: totalRemoteFolders }));
                this.state.setFolderId(remotePath, remoteFolder.id);
                this.folderIdCache.set(remotePath, remoteFolder.id);
                const existingLocal = this.plugin.app.vault.getAbstractFileByPath(remotePath);
                if (!existingLocal) {
                    console.debug(`[GD Sync] Creating empty folder from remote: ${remotePath}`);
                    await this.plugin.app.vault.createFolder(remotePath);
                }
            }

            // 2.1b 로컬 폴더 동기화 (로컬의 빈 폴더도 원격에 반영되도록 보장)
            const allLocalFolders = this.plugin.app.vault.getAllLoadedFiles()
                .filter((f): f is TFolder => f instanceof TFolder);
            
            let newLocalFolders = allLocalFolders.filter(f => !f.isRoot() && !this.isIgnoredPath(f.path) && !remoteFoldersByPath.has(f.path));

            if (!this.plugin.settings.syncEmptyFolders) {
                // 지원되는 파일이 있는 폴더 경로만 추출
                const validFolders = new Set<string>();
                const allFiles = this.plugin.app.vault.getFiles();
                for (const file of allFiles) {
                    if (!this.isIgnoredPath(file.path) && this.isAllowedExtension(file.name)) {
                        let parent = file.parent;
                        while (parent && !parent.isRoot()) {
                            validFolders.add(parent.path);
                            parent = parent.parent;
                        }
                    }
                }
                newLocalFolders = newLocalFolders.filter(f => validFolders.has(f.path));
            }

            if (newLocalFolders.length > 0) {
                // 깊이별로 그룹화하여 같은 깊이의 폴더들을 병렬 처리
                const foldersByDepth = new Map<number, TFolder[]>();
                for (const folder of newLocalFolders) {
                    const depth = folder.path.split('/').length;
                    if (!foldersByDepth.has(depth)) foldersByDepth.set(depth, []);
                    foldersByDepth.get(depth)!.push(folder);
                }

                const sortedDepths = Array.from(foldersByDepth.keys()).sort((a, b) => a - b);
                const FOLDER_CONCURRENCY = 5;
                let localFolderIdx = 0;

                for (const depth of sortedDepths) {
                    const foldersAtDepth = foldersByDepth.get(depth)!;
                    // 같은 깊이의 폴더들은 서로 의존성이 없으므로 병렬 처리 가능
                    for (let i = 0; i < foldersAtDepth.length; i += FOLDER_CONCURRENCY) {
                        const batch = foldersAtDepth.slice(i, i + FOLDER_CONCURRENCY);
                        // skipFind=true: remoteFoldersByPath에 없으므로 원격에 미존재 확정
                        await Promise.all(batch.map(f => this.getOrCreateDrivePath(f.path, true, true)));
                        localFolderIdx += batch.length;
                        this.plugin.updateSyncStatus(t('STATUS_CREATING_FOLDERS', { current: localFolderIdx, total: newLocalFolders.length }));
                    }
                }
            }

            // 2.2 파일 동기화 계획 실행
            let currentIdx = 0;
            const totalLocal = localFiles.length;

            for (const localFile of localFiles) {
                currentIdx++;
                const path = localFile.path;
                if (this.isIgnoredPath(path) || !this.isAllowedExtension(localFile.name)) continue;
                processedPaths.add(path);

                this.plugin.updateSyncStatus(t("STATUS_CHECKING", { current: currentIdx, total: totalLocal }));

                const data = this.state.getFileData(path);

                // ID 기반 매칭 시도 (이름이 바뀌었을 수 있음)
                let remoteFile = remoteFilesByPath.get(path);
                if (!remoteFile && data?.driveId) {
                    remoteFile = remoteMap.get(data.driveId);
                    if (remoteFile) {
                        // 이름이 바뀌었으므로 로컬 경로 조정
                        const newPath = this.buildLocalPathFromRemote(remoteFile.id, remoteMap, targetFolderId);
                        if (newPath && newPath !== path) {
                            console.debug(`[GD Sync] FullSync: Rename detected via ID: ${path} -> ${newPath}`);
                            const fileObj = this.plugin.app.vault.getAbstractFileByPath(path);
                            if (fileObj) {
                                await this.plugin.app.vault.rename(fileObj, newPath);
                                this.state.renameFileData(path, newPath);
                                // 루프 진행을 위해 현재 path 변수와 data 업데이트
                                processedPaths.add(newPath);
                                const abstractUpdated = this.plugin.app.vault.getAbstractFileByPath(newPath);
                                if (abstractUpdated instanceof TFile) {
                                    // 동기화 로직은 바뀐 경로로 계속 진행
                                    await this.syncWholeVaultOneFile(abstractUpdated, remoteFile, data, true);
                                    if (remoteFile) processedDriveIds.add(remoteFile.id);
                                    continue;
                                }
                            }
                        }
                    }
                }

                if (remoteFile) processedDriveIds.add(remoteFile.id);

                const localMtime = localFile.stat.mtime;
                const lastSyncTime = data?.lastSyncTime || 0;
                const remoteMtime = (remoteFile && remoteFile.modifiedTime) ? new Date(remoteFile.modifiedTime).getTime() : 0;

                const isLocalChanged = localMtime > lastSyncTime + 1000;
                const isRemoteChanged = remoteFile && (remoteMtime > lastSyncTime + 1000);

                if (isLocalChanged && isRemoteChanged) {
                    // ─── 충돌 발생! ───
                    this.plugin.updateSyncStatus(t("STATUS_CONFLICT", { name: localFile.name }));
                    const resolved = await this.handleConflict(localFile, remoteFile!);
                    if (resolved === 'upload') uploadCount++;
                    else if (resolved === 'download') downloadCount++;
                    else if (resolved === 'both') {
                        uploadCount++;
                        downloadCount++;
                    }
                } else if (isLocalChanged) {
                    // 로컬만 변경됨 -> 업로드
                    this.plugin.updateSyncStatus(t("STATUS_UPLOADING", { name: localFile.name }));
                    await this.uploadFileImmediate(localFile, true, 0, FULL_SYNC_OPTS);
                    uploadCount++;
                } else if (isRemoteChanged) {
                    // 원격만 변경됨 -> 다운로드
                    this.plugin.updateSyncStatus(t("STATUS_DOWNLOADING", { name: localFile.name }));
                    await this.downloadFile(path, remoteFile!);
                    downloadCount++;
                } else if (!data && remoteFile) {
                    this.plugin.updateSyncStatus(t("STATUS_SYNCING", { name: localFile.name }));
                    await this.downloadFile(path, remoteFile);
                    downloadCount++;
                } else if (!remoteFile) {
                    this.plugin.updateSyncStatus(t("STATUS_UPLOADING", { name: localFile.name }));
                    await this.uploadFileImmediate(localFile, true, 0, FULL_SYNC_OPTS);
                    uploadCount++;
                }

                // 배치 state.save: 20개 파일마다 중간 저장 (크래시 방어)
                if ((uploadCount + downloadCount) % 20 === 0 && (uploadCount + downloadCount) > 0) {
                    await this.state.save();
                }
            }

            // 2.3 원격에만 있는 파일 다운로드
            const remoteOnlyPaths = Array.from(remoteFilesByPath.keys()).filter(p => {
                const f = remoteFilesByPath.get(p);
                return f && !processedPaths.has(p) && !processedDriveIds.has(f.id);
            });

            let remoteOnlyIdx = 0;
            for (const remotePath of remoteOnlyPaths) {
                remoteOnlyIdx++;
                const remoteFile = remoteFilesByPath.get(remotePath);
                if (!remoteFile) continue;

                this.plugin.updateSyncStatus(t("STATUS_REMOTE_NEW", { current: remoteOnlyIdx, total: remoteOnlyPaths.length }));

                await this.downloadFile(remotePath, remoteFile);
                downloadCount++;
            }

            await this.state.save();

            if (uploadCount > 0 || downloadCount > 0) {
                const msg = t("STATUS_SYNCED", { up: uploadCount, down: downloadCount });
                new Notice(t("NOTICE_SYNC_COMPLETE", { result: msg }));
                this.plugin.updateSyncStatus(msg);
            } else {
                this.plugin.updateSyncStatus(t("STATUS_LAST_SYNC", { time: new Date().toLocaleTimeString() }));
            }

        } catch (err: unknown) {
            const e = err as { message?: string };
            console.error("[GD Sync] Full Sync failed:", err);
            new Notice(t("NOTICE_ERROR", { msg: e.message || 'Unknown error' }));
            this.plugin.updateSyncStatus(t("STATUS_ERROR"));
        } finally {
            this.isSyncing = false;
            this.plugin.setSyncBusy(false);
        }
    }

    // 개별 파일 동기화 판단 로직 모듈화 (FullSync용)
    private async syncWholeVaultOneFile(localFile: TFile, remoteFile: GoogleDriveFile, data: FileSyncData | undefined, isPathAlreadySynced: boolean = false) {
        const path = localFile.path;
        const localMtime = localFile.stat.mtime;
        const lastSyncTime = data?.lastSyncTime || 0;
        const remoteMtime = (remoteFile && remoteFile.modifiedTime) ? new Date(remoteFile.modifiedTime).getTime() : 0;

        const isLocalChanged = localMtime > lastSyncTime + 1000;
        const isRemoteChanged = remoteFile && (remoteMtime > lastSyncTime + 1000);

        if (isLocalChanged && isRemoteChanged) {
            this.plugin.updateSyncStatus(t("STATUS_CONFLICT", { name: localFile.name }));
            await this.handleConflict(localFile, remoteFile);
            return 'conflict';
        } else if (isLocalChanged) {
            this.plugin.updateSyncStatus(t("STATUS_UPLOADING", { name: localFile.name }));
            await this.uploadFileImmediate(localFile, true, 0, FULL_SYNC_OPTS);
            return 'upload';
        } else if (isRemoteChanged) {
            this.plugin.updateSyncStatus(t("STATUS_DOWNLOADING", { name: localFile.name }));
            await this.downloadFile(path, remoteFile);
            return 'download';
        } else if (!data && remoteFile) {
            this.plugin.updateSyncStatus(t("STATUS_SYNCING", { name: localFile.name }));
            await this.downloadFile(path, remoteFile);
            return 'download';
        } else if (!remoteFile) {
            this.plugin.updateSyncStatus(t("STATUS_UPLOADING", { name: localFile.name }));
            await this.uploadFileImmediate(localFile, true, 0, FULL_SYNC_OPTS);
            return 'upload';
        }
        return 'none';
    }

    // SEC-M06: Definition of buildLocalPathFromRemote
    private buildLocalPathFromRemote(fileId: string, remoteMap: Map<string, GoogleDriveFile>, targetRootId: string): string | null {
        let current = remoteMap.get(fileId);
        if (!current) return null;
        let pathParts: string[] = [current.name];

        let foundTarget = false;
        while (current.parents && current.parents.length > 0) {
            // targetRootId가 parents에 포함되어 있는지 확인
            if (current.parents.some(id => id === targetRootId)) {
                foundTarget = true;
                break;
            }
            
            const parentId = current.parents[0]!;
            current = remoteMap.get(parentId);
            if (!current) break;
            pathParts.unshift(current.name);
        }
        
        return foundTarget ? pathParts.join('/') : null;
    }

    // 개별 파일 다운로드 로직 분리
    private async downloadFile(localPath: string, remoteFile: GoogleDriveFile) {
        console.debug(`[GD Sync] Downloading: ${localPath}`);

        this.recentlyDownloaded.add(localPath);
        // Ping-pong 방지: autoSyncDelay 보다 길게 설정 (기본 5초 + 설정된 여유 버퍼)
        const delay = this.plugin.settings.autoSyncDelay + this.plugin.settings.postDownloadGuardBuffer;
        setTimeout(() => this.recentlyDownloaded.delete(localPath), delay);

        const binaryContent = await this.driveClient.downloadFile(remoteFile.id, true) as ArrayBuffer;

        const folders = localPath.split('/');
        folders.pop();
        let currentLocalPath = '';
        for (const p of folders) {
            currentLocalPath += (currentLocalPath ? '/' : '') + p;
            if (!this.plugin.app.vault.getAbstractFileByPath(currentLocalPath)) {
                if (this.localFolderLocks.has(currentLocalPath)) {
                    await this.localFolderLocks.get(currentLocalPath);
                    continue;
                }

                const createPromise = (async () => {
                    try {
                        if (!this.plugin.app.vault.getAbstractFileByPath(currentLocalPath)) {
                            await this.plugin.app.vault.createFolder(currentLocalPath);
                        }
                    } catch (err: unknown) {
                        const e = err as { message?: string };
                        if (e.message && !e.message.includes('already exists')) {
                            throw err;
                        }
                    }
                })();

                this.localFolderLocks.set(currentLocalPath, createPromise);
                try {
                    await createPromise;
                } finally {
                    this.localFolderLocks.delete(currentLocalPath);
                }
            }
        }

        const existingLocal = this.plugin.app.vault.getAbstractFileByPath(localPath);
        if (existingLocal && existingLocal instanceof TFile) {
            await this.plugin.app.vault.modifyBinary(existingLocal, binaryContent);
            let fileData = this.state.getFileData(localPath);
            if (!fileData) {
                fileData = { driveId: remoteFile.id, lastSyncTime: existingLocal.stat.mtime };
            } else {
                fileData.lastSyncTime = existingLocal.stat.mtime;
                fileData.driveId = remoteFile.id;
            }
            this.state.setFileData(localPath, fileData);
        } else {
            const newLocalFile = await this.plugin.app.vault.createBinary(localPath, binaryContent);
            this.state.setFileData(localPath, {
                driveId: remoteFile.id,
                lastSyncTime: newLocalFile.stat.mtime
            });
        }
        this.state.addSyncLog({ action: 'download', fileName: localPath });
    }

    // 충돌 해결 핸들러
    private async handleConflict(localFile: TFile, remoteFile: GoogleDriveFile): Promise<'upload' | 'download' | 'both' | 'skip'> {
        let strategy = this.plugin.settings.conflictStrategy;

        if (strategy === 'manual') {
            const { ConflictResolutionModal } = await import('../ui/ConflictResolutionModal');
            const modal = new ConflictResolutionModal(
                this.plugin.app,
                localFile.path,
                localFile.stat.mtime,
                (remoteFile.modifiedTime ? new Date(remoteFile.modifiedTime).getTime() : 0)
            );
            const choice = await modal.openAndGetChoice();

            if (choice === 'keepLocal') strategy = 'keepLocal';
            else if (choice === 'keepRemote') strategy = 'keepRemote';
            else if (choice === 'keepBoth') strategy = 'keepBoth';
            else if (choice === 'merge') strategy = 'merge';
            else {
                this.state.addSyncLog({ action: 'conflict', fileName: localFile.path, details: 'Skipped' });
                return 'skip';
            }
        }

        if (strategy === 'keepLocal') {
            await this.uploadFileImmediate(localFile, true);
            return 'upload';
        } else if (strategy === 'keepRemote') {
            await this.downloadFile(localFile.path, remoteFile);
            return 'download';
        } else if (strategy === 'keepBoth') {
            await this.doKeepBoth(localFile, remoteFile, strategy);
            return 'both';
        } else if (strategy === 'merge') {
            // 텍스트 파일(md, txt 등)인 경우에만 라인 단위 마커 병합
            const ext = localFile.extension.toLowerCase();
            if (ext === 'md' || ext === 'txt') {
                const { DiffUtils } = await import('./DiffUtils');
                const remoteContent = await this.driveClient.downloadFile(remoteFile.id, false) as string;
                const localContent = await this.plugin.app.vault.read(localFile);

                const mergedContent = DiffUtils.mergeTexts(localContent, remoteContent);

                await this.plugin.app.vault.modify(localFile, mergedContent);

                // 당장 업로드하여 원격도 병합 대기 상태로 만듦
                await this.uploadFileImmediate(localFile, true);
                this.state.addSyncLog({ action: 'conflict', fileName: localFile.path, details: `Merged manually (line-by-line)` });
                return 'both';
            } else {
                // 텍스트가 아니므로 keepBoth로 폴백
                await this.doKeepBoth(localFile, remoteFile, 'keepBoth(fallback)');
                return 'both';
            }
        }

        this.state.addSyncLog({ action: 'conflict', fileName: localFile.path, details: `Resolved: ${strategy as string}` });
        return 'skip';
    }

    private async doKeepBoth(localFile: TFile, remoteFile: GoogleDriveFile, strategyMsg: string) {
        // 1. 로컬 파일을 사본으로 복제
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const extension = localFile.extension;
        const baseName = localFile.basename;
        const folderPath = localFile.parent ? localFile.parent.path : "";
        const newFileName = `${baseName} (Conflict ${timestamp}).${extension}`;
        const newPath = folderPath === "/" || folderPath === "" ? newFileName : `${folderPath}/${newFileName}`;

        const content = await this.plugin.app.vault.readBinary(localFile);
        await this.plugin.app.vault.createBinary(newPath, content);
        // 사본은 다음 동기화 때 업로드되도록 둠 (또는 즉시 업로드)

        // 2. 원본 경로는 원격 파일로 덮어쓰기
        await this.downloadFile(localFile.path, remoteFile);
        this.state.addSyncLog({ action: 'conflict', fileName: localFile.path, details: `Resolved: ${strategyMsg}` });
    }

    // 로컬 .trash 폴더 자동 정리
    public async cleanupTrash() {
        const days = this.plugin.settings.trashAutoCleanupDays;
        if (days <= 0) return;

        const trashPath = '.trash';
        if (!(await this.plugin.app.vault.adapter.exists(trashPath))) return;

        console.debug(`[GD Sync] Starting .trash cleanup (Older than ${days} days)`);
        let count = 0;
        const now = Date.now();
        const threshold = days * 24 * 60 * 60 * 1000;

        const list = await this.plugin.app.vault.adapter.list(trashPath);

        // 파일 처리
        for (const filePath of list.files) {
            try {
                const stat = await this.plugin.app.vault.adapter.stat(filePath);
                if (stat && now - stat.mtime > threshold) {
                    await this.plugin.app.vault.adapter.remove(filePath);
                    count++;
                }
            } catch (e) {
                console.error(`[GD Sync] Failed to cleanup trash file: ${filePath}`, e);
            }
        }

        // 폴더 처리
        for (const folderPath of list.folders) {
            try {
                const stat = await this.plugin.app.vault.adapter.stat(folderPath);
                if (stat && now - stat.mtime > threshold) {
                    await this.plugin.app.vault.adapter.remove(folderPath);
                    count++;
                }
            } catch (err) {
                console.debug(`[GD Sync] Failed to cleanup trash folder (might not be empty): ${folderPath}`, err);
            }
        }

        if (count > 0) {
            console.debug(`[GD Sync] .trash cleanup done. Removed ${count} items.`);
            new Notice(t('SETTING_TRASH_CLEANUP_NOTICE', { count: count.toString() }));
        }
    }
}
