/**
 * Canonical stale-context turn: abort early, retain the authoritative write
 * guard, rebuild context on a bounded retry, and never blindly replay an
 * irreversible tool side effect.
 *
 * The application-owned model and notification functions below are small,
 * deterministic stand-ins. Keep their cancellation/idempotency contracts when
 * replacing them with real providers.
 *
 * Run: ABLO_API_KEY=sk_... RECORD_ID=record_... npx tsx examples/stale-context-agent-turn.ts
 */
import { Ablo, AbloStaleContextError } from '@abloatai/ablo';
import { context } from '@abloatai/ablo/context';
import { defineSchema, model, z } from '@abloatai/ablo/schema';

const schema = defineSchema({
  records: model({
    title: z.string(),
    status: z.enum(['pending', 'done']),
    result: z.string().optional(),
  }),
});

const delivered = new Set<string>();

async function callModel(title: string, signal: AbortSignal): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 25);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
  return `Completed: ${title}`;
}

async function sendResult(operationKey: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  // Replace with a provider call that accepts operationKey as its idempotency key.
  delivered.add(operationKey);
}

async function wasResultSent(operationKey: string): Promise<boolean> {
  // Replace with the provider's outcome lookup using the same key.
  return delivered.has(operationKey);
}

const recordId = process.env.RECORD_ID;
if (!recordId) throw new Error('RECORD_ID is required');

const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });

async function completeRecord(id: string): Promise<void> {
  const operationKey = `complete-record:${id}`;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const ctx = await context({
      ablo,
      data: { record: ablo.records.read({ id }) },
    });
    if (!ctx.data.record) throw new Error(`Record ${id} was not found`);

    const controller = new AbortController();
    const stop = ctx.onChange((error) => controller.abort(error));
    let resultMayHaveBeenSent = false;

    try {
      const result = await callModel(ctx.data.record.title, controller.signal);
      resultMayHaveBeenSent = true;
      await sendResult(operationKey, controller.signal);

      await ablo.records.update({
        id: ctx.data.record.id,
        data: { status: 'done', result },
        reads: ctx.reads,
        idempotencyKey: operationKey,
      });
      console.log({ attempt, operationKey, status: 'done' });
      return;
    } catch (error) {
      const stale = error instanceof AbloStaleContextError ||
        controller.signal.reason instanceof AbloStaleContextError;
      if (!stale) throw error;

      if (resultMayHaveBeenSent) {
        const sent = await wasResultSent(operationKey);
        throw new Error(
          `Context changed after the external action (sent=${sent}). ` +
          `Reconcile operation ${operationKey}; do not replay it automatically.`,
        );
      }
      if (attempt === maxAttempts) throw error;
      // The next iteration assembles new data and new read evidence.
    } finally {
      stop();
    }
  }
}

try {
  await ablo.ready();
  await completeRecord(recordId);
} finally {
  await ablo.dispose();
}
