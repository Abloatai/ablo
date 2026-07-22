/**
 * Whether a write would actually succeed right now, and when it would not, why.
 *
 * `ablo status` used to answer a narrower question — is the API reachable, is a
 * schema pushed — and both can be true while every write is refused. A plane
 * with no database connected holds writes; a client built against a schema the
 * server no longer runs is rejected. Neither fact was reachable from the
 * command people ran to check their setup, so the search moved into the
 * application, which was never the layer at fault.
 *
 * This module gathers those facts and classifies them. It renders nothing:
 * `status` prints the verdict, and a later check-everything command can reach
 * the same conclusion from the same source rather than growing a second
 * opinion.
 */

import { loadSchema, DEFAULT_SCHEMA_PATH, DEFAULT_EXPORT } from './push';
import { detectPooler } from './connectApply';
import { requestRemoteValidation, type RemoteValidation } from './remoteValidation';
import { schemaHash } from '../schema/serialize';

/** A model as the server reports it active for this key — pairing the schema key
 *  your local code addresses with the wire typename the engine routes on. */
export interface PushedModel {
  key: string;
  typename: string;
  conflict: { user?: string; agent?: string; system?: string } | null;
}

export interface PushedSchema {
  active: boolean;
  version?: number;
  /** The deployed schema's content hash — the same value a running client
   *  compares against when it warns about schema drift, so it can be matched
   *  directly here. */
  hash?: string;
  pushedAt?: string | null;
  models: PushedModel[];
}

/**
 * Fetch the schema currently active for this key's environment (`GET /api/schema`).
 * Best-effort: any failure — unreachable server, unauthorized key, or a server
 * too old to serve the route — returns null, so a caller falls back to shorter
 * output rather than erroring. The key's scope determines which environment is
 * read; there is no environment argument to pass.
 */
