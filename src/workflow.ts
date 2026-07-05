import { createHash, randomUUID } from 'node:crypto';
import type { ToolDeps } from './tools.js';
import { evaluateOrderGate } from './tradingSafety.js';
import { redactSensitive } from './redaction.js';

export const WORKFLOW_CONFIRMATION_TEXT = 'I approve this exact Toss order preview';
const DEFAULT_PREVIEW_TTL_SECONDS = 90;
const MAX_PREVIEW_TTL_SECONDS = 300;

type JsonRecord = Record<string, unknown>;
type Severity = 'pass' | 'warning' | 'blocker' | 'missing';

interface PreviewContract {
  previewId: string;
  requestHash: string;
  request: JsonRecord;
  accountSeq?: number;
  createdAt: string;
  expiresAt: string;
  delegatedAuthority?: JsonRecord;
}

const previewStore = new Map<string, PreviewContract>();

export function clearPreviewStoreForTests(): void {
  previewStore.clear();
}

function nowIso(): string {
  return new Date().toISOString();
}

function compactId(): string {
  if (typeof randomUUID === 'function') return randomUUID().replaceAll('-', '').slice(0, 16);
  return `${Date.now()}${Math.random()}`.replace(/\D/g, '').slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as JsonRecord).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as JsonRecord)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestHash(request: JsonRecord): string {
  return createHash('sha256').update(stableStringify(redactSensitive(request))).digest('hex');
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const record = value as JsonRecord;
    for (const key of ['items', 'orders', 'holdings', 'data', 'result', 'contents']) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function upper(value: unknown): string | undefined {
  return text(value)?.toUpperCase();
}

function numberValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function symbolOf(value: unknown): string | undefined {
  const record = asRecord(value);
  return upper(record.symbol ?? record.stockCode ?? record.ticker ?? record.isinCode);
}

function quantityOf(value: unknown): number | undefined {
  const record = asRecord(value);
  return numberValue(record.quantity ?? record.qty ?? record.orderQuantity ?? record.sellableQuantity);
}

function amountOf(value: unknown): number | undefined {
  const record = asRecord(value);
  return numberValue(record.amount ?? record.availableAmount ?? record.buyingPower ?? record.cash ?? record.orderAmount ?? record.valuationAmount ?? record.evaluationAmount ?? record.marketValue);
}

function priceOf(value: unknown): number | undefined {
  const record = asRecord(value);
  return numberValue(record.price ?? record.orderPrice ?? record.currentPrice ?? record.close);
}

function estimateAmount(request: JsonRecord): number | undefined {
  const orderAmount = numberValue(request.orderAmount);
  if (orderAmount !== undefined) return orderAmount;
  const price = numberValue(request.price);
  const quantity = numberValue(request.quantity);
  return price !== undefined && quantity !== undefined ? price * quantity : undefined;
}

function currencyOf(request: JsonRecord): string {
  const explicit = upper(request.currency);
  if (explicit) return explicit;
  const symbol = upper(request.symbol);
  return symbol && /^\d{6}$/.test(symbol) ? 'KRW' : 'USD';
}

function sideOf(request: JsonRecord): string {
  return upper(request.side ?? request.orderSide ?? request.tradeType) ?? 'BUY';
}

function statusOf(order: unknown): string {
  const record = asRecord(order);
  return upper(record.status ?? record.orderStatus ?? record.state) ?? 'UNKNOWN';
}

function check(code: string, status: Severity, message: string, details: JsonRecord = {}) {
  return { code, status, message, ...details };
}

async function safeRead(label: string, read: () => Promise<unknown>) {
  try {
    return { label, ok: true as const, data: await read(), fetchedAt: nowIso() };
  } catch (error) {
    return { label, ok: false as const, error: error instanceof Error ? error.message : String(error), fetchedAt: nowIso() };
  }
}

function totalHoldingValue(holdings: unknown[]): number | undefined {
  let total = 0;
  let found = false;
  for (const holding of holdings) {
    const amount = amountOf(holding);
    if (amount !== undefined) {
      total += amount;
      found = true;
    }
  }
  return found ? total : undefined;
}

function summarizeHoldings(holdings: unknown[]) {
  const totalValue = totalHoldingValue(holdings);
  return holdings.map((holding) => {
    const record = asRecord(holding);
    const value = amountOf(record);
    return {
      ...redactSensitive(record),
      symbol: symbolOf(record) ?? record.symbol,
      quantity: quantityOf(record),
      valuationAmount: value,
      weight: value !== undefined && totalValue && totalValue > 0 ? value / totalValue : undefined,
      weightStatus: value !== undefined && totalValue && totalValue > 0 ? 'calculated' : 'not_calculable'
    };
  });
}

function warningsFromStockPayload(payload: unknown) {
  const warnings: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) warnings.push(value.trim());
    else if (typeof value === 'boolean' && value) warnings.push('warning_flag_true');
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.entries(value as JsonRecord).forEach(([key, nested]) => {
      if (typeof nested === 'boolean' && nested) warnings.push(key);
      else visit(nested);
    });
  };
  visit(payload);
  return [...new Set(warnings)];
}

