import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import GDSyncPlugin from "./main";
import { FolderPickerModal } from "./ui/FolderPickerModal";
import { SyncHistoryModal } from "./ui/SyncHistoryModal";
import { t } from "./lang/helpers";

export interface GDSyncSettings {
    pendingState?: string;
    pendingVerifier?: string;
    syncFolderName: string;
    syncFolderPath?: { id: string, name: string }[]; // 상위 경로 히스토리 저장
    autoSyncDelay: number; // 자동 동기화 딜레이 (ms)
    backgroundSyncInterval: number; // 백그라운드 동기화 주기 (분)
    conflictStrategy: 'manual' | 'keepLocal' | 'keepRemote' | 'keepBoth' | 'merge';
    trashAutoCleanupDays: number; // .trash 폴더 자동 삭제 기간 (일)
    customExtensions: string; // 사용자 지정 동기화 확장자 목록
    syncEmptyFolders: boolean; // 빈 폴더 동기화 여부
    postDownloadGuardBuffer: number; // 다운로드 후 재업로드 방지 버퍼 (ms)
}

export const DEFAULT_SETTINGS: GDSyncSettings = {
    syncFolderName: 'GD_Sync',
    syncFolderPath: [{ id: 'root', name: 'root' }],
    autoSyncDelay: 5000, // 너무 짧으면 타이핑 중 동기화 시도 가능성 높음
    backgroundSyncInterval: 5,
    conflictStrategy: 'manual',
    trashAutoCleanupDays: 0,
    customExtensions: '',
    syncEmptyFolders: false,
    postDownloadGuardBuffer: 2000
}

export class GDSyncSettingTab extends PluginSettingTab {
    plugin: GDSyncPlugin;

    constructor(app: App, plugin: GDSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // ─── Header ───────────────────────────────────────────────
        new Setting(containerEl).setName(t('SETTING_TITLE')).setHeading();

        // ─── Connection Status ────────────────────────────────────
        const isConnected = !!this.plugin.refreshToken;

        const connectionSetting = new Setting(containerEl)
            .setName(t('SETTING_CONN_STATUS'))
            .setDesc(isConnected
                ? t('SETTING_CONN_STATUS_DESC_ON')
                : t('SETTING_CONN_STATUS_DESC_OFF'));

        if (isConnected) {
            connectionSetting
                .addButton(button => button
                    .setButtonText(t('SETTING_BTN_RECONNECT'))
                    .onClick(() => this.plugin.googleOAuthManager.startOAuthFlow()))
                .addButton(button => button
                    .setButtonText(t('SETTING_BTN_DISCONNECT'))
                    .setWarning()
                    .onClick(async () => {
                        // 1. 모든 설정을 기본값으로 초기화
                        this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
                        this.plugin.refreshToken = '';
                        await this.plugin.saveSettings();

                        // 2. 인증 토큰 해제
                        this.plugin.googleOAuthManager.clearTokens();

                        // 3. 로컬 동기화 데이터베이스(SyncState) 초기화
                        await this.plugin.syncManager.state.clearAll();

                        // 4. 확장자 필터 캐시 초기화
                        this.plugin.syncManager.updateCustomExtensionsCache();

                        this.display(); // UI 새로고침
                        new Notice(t('SETTING_NOTICE_DISCONNECT'));
                    }));
        } else {
            connectionSetting
                .addButton(button => button
                    .setButtonText(t('SETTING_BTN_CONNECT'))
                    .setCta()
                    .onClick(() => this.plugin.googleOAuthManager.startOAuthFlow()));
        }

        // ─── Sync Settings (로그인 되었을 때만 노출) ─────────────────
        if (isConnected) {
            const pathNames = (this.plugin.settings.syncFolderPath || [])
                .map(p => p.id === 'root' ? t('FOLDER_ROOT') : p.name)
                .join(' > ') || t('FOLDER_ROOT');

            const folderDesc = document.createDocumentFragment();
            folderDesc.createEl('span', { text: t('SETTING_TARGET_CURRENT', { path: pathNames }) });
            folderDesc.createEl('br');
            folderDesc.createEl('span', { text: t('SETTING_TARGET_DESC') });

            new Setting(containerEl)
                .setName(t('SETTING_TARGET_FOLDER'))
                .setDesc(folderDesc)
                .addButton(button => button
                    .setButtonText(this.plugin.settings.syncFolderName ? t('SETTING_BTN_CHANGE_FOLDER') : t('SETTING_BTN_SELECT_FOLDER'))
                    .setCta()
                    .onClick(() => {
                        new FolderPickerModal(this.app, this.plugin, async (folder, fullPath) => {
                            this.plugin.settings.syncFolderName = folder.name;
                            this.plugin.settings.syncFolderPath = fullPath;
                            this.plugin.syncManager.state.setTargetFolderId(folder.id);

                            await this.plugin.saveSettings();
                            await this.plugin.syncManager.state.save();

                            new Notice(t('NOTICE_FOLDER_SELECTED', { folder: folder.name }));
                            this.display();
                        }).open();
                    }));

            new Setting(containerEl).setName(t('SETTING_ADVANCED')).setHeading();

            new Setting(containerEl)
                .setName(t('SETTING_HISTORY'))
                .setDesc(t('SETTING_HISTORY_DESC'))
                .addButton(btn => btn
                    .setButtonText(t('SETTING_BTN_VIEW_HISTORY'))
                    .onClick(() => {
                        new SyncHistoryModal(this.app, this.plugin).open();
                    }));

            new Setting(containerEl)
                .setName(t('SETTING_RESET_INDEX'))
                .setDesc(t('SETTING_RESET_INDEX_DESC'))
                .addButton(btn => btn
                    .setButtonText(t('SETTING_BTN_RESET_INDEX'))
                    .setWarning()
                    .onClick(async () => {
                        await this.plugin.syncManager.state.clearSyncIndex();
                        await this.plugin.syncManager.initialize();
                        new Notice(t('NOTICE_CACHE_RESET'));
                        void this.plugin.syncManager.syncWholeVault();
                    }));

            new Setting(containerEl)
                .setName(t('SETTING_CUSTOM_EXTENSIONS'))
                .setDesc(t('SETTING_CUSTOM_EXTENSIONS_DESC'))
                .addText(text => {
                    text.setPlaceholder(t('SETTING_CUSTOM_EXTENSIONS_PLACEHOLDER'))
                        .setValue(this.plugin.settings.customExtensions);

                    text.inputEl.addEventListener('blur', () => {
                        void (async () => {
                            const normalized = text.getValue()
                                .split(',')
                                .map(s => s.trim().toLowerCase().replace(/^\./, ''))
                                .filter(s => s.length > 0)
                                .join(', ');

                            text.setValue(normalized);
                            this.plugin.settings.customExtensions = normalized;
                            await this.plugin.saveSettings();
                            this.plugin.syncManager.updateCustomExtensionsCache();
                        })();
                    });

                    text.onChange((value) => {
                        void (async () => {
                            const normalized = value
                                .split(',')
                                .map(s => s.trim().toLowerCase().replace(/^\./, ''))
                                .filter(s => s.length > 0)
                                .join(', ');

                            this.plugin.settings.customExtensions = normalized;
                            await this.plugin.saveSettings();
                            this.plugin.syncManager.updateCustomExtensionsCache();
                        })();
                    });
                });

            new Setting(containerEl)
                .setName(t('SETTING_SYNC_EMPTY_FOLDERS'))
                .setDesc(t('SETTING_SYNC_EMPTY_FOLDERS_DESC'))
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.syncEmptyFolders)
                    .onChange(async (value) => {
                        this.plugin.settings.syncEmptyFolders = value;
                        await this.plugin.saveSettings();
                    }));

