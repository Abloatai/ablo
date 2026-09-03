/** File-upload behavior owned beneath the SyncClient boundary. */

import { AbloAuthenticationError } from '@abloatai/transaction/errors';
import type { RuntimeContext } from './RuntimeContext.js';
import { Model } from './Model.js';
import { InstanceCache, ModelScope } from './InstanceCache.js';
import type { MutationQueue } from './transactions/mutations/MutationQueue.js';

export interface FileUploadOptions {
  readonly id: string;
  readonly attachableType: string;
  readonly attachableId: string;
  readonly metadata?: Record<string, unknown>;
}

export interface BatchFileUploadOptions {
  readonly ids: string[];
  readonly attachableType: string;
  readonly attachableId: string;
  readonly metadata?: Record<string, unknown>;
}

export interface FileUploadContext {
  readonly userId: string | null;
  readonly organizationId: string | null;
  readonly mutationQueue: MutationQueue;
  readonly objectPool: InstanceCache;
  readonly observability: RuntimeContext['observability'];
  readonly notifyCreated: (model: Model) => void;
}

function authenticatedContext(context: FileUploadContext): {
  readonly userId: string;
  readonly organizationId: string;
} {
  if (!context.userId || !context.organizationId) {
    throw new AbloAuthenticationError('Authentication required for file uploads', {
      code: 'file_upload_auth_required',
    });
  }
  return { userId: context.userId, organizationId: context.organizationId };
}

function acceptUploadedModel(
  context: FileUploadContext,
  data: Record<string, unknown>,
): Model | null {
  const model = context.objectPool.createFromData(data);
  if (!model) return null;
  context.objectPool.add(model, ModelScope.live);
  context.notifyCreated(model);
  return model;
}

export async function uploadFile(
  context: FileUploadContext,
  file: File,
  options: FileUploadOptions,
): Promise<Model | null> {
  const identity = authenticatedContext(context);
  try {
    const result = await context.mutationQueue.uploadAttachment(file, {
      id: options.id,
      attachableType: options.attachableType,
      attachableId: options.attachableId,
      metadata: options.metadata,
    }, identity);
    return result
      ? acceptUploadedModel(context, { id: options.id, ...result })
      : null;
  } catch (error) {
    context.observability.captureMutationFailure({
      context: 'file-upload',
      error: error instanceof Error ? error : new Error(String(error)),
    });
    throw error;
  }
}

export async function batchUploadFiles(
  context: FileUploadContext,
  files: File[],
  options: BatchFileUploadOptions,
): Promise<Model[]> {
  const identity = authenticatedContext(context);
  const items = options.ids.map((id) => ({
    id,
    attachableType: options.attachableType,
    attachableId: options.attachableId,
    metadata: options.metadata,
  }));
  const results = await context.mutationQueue.batchUploadAttachments(files, items, identity);
  return results.flatMap((result) => {
    const model = acceptUploadedModel(context, { ...result });
    return model ? [model] : [];
  });
}
