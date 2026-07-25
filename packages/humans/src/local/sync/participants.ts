import type { JoinOptions } from '@abloatai/transaction/resources/modelOperations';
import type { SyncWebSocket } from './SyncWebSocket.js';
import type { Schema, SchemaRecord } from '@abloatai/transaction/schema/schema';
import { scopeKindOf, type ModelDef } from '@abloatai/transaction/schema/model';
import { AbloValidationError } from '@abloatai/transaction/errors';
import type {
  Claim,
  Activity,
  ClaimTarget,
  ClaimLeaseOptions,
  ClaimStream,
  Peer,
  PresenceStream,
  PresenceTarget,
} from '@abloatai/transaction/types/streams';
import {
  subTarget,
  streamTarget,
  wireTarget,
} from '@abloatai/transaction/coordination';
import type { AttachableClaimStream } from './createClaimStream.js';

/**
 * The scope a participant can be joined to. The usual form is an entity target
 * (`{ type, id }`); raw sync-group strings are an advanced escape hatch for
 * addressing a transport scope directly.
 */
export type ParticipantScope =
  | ClaimTarget
  | readonly ClaimTarget[]
  | string
  | readonly string[]
  | { readonly syncGroup: string }
  | { readonly syncGroups: readonly string[] }
  | Record<string, string | readonly string[] | undefined>;

export type ParticipantStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'disconnected';

export interface EngineParticipant {
  readonly presence: PresenceStream;
  readonly claims: ClaimStream;
}

/**
 * The options for a participant join. It extends the public per-model
 * {@link JoinOptions} rather than restating its members, so the lease dial is
 * declared once, in the core, and this surface adds only what a lower-level
 * join can additionally say.
 */
export interface ParticipantJoinOptions extends JoinOptions {
  /**
   * The initial focus target, named in your schema's vocabulary and optionally
   * narrowed to a field. When `scope` is omitted, this target also becomes the
   * routing scope.
   */
  readonly target?: PresenceTarget;
  /** Alias for `target` when the participant is joined to a broader scope. */
  readonly focus?: PresenceTarget;
  /**
   * The routing scope: one entity, many entities, or a raw sync-group escape
   * hatch. Use it for "joined to the folder, focused on one file" shapes,
   * where the participant listens more broadly than its focus target.
   */
  readonly scope?: ParticipantScope;
  /** Present a narrower capability for this logical participant. */
  readonly capabilityToken?: string;
  /**
   * @deprecated Use `ttl`. Removed in 0.37.0.
   *
   * One lease, spelled two ways, and the seconds spelling was the one that
   * misled: it accepted a duration string, so `ablo.<model>.join(ids, { ttl:
   * '5m' })` reached this surface as `ttlSeconds: '5m'` — a field whose name
   * asserts a unit its value did not carry. `ttl` takes the same values and is
   * the spelling every other lease in the SDK already uses (`claim`'s `ttl`,
   * `ClaimLeaseOptions.ttl`). The wire is unchanged: it has always carried
   * seconds, and still does.
   */
  readonly ttlSeconds?: number | string | null;
  /**
   * The activity to announce as soon as the claim is acknowledged. Defaults to
   * `reading` when a `target` is present. Pass `false` to join without
   * announcing anything.
   */
  readonly activity?: 'reading' | 'viewing' | 'editing' | false;
  readonly detail?: string;
}

export interface ScopedPresence {
  readonly self: Peer;
  readonly focus: ClaimTarget | null;
  readonly others: readonly Peer[];
  update(activity: Activity): void;
  reading(detail?: string): void;
  reading(target: PresenceTarget, detail?: string): void;
  viewing(detail?: string): void;
  viewing(target: PresenceTarget, detail?: string): void;
  editing(detail?: string): void;
  editing(target: PresenceTarget, detail?: string): void;
  idle(): void;
  onChange(listener: () => void): () => void;
}

export interface ScopedClaimOptions {
  /** Override the participant's focus target for this one claim. */
  readonly target?: PresenceTarget;
  /** Peer-visible description of the work. Defaults to `'editing'`. */
  readonly description?: string;
  /** How long the claim lives; the server expires it automatically after this. */
  readonly ttl?: import('@abloatai/transaction/types/streams').Duration;
}