async function readOpenOrders(args: JsonRecord, deps: ToolDeps): Promise<unknown> {
  return deps.client.get('/api/v1/orders', { query: { status: 'OPEN', symbol: args.symbol, limit: args.limit }, accountRequired: true, accountSeq: numberValue(args.accountSeq) });
}

async function readClosedOrders(args: JsonRecord, deps: ToolDeps): Promise<unknown> {
  return deps.client.get('/api/v1/orders', { query: { status: 'CLOSED', symbol: args.symbol, from: args.from, to: args.to, cursor: args.cursor, limit: args.limit }, accountRequired: true, accountSeq: numberValue(args.accountSeq) });
}

async function readBuyingPower(currency: string, args: JsonRecord, deps: ToolDeps): Promise<unknown> {
  return deps.client.get('/api/v1/buying-power', { query: { currency }, accountRequired: true, accountSeq: numberValue(args.accountSeq) });
}

export async function portfolioSnapshot(args: JsonRecord, deps: ToolDeps) {
  const currencies = Array.isArray(args.currencies) ? args.currencies.map(String) : ['KRW', 'USD'];
  const reads = await Promise.all([
    safeRead('holdings', () => deps.client.get('/api/v1/holdings', { accountRequired: true, accountSeq: numberValue(args.accountSeq) })),
    safeRead('openOrders', () => readOpenOrders({ ...args, limit: args.limit ?? 100 }, deps)),
    ...currencies.map((currency) => safeRead(`buyingPower.${currency.toUpperCase()}`, () => readBuyingPower(currency.toUpperCase(), args, deps)))
  ]);
  const holdingRead = reads.find((read) => read.label === 'holdings');
  const orderRead = reads.find((read) => read.label === 'openOrders');
  const holdings = holdingRead?.ok ? asArray(holdingRead.data) : [];
  const openOrders = orderRead?.ok ? asArray(orderRead.data) : [];
  const partialFailures = reads.filter((read) => !read.ok).map((read) => ({ source: read.label, error: read.ok ? undefined : read.error }));
  const buyingPower: JsonRecord = {};
  for (const currency of currencies.map((item) => item.toUpperCase())) {
    const read = reads.find((candidate) => candidate.label === `buyingPower.${currency}`);
    buyingPower[currency] = read?.ok ? { status: 'ok', ...asRecord(redactSensitive(read.data)), amount: amountOf(read.data) } : { status: 'partial_failure', error: read && !read.ok ? read.error : 'not_read' };
  }
  const warningFlags = [];
  if (partialFailures.length > 0) warningFlags.push('partial_failures_present');
  if (holdings.length === 0) warningFlags.push('holdings_empty_or_unavailable');
  return {
    status: partialFailures.length ? 'partial' : 'ok',
    account: { accountSeq: numberValue(args.accountSeq) ?? deps.config.accountSeq ?? null, accountSeqConfigured: (numberValue(args.accountSeq) ?? deps.config.accountSeq) !== undefined },
    holdings: { status: holdingRead?.ok ? 'ok' : 'partial_failure', count: holdings.length, items: summarizeHoldings(holdings) },
    buyingPower,
    openOrders: { status: orderRead?.ok ? 'ok' : 'partial_failure', count: openOrders.length, items: redactSensitive(openOrders) },
    positionWeights: { status: totalHoldingValue(holdings) ? 'calculated' : 'not_calculable', basis: 'holding valuationAmount/evaluationAmount/marketValue when supplied by official API' },
    warningFlags,
    partialFailures,
    dataFreshness: { generatedAt: nowIso(), sources: reads.map((read) => ({ source: read.label, ok: read.ok, fetchedAt: read.fetchedAt })) }
  };
}

