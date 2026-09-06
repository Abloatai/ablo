import { test, expect, type BrowserContext, type Page } from '@playwright/test';

async function signIn(page: Page, user: string) {
  const password = process.env.DEMO_PASSWORD;
  if (!password) throw new Error('DEMO_PASSWORD is required');
  await page.goto('/');
  await page.getByLabel('User').selectOption(user);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('connected');
}
async function post(page: Page, path: string, data = {}) {
  return page.evaluate(async ({ path, data }) => {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: response.status, text: await response.text() };
  }, { path, data });
}

test('two humans, agent ownership, navigation, account isolation and reconnect', async ({ browser }) => {
  const contexts: BrowserContext[] = [];
  try {
    for (let i = 0; i < 3; i++) contexts.push(await browser.newContext({ baseURL: 'http://localhost:5173' }));
    const [alice, bob, eve] = await Promise.all(contexts.map(context => context.newPage()));
    const presenceEvents: unknown[] = [];
    alice!.on('websocket', socket => socket.on('framereceived', frame => {
      try {
        const message = JSON.parse(String(frame.payload));
        if (message.type === 'presence_patch' || message.type === 'presence_snapshot') {
          presenceEvents.push({ at: Date.now(), ...message });
        }
      } catch { /* Ignore non-JSON transport frames. */ }
    }));
    await Promise.all([signIn(alice!, 'alice'), signIn(bob!, 'bob'), signIn(eve!, 'eve')]);
    const created = await post(alice!, '/api/accounts/alpha/create');
    expect(created.status).toBe(200);
    const { id } = JSON.parse(created.text);
    // The beta-only member cannot mint alpha credentials or run alpha writes.
    expect((await post(eve!, '/api/accounts/alpha/session')).status).toBe(403);
    expect((await post(eve!, '/api/accounts/alpha/create')).status).toBe(403);
    await expect(eve!.getByTestId(`conversation-${id}`)).toHaveCount(0);
    await alice!.getByTestId(`conversation-${id}`).click();
    await bob!.getByTestId(`conversation-${id}`).click();
    await expect(alice!.getByTestId('people')).toContainText('2 people');
    // A second tab adds a session, not a person.
    const tab = await contexts[1]!.newPage();
    await signIn(tab, 'bob');
    await tab.getByTestId(`conversation-${id}`).click();
    await expect(alice!.getByTestId('people')).toContainText('2 people, 3 sessions');
    // Navigation removes its read immediately. A closed socket instead loses
    // its read by lease expiry (90s plus the server's periodic sweep).
    await bob!.getByRole('button', { name: 'Leave chat', exact: true }).click();
    await expect(alice!.getByTestId('people')).toContainText('2 people, 2 sessions');
    await tab.close();
    // Separate requests mint distinct agent identities. Both target this exact
    // conversation; receipts count entry into the actual execution callback.
    const contenders = await Promise.all([
      post(alice!, '/api/accounts/alpha/agent', { id }),
      post(bob!, '/api/accounts/alpha/agent', { id }),
    ]);
    for (const response of contenders) expect(response.status).toBe(202);
    const runIds: string[] = contenders.map(response => JSON.parse(response.text).runId);
    expect(new Set(runIds).size).toBe(2);
    expect((await post(alice!, '/api/accounts/beta/agent-status', { runId: runIds[0] })).status).toBe(404);
    const receipts = () => Promise.all(runIds.map(async runId => {
      const response = await post(alice!, '/api/accounts/alpha/agent-status', { runId });
      expect(response.status).toBe(200);
      return JSON.parse(response.text) as { status: string; executions: number };
    }));
    await expect(alice!.getByText('Agent owns this chat', { exact: true })).toBeVisible();
    await expect.poll(async () => (await receipts()).map(run => run.status).sort())
      .toEqual(['executing', 'skipped']);
    await expect(alice!.getByText('Execution: generating', { exact: true })).toBeVisible();
    await expect(alice!.getByText('Agent owns this chat', { exact: true })).toBeVisible();
    // A contender arriving AFTER the first write must still be excluded.
    const duringRun = await post(bob!, '/api/accounts/alpha/agent', { id });
    expect(duringRun.status).toBe(202);
    const { runId: duringRunId } = JSON.parse(duringRun.text);
    await expect.poll(async () => {
      const response = await post(bob!, '/api/accounts/alpha/agent-status', { runId: duringRunId });
      return JSON.parse(response.text);
    }).toEqual({ runId: duringRunId, status: 'skipped', executions: 0 });
    await expect(alice!.getByText('Execution: idle', { exact: true })).toBeVisible();
    await expect(alice!.getByText('Agent owns this chat', { exact: true })).toBeVisible();
    await expect.poll(async () => (await receipts()).map(run => run.status).sort())
      .toEqual(['completed', 'skipped']);
    expect((await receipts()).map(run => run.executions).sort()).toEqual([0, 1]);
    await expect(alice!.getByText('Unclaimed', { exact: true })).toBeVisible();
    // A third identity must acquire after the previous owner releases.
    const next = await post(bob!, '/api/accounts/alpha/agent', { id });
    expect(next.status).toBe(202);
    const { runId: nextRunId } = JSON.parse(next.text);
    expect(runIds).not.toContain(nextRunId);
    try {
      await expect(alice!.getByText('Agent owns this chat', { exact: true })).toBeVisible();
    } catch (error) {
      const receipt = await post(bob!, '/api/accounts/alpha/agent-status', { runId: nextRunId });
      console.error('Ownership transfer diagnostic', JSON.stringify({
        runId: nextRunId, receipt: JSON.parse(receipt.text),
        view: await alice!.locator('section').innerText(), presenceEvents,
      }));
      throw error;
    }
    await expect.poll(async () => {
      const response = await post(bob!, '/api/accounts/alpha/agent-status', { runId: nextRunId });
      return JSON.parse(response.text);
    }).toEqual({ runId: nextRunId, status: 'completed', executions: 1 });
    await expect(alice!.getByText('Unclaimed', { exact: true })).toBeVisible();
    await contexts[0]!.setOffline(true);
    await expect(alice!.getByRole('status')).not.toHaveText('connected');
    // Bob commits new data while Alice cannot receive it. Prove actual
    // catch-up after reconnect, not just a transport label transition.
    await bob!.getByTestId(`conversation-${id}`).click();
    const updatedTitle = `Renamed while offline ${id}`;
    await bob!.getByLabel('Chat title').fill(updatedTitle);
    await bob!.getByRole('button', { name: 'Rename chat', exact: true }).click();
    await expect(bob!.getByRole('heading', { name: updatedTitle, exact: true })).toBeVisible();
    await expect(alice!.getByRole('heading', { name: updatedTitle, exact: true })).toHaveCount(0);
    await contexts[0]!.setOffline(false);
    await expect(alice!.getByRole('status')).toHaveText('connected', { timeout: 30_000 });
    await expect(alice!.getByRole('heading', { name: updatedTitle, exact: true })).toBeVisible();
    await bob!.getByRole('button', { name: 'Leave chat', exact: true }).click();
    // The closed tab's lease has been expiring while the agent/reconnect checks run.
    await expect(alice!.getByTestId('people')).toContainText('1 people', { timeout: 120_000 });
    await alice!.getByLabel('Account').selectOption('beta');
    await expect(alice!.getByRole('status')).toHaveText('connected');
    await expect(alice!.getByTestId(`conversation-${id}`)).toHaveCount(0);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
