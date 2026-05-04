import { App, Modal } from 'obsidian';
import GDSyncPlugin from '../main';
import { t } from '../lang/helpers';

export class SyncHistoryModal extends Modal {
    constructor(app: App, private plugin: GDSyncPlugin) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: t('HISTORY_TITLE') });

        const history = this.plugin.syncManager.state.getSyncHistory();
        
        if (history.length === 0) {
            contentEl.createEl('p', { text: t('HISTORY_EMPTY') });
            return;
        }

        const container = contentEl.createDiv({ cls: 'gd-sync-history-list' });
        
        history.forEach(log => {
            const item = container.createDiv({ cls: 'gd-sync-history-item' });
            const date = new Date(log.timestamp).toLocaleString();
            
            let icon = '📄';
            let actionLabel = log.action.toUpperCase();

            if (log.action === 'upload') {
                icon = '⬆️';
                actionLabel = t('HISTORY_ACTION_UPLOAD');
            } else if (log.action === 'download') {
                icon = '⬇️';
                actionLabel = t('HISTORY_ACTION_DOWNLOAD');
            } else if (log.action === 'conflict') {
                icon = '⚠️';
                actionLabel = t('HISTORY_ACTION_CONFLICT');
            } else if (log.action === 'error') {
                icon = '❌';
                actionLabel = t('HISTORY_ACTION_ERROR');
            } else if (log.action === 'delete') {
                icon = '🗑️';
                actionLabel = t('HISTORY_ACTION_DELETE');
            } else if (log.action === 'move') {
                icon = '🚚';
                actionLabel = t('HISTORY_ACTION_MOVE');
            }

            item.createEl('div', { text: `${icon} [${actionLabel}] ${log.fileName}` });
            item.createEl('small', { text: `${date} ${log.details ? `(${log.details})` : ''}`, cls: 'gd-sync-history-date' });
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
