/**
 * withRetry — tool middleware that adds timeout + exponential-backoff retry.
 *
 * Wraps a Tool's execute to make it resilient to flaky dependencies.
 * Ported from agent-worker's `tool-executor.ts` logic into the AI SDK
 * middleware pattern — apply per-tool instead of wrapping every call site.
 *
 * ```ts
 * const resilient = withRetry(myTool(), { timeoutMs: 30_000, maxRetries: 3 });
 * ```
 */

/**
 * Minimal structural shape the middleware reads. Real AI SDK `Tool` values
 * satisfy this at runtime. Using a structural type here (instead of
 * importing `Tool` from `ai`) avoids triggering expensive generic
 * instantiation on AI SDK's heavy Tool type — which was causing tsc OOM.
 */
interface RetryTarget {
  execute?: (...args: unknown[]) => Promise<unknown>;
  [key: string]: unknown;
}

export class ToolTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    super(`Tool '${toolName}' timed out after ${timeoutMs}ms`);
    this.name = 'ToolTimeoutError';
  }
}

export interface WithRetryOptions {
  /** Max ms one attempt is allowed. Defaults to 30_000. */
  timeoutMs?: number;
  /** Max retry attempts after the initial try. Defaults to 2 (total 3 tries). */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms. Defaults to 1000. */
  baseDelayMs?: number;
  /** Name used in timeout errors. Defaults to 'tool'. */
  toolName?: string;
}

/**
 * Wrap a tool's execute with timeout + retry. Timeouts are NOT retried
 * (they'd just timeout again). Infrastructure errors (network, 5xx) retry
 * with exponential backoff.
 */
export function withRetry<T extends RetryTarget>(
  tool: T,
  options: WithRetryOptions = {},
): T {
  const originalExecute = tool.execute;
  if (!originalExecute) return tool;

  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRetries = options.maxRetries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const toolName = options.toolName ?? 'tool';

  const wrapped = async (...args: unknown[]): Promise<unknown> => {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await executeWithTimeout(
          () => originalExecute(...args),
          toolName,
          timeoutMs,
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === maxRetries) break;
        // Don't retry timeouts — they'll just timeout again
        if (error instanceof ToolTimeoutError) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, baseDelayMs * Math.pow(2, attempt)),
        );
      }
    }
    throw lastError;
  };

  return { ...tool, execute: wrapped } as T;
}

// ── Internal ──────────────────────────────────────────────────────────────

async function executeWithTimeout<T>(
  fn: () => Promise<T>,
  toolName: string,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new ToolTimeoutError(toolName, timeoutMs));
        });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
