/**
 * Canonical cheap turn: explicitly attach the exact rows used to decide the
 * write. Ablo keeps their watermarks opaque and checks them at commit time.
 *
 * Run: ABLO_API_KEY=sk_... TASK_ID=task_... npx tsx examples/agent-turn.ts
 */
import { Ablo } from '@abloatai/ablo';
import { defineSchema, model, z } from '@abloatai/ablo/schema';

const schema = defineSchema({
  tasks: model({
    title: z.string(),
    status: z.enum(['pending', 'done']),
    result: z.string().optional(),
  }),
});

const taskId = process.env.TASK_ID;
if (!taskId) throw new Error('TASK_ID is required');

const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });
try {
  await ablo.ready();
  const task = await ablo.tasks.get({ id: taskId });
  if (!task) throw new Error(`Task ${taskId} was not found`);
  const commitId = `task:${taskId}:cheap`;
  await ablo.tasks.update({
    id: task.id,
    data: { status: 'done', result: `Completed: ${task.title}` },
    reads: [task],
    idempotencyKey: commitId,
  });
  const record = await ablo.commits.get({ id: commitId });
  console.log({ identity: ablo.identity, commit: record });
} finally {
  await ablo.dispose();
}