            const delaySetting = new Setting(containerEl)
                .setName(t('SETTING_DELAY'))
                .setDesc(t('SETTING_DELAY_DESC'));

            const delayValueSpan = delaySetting.controlEl.createEl('span', {
                text: t('FORMAT_SECONDS', { value: (this.plugin.settings.autoSyncDelay / 1000).toString() }),
                cls: 'gd-sync-delay-value'
            });
            delayValueSpan.addClass('gd-sync-setting-spacer');

            delaySetting.addSlider(slider => {
                slider
                    .setLimits(3, 10, 1)
                    .setValue(this.plugin.settings.autoSyncDelay / 1000)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.autoSyncDelay = value * 1000;
                        delayValueSpan.setText(t('FORMAT_SECONDS', { value: value.toString() }));
                        await this.plugin.saveSettings();
                    });

                // 드래그 중 실시간 업데이트를 위해 input 이벤트 직접 바인딩
                slider.sliderEl.addEventListener('input', (ev) => {
                    const value = (ev.target as HTMLInputElement).value;
                    delayValueSpan.setText(t('FORMAT_SECONDS', { value }));
                });
            });

            const guardBufferSetting = new Setting(containerEl)
                .setName(t('SETTING_GUARD_BUFFER'))
                .setDesc(t('SETTING_GUARD_BUFFER_DESC'));

            const guardBufferValueSpan = guardBufferSetting.controlEl.createEl('span', {
                text: t('FORMAT_SECONDS', { value: (this.plugin.settings.postDownloadGuardBuffer / 1000).toString() }),
                cls: 'gd-sync-delay-value'
            });
            guardBufferValueSpan.addClass('gd-sync-setting-spacer');

            guardBufferSetting.addSlider(slider => {
                slider
                    .setLimits(1, 10, 1)
                    .setValue(this.plugin.settings.postDownloadGuardBuffer / 1000)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.postDownloadGuardBuffer = value * 1000;
                        guardBufferValueSpan.setText(t('FORMAT_SECONDS', { value: value.toString() }));
                        await this.plugin.saveSettings();
                    });

                slider.sliderEl.addEventListener('input', (ev) => {
                    const value = (ev.target as HTMLInputElement).value;
                    guardBufferValueSpan.setText(t('FORMAT_SECONDS', { value }));
                });
            });

            const intervalSetting = new Setting(containerEl)
                .setName(t('SETTING_INTERVAL'))
                .setDesc(t('SETTING_INTERVAL_DESC'));

            const intervalValueSpan = intervalSetting.controlEl.createEl('span', {
                text: t('FORMAT_MINUTES', { value: this.plugin.settings.backgroundSyncInterval.toString() }),
                cls: 'gd-sync-delay-value'
            });
            intervalValueSpan.addClass('gd-sync-setting-spacer');

            intervalSetting.addSlider(slider => {
                slider
                    .setLimits(3, 60, 1) // 3분 ~ 60분
                    .setValue(this.plugin.settings.backgroundSyncInterval)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.backgroundSyncInterval = value;
                        intervalValueSpan.setText(t('FORMAT_MINUTES', { value: value.toString() }));
                        await this.plugin.saveSettings();
                        this.plugin.registerBackgroundSync(); // 스케줄러 재등록
                    });

                slider.sliderEl.addEventListener('input', (ev) => {
                    const value = (ev.target as HTMLInputElement).value;
                    intervalValueSpan.setText(t('FORMAT_MINUTES', { value }));
                });
            });

            new Setting(containerEl)
                .setName(t('SETTING_CONFLICT'))
                .setDesc(t('SETTING_CONFLICT_DESC'))
                .addDropdown(dropdown => {
                    dropdown
                        .addOption('manual', t('SETTING_CONFLICT_MANUAL'))
                        .addOption('keepLocal', t('SETTING_CONFLICT_LOCAL'))
                        .addOption('keepRemote', t('SETTING_CONFLICT_REMOTE'))
                        .addOption('keepBoth', t('SETTING_CONFLICT_BOTH'))
                        .addOption('merge', t('SETTING_CONFLICT_MERGE'))
                        .setValue(this.plugin.settings.conflictStrategy)
                        .onChange(async (value: string) => {
                            this.plugin.settings.conflictStrategy = value as GDSyncSettings['conflictStrategy'];
                            await this.plugin.saveSettings();
                        });
                });

            const trashSetting = new Setting(containerEl)
                .setName(t('SETTING_TRASH_CLEANUP'))
                .setDesc(t('SETTING_TRASH_CLEANUP_DESC'));

            const trashValueSpan = trashSetting.controlEl.createEl('span', {
                text: this.plugin.settings.trashAutoCleanupDays === 0 ? t('SETTING_TRASH_CLEANUP_DISABLED') : t('SETTING_TRASH_CLEANUP_DAYS', { count: this.plugin.settings.trashAutoCleanupDays.toString() }),
                cls: 'gd-sync-delay-value'
            });
            trashValueSpan.addClass('gd-sync-setting-spacer');

            trashSetting.addSlider(slider => {
                // 가상 매핑: UI 0 -> 0, UI 1 -> 30, UI 2 -> 29, ..., UI 30 -> 1
                const toUI = (val: number) => val === 0 ? 0 : 31 - val;
                const fromUI = (uiVal: number) => uiVal === 0 ? 0 : 31 - uiVal;

                slider
                    .setLimits(0, 30, 1)
                    .setValue(toUI(this.plugin.settings.trashAutoCleanupDays))
                    .setDynamicTooltip()
                    .onChange(async (uiValue) => {
                        const actualValue = fromUI(uiValue);
                        this.plugin.settings.trashAutoCleanupDays = actualValue;

                        const text = actualValue === 0 ? t('SETTING_TRASH_CLEANUP_DISABLED') : t('SETTING_TRASH_CLEANUP_DAYS', { count: actualValue.toString() });
                        trashValueSpan.setText(text);

                        await this.plugin.saveSettings();
                    });

                // 동적 툴팁의 텍스트를 강제로 가로채서 수정하는 로직
                const updateTooltip = () => {
                    const uiValue = parseInt(slider.sliderEl.value);
                    const actualValue = fromUI(uiValue);

                    const text = actualValue === 0 ? t('SETTING_TRASH_CLEANUP_DISABLED') : t('SETTING_TRASH_CLEANUP_DAYS', { count: actualValue.toString() });
                    trashValueSpan.setText(text);

                    const labelValue = actualValue.toString();

                    window.requestAnimationFrame(() => {
                        const tooltips = document.querySelectorAll('.tooltip');
                        tooltips.forEach((t: HTMLElement) => {
                            // 툴팁의 메인 텍스트가 현재 스큐된 값(uiValue)이거나 이미 변환된 값인 경우만 교체
                            if (t.firstChild && (t.firstChild.textContent === uiValue.toString() || t.firstChild.textContent === labelValue)) {
                                // 화살표(tail) 등 하위 요소를 건드리지 않기 위해 innerText가 아닌 firstChild.textContent 사용
                                t.firstChild.textContent = labelValue;

                                // 너비가 고정되지 않고 콘텐츠에 맞게 줄어들도록 스타일 강제 초기화
                                t.addClass('gd-sync-tooltip-reset');
                            }
                        });
                    });
                };

                slider.sliderEl.addEventListener('input', updateTooltip);
                slider.sliderEl.addEventListener('mousedown', updateTooltip);
                slider.sliderEl.addEventListener('mouseenter', updateTooltip);
            });
        }
    }
}
