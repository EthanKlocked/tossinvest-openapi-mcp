import type { TossInvestConfig } from './config.js';
import { maskAccountNo, redactSensitive, sanitizeError } from './redaction.js';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface TokenCache {
  token: string;
  expiresAt: number;
}

export interface RequestOptions {
  query?: Record<string, unknown>;
  accountRequired?: boolean;
  accountSeq?: number;
  body?: unknown;
  retryInvalidToken?: boolean;
}

type TokenReason = 'cold-cache' | 'expiry-margin' | 'invalid-token' | 'token-revoked';
interface TokenLifecycle {
  reason: TokenReason;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  expiresAt: number | null;
  outcome: 'pending' | 'succeeded' | 'failed';
}

export class TossInvestClient {
  // Each cache object is a distinct generation, even if token strings repeat.
  private tokenCache?: TokenCache;
  private tokenIssuance?: Promise<TokenCache>;
  private tokenLifecycle?: TokenLifecycle;

  constructor(private readonly config: TossInvestConfig, private readonly fetcher: FetchLike = fetch) {}

  async authStatus(): Promise<Record<string, unknown>> {
    if (!this.config.hasCredentials) {
      return { configured: false, authenticated: false, reason: 'Missing TOSS_API_KEY or TOSS_SECRET_KEY' };
    }

    const baseStatus = {
      configured: true,
      tokenCache: this.tokenCache ? 'memory' : 'none',
      accountSeqConfigured: this.config.accountSeq !== undefined,
      accountSeqRequiredForAccountTools: true
    };

    try {
      await this.getToken();
    } catch (error) {
      return {
        ...baseStatus,
        tokenLifecycle: this.tokenLifecycle ? { ...this.tokenLifecycle } : null,
        tokenAvailable: false,
        dataApiReachable: false,
        authenticated: false,
        error: sanitizeError(error).message
      };
    }

    try {
      await this.request('GET', '/api/v1/accounts', {});
      return {
        ...baseStatus,
        tokenLifecycle: this.tokenLifecycle ? { ...this.tokenLifecycle } : null,
        tokenAvailable: true,
        dataApiReachable: true,
        authenticated: true,
        tokenCache: this.tokenCache ? 'memory' : 'none',
        dataApiCheck: { endpoint: '/api/v1/accounts', ok: true }
      };
    } catch (error) {
      return {
        ...baseStatus,
        tokenLifecycle: this.tokenLifecycle ? { ...this.tokenLifecycle } : null,
        tokenAvailable: true,
        dataApiReachable: false,
        authenticated: false,
        tokenCache: this.tokenCache ? 'memory' : 'none',
        dataApiCheck: { endpoint: '/api/v1/accounts', ok: false, error: sanitizeError(error).message }
      };
    }
  }

  async get(path: string, options: RequestOptions = {}): Promise<unknown> {
    return this.request('GET', path, options);
  }

  async post(path: string, options: RequestOptions = {}): Promise<unknown> {
    return this.request('POST', path, options);
  }

  private async getToken(reason?: TokenReason): Promise<TokenCache> {
    if (!this.config.apiKey || !this.config.secretKey) {
      throw new Error('Missing TOSS_API_KEY or TOSS_SECRET_KEY');
    }
    if (this.tokenIssuance) return this.tokenIssuance;
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 30_000) return this.tokenCache;

