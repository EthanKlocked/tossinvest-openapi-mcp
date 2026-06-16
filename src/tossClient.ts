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
}

export class TossInvestClient {
  private tokenCache?: TokenCache;

  constructor(private readonly config: TossInvestConfig, private readonly fetcher: FetchLike = fetch) {}

  async authStatus(): Promise<Record<string, unknown>> {
    if (!this.config.hasCredentials) {
      return { configured: false, authenticated: false, reason: 'Missing TOSS_API_KEY or TOSS_SECRET_KEY' };
    }
    try {
      await this.getToken();
      return { configured: true, authenticated: true, tokenCache: this.tokenCache ? 'memory' : 'none' };
    } catch (error) {
      return { configured: true, authenticated: false, error: sanitizeError(error).message };
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
    const response = await this.fetcher(`${this.config.baseUrl}/oauth2/token`, {
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

  private async request(method: 'GET' | 'POST', path: string, options: RequestOptions): Promise<unknown> {
    const selectedAccount = options.accountSeq ?? this.config.accountSeq;
    if (options.accountRequired && selectedAccount === undefined) {
      throw new Error('accountSeq is required. Pass accountSeq per call or set TOSS_ACCOUNT_SEQ.');
    }

    const token = await this.getToken();
    const url = new URL(path, this.config.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (options.accountRequired) {
      headers['X-Tossinvest-Account'] = String(selectedAccount);
    }
    const response = await this.fetcher(url.toString(), {
      method,
      headers: options.body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const payload = await parseResponse(response);
    if (!response.ok) throw new Error(`Toss API ${method} ${path} failed (${response.status}): ${JSON.stringify(redactSensitive(payload))}`);
    if (path === '/api/v1/accounts' && Array.isArray(payload)) {
      return payload.map((account) => typeof account === 'object' && account !== null
        ? { ...account, accountNo: maskAccountNo((account as Record<string, unknown>).accountNo) }
        : account);
    }
    return redactSensitive(payload);
  }
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return text; }
}
