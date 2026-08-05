import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/node';
import { errorCodeSpec } from '@abloatai/transaction/errorCodes';
import {
  errorObservationSchema,
  sanitizeObservationValue,
  type ErrorObservation,
} from '@abloatai/transaction/errorObservation';
import { toAbloError } from '@abloatai/transaction/errors';

// `ABLO_CLI_EMBEDDED_*` is replaced with literals by tsup for published
// packages. The ordinary runtime override remains useful for staging and
// local verification, but normal users no longer need to configure telemetry.
const dsn =
  process.env.ABLO_CLI_SENTRY_DSN ?? process.env.ABLO_CLI_EMBEDDED_SENTRY_DSN ?? '';
const release =
  process.env.ABLO_CLI_RELEASE ?? process.env.ABLO_CLI_EMBEDDED_RELEASE;
let initialized = false;
const nativeProcessExit = process.exit.bind(process);
let exitBoundaryInstalled = false;

/**
 * Internal signal used to turn legacy non-zero `process.exit(...)` calls into
 * an error that the one top-level command boundary can observe and flush.
 * Successful exits remain immediate and unchanged.
 */
export class CliFailureExit extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`CLI command exited with status ${exitCode}`);
    this.name = 'CliFailureExit';
    this.exitCode = exitCode;
  }
}

/** Install the unavoidable boundary before command dispatch begins. */
export function installCliExitObservationBoundary(): void {
  if (exitBoundaryInstalled) return;
  exitBoundaryInstalled = true;
  process.exit = ((code?: string | number | null): never => {
    const numericCode = code == null ? 0 : Number(code);
    if (numericCode === 0) return nativeProcessExit(code);
    throw new CliFailureExit(Number.isFinite(numericCode) ? numericCode : 1);
  }) as typeof process.exit;
}

/** Restore Node's real exit before the top-level boundary terminates. */
export function restoreCliExitObservationBoundary(): void {
  if (!exitBoundaryInstalled) return;
  process.exit = nativeProcessExit as typeof process.exit;
  exitBoundaryInstalled = false;
}

function init(): boolean {
  if (!dsn) return false;
  if (!initialized) {
    Sentry.init({
      dsn,
      environment: process.env.ABLO_STAGE ?? 'local',
      release,
      sendDefaultPii: false,
      enableLogs: true,
      beforeSend(event) {
        return sanitizeObservationValue(event) as typeof event;
      },
      beforeBreadcrumb(breadcrumb) {
        return sanitizeObservationValue(breadcrumb) as typeof breadcrumb;
      },
    });
    initialized = true;
  }
  return true;
}

function commandOperation(): string {
  const command = process.argv[2];
  const subcommand = process.argv[3];
  const safe = (value: string | undefined): string | undefined =>
    value && /^[a-z][a-z0-9-]*$/i.test(value) ? value : undefined;
  return ['ablo', safe(command), safe(subcommand)].filter(Boolean).join(' ');
}

function detailString(
  details: Readonly<Record<string, unknown>> | undefined,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = details?.[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** Capture the top-level CLI failure without ever replacing terminal output. */
export function observeCliError(err: unknown): string | undefined {
  const normalized = toAbloError(err);
  // A server-generated event is already captured at its origin; retain its id
  // and add only a CLI structured log when enabled.
  const eventId = normalized.eventId ?? (dsn ? randomUUID().replaceAll('-', '') : undefined);
  if (!eventId || !init()) return normalized.eventId;

  try {
    const spec = normalized.code ? errorCodeSpec(normalized.code) : undefined;
    const policy = spec?.observability ?? {
      severity: 'error' as const,
      sentry: 'issue' as const,
      pagingEligible: false,
      expectedVolume: 'low' as const,
      owner: 'product' as const,
    };
    const details = normalized.details;
    const organizationId = detailString(details, 'organizationId', 'organization_id');
    const projectId = detailString(details, 'projectId', 'project_id');
    const branchId = detailString(details, 'branchId', 'branch_id');
    const dataSourceId = detailString(details, 'dataSourceId', 'data_source_id');
    const model = detailString(details, 'model', 'modelName', 'model_name');
    const candidate = sanitizeObservationValue({
      eventId,
      occurredAt: new Date().toISOString(),
      service: 'ablo-cli',
      stage: process.env.ABLO_STAGE ?? 'local',
      ...(release ? { release } : {}),
      severity: normalized.eventId ? 'warning' : policy.severity,
      channel: 'cli',
      scope: 'command',
      operation: commandOperation(),
      errorCode: normalized.code ?? 'internal_error',
      errorType: normalized.type,
      category: spec?.category ?? 'client',
      retryable: spec?.retryable ?? false,
      handled: normalized.eventId !== undefined || policy.sentry === 'log',
      publicMessage: normalized.message,
      internalMessage: normalized.message,
      ...(normalized.stack ? { stack: normalized.stack } : {}),
      ...(normalized.requestId ? { requestId: normalized.requestId } : {}),
      ...(organizationId ? { organizationId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(branchId ? { branchId } : {}),
      ...(dataSourceId ? { dataSourceId } : {}),
      ...(model ? { model } : {}),
      ...(err instanceof CliFailureExit
        ? { diagnosticContext: { exitCode: err.exitCode } }
        : {}),
    });
    const observation: ErrorObservation = errorObservationSchema.parse(candidate);

    if (normalized.eventId || policy.sentry === 'log') {
      Sentry.logger.warn(observation.publicMessage, { ...observation });
    } else {
      Sentry.captureException(err, {
        event_id: observation.eventId,
        captureContext: {
          level: observation.severity,
          fingerprint: [observation.service, observation.operation, observation.errorCode],
          tags: {
            service: observation.service,
            channel: observation.channel,
            scope: observation.scope,
            error_code: observation.errorCode,
          },
          contexts: { ablo: { ...observation } },
        },
      });
    }
    return eventId;
  } catch {
    return normalized.eventId;
  }
}

export async function flushCliErrors(timeoutMs = 2_000): Promise<boolean> {
  if (!initialized) return true;
  return Sentry.flush(timeoutMs);
}
