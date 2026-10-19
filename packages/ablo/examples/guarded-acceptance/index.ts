/** Copy this server-owned operation together with its schema and rejection module. */
import { createHash } from 'node:crypto';
import type { AbloHttpClient } from '@abloatai/ablo';
import { candidateSchema, outcomeSchema, schema, type Candidate, type ApplicationOutcome } from './schema.js';
import { AcceptanceRejection, result } from './rejection.js';
export { schema, type Candidate, type ApplicationOutcome } from './schema.js';
export type { Result, Rejection } from './rejection.js';

type Client = AbloHttpClient<typeof schema.models>;
type Proposal = NonNullable<Awaited<ReturnType<Client['acceptanceProposals']['read']>>>;
type Task = NonNullable<Awaited<ReturnType<Client['acceptanceTasks']['read']>>>;
type Premise = NonNullable<Awaited<ReturnType<Client['acceptancePremises']['read']>>>;
export type PreparedCandidate = Candidate & { accountId: string; workerId: string; digest: string };

export interface GitBroker {
  /** Return null only for authoritative absence; throw on an unknown outcome. */
  lookup(candidate: PreparedCandidate): Promise<ApplicationOutcome | null>;
  /** Atomically persist an applied receipt or terminal rejection, deduplicated by proposal ID. */
  apply(candidate: PreparedCandidate): Promise<ApplicationOutcome>;
}

