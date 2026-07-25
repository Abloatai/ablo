export type CredentialKind =
  | 'secret'
  | 'ephemeral'
  | 'restricted'
  | 'publishable';

const KIND_BY_PREFIX: readonly (readonly [string, CredentialKind])[] = [
  ['sk_', 'secret'],
  ['ek_', 'ephemeral'],
  ['rk_', 'restricted'],
  ['pk_', 'publishable'],
];

/** Browser-safe prefix classification; server checksum validation stays server-side. */
export function classifyCredentialKind(value: string): CredentialKind | null {
  for (const [prefix, kind] of KIND_BY_PREFIX) {
    if (value.startsWith(prefix)) return kind;
  }
  return null;
}
