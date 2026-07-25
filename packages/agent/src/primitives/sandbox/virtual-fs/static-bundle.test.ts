/**
 * StaticBundleBackend tests — read-only filesystem for bundled content.
 */

import { describe, it, expect } from 'vitest';
import { StaticBundleBackend } from './static-bundle';
import { SandboxNotFoundError, SandboxReadOnlyError } from '../interface';

describe('StaticBundleBackend', () => {
  describe('construction', () => {
    it('accepts a Map of files', () => {
      const backend = new StaticBundleBackend({
        prefix: '/api',
        files: new Map([['/api/layer.ts', 'content']]),
      });
      expect(backend.name).toBe('static:/api');
    });

    it('accepts a plain object of files', () => {
      const backend = new StaticBundleBackend({
        prefix: '/api',
        files: { '/api/layer.ts': 'content' },
      });
      expect(backend.name).toBe('static:/api');
    });

    it('rejects files outside the prefix', () => {
      expect(
        () =>
          new StaticBundleBackend({
            prefix: '/api',
            files: { '/elsewhere/file.ts': 'content' },
          }),
      ).toThrow(/outside the prefix/);
    });

    it('respects custom name override', () => {
      const backend = new StaticBundleBackend({
        prefix: '/api',
        files: {},
        name: 'api-bundle',
      });
      expect(backend.name).toBe('api-bundle');
    });
  });

  describe('matches', () => {
    it('matches the prefix and any subpath', () => {
      const backend = new StaticBundleBackend({ prefix: '/api', files: {} });
      expect(backend.matches('/api')).toBe(true);
      expect(backend.matches('/api/layer.ts')).toBe(true);
      expect(backend.matches('/api/sub/deep.ts')).toBe(true);
    });

    it('does not match unrelated or substring paths', () => {
      const backend = new StaticBundleBackend({ prefix: '/api', files: {} });
      expect(backend.matches('/other')).toBe(false);
      expect(backend.matches('/apipie')).toBe(false);
    });
  });

  describe('readFile', () => {
    it('returns content for an existing path', async () => {
      const backend = new StaticBundleBackend({
        prefix: '/api',
        files: { '/api/layer.ts': 'export declare function create(): void;' },
      });
      const content = await backend.readFile('/api/layer.ts');
      expect(content).toContain('create');
    });

    it('throws SandboxNotFoundError for missing paths', async () => {
      const backend = new StaticBundleBackend({ prefix: '/api', files: {} });
      await expect(backend.readFile('/api/missing.ts')).rejects.toThrow(
        SandboxNotFoundError,
      );
    });
  });

  describe('write operations are rejected', () => {
    it('writeFile throws SandboxReadOnlyError', async () => {
      const backend = new StaticBundleBackend({ prefix: '/api', files: {} });
      await expect(backend.writeFile('/api/layer.ts')).rejects.toThrow(
        SandboxReadOnlyError,
      );
    });

    it('edit throws SandboxReadOnlyError', async () => {
      const backend = new StaticBundleBackend({ prefix: '/api', files: {} });
      await expect(backend.edit('/api/layer.ts')).rejects.toThrow(
        SandboxReadOnlyError,
      );
    });

    it('error message hints that state mutations should go through execute()', async () => {
      const backend = new StaticBundleBackend({ prefix: '/api', files: {} });
      try {
        await backend.writeFile('/api/x.ts');
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as Error).message).toContain('execute()');
      }
    });
  });

  describe('readdir', () => {
    it('lists files and subdirectories', async () => {
      const backend = new StaticBundleBackend({
        prefix: '/api',
        files: {
          '/api/layer.ts': '',
          '/api/sheet.ts': '',
          '/api/sub/deep.ts': '',
        },
      });
      const entries = await backend.readdir('/api');
      expect(entries.map((e) => e.name).sort()).toEqual([
        'layer.ts',
        'sheet.ts',
        'sub',
      ]);
      const sub = entries.find((e) => e.name === 'sub')!;
      expect(sub.isDirectory()).toBe(true);
    });
  });

  describe('glob', () => {
    it('matches single-segment wildcards', async () => {
      const backend = new StaticBundleBackend({
        prefix: '/api',
        files: {
          '/api/layer.ts': '',
          '/api/sheet.ts': '',
          '/api/sub/deep.ts': '',
        },
      });
      const direct = await backend.glob('/api/*.ts');
      expect(direct.sort()).toEqual(['/api/layer.ts', '/api/sheet.ts']);
    });

    it('handles globstar', async () => {
      const backend = new StaticBundleBackend({
        prefix: '/api',
        files: {
          '/api/layer.ts': '',
          '/api/sub/deep.ts': '',
        },
      });
      const all = await backend.glob('/api/**/*.ts');
      expect(all.sort()).toEqual(['/api/layer.ts', '/api/sub/deep.ts']);
    });
  });

  describe('grep', () => {
    it('finds lines matching a pattern across files', async () => {
      const backend = new StaticBundleBackend({
        prefix: '/api',
        files: {
          '/api/layer.ts': 'export declare function createLayer(): void;',
          '/api/sheet.ts': 'export declare function setCell(): void;',
        },
      });
      const matches = await backend.grep('createLayer');
      expect(matches).toHaveLength(1);
      expect(matches[0].path).toBe('/api/layer.ts');
    });
  });

  describe('stat', () => {
    it('returns file metadata', async () => {
      const backend = new StaticBundleBackend({
        prefix: '/api',
        files: { '/api/layer.ts': 'hello' },
      });
      const stats = await backend.stat('/api/layer.ts');
      expect(stats.size).toBe(5);
      expect(stats.isFile()).toBe(true);
    });
  });
});