export function createAcceptance(options: {
  client: Client;
  /** Derived from authenticated server context, never from candidate input. */
  accountId: string;
  verify(input: { candidate: Candidate; workerId: string; task: Task; premises: Premise[] }): Promise<boolean>;
  broker: GitBroker;
}) {
  const { client, accountId, verify, broker } = options;

  function scoped<T extends { accountId: string }>(row: T | null | undefined): T {
    if (!row || row.accountId !== accountId) throw new AcceptanceRejection('unavailable', 'stop');
    return row;
  }

  async function readProposal(id: string) {
    return scoped(await client.acceptanceProposals.read({ id }));
  }

  function prepared(row: Proposal): PreparedCandidate {
    const candidate = candidateSchema.parse(JSON.parse(row.payload));
    const digest = createHash('sha256').update(JSON.stringify([accountId, row.workerId, row.payload])).digest('hex');
    if (digest !== row.digest || candidate.id !== row.id || candidate.taskId !== row.taskId || candidate.repositoryId !== row.repositoryId) {
      throw new AcceptanceRejection('proposal_conflict', 'stop');
    }
    return { ...candidate, accountId, workerId: row.workerId, digest: row.digest };
  }

  function summary(row: Proposal) {
    return { proposalId: row.id, status: row.status,
      outcome: row.outcome ? outcomeSchema.parse(JSON.parse(row.outcome)) : null };
  }

  async function existing(id: string, payload: string, workerId: string) {
    const row = await client.acceptanceProposals.read({ id });
    if (!row) return null;
    scoped(row);
    if (row.payload !== payload || row.workerId !== workerId) {
      throw new AcceptanceRejection('proposal_conflict', 'stop');
    }
    return summary(row);
  }

  return {
    prepare(input: { candidate: unknown; workerId: string }) {
      return result(async () => {
        const parsed = candidateSchema.safeParse(input.candidate);
        if (!parsed.success || !input.workerId || input.workerId.length > 128) {
          throw new AcceptanceRejection('invalid_proposal', 'stop');
        }
        const candidate = parsed.data;
        candidate.premises.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        const payload = JSON.stringify(candidate);
        const previous = await existing(candidate.id, payload, input.workerId);
        if (previous) return previous;

        const task = scoped(await client.acceptanceTasks.read({ id: candidate.taskId }));
        if (task.repositoryId !== candidate.repositoryId) throw new AcceptanceRejection('unavailable', 'stop');
        if (task.revoked) throw new AcceptanceRejection('access_revoked', 'stop');
        if (task.ownerId !== input.workerId || task.generation !== candidate.generation) {
          throw new AcceptanceRejection('ownership_changed', 'replan');
        }
        if (task.pendingProposalId) throw new AcceptanceRejection('acceptance_pending', 'reconcile', task.pendingProposalId);
        if (task.revision !== candidate.taskRevision || task.policyRevision !== candidate.policyRevision ||
            task.acceptedSha !== candidate.baseSha) throw new AcceptanceRejection('premise_changed', 'replan');
        const premises = await Promise.all(candidate.premises.map(async (expected) => {
          const row = scoped(await client.acceptancePremises.read({ id: expected.id }));
          if (row.revision !== expected.revision) throw new AcceptanceRejection('premise_changed', 'replan');
          return row;
        }));
        if (!await verify(structuredClone({ candidate, workerId: input.workerId, task, premises }))) {
          throw new AcceptanceRejection('verification_failed', 'stop');
        }
        const digest = createHash('sha256').update(JSON.stringify([accountId, input.workerId, payload])).digest('hex');
        try {
          await client.commits.create({
            operations: [
              { action: 'create', model: 'acceptanceProposals', id: candidate.id,
                data: { accountId, repositoryId: candidate.repositoryId, taskId: task.id,
                  workerId: input.workerId, payload, digest, status: 'prepared', outcome: null } },
              { action: 'update', model: 'acceptanceTasks', id: task.id, data: { pendingProposalId: candidate.id } },
            ],
            reads: [task, ...premises], idempotencyKey: `acceptance:prepare:${candidate.id}`, wait: 'confirmed',
          });
        } catch (error) {
          // An identical concurrent request or lost response may already have prepared it.
          const recovered = await existing(candidate.id, payload, input.workerId);
          if (recovered) return recovered;
          throw error;
        }
        return summary(await readProposal(candidate.id));
      });
    },

    reconcile(input: { proposalId: string }) {
      return result(async () => {
        const proposal = await readProposal(input.proposalId);
        if (proposal.status !== 'prepared') return summary(proposal);
        const candidate = prepared(proposal);
        const task = scoped(await client.acceptanceTasks.read({ id: proposal.taskId }));
        if (task.pendingProposalId !== proposal.id || task.repositoryId !== proposal.repositoryId) {
          throw new AcceptanceRejection('proposal_conflict', 'stop');
        }
        const applied = await broker.lookup(structuredClone(candidate)) ?? await broker.apply(structuredClone(candidate));
        const parsed = outcomeSchema.safeParse(applied);
        if (!parsed.success) throw new AcceptanceRejection('receipt_conflict', 'stop');
        const outcome = parsed.data;
        if (outcome.proposalId !== proposal.id || outcome.digest !== proposal.digest ||
            outcome.repositoryId !== candidate.repositoryId || outcome.baseSha !== candidate.baseSha ||
            (outcome.status === 'applied' && outcome.acceptedSha !== candidate.candidateSha)) {
          throw new AcceptanceRejection('receipt_conflict', 'stop');
        }
        const status = outcome.status === 'applied' ? 'acknowledged' : 'rejected';
        try {
          await client.commits.create({
            operations: [
              { action: 'update', model: 'acceptanceProposals', id: proposal.id,
                data: { status, outcome: JSON.stringify(outcome) } },
              { action: 'update', model: 'acceptanceTasks', id: task.id,
                data: { pendingProposalId: null, ...(outcome.status === 'applied' ? { acceptedSha: outcome.acceptedSha } : {}) } },
            ],
            reads: [proposal, task], idempotencyKey: `acceptance:ack:${proposal.id}`, wait: 'confirmed',
          });
        } catch (error) {
          const current = await readProposal(proposal.id);
          if (current.status === status && current.outcome === JSON.stringify(outcome)) return summary(current);
          throw error;
        }
        return summary(await readProposal(proposal.id));
      });
    },

    /** One bounded page. Persist its cursor; periodically restart scanning from the beginning. */
    pending(input: { repositoryId: string; cursor?: string; limit?: number }) {
      return result(async () => {
        const limit = input.limit ?? 100;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AcceptanceRejection('invalid_limit', 'stop');
        const page = await client.acceptanceProposals.list({
          where: { accountId, repositoryId: input.repositoryId, status: 'prepared' },
          orderBy: { id: 'asc' }, limit, ...(input.cursor ? { cursor: input.cursor } : {}),
        });
        return { proposalIds: page.map((row) => scoped(row).id), nextCursor: page.nextCursor ?? null };
      });
    },
  };
}
