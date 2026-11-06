'use client';

import posthog from 'posthog-js';
import { sanitizePostHogProperties } from './posthog';
import {
  buildBrowserErrorObservation,
  type ErrorContext,
} from './observation';
import {
  SENSITIVE_KEYS,
  maskSensitiveFields as sharedMaskSensitiveFields,
} from './sanitization';

export type { ErrorContext } from './observation';
export { buildBrowserErrorObservation } from './observation';

/**
 * An Error that carries its own {@link ErrorContext}. The code that throws it
 * has the domain context (ids, feature, fingerprint) that a generic error
 * boundary lacks. Rather than the throw site calling `captureError` itself —
 * which would double-report once the boundary also captures — it attaches the
 * context here, and the boundary merges it into its single capture via
 * {@link getReportContext}.
 */
export interface ReportableError {
  readonly reportContext: ErrorContext;
}

/**
 * Read the {@link ErrorContext} an error carries, if any. Error boundaries pass
 * the result into `captureError` so a thrown {@link ReportableError} is reported
 * exactly once, with the throw site's tags and fingerprint intact.
 */
export function getReportContext(error: unknown): ErrorContext | undefined {
  if (!(error instanceof Error) || !('reportContext' in error)) return undefined;
  const ctx: unknown = (error as { reportContext?: unknown }).reportContext;
  return ctx && typeof ctx === 'object' ? (ctx as ErrorContext) : undefined;
}

export class ErrorReporter {
  static captureError(error: Error, context?: ErrorContext) {
    try {
      const observation = buildBrowserErrorObservation(error, context);
      if (!posthog.__loaded) return undefined;
      const safe = new Error(observation.internalMessage ?? observation.publicMessage);
      safe.name = observation.errorType;
      // The SDK matches chunk IDs against original URLs; before_send scrubs parsed frames before export.
      if (error.stack) safe.stack = error.stack.slice(0, 20_000);
      posthog.captureException(safe, sanitizePostHogProperties({
        ...observation, environment: observation.stage, $exception_level: observation.severity,
        $exception_fingerprint: (context?.fingerprint ?? [observation.service, observation.scope, observation.errorCode]).join(':'),
      }));
      return observation.eventId;
    } catch {
      // Reporting must never replace a render or interaction failure.
      return undefined;
    }
  }

  static captureMessage(
    message: string,
    level: 'info' | 'warning' | 'error' = 'info',
    context?: ErrorContext
  ) {
    return posthog.capture('application_message', sanitizePostHogProperties({
      message, level, page: context?.page, feature: context?.feature, action: context?.action,
      metadata: context?.metadata ? this.sanitizeMetadata(context.metadata) : undefined,
    }));
  }

  static setUserContext(userId: string, _email?: string) { posthog.identify(userId); }
  static clearUserContext() { posthog.reset(); }
  static addBreadcrumb(message: string, category: string, level = 'info', data?: Record<string, unknown>) {
    posthog.capture('application_breadcrumb', sanitizePostHogProperties({ message, category, level, data }));
  }

  // Delegate to the shared sanitization module (single source of truth)
  private static sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    return sharedMaskSensitiveFields(metadata, SENSITIVE_KEYS);
  }


}

// Hook for React error handling
export const useErrorReporter = () => {
  const reportError = (error: Error, context?: ErrorContext) => {
    ErrorReporter.captureError(error, context);
  };

  const reportMessage = (
    message: string,
    level: 'info' | 'warning' | 'error' = 'info',
    context?: ErrorContext
  ) => {
    ErrorReporter.captureMessage(message, level, context);
  };

  const addBreadcrumb = (
    message: string,
    category: string,
    level: 'info' | 'warning' | 'error' = 'info',
    data?: Record<string, unknown>
  ) => {
    ErrorReporter.addBreadcrumb(message, category, level, data);
  };

  return {
    reportError,
    reportMessage,
    addBreadcrumb,
  };
};


/**
 * Determine if an error is a technical/internal error that should not be shown to users.
 * Returns a user-friendly message if it's a technical error, or null if it should be shown as-is.
 */
export function getAIUserFriendlyError(errorMessage: string): string | null {
  // Technical errors from the sandbox/executor
  const technicalPatterns = [
    /^Invalid \w+ params:/i,
    /invalid.*input/i,
    /execution.*failed/i,
    /sandbox.*error/i,
    /api.*error:\s*\d+/i,
    /unexpected.*token/i,
    /syntax.*error/i,
    /cannot.*read.*property/i,
    /is not a function/i,
    /undefined is not/i,
    /null is not/i,
  ];

  for (const pattern of technicalPatterns) {
    if (pattern.test(errorMessage)) {
      return "Something went wrong. I'll try a different approach.";
    }
  }

  // If the error message is very long or looks like a stack trace, hide it
  if (errorMessage.length > 200 || errorMessage.includes('\n') || errorMessage.includes('at ')) {
    return "Something went wrong. I'll try a different approach.";
  }

  return null; // Show the original error
}
