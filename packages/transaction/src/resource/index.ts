import { z } from 'zod';
export { RESOURCE_CLAIM_MODEL } from './claimTarget.js';

const readSchema = z.object({ resource: z.string(), content: z.string().nullable(), revision: z.number().int().nonnegative(), evidence: z.string() });
const evidenceSchema = readSchema.omit({ content: true });
const claimSchema = z.object({ resource: z.string(), claim: z.string(), fence: z.number().int().positive(), expires: z.number().positive() });
const receiptSchema = z.object({
  operationId: z.string().uuid(), status: z.enum(['running', 'absent', 'applied', 'rejected', 'aborted']),
  code: z.string().optional(), resources: z.array(z.string()).optional(),
  exitCode: z.number().int().optional(), output: z.string().optional(),
  reads: z.array(evidenceSchema).optional(),
});

export type ResourceEvidence = z.infer<typeof evidenceSchema>;
export type ResourceRead = z.infer<typeof readSchema>;
export type ResourceReceipt = z.infer<typeof receiptSchema>;
export type ResourceTarget = string | { readonly kind: 'file' | 'ref'; readonly name: string };

/** A transport bound to one authenticated worker in one protected workspace. */
export interface ResourceWorkspace {
  request(request: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export class ResourceError extends Error {
  constructor(readonly code: string, readonly resources: readonly string[] = [], readonly operationId?: string) {
    super(code === 'outcome_unknown' && operationId
      ? `Operation ${operationId} may have completed; check its receipt before retrying`
      : `${code}${resources.length ? `: ${resources.join(', ')}` : ''}`);
    this.name = 'ResourceError';
  }
}

export interface ResourceClaim extends AsyncDisposable {
  readonly object: 'claim';
  readonly resource: string;
  readonly id: string;
  readonly fenceToken: number;
  readonly expiresAt: number;
  heartbeat(ttl?: string): Promise<{ readonly expiresAt: number }>;
  release(): Promise<void>;
}

export interface NativeResourceOperation {
  readonly claims: readonly ResourceClaim[];
  readonly reads?: readonly (ResourceRead | ResourceEvidence)[];
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly operationId?: string;
}

async function mutation(workspace: ResourceWorkspace, input: Readonly<Record<string, unknown>>): Promise<ResourceReceipt> {
  const operationId = typeof input.operationId === 'string' ? input.operationId : crypto.randomUUID();
  let result: unknown;
  try {
    result = await workspace.request({ ...input, operationId });
  } catch (error) {
    if (error instanceof ResourceError) throw error;
    throw new ResourceError('outcome_unknown', [], operationId);
  }
  const parsed = receiptSchema.safeParse(result);
  if (!parsed.success || parsed.data.operationId !== operationId || parsed.data.status === 'absent') {
    throw new ResourceError('outcome_unknown', [], operationId);
  }
  const receipt = parsed.data;
  if (receipt.status === 'rejected' || receipt.status === 'aborted') {
    throw new ResourceError(receipt.code ?? 'operation_failed', receipt.resources, operationId);
  }
  return receipt;
}

function claimsOnWire(claims: readonly ResourceClaim[]) {
  return claims.map(({ resource, id }) => ({ resource, claim: id }));
}

function readsOnWire(reads: readonly (ResourceRead | ResourceEvidence)[] = []) {
  return reads.map(({ resource, evidence }) => ({ resource, evidence }));
}

/** Execute unchanged native tools inside the adapter's authenticated operation context. */
export function runResourceOperation(workspace: ResourceWorkspace, operation: NativeResourceOperation): Promise<ResourceReceipt> {
  return mutation(workspace, { action: 'run', ...operation, reads: readsOnWire(operation.reads), claims: claimsOnWire(operation.claims) });
}

export async function getResourceReceipt(workspace: ResourceWorkspace, operationId: string): Promise<ResourceReceipt> {
  const receipt = receiptSchema.safeParse(await workspace.request({ action: 'receipt', operationId }));
  if (!receipt.success || receipt.data.operationId !== operationId) throw new ResourceError('outcome_unknown', [], operationId);
  return receipt.data;
}

export async function getResourceChanges(workspace: ResourceWorkspace, options: { readonly after?: number; readonly reads?: readonly (ResourceRead | ResourceEvidence)[] } = {}) {
  return z.object({
    events: z.array(z.object({ sequence: z.number().int(), path: z.string(), revision: z.number().int(), operation: z.string() })),
    cursor: z.number().int(), stale: z.array(z.object({ resource: z.string(), action: z.literal('reread') })),
  }).parse(await workspace.request({ action: 'changes', ...options, reads: readsOnWire(options.reads) }));
}

export function createResource(workspace: ResourceWorkspace, target: ResourceTarget) {
  const kind = typeof target === 'string' ? 'file' : target.kind;
  const name = typeof target === 'string' ? target : target.name;
  if (!name || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..') || name.includes('\0')) {
    throw new ResourceError('invalid_resource');
  }
  const resource = `${kind}:${name}`;
  return {
    resource,
    async claim(options: { readonly ttl?: string; readonly waitMs?: number } = {}): Promise<ResourceClaim> {
      const held = claimSchema.parse(await workspace.request({ action: 'claim', resource, ...options }));
      return {
        object: 'claim', resource: held.resource, id: held.claim, fenceToken: held.fence,
        get expiresAt() { return held.expires * 1000; },
        async heartbeat(ttl) {
          const beat = z.object({ expires: z.number().positive() }).parse(await workspace.request({ action: 'heartbeat', resource, claim: held.claim, ...(ttl ? { ttl } : {}) }));
          held.expires = beat.expires;
          return { expiresAt: held.expires * 1000 };
        },
        async release() {
          await workspace.request({ action: 'release', resource, claim: held.claim });
        },
        async [Symbol.asyncDispose]() { await workspace.request({ action: 'release', resource, claim: held.claim }); },
      };
    },
    async read(): Promise<ResourceRead> {
      return readSchema.parse(await workspace.request({ action: 'read', resource }));
    },
    write(options: { readonly claim: ResourceClaim; readonly reads: readonly (ResourceRead | ResourceEvidence)[]; readonly content: string; readonly operationId?: string }) {
      return mutation(workspace, { action: 'write', resource, reads: readsOnWire(options.reads), content: options.content,
        claims: claimsOnWire([options.claim]), ...(options.operationId ? { operationId: options.operationId } : {}) });
    },
    delete(options: { readonly claim: ResourceClaim; readonly reads: readonly (ResourceRead | ResourceEvidence)[]; readonly operationId?: string }) {
      return mutation(workspace, { action: 'delete', resource, reads: readsOnWire(options.reads),
        claims: claimsOnWire([options.claim]), ...(options.operationId ? { operationId: options.operationId } : {}) });
    },
    rename(destination: string, options: { readonly claims: readonly ResourceClaim[]; readonly reads: readonly (ResourceRead | ResourceEvidence)[]; readonly operationId?: string }) {
      return mutation(workspace, { action: 'rename', resource, destination: createResource(workspace, destination).resource,
        reads: readsOnWire(options.reads), claims: claimsOnWire(options.claims), ...(options.operationId ? { operationId: options.operationId } : {}) });
    },
  };
}

export type Resource = ReturnType<typeof createResource>;
