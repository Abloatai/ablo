/**
 * Sandbox interface contract tests.
 *
 * These tests verify that the interface can be satisfied by a realistic
 * implementation (a fake in-memory sandbox with a small virtual filesystem).
 * They serve as both sanity checks and documentation — when a new backend
 * is added, copy this fake and replace the internals.
 */

import { describe, it, expect } from 'vitest';
import type {
  Sandbox,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxStats,
  Dirent,
  GrepMatch,
} from './interface';
import {
  SandboxNotFoundError,
  SandboxReadOnlyError,
  SandboxEditError,
} from './interface';

// ── FakeSandbox: reference implementation used in tests ──────────────────

/**
 * A minimal in-memory Sandbox. Unsafe for production — uses `new Function`
 * for execution and has no isolation — but demonstrates the interface
 * contract cleanly.
 */
class FakeSandbox implements Sandbox {
  readonly type = 'isolated-vm' as const;
  readonly workingDirectory = '/scratch';
  readonly environmentDetails = 'FakeSandbox: eval-based in-memory fs';
  readonly timeout = 30_000;

  private files = new Map<string, string>();
  private readOnlyPaths = new Set<string>();
  private stopped = false;

  constructor(initial?: { files?: Record<string, string>; readOnly?: string[] }) {
    for (const [path, content] of Object.entries(initial?.files ?? {})) {
      this.files.set(path, content);
    }
    for (const path of initial?.readOnly ?? []) {
      this.readOnlyPaths.add(path);
    }
  }