async function evaluateRealityChecks(args: JsonRecord, deps: ToolDeps) {
  const request = asRecord(args.request);
  const symbol = upper(request.symbol);
  const currency = currencyOf(request);
  const side = sideOf(request);
  const estimatedAmount = estimateAmount(request);
  const checks = [];
  const warnings = [];
  const blockers = [];
  const missing = [];
  const reads = [];

  if (!symbol) missing.push(check('symbol_missing', 'missing', 'request.symbol is required for reality checks'));

  const gate = evaluateOrderGate('create', deps.config, { dryRun: false, confirmation: undefined, request });
  for (const failure of gate.failures) {
    if (/confirmation/.test(failure)) continue;
    blockers.push(check('local_gate_failed', 'blocker', failure));
  }

  if (upper(request.orderType) === 'MARKET') blockers.push(check('market_order_blocked', 'blocker', 'Market orders are blocked by v0.2 safety policy; use a bounded LIMIT order.'));

  if (symbol) {
    const market = await safeRead('market_calendar', () => deps.client.get('/api/v1/market-calendar/KR', { query: { date: text(args.date) } }));
    reads.push(market);
    if (market.ok) {
      const record = asRecord(market.data);
      const open = record.isOpen ?? record.open ?? record.marketOpen;
      if (open === false) blockers.push(check('market_closed', 'blocker', 'Official market calendar indicates the market is closed.'));
      else if (open === true) checks.push(check('market_open', 'pass', 'Official market calendar indicates market is open.'));
      else missing.push(check('market_open_unknown', 'missing', 'Market open state was not present in the official payload.'));
    } else warnings.push(check('market_calendar_unavailable', 'warning', market.error));

    const stockWarnings = await safeRead('stock_warnings', () => deps.client.get(`/api/v1/stocks/${encodeURIComponent(symbol)}/warnings`, { query: {} }));
    reads.push(stockWarnings);
    if (stockWarnings.ok) {
      const values = warningsFromStockPayload(stockWarnings.data);
      if (values.length) warnings.push(check('stock_warning_flags', 'warning', 'Official stock warning payload contains warning flags.', { warnings: values }));
      else checks.push(check('stock_warnings_clear', 'pass', 'No warning flags found in stock warning payload.'));
    } else warnings.push(check('stock_warnings_unavailable', 'warning', stockWarnings.error));

    const priceLimits = await safeRead('price_limits', () => deps.client.get('/api/v1/price-limits', { query: { symbol } }));
    reads.push(priceLimits);
    if (priceLimits.ok) {
      const limitRecord = asRecord(priceLimits.data);
      const upperLimit = numberValue(limitRecord.upperLimit ?? limitRecord.upper);
      const lowerLimit = numberValue(limitRecord.lowerLimit ?? limitRecord.lower);
      const price = priceOf(request);
      if (price !== undefined && upperLimit !== undefined && upperLimit > 0 && price >= upperLimit * 0.98) warnings.push(check('price_near_upper_limit', 'warning', 'Limit price is near official upper price limit.', { price, upperLimit }));
      if (price !== undefined && lowerLimit !== undefined && lowerLimit > 0 && price <= lowerLimit * 1.02) warnings.push(check('price_near_lower_limit', 'warning', 'Limit price is near official lower price limit.', { price, lowerLimit }));
    } else warnings.push(check('price_limits_unavailable', 'warning', priceLimits.error));
  }

  if (side === 'BUY') {
    const buyingPower = await safeRead('buying_power', () => readBuyingPower(currency, args, deps));
    reads.push(buyingPower);
    if (buyingPower.ok) {
      const available = amountOf(buyingPower.data);
      if (available !== undefined && estimatedAmount !== undefined && available < estimatedAmount) blockers.push(check('insufficient_buying_power', 'blocker', 'Estimated order amount exceeds available buying power.', { available, estimatedAmount, currency }));
      else if (available !== undefined) checks.push(check('buying_power_sufficient', 'pass', 'Buying power is sufficient for estimated amount.', { available, estimatedAmount, currency }));
      else missing.push(check('buying_power_not_calculable', 'missing', 'Buying power amount was not present in official payload.'));
    } else warnings.push(check('buying_power_unavailable', 'warning', buyingPower.error));
  } else if (side === 'SELL' && symbol) {
    const sellable = await safeRead('sellable_quantity', () => deps.client.get('/api/v1/sellable-quantity', { query: { symbol }, accountRequired: true, accountSeq: numberValue(args.accountSeq) }));
    reads.push(sellable);
    if (sellable.ok) {
      const sellableQty = quantityOf(sellable.data) ?? amountOf(sellable.data);
      const quantity = numberValue(request.quantity);
      if (sellableQty !== undefined && quantity !== undefined && sellableQty < quantity) blockers.push(check('insufficient_sellable_quantity', 'blocker', 'Requested sell quantity exceeds sellable quantity.', { sellableQty, quantity }));
      else if (sellableQty !== undefined) checks.push(check('sellable_quantity_sufficient', 'pass', 'Sellable quantity is sufficient.', { sellableQty, quantity }));
      else missing.push(check('sellable_quantity_not_calculable', 'missing', 'Sellable quantity was not present in official payload.'));
    } else warnings.push(check('sellable_quantity_unavailable', 'warning', sellable.error));
  }

  const commissions = await safeRead('commissions', () => deps.client.get('/api/v1/commissions', { accountRequired: true, accountSeq: numberValue(args.accountSeq) }));
  reads.push(commissions);
  if (commissions.ok) checks.push(check('commission_payload_available', 'pass', 'Commission payload was read for caller-side fee estimation.', { payload: redactSensitive(commissions.data) }));
  else missing.push(check('commission_unavailable', 'missing', 'Commission/fee payload unavailable; fee estimate is not calculable.', { error: commissions.error }));

  const openOrders = await safeRead('open_orders', () => readOpenOrders({ ...args, symbol, limit: 100 }, deps));
  reads.push(openOrders);
  if (openOrders.ok) {
    const items = asArray(openOrders.data);
    const sameSymbol = symbol ? items.filter((item) => symbolOf(item) === symbol) : items;
    if (sameSymbol.length > 0) warnings.push(check('duplicate_open_order', 'warning', 'Open orders exist for the same symbol.', { count: sameSymbol.length, orders: redactSensitive(sameSymbol) }));
    const committed = sameSymbol.map(amountOf).filter((value): value is number => value !== undefined).reduce((sum, value) => sum + value, 0);
    checks.push(check('open_order_committed_amount', 'pass', 'Open-order committed amount calculated when official payload exposes amount fields.', { committedAmount: committed, calculable: committed > 0 }));
  } else warnings.push(check('open_orders_unavailable', 'warning', openOrders.error));

  const authority = asRecord(args.delegatedAuthority);
  if (Object.keys(authority).length > 0) {
    const expiresAt = text(authority.expiresAt);
    const remainingAmount = numberValue(authority.remainingAmount);
    const remainingQuantity = numberValue(authority.remainingQuantity);
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) blockers.push(check('delegated_authority_expired', 'blocker', 'Delegated authority has expired.', { expiresAt }));
    if (remainingAmount !== undefined && estimatedAmount !== undefined && estimatedAmount > remainingAmount) blockers.push(check('delegated_amount_exceeded', 'blocker', 'Estimated amount exceeds delegated authority remaining amount.', { estimatedAmount, remainingAmount }));
    const quantity = numberValue(request.quantity);
    if (remainingQuantity !== undefined && quantity !== undefined && quantity > remainingQuantity) blockers.push(check('delegated_quantity_exceeded', 'blocker', 'Quantity exceeds delegated authority remaining quantity.', { quantity, remainingQuantity }));
  }

  return { request, estimatedAmount, currency, side, checks, warnings, blockers, missing, reads };
}

