import { AbloValidationError } from '@abloatai/transaction/errors';
import type { Logger } from '@abloatai/transaction/logger';
import type {
  Activity,
  Claim,
} from '@abloatai/transaction/types/streams';
import { createAgentSession } from './session.js';
import { createConsoleLogger, resolveLogLevel } from './consoleLogger.js';
import type { AgentContext, PresenceAnnouncer } from './types.js';

export type { AgentContext } from './types.js';
export type { Claim } from '@abloatai/transaction/types/streams';

/**
 * The authoritative transaction capabilities perception needs.
 *
 * Callers adapt their schema-typed Ablo client once. Perception deliberately
 * has no URL, credential, fetch, or private endpoint configuration of its own.
 */
export interface AgentPerceptionSource {
  get(
    entityType: string,
    entityId: string,
  ): Promise<Record<string, unknown> | undefined>;
  claims(entityType: string, entityId: string): Promise<readonly Claim[]>;
}

/** The schema-model slice used by {@link transactionPerceptionSource}. */
export interface TransactionPerceptionModel {
  get(params: { readonly id: string }): Promise<object | undefined>;
  readonly claim: {
    state(params: { readonly id: string }): Promise<Claim | null>;
    queue(params: {
      readonly id: string;
    }): Promise<{ readonly data: readonly Claim[] }>;
  };
}

export type TransactionModelResolver = (
  entityType: string,
) => TransactionPerceptionModel | undefined;

/**
 * Adapt canonical transaction resources to the small read-only perception
 * port. Unknown model names fail closed instead of silently skipping a guard.
 */
export function transactionPerceptionSource(
  resolveModel: TransactionModelResolver,
): AgentPerceptionSource {
  const model = (entityType: string): TransactionPerceptionModel => {
    const resolved = resolveModel(entityType);
    if (!resolved) {
      throw new AgentPerceptionUnavailableError(
        `No transaction model is registered for entity type "${entityType}".`,
      );
    }
    return resolved;
  };

  return {
    async get(entityType, entityId) {
      const row = await model(entityType).get({ id: entityId });
      return row as Record<string, unknown> | undefined;
    },
    async claims(entityType, entityId) {
      const resource = model(entityType);
      const [active, queued] = await Promise.all([
        resource.claim.state({ id: entityId }),
        resource.claim.queue({ id: entityId }),
      ]);
      return active ? [active, ...queued.data] : queued.data;
    },
  };
}

export class AgentPerceptionUnavailableError extends Error {
  readonly code = 'agent_perception_unavailable';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentPerceptionUnavailableError';
  }
}

export interface AgentOptions {
  /** Stable agent identity. The `agent:` prefix is added when absent. */
  agentId: string;
  /** Canonical transaction-backed authoritative reads and claim observation. */
  source: AgentPerceptionSource;
  /** Optional live human/agent activity channel. */
  announcer?: PresenceAnnouncer;
  logger?: Logger;
}

export interface GatherOptions {
  /** Entities to inspect, formatted as `ModelName:id`. */
  focusEntities?: readonly string[];
  /** Maximum output characters. Default 2000. */
  maxChars?: number;
}

export interface AgentSnapshot {
  readonly timestamp: number;
  readonly claims: readonly Claim[];
}

export interface GatherResult {
  readonly prompt: string;
  readonly snapshot: AgentSnapshot;
}

export interface FreshnessCheck {
  readonly stale: boolean;
  readonly reason: 'ok' | 'not_found' | 'modified';
  readonly currentState?: Record<string, unknown>;
  readonly lastModifiedBy?: string;
  readonly lastModifiedAt?: number;
  readonly summary?: string;
  readonly pendingClaims: readonly Claim[];
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
}

export interface PrepareStepContext<M extends AgentMessage = AgentMessage> {
  stepNumber: number;
  steps: readonly {
    toolCalls?: readonly { toolName: string; input?: unknown; args?: unknown }[];
    toolResults?: readonly unknown[];
  }[];
  messages: M[];
  model?: unknown;
}

export interface PrepareStepResult<M extends AgentMessage = AgentMessage> {
  messages?: M[];
  model?: unknown;
  toolChoice?: unknown;
  activeTools?: string[];
}

