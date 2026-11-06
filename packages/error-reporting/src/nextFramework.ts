import { ErrorReporter } from './reporter';
import type { ErrorContext } from './observation';

/** Client global-boundary adapter; never load a server SDK into the browser. */
export function captureGlobalError(error: Error, context: ErrorContext = {}): string | undefined {
  return ErrorReporter.captureError(error, { feature: 'react.global_error', action: 'render', handled: false, ...context });
}
