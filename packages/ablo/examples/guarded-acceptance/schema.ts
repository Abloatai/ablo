import { defineSchema, model, z } from '@abloatai/ablo/schema';

const id = z.string().min(1).max(128);
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const revision = z.string().min(1).max(128);

export const candidateSchema = z.strictObject({
  id: z.uuid(),
  taskId: id,
  repositoryId: id,
  runId: id,
  generation: z.number().int().nonnegative(),
  taskRevision: revision,
  policyRevision: revision,
  baseSha: sha,
  candidateSha: sha,
  verificationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  premises: z.array(z.strictObject({ id, revision })).max(64),
}).refine((candidate) => new Set(candidate.premises.map((premise) => premise.id)).size === candidate.premises.length,
  'Premise IDs must be unique');

export type Candidate = z.infer<typeof candidateSchema>;

const subject = { field: 'accountId', group: 'account' } as const;

export const schema = defineSchema({
  acceptanceTasks: model({
    accountId: id,
    repositoryId: id,
    ownerId: id,
    generation: z.number().int().nonnegative(),
    revoked: z.boolean(),
    revision,
    policyRevision: revision,
    pendingProposalId: z.string().nullable(),
    acceptedSha: sha,
  }, { subject }),
  acceptancePremises: model({ accountId: id, revision }, { subject }),
  acceptanceProposals: model({
    accountId: id,
    repositoryId: id,
    taskId: id,
    workerId: id,
    payload: z.string(),
    digest: z.string(),
    status: z.enum(['prepared', 'acknowledged', 'rejected']),
    outcome: z.string().nullable(),
  }, { subject }),
});

export const outcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied'), proposalId: z.uuid(), digest: z.string(),
    repositoryId: id, baseSha: sha, acceptedSha: sha, receiptId: id }),
  z.strictObject({ status: z.literal('rejected'), proposalId: z.uuid(), digest: z.string(),
    repositoryId: id, baseSha: sha, reason: z.enum(['base_changed', 'verification_failed']) }),
]);
export type ApplicationOutcome = z.infer<typeof outcomeSchema>;
