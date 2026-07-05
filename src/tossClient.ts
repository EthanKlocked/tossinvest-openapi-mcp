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

export class TossInvestClient {
  private tokenCache?: TokenCache;

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
        tokenAvailable: true,
        dataApiReachable: true,
        authenticated: true,
        tokenCache: this.tokenCache ? 'memory' : 'none',
        dataApiCheck: { endpoint: '/api/v1/accounts', ok: true }
      };
    } catch (error) {
      return {
        ...baseStatus,
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

  private async getToken(): Promise<string> {
    if (!this.config.apiKey || !this.config.secretKey) {
      throw new Error('Missing TOSS_API_KEY or TOSS_SECRET_KEY');
    }
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 30_000) return this.tokenCache.token;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.apiKey,
      client_secret: this.config.secretKey
    });
    const response = await this.fetchWithTimeout(`${this.config.baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    });
    const payload = await parseResponse(response);
    if (!response.ok) throw new Error(`Toss OAuth failed: ${JSON.stringify(redactSensitive(payload))}`);
    const accessToken = String((payload as Record<string, unknown>).access_token ?? '');
    if (!accessToken) throw new Error('Toss OAuth response did not include access_token');
    const expiresIn = Number((payload as Record<string, unknown>).expires_in ?? 3600);
    this.tokenCache = { token: accessToken, expiresAt: now + Math.max(60, expiresIn) * 1000 };
    return accessToken;
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

    let { response, payload } = await execute(await this.getToken());
    if (options.retryInvalidToken !== false && isInvalidTokenResponse(response, payload)) {
      this.tokenCache = undefined;
      ({ response, payload } = await execute(await this.getToken()));
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

function isInvalidTokenResponse(response: Response, payload: unknown): boolean {
  if (response.status !== 401) return false;
  return containsInvalidToken(payload);
}

function containsInvalidToken(value: unknown): boolean {
  if (typeof value === 'string') return value.toLowerCase() === 'invalid-token';
  if (Array.isArray(value)) return value.some((item) => containsInvalidToken(item));
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value as Record<string, unknown>).some((item) => containsInvalidToken(item));
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return text; }
}
