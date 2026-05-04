import { Notice, requestUrl } from 'obsidian';
import { t } from '../lang/helpers';
import GDSyncPlugin from '../main';

// 구글 드라이브 API 통신을 전담하는 클래스
export class GoogleDriveClient {
    constructor(private plugin: GDSyncPlugin) {}

    private async getHeaders(): Promise<Record<string, string>> {
        const token = await this.plugin.getAccessToken();
        return {
            'Authorization': `Bearer ${token}`
        };
    }

    // SEC-C02: Drive ID validation
    private validateDriveId(id: string): string {
        if (!/^[a-zA-Z0-9_-]+$/.test(id) && id !== 'root') {
            throw new Error(`Invalid Drive ID: ${id}`);
        }
        return id;
    }

    private escapeQuery(str: string): string {
        return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    }

    // 1. 특정 폴더 찾기
    async findFolder(folderName: string, parentId: string = 'root'): Promise<string | null> {
        const safeName = this.escapeQuery(folderName);
        const safeParent = this.validateDriveId(parentId);
        const q = `mimeType='application/vnd.google-apps.folder' and name='${safeName}' and '${safeParent}' in parents and trashed=false`;
        const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`;
        
        const res = await requestUrl({
            url,
            method: 'GET',
            headers: await this.getHeaders()
        });

        if (res.status !== 200) {
            new Notice(t('NOTICE_ERROR', { msg: `Folder search failed (HTTP ${res.status})` }));
            throw new Error(`폴더 검색 실패: ${res.status}`);
        }

        if (res.json.files && res.json.files.length > 0) {
            return res.json.files[0].id;
        }
        return null;
    }

    // 2. 특정 폴더 생성하기
    async createFolder(folderName: string, parentId: string = 'root'): Promise<string> {
        const safeParent = this.validateDriveId(parentId);
        const res = await requestUrl({
            url: 'https://www.googleapis.com/drive/v3/files',
            method: 'POST',
            headers: {
                ...(await this.getHeaders()),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [safeParent]
            })
        });

        if (res.status !== 200) {
            new Notice(t('NOTICE_ERROR', { msg: `Folder creation failed (HTTP ${res.status})` }));
            throw new Error(`폴더 생성 실패: ${res.status}`);
        }
        return res.json.id;
    }

    // 3. 파일 목록조회 (주어진 폴더 하위의 모든 파일, 트리 구조 재귀 탐색)
    async listAllFilesInTree(rootFolderId: string): Promise<any[]> {
        let allFiles: any[] = [];
        let foldersToProcess: string[] = [this.validateDriveId(rootFolderId)];
        const headers = await this.getHeaders();
        const processedFolderIds = new Set<string>(); // SEC-M05: Circular loop protection

        while (foldersToProcess.length > 0) {
            // 한번에 최대 10개 폴더씩 쿼리 묶음 처리 (URL 길이 한계 방지)
            const batch = foldersToProcess.splice(0, 10);
            const parentConditions = batch.map(id => `'${this.validateDriveId(id)}' in parents`).join(' or ');
            
            let pageToken: string | undefined = undefined;
            do {
                let q = `(${parentConditions}) and trashed=false`;
                let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,parents)&spaces=drive&pageSize=1000`;
                if (pageToken) url += `&pageToken=${pageToken}`;

                const res = await requestUrl({ url, method: 'GET', headers });
                
                const files = res.json.files || [];
                allFiles = allFiles.concat(files);
                
                // 검색된 파일들 중 '폴더'인 것들은 다음 탐색 큐에 추가
                const subFolders = files.filter((f: any) => f.mimeType === 'application/vnd.google-apps.folder');
                for (const sub of subFolders) {
                    if (!processedFolderIds.has(sub.id)) {
                        processedFolderIds.add(sub.id);
                        foldersToProcess.push(sub.id);
                    }
                }

                pageToken = res.json.nextPageToken;
            } while (pageToken);
        }

        return allFiles;
    }

    // 4. 폴더 목록전용 조회 (UI 폴더 픽커용)
    async listFolders(parentId: string = 'root'): Promise<any[]> {
        let folders: any[] = [];
        const headers = await this.getHeaders();
        const safeParent = this.validateDriveId(parentId);
        
        // 1. 일반 하위 폴더 조회
        let pageToken: string | undefined = undefined;
        do {
            let q = `mimeType='application/vnd.google-apps.folder' and '${safeParent}' in parents and trashed=false`;
            let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,shared)&spaces=drive&pageSize=100`;
            if (pageToken) url += `&pageToken=${pageToken}`;

            try {
                const res = await requestUrl({ url, method: 'GET', headers });
                folders = folders.concat(res.json.files || []);
                pageToken = res.json.nextPageToken;
            } catch (err: any) {
                throw new Error(`일반 폴더 조회 중 오류 (status: ${err.status}): ${err.message || err.text || err}`);
            }
        } while (pageToken);

        // 2. root 위치일 때는 '공유 받은 폴더' 리스트도 개별 쿼리로 합산 (Drive API 문법 오류 방지)
        if (parentId === 'root') {
            let sharedPageToken: string | undefined = undefined;
            do {
                let q = `mimeType='application/vnd.google-apps.folder' and sharedWithMe and trashed=false`;
                let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,shared)&spaces=drive&pageSize=100`;
                if (sharedPageToken) url += `&pageToken=${sharedPageToken}`;

                try {
                    const res = await requestUrl({ url, method: 'GET', headers });
                    folders = folders.concat(res.json.files || []);
                    sharedPageToken = res.json.nextPageToken;
                } catch (err: any) {
                    console.error("공유 폴더 조회 오류:", err);
                    break; // 공유 폴더 조회 실패 시 일반 폴더 리스트라도 반환하기 위해 중단만 함
                }
            } while (sharedPageToken);
            
            // id 기준 중복 폴더 제거
            const uniqueFolders = new Map();
            folders.forEach(f => uniqueFolders.set(f.id, f));
            folders = Array.from(uniqueFolders.values());
        }

        return folders;
    }

    // 5. 새 파일 업로드 (Multipart)
    async uploadFile(content: ArrayBuffer | string, name: string, parentId: string, mimeType: string = 'text/markdown', modifiedTime?: number): Promise<string> {
        const boundary = '-------314159265358979323846';
        const delimiter = "\r\n--" + boundary + "\r\n";
        const close_delim = "\r\n--" + boundary + "--";
        const safeParent = this.validateDriveId(parentId);

        const metadata: any = {
            name: name,
            mimeType: mimeType,
            parents: [safeParent]
        };

        if (modifiedTime) {
            metadata.modifiedTime = new Date(modifiedTime).toISOString();
        }

        // Obsidian requestUrl은 body로 string 또는 ArrayBuffer를 지원함.
        // 텍스트 파일(md) 처리 우선 구현. ArrayBuffer는 바이너리 처리가 필요.
        let base64Data = "";
        let isBinary = content instanceof ArrayBuffer;
        if (isBinary) {
            base64Data = arrayBufferToBase64(content as ArrayBuffer);
        }

        const multipartRequestBody =
            delimiter +
            'Content-Type: application/json\r\n\r\n' +
            JSON.stringify(metadata) +
            delimiter +
            'Content-Type: ' + mimeType + (isBinary ? '\r\nContent-Transfer-Encoding: base64' : '') + '\r\n\r\n' +
            (isBinary ? base64Data : content as string) +
            close_delim;

        const res = await requestUrl({
            url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
            method: 'POST',
            headers: {
                ...(await this.getHeaders()),
                'Content-Type': `multipart/related; boundary=${boundary}`
            },
            body: multipartRequestBody
        });

        if (res.status !== 200) {
            new Notice(t('NOTICE_ERROR', { msg: `Upload failed (HTTP ${res.status})` }));
            throw new Error(`업로드 실패: ${res.status}`);
        }
        return res.json.id;
    }

    // 5. 기존 파일 콘텐츠 업데이트 (Multipart OR 단순 패치)
    async updateFile(fileId: string, content: ArrayBuffer | string, mimeType: string = 'text/markdown'): Promise<any> {
        const isBinary = content instanceof ArrayBuffer;
        const safeFileId = this.validateDriveId(fileId);
        
        const headers = await this.getHeaders();
        headers['Content-Type'] = mimeType;
        
        let body: ArrayBuffer | string;
        if (isBinary) {
            body = content;
        } else {
            body = content;
        }

        const res = await requestUrl({
            url: `https://www.googleapis.com/upload/drive/v3/files/${safeFileId}?uploadType=media`,
            method: 'PATCH',
            headers: headers,
            body: body
        });

        if (res.status !== 200) {
            new Notice(t('NOTICE_ERROR', { msg: `Update failed (HTTP ${res.status})` }));
            throw new Error(`파일 업데이트 실패: ${res.status}`);
        }
        return res.json;
    }

    // 6. 파일 다운로드
    async downloadFile(fileId: string, asBinary: boolean = false): Promise<string | ArrayBuffer> {
        const safeFileId = this.validateDriveId(fileId);
        const res = await requestUrl({
            url: `https://www.googleapis.com/drive/v3/files/${safeFileId}?alt=media`,
            method: 'GET',
            headers: await this.getHeaders()
        });

        if (res.status !== 200) {
            new Notice(t('NOTICE_ERROR', { msg: `Download failed (HTTP ${res.status})` }));
            throw new Error(`다운로드 실패: ${res.status}`);
        }

        return asBinary ? res.arrayBuffer : res.text;
    }

    // 7. 지정된 목적지 폴더로 이동 (가상 지우기 / 휴지통 대용)
    async moveToFolder(fileId: string, targetFolderId: string): Promise<void> {
        const safeFileId = this.validateDriveId(fileId);
        const safeTarget = this.validateDriveId(targetFolderId);
        // 현재 파일의 부모 폴더 목록 조회 후 모두 제거하면서 새로운 폴더 추가
        const fileInfoRes = await requestUrl({
            url: `https://www.googleapis.com/drive/v3/files/${safeFileId}?fields=parents`,
            method: 'GET',
            headers: await this.getHeaders()
        });
        
        const previousParents = fileInfoRes.json.parents?.join(',') || '';

        const res = await requestUrl({
            url: `https://www.googleapis.com/drive/v3/files/${safeFileId}?addParents=${safeTarget}&removeParents=${previousParents}`,
            method: 'PATCH',
            headers: await this.getHeaders()
        });

        if (res.status !== 200) {
            throw new Error(`폴더 이동 실패: ${res.status}`);
        }
    }

    // 8. 파일 메타데이터 업데이트 (이름 변경 및 경로 이동)
    async updateFileMetadata(fileId: string, newName?: string, addParents?: string[], removeParents?: string[], modifiedTime?: number): Promise<any> {
        const safeFileId = this.validateDriveId(fileId);
        let url = `https://www.googleapis.com/drive/v3/files/${safeFileId}?fields=id,name,parents`;
        const queryParams = [];
        if (addParents && addParents.length > 0) queryParams.push(`addParents=${addParents.map(id => this.validateDriveId(id)).join(',')}`);
        if (removeParents && removeParents.length > 0) queryParams.push(`removeParents=${removeParents.map(id => this.validateDriveId(id)).join(',')}`);
        
        if (queryParams.length > 0) {
            url += `&${queryParams.join('&')}`;
        }

        const body: any = {};
        if (newName) {
            body.name = newName;
        }
        if (modifiedTime) {
            body.modifiedTime = new Date(modifiedTime).toISOString();
        }

        const headers = await this.getHeaders();
        headers['Content-Type'] = 'application/json';

        const res = await requestUrl({
            url: url,
            method: 'PATCH',
            headers: headers,
            body: JSON.stringify(body)
        });

        if (res.status !== 200) {
            throw new Error(`파일 메타데이터 업데이트 실패: ${res.status}`);
        }
        return res.json;
    }

    // 9. 파일 이름 및 경로 동시 완벽 이동 (기존 부모 모두 제거 후 새 부모 추가)
    async renameAndMove(fileId: string, newName: string, newParentId: string, modifiedTime?: number): Promise<any> {
        const safeFileId = this.validateDriveId(fileId);
        const fileInfoRes = await requestUrl({
            url: `https://www.googleapis.com/drive/v3/files/${safeFileId}?fields=parents`,
            method: 'GET',
            headers: await this.getHeaders()
        });
        
        const previousParents = fileInfoRes.json.parents?.join(',') || '';

        return await this.updateFileMetadata(fileId, newName, [newParentId], previousParents ? previousParents.split(',') : [], modifiedTime);
    }

    // ─── Phase 7: Changes API (Delta Sync) ───

    // 현재 시점의 페이지 토큰 가져오기
    async getStartPageToken(): Promise<string> {
        const res = await requestUrl({
            url: 'https://www.googleapis.com/drive/v3/changes/startPageToken',
            method: 'GET',
            headers: await this.getHeaders()
        });
        if (res.status !== 200) throw new Error("Failed to get startPageToken");
        return res.json.startPageToken;
    }

    // 변경 사항 목록 가져오기
    async listChanges(pageToken: string): Promise<{ changes: any[], newStartPageToken: string }> {
        let allChanges: any[] = [];
        let currentToken = pageToken;
        const headers = await this.getHeaders();

        while (true) {
            const url = `https://www.googleapis.com/drive/v3/changes?pageToken=${currentToken}&fields=nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,parents,trashed))&spaces=drive&pageSize=1000`;
            const res = await requestUrl({ url, method: 'GET', headers });

            if (res.status !== 200) throw new Error(`Failed to list changes: ${res.status}`);

            allChanges = allChanges.concat(res.json.changes || []);
            
            if (res.json.nextPageToken) {
                currentToken = res.json.nextPageToken;
            } else {
                return {
                    changes: allChanges,
                    newStartPageToken: res.json.newStartPageToken
                };
            }
        }
    }

    // 파일 정보 조회
    async getFile(fileId: string): Promise<any> {
        const safeFileId = this.validateDriveId(fileId);
        const res = await requestUrl({
            url: `https://www.googleapis.com/drive/v3/files/${safeFileId}?fields=id,name,mimeType,modifiedTime,parents,trashed`,
            method: 'GET',
            headers: await this.getHeaders()
        });
        if (res.status !== 200) return null;
        return res.json;
    }
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
    const bytes = new Uint8Array(buffer);
    const CHUNK_SIZE = 8192;
    let result = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        const chunk = bytes.subarray(i, i + CHUNK_SIZE);
        result += String.fromCharCode.apply(null, chunk as unknown as number[]);
    }
    return window.btoa(result);
}
