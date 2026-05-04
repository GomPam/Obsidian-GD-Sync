import { App, Modal, Setting, Notice } from 'obsidian';
import GDSyncPlugin from '../main';
import { t } from '../lang/helpers';

interface DriveFolder {
    id: string;
    name: string;
    shared?: boolean;
}

export class FolderPickerModal extends Modal {
    private folders: DriveFolder[] = [];
    private isLoading: boolean = true;
    
    // 폴더 탐색을 위한 히스토리(Breadcrumbs) 스택
    private pathStack: {id: string, name: string}[] = [{id: 'root', name: 'root'}];

    constructor(app: App, private plugin: GDSyncPlugin, private onSelect: (folder: DriveFolder, fullPath: {id: string, name: string}[]) => void) {
        super(app);
        // 기존에 저장된 경로가 있다면 복원
        if (this.plugin.settings.syncFolderPath && this.plugin.settings.syncFolderPath.length > 0) {
            this.pathStack = [...this.plugin.settings.syncFolderPath];
        }
    }

    get currentParentId() {
        return this.pathStack[this.pathStack.length - 1]!.id;
    }

    async onOpen() {
        await this.loadFolders();
    }

    private errorMessage: string = '';

    async loadFolders() {
        this.isLoading = true;
        this.errorMessage = '';
        this.render();

        try {
            // GoogleDriveClient를 통해 폴더 목록 조회 (SEC-M03 fixed, driveClient is now public)
            const client = this.plugin.syncManager.driveClient;
            this.folders = await client.listFolders(this.currentParentId);
        } catch (e: any) {
            console.error("Folder load failed:", e);
            this.errorMessage = e.message || 'Unknown error';
            new Notice(t('PICKER_LOAD_FAILED', { error: this.errorMessage }));
        } finally {
            this.isLoading = false;
            this.render();
        }
    }

