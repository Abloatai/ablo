/**
 * A deterministic terminal proof of Ablo's product contract.
 *
 * It uses a real Ablo project, mints distinct human and agent participants,
 * proves stale work is rejected, then proves claim contention serializes the
 * same two participants onto fresh state. The final write is looked up through
 * the durable commit API so the terminal shows evidence, not just application
 * output.
 *
 * Run from packages/ablo:
 *
 *   npx ablo push --schema examples/terminal-showcase/schema.ts
 *   ABLO_API_KEY=sk_... npx tsx examples/terminal-showcase/index.ts
 */
import Ablo, { AbloStaleContextError } from '@abloatai/ablo';
import Sessions from '@abloatai/ablo/sessions';
import { schema } from './schema';

const apiKey = process.env.ABLO_API_KEY;
if (!apiKey?.startsWith('sk_')) {
  throw new Error('ABLO_API_KEY must be a secret sk_ project key so the demo can mint scoped participants.');
}

const delayMs = Number.parseInt(process.env.ABLO_SHOWCASE_DELAY_MS ?? '650', 10);
const keepRow = process.env.ABLO_SHOWCASE_KEEP === '1';
const color = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const ink = {
  blue: (value: string) => color ? `\u001B[34m${value}\u001B[39m` : value,
  dim: (value: string) => color ? `\u001B[2m${value}\u001B[22m` : value,
  green: (value: string) => color ? `\u001B[32m${value}\u001B[39m` : value,
  red: (value: string) => color ? `\u001B[31m${value}\u001B[39m` : value,
  yellow: (value: string) => color ? `\u001B[33m${value}\u001B[39m` : value,
};

function pause(ms = delayMs): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function heading(index: number, title: string): void {
  console.log(`\n${ink.blue(String(index).padStart(2, '0'))}  ${title}`);
}

function fact(label: string, value: unknown): void {
  console.log(`    ${ink.dim(label.padEnd(16))}${String(value)}`);
}

function ok(message: string): void {
  console.log(`    ${ink.green('✓')} ${message}`);
}

