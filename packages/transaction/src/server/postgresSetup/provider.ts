/**
 * The hosting-provider vocabulary: which managed Postgres a connection string
 * points at, whether it points at that provider's connection POOLER rather than
 * the database, and how that provider reaches `wal_level = logical`.
 *
 * One table, one entry per provider. Every fact about a provider (the domains
 * that identify it, how its pooled endpoint is spelled, the one sentence that
 * gets it to logical decoding) lives on that entry, so adding a provider is
 * adding a row rather than editing three `switch`/`if` chains that must be kept
 * in step. This is the only definition of the vocabulary: `connectApply`,
 * `connectSetup`, and `readiness` all read it from here.
 *
 * Matching is on DOMAIN LABELS, not substrings. `hostname.includes('neon.tech')`
 * also matches `neon.tech.example.com`, and `includes('.rds.')` matched any
 * self-hosted `pg.rds.internal.corp` and then told its operator to edit an RDS
 * parameter group that does not exist. A suffix must fall on a label boundary.
 *
 * Provider identification is BEST-EFFORT and used only to phrase guidance. An
 * unrecognized host is `generic`, and `generic` guidance must therefore stay
 * true for a managed host too: it offers the `ALTER SYSTEM` a self-hosted
 * cluster accepts, and names the dashboard route for a host that refuses it.
 * Asserting a statement the reader's provider cannot run is the failure this
 * whole module exists to avoid.
 */

interface ProviderSpec {
  /** Stable identifier; the source of the `DbProvider` union below. */
  readonly id: string;
  /** Registrable domains that identify this provider, matched on label boundaries. */
  readonly domains: readonly string[];
  /** How to reach `wal_level = logical` here, in one plain sentence. */
  readonly logicalReplication: string;
  /** Whether this hostname is the provider's pooled endpoint rather than the database. */
  readonly isPooledHost?: (hostname: string) => boolean;
  /** The direct target derived from a pooled one, when the name alone determines it. */
  readonly directTarget?: (hostOrTarget: string) => string;
  /**
   * The role to grant when this provider withholds the REPLICATION attribute.
   *
   * Postgres lets a role hand out only the attributes it holds, and a managed
   * provider keeps REPLICATION on an internal superuser, so `CREATE ROLE ...
   * REPLICATION` fails for the customer's own admin. Each provider exposes the
   * capability as a grantable role instead, and the name differs, which is why
   * this belongs beside the provider rather than in the recipe.
   */
  readonly replicationGrantRole?: string;
}

const PROVIDERS = [
  {
    id: 'neon',
    domains: ['neon.tech'],
    logicalReplication: `enable logical replication in your Neon project settings — it can't be set over SQL`,
    // Neon encodes pooling in the endpoint id, so the direct host is the same
    // name with the marker removed: a fix the reader applies without a lookup.
    isPooledHost: (hostname) => hostname.includes('-pooler'),
    directTarget: (hostOrTarget) => hostOrTarget.replace(/-pooler/i, ''),
  },
  {
    id: 'supabase',
    domains: ['supabase.co', 'supabase.com'],
    logicalReplication: `raise wal_level to logical in your Supabase project's database settings`,
    // Supavisor is a separate host entirely (`aws-0-<region>.pooler.supabase.com`),
    // so there is no direct host to derive from it.
    isPooledHost: (hostname) => hostname.endsWith('.pooler.supabase.com'),
  },
  {
    id: 'rds',
    // Anchored to the real RDS domains, including the China partition, rather
    // than a bare `.rds.` anywhere in the name.
    domains: ['rds.amazonaws.com', 'rds.amazonaws.com.cn'],
    logicalReplication: `set rds.logical_replication = 1 in the instance's parameter group, then reboot`,
    // RDS Proxy fronts the instance under a `.proxy-` subdomain.
    isPooledHost: (hostname) => hostname.includes('.proxy-'),
    // Neither the master user nor rds_superuser carries REPLICATION; AWS keeps
    // it on rdsadmin and exposes it through this role.
    replicationGrantRole: 'rds_replication',
  },
] as const satisfies readonly ProviderSpec[];

/**
 * Every provider the CLI can name, DERIVED from the table rather than restated
 * beside it. Written by hand, the union and the table drift in the direction
 * that fails quietly: a member with no row still type-checks everywhere and
 * silently takes the generic guidance.
 */
export type DbProvider = (typeof PROVIDERS)[number]['id'] | 'generic';

/** A host that fronts the database through a connection pooler. */
export interface PooledHost {
  readonly provider: DbProvider;
  /** The direct host, when it can be derived from the pooled one. */
  readonly direct?: string;
  /**
   * How this was established, which decides whether a caller may act on it.
   *
   * `host` is the provider's own pooled endpoint, which is what the name means
   * and cannot be anything else. `port` is a convention and nothing more: a
   * pooler is routinely moved off it, and Postgres itself is routinely put on
   * it. Refusing a run on `port` alone would block a working database with a
   * confident explanation and no way past, so a caller may stop on `host` and
   * may only caution on `port`.
   */
  readonly confidence: 'host' | 'port';
}