export interface ScopedClaims {
  readonly focus: ClaimTarget | null;
  readonly others: readonly Claim[];
  /**
   * Takes an exclusive claim on the participant's focus target, or on an
   * explicit target passed via `opts.target`. While the claim is held, other
   * participants that request an overlapping target are rejected.
   */
  claim(opts?: ScopedClaimOptions): Claim;
  onRejected(listener: Parameters<ClaimStream['onRejected']>[0]): () => void;
  onChange(listener: () => void): () => void;
}

export interface ParticipantFocusOptions {
  readonly activity?: 'reading' | 'viewing' | 'editing' | false;
  readonly detail?: string;
}

export interface JoinedParticipant {
  /** The exact entity this participant is currently reading or editing. */
  readonly target: ClaimTarget | null;
  readonly focusTarget: ClaimTarget | null;
  /** The transport scopes this participant is joined to, which govern what it sees and receives. */
  readonly syncGroups: readonly string[];
  readonly presence: ScopedPresence;
  readonly claims: ScopedClaims;
  readonly peers: readonly Peer[];
  readonly activeClaims: readonly Claim[];
  focus(target: PresenceTarget, options?: ParticipantFocusOptions): JoinedParticipant;
  leave(): void;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface ParticipantManager {
  join(target: PresenceTarget, options?: Omit<ParticipantJoinOptions, 'target'>): Promise<JoinedParticipant>;
  join(options: ParticipantJoinOptions): Promise<JoinedParticipant>;
}

export interface ParticipantManagerConfig {
  readonly ready: () => Promise<void>;
  /** The connection, host-built and stable for the client's lifetime. */
  readonly transport: SyncWebSocket;
  readonly presence: PresenceStream;
  readonly claims: AttachableClaimStream;
  readonly schema?: Schema;
}

export function createParticipantManager(
  config: ParticipantManagerConfig,
): ParticipantManager {
  return {
    async join(
      input: PresenceTarget | ParticipantJoinOptions,
      overrides?: Omit<ParticipantJoinOptions, 'target'>,
    ): Promise<JoinedParticipant> {
      const options = normalizeJoinOptions(input, overrides);
      const target = options.focus ?? options.target
        ? targetToEntityRef((options.focus ?? options.target)!)
        : null;
      const syncGroups = unique(
        resolveParticipantSyncGroups(options.scope ?? target ?? undefined, config.schema),
      );

      await config.ready();
      // Not-connected joins surface through `sendClaim`'s diagnosed
      // rejection below; a scopeless join needs no wire send at all.
      const transport = config.transport;

      const claimId = createParticipantClaimId();
      if (syncGroups.length > 0) {
        await transport.sendClaim(claimId, syncGroups, {
          capabilityToken: options.capabilityToken,
          // `ttl` is the spelling; `ttlSeconds` is the deprecated one, read
          // second so a caller passing both gets the current name honored.
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- reading the deprecated alias IS the back-compat this line provides
          ttlSeconds: parseParticipantTtlSeconds(options.ttl ?? options.ttlSeconds),
        });
      }

      const participant = createJoinedParticipant({
        target,
        syncGroups,
        claimId,
        transport,
        presence: config.presence,
        claims: config.claims,
      });

      if (target && options.activity !== false) {
        const activity = options.activity ?? 'reading';
        if (activity === 'editing') {
          participant.presence.editing(options.detail);
        } else if (activity === 'viewing') {
          participant.presence.viewing(options.detail);
        } else {
          participant.presence.reading(options.detail);
        }
      }

      return participant;
    },
  };
}

export function resolveParticipantSyncGroups(
  scope: ParticipantScope | undefined,
  schema?: Schema,
): string[] {
  if (!scope) return [];
  if (typeof scope === 'string') return [scope];
  if (Array.isArray(scope)) {
    return scope.flatMap((entry) =>
      typeof entry === 'string' ? [entry] : [syncGroupFromEntityRef(entry, schema)],
    );
  }
  const direct = scope as { syncGroup?: unknown; syncGroups?: unknown };
  if (isEntityScope(scope)) return [syncGroupFromEntityRef(scope, schema)];
  if (typeof direct.syncGroup === 'string') return [direct.syncGroup];
  if (Array.isArray(direct.syncGroups)) {
    return direct.syncGroups.filter((g): g is string => typeof g === 'string');
  }
  const out: string[] = [];
  for (const [key, value] of Object.entries(scope)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const id of value) out.push(syncGroupFromSchemaKey(key, id, schema));
    } else {
      out.push(syncGroupFromSchemaKey(key, value, schema));
    }
  }
  return out;
}