    render() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: t('PICKER_TITLE') });

        const pathStr = this.pathStack.map(p => p.id === 'root' ? t('FOLDER_ROOT') : p.name).join(' > ');
        contentEl.createEl('div', { text: t('SETTING_TARGET_CURRENT', { path: pathStr }) as string, cls: 'gd-sync-modal-path' });

        // ─── Breadcrumbs (상단 경로 내비게이션 추가) ───
        const navContainer = contentEl.createDiv({ cls: 'gd-sync-nav-container' });
        navContainer.style.display = 'flex';
        navContainer.style.flexWrap = 'wrap';
        navContainer.style.alignItems = 'center';
        navContainer.style.marginBottom = '10px';
        navContainer.style.padding = '8px';
        navContainer.style.backgroundColor = 'var(--background-secondary)';
        navContainer.style.borderRadius = '5px';

        this.pathStack.forEach((crumb, index) => {
            const crumbEl = navContainer.createSpan({ text: crumb.name });
            crumbEl.style.cursor = 'pointer';
            crumbEl.style.fontWeight = index === this.pathStack.length - 1 ? 'bold' : 'normal';
            crumbEl.style.color = index === this.pathStack.length - 1 ? 'var(--text-normal)' : 'var(--text-accent)';
            
            crumbEl.onclick = async () => {
                if (index < this.pathStack.length - 1) {
                    // 클릭한 위치까지 스택 되돌리기
                    this.pathStack = this.pathStack.slice(0, index + 1);
                    await this.loadFolders();
                }
            };

            if (index < this.pathStack.length - 1) {
                navContainer.createSpan({ text: ' > ' }).style.margin = '0 5px';
            }
        });

        // ─── 현재 폴더 선택하기 버튼 ───
        const currentFolderName = this.pathStack[this.pathStack.length - 1]!.name;
        const selectCurrentBtn = contentEl.createEl('button', { 
            text: t('PICKER_CURRENT_TARGET', { name: currentFolderName }), 
            cls: 'mod-cta' 
        });
        selectCurrentBtn.style.width = '100%';
        selectCurrentBtn.style.marginBottom = '15px';
        selectCurrentBtn.onclick = () => {
            this.onSelect({ 
                id: this.currentParentId, 
                name: this.pathStack[this.pathStack.length - 1]!.name 
            }, [...this.pathStack]);
            this.close();
        };


        // 새 폴더 만들기 섹션
        new Setting(contentEl)
            .setName(t('PICKER_NEW_FOLDER_NAME'))
            .setDesc(t('PICKER_NEW_FOLDER_DESC'))
            .addText(text => {
                text.setPlaceholder(t('PICKER_NEW_FOLDER_PLACEHOLDER'));
                let folderName = '';
                text.onChange(val => folderName = val);
                
                const createBtn = contentEl.createEl('button', { text: t('PICKER_NEW_FOLDER_BUTTON') });
                createBtn.onclick = async () => {
                    if (!folderName.trim()) {
                        new Notice(t('PICKER_NEW_FOLDER_EMPTY_NAME'));
                        return;
                    }
                    try {
                        const client = this.plugin.syncManager.driveClient;
                        new Notice(t('PICKER_NEW_FOLDER_CREATING'));
                        const newFolderId = await client.createFolder(folderName, this.currentParentId);
                        const finalPath = [...this.pathStack, { id: newFolderId, name: folderName }];
                        this.onSelect({ id: newFolderId, name: folderName }, finalPath);
                        this.close();
                    } catch {
                        new Notice(t('PICKER_NEW_FOLDER_FAILED'));
                    }
                };
            });

        contentEl.createEl('hr');
        contentEl.createEl('h3', { text: t('PICKER_SUBFOLDERS') });

        if (this.isLoading) {
            contentEl.createEl('p', { text: t('PICKER_LOADING') });
            return;
        }

        const listContainer = contentEl.createDiv({ cls: 'gd-sync-folder-list' });
        listContainer.style.maxHeight = '50vh'; // 화면 높이 대비 비율로 제한하여 무조건 스크롤되도록 함
        listContainer.style.minHeight = '200px';
        listContainer.style.overflowY = 'auto';
        listContainer.style.border = '1px solid var(--background-modifier-border)';
        listContainer.style.padding = '10px';
        listContainer.style.borderRadius = '5px';
        listContainer.style.backgroundColor = 'var(--background-primary)';

        if (this.errorMessage) {
            const errorDiv = listContainer.createDiv();
            errorDiv.style.color = 'var(--text-error)';
            errorDiv.createEl('strong', { text: t('PICKER_ERROR') });
            errorDiv.createEl('p', { text: this.errorMessage, attr: { style: 'white-space: pre-wrap; font-size: 0.9em; margin-top: 5px;' } });
            return;
        }

        if (this.folders.length === 0) {
            listContainer.createEl('p', { text: t('PICKER_NO_SUBFOLDERS') });
        } else {
            for (const folder of this.folders) {
                const item = listContainer.createDiv({ cls: 'gd-sync-folder-item' });
                item.style.padding = '8px';
                item.style.display = 'flex';
                item.style.justifyContent = 'space-between';
                item.style.alignItems = 'center';
                item.style.borderBottom = '1px solid var(--background-modifier-border)';
                
                // 1. 왼쪽: 폴더 이름 (더블클릭 또는 클릭하여 진입)
                const nameContainer = item.createDiv();
                nameContainer.style.cursor = 'pointer';
                nameContainer.style.flexGrow = '1';
                const icon = folder.shared ? '👥' : '📁';
                nameContainer.createSpan({ text: `${icon} ${folder.name}` });

                nameContainer.onclick = async () => {
                    this.pathStack.push({ id: folder.id, name: folder.name });
                    await this.loadFolders();
                };

                // 2. 오른쪽: 바로 선택 버튼
                const pickBtn = item.createEl('button', { text: t('PICKER_BUTTON_SELECT') });
                pickBtn.onclick = () => {
                    this.onSelect(folder, [...this.pathStack, { id: folder.id, name: folder.name }]);
                    this.close();
                };

                item.onmouseover = () => {
                    item.style.backgroundColor = 'var(--background-modifier-hover)';
                };
                item.onmouseout = () => {
                    item.style.backgroundColor = 'transparent';
                };
            }
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