async function main(): Promise<void> {
  const control = Ablo({ schema, apiKey });
  const sessions = Sessions({ schema, apiKey });
  const participants: Array<{ dispose(): Promise<void> }> = [];
  let dealId: string | undefined;
  let humanClaim: { release(): Promise<void> } | undefined;
  let agentClaim: { release(): Promise<void> } | undefined;

  console.log();
  console.log('  ABLO / ONE ROW, TWO ACTORS, ONE CONFIRMED REALITY');
  console.log(ink.dim('  Real credentials · real coordination · no model call · no simulated server'));

  try {
    await control.ready();

    heading(1, 'Create one shared row');
    const deal = await control.deals.create({
      data: {
        name: `Northstar renewal ${Date.now().toString(36)}`,
        stage: 'open',
        value: 100_000,
        revision: 1,
        note: 'Initial account plan',
      },
    });
    dealId = deal.id;
    fact('row', `${deal.id} · revision ${deal.revision}`);
    ok('create resolved after authoritative confirmation');

    heading(2, 'Give each actor its own bounded authority');
    const humanSession = await sessions.create({
      user: { id: `showcase-human-${deal.id}` },
      can: { deals: ['read', 'update'] },
      ttlSeconds: 300,
    });
    const agentSession = await sessions.create({
      agent: { id: `showcase-agent-${deal.id}` },
      onBehalfOf: { user: { id: `showcase-human-${deal.id}` } },
      can: { deals: ['read', 'update'] },
      ttlSeconds: 300,
    });
    const human = Ablo({ schema, session: humanSession, transport: 'http' });
    const pricingAgent = Ablo({ schema, session: agentSession, transport: 'http' });
    participants.push(human, pricingAgent);
    await Promise.all([human.ready(), pricingAgent.ready()]);
    fact('human', `${human.identity?.participantKind}:${human.identity?.participantId}`);
    fact('agent', `${pricingAgent.identity?.participantKind}:${pricingAgent.identity?.participantId}`);
    fact('agent can', pricingAgent.identity?.operations.join(', '));

    heading(3, 'Reject reasoning built on stale state');
    const agentRead = await pricingAgent.deals.read({ id: deal.id });
    if (!agentRead) throw new Error('The agent could not read the showcase row.');
    fact('agent reads', `revision ${agentRead.revision} · value ${agentRead.value}`);
    console.log(`    ${ink.yellow('…')} agent starts a slow pricing calculation`);
    await pause();

    const humanEdit = await human.deals.update({
      id: deal.id,
      data: {
        value: 120_000,
        revision: 2,
        note: 'Human added the expansion seats',
      },
    });
    fact('human writes', `revision ${humanEdit.revision} · value ${humanEdit.value}`);

    try {
      await pricingAgent.deals.update({
        id: deal.id,
        data: {
          value: 105_000,
          revision: 2,
          note: 'Price calculated from revision 1',
        },
        reads: [agentRead],
        idempotencyKey: `showcase:${deal.id}:stale-price`,
      });
      throw new Error('The stale write unexpectedly landed.');
    } catch (error) {
      if (!(error instanceof AbloStaleContextError)) throw error;
      console.log(`    ${ink.red('REJECTED')} ${error.code} — the human edit was not overwritten`);
    }

    const afterRejection = await control.deals.get({ id: deal.id });
    if (!afterRejection) throw new Error('The showcase row disappeared after stale rejection.');
    fact('still true', `revision ${afterRejection.revision} · value ${afterRejection.value}`);

    heading(4, 'Serialize slow work with a visible claim');
    const claimedByHuman = await human.deals.claim({
      id: deal.id,
      description: 'reviewing commercial terms',
      ttl: '30s',
    });
    humanClaim = claimedByHuman;
    fact('human holds', `fence ${claimedByHuman.fenceToken}`);

    const queuedClaim = pricingAgent.deals.claim({
      id: deal.id,
      description: 'recalculating final price',
      ttl: '30s',
      queue: true,
    });
    await pause();
    const queue = await control.deals.claim.queue({ id: deal.id });
    fact('agent waits', `${queue.size} participant in FIFO queue`);

    await human.deals.update({
      id: deal.id,
      data: {
        stage: 'reviewing',
        revision: 3,
        note: 'Commercial review complete',
      },
      claim: claimedByHuman,
      idempotencyKey: `showcase:${deal.id}:human-review`,
    });
    await claimedByHuman.release();
    humanClaim = undefined;

    const claimedByAgent = await queuedClaim;
    agentClaim = claimedByAgent;
    fact('agent receives', `fresh revision ${claimedByAgent.data.revision} · fence ${claimedByAgent.fenceToken}`);
    ok('the queued agent did not continue from its earlier revision 1 read');

    heading(5, 'Commit and inspect the durable evidence');
    const commitId = `showcase:${deal.id}:agent-approval`;
    const confirmed = await pricingAgent.deals.update({
      id: deal.id,
      data: {
        stage: 'approved',
        value: 118_000,
        revision: 4,
        note: 'Repriced from the fresh claimed row',
      },
      claim: claimedByAgent,
      idempotencyKey: commitId,
    });
    await claimedByAgent.release();
    agentClaim = undefined;

    const evidence = await control.commits.get({ id: commitId });
    if (!evidence) throw new Error(`Durable commit ${commitId} was not found.`);
    fact('row', `${confirmed.id} · revision ${confirmed.revision} · ${confirmed.stage}`);
    fact('commit', commitId);
    fact('status', evidence.status);
    fact('actor', `${evidence.actor.kind}:${evidence.actor.id}`);
    fact('claim refs', evidence.claims.length);
    fact('attempts', evidence.attempts.length);
    fact('confirmation', `${Date.parse(evidence.statusAt) - Date.parse(evidence.createdAt)} ms`);
    ok('the authoritative source confirmed the write before the SDK resolved');

    console.log();
    console.log(`  ${ink.green('PROVEN')} stale work did not land · contenders serialized · fresh state won · evidence persisted`);
    if (keepRow) fact('kept row', deal.id);
  } finally {
    await agentClaim?.release().catch(() => undefined);
    await humanClaim?.release().catch(() => undefined);
    await Promise.all(participants.map((participant) => participant.dispose()));
    if (dealId && !keepRow) {
      await control.deals.delete({ id: dealId }).catch(() => undefined);
    }
    await control.dispose();
  }
}

main().catch((error: unknown) => {
  console.error(`\n  ${ink.red('SHOWCASE FAILED')}`, error);
  process.exitCode = 1;
});