export interface StepFinishContext {
  stepType?: 'initial' | 'continue' | 'tool-result';
  finishReason?: string;
  text?: string;
  toolCalls?: readonly { toolName: string; input?: unknown; args?: unknown }[];
  toolResults?: readonly unknown[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

export interface PrepareStepOptions {
  maxChars?: number;
  focusFromToolCalls?: (toolCall: {
    toolName: string;
    input?: unknown;
    args?: unknown;
  }) => string[] | undefined;
  skipFirstStep?: boolean;
}

export interface OnStepFinishOptions {
  activity?: (ctx: StepFinishContext) => Activity | null;
}

export function defaultAgentLogger(): Logger {
  const gated = createConsoleLogger(resolveLogLevel());
  return {
    debug: (msg, ...args) => {
      gated.debug('[agent]', msg, ...args);
    },
    info: (msg, ...args) => {
      gated.info('[agent]', msg, ...args);
    },
    warn: (msg, ...args) => {
      gated.warn('[agent]', msg, ...args);
    },
    error: (msg, ...args) => {
      gated.error('[agent]', msg, ...args);
    },
  };
}

export class Agent implements PresenceAnnouncer {
  private readonly source: AgentPerceptionSource;
  private readonly announcer?: PresenceAnnouncer;
  private readonly logger: Logger;
  private readonly agentId: string;

  constructor(options: AgentOptions) {
    this.agentId = options.agentId.replace(/^agent:/, '');
    this.source = options.source;
    this.announcer = options.announcer;
    this.logger = options.logger ?? defaultAgentLogger();
  }

  static session = createAgentSession;

  get userId(): string {
    return `agent:${this.agentId}`;
  }

  static fromContext(ctx: unknown, toolName?: string): Agent {
    if (
      !ctx ||
      typeof ctx !== 'object' ||
      !('perception' in ctx) ||
      !(ctx.perception instanceof Agent)
    ) {
      const where = toolName ? ` (tool: ${toolName})` : '';
      throw new AbloValidationError(
        `Agent.fromContext: experimental_context must contain an Agent in \`perception\`.${where} ` +
          'Set `experimental_context: { perception } satisfies AgentContext` when calling generateText/streamText.',
        { code: 'agent_perception_missing_context' },
      );
    }
    return ctx.perception;
  }

  static tryFromContext(ctx: unknown): Agent | undefined {
    if (
      !ctx ||
      typeof ctx !== 'object' ||
      !('perception' in ctx) ||
      !(ctx.perception instanceof Agent)
    ) {
      return undefined;
    }
    return ctx.perception;
  }

  /**
   * Live activity is optional and best-effort. It is never synthesized over a
   * private HTTP route; human applications may inject their WebSocket client.
   */
  async announce(
    status: 'online' | 'away' | 'offline',
    activity?: Activity,
  ): Promise<void> {
    if (!this.announcer) return;
    try {
      await this.announcer.announce(status, activity);
    } catch (error) {
      this.logger.debug('[perception] activity announcement failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Read durable coordination context for explicitly focused entities.
   * Without a focus there is no honest global claim query on the transaction
   * client, so no context is invented.
   */
  async gather(options?: GatherOptions): Promise<GatherResult> {
    const focusEntities = options?.focusEntities ?? [];
    const claims = (
      await Promise.all(
        focusEntities.map((focusEntity) => {
          const { entityType, entityId } = parseFocusEntity(focusEntity);
          return this.pendingClaims(entityType, entityId);
        }),
      )
    ).flat();
    const snapshot: AgentSnapshot = { timestamp: Date.now(), claims };
    return {
      prompt: this.formatPrompt(snapshot, options?.maxChars ?? 2_000),
      snapshot,
    };
  }

  async checkFreshness(
    entityType: string,
    entityId: string,
    lastSeenAt: number,
  ): Promise<FreshnessCheck> {
    let entity: Record<string, unknown> | undefined;
    let pendingClaims: readonly Claim[];
    try {
      [entity, pendingClaims] = await Promise.all([
        this.source.get(entityType, entityId),
        this.pendingClaims(entityType, entityId),
      ]);
    } catch (cause) {
      throw new AgentPerceptionUnavailableError(
        `Could not establish authoritative freshness for ${entityType}:${entityId}; the guarded operation was not run.`,
        { cause },
      );
    }

    if (!entity) {
      return {
        stale: true,
        reason: 'not_found',
        summary: `${entityType} ${entityId} no longer exists or is outside this credential's scope.`,
        pendingClaims,
      };
    }

    const updatedAtRaw = entity.updated_at ?? entity.updatedAt;
    const lastModifiedBy =
      stringValue(entity.updated_by) ??
      stringValue(entity.updatedBy) ??
      stringValue(entity.created_by);
    const lastModifiedAt = timestampValue(updatedAtRaw);

    if (lastModifiedAt !== undefined && lastModifiedAt > lastSeenAt) {
      return {
        stale: true,
        reason: 'modified',
        currentState: entity,
        lastModifiedBy,
        lastModifiedAt,
        summary:
          `${entityType} ${entityId} changed after it was read. ` +
          'Re-read the authoritative row and plan the mutation again.',
        pendingClaims,
      };
    }

    return {
      stale: false,
      reason: 'ok',
      currentState: entity,
      lastModifiedBy,
      lastModifiedAt,
      pendingClaims,
    };
  }

  async pendingClaims(
    entityType: string,
    entityId: string,
  ): Promise<readonly Claim[]> {
    const claims = await this.source.claims(entityType, entityId);
    return claims.filter((claim) => claim.heldBy !== this.userId);
  }

  prepareStep<M extends AgentMessage = AgentMessage>(
    options?: PrepareStepOptions,
  ): (ctx: PrepareStepContext<M>) => Promise<PrepareStepResult<M> | undefined> {
    return async ({ stepNumber, steps, messages }) => {
      if (options?.skipFirstStep && stepNumber === 0) return undefined;

      const focus = new Set<string>();
      if (options?.focusFromToolCalls) {
        for (const step of steps) {
          for (const call of step.toolCalls ?? []) {
            for (const entity of options.focusFromToolCalls(call) ?? []) {
              focus.add(entity);
            }
          }
        }
      }
      if (focus.size === 0) return undefined;

      const { prompt, snapshot } = await this.gather({
        focusEntities: [...focus],
        maxChars: options?.maxChars ?? 1_500,
      });
      if (snapshot.claims.length === 0) return undefined;

      return {
        messages: [
          ...messages,
          { role: 'system', content: prompt } as M,
        ],
      };
    };
  }

  onStepFinish(
    options?: OnStepFinishOptions,
  ): (ctx: StepFinishContext) => Promise<void> {
    const activity =
      options?.activity ??
      ((ctx: StepFinishContext): Activity | null => {
        const call = ctx.toolCalls?.at(-1);
        return call
          ? {
              entityType: 'Tool',
              entityId: call.toolName,
              action: 'executed',
              detail: call.toolName,
            }
          : null;
      });
    return async (ctx) => {
      const resolved = activity(ctx);
      if (resolved) await this.announce('online', resolved);
    };
  }

  private formatPrompt(snapshot: AgentSnapshot, maxChars: number): string {
    const lines = [
      '<coordination_context>',
      ...snapshot.claims.map((claim) => {
        const holder = claim.heldBy ? ` by ${claim.heldBy}` : '';
        return (
          `- ${claim.target.type}:${claim.target.id}${holder}: ` +
          claim.description
        );
      }),
      'These operations are in flight. Re-read before writing and avoid overwriting their work.',
      '</coordination_context>',
    ];
    const prompt = lines.join('\n');
    return prompt.length > maxChars
      ? `${prompt.slice(0, Math.max(0, maxChars - 3))}...`
      : prompt;
  }
}

function parseFocusEntity(value: string): {
  entityType: string;
  entityId: string;
} {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) {
    throw new AbloValidationError(
      `Invalid focus entity "${value}"; expected "ModelName:id".`,
    );
  }
  return {
    entityType: value.slice(0, separator),
    entityId: value.slice(separator + 1),
  };
}

function timestampValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Agent {
  export type Options = AgentOptions;
  export type Context = AgentContext;
  export type SessionOptions = import('./session.js').AgentSessionOptions;
}
