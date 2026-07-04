import { App, Modal, Setting } from 'obsidian';
import GDSyncPlugin from '../main';
import { t } from '../lang/helpers';

export class AuthRequiredModal extends Modal {
    constructor(app: App, private plugin: GDSyncPlugin, private onCloseCallback: () => void) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: t('AUTH_REQUIRED_TITLE') });
        contentEl.createEl('p', {
            text: t('AUTH_REQUIRED_DESC'),
            cls: 'gd-sync-auth-required-desc'
        });

        new Setting(contentEl)
            .addButton(button => button
                .setButtonText(t('AUTH_REQUIRED_RECONNECT'))
                .setCta()
                .onClick(() => {
                    this.close();
                    void this.plugin.startOAuthFlow();
                }))
            .addButton(button => button
                .setButtonText(t('AUTH_REQUIRED_LATER'))
                .onClick(() => this.close()));
    }

    onClose() {
        this.contentEl.empty();
        this.onCloseCallback();
    }
}
