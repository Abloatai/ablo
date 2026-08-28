function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Stable non-cryptographic identity used only to detect a changed reviewed plan. */
export function deploymentFingerprint(value: unknown): string {
  const input = canonical(value);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index++) { hash ^= BigInt(input.charCodeAt(index)); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
  return `plan_${hash.toString(16).padStart(16, '0')}`;
}
