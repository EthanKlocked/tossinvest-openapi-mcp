export type Env = Record<string, string | undefined>;

export interface TossInvestConfig {
  apiKey?: string;
  secretKey?: string;
  accountSeq?: number;
  hasCredentials: boolean;
  enableTrading: boolean;
  enableOrderCreate: boolean;
  enableOrderModify: boolean;
  enableOrderCancel: boolean;
  requireConfirmation: boolean;
  maxOrderKrw: number;
  maxOrderUsd: number;
  allowedSymbols: string[];
  blockedSymbols: string[];
  baseUrl: string;
  requestTimeoutMs: number;
}


const DEFAULT_BASE_URL = 'https://openapi.tossinvest.com';

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value.trim() === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultValue;
  return parsed;
}

function parseSymbolList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
}

export function loadConfig(env: Env = process.env): TossInvestConfig {
  const apiKey = env.TOSS_API_KEY || undefined;
  const secretKey = env.TOSS_SECRET_KEY || undefined;
  const accountSeqRaw = env.TOSS_ACCOUNT_SEQ;
  const accountSeq = accountSeqRaw && /^\d+$/.test(accountSeqRaw) ? Number(accountSeqRaw) : undefined;

  return {
    apiKey,
    secretKey,
    accountSeq,
    hasCredentials: Boolean(apiKey && secretKey),
    enableTrading: parseBool(env.ENABLE_TRADING, false),
    enableOrderCreate: parseBool(env.ENABLE_ORDER_CREATE, false),
    enableOrderModify: parseBool(env.ENABLE_ORDER_MODIFY, false),
    enableOrderCancel: parseBool(env.ENABLE_ORDER_CANCEL, false),
    requireConfirmation: parseBool(env.REQUIRE_CONFIRMATION, true),
    maxOrderKrw: parseNumber(env.MAX_ORDER_KRW, 0),
    maxOrderUsd: parseNumber(env.MAX_ORDER_USD, 0),
    allowedSymbols: parseSymbolList(env.ALLOWED_SYMBOLS),
    blockedSymbols: parseSymbolList(env.BLOCKED_SYMBOLS),
    baseUrl: DEFAULT_BASE_URL,
    requestTimeoutMs: parseNumber(env.TOSS_REQUEST_TIMEOUT_MS, 15_000)
  };
}