/**
 * The group kind for a model, in the wire dialect every plane shares: a
 * declared scope root wins; otherwise the lowercased typename — the same
 * token the commit plane and claim targets use (`wireModel`). Never the
 * camelCase schema key: the server validates inbound subscription groups
 * against a lowercase-only grammar, so a key like `reportBlocks` would be
 * rejected as malformed on subscribe — and even a lowercase key would put
 * this client in a different group than a peer who resolved the same row
 * through an entity ref, so the two would never see each other's claims.
 */
function groupKindForModel(def: ModelDef, key: string): string {
  return scopeKindOf(def, key) ?? (def.typename ?? key).toLowerCase();
}

export function syncGroupFromEntityRef(
  ref: ClaimTarget,
  schema?: Schema,
): string {
  const match = findModelForEntityRef(ref, schema);
  const kind = match
    ? groupKindForModel(match.def, match.key)
    : ref.type.toLowerCase();
  return `${kind}:${ref.id}`;
}

function syncGroupFromSchemaKey(
  schemaKey: string,
  id: string,
  schema?: Schema,
): string {
  const def = schema?.models?.[schemaKey];
  const kind = def ? groupKindForModel(def, schemaKey) : schemaKey.toLowerCase();
  return `${kind}:${id}`;
}

function findModelForEntityRef(
  ref: ClaimTarget,
  schema?: Schema,
): { key: string; def: ModelDef } | null {
  if (!schema?.models) return null;
  const wanted = ref.type.toLowerCase();
  for (const [key, def] of Object.entries(schema.models) as [string, ModelDef][]) {
    const typename = def.typename ?? key;
    if (typename.toLowerCase() === wanted || key.toLowerCase() === wanted) {
      return { key, def };
    }
  }
  return null;
}

export function parseParticipantTtlSeconds(
  value: number | string | null | undefined,
): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value) return undefined;
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  if (unit === 'ms') return Math.max(1, Math.ceil(amount / 1000));
  if (unit === 'm') return Math.ceil(amount * 60);
  if (unit === 'h') return Math.ceil(amount * 3600);
  return Math.ceil(amount);
}

