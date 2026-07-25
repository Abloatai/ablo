/**
 * DefaultSandbox tests — end-to-end composition of VirtualFs + isolated-vm.
 *
 * These actually spin up real isolated-vm isolates, so they exercise the
 * full execute path. Slower than unit tests but they prove the wiring.
 */

import { describe, it, expect } from 'vitest';
import { DefaultSandbox } from './default';
import { ScratchBackend } from './virtual-fs';

describe('DefaultSandbox', () => {
  describe('filesystem delegation', () => {
    it('writeFile + readFile round-trip via ScratchBackend', async () => {
      const sandbox = new DefaultSandbox({
        backends: [new ScratchBackend()],
        api: {},
      });
      await sandbox.writeFile('/scratch/main.ts', 'const x = 1;');
      expect(await sandbox.readFile('/scratch/main.ts')).toBe('const x = 1;');
      await sandbox.stop();
    });

    it('glob/grep work across the composed filesystem', async () => {
      const sandbox = new DefaultSandbox({
        backends: [new ScratchBackend()],
        api: {},
      });
      await sandbox.writeFile('/scratch/a.ts', 'const target = 1;');
      await sandbox.writeFile('/scratch/b.ts', 'const other = 2;');

      const files = await sandbox.glob('/scratch/*.ts');
      expect(files.sort()).toEqual(['/scratch/a.ts', '/scratch/b.ts']);

      const matches = await sandbox.grep('target');
      expect(matches).toHaveLength(1);
      expect(matches[0].path).toBe('/scratch/a.ts');

      await sandbox.stop();
    });
  });

  describe('execute (real isolated-vm)', () => {
    it('runs simple sync code from a scratch file', async () => {
      const sandbox = new DefaultSandbox({
        backends: [new ScratchBackend()],
        api: {},
      });
      await sandbox.writeFile('/scratch/main.ts', 'return 1 + 2;');
      const result = await sandbox.execute({ entrypoint: '/scratch/main.ts' });
      expect(result.error).toBeUndefined();
      expect(result.value).toBe(3);
      await sandbox.stop();
    });

    it('exposes bound API methods to the isolate', async () => {
      const recorded: Array<{ name: string; value: unknown }> = [];
      const sandbox = new DefaultSandbox({
        backends: [new ScratchBackend()],
        api: {
          recorder: {
            log: (name: string, value: unknown) => {
              recorded.push({ name, value });
              return { ok: true };
            },
          },
        },
      });
      await sandbox.writeFile(
        '/scratch/main.ts',
        `recorder.log('first', 42); recorder.log('second', 'hello'); return recorder.log('third', { nested: true });`,
      );
      const result = await sandbox.execute({ entrypoint: '/scratch/main.ts' });
      expect(result.error).toBeUndefined();
      expect(result.value).toEqual({ ok: true });
      expect(recorded).toEqual([
        { name: 'first', value: 42 },
        { name: 'second', value: 'hello' },
        { name: 'third', value: { nested: true } },
      ]);
      await sandbox.stop();
    });

    it('handles arbitrarily deep namespace nesting (4+ levels)', async () => {
      // Regression: the old `buildNestedObject` only unwrapped 3 levels
      // and then emitted leaf method names with their dotted paths
      // intact, producing invalid object literal keys like
      // `layers.create:` when the registered path was 4+ deep
      // (e.g. `context.deck.layouts.layers.create`).
      const sandbox = new DefaultSandbox({
        backends: [new ScratchBackend()],
        api: {
          context: {
            deck: {
              layouts: {
                create: () => 'created',
                layers: {
                  add: (id: string) => `added-${id}`,
                  nested: {
                    deeper: {
                      ping: () => 'pong',
                    },
                  },
                },
              },
            },
          },
        },
      });
      await sandbox.writeFile(
        '/scratch/main.ts',
        `return [
          context.deck.layouts.create(),
          context.deck.layouts.layers.add('x'),
          context.deck.layouts.layers.nested.deeper.ping(),
        ];`,
      );
      const result = await sandbox.execute({ entrypoint: '/scratch/main.ts' });
      expect(result.error).toBeUndefined();
      expect(result.value).toEqual(['created', 'added-x', 'pong']);
      await sandbox.stop();
    });

    it('supports async API methods in the isolate', async () => {
      const sandbox = new DefaultSandbox({
        backends: [new ScratchBackend()],
        api: {
          db: {
            fetch: async (id: string) => ({ id, fetched: true }),
          },
        },
      });
      await sandbox.writeFile(
        '/scratch/main.ts',
        `var result = await db.fetch('user-1'); return result;`,
      );
      const result = await sandbox.execute({ entrypoint: '/scratch/main.ts' });
      expect(result.error).toBeUndefined();
      expect(result.value).toEqual({ id: 'user-1', fetched: true });
      await sandbox.stop();
    });

    it('exposes context blob as __context global', async () => {
      const sandbox = new DefaultSandbox({
        backends: [new ScratchBackend()],
        api: {},
      });
      await sandbox.writeFile(
        '/scratch/main.ts',
        `return __context.value * 10;`,
      );
      const result = await sandbox.execute({
        entrypoint: '/scratch/main.ts',
        context: { value: 7 },
      });
      expect(result.error).toBeUndefined();
      expect(result.value).toBe(70);
      await sandbox.stop();
    });

    it('captures runtime errors in result.error instead of throwing', async () => {
      const sandbox = new DefaultSandbox({
        backends: [new ScratchBackend()],
        api: {},
      });
      await sandbox.writeFile('/scratch/main.ts', 'throw new Error("boom");');
      const result = await sandbox.execute({ entrypoint: '/scratch/main.ts' });
      expect(result.value).toBeUndefined();
      expect(result.error?.message).toContain('boom');
      expect(result.error?.isTimeout).toBe(false);
      await sandbox.stop();
    });

    it('reports infrastructure errors when entrypoint cannot be read', async () => {
      const sandbox = new DefaultSandbox({
        backends: [new ScratchBackend()],
        api: {},
      });
      const result = await sandbox.execute({
        entrypoint: '/scratch/missing.ts',
      });
      expect(result.value).toBeUndefined();
      expect(result.error?.message).toContain('Cannot read entrypoint');
      await sandbox.stop();
    });

    it('honors per-execution timeout', async () => {
      const sandbox = new DefaultSandbox({
        backends: [new ScratchBackend()],
        api: {},
      });
      await sandbox.writeFile(
        '/scratch/main.ts',
        `while(true) {}`, // infinite loop
      );
      const result = await sandbox.execute({
        entrypoint: '/scratch/main.ts',
        timeoutMs: 200,
      });
      expect(result.error).toBeDefined();
      expect(result.error?.isTimeout).toBe(true);
      await sandbox.stop();
    }, 5_000);

    it('stop() makes subsequent execute() return an error', async () => {
      const sandbox = new DefaultSandbox({
        backends: [new ScratchBackend()],
        api: {},
      });
      await sandbox.writeFile('/scratch/main.ts', 'return 1;');
      await sandbox.stop();
      const result = await sandbox.execute({ entrypoint: '/scratch/main.ts' });
      expect(result.error?.message).toBe('Sandbox is stopped');
    });
  });

  describe('lifecycle hooks', () => {
    it('create() awaits afterStart hook before returning', async () => {
      const events: string[] = [];
      const sandbox = await DefaultSandbox.create({
        backends: [new ScratchBackend()],
        api: {},
        hooks: {
          afterStart: async (s) => {
            events.push('afterStart');
            await s.writeFile('/scratch/seeded.ts', 'return 42;');
          },
        },
      });
      expect(events).toEqual(['afterStart']);
      // Verify the seeded file was written before create() resolved
      expect(await sandbox.readFile('/scratch/seeded.ts')).toBe('return 42;');
      await sandbox.stop();
    });

    it('stop() awaits beforeStop hook', async () => {
      const events: string[] = [];
      const sandbox = new DefaultSandbox({
        backends: [new ScratchBackend()],
        api: {},
        hooks: {
          beforeStop: async () => {
            events.push('beforeStop');
          },
        },
      });
      await sandbox.stop();
      expect(events).toEqual(['beforeStop']);
    });

    it('stop() is idempotent', async () => {
      let count = 0;
      const sandbox = new DefaultSandbox({
        backends: [new ScratchBackend()],
        api: {},
        hooks: { beforeStop: async () => { count++; } },
      });
      await sandbox.stop();
      await sandbox.stop();
      await sandbox.stop();
      expect(count).toBe(1);
    });

    it('stop() proceeds even when beforeStop throws', async () => {
      const sandbox = new DefaultSandbox({
        backends: [new ScratchBackend()],
        api: {},
        hooks: {
          beforeStop: async () => {
            throw new Error('hook failure');
          },
        },
      });
      await expect(sandbox.stop()).resolves.not.toThrow();
      // After failed stop, sandbox should still be marked stopped
      await sandbox.writeFile('/scratch/main.ts', 'return 1;');
      const result = await sandbox.execute({ entrypoint: '/scratch/main.ts' });
      expect(result.error?.message).toBe('Sandbox is stopped');
    });
  });

  describe('metadata', () => {
    it('exposes type, environmentDetails, timeout from options', () => {
      const sandbox = new DefaultSandbox({
        backends: [new ScratchBackend()],
        api: {},
        type: 'cloud',
        environmentDetails: 'test sandbox',
        proactiveTimeoutMs: 60_000,
      });
      expect(sandbox.type).toBe('cloud');
      expect(sandbox.environmentDetails).toBe('test sandbox');
      expect(sandbox.timeout).toBe(60_000);
      expect(sandbox.expiresAt).toBeGreaterThan(Date.now());
    });

    it('defaults type to isolated-vm', () => {
      const sandbox = new DefaultSandbox({
        backends: [new ScratchBackend()],
        api: {},
      });
      expect(sandbox.type).toBe('isolated-vm');
      expect(sandbox.expiresAt).toBeUndefined();
    });
  });
});
