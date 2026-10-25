import { defineSchema, model, field } from '@abloatai/transaction/schema';
import { runPush, parseDevArgs } from '../dev';
import { pushSchema } from '../push';
import { createDeploymentPlanBundle } from '../plan/index';
import { renderDeploymentPlan } from '../plan/render';
import { readProjectAdminDatabaseUrl } from '../dbRole';

jest.mock('../push', () => ({ ...jest.requireActual('../push'), pushSchema: jest.fn() }));
jest.mock('../plan/index', () => ({ createDeploymentPlanBundle: jest.fn() }));
jest.mock('../plan/render', () => ({ renderDeploymentPlan: jest.fn() }));
jest.mock('../dbRole', () => ({ ...jest.requireActual('../dbRole'), readProjectAdminDatabaseUrl: jest.fn() }));

const schema = defineSchema({ notes: model({ title: field.string() }) });
const args = { ...parseDevArgs(['--watch', '--url', 'http://127.0.0.1:18082']), apiKey: 'sk_disposable_test' };
const planMock = createDeploymentPlanBundle as jest.Mock;
const pushMock = pushSchema as jest.Mock;
const databaseMock = readProjectAdminDatabaseUrl as jest.Mock;
const firstPlan = { outcome: 'ready', fingerprint: 'plan_first' };
const database = { schema: 'public', tables: [] };

beforeEach(() => {
  jest.clearAllMocks();
  databaseMock.mockReturnValue('postgresql://synthetic/local');
  planMock.mockResolvedValue({ plan: firstPlan, database });
  pushMock.mockResolvedValue({ ok: true, status: 201, body: { version: 1, hash: 'test' }, bodyText: '' });
});

test('initial push plans before apply and carries the exact reviewed plan and database snapshot', async () => {
  expect((await runPush(schema, args)).ok).toBe(true);
  expect(planMock).toHaveBeenCalledWith({ schema, schemaPath: args.schemaPath, appSchema: 'public', apiKey: args.apiKey, url: args.url, databaseUrl: 'postgresql://synthetic/local', force: false, renames: [], backfills: [] });
  expect(pushMock.mock.calls[0]![1].plan).toBe(firstPlan);
  expect(pushMock.mock.calls[0]![1].database).toBe(database);
  expect(planMock.mock.invocationCallOrder[0]).toBeLessThan(pushMock.mock.invocationCallOrder[0]!);
});

test('watch repush obtains a fresh plan and observation for the changed schema', async () => {
  await runPush(schema, args);
  const next = defineSchema({ notes: model({ title: field.string(), done: field.boolean() }) });
  const nextPlan = { outcome: 'ready', fingerprint: 'plan_next' };
  const nextDatabase = { schema: 'public', tables: [{ name: 'notes' }] };
  planMock.mockResolvedValueOnce({ plan: nextPlan, database: nextDatabase });
  await runPush(next, args);
  expect(planMock).toHaveBeenLastCalledWith(expect.objectContaining({ schema: next }));
  expect(pushMock.mock.calls[1]![1].plan).toBe(nextPlan);
  expect(pushMock.mock.calls[1]![1].database).toBe(nextDatabase);
});

test('blocked planning renders findings and never calls apply', async () => {
  const blocked = { outcome: 'blocked', fingerprint: 'plan_blocked' };
  planMock.mockResolvedValueOnce({ plan: blocked, database });
  const result = await runPush(schema, args);
  expect(result.ok).toBe(false);
  expect(result.message).toContain('plan_blocked');
  expect(renderDeploymentPlan).toHaveBeenCalledWith(blocked);
  expect(pushMock).not.toHaveBeenCalled();
});

test('planning failure cannot fall through to apply', async () => {
  planMock.mockRejectedValueOnce(new Error('planning unavailable'));
  await expect(runPush(schema, args)).rejects.toThrow('planning unavailable');
  expect(pushMock).not.toHaveBeenCalled();
});

test('server-observed storage passes null database and preserves apply refusal rendering', async () => {
  databaseMock.mockReturnValue(undefined);
  planMock.mockResolvedValueOnce({ plan: firstPlan, database: null });
  pushMock.mockResolvedValueOnce({ ok: false, status: 403, body: { message: 'Authoring denied' }, bodyText: '' });
  const result = await runPush(schema, args);
  expect(planMock.mock.calls[0]![0]).not.toHaveProperty('databaseUrl');
  expect(pushMock.mock.calls[0]![1].database).toBeNull();
  expect(result.ok).toBe(false);
  expect(result.message).toContain('Authoring denied');
});
