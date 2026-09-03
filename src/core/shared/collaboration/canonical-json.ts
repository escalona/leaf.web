/**
 * Serializes JSON-compatible data with recursively sorted object keys.
 *
 * Array order remains significant. Callers use the stable representation for
 * idempotency hashes, integrity checks, and encoded-size budgets, so every
 * collaboration runtime must share this implementation.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
