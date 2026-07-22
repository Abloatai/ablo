/**
 * The semantic schema-drift classifier — the question that matters is not
 * "did the schema change at all?" (one whole-schema hash answers that, and
 * welds every client to every push) but "does THIS client use anything that
 * changed?". This module compares only the models the client declares against
 * the server's per-model surface (`GET /api/schema`), so:
 *
 *   - a purely additive server change (models this build never references) is
 *     SILENCE — deployed clients don't care what they don't use;
 *   - a model this build declares that the server doesn't have is named, with
 *     the push as the fix;
 *   - a shared model whose content differs is named, so "which field moved"
 *     is one `ablo status` away instead of a hash-guessing game.
 *
 * Pure and transport-free; the BootstrapFetcher owns fetching the surface.
 */

/** One model as the server's schema read-back reports it. */
export interface ServerSchemaModel {
  readonly key: string;
  /** Per-model content hash; absent on servers older than this check. */
  readonly hash?: string;
}

export type SchemaDriftFinding =
  /** Every model this client declares exists server-side with matching content
   *  (the server may know more — that's an additive lead, not drift). */
  | { readonly kind: 'aligned' }
  /** Models this build declares that the server has no idea about — writes to
   *  them will be declined until the schema is pushed. */
  | { readonly kind: 'unpushed'; readonly models: readonly string[] }
  /** Shared models whose content differs between this build and the server
   *  (may also carry unpushed models found alongside). */
  | {
      readonly kind: 'changed';
      readonly models: readonly string[];
      readonly unpushed: readonly string[];
    }
  /** The server surface carries no per-model hashes (older server) — the
   *  caller falls back to the whole-hash comparison. */
  | { readonly kind: 'unknown' };

export function classifySchemaDrift(
  clientModels: Readonly<Record<string, string>>,
  serverModels: readonly ServerSchemaModel[],
): SchemaDriftFinding {
  if (serverModels.length > 0 && serverModels.every((m) => !m.hash)) {
    return { kind: 'unknown' };
  }
  const server = new Map(serverModels.map((m) => [m.key, m.hash]));
  const unpushed: string[] = [];
  const changed: string[] = [];
  for (const [key, hash] of Object.entries(clientModels)) {
    const serverHash = server.get(key);
    if (serverHash === undefined) unpushed.push(key);
    else if (serverHash !== hash) changed.push(key);
  }
  if (changed.length > 0) return { kind: 'changed', models: changed, unpushed };
  if (unpushed.length > 0) return { kind: 'unpushed', models: unpushed };
  return { kind: 'aligned' };
}

/**
 * The warning for a real, named divergence. Calm and specific: which models,
 * what that means for this client, and the one next step. Never speaks about
 * hashes — the point of the semantic check is that nobody has to compare hex.
 */
export function describeSchemaDrift(
  finding: Extract<SchemaDriftFinding, { kind: 'unpushed' | 'changed' }>,
  serverLabel: string,
): string {
  if (finding.kind === 'unpushed') {
    return (
      `Ablo: This build declares models the server at ${serverLabel} doesn't have yet ` +
      `(${finding.models.join(', ')}). Writes to them will be declined until the schema is ` +
      `pushed — run \`ablo push\` (and \`ablo status\` to confirm it targets this server).`
    );
  }
  const alsoUnpushed = finding.unpushed.length > 0 ? ` (${finding.unpushed.join(', ')} not pushed yet)` : '';
  return (
    `Ablo: These models differ between this build and the server at ${serverLabel}: ` +
    `${finding.models.join(', ')}${alsoUnpushed}. Reads and writes touching what changed may be ` +
    `declined — \`ablo status\` shows the deployed shape; pushing your schema or deploying a ` +
    `current build aligns them.`
  );
}
