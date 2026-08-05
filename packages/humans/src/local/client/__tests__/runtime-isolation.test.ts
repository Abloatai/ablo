/**
 * Two clients in one process each read their own runtime — the acceptance
 * test for instancing the runtime context (docs/plans/package-split.md,
 * sequence step 1).
 *
 * Before the runtime became per-client, `initRuntime()` was last-writer-wins:
 * constructing a second client silently redirected the first client's
 * components — logger, config, mutation executor — through the second
 * client's context. These tests pin the isolation at both levels: the
 * component graph directly, and the assembled client through the real
 * factory.
 */

import { z } from 'zod';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import type { Logger } from '@abloatai/transaction/logger';
import { Ablo } from '../../../Ablo.js';
import { createInternalComponents } from '../createInternalComponents.js';
import type { RuntimeContext } from '../../RuntimeContext.js';
import {
  noopObservability,
  browserOnlineStatus,
  defaultSessionErrorDetector,
  emptyConfig,
} from '../../RuntimeContext.js';

/** A logger that records every line it is handed, tagged with its level. */
function recordingLogger(): { lines: string[]; logger: Logger } {
  const lines: string[] = [];
  const record =
    (level: string) =>
    (message: string): void => {
      lines.push(`${level}:${message}`);
    };
  return {
    lines,
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
  };
}

function runtimeWith(logger: Logger): RuntimeContext {
  return {
    logger,
    observability: noopObservability,
    sessionErrorDetector: defaultSessionErrorDetector,
    onlineStatus: browserOnlineStatus,
    config: emptyConfig,
    mutationExecutor: {
      commit: () => Promise.resolve({
        lastSyncId: 0,
        status: 'confirmed' as const,
        statusAt: '2026-08-05T10:00:00.058Z',
      }),
      executeCreate: () => Promise.resolve(),
      executeUpdate: () => Promise.resolve(null),
      executeDelete: () => Promise.resolve(),
      executeArchive: () => Promise.resolve(),
      executeUnarchive: () => Promise.resolve(),
    },
    getModelMetadata: () => undefined,
  };
}

const schema = defineSchema({ tasks: model({ title: z.string() }) });

describe('runtime isolation between clients', () => {
  it('component graphs built with different runtimes log through their own', () => {
    const a = recordingLogger();
    const b = recordingLogger();

    const graphA = createInternalComponents({
      schema,
      url: 'wss://a.example.com',
      options: {},
      runtime: runtimeWith(a.logger),
    });
    const graphB = createInternalComponents({
      schema,
      url: 'wss://b.example.com',
      options: {},
      runtime: runtimeWith(b.logger),
    });

    // An operation on A's registry, after B was built, reaches A's logger —
    // not B's, and not the module global.
    const aBefore = a.lines.length;
    const bBefore = b.lines.length;
    graphA.modelRegistry.registerModel('IsolationProbe', class { readonly isProbe = true; } as never);
    expect(a.lines.length).toBeGreaterThan(aBefore);
    expect(b.lines.length).toBe(bBefore);

    // And symmetrically for B.
    const aAfter = a.lines.length;
    graphB.modelRegistry.registerModel('IsolationProbe', class { readonly isProbe = true; } as never);
    expect(b.lines.length).toBeGreaterThan(bBefore);
    expect(a.lines.length).toBe(aAfter);
  });

  it('two factory-built clients keep their own loggers after the second constructs', async () => {
    const a = recordingLogger();
    const b = recordingLogger();

    // Endpoint-form credential: safe under jsdom (no secret-key browser guard).
    const clientA = Ablo({ schema, authEndpoint: '/api/ablo-session', logger: a.logger });
    const clientB = Ablo({ schema, authEndpoint: '/api/ablo-session', logger: b.logger });

    try {
      // Constructing B moved the module-global bridge to B. A write staged on
      // A must still log through A's runtime: the staging path runs
      // InstanceCache and MutationQueue, both constructed with A's instance.
      const aBefore = a.lines.length;
      const bBefore = b.lines.length;
      void clientA.tasks.create({ data: { title: 'isolated' } }).catch(() => undefined);
      // The staging path is asynchronous; give it a beat to run.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(a.lines.length).toBeGreaterThan(aBefore);
      expect(b.lines.length).toBe(bBefore);
    } finally {
      void clientA.dispose();
      void clientB.dispose();
    }
  });
});
