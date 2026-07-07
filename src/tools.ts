import { z } from 'zod';
import type { TossInvestClient } from './tossClient.js';
import type { TossInvestConfig } from './config.js';
import { CONFIRMATION_TEXT, evaluateOrderGate, type OrderOperation } from './tradingSafety.js';
import { orderExecute, orderPreview, orderStatusSummary, portfolioSnapshot, preTradeCheck, WORKFLOW_CONFIRMATION_TEXT } from './workflow.js';

export type ToolDefinition = {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, deps: ToolDeps) => Promise<unknown> | unknown;
} | {
  name: string;
  description: string;
  path: string;
  method: 'GET';
  accountRequired?: boolean;
  schema: z.ZodRawShape;
  makeQuery?: (args: Record<string, unknown>) => Record<string, unknown>;
  makePath?: (args: Record<string, unknown>) => string;
};

export interface ToolDeps { client: TossInvestClient; config: TossInvestConfig }

const accountSeq = z.number().int().positive().optional();
const symbol = z.string().regex(/^[A-Za-z0-9.\-]+$/);
const symbols = z.string().regex(/^[A-Za-z0-9.,\-]+$/);

function q(keys: string[]) {
  return (args: Record<string, unknown>) => Object.fromEntries(keys.map((key) => [key, args[key]]));
}

async function readOnly(tool: Extract<ToolDefinition, { method: 'GET' }>, args: Record<string, unknown>, deps: ToolDeps) {
  const path = tool.makePath ? tool.makePath(args) : tool.path;
  return deps.client.get(path, {
    query: tool.makeQuery ? tool.makeQuery(args) : args,
    accountRequired: tool.accountRequired,
    accountSeq: typeof args.accountSeq === 'number' ? args.accountSeq : undefined
  });
}

function orderTool(operation: OrderOperation, pathFactory: (args: Record<string, unknown>) => string) {
  return async (args: Record<string, unknown>, deps: ToolDeps) => {
    const request = (args.request && typeof args.request === 'object' ? args.request : {}) as Record<string, unknown>;
    const gate = evaluateOrderGate(operation, deps.config, {
      dryRun: args.dryRun as boolean | undefined,
      confirmation: args.confirmation as string | undefined,
      request
    });
    if (!gate.shouldExecute) return { status: 'blocked_or_dry_run', ...gate };
    return deps.client.post(pathFactory(args), {
      accountRequired: true,
      accountSeq: typeof args.accountSeq === 'number' ? args.accountSeq : undefined,
      body: request
    });
  };
}

