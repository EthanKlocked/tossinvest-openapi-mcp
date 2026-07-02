#!/usr/bin/env node
import { loadConfig } from '../dist/config.js';
import { TossInvestClient } from '../dist/tossClient.js';
import { executeTool } from '../dist/tools.js';
import { redactSensitive } from '../dist/redaction.js';

const config = loadConfig(process.env);

function print(label, value) {
  console.log(`\n## ${label}`);
  console.log(JSON.stringify(redactSensitive(value), null, 2));
}

if (!config.hasCredentials) {
  console.log('SKIP: TOSS_API_KEY and TOSS_SECRET_KEY are required for the opt-in read-only integration smoke test.');
  console.log('No Toss API request was made.');
  process.exit(0);
}

const client = new TossInvestClient(config);
const deps = { client, config };
const checks = [
  ['auth_status', {}],
  ['accounts', {}],
  ['market_calendar', { market: 'KR' }]
];

let failures = 0;
for (const [name, args] of checks) {
  try {
    const result = await executeTool(name, args, deps);
    print(`${name} OK`, result);
  } catch (error) {
    failures += 1;
    print(`${name} FAILED`, { error: error instanceof Error ? error.message : String(error) });
  }
}

if (failures > 0) {
  console.error(`\nRead-only smoke test completed with ${failures} failure(s). No trading operation was attempted.`);
  process.exit(1);
}
console.log('\nRead-only smoke test passed. No trading operation was attempted.');
