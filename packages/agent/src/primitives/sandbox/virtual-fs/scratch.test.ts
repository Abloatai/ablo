/**
 * ScratchBackend tests — in-memory writable filesystem for /scratch/**.
 */

import { describe, it, expect } from 'vitest';
import { ScratchBackend } from './scratch';
import { SandboxNotFoundError, SandboxEditError } from '../interface';

describe('ScratchBackend', () => {
  describe('matches', () => {
    it('matches the prefix and any subpath', () => {
      const backend = new ScratchBackend();
      expect(backend.matches('/scratch')).toBe(true);
      expect(backend.matches('/scratch/main.ts')).toBe(true);
      expect(backend.matches('/scratch/sub/deep.ts')).toBe(true);
    });

    it('does not match unrelated paths', () => {
      const backend = new ScratchBackend();
      expect(backend.matches('/api/layer.ts')).toBe(false);
      expect(backend.matches('/state/slides.json')).toBe(false);
      // Edge case: prefix as substring should not match
      expect(backend.matches('/scratchpad')).toBe(false);
    });

    it('respects custom prefix', () => {
      const backend = new ScratchBackend({ prefix: '/workspace' });
      expect(backend.matches('/workspace/main.ts')).toBe(true);
      expect(backend.matches('/scratch/main.ts')).toBe(false);
    });
  });

  describe('readFile / writeFile', () => {
    it('reads what was written', async () => {
      const backend = new ScratchBackend();
      await backend.writeFile('/scratch/main.ts', 'const x = 1;');
      expect(await backend.readFile('/scratch/main.ts')).toBe('const x = 1;');
    });

    it('overwrites existing files', async () => {
      const backend = new ScratchBackend();
      await backend.writeFile('/scratch/main.ts', 'first');
      await backend.writeFile('/scratch/main.ts', 'second');
      expect(await backend.readFile('/scratch/main.ts')).toBe('second');
    });

    it('throws SandboxNotFoundError for missing files', async () => {
      const backend = new ScratchBackend();
      await expect(backend.readFile('/scratch/missing.ts')).rejects.toThrow(
        SandboxNotFoundError,
      );
    });
  });

  describe('edit', () => {
    it('replaces a unique substring', async () => {
      const backend = new ScratchBackend();
      await backend.writeFile('/scratch/main.ts', 'const x = 1;');
      await backend.edit('/scratch/main.ts', 'x = 1', 'x = 42');
      expect(await backend.readFile('/scratch/main.ts')).toBe('const x = 42;');
    });

    it('throws when oldStr is not found', async () => {
      const backend = new ScratchBackend();
      await backend.writeFile('/scratch/main.ts', 'const x = 1;');
      await expect(
        backend.edit('/scratch/main.ts', 'nonexistent', 'y'),
      ).rejects.toThrow(SandboxEditError);
    });

    it('throws when oldStr appears multiple times', async () => {
      const backend = new ScratchBackend();
      await backend.writeFile(
        '/scratch/main.ts',
        'const x = 1; const x = 2;',
      );
      await expect(
        backend.edit('/scratch/main.ts', 'const x', 'let x'),
      ).rejects.toThrow(/multiple times/);
    });

    it('throws when file does not exist', async () => {
      const backend = new ScratchBackend();
      await expect(
        backend.edit('/scratch/missing.ts', 'a', 'b'),
      ).rejects.toThrow(SandboxNotFoundError);
    });
  });

  describe('stat', () => {
    it('returns size and mtime for existing files', async () => {
      const backend = new ScratchBackend();
      await backend.writeFile('/scratch/main.ts', 'hello');
      const stats = await backend.stat('/scratch/main.ts');
      expect(stats.size).toBe(5);
      expect(stats.isFile()).toBe(true);
      expect(stats.isDirectory()).toBe(false);
      expect(stats.mtimeMs).toBeGreaterThan(0);
    });

    it('throws for missing files', async () => {
      const backend = new ScratchBackend();
      await expect(backend.stat('/scratch/missing.ts')).rejects.toThrow(
        SandboxNotFoundError,
      );
    });
  });

  describe('readdir', () => {
    it('lists files in a directory', async () => {
      const backend = new ScratchBackend();
      await backend.writeFile('/scratch/a.ts', '');
      await backend.writeFile('/scratch/b.ts', '');
      const entries = await backend.readdir('/scratch');
      expect(entries.map((e) => e.name).sort()).toEqual(['a.ts', 'b.ts']);
      expect(entries.every((e) => e.isFile())).toBe(true);
    });

    it('lists directories alongside files', async () => {
      const backend = new ScratchBackend();
      await backend.writeFile('/scratch/main.ts', '');
      await backend.writeFile('/scratch/sub/deep.ts', '');
      const entries = await backend.readdir('/scratch');
      expect(entries.map((e) => e.name).sort()).toEqual(['main.ts', 'sub']);
      const sub = entries.find((e) => e.name === 'sub')!;
      expect(sub.isDirectory()).toBe(true);
      expect(sub.isFile()).toBe(false);
    });

    it('returns empty array for paths with no children', async () => {
      const backend = new ScratchBackend();
      const entries = await backend.readdir('/scratch/empty');
      expect(entries).toEqual([]);
    });
  });

  describe('glob', () => {
    it('matches simple wildcards', async () => {
      const backend = new ScratchBackend();
      await backend.writeFile('/scratch/a.ts', '');
      await backend.writeFile('/scratch/b.ts', '');
      await backend.writeFile('/scratch/sub/c.ts', '');

      // Single-segment wildcard does not cross directories
      const direct = await backend.glob('/scratch/*.ts');
      expect(direct.sort()).toEqual(['/scratch/a.ts', '/scratch/b.ts']);
    });

    it('handles globstar (**)', async () => {
      const backend = new ScratchBackend();
      await backend.writeFile('/scratch/a.ts', '');
      await backend.writeFile('/scratch/sub/c.ts', '');
      await backend.writeFile('/scratch/sub/deep/d.ts', '');

      const all = await backend.glob('/scratch/**/*.ts');
      expect(all.sort()).toEqual([
        '/scratch/a.ts',
        '/scratch/sub/c.ts',
        '/scratch/sub/deep/d.ts',
      ]);
    });
  });

  describe('grep', () => {
    it('finds lines matching a pattern across files', async () => {
      const backend = new ScratchBackend();
      await backend.writeFile(
        '/scratch/a.ts',
        'createLayer({type: "text"});\nconst x = 1;',
      );
      await backend.writeFile(
        '/scratch/b.ts',
        'function foo() {}\ncreateLayer({type: "chart"});',
      );

      const matches = await backend.grep('createLayer');
      expect(matches.length).toBe(2);
      expect(matches.map((m) => m.path).sort()).toEqual([
        '/scratch/a.ts',
        '/scratch/b.ts',
      ]);
    });

    it('reports correct line numbers', async () => {
      const backend = new ScratchBackend();
      await backend.writeFile(
        '/scratch/a.ts',
        'line1\nline2 with target\nline3',
      );
      const matches = await backend.grep('target');
      expect(matches).toHaveLength(1);
      expect(matches[0].lineNumber).toBe(2);
      expect(matches[0].line).toBe('line2 with target');
    });

    it('respects caseInsensitive flag', async () => {
      const backend = new ScratchBackend();
      await backend.writeFile('/scratch/a.ts', 'Foo\nBAR');
      const sensitive = await backend.grep('foo');
      expect(sensitive).toHaveLength(0);
      const insensitive = await backend.grep('foo', { caseInsensitive: true });
      expect(insensitive).toHaveLength(1);
    });

    it('limits search to a path subtree when path is provided', async () => {
      const backend = new ScratchBackend();
      await backend.writeFile('/scratch/a/x.ts', 'target');
      await backend.writeFile('/scratch/b/y.ts', 'target');
      const matches = await backend.grep('target', { path: '/scratch/a' });
      expect(matches).toHaveLength(1);
      expect(matches[0].path).toBe('/scratch/a/x.ts');
    });
  });
});