export async function preTradeCheck(args: JsonRecord, deps: ToolDeps) {
  const evaluation = await evaluateRealityChecks(args, deps);
  return {
    canProceedDryRun: evaluation.blockers.length === 0 && evaluation.missing.length === 0,
    realOrderBlockedByDefault: !(deps.config.enableTrading && deps.config.enableOrderCreate),
    checks: evaluation.checks,
    warnings: evaluation.warnings,
    blockers: evaluation.blockers,
    missing: evaluation.missing,
    estimate: { amount: evaluation.estimatedAmount, currency: evaluation.currency, status: evaluation.estimatedAmount === undefined ? 'not_calculable' : 'calculated' },
    sanitizedRequest: redactSensitive(evaluation.request),
    dataFreshness: { source: 'fresh_reads', generatedAt: nowIso(), reads: evaluation.reads.map((read) => ({ source: read.label, ok: read.ok, fetchedAt: read.fetchedAt })) }
  };
}

export async function orderPreview(args: JsonRecord, deps: ToolDeps) {
  const request = asRecord(args.request);
  const ttlSeconds = Math.min(Math.max(numberValue(args.ttlSeconds) ?? DEFAULT_PREVIEW_TTL_SECONDS, 1), MAX_PREVIEW_TTL_SECONDS);
  const evaluation = await evaluateRealityChecks(args, deps);
  const hash = requestHash(request);
  const createdAt = Date.now();
  const previewId = `preview_${compactId()}`;
  const expiresAt = new Date(createdAt + ttlSeconds * 1000).toISOString();
  previewStore.set(previewId, { previewId, requestHash: hash, request, accountSeq: numberValue(args.accountSeq), createdAt: new Date(createdAt).toISOString(), expiresAt, delegatedAuthority: Object.keys(asRecord(args.delegatedAuthority)).length ? asRecord(args.delegatedAuthority) : undefined });
  return {
    previewId,
    requestHash: hash,
    ttlSeconds,
    expiresAt,
    confirmationText: WORKFLOW_CONFIRMATION_TEXT,
    estimatedAmount: evaluation.estimatedAmount,
    currency: evaluation.currency,
    fee: { status: evaluation.checks.some((item) => item.code === 'commission_payload_available') ? 'source_payload_available' : 'not_calculable' },
    cashCheck: evaluation.checks.find((item) => item.code === 'buying_power_sufficient') ?? evaluation.blockers.find((item) => item.code === 'insufficient_buying_power') ?? { status: 'not_calculable' },
    quantityCheck: evaluation.checks.find((item) => item.code === 'sellable_quantity_sufficient') ?? evaluation.blockers.find((item) => item.code === 'insufficient_sellable_quantity') ?? { status: 'not_applicable_or_not_calculable' },
    gate: { status: evaluation.blockers.length === 0 ? 'pass' : 'blocked', blockers: evaluation.blockers, warnings: evaluation.warnings, missing: evaluation.missing },
    impact: {
      postOrderCash: evaluation.estimatedAmount !== undefined ? { status: 'partially_calculable', reason: 'available buying power payload shape varies; caller should reconcile with portfolio_snapshot after execution' } : { status: 'not_calculable', reason: 'estimated amount unavailable' },
      positionWeight: { status: 'not_calculable', reason: 'requires portfolio valuation snapshot and official filled order result' },
      openOrders: { status: 'estimated', change: '+1 if submitted and accepted; reconcile with order_status_summary' }
    },
    riskFlags: [...evaluation.blockers.map((item) => item.code), ...evaluation.warnings.map((item) => item.code)],
    sanitizedRequest: redactSensitive(request)
  };
}

