/**
 * StateProjectionBackend — read-only filesystem that serializes current
 * entity state into JSON files under `/state/**`.
 *
 * This is the "lens onto entity state" — the agent reads the current
 * layers/cells/blocks as JSON, never as editable code. State mutations
 * happen through `Sandbox.execute()` (which goes through the mutation
 * pipeline and sync engine).
 *
 * The backend is **stateless** — it doesn't store anything. On every read,
 * it calls the configured `provider` callback to get the current entity
 * state and serializes to JSON. This guarantees the agent always sees
 * truth (including changes from concurrent human/agent edits).
 *
 * ```ts
 * const stateBackend = new StateProjectionBackend({
 *   provider: {
 *     async listEntities(modelName) {
 *       const slides = await db.slide.findMany({ where: { deckId } });
 *       return slides.map(s => s.id);
 *     },
 *     async getEntity(modelName, id) {
 *       return await db.slide.findUnique({ where: { id }, include: { layers: true } });
 *     },
 *   },
 *   models: ['slides', 'sheets', 'docs'],
 * });
 *
 * // Agent reads:
 * await stateBackend.readFile('/state/slides/slide-3.json');
 * // → '{"id":"slide-3","layers":[...],"updatedAt":"..."}'
 * ```
 */

import {
  SandboxNotFoundError,
  SandboxReadOnlyError,
  type Dirent,
  type GrepMatch,
  type SandboxStats,
} from '../interface';
import { globToRegex } from './glob-utils';
import type { VirtualFsBackend } from './types';

/**
 * Provider that exposes current entity state. Implementations adapt to
 * the host's persistence layer (Prisma, the sync engine's ObjectPool,
 * a REST client, etc.). The backend doesn't care — it just calls these.
 */
export interface StateProvider {
  /**
   * List all entity ids for a model. Used by readdir + glob.
   * Return an empty array if the model has no entities.
   */
  listEntities(modelName: string): Promise<string[]>;

  /**
   * Fetch one entity by id. Return `null` if the entity doesn't exist.
   * The returned object is JSON-serialized for the agent to read.
   */
  getEntity(modelName: string, id: string): Promise<unknown | null>;
}

export interface StateProjectionBackendOptions {
  /**
   * Provider that fetches current entity state. Called on every read
   * (no caching at this layer — caching is the provider's responsibility).
   */
  provider: StateProvider;

  /**
   * Model names exposed under the prefix. The agent sees a directory
   * per model: `/state/slides/`, `/state/sheets/`, `/state/docs/`, etc.
   */
  models: readonly string[];

  /** Path prefix this backend handles. Default `/state`. */
  prefix?: string;

  /** Override the backend name shown in errors. */
  name?: string;
}

const DEFAULT_PREFIX = '/state';
const FILE_SUFFIX = '.json';

export class StateProjectionBackend implements VirtualFsBackend {
  readonly name: string;
  readonly prefix: string;
  private readonly provider: StateProvider;
  private readonly models: ReadonlySet<string>;

  constructor(options: StateProjectionBackendOptions) {
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    this.name = options.name ?? `state:${this.prefix}`;
    this.provider = options.provider;
    this.models = new Set(options.models);
    if (this.models.size === 0) {
      throw new Error(
        `StateProjectionBackend(${this.name}): at least one model must be configured.`,
      );
    }
  }

  matches(path: string): boolean {
    return path === this.prefix || path.startsWith(`${this.prefix}/`);
  }

  // ── Read operations ───────────────────────────────────────────────────

  async readFile(path: string): Promise<string> {
    const parsed = this.parseEntityPath(path);
    if (!parsed) throw new SandboxNotFoundError(path);

    const entity = await this.provider.getEntity(parsed.model, parsed.id);
    if (entity === null) throw new SandboxNotFoundError(path);

    return JSON.stringify(entity, null, 2);
  }

  async stat(path: string): Promise<SandboxStats> {
    const content = await this.readFile(path);
    return {
      isFile: () => true,
      isDirectory: () => false,
      size: content.length,
      mtimeMs: Date.now(),
    };
  }

  async access(path: string): Promise<void> {
    // Reuse readFile's existence check (it throws SandboxNotFoundError).
    await this.readFile(path);
  }