export const toolDefinitions: ToolDefinition[] = [
  { name: 'auth_status', description: 'Check Toss API credential configuration and token status without returning secrets.', schema: {}, handler: (_args, deps) => deps.client.authStatus() },
  { name: 'accounts', description: 'List Toss Securities accounts. Account numbers are masked.', path: '/api/v1/accounts', method: 'GET', schema: {} },
  { name: 'holdings', description: 'Read holdings for an account using X-Tossinvest-Account.', path: '/api/v1/holdings', method: 'GET', accountRequired: true, schema: { accountSeq, symbol: symbol.optional() }, makeQuery: q(['symbol']) },
  { name: 'prices', description: 'Read current prices for comma-separated symbols.', path: '/api/v1/prices', method: 'GET', schema: { symbols }, makeQuery: q(['symbols']) },
  { name: 'orderbook', description: 'Read orderbook for a symbol.', path: '/api/v1/orderbook', method: 'GET', schema: { symbol }, makeQuery: q(['symbol']) },
  { name: 'trades', description: 'Read recent trades for a symbol.', path: '/api/v1/trades', method: 'GET', schema: { symbol, count: z.number().int().min(1).max(50).optional() }, makeQuery: q(['symbol', 'count']) },
  { name: 'price_limits', description: 'Read upper/lower price limits for a symbol.', path: '/api/v1/price-limits', method: 'GET', schema: { symbol }, makeQuery: q(['symbol']) },
  { name: 'candles', description: 'Read candles for a symbol.', path: '/api/v1/candles', method: 'GET', schema: { symbol, interval: z.string(), count: z.number().int().min(1).max(200).optional(), before: z.string().optional(), adjusted: z.boolean().optional() }, makeQuery: q(['symbol', 'interval', 'count', 'before', 'adjusted']) },
  { name: 'stock_info', description: 'Read basic stock info for comma-separated symbols.', path: '/api/v1/stocks', method: 'GET', schema: { symbols }, makeQuery: q(['symbols']) },
  { name: 'stock_warnings', description: 'Read buy-warning information for a stock.', path: '/api/v1/stocks/{symbol}/warnings', method: 'GET', schema: { symbol }, makePath: (args) => `/api/v1/stocks/${encodeURIComponent(String(args.symbol))}/warnings`, makeQuery: () => ({}) },
  { name: 'exchange_rate', description: 'Read exchange rate from official Toss API.', path: '/api/v1/exchange-rate', method: 'GET', schema: { baseCurrency: z.string(), quoteCurrency: z.string(), dateTime: z.string().optional() }, makeQuery: q(['baseCurrency', 'quoteCurrency', 'dateTime']) },
  { name: 'market_calendar', description: 'Read KR or US market calendar.', path: '/api/v1/market-calendar/KR', method: 'GET', schema: { market: z.enum(['KR', 'US']).default('KR'), date: z.string().optional() }, makePath: (args) => `/api/v1/market-calendar/${args.market === 'US' ? 'US' : 'KR'}`, makeQuery: q(['date']) },
  { name: 'orders_open', description: 'Read open orders for an account.', path: '/api/v1/orders', method: 'GET', accountRequired: true, schema: { accountSeq, symbol: symbol.optional(), limit: z.number().int().min(1).max(100).optional() }, makeQuery: (args) => ({ status: 'OPEN', symbol: args.symbol, limit: args.limit }) },
  { name: 'orders_closed', description: 'Read closed orders for an account if supported by Toss API.', path: '/api/v1/orders', method: 'GET', accountRequired: true, schema: { accountSeq, symbol: symbol.optional(), from: z.string().optional(), to: z.string().optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }, makeQuery: (args) => ({ status: 'CLOSED', symbol: args.symbol, from: args.from, to: args.to, cursor: args.cursor, limit: args.limit }) },
  { name: 'order_detail', description: 'Read one order detail for an account.', path: '/api/v1/orders/{orderId}', method: 'GET', accountRequired: true, schema: { accountSeq, orderId: z.string() }, makePath: (args) => `/api/v1/orders/${encodeURIComponent(String(args.orderId))}`, makeQuery: () => ({}) },
  { name: 'buying_power', description: 'Read buying power for an account and currency.', path: '/api/v1/buying-power', method: 'GET', accountRequired: true, schema: { accountSeq, currency: z.string() }, makeQuery: q(['currency']) },
  { name: 'sellable_quantity', description: 'Read sellable quantity for an account and symbol.', path: '/api/v1/sellable-quantity', method: 'GET', accountRequired: true, schema: { accountSeq, symbol }, makeQuery: q(['symbol']) },
  { name: 'commissions', description: 'Read official Toss account commission rates.', path: '/api/v1/commissions', method: 'GET', accountRequired: true, schema: { accountSeq } },
  { name: 'order_validate', description: `Validate order safety gates only. Never calls Toss order POST endpoints. Confirmation text: ${CONFIRMATION_TEXT}`, schema: { operation: z.enum(['create', 'modify', 'cancel']).default('create'), dryRun: z.boolean().default(true), confirmation: z.string().optional(), request: z.record(z.unknown()) }, handler: (args, deps) => evaluateOrderGate((args.operation as OrderOperation) ?? 'create', deps.config, { dryRun: args.dryRun as boolean | undefined, confirmation: args.confirmation as string | undefined, request: args.request as Record<string, unknown> }) },
  { name: 'portfolio_snapshot', description: "Read a structured account snapshot: holdings, KRW/USD buying power, open orders, calculable position weights, warning flags, and partial failures. If status is 'partial', do not trust holdings.count as a complete account position count; retry or use a fallback read path.", schema: { accountSeq, currencies: z.array(z.enum(['KRW', 'USD'])).optional(), limit: z.number().int().min(1).max(100).optional() }, handler: portfolioSnapshot },
  { name: 'pre_trade_check', description: 'Run separate pre-execution safety/reality checks for a candidate order. Read/check only; not required in order_execute hot path.', schema: { accountSeq, request: z.record(z.unknown()), delegatedAuthority: z.record(z.unknown()).optional(), date: z.string().optional() }, handler: preTradeCheck },
  { name: 'order_preview', description: `Create an in-memory preview contract for an order. Never calls Toss order POST endpoints. order_execute confirmation text: ${WORKFLOW_CONFIRMATION_TEXT}`, schema: { accountSeq, request: z.record(z.unknown()), delegatedAuthority: z.record(z.unknown()).optional(), ttlSeconds: z.number().int().min(1).max(300).optional(), date: z.string().optional() }, handler: orderPreview },
  { name: 'order_execute', description: 'Fast preview-based order execution. Requires valid unexpired previewId, matching requestHash, exact confirmation, and passing env/delegated-authority gates. No automatic order POST retry.', schema: { previewId: z.string(), requestHash: z.string(), confirmation: z.string(), delegatedAuthority: z.record(z.unknown()).optional() }, handler: orderExecute },
  { name: 'order_status_summary', description: 'Read-only order reconciliation summary for open and recently closed orders, state counts, and replace/modify caveats.', schema: { accountSeq, symbol: symbol.optional(), from: z.string().optional(), to: z.string().optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }, handler: orderStatusSummary },
  { name: 'order_create', description: 'Create an order. Default dry-run; real execution requires ENABLE_TRADING, ENABLE_ORDER_CREATE, dryRun=false, confirmation, amount, and symbol gates.', schema: { accountSeq, dryRun: z.boolean().default(true), confirmation: z.string().optional(), request: z.record(z.unknown()) }, handler: orderTool('create', () => '/api/v1/orders') },
  { name: 'order_modify', description: 'Modify an order. Default dry-run; real execution requires ENABLE_TRADING, ENABLE_ORDER_MODIFY, dryRun=false, confirmation, and applicable gates.', schema: { accountSeq, orderId: z.string(), dryRun: z.boolean().default(true), confirmation: z.string().optional(), request: z.record(z.unknown()) }, handler: orderTool('modify', (args) => `/api/v1/orders/${encodeURIComponent(String(args.orderId))}/modify`) },
  { name: 'order_cancel', description: 'Cancel an order. Default dry-run; real execution requires ENABLE_TRADING, ENABLE_ORDER_CANCEL, dryRun=false, confirmation, and caller-supplied request.symbol when symbol allow/block policy is configured.', schema: { accountSeq, orderId: z.string(), dryRun: z.boolean().default(true), confirmation: z.string().optional(), request: z.record(z.unknown()).default({}) }, handler: orderTool('cancel', (args) => `/api/v1/orders/${encodeURIComponent(String(args.orderId))}/cancel`) }
];

export async function executeTool(name: string, args: Record<string, unknown>, deps: ToolDeps): Promise<unknown> {
  const tool = toolDefinitions.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if ('handler' in tool) return tool.handler(args, deps);
  return readOnly(tool, args, deps);
}
