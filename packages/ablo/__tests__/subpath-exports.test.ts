import { describe, expect, it } from 'vitest';
import manifest from '../package.json';
import Ablo, { Ablo as NamedAblo, AbloError } from '../src/index.js';
import { Ablo as ReactiveAblo } from '../src/client.js';
import { defineSchema, field, relation } from '../src/schema.js';
import { useAblo } from '../src/react.js';
import { dataSourceNext } from '../src/source-next.js';
import { drizzleDataSource } from '../src/source-drizzle.js';
import { kyselyDataSource } from '../src/source-kysely.js';
import { runDataSourceTests } from '../src/source-conformance.js';
import {
  defineDatabaseAdapter,
  postgresAdapterProfile,
} from '../src/source.js';
import {
  createTool,
  deleteTool,
  readTool,
  updateTool,
} from '../src/ai-sdk.js';
import { context } from '../src/context/index.js';
import Sessions from '../src/sessions.js';

describe('@abloatai/ablo public entry points', () => {
  it('publishes the intentional branded subpaths', () => {
    expect(Object.keys(manifest.exports).sort()).toEqual([
      '.',
      './ai-sdk',
      './auth',
      './batching',
      './client',
      './context',
      './coordination',
      './react',
      './schema',
      './server',
      './sessions',
      './source',
      './source/conformance',
      './source/drizzle',
      './source/kysely',
      './source/next',
      './wire',
    ]);
  });

  it('uses the transaction client at the root', () => {
    expect(Ablo).toBe(NamedAblo);
    expect(typeof Ablo).toBe('function');
    expect(AbloError).toBeDefined();
  });

  it('keeps the reactive client and React bindings on explicit subpaths', () => {
    expect(typeof ReactiveAblo).toBe('function');
    expect(typeof useAblo).toBe('function');
  });

  it('serves the server-only session issuer through its explicit subpath', () => {
    expect(typeof Sessions).toBe('function');
  });

  it('serves schema builders through the branded schema path', () => {
    expect(typeof defineSchema).toBe('function');
    expect(typeof field.string).toBe('function');
    expect(typeof relation.belongsTo).toBe('function');
  });

  it('serves data-source adapters through branded subpaths', () => {
    expect(typeof dataSourceNext).toBe('function');
    expect(typeof drizzleDataSource).toBe('function');
    expect(typeof kyselyDataSource).toBe('function');
    expect(typeof runDataSourceTests).toBe('function');
    expect(typeof defineDatabaseAdapter).toBe('function');
    expect(typeof postgresAdapterProfile).toBe('function');
  });

  it('serves AI SDK adapters through the branded path', () => {
    expect(typeof readTool).toBe('function');
    expect(typeof createTool).toBe('function');
    expect(typeof updateTool).toBe('function');
    expect(typeof deleteTool).toBe('function');
  });

  it('serves context assembly without occupying the model namespace', () => {
    expect(typeof context).toBe('function');
  });
});