    const diagnostic: TokenLifecycle = {
      reason: reason ?? (this.tokenCache ? 'expiry-margin' : 'cold-cache'),
      startedAt: now, completedAt: null, durationMs: null, expiresAt: null, outcome: 'pending'
    };
    this.tokenLifecycle = diagnostic;
    this.tokenCache = undefined;
    this.tokenIssuance = this.issueToken(now, diagnostic);
    try {
      return await this.tokenIssuance;
    } finally {
      this.tokenIssuance = undefined;
    }
  }

  private async issueToken(now: number, diagnostic: TokenLifecycle): Promise<TokenCache> {
    try {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.config.apiKey!,
        client_secret: this.config.secretKey!
      });
      const response = await this.fetchWithTimeout(`${this.config.baseUrl}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body
      });
      const payload = await parseResponse(response);
      if (!response.ok) throw new Error('OAuth rejected');
      const data = payload as Record<string, unknown> | null;
      const accessToken = data?.access_token;
      if (typeof accessToken !== 'string' || !accessToken) throw new Error('Missing access token');
      const expiresIn = Number(data?.expires_in ?? 3600);
      this.tokenCache = { token: accessToken, expiresAt: now + Math.max(60, expiresIn) * 1000 };
      diagnostic.expiresAt = this.tokenCache.expiresAt;
      diagnostic.outcome = 'succeeded';
      return this.tokenCache;
    } catch {
      diagnostic.outcome = 'failed';
      // Never carry provider bodies, network messages, or credentials into diagnostics/errors.
      throw new Error('Toss OAuth token issuance failed. Check TOSS_API_KEY/TOSS_SECRET_KEY configuration and network availability, then retry the read. Reconcile any prior order before resubmitting.');
    } finally {
      diagnostic.completedAt = Date.now();
      diagnostic.durationMs = Math.max(0, diagnostic.completedAt - now);
    }
  }

  private async fetchWithTimeout(input: string | URL, init: RequestInit): Promise<Response> {
    const timeoutMs = this.config.requestTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return this.fetcher(input, init);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetcher(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`Toss API request timed out after ${timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(method: 'GET' | 'POST', path: string, options: RequestOptions): Promise<unknown> {
    const selectedAccount = options.accountSeq ?? this.config.accountSeq;
    if (options.accountRequired && selectedAccount === undefined) {
      throw new Error('accountSeq is required. Pass accountSeq per call or set TOSS_ACCOUNT_SEQ.');
    }

    const url = new URL(path, this.config.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }

    const execute = async (token: string): Promise<{ response: Response; payload: unknown }> => {
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      if (options.accountRequired) {
        headers['X-Tossinvest-Account'] = String(selectedAccount);
      }
      const response = await this.fetchWithTimeout(url.toString(), {
        method,
        headers: options.body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
      const payload = await parseResponse(response);
      return { response, payload };
    };

    let token = await this.getToken();
    let invalidTokenRetried = false;
    let retryableAttempt = 0;
    let { response, payload } = await execute(token.token);
    while (true) {
      const authCode = recoverableAuthCode(response, payload);
      if (options.retryInvalidToken !== false && !invalidTokenRetried && authCode
        && (method === 'GET' || authCode === 'invalid-token')) {
        if (this.tokenCache === token) this.tokenCache = undefined;
        token = await this.getToken(authCode);
        invalidTokenRetried = true;
        ({ response, payload } = await execute(token.token));
        continue;
      }
      if (method === 'GET' && shouldRetryGetResponse(response, retryableAttempt)) {
        const delayMs = retryDelayMs(response, retryableAttempt);
        if (typeof delayMs !== 'number') break;
        await sleep(delayMs);
        retryableAttempt += 1;
        ({ response, payload } = await execute(token.token));
        continue;
      }
      break;
    }

    if (!response.ok) throw new Error(`Toss API ${method} ${path} failed (${response.status}): ${JSON.stringify(redactSensitive(payload))}`);
    if (path === '/api/v1/accounts' && Array.isArray(payload)) {
      return payload.map((account) => typeof account === 'object' && account !== null
        ? { ...account, accountNo: maskAccountNo((account as Record<string, unknown>).accountNo) }
        : account);
    }
    return redactSensitive(payload);
  }
}

function recoverableAuthCode(response: Response, payload: unknown): 'invalid-token' | 'token-revoked' | undefined {
  if (response.status !== 401 || typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const envelope = payload as Record<string, unknown>;
  const error = envelope.error;
  const code = typeof error === 'object' && error !== null && !Array.isArray(error) && 'code' in error
    ? (error as Record<string, unknown>).code : envelope.code;
  return code === 'invalid-token' || code === 'token-revoked' ? code : undefined;
}

const MAX_RETRY_DELAY_MS = 10_000;

function shouldRetryGetResponse(response: Response, attempt: number): boolean {
  if (response.status === 429 && attempt < 3) return retryDelayMs(response, attempt) !== undefined;
  if ([502, 503, 504].includes(response.status) && attempt < 2) return retryDelayMs(response, attempt) !== undefined;
  return false;
}

function retryDelayMs(response: Response, attempt: number): number | undefined {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      const delay = seconds * 1000;
      return delay <= MAX_RETRY_DELAY_MS ? delay : undefined;
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      const delay = Math.max(0, retryAt - Date.now());
      return delay <= MAX_RETRY_DELAY_MS ? delay : undefined;
    }
  }
  return Math.min(4000, 1000 * 2 ** attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return text; }
}
