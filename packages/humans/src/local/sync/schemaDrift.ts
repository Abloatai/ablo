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

import { reconcileClientToActive } from '@abloatai/transaction/schema';

/** One model as the server's schema read-back reports it. */
export interface ServerSchemaModel {
  readonly key: string;
  /** Per-model content hash; absent on servers older than this check. */
  readonly hash?: string;
  readonly fields?: Readonly<Record<string, { readonly type: string; readonly isOptional: boolean }>>;
}

export interface SchemaFieldDrift { readonly model: string; readonly field: string; readonly direction: 'client_only' | 'active_only' | 'changed'; readonly detail: string; }

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
      readonly fields?: readonly SchemaFieldDrift[];
    }
  /** The server surface carries no per-model hashes (older server) — the
   *  caller falls back to the whole-hash comparison. */
  | { readonly kind: 'unknown' };

export function classifySchemaDrift(
  clientModels: Readonly<Record<string, string>>,
  serverModels: readonly ServerSchemaModel[],
  clientShapes: Readonly<Record<string, Readonly<Record<string, { readonly type: string; readonly isOptional: boolean }>>>> = {},
): SchemaDriftFinding {
  if (serverModels.length > 0 && serverModels.every((m) => !m.hash)) {
    return { kind: 'unknown' };
  }
  const server = new Map(serverModels.map((m) => [m.key, m.hash]));
  const unpushed: string[] = [];
  const changed: string[] = [];
  const fields: SchemaFieldDrift[] = [];
  for (const [key, hash] of Object.entries(clientModels)) {
    const serverHash = server.get(key);
    if (serverHash === undefined) unpushed.push(key);
    else if (serverHash !== hash) {
      changed.push(key);
      const clientFields = clientShapes[key];
      const activeFields = serverModels.find((model) => model.key === key)?.fields;
      if (clientFields && activeFields) for (const field of new Set([...Object.keys(clientFields), ...Object.keys(activeFields)])) {
        const client = clientFields[field];
        const active = activeFields[field];
        if (!active) fields.push({ model: key, field, direction: 'client_only', detail: 'present in this build but absent from the active schema' });
        else if (!client) fields.push({ model: key, field, direction: 'active_only', detail: 'present in the active schema but absent from this build' });
        else if (client.type !== active.type || client.isOptional !== active.isOptional) fields.push({ model: key, field, direction: 'changed', detail: `${client.type}${client.isOptional ? ' optional' : ' required'} in this build and ${active.type}${active.isOptional ? ' optional' : ' required'} in the active schema` });
      }
    }
  }
  if (changed.length > 0) return { kind: 'changed', models: changed, unpushed, ...(fields.length ? { fields } : {}) };
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
  const findings = finding.kind === 'unpushed'
    ? reconcileClientToActive([], finding.models, serverLabel)
    : reconcileClientToActive(finding.models, finding.unpushed, serverLabel, finding.fields ?? []);
  const changed = findings.filter(({ code }) => code === 'model_changed').map(({ model }) => model).filter(Boolean);
  const unpushed = findings.filter(({ code }) => code === 'model_unpushed').map(({ model }) => model).filter(Boolean);
  const summary = [
    ...findings.filter(({ field }) => field !== undefined).map(({ message }) => message),
    ...(changed.length ? [`Models ${changed.join(', ')} differ between this build and the active schema at ${serverLabel}.`] : []),
    ...(unpushed.length ? [`Models ${unpushed.join(', ')} are declared by this build but are not active at ${serverLabel}.`] : []),
  ];
  return `Ablo: ${summary.join(' ')} ${findings.map(({ action }) => action).filter((value, index, all) => all.indexOf(value) === index).join(' ')}`;
}