/**
 * Ports a connection pooler conventionally listens on, against Postgres's 5432.
 *
 * A managed pooler is identifiable by name, but a self-hosted PgBouncer or
 * Supavisor sits on an ordinary domain where the port is the only signal left.
 * 6432 is PgBouncer's shipped default and 6543 is Supavisor's transaction mode.
 *
 * This is a HINT and the set can only ever be one. A pooler is routinely moved
 * to a free port (Mastra's own pooler suite runs theirs on 6433), and nothing
 * stops a Postgres from listening on 6432. That is why a port match reports
 * `confidence: 'port'` and never justifies refusing a run on its own.
 */
const POOLER_PORTS: ReadonlySet<string> = new Set(['6432', '6543']);

/**
 * The hostname and port of a connection string, a `host:port/db` target, or a
 * bare host. Callers pass all three shapes, so this normalizes rather than
 * assuming a parsable URL.
 */
function hostAndPort(hostOrTarget: string): { hostname: string; port: string } {
  const withoutScheme = hostOrTarget.trim().replace(/^[a-z0-9+.-]+:\/\//i, '');
  const at = withoutScheme.lastIndexOf('@');
  const withoutUserinfo = at === -1 ? withoutScheme : withoutScheme.slice(at + 1);
  const authority = withoutUserinfo.split('/')[0] ?? '';
  // An IPv6 literal keeps its brackets, so the port split can't run on colons.
  const parts = /^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/.exec(authority);
  return { hostname: (parts?.[1] ?? authority).toLowerCase(), port: parts?.[2] ?? '' };
}

/** Whether `hostname` is `domain` or a subdomain of it — never a substring of a longer label. */
function inDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * Best-effort provider identification from the host. Enough to give the right
 * logical-replication instructions: the managed providers don't accept
 * `ALTER SYSTEM SET wal_level`, so printing it for them is a statement that
 * can't work.
 */
export function detectProvider(hostOrTarget: string): DbProvider {
  const { hostname } = hostAndPort(hostOrTarget);
  const spec = PROVIDERS.find((p) => p.domains.some((domain) => inDomain(hostname, domain)));
  return spec?.id ?? 'generic';
}

/**
 * Whether a host reaches the database through a CONNECTION POOLER rather than
 * the database itself. This matters because a pooler is not a smaller version
 * of the database: it terminates the session, so logical replication and the
 * setup that establishes it cannot run over it at all.
 *
 * The failure is worth naming because of how it presents. A pooler commonly
 * refuses the connection as `password authentication failed`, which sends a
 * reader to check credentials that are perfectly correct.
 */
export function detectPooler(hostOrTarget: string): PooledHost | null {
  const { hostname, port } = hostAndPort(hostOrTarget);
  const provider = detectProvider(hostOrTarget);
  const spec: ProviderSpec | undefined = PROVIDERS.find((p) => p.id === provider);
  if (spec?.isPooledHost?.(hostname)) {
    const direct = spec.directTarget?.(hostOrTarget);
    return direct === undefined
      ? { provider, confidence: 'host' }
      : { provider, direct, confidence: 'host' };
  }
  // A named provider's own host already answered for itself above; the port is
  // what catches a pooler on an ordinary domain, as a hint rather than a fact.
  if (POOLER_PORTS.has(port)) return { provider, confidence: 'port' };
  return null;
}

/** How to reach `wal_level = logical` on each provider, in one plain sentence. */
/**
 * The role that carries REPLICATION on this provider, when the attribute cannot
 * be granted directly. Null where the provider has no such role, or where the
 * admin holds the attribute already and no substitute is needed.
 */
export function replicationGrantRole(provider: DbProvider): string | null {
  // Typed as the interface rather than the inferred literal union: `as const`
  // narrows each entry to exactly the keys it wrote, so an optional one is
  // absent from the union's type even though the table declares it.
  const specs: readonly ProviderSpec[] = PROVIDERS;
  const spec = specs.find((candidate) => candidate.id === provider);
  return spec?.replicationGrantRole ?? null;
}

export function logicalReplicationGuidance(provider: DbProvider): string {
  const spec = PROVIDERS.find((p) => p.id === provider);
  if (spec) return spec.logicalReplication;
  // Unrecognized, which covers both a self-hosted cluster and a managed host
  // this table does not name yet. Give the runnable statement first, then the
  // route for a host that refuses it, so the sentence is true either way.
  return (
    `run the ALTER SYSTEM above, then restart Postgres (wal_level is not reloadable). ` +
    `On a managed host that refuses ALTER SYSTEM, set wal_level to logical in its dashboard instead`
  );
}