  // ── Filesystem ──────────────────────────────────────────────────────

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new SandboxNotFoundError(path);
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (this.readOnlyPaths.has(path) || [...this.readOnlyPaths].some((p) => path.startsWith(p))) {
      throw new SandboxReadOnlyError(path);
    }
    this.files.set(path, content);
  }

  async edit(path: string, oldStr: string, newStr: string): Promise<void> {
    const content = await this.readFile(path);
    const firstIdx = content.indexOf(oldStr);
    if (firstIdx < 0) {
      throw new SandboxEditError(
        `edit(${path}): old string not found. Use readFile first to check the current content.`,
      );
    }
    const secondIdx = content.indexOf(oldStr, firstIdx + oldStr.length);
    if (secondIdx >= 0) {
      throw new SandboxEditError(
        `edit(${path}): old string appears multiple times. Make it more specific.`,
      );
    }
    await this.writeFile(path, content.replace(oldStr, newStr));
  }

  async stat(path: string): Promise<SandboxStats> {
    const content = this.files.get(path);
    if (content === undefined) throw new SandboxNotFoundError(path);
    return {
      isDirectory: () => false,
      isFile: () => true,
      size: content.length,
      mtimeMs: Date.now(),
    };
  }

  async access(path: string): Promise<void> {
    if (!this.files.has(path)) throw new SandboxNotFoundError(path);
  }

  async mkdir(_path: string, _options?: { recursive?: boolean }): Promise<void> {
    // Virtual fs: directories are implicit, mkdir is a no-op.
  }

  async readdir(path: string): Promise<Dirent[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const names = new Set<string>();
    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const relative = filePath.slice(prefix.length);
      const [first] = relative.split('/');
      if (first) names.add(first);
    }
    return [...names].map((name) => ({
      name,
      isDirectory: () => {
        const sub = `${prefix}${name}/`;
        return [...this.files.keys()].some((p) => p.startsWith(sub));
      },
      isFile: () => this.files.has(`${prefix}${name}`),
    }));
  }

  async glob(pattern: string): Promise<string[]> {
    // Minimal glob: only supports `*` as single-segment wildcard
    const regex = new RegExp(
      '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$',
    );
    return [...this.files.keys()].filter((p) => regex.test(p));
  }

  async grep(
    pattern: string,
    options?: { path?: string; caseInsensitive?: boolean },
  ): Promise<GrepMatch[]> {
    const regex = new RegExp(pattern, options?.caseInsensitive ? 'i' : '');
    const results: GrepMatch[] = [];
    const paths = options?.path
      ? [...this.files.keys()].filter((p) => p.startsWith(options.path!))
      : [...this.files.keys()];
    for (const path of paths) {
      const lines = (this.files.get(path) ?? '').split('\n');
      lines.forEach((line, i) => {
        if (regex.test(line)) {
          results.push({ path, lineNumber: i + 1, line });
        }
      });
    }
    return results;
  }

  // ── Execute ─────────────────────────────────────────────────────────

  async execute(
    request: SandboxExecutionRequest,
  ): Promise<SandboxExecutionResult> {
    if (this.stopped) {
      return {
        value: undefined,
        error: { message: 'Sandbox is stopped' },
      };
    }
    const code = await this.readFile(request.entrypoint);
    try {
      const fn = new Function(
        '__context',
        `"use strict"; return (function() { ${code} })();`,
      );
      const value = fn(request.context ?? {});
      return { value };
    } catch (err) {
      return {
        value: undefined,
        error: {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
      };
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

// ── Contract tests ────────────────────────────────────────────────────────

describe('Sandbox interface contract', () => {
  describe('filesystem', () => {
    it('readFile returns content for an existing path', async () => {
      const sandbox = new FakeSandbox({ files: { '/api/layer.ts': 'export declare function create(): void;' } });
      expect(await sandbox.readFile('/api/layer.ts')).toContain('create');
    });

    it('readFile throws SandboxNotFoundError for missing paths', async () => {
      const sandbox = new FakeSandbox();
      await expect(sandbox.readFile('/missing.ts')).rejects.toThrow(SandboxNotFoundError);
    });

    it('writeFile persists content for writable paths', async () => {
      const sandbox = new FakeSandbox();
      await sandbox.writeFile('/scratch/main.ts', 'const x = 1;');
      expect(await sandbox.readFile('/scratch/main.ts')).toBe('const x = 1;');
    });

    it('writeFile throws SandboxReadOnlyError for read-only paths', async () => {
      const sandbox = new FakeSandbox({
        files: { '/state/slides/slide-1.json': '{}' },
        readOnly: ['/state'],
      });
      await expect(sandbox.writeFile('/state/slides/slide-1.json', '{}')).rejects.toThrow(
        SandboxReadOnlyError,
      );
    });

    it('edit replaces a unique oldStr', async () => {
      const sandbox = new FakeSandbox({ files: { '/scratch/main.ts': 'const x = 1;' } });
      await sandbox.edit('/scratch/main.ts', 'x = 1', 'x = 42');
      expect(await sandbox.readFile('/scratch/main.ts')).toBe('const x = 42;');
    });

    it('edit throws when oldStr not found', async () => {
      const sandbox = new FakeSandbox({ files: { '/scratch/main.ts': 'const x = 1;' } });
      await expect(sandbox.edit('/scratch/main.ts', 'nonexistent', 'y')).rejects.toThrow(SandboxEditError);
    });

    it('edit throws when oldStr appears multiple times', async () => {
      const sandbox = new FakeSandbox({ files: { '/scratch/main.ts': 'const x = 1; const x = 2;' } });
      await expect(sandbox.edit('/scratch/main.ts', 'const x', 'let x')).rejects.toThrow(
        /multiple times/,
      );
    });

    it('glob matches patterns', async () => {
      const sandbox = new FakeSandbox({
        files: {
          '/api/layer.ts': '',
          '/api/sheet.ts': '',
          '/examples/bar.ts': '',
        },
      });
      expect((await sandbox.glob('/api/*.ts')).sort()).toEqual(['/api/layer.ts', '/api/sheet.ts']);
    });

    it('grep finds lines matching a pattern', async () => {
      const sandbox = new FakeSandbox({
        files: { '/examples/chart.ts': 'const x = 1;\nconst chart = renderChart();\n' },
      });
      const matches = await sandbox.grep('chart');
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].path).toBe('/examples/chart.ts');
      expect(matches[0].lineNumber).toBe(2);
    });

    it('readdir lists entries of a directory', async () => {
      const sandbox = new FakeSandbox({
        files: { '/api/layer.ts': '', '/api/sheet.ts': '', '/api/sub/deep.ts': '' },
      });
      const entries = await sandbox.readdir('/api');
      expect(entries.map((e) => e.name).sort()).toEqual(['layer.ts', 'sheet.ts', 'sub']);
    });
  });

  describe('execute', () => {
    it('evaluates code from the entrypoint and returns the final expression', async () => {
      const sandbox = new FakeSandbox({ files: { '/scratch/main.ts': 'return 1 + 2;' } });
      const result = await sandbox.execute({ entrypoint: '/scratch/main.ts' });
      expect(result.value).toBe(3);
      expect(result.error).toBeUndefined();
    });

    it('captures runtime errors in result.error instead of throwing', async () => {
      const sandbox = new FakeSandbox({
        files: { '/scratch/main.ts': 'throw new Error("boom");' },
      });
      const result = await sandbox.execute({ entrypoint: '/scratch/main.ts' });
      expect(result.value).toBeUndefined();
      expect(result.error?.message).toBe('boom');
    });

    it('exposes injected context to evaluated code', async () => {
      const sandbox = new FakeSandbox({
        files: { '/scratch/main.ts': 'return __context.count * 10;' },
      });
      const result = await sandbox.execute({
        entrypoint: '/scratch/main.ts',
        context: { count: 7 },
      });
      expect(result.value).toBe(70);
    });

    it('stop() makes subsequent execute() return an error', async () => {
      const sandbox = new FakeSandbox({ files: { '/scratch/main.ts': 'return 1;' } });
      await sandbox.stop();
      const result = await sandbox.execute({ entrypoint: '/scratch/main.ts' });
      expect(result.error?.message).toBe('Sandbox is stopped');
    });
  });

  describe('metadata', () => {
    it('exposes readonly type, environmentDetails, timeout', () => {
      const sandbox = new FakeSandbox();
      expect(sandbox.type).toBe('isolated-vm');
      expect(sandbox.environmentDetails).toContain('FakeSandbox');
      expect(sandbox.timeout).toBe(30_000);
    });

    it('is assignable to the Sandbox interface', () => {
      const sandbox: Sandbox = new FakeSandbox();
      expect(sandbox.type).toBeDefined();
    });
  });
});
