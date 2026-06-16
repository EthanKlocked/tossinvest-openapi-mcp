const SENSITIVE_KEY_PATTERN = /(api[_-]?key|secret|token|authorization|x-tossinvest-account|accountno|account_no|accountnumber|account_number)/i;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi;
const LONG_ACCOUNT_PATTERN = /\b\d{8,}\b/g;

export function maskAccountNo(accountNo: unknown): string {
  const raw = String(accountNo ?? '');
  if (raw.length <= 4) return '*'.repeat(raw.length);
  return `${'*'.repeat(Math.max(0, raw.length - 4))}${raw.slice(-4)}`;
}

function redactString(value: string): string {
  return value.replace(BEARER_PATTERN, 'Bearer [REDACTED]').replace(LONG_ACCOUNT_PATTERN, (match) => maskAccountNo(match));
}

export function redactSensitive<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item)) as T;
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        if (/account/i.test(key) && typeof entry === 'string') output[key] = maskAccountNo(entry);
        else output[key] = '[REDACTED]';
      } else {
        output[key] = redactSensitive(entry);
      }
    }
    return output as T;
  }
  return value;
}

export function sanitizeError(error: unknown): Error {
  if (error instanceof Error) return new Error(redactString(error.message));
  return new Error(redactString(String(error)));
}
