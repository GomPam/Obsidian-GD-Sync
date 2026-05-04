import { Notice, Plugin, TFile, TFolder, setIcon, addIcon } from 'obsidian';
import { DEFAULT_SETTINGS, GDSyncSettings, GDSyncSettingTab } from "./settings";
import { SyncManager } from "./sync/SyncManager";
import { FolderPickerModal } from "./ui/FolderPickerModal";
import { GoogleOAuthManager } from "./api/GoogleOAuthManager";
import { SyncHistoryModal } from "./ui/SyncHistoryModal";
import { t } from "./lang/helpers";
import googleDriveIcon from "./assets/google-drive.svg";

export default class GDSyncPlugin extends Plugin {
    settings: GDSyncSettings;
    public refreshToken: string = '';
    public syncManager: SyncManager;
    public googleOAuthManager: GoogleOAuthManager;

    // 토큰 교환 중복 실행 방지 플래그 (유저의 딥링크 광클 방어)
    private _isExchanging: boolean = false;
    private backgroundSyncIntervalId: number | null = null;

    private ribbonIconEl: HTMLElement;
    public statusBarEl: HTMLElement;
    public modifyDebounceTimers = new Map<string, number>();

    async onload() {
        // 구글 드라이브 로고 SVG 등록
        addIcon('google-drive', googleDriveIcon);

        this.statusBarEl = this.addStatusBarItem();
        this.updateSyncStatus(t('STATUS_INITIALIZING'));

        try {
            await this.loadSettings();
        } catch (e) {
            console.error('[GD Sync] Failed to load settings (might be empty/corrupt data.json):', e);
            // Fallback to defaults
            this.settings = Object.assign({}, DEFAULT_SETTINGS);
        }

        this.googleOAuthManager = new GoogleOAuthManager(this);

        this.syncManager = new SyncManager(this);
        await this.syncManager.initialize();

        // Troubleshooting notice for clean install/reset
        console.log('[GD Sync] Plugin loaded successfully.');

        this.ribbonIconEl = this.addRibbonIcon('cloud', t('RIBBON_TOOLTIP'), (evt: MouseEvent) => {
            this.syncManager.syncDelta();
        });

        this.addCommand({
            id: 'force-full-sync',
            name: t('COMMAND_FORCE_SYNC'),
            callback: () => {
                this.syncManager.syncWholeVault();
            }
        });

        this.addCommand({
            id: 'view-sync-history',
            name: t('COMMAND_VIEW_HISTORY'),
            callback: () => {
                new SyncHistoryModal(this.app, this).open();
            }
        });

        // ─── 즉시 동기화 트리거 (이벤트 후킹) ──────────────────────

        const triggerDebounce = (file: TFile) => {
            const prev = this.modifyDebounceTimers.get(file.path);
            if (prev) window.clearTimeout(prev);

            const delay = this.settings.autoSyncDelay || DEFAULT_SETTINGS.autoSyncDelay;

            const timer = window.setTimeout(() => {
                this.modifyDebounceTimers.delete(file.path);
                this.syncManager.uploadFileImmediate(file);
            }, delay);

            this.modifyDebounceTimers.set(file.path, timer);
        };

        // 실제 타이핑 이벤트 감지 (에디터 내 텍스트 변화가 있을 때마다 타이머 리셋)
        this.registerEvent(this.app.workspace.on('editor-change', (editor, info) => {
            if (info && info.file instanceof TFile) {
                triggerDebounce(info.file);
            }
        }));

        // 파일 보존 이벤트 감지 (옵시디언의 자동 저장 등으로 디스크 기록 시 타이머 리셋)
        this.registerEvent(this.app.vault.on("modify", (file) => {
            if (file instanceof TFile) {
                triggerDebounce(file);
            }
        }));

        this.registerEvent(this.app.vault.on("delete", (file) => {
            if (file instanceof TFile || file instanceof TFolder) {
                // SEC-M01: Clean up timer on delete
                const prev = this.modifyDebounceTimers.get(file.path);
                if (prev) {
                    window.clearTimeout(prev);
                    this.modifyDebounceTimers.delete(file.path);
                }
                this.syncManager.handleLocalDeleteImmediate(file.path);
            }
        }));

        this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
            if (file instanceof TFile || file instanceof TFolder) {
                // SEC-M01: Clean up timer on rename
                const prev = this.modifyDebounceTimers.get(oldPath);
                if (prev) {
                    window.clearTimeout(prev);
                    this.modifyDebounceTimers.delete(oldPath);
                }
                this.syncManager.handleRenameImmediate(file, oldPath);
            }
        }));

        this.registerEvent(this.app.vault.on("create", (file) => {
            if (file instanceof TFolder) {
                this.syncManager.handleFolderCreateImmediate(file.path);
            }
        }));

        // ─── 주기적 백그라운드 동기화 (Interval) ──────────────────────
        this.registerBackgroundSync();

        // 앱 시작 시 (레이아웃 준비 완료 후) 즉시 동기화 시도
        this.app.workspace.onLayoutReady(async () => {
            // .trash 폴더 자동 정리 시도
            await this.syncManager.cleanupTrash();

            // 타겟 폴더가 설정되어 있고 인증 정보가 있는 경우에만 실행
            if (this.syncManager.state.getTargetFolderId() && this.refreshToken) {
                console.log('[GD Sync] Startup sync triggered.');
                await this.syncManager.syncDelta();
            }
        });

        this.addSettingTab(new GDSyncSettingTab(this.app, this));

        // Register protocol handler: obsidian://gd-sync-oauth?ticket=...&state=...
        this.registerObsidianProtocolHandler("gd-sync-oauth", async (params) => {
            if (params.error) {
                new Notice(`${t('OAUTH_ERROR')}${params.error}`);
                return;
            }

            if (this._isExchanging) return;
            this._isExchanging = true;

            new Notice(t('OAUTH_TICKET_RECEIVED'));
            try {
                const ticket = params.ticket;
                const state = params.state;

                // 검토 1: 메모리(최우선) 혹은 설정 파일(백업)에서 verifier/state 로드
                const verifier = this.googleOAuthManager.sessionVerifier || this.settings.pendingVerifier;
                const savedState = this.googleOAuthManager.sessionState || this.settings.pendingState;

                if (!ticket || !verifier) {
                    throw new Error("Security Error: Missing code verifier (Verifier).");
                }

                // SEC-H02: Verify that savedState exists and strictly matches
                if (!savedState || state !== savedState) {
                    throw new Error("Security Error: State value mismatch.");
                }

                // 티켓과 verifier를 함께 사용하여 Auth Proxy에서 토큰을 가져옴
                await this.googleOAuthManager.exchangeTicketForToken(ticket, verifier);
                new Notice(t('OAUTH_SUCCESS'));

                // 연동 직후 타겟 폴더가 지정되어 있지 않다면 폴더 픽커 모달 팝업
                if (!this.syncManager.state.getTargetFolderId()) {
                    setTimeout(() => {
                        new FolderPickerModal(this.app, this, async (folder, fullPath) => {
                            this.settings.syncFolderName = folder.name;
                            this.settings.syncFolderPath = fullPath;
                            this.syncManager.state.setTargetFolderId(folder.id);
                            await this.saveSettings();
                            await this.syncManager.state.save();
                            new Notice(t('NOTICE_FOLDER_SELECTED', { folder: folder.name }));

                            this.refreshSettingsUI();

                            // 폴더 선택 직후 최초 전체 동기화 자동 시작
                            setTimeout(() => {
                                this.syncManager.syncWholeVault();
                            }, 500);
                        }).open();
                    }, 300);
                }

            } catch (e: any) {
                console.error("GD Sync OAuth error:", e);
                new Notice(t('OAUTH_FAIL') + (e.message || "Check console for details."));
            } finally {
                this._isExchanging = false;

                // 보안 강화: 사용된 State/Verifier 삭제
                this.googleOAuthManager.sessionState = null;
                this.googleOAuthManager.sessionVerifier = null;
                this.settings.pendingState = undefined;
                this.settings.pendingVerifier = undefined;
                await this.saveSettings();

                this.refreshSettingsUI();
            }
        });
    }

    onunload() {
        // SEC-L01: cleanup active timers is technically already partially handled if we kept referenes, 
        // but since modifyDebounceTimers is local to onload we can't easily reach it. 
        // We'll reset sync state just in case.
        if (this.syncManager) {
            this.syncManager['isSyncing'] = false;
        }
        // V2-M01: properly cleanup instance timers
        for (const timer of this.modifyDebounceTimers.values()) {
            window.clearTimeout(timer);
        }
        this.modifyDebounceTimers.clear();
    }

    // SEC-C01 v3: refreshToken is stored in a separate file (.auth-token) rather than data.json.
    // The file is excluded from git via .gitignore, providing leak protection without encryption.
    // Uses app.vault.adapter for mobile compatibility (no Node.js fs dependency).
    private get authTokenPath(): string {
        return `${this.app.vault.configDir}/plugins/gd-sync/.auth-token`;
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<GDSyncSettings>);

        try {
            if (await this.app.vault.adapter.exists(this.authTokenPath)) {
                const token = (await this.app.vault.adapter.read(this.authTokenPath)).trim();
                if (token) this.refreshToken = token;
            }
        } catch (e) {
            console.error('[GD Sync] Failed to read .auth-token:', e);
        }
    }

    async saveSettings() {
        // Write refreshToken to separate file, completely isolated from data.json
        if (this.refreshToken) {
            try {
                await this.app.vault.adapter.write(this.authTokenPath, this.refreshToken);
            } catch (e) {
                console.error('[GD Sync] Failed to write .auth-token:', e);
            }
        } else {
            // Token cleared (disconnect) — delete the file
            try {
                if (await this.app.vault.adapter.exists(this.authTokenPath)) {
                    await this.app.vault.adapter.remove(this.authTokenPath);
                }
            } catch (e) {
                console.error('[GD Sync] Failed to remove .auth-token:', e);
            }
        }

        const settingsCopy = { ...this.settings };
        // Make absolutely sure legacy key is gone
        if ('refreshToken' in settingsCopy) {
            delete (settingsCopy as any).refreshToken;
        }

        await this.saveData(settingsCopy);
    }

    public registerBackgroundSync() {
        // 기존 타이머 해제
        if (this.backgroundSyncIntervalId !== null) {
            window.clearInterval(this.backgroundSyncIntervalId);
            this.backgroundSyncIntervalId = null;
        }

        // 설정된 분(minutes) 단위 주기를 밀리초(ms)로 변환
        const intervalMs = (this.settings.backgroundSyncInterval || 5) * 60 * 1000;
        if (intervalMs > 0) {
            this.backgroundSyncIntervalId = window.setInterval(() => {
                this.syncManager.syncDelta();
            }, intervalMs);
            // 플러그인 종료 시 자동 정리를 위해 Obsidian의 registerInterval도 함께 호명
            this.registerInterval(this.backgroundSyncIntervalId);
        }
    }

    /**
     * 타 컴포넌트 편의를 위한 Access Token 래퍼
     */
    async getAccessToken(): Promise<string> {
        return await this.googleOAuthManager.getAccessToken();
    }

    async startOAuthFlow() {
        return await this.googleOAuthManager.startOAuthFlow();
    }

    /**
     * 설정 탭 UI 동적 새로고침
     */
    refreshSettingsUI() {
        const settingModal = (this.app as any).setting;
        if (settingModal && settingModal.activeTab && settingModal.activeTab.id === this.manifest.id) {
            settingModal.activeTab.display();
        }
    }

    public setSyncBusy(busy: boolean) {
        if (busy) {
            setIcon(this.ribbonIconEl, 'refresh-cw');
            this.ribbonIconEl.addClass('gd-sync-spin');
        } else {
            setIcon(this.ribbonIconEl, 'cloud');
            this.ribbonIconEl.removeClass('gd-sync-spin');
        }
    }

    public updateSyncStatus(message: string) {
        if (this.statusBarEl) {
            this.statusBarEl.empty();
            const iconSpan = this.statusBarEl.createSpan();
            setIcon(iconSpan, 'google-drive');
            iconSpan.style.marginRight = '5px';
            iconSpan.style.display = 'inline-flex';
            iconSpan.style.alignItems = 'center';
            iconSpan.style.verticalAlign = 'middle';

            this.statusBarEl.createSpan({ text: message });
        }
    }
}
