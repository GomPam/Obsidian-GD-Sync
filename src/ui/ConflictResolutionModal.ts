import { App, Modal, Setting } from 'obsidian';
import { t } from '../lang/helpers';

export type ConflictChoice = 'keepLocal' | 'keepRemote' | 'keepBoth' | 'merge' | 'skip';

export class ConflictResolutionModal extends Modal {
    private resolvePromise: (value: ConflictChoice) => void;

    constructor(
        app: App,
        private fileName: string,
        private localTime: number,
        private remoteTime: number
    ) {
        super(app);
    }

    async openAndGetChoice(): Promise<ConflictChoice> {
        return new Promise((resolve) => {
            this.resolvePromise = resolve;
            this.open();
        });
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: t('CONFLICT_TITLE') });
        contentEl.createEl('p', { 
            text: t('CONFLICT_DESC', { name: this.fileName }),
            cls: 'gd-sync-conflict-desc'
        });

        const infoContainer = contentEl.createDiv({ cls: 'gd-sync-conflict-info' });
        
        const localDate = new Date(this.localTime).toLocaleString();
        const remoteDate = new Date(this.remoteTime).toLocaleString();

        infoContainer.createEl('div', { text: t('CONFLICT_LOCAL_MOD', { time: localDate }) });
        infoContainer.createEl('div', { text: t('CONFLICT_REMOTE_MOD', { time: remoteDate }) });

        new Setting(contentEl)
            .setName(t('CONFLICT_KEEP_LOCAL_NAME'))
            .setDesc(t('CONFLICT_KEEP_LOCAL_DESC'))
            .addButton(btn => btn
                .setButtonText(t('CONFLICT_BTN_KEEP_LOCAL'))
                .setCta()
                .onClick(() => {
                    this.resolvePromise('keepLocal');
                    this.resolvePromise = null!;
                    this.close();
                }));

        new Setting(contentEl)
            .setName(t('CONFLICT_KEEP_REMOTE_NAME'))
            .setDesc(t('CONFLICT_KEEP_REMOTE_DESC'))
            .addButton(btn => btn
                .setButtonText(t('CONFLICT_BTN_KEEP_REMOTE'))
                .setWarning()
                .onClick(() => {
                    this.resolvePromise('keepRemote');
                    this.resolvePromise = null!;
                    this.close();
                }));

        new Setting(contentEl)
            .setName(t('CONFLICT_KEEP_BOTH_NAME'))
            .setDesc(t('CONFLICT_KEEP_BOTH_DESC'))
            .addButton(btn => btn
                .setButtonText(t('CONFLICT_BTN_KEEP_BOTH'))
                .onClick(() => {
                    this.resolvePromise('keepBoth');
                    this.resolvePromise = null!;
                    this.close();
                }));

        // 텍스트 파일인 경우에만 수동 병합 옵션 표시
        const ext = this.fileName.split('.').pop()?.toLowerCase();
        if (ext === 'md' || ext === 'txt') {
            new Setting(contentEl)
                .setName(t('CONFLICT_MERGE_NAME'))
                .setDesc(t('CONFLICT_MERGE_DESC'))
                .addButton(btn => btn
                    .setButtonText(t('CONFLICT_BTN_MERGE_MANUAL'))
                    .onClick(() => {
                        this.resolvePromise('merge');
                        this.resolvePromise = null!;
                        this.close();
                    }));
        }

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t('CONFLICT_SKIP'))
                .onClick(() => {
                    this.resolvePromise('skip');
                    this.resolvePromise = null!;
                    this.close();
                }));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
        // 혹시 버튼을 안 누르고 닫은 경우를 위해 처리
        if (this.resolvePromise) {
            this.resolvePromise('skip');
        }
    }
}
