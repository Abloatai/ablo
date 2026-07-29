/**
 * What a credential can do, said in one place.
 *
 * `ablo login` stores a mode-free management key. Runtime keys state their
 * capability class in the prefix, while the server-side row states their
 * project and branch.
 *
 * Every command that puts a credential in front of a reader derives its wording
 * here. A key's capability cannot read one way in the command that stores it,
 * another in the command that switches to it, and a third in the command that
 * reports it.
 */

import {
  classifyCredentialKind,
  type CredentialKind,
} from '@abloatai/transaction/auth/credentialPolicy';

export interface CredentialCapability {
  /** The kind this key's prefix names, or null when it carries no Ablo prefix. */
  readonly kind: CredentialKind | null;
  /** A short suffix for a key row. Empty when the key deploys and there is
   *  nothing worth saying beside it. */
  readonly label: string;
  /** One sentence for the moment a command hands this key to a reader — what it
   *  does instead, and the key that deploys. Null when the key deploys. */
  readonly note: string | null;
}

/** The secret key that deploys on the same plane this one acts on. */
function secretCounterpart(key: string): string {
  void key;
  return 'sk_';
}

/**
 * Classify a credential for display. An absent or unrecognized value yields an
 * empty capability rather than a guess: the CLI accepts keys it did not mint,
 * and describing one it cannot recognize would be inventing a limit.
 *
 * Every note stays inside what a PREFIX can prove. That a schema push needs a
 * secret key is true of all four kinds and is the server's own rule. That a key
 * cannot write ROWS is not: a restricted `rk_` minted by `sessions.create` may
 * write exactly the models its scopes name, and only the server knows which. So
 * authorization still comes from the persisted grants, not the prefix alone.
 */
export function credentialCapability(key: string | undefined): CredentialCapability {
  const kind = key ? classifyCredentialKind(key) : null;
  if (!key || kind === null) return { kind, label: '', note: null };
  const secret = `${secretCounterpart(key)}…`;
  switch (kind) {
    case 'secret':
      return { kind, label: '', note: null };
    case 'restricted':
      return {
        kind,
        label: 'scoped',
        note:
          'A scoped key does exactly what it was minted for. Authoring schema requires a ' +
          `branch-bound secret ${secret} key with schema:push.`,
      };
    case 'publishable':
      return {
        kind,
        label: 'read-only',
        note:
          'This is the key that is safe to ship in a browser bundle, and it reads. Work from a ' +
          `terminal wants a secret ${secret} key.`,
      };
    case 'ephemeral':
      return {
        kind,
        label: 'session key',
        note:
          'This is a short-lived credential minted for one signed-in person, and it expires. ' +
          `Pushing a schema needs a secret ${secret} key.`,
      };
  }
}
