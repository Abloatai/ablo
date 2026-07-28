import { detectProvider, detectPooler, logicalReplicationGuidance } from '../dbProvider';

/**
 * The corpus is real host shapes taken from each provider's own connection
 * documentation, not hosts invented to match the matcher. The previous tests
 * asserted that three hand-written `includes()` checks matched the three hosts
 * they were written for, which is a shape that cannot fail; every defect below
 * survived it.
 */
describe('detectProvider — identification from real provider hosts', () => {
  it('identifies Neon across its endpoint spellings', () => {
    // Docs: `ep-<id>[-pooler].<region>.aws.neon.tech`; newer projects carry a
    // `.c-N.` segment, and Neon on Azure serves from `azure.neon.tech`.
    expect(detectProvider('ep-cool-darkness-123456.us-east-2.aws.neon.tech')).toBe('neon');
    expect(detectProvider('ep-tiny-fire-aj1gvf1c.c-3.us-east-2.aws.neon.tech/neondb')).toBe('neon');
    expect(detectProvider('ep-tiny-fire-aj1gvf1c.eastus2.azure.neon.tech')).toBe('neon');
  });

  it('identifies Supabase on both its direct domains and Supavisor', () => {
    expect(detectProvider('db.abcdefghijklmnopqrst.supabase.co')).toBe('supabase');
    expect(detectProvider('db.abcdefghijklmnopqrst.supabase.com')).toBe('supabase');
    expect(detectProvider('aws-0-us-east-1.pooler.supabase.com')).toBe('supabase');
  });

  it('identifies RDS including the China partition and RDS Proxy', () => {
    expect(detectProvider('mydb.abc123.us-east-1.rds.amazonaws.com')).toBe('rds');
    expect(detectProvider('mydb.proxy-abc123.us-east-1.rds.amazonaws.com')).toBe('rds');
    expect(detectProvider('mydb.abc.cn-north-1.rds.amazonaws.com.cn')).toBe('rds');
  });

  it('does not claim a self-hosted host that merely contains a provider label', () => {
    // `includes('.rds.')` claimed this one and then told its operator to edit a
    // parameter group that does not exist. A suffix must land on a label boundary.
    expect(detectProvider('pg.rds.internal.corp.example')).toBe('generic');
    expect(detectProvider('neon.tech.attacker.example.com')).toBe('generic');
    expect(detectProvider('my-supabase.com.example.org')).toBe('generic');
  });

  it('leaves unrecognized and self-hosted hosts generic', () => {
    expect(detectProvider('myserver.postgres.database.azure.com')).toBe('generic');
    expect(detectProvider('pg-12345678-proj.a.aivencloud.com')).toBe('generic');
    expect(detectProvider('localhost')).toBe('generic');
    expect(detectProvider('10.0.0.5:5432/app')).toBe('generic');
  });
});

describe('detectPooler — a pooler cannot carry logical replication', () => {
  it('derives the direct Neon host from the pooled one, path intact', () => {
    expect(detectPooler('ep-tiny-fire-aj1gvf1c-pooler.c-3.us-east-2.aws.neon.tech/neondb')).toEqual({
      provider: 'neon',
      direct: 'ep-tiny-fire-aj1gvf1c.c-3.us-east-2.aws.neon.tech/neondb',
      confidence: 'host',
    });
  });

  it('flags Supavisor and RDS Proxy, which have no derivable direct host', () => {
    expect(detectPooler('aws-0-eu-central-1.pooler.supabase.com/postgres')).toEqual({
      provider: 'supabase',
      confidence: 'host',
    });
    expect(detectPooler('mydb.proxy-abc123.us-east-1.rds.amazonaws.com/app')).toEqual({
      provider: 'rds',
      confidence: 'host',
    });
  });

  it('hints at a self-hosted pooler by its port, never claiming it', () => {
    // A self-hosted PgBouncer or Supavisor sits on an ordinary domain, so the
    // port is the only signal left: 6432 is PgBouncer's shipped default and
    // 6543 is Supavisor's transaction mode. It is reported as a hint because a
    // pooler moves off these freely and a Postgres can answer on them, and a
    // caller that refused on this alone would block a working database.
    expect(detectPooler('pgbouncer.internal.example.com:6432')).toEqual({
      provider: 'generic',
      confidence: 'port',
    });
    expect(detectPooler('postgres://u:p@pgbouncer.internal.example.com:6543/app')).toEqual({
      provider: 'generic',
      confidence: 'port',
    });
  });

  it('separates a named pooled endpoint from a mere port, since only one may stop a run', () => {
    expect(detectPooler('aws-0-eu-central-1.pooler.supabase.com/postgres')?.confidence).toBe('host');
    expect(detectPooler('db.internal.example.com:6432/app')?.confidence).toBe('port');
  });

  it('stays silent on a direct host, so a real credential failure still reads as one', () => {
    expect(detectPooler('ep-tiny-fire-aj1gvf1c.c-3.us-east-2.aws.neon.tech/neondb')).toBeNull();
    expect(detectPooler('db.abcdefgh.supabase.co/postgres')).toBeNull();
    expect(detectPooler('mydb.abc123.us-east-1.rds.amazonaws.com/app')).toBeNull();
    expect(detectPooler('pg.internal.example.com:5432/app')).toBeNull();
    expect(detectPooler('localhost')).toBeNull();
  });
});

describe('logicalReplicationGuidance — never a statement the reader cannot run', () => {
  it('gives each named provider its own route, not an ALTER SYSTEM', () => {
    expect(logicalReplicationGuidance('neon')).toMatch(/Neon project settings/);
    expect(logicalReplicationGuidance('neon')).not.toMatch(/ALTER SYSTEM/);
    expect(logicalReplicationGuidance('supabase')).toMatch(/Supabase/);
    expect(logicalReplicationGuidance('supabase')).not.toMatch(/ALTER SYSTEM/);
    expect(logicalReplicationGuidance('rds')).toMatch(/rds\.logical_replication = 1/);
    expect(logicalReplicationGuidance('rds')).not.toMatch(/ALTER SYSTEM/);
  });

  it('keeps generic true for a managed host it does not name yet', () => {
    // Every provider outside the table lands here, and `apply` exits non-zero
    // showing this sentence. "Run the ALTER SYSTEM above, then restart
    // Postgres" is impossible on a managed host, so the dashboard route has to
    // be part of the same sentence.
    const generic = logicalReplicationGuidance('generic');
    expect(generic).toMatch(/ALTER SYSTEM/);
    expect(generic).toMatch(/managed host/i);
    expect(generic).toMatch(/dashboard/i);
  });
});