export async function orderExecute(args: JsonRecord, deps: ToolDeps) {
  const previewId = text(args.previewId);
  const preview = previewId ? previewStore.get(previewId) : undefined;
  const failures = [];
  if (!preview) failures.push('previewId is missing or unknown');
  if (preview && Date.parse(preview.expiresAt) <= Date.now()) failures.push('preview has expired; create a new order_preview');
  if (preview && args.requestHash !== preview.requestHash) failures.push('requestHash does not match the stored preview request');
  if (args.confirmation !== WORKFLOW_CONFIRMATION_TEXT) failures.push(`confirmation must exactly match: ${WORKFLOW_CONFIRMATION_TEXT}`);
  if (preview) {
    const gate = evaluateOrderGate('create', deps.config, { dryRun: false, confirmation: undefined, request: preview.request });
    for (const failure of gate.failures) {
      if (/confirmation/.test(failure)) continue;
      failures.push(failure);
    }
    const authority = asRecord(args.delegatedAuthority ?? preview.delegatedAuthority);
    const estimatedAmount = estimateAmount(preview.request);
    const remainingAmount = numberValue(authority.remainingAmount);
    const remainingQuantity = numberValue(authority.remainingQuantity);
    const expiresAt = text(authority.expiresAt);
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) failures.push('delegated authority has expired');
    if (remainingAmount !== undefined && estimatedAmount !== undefined && estimatedAmount > remainingAmount) failures.push('estimated amount exceeds delegated authority remaining amount');
    const quantity = numberValue(preview.request.quantity);
    if (remainingQuantity !== undefined && quantity !== undefined && quantity > remainingQuantity) failures.push('quantity exceeds delegated authority remaining quantity');
  }
  if (failures.length > 0) return { status: 'blocked', failures, previewId: previewId ?? null, nextStep: 'Call order_preview again after resolving blockers; no order POST was attempted.' };

  try {
    const response = await deps.client.post('/api/v1/orders', { accountRequired: true, accountSeq: preview?.accountSeq, body: preview?.request, retryInvalidToken: false });
    if (previewId) previewStore.delete(previewId);
    return { status: 'submitted', previewId, requestHash: preview?.requestHash, response: redactSensitive(response), nextStep: 'Call order_status_summary or order_detail to reconcile official order state.' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timed out|timeout|aborted|network|fetch failed/i.test(message)) {
      return { status: 'unknown_execution_state', previewId, error: message, nextStep: 'Do not retry automatically. Call order_status_summary and/or order_detail to reconcile before any new order attempt.' };
    }
    return { status: 'failed', previewId, error: message, nextStep: 'Call order_status_summary if there is any ambiguity before retrying manually.' };
  }
}

