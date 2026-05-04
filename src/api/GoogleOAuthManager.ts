import { Notice, requestUrl } from 'obsidian';
import GDSyncPlugin from '../main';

// --- Constants ---
const GOOGLE_CLIENT_ID = '68550802589-isvmdedcs13go0o7kth6sl3embb5mna5.apps.googleusercontent.com';
const AUTH_PROXY_URL = 'https://gd-sync.hgw3674.workers.dev';

export class GoogleOAuthManager {
    private plugin: GDSyncPlugin;
    private _accessToken: string | null = null;
    private _tokenExpiresAt: number = 0;
    private _refreshPromise: Promise<string> | null = null;

    // OAuth 세션 임시값 (PKCE)
    public sessionState: string | null = null;
    public sessionVerifier: string | null = null;

    constructor(plugin: GDSyncPlugin) {
        this.plugin = plugin;
    }

    /**
     * 유효한 Access Token을 가져옵니다. 
     * 캐시된 토큰이 만료되었거나 없을 경우 Refresh Token을 사용해 갱신합니다.
     */
    async getAccessToken(): Promise<string> {
        // 1. 캐시된 토큰이 아직 유효하면 바로 반환 (60초 여유)
        if (this._accessToken && Date.now() < this._tokenExpiresAt - 60_000) {
            return this._accessToken;
        }

        // 2. refresh_token이 없으면 연결이 안 된 상태
        if (!this.plugin.refreshToken) {
            throw new Error("Google Drive에 연결되어 있지 않습니다. 설정에서 연결해 주세요.");
        }

        // 3. 이미 갱신 작업이 진행 중이면, 기존 작업이 끝날 때까지 대기(중복 요청 방지)
        if (this._refreshPromise) {
            return this._refreshPromise;
        }

        // 4. 새 갱신 작업 시작
        this._refreshPromise = (async () => {
            try {
                const refreshUrl = AUTH_PROXY_URL.endsWith('/') 
                    ? `${AUTH_PROXY_URL}refresh` 
                    : `${AUTH_PROXY_URL}/refresh`;
                
                const response = await requestUrl({
                    url: refreshUrl,
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ refresh_token: this.plugin.refreshToken }),
                    throw: false
                });

                let json: { error?: string, error_description?: string, refresh_token?: string, access_token?: string, expires_in?: number };
                try {
                    json = response.json as any;
                } catch {
                    new Notice("Auth proxy error: Server did not return JSON.");
                    throw new Error(`Auth proxy error: HTTP ${response.status}`);
                }

                if (response.status !== 200 || json.error) {
                    if (response.status === 400 || response.status === 401) {
                        this.plugin.refreshToken = '';
                        await this.plugin.saveSettings();
                        throw new Error("인증이 만료되었습니다. 설정에서 다시 연결해 주세요.");
                    }
                    throw new Error(json.error_description || json.error || `HTTP ${response.status}`);
                }

                if (json.refresh_token && json.refresh_token !== this.plugin.refreshToken) {
                    this.plugin.refreshToken = json.refresh_token;
                    await this.plugin.saveSettings();
                }

                this._accessToken = json.access_token;
                this._tokenExpiresAt = Date.now() + (json.expires_in * 1000);

                return this._accessToken!;
            } finally {
                this._refreshPromise = null;
            }
        })();

        return this._refreshPromise;
    }

    /**
     * 신규 OAuth 인증 흐름을 시작합니다.
     */
    async startOAuthFlow() {
        const state = this.generateRandomString(32);
        const codeVerifier = this.generateRandomString(64);
        const codeChallenge = await this.generateCodeChallenge(codeVerifier);

        this.sessionState = state;
        this.sessionVerifier = codeVerifier;
        
        // 폴백 저장
        this.plugin.settings.pendingState = state;
        this.plugin.settings.pendingVerifier = codeVerifier;
        await this.plugin.saveSettings();

        const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        authUrl.searchParams.append("client_id", GOOGLE_CLIENT_ID);
        const redirectUri = AUTH_PROXY_URL.endsWith('/') 
            ? `${AUTH_PROXY_URL}callback` 
            : `${AUTH_PROXY_URL}/callback`;
        
        authUrl.searchParams.append("redirect_uri", redirectUri);
        authUrl.searchParams.append("response_type", "code");
        // DESIGN DECISION: SEC-M02: drive scope is required because we allow users to pick and sync with pre-existing folders, including shared folders. 'drive.file' scope limits visibility only to files created by the app itself, breaking FolderPicker logic for existing repositories.
        authUrl.searchParams.append("scope", "https://www.googleapis.com/auth/drive");
        authUrl.searchParams.append("access_type", "offline");
        authUrl.searchParams.append("prompt", "consent");
        authUrl.searchParams.append("state", state);
        authUrl.searchParams.append("code_challenge", codeChallenge);
        authUrl.searchParams.append("code_challenge_method", "S256");

        window.open(authUrl.toString());
    }

    /**
     * 티켓을 사용해 실제 토큰으로 교환합니다.
     */
    async exchangeTicketForToken(ticket: string, verifier: string) {
        const exchangeUrl = AUTH_PROXY_URL.endsWith('/') 
            ? `${AUTH_PROXY_URL}exchange` 
            : `${AUTH_PROXY_URL}/exchange`;

        const response = await requestUrl({
            url: exchangeUrl,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ticket, verifier }),
            throw: false
        });

        let json: { error?: string, error_description?: string, refresh_token?: string, access_token?: string, expires_in?: number };
        try {
            json = response.json as any;
        } catch {
            throw new Error(`Auth proxy error: HTTP ${response.status}`);
        }

        if (response.status !== 200 || json.error) {
            const msg = json.error_description || json.error || `HTTP ${response.status}`;
            new Notice(`Exchange failed: ${msg}`);
            throw new Error(msg);
        }

        if (json.refresh_token) {
            this.plugin.refreshToken = json.refresh_token;
            await this.plugin.saveSettings();

            if (json.access_token) {
                this._accessToken = json.access_token;
                this._tokenExpiresAt = Date.now() + ((json.expires_in || 3600) * 1000);
            }
        }
    }

    // --- Helpers ---
    clearTokens() {
        this._accessToken = null;
        this._tokenExpiresAt = 0;
    }

    private generateRandomString(length: number) {
        const array = new Uint8Array(length);
        window.crypto.getRandomValues(array);
        return Array.from(array, dec => ('0' + dec.toString(16)).substr(-2)).join('').substring(0, length);
    }

    private async generateCodeChallenge(codeVerifier: string) {
        const encoder = new TextEncoder();
        const data = encoder.encode(codeVerifier);
        const digest = await window.crypto.subtle.digest('SHA-256', data);
        return this.base64UrlEncode(new Uint8Array(digest));
    }

    private base64UrlEncode(array: Uint8Array) {
        return btoa(String.fromCharCode.apply(null, array as unknown as any))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    }
}
