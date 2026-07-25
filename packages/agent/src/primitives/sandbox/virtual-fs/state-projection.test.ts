/**
 * StateProjectionBackend tests — read-only filesystem projecting entity
 * state into JSON files.
 */

import { describe, it, expect, vi } from 'vitest';
import { StateProjectionBackend, type StateProvider } from './state-projection';
import { SandboxNotFoundError, SandboxReadOnlyError } from '../interface';

// ── Test fixture provider ─────────────────────────────────────────────────

function makeProvider(data: Record<string, Record<string, unknown>>): StateProvider {
  return {
    async listEntities(modelName) {
      return Object.keys(data[modelName] ?? {});
    },
    async getEntity(modelName, id) {
      return data[modelName]?.[id] ?? null;
    },
  };
}

const sampleProvider = makeProvider({
  slides: {
    'slide-1': { id: 'slide-1', title: 'Cover', layers: [] },
    'slide-2': { id: 'slide-2', title: 'Revenue', layers: [{ type: 'chart' }] },
  },
  sheets: {
    'main': { id: 'main', cells: { A1: 42 } },
  },
});

describe('StateProjectionBackend', () => {
  describe('construction', () => {
    it('requires at least one model', () => {
      expect(
        () =>
          new StateProjectionBackend({
            provider: sampleProvider,
            models: [],
          }),
      ).toThrow(/at least one model/);
    });

    it('exposes a default name based on the prefix', () => {
      const backend = new StateProjectionBackend({
        provider: sampleProvider,
        models: ['slides'],
      });
      expect(backend.name).toBe('state:/state');
    });

    it('respects custom prefix and name', () => {
      const backend = new StateProjectionBackend({
        provider: sampleProvider,
        models: ['slides'],
        prefix: '/world',
        name: 'world-state',
      });
      expect(backend.name).toBe('world-state');
      expect(backend.prefix).toBe('/world');
    });
  });

  describe('readFile', () => {
    it('returns JSON-serialized entity for a valid path', async () => {
      const backend = new StateProjectionBackend({
        provider: sampleProvider,
        models: ['slides', 'sheets'],
      });
      const content = await backend.readFile('/state/slides/slide-1.json');
      const parsed = JSON.parse(content);
      expect(parsed.id).toBe('slide-1');
      expect(parsed.title).toBe('Cover');
    });

    it('throws SandboxNotFoundError for unknown entity ids', async () => {
      const backend = new StateProjectionBackend({
        provider: sampleProvider,
        models: ['slides'],
      });
      await expect(
        backend.readFile('/state/slides/nonexistent.json'),
      ).rejects.toThrow(SandboxNotFoundError);
    });

    it('throws SandboxNotFoundError for unconfigured models', async () => {
      const backend = new StateProjectionBackend({
        provider: sampleProvider,
        models: ['slides'],
      });
      await expect(
        backend.readFile('/state/sheets/main.json'),
      ).rejects.toThrow(SandboxNotFoundError);
    });

    it('throws for malformed paths', async () => {
      const backend = new StateProjectionBackend({
        provider: sampleProvider,
        models: ['slides'],
      });
      await expect(backend.readFile('/state/slides/sub/x.json')).rejects.toThrow(
        SandboxNotFoundError,
      );
      await expect(backend.readFile('/state/slides/x.txt')).rejects.toThrow(
        SandboxNotFoundError,
      );
    });

    it('calls the provider on every read (no caching)', async () => {
      let callCount = 0;
      const provider: StateProvider = {
        async listEntities() {
          return ['x'];
        },
        async getEntity() {
          callCount++;
          return { id: 'x', value: callCount };
        },
      };
      const backend = new StateProjectionBackend({
        provider,
        models: ['slides'],
      });

      await backend.readFile('/state/slides/x.json');
      await backend.readFile('/state/slides/x.json');
      expect(callCount).toBe(2);
    });
  });

  describe('readdir', () => {
    it('lists model directories at the prefix root', async () => {
      const backend = new StateProjectionBackend({
        provider: sampleProvider,
        models: ['slides', 'sheets'],
      });
      const entries = await backend.readdir('/state');
      expect(entries.map((e) => e.name).sort()).toEqual(['sheets', 'slides']);
      expect(entries.every((e) => e.isDirectory())).toBe(true);
    });

    it('lists entity files within a model directory', async () => {
      const backend = new StateProjectionBackend({
        provider: sampleProvider,
        models: ['slides'],
      });
      const entries = await backend.readdir('/state/slides');
      expect(entries.map((e) => e.name).sort()).toEqual([
        'slide-1.json',
        'slide-2.json',
      ]);
      expect(entries.every((e) => e.isFile())).toBe(true);
    });

    it('returns empty for unconfigured models or deeper paths', async () => {
      const backend = new StateProjectionBackend({
        provider: sampleProvider,
        models: ['slides'],
      });
      expect(await backend.readdir('/state/sheets')).toEqual([]);
      expect(await backend.readdir('/state/slides/slide-1.json')).toEqual([]);
    });
  });

  describe('write operations are rejected', () => {
    it('writeFile throws SandboxReadOnlyError', async () => {
      const backend = new StateProjectionBackend({
        provider: sampleProvider,
        models: ['slides'],
      });
      await expect(
        backend.writeFile('/state/slides/slide-1.json'),
      ).rejects.toThrow(SandboxReadOnlyError);
    });

    it('edit throws SandboxReadOnlyError', async () => {
      const backend = new StateProjectionBackend({
        provider: sampleProvider,
        models: ['slides'],
      });
      await expect(
        backend.edit('/state/slides/slide-1.json'),
      ).rejects.toThrow(SandboxReadOnlyError);
    });

    it('error message hints at execute() for mutations', async () => {
      const backend = new StateProjectionBackend({
        provider: sampleProvider,
        models: ['slides'],
      });
      try {
        await backend.writeFile('/state/slides/slide-1.json');
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as Error).message).toContain('execute()');
      }
    });
  });

  describe('glob', () => {
    it('returns paths for entities matching the pattern', async () => {
      const backend = new StateProjectionBackend({
        provider: sampleProvider,
        models: ['slides', 'sheets'],
      });
      const slides = await backend.glob('/state/slides/*.json');
      expect(slides.sort()).toEqual([
        '/state/slides/slide-1.json',
        '/state/slides/slide-2.json',
      ]);
    });

    it('handles globstar across models', async () => {
      const backend = new StateProjectionBackend({
        provider: sampleProvider,
        models: ['slides', 'sheets'],
      });
      const all = await backend.glob('/state/**/*.json');
      expect(all.sort()).toEqual([
        '/state/sheets/main.json',
        '/state/slides/slide-1.json',
        '/state/slides/slide-2.json',
      ]);
    });

    it('does not iterate unrelated models', async () => {
      const provider: StateProvider = {
        listEntities: vi.fn(async (model) => (model === 'slides' ? ['x'] : [])),
        getEntity: vi.fn(async () => ({})),
      };
      const backend = new StateProjectionBackend({
        provider,
        models: ['slides', 'sheets'],
      });

      await backend.glob('/state/slides/*.json');
      // Must not call listEntities for sheets when scope is /state/slides/
      const calls = (provider.listEntities as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0],
      );
      expect(calls).toContain('slides');
      expect(calls).not.toContain('sheets');
    });
  });

  describe('grep', () => {
    it('finds matches across serialized entity content', async () => {
      const backend = new StateProjectionBackend({
        provider: sampleProvider,
        models: ['slides'],
      });
      const matches = await backend.grep('Revenue');
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].path).toBe('/state/slides/slide-2.json');
    });

    it('respects path scoping', async () => {
      const backend = new StateProjectionBackend({
        provider: sampleProvider,
        models: ['slides', 'sheets'],
      });
      const matches = await backend.grep('id', { path: '/state/sheets' });
      expect(matches.every((m) => m.path.startsWith('/state/sheets'))).toBe(true);
    });
  });

  describe('stat', () => {
    it('returns metadata for an existing entity file', async () => {
      const backend = new StateProjectionBackend({
        provider: sampleProvider,
        models: ['slides'],
      });
      const stats = await backend.stat('/state/slides/slide-1.json');
      expect(stats.isFile()).toBe(true);
      expect(stats.size).toBeGreaterThan(0);
    });
  });
});
