import type { TossInvestConfig } from './config.js';
import { redactSensitive } from './redaction.js';

export const CONFIRMATION_TEXT = 'I understand this may place a real Toss Securities order';
export type OrderOperation = 'create' | 'modify' | 'cancel';

export interface OrderGateInput {
  dryRun?: boolean;
  confirmation?: string;
  request: Record<string, unknown>;
}

export interface OrderGateResult {
  operation: OrderOperation;
  dryRun: boolean;
  shouldExecute: boolean;
  failures: string[];
  gateStatus: Record<string, boolean | string | number | null>;
  sanitizedRequest: Record<string, unknown>;
  estimatedAmount?: number;
  currency?: string;
}

function enabledForOperation(operation: OrderOperation, config: TossInvestConfig): boolean {
  if (operation === 'create') return config.enableOrderCreate;
  if (operation === 'modify') return config.enableOrderModify;
  return config.enableOrderCancel;
}

function operationEnvName(operation: OrderOperation): string {
  if (operation === 'create') return 'ENABLE_ORDER_CREATE';
  if (operation === 'modify') return 'ENABLE_ORDER_MODIFY';
  return 'ENABLE_ORDER_CANCEL';
}

function normalizeSymbol(symbol: unknown): string | undefined {
  return typeof symbol === 'string' && symbol.trim() ? symbol.trim().toUpperCase() : undefined;
}

function decimal(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function inferCurrency(request: Record<string, unknown>): string | undefined {
  const explicit = typeof request.currency === 'string' ? request.currency.toUpperCase() : undefined;
  if (explicit) return explicit;
  const symbol = normalizeSymbol(request.symbol);
  if (symbol && /^\d{6}$/.test(symbol)) return 'KRW';
  if (symbol) return 'USD';
  return undefined;
}

function estimateAmount(request: Record<string, unknown>): number | undefined {
  const orderAmount = decimal(request.orderAmount);
  if (orderAmount !== undefined) return orderAmount;
  const price = decimal(request.price);
  const quantity = decimal(request.quantity);
  if (price !== undefined && quantity !== undefined) return price * quantity;
  return undefined;
}

function requirePositiveDecimal(fieldName: 'quantity' | 'price' | 'orderAmount', request: Record<string, unknown>, failures: string[]): void {
  if (request[fieldName] === undefined || request[fieldName] === null || request[fieldName] === '') return;
  const parsed = decimal(request[fieldName]);
  if (parsed === undefined) {
    failures.push(`${fieldName} must be a finite number`);
    return;
  }
  if (parsed <= 0) failures.push(`${fieldName} must be greater than 0`);
}

export function evaluateOrderGate(operation: OrderOperation, config: TossInvestConfig, input: OrderGateInput): OrderGateResult {
  const dryRun = input.dryRun !== false;
  const failures: string[] = [];
  const symbol = normalizeSymbol(input.request.symbol);
  const currency = inferCurrency(input.request);
  const estimatedAmount = estimateAmount(input.request);

  if (!config.enableTrading) failures.push('ENABLE_TRADING must be true for real trading');
  if (!enabledForOperation(operation, config)) failures.push(`${operationEnvName(operation)} must be true for this operation`);
  if (dryRun) failures.push('dryRun must be false for real execution');
  if (config.requireConfirmation && input.confirmation !== CONFIRMATION_TEXT) failures.push(`confirmation must exactly match: ${CONFIRMATION_TEXT}`);

  if (symbol && config.blockedSymbols.includes(symbol)) failures.push(`symbol ${symbol} is blocked by BLOCKED_SYMBOLS`);
  else if (symbol && config.allowedSymbols.length > 0 && !config.allowedSymbols.includes(symbol)) failures.push(`symbol ${symbol} is not included in ALLOWED_SYMBOLS`);
  else if (!symbol && operation !== 'cancel') failures.push('request.symbol is required for symbol policy checks');

  if (operation !== 'cancel') {
    requirePositiveDecimal('quantity', input.request, failures);
    requirePositiveDecimal('price', input.request, failures);
    requirePositiveDecimal('orderAmount', input.request, failures);
  }

  if (estimatedAmount !== undefined && currency === 'KRW' && estimatedAmount > config.maxOrderKrw) {
    failures.push(`estimated order amount ${estimatedAmount} exceeds MAX_ORDER_KRW=${config.maxOrderKrw}`);
  }
  if (estimatedAmount !== undefined && currency === 'USD' && estimatedAmount > config.maxOrderUsd) {
    failures.push(`estimated order amount ${estimatedAmount} exceeds MAX_ORDER_USD=${config.maxOrderUsd}`);
  }
  if (estimatedAmount === undefined && operation !== 'cancel') {
    failures.push('order amount could not be calculated from price*quantity or orderAmount');
  }

  return {
    operation,
    dryRun,
    shouldExecute: failures.length === 0,
    failures,
    gateStatus: {
      ENABLE_TRADING: config.enableTrading,
      [operationEnvName(operation)]: enabledForOperation(operation, config),
      REQUIRE_CONFIRMATION: config.requireConfirmation,
      MAX_ORDER_KRW: config.maxOrderKrw,
      MAX_ORDER_USD: config.maxOrderUsd,
      symbol: symbol ?? null
    },
    sanitizedRequest: redactSensitive(input.request),
    estimatedAmount,
    currency
  };
}