  async mkdir(path: string): Promise<void> {
    // State directories are derived from entity existence, not created.
    throw new SandboxReadOnlyError(path);
  }

  async readdir(path: string): Promise<Dirent[]> {
    // /state            → list of model directories
    // /state/<model>    → list of entity files
    // /state/<model>/x  → no children
    const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;

    if (trimmed === this.prefix) {
      // List model directories
      return [...this.models].map((name) => ({
        name,
        isFile: () => false,
        isDirectory: () => true,
      }));
    }

    const remainder = trimmed.slice(this.prefix.length + 1); // strip prefix + "/"
    const segments = remainder.split('/');

    if (segments.length === 1 && this.models.has(segments[0])) {
      // List entity files for this model
      const ids = await this.provider.listEntities(segments[0]);
      return ids.map((id) => ({
        name: `${id}${FILE_SUFFIX}`,
        isFile: () => true,
        isDirectory: () => false,
      }));
    }

    return [];
  }

  async glob(pattern: string): Promise<string[]> {
    // Glob requires enumerating all entities and matching against the pattern.
    // Since entity lists can be large, only iterate models whose directory
    // could be matched by the pattern's static prefix.
    const models = await this.modelsThatMightMatch(pattern);
    const allPaths: string[] = [];
    for (const model of models) {
      const ids = await this.provider.listEntities(model);
      for (const id of ids) {
        allPaths.push(`${this.prefix}/${model}/${id}${FILE_SUFFIX}`);
      }
    }
    const re = globToRegex(pattern);
    return allPaths.filter((p) => re.test(p));
  }

  async grep(
    pattern: string,
    options?: { path?: string; caseInsensitive?: boolean },
  ): Promise<GrepMatch[]> {
    // Grep over JSON-serialized state. Iterate scoped models only.
    const re = new RegExp(pattern, options?.caseInsensitive ? 'i' : '');
    const out: GrepMatch[] = [];

    const candidatePath = options?.path ?? this.prefix;
    const remainder = candidatePath
      .replace(this.prefix, '')
      .replace(/^\//, '');
    const scopedModel = remainder.split('/')[0] || null;

    for (const model of this.models) {
      if (scopedModel && scopedModel !== model && this.models.has(scopedModel)) {
        continue;
      }
      const ids = await this.provider.listEntities(model);
      for (const id of ids) {
        const path = `${this.prefix}/${model}/${id}${FILE_SUFFIX}`;
        if (options?.path && !path.startsWith(options.path)) continue;

        const entity = await this.provider.getEntity(model, id);
        if (entity === null) continue;
        const content = JSON.stringify(entity, null, 2);
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            out.push({ path, lineNumber: i + 1, line: lines[i] });
          }
        }
      }
    }
    return out;
  }

  // ── Write operations (all reject) ─────────────────────────────────────

  async writeFile(path: string): Promise<void> {
    throw new SandboxReadOnlyError(path);
  }

  async edit(path: string): Promise<void> {
    throw new SandboxReadOnlyError(path);
  }

  // ── Internal ─────────────────────────────────────────────────────────

  /**
   * Parse `/state/<model>/<id>.json` into `{ model, id }`.
   * Returns null if the path doesn't match the expected shape or the
   * model isn't configured.
   */
  private parseEntityPath(path: string): { model: string; id: string } | null {
    if (!path.startsWith(`${this.prefix}/`)) return null;
    const remainder = path.slice(this.prefix.length + 1);
    const segments = remainder.split('/');
    if (segments.length !== 2) return null;

    const [model, fileName] = segments;
    if (!this.models.has(model)) return null;
    if (!fileName.endsWith(FILE_SUFFIX)) return null;

    return { model, id: fileName.slice(0, -FILE_SUFFIX.length) };
  }

  private async modelsThatMightMatch(pattern: string): Promise<string[]> {
    const wildcardIdx = pattern.search(/[*?[]/);
    const staticPrefix =
      wildcardIdx === -1 ? pattern : pattern.slice(0, wildcardIdx);

    return [...this.models].filter((model) => {
      const modelPath = `${this.prefix}/${model}/`;
      return (
        staticPrefix.startsWith(modelPath) ||
        modelPath.startsWith(staticPrefix) ||
        staticPrefix === this.prefix ||
        staticPrefix === `${this.prefix}/`
      );
    });
  }
}

