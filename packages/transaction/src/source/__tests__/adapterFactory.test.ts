import type { AdapterCapabilities } from '../adapters/contract.js';
import type { MutationAdapter } from '../adapters/adapter.js';
import { defineDatabaseAdapter } from '../adapters/adapterFactory.js';
import {
  memoryAdapterProfile,
  postgresAdapterProfile,
  type DatabaseAdapterProfile,
} from '../adapters/adapterProfile.js';

function adapter(
  profile: DatabaseAdapterProfile,
  capabilities: AdapterCapabilities,
): MutationAdapter {
  return {
    profile,
    capabilities,
    migrations: () => [],
    read: async () => [],
    commit: async () => ({ rows: [] }),
  };
}

const baseCapabilities: AdapterCapabilities = {
  transactions: true,
  propose: false,
  schemaIntrospection: false,
  postgresWalEcho: false,
  outboxEvents: true,
};

describe('defineDatabaseAdapter', () => {
  it('keeps database, binding, and endpoint observation explicit', () => {
    const defined = defineDatabaseAdapter(
      adapter(
        postgresAdapterProfile('prisma', 'transactional-outbox'),
        { ...baseCapabilities, postgresWalEcho: true },
      ),
    );

    expect(defined.profile).toEqual({
      id: 'postgresql-prisma-transactional-outbox',
      database: 'postgresql',
      binding: 'prisma',
      observation: {
        kind: 'transactional-outbox',
        externalWrites: false,
      },
    });
  });

  it('accepts PostgreSQL WAL only without an outbox feed', () => {
    const defined = defineDatabaseAdapter(
      adapter(
        postgresAdapterProfile('kysely', 'postgres-wal'),
        {
          ...baseCapabilities,
          postgresWalEcho: true,
          outboxEvents: false,
        },
      ),
    );

    expect(defined.profile.observation).toEqual({
      kind: 'postgres-wal',
      externalWrites: true,
    });
  });

  it('rejects an outbox profile without atomic transactions', () => {
    expect(() =>
      defineDatabaseAdapter(
        adapter(memoryAdapterProfile(), {
          ...baseCapabilities,
          transactions: false,
        }),
      ),
    ).toThrow(/without atomic transactions/);
  });

  it('rejects a PostgreSQL WAL marker on another database', () => {
    expect(() =>
      defineDatabaseAdapter(
        adapter(
          {
            id: 'memory-invalid-wal-marker',
            database: 'memory',
            binding: 'memory',
            observation: {
              kind: 'transactional-outbox',
              externalWrites: false,
            },
          },
          { ...baseCapabilities, postgresWalEcho: true },
        ),
      ),
    ).toThrow(/PostgreSQL WAL marker on memory/);
  });

  it('rejects a WAL profile that also advertises outbox events', () => {
    expect(() =>
      defineDatabaseAdapter(
        adapter(
          postgresAdapterProfile('kysely', 'postgres-wal'),
          {
            ...baseCapabilities,
            postgresWalEcho: true,
            outboxEvents: true,
          },
        ),
      ),
    ).toThrow(/invalid PostgreSQL WAL capability combination/);
  });
});