export async function orderStatusSummary(args: JsonRecord, deps: ToolDeps) {
  const [openRead, closedRead] = await Promise.all([
    safeRead('open_orders', () => readOpenOrders({ ...args, limit: args.limit ?? 100 }, deps)),
    safeRead('closed_orders', () => readClosedOrders({ ...args, limit: args.limit ?? 100 }, deps))
  ]);
  const openItems = openRead.ok ? asArray(openRead.data) : [];
  const closedItems = closedRead.ok ? asArray(closedRead.data) : [];
  const counts: Record<string, number> = {};
  for (const order of [...openItems, ...closedItems]) {
    const status = statusOf(order);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  const caveats = ['Orders absent from open orders may be filled, canceled, rejected, replaced, or outside the queried window; use order_detail when official order id is available.'];
  if ([...openItems, ...closedItems].some((order) => Object.keys(asRecord(order)).some((key) => /replace|modify|newOrder/i.test(key)))) {
    caveats.push('Replace/modify payload includes replace-related fields; official APIs may return a new order id that should be reconciled by order_detail.');
  }
  return {
    status: !openRead.ok || !closedRead.ok ? 'partial' : 'ok',
    openOrders: { status: openRead.ok ? 'ok' : 'partial_failure', items: redactSensitive(openItems), error: openRead.ok ? undefined : openRead.error },
    recentlyClosedOrders: { status: closedRead.ok ? 'ok' : 'partial_failure', items: redactSensitive(closedItems), error: closedRead.ok ? undefined : closedRead.error },
    stateCounts: counts,
    caveats,
    dataFreshness: { generatedAt: nowIso(), reads: [openRead, closedRead].map((read) => ({ source: read.label, ok: read.ok, fetchedAt: read.fetchedAt })) }
  };
}
