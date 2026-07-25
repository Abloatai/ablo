/**
 * ScratchBackend — in-memory writable filesystem for `/scratch/**`.
 *
 * The agent's workspace. Code written here is evaluated by `Sandbox.execute()`
 * and discarded when the sandbox stops. No persistence across runs — that
 * is intentional: scratch is for one-shot generation, not state.
 *
 * Supports the full filesystem API: read, write, edit, stat, readdir, glob, grep.
 *
 * ```ts
 * const scratch = new ScratchBackend();
 * await scratch.writeFile('/scratch/main.ts', generatedCode);
 * const code = await scratch.readFile('/scratch/main.ts');
 * ```
 */

import {
  SandboxEditError,
  SandboxNotFoundError,
  type Dirent,
  type GrepMatch,
  type SandboxStats,
} from '../interface';
import { globToRegex } from './glob-utils';
import type { VirtualFsBackend } from './types';

const DEFAULT_PREFIX = '/scratch';

export class ScratchBackend implements VirtualFsBackend {
  readonly name = 'scratch';
  readonly prefix: string;

  private readonly files = new Map<string, { content: string; mtimeMs: number }>();

  constructor(options?: { prefix?: string }) {
    this.prefix = options?.prefix ?? DEFAULT_PREFIX;
  }

  matches(path: string): boolean {
    return path === this.prefix || path.startsWith(`${this.prefix}/`);
  }

  // ── Filesystem ────────────────────────────────────────────────────────

  async readFile(path: string): Promise<string> {
    const entry = this.files.get(path);
    if (!entry) throw new SandboxNotFoundError(path);
    return entry.content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, { content, mtimeMs: Date.now() });
  }

  async edit(path: string, oldStr: string, newStr: string): Promise<void> {
    const entry = this.files.get(path);
    if (!entry) throw new SandboxNotFoundError(path);

    const firstIdx = entry.content.indexOf(oldStr);
    if (firstIdx < 0) {
      throw new SandboxEditError(
        `edit(${path}): old string not found. Use readFile first to check the current content.`,
      );
    }
    const secondIdx = entry.content.indexOf(oldStr, firstIdx + oldStr.length);
    if (secondIdx >= 0) {
      throw new SandboxEditError(
        `edit(${path}): old string appears multiple times. Make it more specific so the replacement is unambiguous.`,
      );
    }

    this.files.set(path, {
      content: entry.content.replace(oldStr, newStr),
      mtimeMs: Date.now(),
    });
  }

  async stat(path: string): Promise<SandboxStats> {
    const entry = this.files.get(path);
    if (!entry) throw new SandboxNotFoundError(path);
    return {
      isFile: () => true,
      isDirectory: () => false,
      size: entry.content.length,
      mtimeMs: entry.mtimeMs,
    };
  }

  async access(path: string): Promise<void> {
    if (!this.files.has(path)) throw new SandboxNotFoundError(path);
  }

  async mkdir(_path: string, _options?: { recursive?: boolean }): Promise<void> {
    // No-op — paths are flat keys, no real directories exist.
    // Accepted for API familiarity (agents call mkdir before nested writes).
  }

  async readdir(path: string): Promise<Dirent[]> {
    const dirPrefix = path.endsWith('/') ? path : `${path}/`;
    const names = new Set<string>();
    const dirNames = new Set<string>();

    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(dirPrefix)) continue;
      const remainder = filePath.slice(dirPrefix.length);
      const slashIdx = remainder.indexOf('/');
      if (slashIdx === -1) {
        names.add(remainder);
      } else {
        dirNames.add(remainder.slice(0, slashIdx));
      }
    }

    const entries: Dirent[] = [];
    for (const name of names) {
      entries.push({
        name,
        isFile: () => true,
        isDirectory: () => false,
      });
    }
    for (const name of dirNames) {
      entries.push({
        name,
        isFile: () => false,
        isDirectory: () => true,
      });
    }
    return entries;
  }

  async glob(pattern: string): Promise<string[]> {
    const re = globToRegex(pattern);
    return [...this.files.keys()].filter((p) => re.test(p));
  }

  async grep(
    pattern: string,
    options?: { path?: string; caseInsensitive?: boolean },
  ): Promise<GrepMatch[]> {
    const re = new RegExp(pattern, options?.caseInsensitive ? 'i' : '');
    const out: GrepMatch[] = [];
    for (const [path, entry] of this.files.entries()) {
      if (options?.path && !path.startsWith(options.path)) continue;
      const lines = entry.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          out.push({ path, lineNumber: i + 1, line: lines[i] });
        }
      }
    }
    return out;
  }
}