export function createParticipantClaimId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `participant:${crypto.randomUUID()}`;
  }
  return `participant:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function normalizeJoinOptions(
  input: PresenceTarget | ParticipantJoinOptions,
  overrides?: Omit<ParticipantJoinOptions, 'target'>,
): ParticipantJoinOptions {
  if (isTupleTarget(input) || isEntityScope(input)) {
    return { ...overrides, target: input };
  }
  return { ...input, ...overrides };
}

function isTupleTarget(value: unknown): value is readonly [type: string, id: string] {
  return (
    Array.isArray(value) &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'string'
  );
}

function isEntityScope(scope: unknown): scope is ClaimTarget {
  return (
    typeof scope === 'object' &&
    scope !== null &&
    !Array.isArray(scope) &&
    typeof (scope as { type?: unknown }).type === 'string' &&
    typeof (scope as { id?: unknown }).id === 'string'
  );
}

function targetToEntityRef(target: PresenceTarget): ClaimTarget {
  if (isTupleTarget(target)) return { type: target[0], id: target[1] };
  return target;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function createJoinedParticipant(args: {
  readonly target: ClaimTarget | null;
  readonly syncGroups: readonly string[];
  readonly claimId: string;
  readonly transport: SyncWebSocket;
  readonly presence: PresenceStream;
  readonly claims: AttachableClaimStream;
}): JoinedParticipant {
  const ownHandles = new Set<Claim>();
  let currentTarget = args.target;
  let left = false;

  const requireTarget = (target?: PresenceTarget): ClaimTarget => {
    const resolved = target ? targetToEntityRef(target) : currentTarget;
    if (!resolved) {
      throw new AbloValidationError('Participant action requires a structured target', {
        code: 'invalid_request',
      });
    }
    return resolved;
  };

  const setFocus = (
    target: PresenceTarget,
    options?: ParticipantFocusOptions,
  ): JoinedParticipant => {
    currentTarget = targetToEntityRef(target);
    if (options?.activity === 'editing') {
      scopedPresence.editing(options.detail);
    } else if (options?.activity === 'viewing') {
      scopedPresence.viewing(options.detail);
    } else if (options?.activity === 'reading') {
      scopedPresence.reading(options.detail);
    }
    return joined;
  };

  const resolvePresenceAction = (
    targetOrDetail?: PresenceTarget | string,
    detail?: string,
  ): { target: ClaimTarget; detail?: string } => {
    if (typeof targetOrDetail === 'string' || targetOrDetail === undefined) {
      return { target: requireTarget(), detail: targetOrDetail ?? detail };
    }
    return { target: requireTarget(targetOrDetail), detail };
  };

  const scopedPresence: ScopedPresence = {
    get self() {
      return args.presence.self;
    },
    get focus() {
      return currentTarget;
    },
    get others() {
      return args.presence.others.filter((entry) =>
        presenceMatchesParticipant(entry, currentTarget, args.syncGroups),
      );
    },
    update(activity: Activity): void {
      args.presence.update(activity);
    },
    reading(targetOrDetail?: PresenceTarget | string, detail?: string): void {
      const action = resolvePresenceAction(targetOrDetail, detail);
      args.presence.update({
        ...activityFromTarget(action.target),
        action: 'reading',
        detail: action.detail,
      });
    },
    viewing(targetOrDetail?: PresenceTarget | string, detail?: string): void {
      const action = resolvePresenceAction(targetOrDetail, detail);
      args.presence.viewing(action.target, action.detail);
    },
    editing(targetOrDetail?: PresenceTarget | string, detail?: string): void {
      const action = resolvePresenceAction(targetOrDetail, detail);
      args.presence.editing(action.target, action.detail);
    },
    idle(): void {
      args.presence.idle();
    },
    onChange(listener: () => void): () => void {
      return args.presence.onChange(listener);
    },
  };

  const track = (handle: Claim): Claim => {
    ownHandles.add(handle);
    return {
      object: 'claim',
      id: handle.id,
      description: handle.description,
      target: handle.target,
      async release(): Promise<void> {
        ownHandles.delete(handle);
        await handle.release?.();
      },
      revoke(): void {
        ownHandles.delete(handle);
        handle.revoke?.();
      },
      [Symbol.asyncDispose]: async () => {
        ownHandles.delete(handle);
        await handle[Symbol.asyncDispose]?.();
      },
    };
  };

  const scopedClaims: ScopedClaims = {
    get focus() {
      return currentTarget;
    },
    get others() {
      return args.claims.others.filter((claim) =>
        currentTarget ? targetsOverlap(claim.target, currentTarget) : true,
      );
    },
    claim(opts?: ScopedClaimOptions): Claim {
      return track(
        args.claims.claim(requireTarget(opts?.target), {
          description: opts?.description,
          ttl: opts?.ttl,
        }),
      );
    },
    onRejected(listener) {
      return args.claims.onRejected(listener);
    },
    onChange(listener: () => void): () => void {
      return args.claims.onChange(listener);
    },
  };

  const leave = (): void => {
    if (left) return;
    left = true;
    for (const handle of Array.from(ownHandles)) {
      handle.revoke?.();
      ownHandles.delete(handle);
    }
    args.presence.idle();
    if (args.syncGroups.length > 0) {
      args.transport.sendRelease(args.claimId);
    }
  };

  const joined: JoinedParticipant = {
    get target() {
      return currentTarget;
    },
    get focusTarget() {
      return currentTarget;
    },
    syncGroups: [...args.syncGroups],
    presence: scopedPresence,
    claims: scopedClaims,
    get peers() {
      return scopedPresence.others;
    },
    get activeClaims() {
      return scopedClaims.others;
    },
    focus: setFocus,
    leave,
    [Symbol.asyncDispose]: async () => {
      leave();
    },
  };
  return joined;
}

function activityFromTarget(target: ClaimTarget): Omit<Activity, 'action'> {
  return {
    ...wireTarget(target),
    ...subTarget(target),
  };
}

function presenceMatchesParticipant(
  entry: Peer,
  target: ClaimTarget | null,
  syncGroups: readonly string[],
): boolean {
  if (syncGroups.some((g) => entry.syncGroups.includes(g))) return true;
  if (!target) return true;
  return targetsOverlap(
    {
      ...streamTarget(entry.activity),
      ...subTarget(entry.activity),
    },
    target,
  );
}

function targetsOverlap(a: ClaimTarget, b: ClaimTarget): boolean {
  if (a.type !== b.type || a.id !== b.id) return false;
  if (!hasSubtarget(a) || !hasSubtarget(b)) return true;
  // Field is the floor: same field overlaps, different fields do not. Sub-field
  // targeting returns when same-field concurrency (OT) is solved.
  return !a.field || !b.field || a.field === b.field;
}

function hasSubtarget(target: ClaimTarget): boolean {
  return Boolean(target.field);
}
