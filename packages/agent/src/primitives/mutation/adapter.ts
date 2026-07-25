/**
 * ContentMutationAdapter — the interface every content type implements
 * to plug into the unified AI mutation pipeline.
 *
 * The pipeline (parser, recorder, runner, registry) is GENERIC. All
 * content-specific concerns — what the AI calls inside the sandbox, how
 * mutations are validated, how previews render, how mutations persist —
 * live inside an adapter that implements this interface.
 *
 * Adding a new content type means: write one adapter file, register it
 * in the adapter registry, done. No pipeline changes.
 *
 * Generic over `TMutation` so apps (apps/web with rich RecordedMutation,
 * agent-worker with simpler shape) can plug in their own mutation types.
 *
 * Ported from apps/web/src/lib/ai/core/mutations/adapter.ts.
 */

import type { z } from 'zod';
import type { ContentType } from './schemas/content-types';
import type { Mutation } from './types';
import type { MutationRecorder } from './recorder';
import type { ParserPattern } from './parser/parser-patterns';

// ──────────────────── shared types ──────────────────────────────────────

/**
 * Context passed to `buildSandboxNamespace` when constructing the per-execute
 * sandbox API surface.
 */
export interface SandboxBuildContext {
  /** The active entity being edited (deck/spreadsheet/document id). */
  entityId: string;
  /**
   * Adapter-specific bag of pre-fetched data the host loaded before invoking
   * the sandbox. Adapters cast this to their own typed shape.
   */
  initialData: unknown;
  /** Organization id for scoping. */
  organizationId: string;
}

/**
 * Context passed to `persistMutations` after the AI's execute completes
 * successfully and the mutations need to land in the entity model.
 */
export interface PersistContext {
  /** Which entity to persist against. */
  entityId: string;
  /** Organization id for scoping. */
  organizationId: string;
  /**
   * Host-supplied dispatcher — apps/web passes its SyncStore handle,
   * agent-worker passes its batchAck client. Typed as `unknown` here to
   * avoid coupling the package to either.
   */
  dispatcher: unknown;
}

export interface PersistResult {
  success: boolean;
  /** Number of mutations actually applied. */
  applied: number;
  /** Optional error if some or all mutations failed. */
  error?: string;
}

// ──────────────────── adapter interface ─────────────────────────────────

export interface ContentMutationAdapter<TMutation extends Mutation = Mutation> {
  // ── Identity ─────────────────────────────────────────────────────────
  /** Top-level content type — used by the runner to look up the right adapter. */
  contentType: ContentType;
  /**
   * Entity types this adapter handles (e.g. ['layer', 'slide']).
   * Used by the recorder to validate that a mutation belongs to this adapter.
   */
  entityTypes: readonly string[];

  // ── Schemas ──────────────────────────────────────────────────────────
  /**
   * Zod schemas for validating sandbox API inputs. Keyed by entity type.
   * Used at the sandbox boundary to fail fast on malformed AI calls.
   */
  payloadSchemas: Readonly<Record<string, z.ZodType>>;

  /**
   * Type guard for narrowing a generic mutation to the subset this adapter
   * handles. Used by the runner to dispatch mutations during persistence.
   *
   * Method syntax (not arrow property) so TypeScript uses bivariant parameter
   * checking — lets narrower adapter types assign to wider registry slots
   * without casts.
   */
  isMutation(m: Mutation): m is TMutation;

  // ── Sandbox API ──────────────────────────────────────────────────────
  /**
   * Build the namespace exposed inside the sandbox VM. Returns an object
   * that gets injected as a global (e.g. `layer`, `sheet`, `document`).
   * Each method validates inputs and pushes mutations to `recorder`.
   *
   * The recorder is shared across all adapters in a single execute run, so
   * cross-adapter workflows ("create a slide from this document block")
   * are naturally supported.
   */
  buildSandboxNamespace(
    context: SandboxBuildContext,
    recorder: MutationRecorder<TMutation>,
  ): Record<string, unknown>;

  // ── Streaming Parser ─────────────────────────────────────────────────
  /**
   * Function call patterns the streaming parser detects for this content
   * type (e.g. `layer.create(...)`, `sheet.setCell(...)`). The generic
   * parser uses these to emit `MutationIntentEvent`s as the AI's code
   * streams in, BEFORE the code executes — this drives live preview.
   */
  parserPatterns: readonly ParserPattern[];

  // ── Preview ──────────────────────────────────────────────────────────
  /**
   * Pure function: given a snapshot and pending mutations, return the
   * previewed state for rendering. Called by the preview consumer on
   * every preview store update.
   *
   * MUST be pure — no DOM access, no side effects, no async.
   */
  applyPreview(
    currentSnapshot: unknown,
    pendingMutations: TMutation[],
  ): unknown;

  // ── Persistence ──────────────────────────────────────────────────────
  /**
   * Apply approved mutations to the entity model. Called once per
   * execute run after preview approval.
   *
   * Returns a `PersistResult` indicating success and how many landed.
   */
  persistMutations(
    mutations: TMutation[],
    context: PersistContext,
  ): Promise<PersistResult>;
}

// ──────────────────── adapter registry ──────────────────────────────────

/**
 * Registry that maps content types to their adapters.
 *
 * Adapters self-register at module load time via `registry.register(adapter)`.
 * The runner uses `findForMutation` to route each mutation to its adapter.
 */
export class AdapterRegistry {
  private adapters = new Map<ContentType, ContentMutationAdapter>();

  /**
   * Register or REPLACE an adapter for a content type. Idempotent — calling
   * twice with the same content type silently replaces the previous adapter.
   * Required for Next.js dev mode where modules hot-reload.
   */
  register(adapter: ContentMutationAdapter): void {
    this.adapters.set(adapter.contentType, adapter);
  }

  get(contentType: ContentType): ContentMutationAdapter {
    const adapter = this.adapters.get(contentType);
    if (!adapter) {
      throw new Error(
        `No adapter registered for content type "${contentType}". ` +
          `Registered: ${Array.from(this.adapters.keys()).join(', ') || '(none)'}`,
      );
    }
    return adapter;
  }

  /** Look up the adapter that owns a specific mutation. */
  findForMutation(mutation: Mutation): ContentMutationAdapter | null {
    for (const adapter of this.adapters.values()) {
      if (adapter.isMutation(mutation)) return adapter;
    }
    return null;
  }

  /** All registered content types. */
  list(): ContentType[] {
    return Array.from(this.adapters.keys());
  }
}

/**
 * Singleton registry. Adapters import this and call `defaultRegistry.register`
 * at the bottom of their module file. The runner imports it to look up
 * adapters by content type.
 */
export const defaultRegistry = new AdapterRegistry();
