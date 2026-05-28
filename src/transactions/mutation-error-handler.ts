import { getContext } from "../context.js";


/**
 * Shared error handler for mutation execution.
 * Logs to SyncObservability (unless offline + network error), then re-throws.
 */
export function handleMutationError(
  error: unknown,
  context: string,
  schemaName: string,
  modelId: string
): never {
  const errorInfo: Record<string, unknown> = { schemaName, modelId, rawError: error };

  if (error instanceof Error) {
    errorInfo.message = error.message;
    errorInfo.name = error.name;
    errorInfo.stack =
      typeof error.stack === 'string' ? error.stack.split('\n').slice(0, 5) : undefined;
  } else if (error && typeof error === 'object') {
    errorInfo.message =
      (error as Record<string, unknown>).message ??
      (error as Record<string, unknown>).error ??
      'Unknown error';
    errorInfo.code = (error as Record<string, unknown>).code;
    errorInfo.extensions = (error as Record<string, unknown>).extensions;
  } else {
    errorInfo.message = String(error);
  }

  const isOffline = !getContext().onlineStatus.isOnline();
  const msg = errorInfo.message as string | undefined;
  const isNetworkError =
    msg?.includes('Failed to fetch') ||
    msg?.includes('Network request failed') ||
    msg?.includes('NetworkError');

  if (!isOffline || !isNetworkError) {
    getContext().observability.captureTransactionFailure({
      context,
      error: error instanceof Error ? error : String(errorInfo.message ?? error),
      modelName: schemaName,
      modelId,
    });
  }

  throw error;
}
