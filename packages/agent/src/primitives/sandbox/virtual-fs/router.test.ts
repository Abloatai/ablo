/**
 * VirtualFs router tests.
 *
 * Verifies path-based dispatch, error semantics, and the multi-backend
 * fan-out for glob/grep. Uses tiny in-memory backends for clarity.
 */

import { describe, it, expect } from 'vitest';
import { VirtualFs } from './router';
import { UnsupportedOperationError } from './types';
import { SandboxNotFoundError } from '../interface';
import type { VirtualFsBackend } from './types';
import type { Dirent, GrepMatch, SandboxStats } from '../interface';

// ── Test backends ────────────────────────────────────────────────────────

function makeMapBackend(opts: {
  name: string;
  prefix: string;
  files: Record<string, string>;
  readOnly?: boolean;
}): VirtualFsBackend {
  const map = new Map(Object.entries(opts.files));

  const backend: VirtualFsBackend = {
    name: opts.name,
    prefix: opts.prefix,
    matches: (path) =>
      path === opts.prefix || path.startsWith(`${opts.prefix}/`),
    readFile: async (path) => {
      const v = map.get(path);
      if (v === undefined) throw new Error(`${opts.name}: not found ${path}`);
      return v;
    },
    stat: async (path): Promise<SandboxStats> => {
      const v = map.get(path);
      if (v === undefined) throw new Error(`${opts.name}: not found ${path}`);
      return {
        isFile: () => true,
        isDirectory: () => false,
        size: v.length,
        mtimeMs: 0,
      };
    },
    readdir: async (path): Promise<Dirent[]> => {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const names = new Set<string>();
      for (const fp of map.keys()) {
        if (!fp.startsWith(prefix)) continue;
        const [first] = fp.slice(prefix.length).split('/');
        if (first) names.add(first);
      }
      return [...names].map((name) => ({
        name,
        isFile: () => map.has(`${prefix}${name}`),
        isDirectory: () => false,
      }));
    },
    glob: async (pattern) => {
      const re = new RegExp(
        '^' +
          pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*\*/g, '.*')
            .replace(/\*/g, '[^/]*') +
          '$',
      );
      return [...map.keys()].filter((p) => re.test(p));
    },
    grep: async (pattern, options): Promise<GrepMatch[]> => {
      const re = new RegExp(pattern, options?.caseInsensitive ? 'i' : '');
      const out: GrepMatch[] = [];
      for (const [path, content] of map.entries()) {
        if (options?.path && !path.startsWith(options.path)) continue;
        content.split('\n').forEach((line, i) => {
          if (re.test(line)) {
            out.push({ path, lineNumber: i + 1, line });
          }
        });
      }
      return out;
    },
  };

  if (!opts.readOnly) {
    backend.writeFile = async (path, content) => {
      map.set(path, content);
    };
    backend.edit = async (path, oldStr, newStr) => {
      const c = map.get(path);
      if (c === undefined) throw new Error(`${opts.name}: not found ${path}`);
      map.set(path, c.replace(oldStr, newStr));
    };
  }

  return backend;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('VirtualFs router', () => {
  describe('construction', () => {
    it('throws when constructed with no backends', () => {
      expect(() => new VirtualFs([])).toThrow(/at least one backend/);
    });
  });

  describe('dispatch by prefix', () => {
    it('routes readFile to the matching backend', async () => {
      const fs = new VirtualFs([
        makeMapBackend({
          name: 'api',
          prefix: '/api',
          files: { '/api/layer.ts': 'layer-content' },
        }),
        makeMapBackend({
          name: 'scratch',
          prefix: '/scratch',
          files: { '/scratch/main.ts': 'scratch-content' },
        }),
      ]);

      expect(await fs.readFile('/api/layer.ts')).toBe('layer-content');
      expect(await fs.readFile('/scratch/main.ts')).toBe('scratch-content');
    });

    it('throws SandboxNotFoundError when no backend matches the path', async () => {
      const fs = new VirtualFs([
        makeMapBackend({ name: 'api', prefix: '/api', files: {} }),
      ]);
      // "No backend" surfaces as "not found" — never reveals which prefixes
      // are wired (that would leak access scope to the agent).
      await expect(fs.readFile('/unknown/file')).rejects.toThrow(
        SandboxNotFoundError,
      );
    });

    it('error message does NOT leak available prefixes (security boundary)', async () => {
      const fs = new VirtualFs([
        makeMapBackend({ name: 'api', prefix: '/api', files: {} }),
        makeMapBackend({ name: 'scratch', prefix: '/scratch', files: {} }),
      ]);
      try {
        await fs.readFile('/state/x');
        expect.fail('should have thrown');
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).not.toContain('/api');
        expect(msg).not.toContain('/scratch');
        expect(msg).not.toContain('Available');
      }
    });

    it('throws UnsupportedOperationError when backend lacks the method', async () => {
      const fs = new VirtualFs([
        makeMapBackend({
          name: 'api',
          prefix: '/api',
          files: { '/api/x.ts': 'x' },
          readOnly: true, // no writeFile
        }),
      ]);
      await expect(fs.writeFile('/api/x.ts', 'new')).rejects.toThrow(
        UnsupportedOperationError,
      );
    });
  });

  describe('writeFile + edit', () => {
    it('writeFile delegates to backend', async () => {
      const backend = makeMapBackend({
        name: 'scratch',
        prefix: '/scratch',
        files: {},
      });
      const fs = new VirtualFs([backend]);
      await fs.writeFile('/scratch/main.ts', 'content');
      expect(await fs.readFile('/scratch/main.ts')).toBe('content');
    });

    it('edit delegates to backend', async () => {
      const backend = makeMapBackend({
        name: 'scratch',
        prefix: '/scratch',
        files: { '/scratch/main.ts': 'const x = 1;' },
      });
      const fs = new VirtualFs([backend]);
      await fs.edit('/scratch/main.ts', 'x = 1', 'x = 42');
      expect(await fs.readFile('/scratch/main.ts')).toBe('const x = 42;');
    });
  });

  describe('stat + readdir', () => {
    it('stat returns metadata from the matching backend', async () => {
      const fs = new VirtualFs([
        makeMapBackend({
          name: 'api',
          prefix: '/api',
          files: { '/api/layer.ts': 'abc' },
        }),
      ]);
      const stats = await fs.stat('/api/layer.ts');
      expect(stats.size).toBe(3);
      expect(stats.isFile()).toBe(true);
    });

    it('readdir lists entries from the matching backend', async () => {
      const fs = new VirtualFs([
        makeMapBackend({
          name: 'api',
          prefix: '/api',
          files: {
            '/api/layer.ts': '',
            '/api/sheet.ts': '',
            '/api/sub/deep.ts': '',
          },
        }),
      ]);
      const entries = await fs.readdir('/api');
      expect(entries.map((e) => e.name).sort()).toEqual([
        'layer.ts',
        'sheet.ts',
        'sub',
      ]);
    });
  });

  describe('glob fan-out', () => {
    it('queries every matching backend and merges results', async () => {
      const fs = new VirtualFs([
        makeMapBackend({
          name: 'api',
          prefix: '/api',
          files: { '/api/layer.ts': '', '/api/sheet.ts': '' },
        }),
        makeMapBackend({
          name: 'examples',
          prefix: '/examples',
          files: { '/examples/bar.ts': '' },
        }),
      ]);

      // Pattern that could match multiple backends
      const results = await fs.glob('/**/*.ts');
      expect(results.sort()).toEqual([
        '/api/layer.ts',
        '/api/sheet.ts',
        '/examples/bar.ts',
      ]);
    });

    it('only queries backends whose prefix could match the pattern', async () => {
      let apiCalls = 0;
      let examplesCalls = 0;
      const apiBackend = makeMapBackend({
        name: 'api',
        prefix: '/api',
        files: { '/api/layer.ts': '' },
      });
      const examplesBackend = makeMapBackend({
        name: 'examples',
        prefix: '/examples',
        files: { '/examples/bar.ts': '' },
      });
      const originalApiGlob = apiBackend.glob!;
      const originalExamplesGlob = examplesBackend.glob!;
      apiBackend.glob = async (...args) => {
        apiCalls++;
        return originalApiGlob.call(apiBackend, ...args);
      };
      examplesBackend.glob = async (...args) => {
        examplesCalls++;
        return originalExamplesGlob.call(examplesBackend, ...args);
      };

      const fs = new VirtualFs([apiBackend, examplesBackend]);
      await fs.glob('/api/*.ts');

      expect(apiCalls).toBe(1);
      expect(examplesCalls).toBe(0);
    });

    it('continues when one backend throws', async () => {
      const goodBackend = makeMapBackend({
        name: 'api',
        prefix: '/api',
        files: { '/api/layer.ts': '' },
      });
      const badBackend: VirtualFsBackend = {
        name: 'bad',
        prefix: '/bad',
        matches: (p) => p.startsWith('/bad'),
        glob: async () => {
          throw new Error('boom');
        },
      };
      const fs = new VirtualFs([goodBackend, badBackend]);
      const results = await fs.glob('/**/*.ts');
      expect(results).toContain('/api/layer.ts');
    });
  });

  describe('grep fan-out', () => {
    it('queries every backend when no path is given', async () => {
      const fs = new VirtualFs([
        makeMapBackend({
          name: 'api',
          prefix: '/api',
          files: { '/api/layer.ts': 'createLayer()' },
        }),
        makeMapBackend({
          name: 'examples',
          prefix: '/examples',
          files: { '/examples/use-layer.ts': 'createLayer({})' },
        }),
      ]);
      const matches = await fs.grep('createLayer');
      expect(matches.length).toBe(2);
      expect(matches.map((m) => m.path).sort()).toEqual([
        '/api/layer.ts',
        '/examples/use-layer.ts',
      ]);
    });

    it('routes to a single backend when path is specified', async () => {
      let apiCalls = 0;
      let examplesCalls = 0;
      const apiBackend = makeMapBackend({
        name: 'api',
        prefix: '/api',
        files: { '/api/layer.ts': 'createLayer()' },
      });
      const examplesBackend = makeMapBackend({
        name: 'examples',
        prefix: '/examples',
        files: { '/examples/use-layer.ts': 'createLayer({})' },
      });
      const originalApiGrep = apiBackend.grep!;
      const originalExamplesGrep = examplesBackend.grep!;
      apiBackend.grep = async (...args) => {
        apiCalls++;
        return originalApiGrep.call(apiBackend, ...args);
      };
      examplesBackend.grep = async (...args) => {
        examplesCalls++;
        return originalExamplesGrep.call(examplesBackend, ...args);
      };

      const fs = new VirtualFs([apiBackend, examplesBackend]);
      await fs.grep('createLayer', { path: '/api' });

      expect(apiCalls).toBe(1);
      expect(examplesCalls).toBe(0);
    });
  });
});
