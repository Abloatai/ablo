import type { SyncWebSocket } from './SyncWebSocket.js';
import type { Schema, SchemaRecord } from '../schema/schema.js';
import { scopeKindOf, type ModelDef } from '../schema/model.js';
import { AbloConnectionError, AbloValidationError } from '../errors.js';
import type {
  Claim,
  Activity,
  ClaimTarget,
  ClaimLeaseOptions,
  ClaimStream,
  Peer,
  PresenceStream,
  PresenceTarget,
} from '../types/streams.js';
import type { AttachableClaimStream } from './createClaimStream.js';

/**
 * Scope accepted by participant APIs. The normal SDK shape is an
 * entity target (`{ type, id }`). Raw sync-group strings remain an
 * advanced transport escape hatch.
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

export interface ParticipantJoinOptions {
  /**
   * Initial focus target: customer schema vocabulary, optionally
   * narrowed to a path, field, or range. When `scope` is omitted,
   * this also becomes the routing scope.
   */
  readonly target?: PresenceTarget;
  /** Alias for `target` when the participant is joined to a broader scope. */
  readonly focus?: PresenceTarget;
  /**
   * Routing scope. Can be one entity, many entities, or a raw
   * sync-group escape hatch. Use this for "joined to folder, focused
   * on file" shapes.
   */
  readonly scope?: ParticipantScope;
  /** Present a narrower capability for this logical participant. */
  readonly capabilityToken?: string;
  /** Claim TTL, in seconds or a compact duration string (`30s`, `5m`). */
  readonly ttlSeconds?: number | string | null;
  /**
   * Activity to announce immediately after the claim acks. Defaults to
   * `reading` when `target` is present. Pass false to join silently.
   */
  readonly activity?: 'reading' | 'viewing' | 'editing' | false;
  readonly detail?: string;
}

export interface ScopedPresence {
  readonly self: Peer;
  readonly focus: ClaimTarget | null;
  readonly others: ReadonlyArray<Peer>;
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
  /** Free-form reason. Defaults to `'editing'`. Common: `'editing'`,
   *  `'writing'`, `'reviewing'`, app-specific phases. */
  readonly reason?: string;
  /** TTL — server auto-expires the claim after this. */
  readonly ttl?: import('../types/streams.js').Duration;
}

export interface ScopedClaims {
  readonly focus: ClaimTarget | null;
  readonly others: ReadonlyArray<Claim>;
  /**
   * Claim an exclusive claim on the participant's focus target (or
   * an explicit override via `opts.target`). Single verb — the old
   * `editing / writing / announce / claim(reason, opts)` overloads
   * collapsed into this one method.
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
  /** Current exact thing this participant is reading/editing. */
  readonly target: ClaimTarget | null;
  readonly focusTarget: ClaimTarget | null;
  /** Transport scopes this participant is joined to for visibility/fan-out. */
  readonly syncGroups: readonly string[];
  readonly presence: ScopedPresence;
  readonly claims: ScopedClaims;
  readonly peers: ReadonlyArray<Peer>;
  readonly activeClaims: ReadonlyArray<Claim>;
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
  readonly getTransport: () => SyncWebSocket | null;
  readonly presence: PresenceStream;
  readonly claims: AttachableClaimStream;
  readonly schema?: Schema<SchemaRecord>;
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
      const transport = config.getTransport();
      if (!transport) {
        throw new AbloConnectionError(
          'Ablo participant join failed: WebSocket is not connected',
          { code: 'ws_not_ready' },
        );
      }

      const claimId = createParticipantClaimId();
      if (syncGroups.length > 0) {
        await transport.sendClaim(claimId, syncGroups, {
          capabilityToken: options.capabilityToken,
          ttlSeconds: parseParticipantTtlSeconds(options.ttlSeconds),
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
  schema?: Schema<SchemaRecord>,
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

export function syncGroupFromEntityRef(
  ref: ClaimTarget,
  schema?: Schema<SchemaRecord>,
): string {
  const match = findModelForEntityRef(ref, schema);
  const kind = match ? scopeKindOf(match.def, match.key) : undefined;
  return `${kind ?? ref.type.toLowerCase()}:${ref.id}`;
}

function syncGroupFromSchemaKey(
  schemaKey: string,
  id: string,
  schema?: Schema<SchemaRecord>,
): string {
  const def = schema?.models?.[schemaKey] as ModelDef | undefined;
  const kind = def ? scopeKindOf(def, schemaKey) : undefined;
  return `${kind ?? schemaKey}:${id}`;
}

function findModelForEntityRef(
  ref: ClaimTarget,
  schema?: Schema<SchemaRecord>,
): { key: string; def: ModelDef } | null {
  if (!schema?.models) return null;
  const wanted = ref.type.toLowerCase();
  for (const [key, def] of Object.entries(schema.models) as Array<[string, ModelDef]>) {
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
  return target as ClaimTarget;
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
      reason: handle.reason,
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
          reason: opts?.reason,
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
    entityType: target.type,
    entityId: target.id,
    path: target.path,
    range: target.range,
    field: target.field,
    meta: target.meta,
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
      type: entry.activity.entityType,
      id: entry.activity.entityId,
      path: entry.activity.path,
      range: entry.activity.range,
      field: entry.activity.field,
      meta: entry.activity.meta,
    },
    target,
  );
}

function targetsOverlap(a: ClaimTarget, b: ClaimTarget): boolean {
  if (a.type !== b.type || a.id !== b.id) return false;
  if (!hasSubtarget(a) || !hasSubtarget(b)) return true;
  if (a.path && b.path && a.path !== b.path) return false;
  const fieldOverlaps = !a.field || !b.field || a.field === b.field;
  const rangeOverlaps = !a.range || !b.range || rangesOverlap(a.range, b.range);
  return fieldOverlaps && rangeOverlaps;
}

function hasSubtarget(target: ClaimTarget): boolean {
  return Boolean(target.path || target.field || target.range);
}

function rangesOverlap(
  a: NonNullable<ClaimTarget['range']>,
  b: NonNullable<ClaimTarget['range']>,
): boolean {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}