export async function fetchPushedSchema(
  apiUrl: string,
  apiKey: string | undefined,
): Promise<PushedSchema | null> {
  if (!apiKey) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => { ctrl.abort(); }, 3000);
  try {
    const res = await fetch(`${apiUrl}/api/schema`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as PushedSchema;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** How a connected database is reached — the two registration kinds. */
export type DataSourceConnection = 'direct' | 'endpoint';

/**
 * What the calling key's plane has connected. `none` is the decisive one: it
 * means writes are held rather than routed, which is invisible to a read probe
 * because reads can still resolve.
 */
export type DataSourceState =
  | {
      readonly kind: 'connected';
      readonly connections: readonly DataSourceConnection[];
      /** Hosts of the direct sources, when the plane reports them. Safe to
       *  show: the credential is decomposed at registration and never returns. */
      readonly hosts: readonly string[];
    }
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown'; readonly detail: string };

/** The local schema and the one the server is running, when they disagree. */
export interface SchemaDrift {
  readonly local: string;
  readonly server: string;
}

/** One thing standing between this setup and a successful write. */
export interface Blocker {
  /** What is wrong, in one line. */
  readonly problem: string;
  /** The single next command or change that resolves it. */
  readonly fix: string;
}

/**
 * Ask the plane what it has connected. Scoped entirely by the key — environment,
 * project, and sandbox all ride on the credential, so there is nothing to pass
 * and no way to read a plane the key does not address.
 *
 * Best-effort by design: this runs inside a status command that must still be
 * useful offline, so every failure resolves to `unknown` rather than throwing.
 * `unknown` is reported as unknown, never as healthy.
 */
export async function fetchDataSourceState(
  apiUrl: string,
  apiKey: string | undefined,
  timeoutMs = 4000,
): Promise<DataSourceState> {
  if (!apiKey) return { kind: 'unknown', detail: 'no key' };
  const ctrl = new AbortController();
  const t = setTimeout(() => { ctrl.abort(); }, timeoutMs);
  try {
    const res = await fetch(`${apiUrl}/api/v1/datasources`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // A restricted or wrong-environment key cannot enumerate the plane. That
      // is a fact about the key, not evidence that nothing is connected.
      return { kind: 'unknown', detail: `HTTP ${res.status}` };
    }
    const body: unknown = await res.json();
    const data =
      typeof body === 'object' && body !== null && Array.isArray((body as { data?: unknown }).data)
        ? ((body as { data: unknown[] }).data)
        : null;
    if (data === null) return { kind: 'unknown', detail: 'unrecognized response' };
    if (data.length === 0) return { kind: 'none' };
    const rows = data.filter((row): row is Record<string, unknown> =>
      typeof row === 'object' && row !== null,
    );
    const connections = rows.map((row) =>
      row.connection === 'endpoint' ? ('endpoint' as const) : ('direct' as const),
    );
    const hosts = rows.flatMap((row) => (typeof row.host === 'string' ? [row.host] : []));
    return { kind: 'connected', connections, hosts };
  } catch {
    return { kind: 'unknown', detail: 'unreachable' };
  } finally {
    clearTimeout(t);
  }
}

/**
 * The hash of the schema in this working tree — the value a running client
 * carries and the server compares against. Null when there is no local schema
 * to read (not every directory has one), which is not itself a problem.
 */
export async function readLocalSchemaHash(schemaPath = DEFAULT_SCHEMA_PATH): Promise<string | null> {
  try {
    // `loadSchema` resolves against the working directory and throws a
    // CLI-shaped error when absent; here absence just means nothing to compare.
    const schema = await loadSchema(schemaPath, DEFAULT_EXPORT);
    return schemaHash(schema);
  } catch {
    return null;
  }
}

/**
 * Does this server message read as the database refusing the credential?
 *
 * Worth asking because the answer is so often misleading: a connection pooler
 * rejects a session it cannot serve with the same wording Postgres uses for a
 * wrong password, so the message sends a reader to check credentials that are
 * correct and in use elsewhere in the same session.
 */
export function looksLikeCredentialRefusal(message: string): boolean {
  return /password authentication failed|authentication failed for user/i.test(message);
}

/**
 * What this plane has connected AND whether writes would actually route to it.
 *
 * These are two questions, and they can disagree: a registration can still be
 * listed for a plane while nothing routes — which is precisely the state that
 * holds writes rather than failing them. So the routing authority is asked
 * first, because that is the question a caller means by "is a database
 * connected", and the listing is used for the details it alone carries (the
 * host, and therefore whether it is a pooler).
 *
 * Asking the authority also replaces guessing from sampled reads: reads route
 * before writes settle, so a read that succeeds says nothing about a write.
 */
export interface RoutingState {
  readonly source: DataSourceState;
  /** The authority's answer, when it could be asked. */
  readonly validation: RemoteValidation | null;
}

export async function fetchRoutingState(
  apiUrl: string,
  apiKey: string | undefined,
): Promise<RoutingState> {
  if (!apiKey) return { source: { kind: 'unknown', detail: 'no key' }, validation: null };
  const validation = await requestRemoteValidation({ apiUrl, apiKey });
  // The one decisive negative: nothing routes here, whatever is listed.
  if (!validation.ok && validation.code === 'no_data_source_registered') {
    return { source: { kind: 'none' }, validation };
  }
  return { source: await fetchDataSourceState(apiUrl, apiKey), validation };
}

/** The first pooled host among these, with the host that was matched. */
export function detectPoolerIn(
  hosts: readonly string[],
): { readonly host: string; readonly direct?: string } | null {
  for (const host of hosts) {
    const pooled = detectPooler(host);
    if (pooled) return { host, ...(pooled.direct ? { direct: pooled.direct } : {}) };
  }
  return null;
}

/**
 * The explanation for a credential refusal that is really a pooler host, or
 * null when the plane's host is not one (in which case the refusal means what
 * it says). Best-effort: an unreadable plane simply yields no hint.
 */
export async function poolerExplanation(
  apiUrl: string,
  apiKey: string | undefined,
): Promise<string | null> {
  const state = await fetchDataSourceState(apiUrl, apiKey);
  if (state.kind !== 'connected') return null;
  const pooled = detectPoolerIn(state.hosts);
  if (!pooled) return null;
  const direct = pooled.direct
    ? ` Use the direct host instead: ${pooled.direct}.`
    : ' Use the direct database host instead, not the pooled one.';
  return (
    `${pooled.host} is a connection pooler, not the database itself. ` +
    `A pooler terminates the session, so replication and the setup that establishes it ` +
    `cannot run over it — and it refuses the connection in the same words a wrong ` +
    `password would.${direct}`
  );
}

/** Drift, or null when the two agree or either side is unknown. */
export function schemaDrift(local: string | null, server: string | undefined): SchemaDrift | null {
  if (!local || !server || local === server) return null;
  return { local, server };
}

/**
 * Everything that would stop a write, in the order a reader should act on it.
 *
 * Order is deliberate: an unreachable API makes every other finding unverifiable,
 * and a plane with nothing connected makes a schema question academic.
 */
export function blockers(input: {
  readonly reachable: boolean;
  readonly hasKey: boolean;
  readonly dataSource: DataSourceState;
  readonly schemaPushed: boolean;
  readonly drift: SchemaDrift | null;
}): readonly Blocker[] {
  const found: Blocker[] = [];
  if (!input.hasKey) {
    found.push({
      problem: 'no API key',
      fix: 'run `ablo login`, or set ABLO_API_KEY',
    });
    return found;
  }
  if (!input.reachable) {
    found.push({
      problem: 'the API is unreachable',
      fix: 'check your connection, then re-run `ablo status`',
    });
    return found;
  }
  if (input.dataSource.kind === 'none') {
    found.push({
      problem: 'no database is connected to this plane, so writes are held rather than routed',
      fix: 'connect one with `ablo connect apply`',
    });
  }
  if (!input.schemaPushed) {
    found.push({
      problem: 'no schema is active for this key',
      fix: 'run `ablo push`',
    });
  }
  if (input.drift) {
    found.push({
      problem: `the local schema (${input.drift.local}) is not the one the server is running (${input.drift.server})`,
      fix: 'run `ablo push` to deploy this tree, or check out the revision the server has',
    });
  }
  return found;
}
