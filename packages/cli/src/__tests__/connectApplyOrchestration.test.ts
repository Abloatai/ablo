/** Exercise connect apply through real lifecycle inspection and SQL planning. */
import { runConnectApply } from '../connectApply';
import { parseConnectArgs } from '../connect';
import * as config from '../config';
import * as dbRole from '../dbRole';
import * as readiness from '../readiness';
import * as remote from '../remoteValidation';
import * as target from '../target';
import * as preflight from '../connectPreflight';
import * as ownership from '../connectOwnership';
import * as setup from '../connectSetup';
import * as connect from '../connect/index';
import postgres from 'postgres';

const mockUnsafe = jest.fn(async (_statement: string) => []);
const mockEnd = jest.fn(async () => undefined);
jest.mock('postgres', () => jest.fn(() => ({ unsafe: mockUnsafe, end: mockEnd })));

const ready = {
  ok: true, reachable: true, ready: true, failures: [],
  initialSnapshot: { status: 'complete' },
} satisfies remote.RemoteValidation;
const args = parseConnectArgs([
  'apply', '--tables', 'items,new_table', '--url', 'postgres://admin@localhost/test', '--yes', '--json',
]);

beforeEach(() => {
  jest.clearAllMocks();
  mockUnsafe.mockReset().mockResolvedValue([]);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(config, 'resolveMutationApiKey').mockReturnValue('sk_fixture');
  jest.spyOn(dbRole, 'readProjectAdminDatabaseUrl').mockReturnValue(null);
  jest.spyOn(readiness, 'fetchDataSourceState').mockResolvedValue({ kind: 'connected', connections: ['direct'], hosts: ['localhost'] });
  jest.spyOn(remote, 'requestRemoteValidation').mockResolvedValue(ready);
  jest.spyOn(target, 'resolveTarget').mockResolvedValue({
    url: 'https://api.example.com', keyPrefix: 'sk_fixture', keySource: 'env', keyEnv: null,
    localProject: undefined, mismatches: [],
    confirmed: { branchId: 'br1', organizationId: 'org1', projectId: 'proj1', project: null, environment: null },
  });
  jest.spyOn(preflight, 'locateExistingConnection').mockResolvedValue(null);
  jest.spyOn(preflight, 'schemaDeclaredTables').mockResolvedValue(['items']);
  jest.spyOn(preflight, 'adminCanCreateRoles').mockResolvedValue({
    rolname: 'admin', rolsuper: true, rolcreaterole: true, rolreplication: true, rolbypassrls: true,
  });
  jest.spyOn(ownership, 'ledgerBlocker').mockResolvedValue(null);
  jest.spyOn(ownership, 'publishedTableBlockers').mockResolvedValue([]);
  jest.spyOn(preflight, 'currentWalLevel').mockResolvedValue('logical');
  jest.spyOn(preflight, 'presentRoles').mockImplementation(async (_sql, roles) => [...roles]);
  jest.spyOn(setup, 'readPublicationState').mockResolvedValue({ exists: true, allTables: false, tables: ['items'] });
  jest.spyOn(setup, 'registerDirectDataSource').mockResolvedValue(true);
  jest.spyOn(connect, 'requestInitialSnapshot').mockResolvedValue({ object: 'datasource_resnapshot', initial_snapshot: { status: 'loading' } });
});
afterEach(() => jest.restoreAllMocks());

it('adds a requested table to publication and both scoped grants without rotating or registering credentials', async () => {
  await runConnectApply(args);
  const sql = mockUnsafe.mock.calls.map(([statement]) => statement).join('\n');
  expect(sql).toMatch(/ALTER PUBLICATION .* SET TABLE "public"\."items", "public"\."new_table"/);
  expect(sql).toMatch(/GRANT SELECT ON TABLE .*"public"\."new_table" TO "ablo_replicator_/);
  expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE .*"public"\."new_table" TO "ablo_writer_/);
  expect(sql).not.toMatch(/ALTER ROLE[^;]*PASSWORD/);
  expect(setup.registerDirectDataSource).not.toHaveBeenCalled();
  expect(connect.requestInitialSnapshot).not.toHaveBeenCalled();
  expect(remote.requestRemoteValidation).toHaveBeenCalledTimes(2);
  expect(mockEnd).toHaveBeenCalled();
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"database":"changed"'));
});

it('writes no SQL when the healthy connection already publishes the requested set', async () => {
  await runConnectApply({ ...args, tables: ['items'] });
  expect(mockUnsafe).not.toHaveBeenCalled();
  expect(setup.registerDirectDataSource).not.toHaveBeenCalled();
  expect(connect.requestInitialSnapshot).not.toHaveBeenCalled();
});

it.each(['ready', 'loading'] as const)('preserves %s lifecycle without an admin URL', async (state) => {
  jest.mocked(remote.requestRemoteValidation).mockResolvedValue({
    ...ready, ready: state === 'ready', initialSnapshot: { status: state === 'ready' ? 'complete' : 'loading' },
  });
  await runConnectApply({ ...args, url: undefined, tables: state === 'ready' ? [] : args.tables });
  expect(postgres).not.toHaveBeenCalled();
  expect(connect.requestInitialSnapshot).not.toHaveBeenCalled();
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`"code":"${state}"`));
});

it('retries a snapshot without provisioning when no tables were requested', async () => {
  jest.mocked(remote.requestRemoteValidation).mockResolvedValue({ ...ready, ready: false, initialSnapshot: { status: 'retrying' } });
  await runConnectApply({ ...args, url: undefined, tables: [] });
  expect(postgres).not.toHaveBeenCalled();
  expect(connect.requestInitialSnapshot).toHaveBeenCalledTimes(1);
});

it('executes every SQL statement before retrying a snapshot with added tables', async () => {
  jest.mocked(remote.requestRemoteValidation).mockResolvedValueOnce({ ...ready, ready: false, initialSnapshot: { status: 'retrying' } });
  await runConnectApply(args);
  expect(mockUnsafe).toHaveBeenCalled();
  expect(connect.requestInitialSnapshot).toHaveBeenCalledTimes(1);
  expect(Math.max(...mockUnsafe.mock.invocationCallOrder)).toBeLessThan(
    jest.mocked(connect.requestInitialSnapshot).mock.invocationCallOrder[0]!,
  );
});

it('stops before snapshot retry when publication execution fails', async () => {
  jest.mocked(remote.requestRemoteValidation).mockResolvedValueOnce({ ...ready, ready: false, initialSnapshot: { status: 'retrying' } });
  mockUnsafe.mockRejectedValueOnce(new Error('publication denied'));
  const exit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit requested'); });
  await expect(runConnectApply(args)).rejects.toThrow('exit requested');
  expect(exit).toHaveBeenCalledWith(1);
  expect(connect.requestInitialSnapshot).not.toHaveBeenCalled();
  expect(setup.registerDirectDataSource).not.toHaveBeenCalled();
});
