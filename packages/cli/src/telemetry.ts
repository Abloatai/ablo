import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  PRODUCT_EVENT_VERSION,
  productEventSchema,
  type ProductEvent,
} from '@ablo/product-analytics';
import { cliArchitecture, cliOs, cliVersion } from './cliEnvironment';
import { apiBaseUrl } from './controlPlane';
import { configDir } from './config';

const TELEMETRY_FILE_VERSION = 1 as const;
const MAX_QUEUED_EVENTS = 50;
const MAX_FLUSH_EVENTS = 20;
const DEFAULT_FLUSH_TIMEOUT_MS = 800;

interface TelemetryState {
  version: typeof TELEMETRY_FILE_VERSION;
  enabled: boolean;
  disclosureShown: boolean;
  anonymousId?: string;
  queue: ProductEvent[];
}

export interface TelemetryStatus {
  enabled: boolean;
  effective: boolean;
  blockedBy: string | null;
  installationIdCreated: boolean;
  queuedEvents: number;
}

export interface FlushTelemetryOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

let flushInFlight: Promise<void> | null = null;

export function telemetryPath(): string {
  return join(configDir(), 'telemetry.json');
}

export function telemetryStatus(): TelemetryStatus {
  const state = readState();
  const blockedBy = environmentBlocker();
  return {
    enabled: state.enabled,
    effective: state.enabled && blockedBy === null,
    blockedBy,
    installationIdCreated: state.anonymousId !== undefined,
    queuedEvents: state.queue.length,
  };
}

export function setTelemetryEnabled(enabled: boolean): TelemetryStatus {
  const state = readState();
  writeState({
    ...state,
    enabled,
    // Disabling is immediate: events collected before the choice must not be
    // delivered later if telemetry is re-enabled.
    queue: enabled ? state.queue : [],
  });
  return telemetryStatus();
}

export function resetTelemetry(): void {
  rmSync(telemetryPath(), { force: true });
}

export function trackCliInitStarted(input: {
  interactive: boolean;
  source?: string;
}): void {
  queueEvent('cli_init_started', {
    cliVersion: cliVersion(),
    nodeMajorVersion: Number(process.versions.node.split('.')[0]),
    os: cliOs(),
    architecture: cliArchitecture(),
    interactive: input.interactive,
    source: input.source ?? 'direct',
  });
}

export function trackCliInitCompleted(durationMs: number, setupClass: string): void {
  queueEvent('cli_init_completed', {
    durationBucket: durationBucket(durationMs),
    setupClass,
  });
}

export function trackCliDevStarted(mode: string): void {
  queueEvent('cli_dev_started', { mode, cliVersion: cliVersion() });
}

export function trackCliSchemaPushAttempted(): void {
  queueEvent('cli_schema_push_attempted', { sourceCommand: 'push' });
}

export function flushProductAnalytics(options: FlushTelemetryOptions = {}): Promise<void> {
  if (flushInFlight) return flushInFlight;
  flushInFlight = flushOnce(options)
    .catch((error) => {
      // Telemetry is best-effort and cannot report its own delivery failure.
      void error;
    })
    .finally(() => {
      flushInFlight = null;
    });
  return flushInFlight;
}

function queueEvent(eventName: ProductEvent['eventName'], properties: unknown): void {
  try {
    if (environmentBlocker()) return;
    const state = readState();
    if (!state.enabled) return;

    const disclose = !state.disclosureShown;
    state.disclosureShown = true;
    state.anonymousId ??= randomUUID();
    const parsed = productEventSchema.parse({
      producerEventId: randomUUID(),
      eventVersion: PRODUCT_EVENT_VERSION,
      occurredAt: new Date().toISOString(),
      eventName,
      properties,
    });
    state.queue = [...state.queue, parsed].slice(-MAX_QUEUED_EVENTS);
    // Persistence is the commit point. A read-only home directory must not
    // print a disclosure for collection that did not happen—or fail a command.
    writeState(state);
    if (disclose) {
      process.stderr.write(
        'Ablo collects limited usage analytics. Run `ablo telemetry disable` to opt out or `ablo telemetry status` for details.\n'
      );
    }
  } catch {
    // Product analytics is strictly fail-open for every CLI command.
  }
}

async function flushOnce(options: FlushTelemetryOptions): Promise<void> {
  if (environmentBlocker()) return;
  const state = readState();
  if (!state.enabled || !state.anonymousId || state.queue.length === 0) return;

  const batch = state.queue.slice(0, MAX_FLUSH_EVENTS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(
      `${(options.baseUrl ?? apiBaseUrl()).replace(/\/+$/, '')}/api/v1/analytics/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ anonymousId: state.anonymousId, events: batch }),
        signal: controller.signal,
      }
    );
  } catch {
    return;
  } finally {
    clearTimeout(timer);
  }

  // Retry transient failures on a later invocation. Permanently rejected
  // locally-validated events are discarded so one expired event cannot poison
  // the bounded queue forever.
  if (!response.ok && (response.status >= 500 || [408, 425, 429].includes(response.status))) {
    return;
  }
  if (response.ok || (response.status >= 400 && response.status < 500)) {
    const current = readState();
    const delivered = new Set(batch.map((event) => event.producerEventId));
    writeState({
      ...current,
      queue: current.queue.filter((event) => !delivered.has(event.producerEventId)),
    });
  }
}

function defaultState(): TelemetryState {
  return { version: TELEMETRY_FILE_VERSION, enabled: true, disclosureShown: false, queue: [] };
}

function readState(): TelemetryState {
  if (!existsSync(telemetryPath())) return defaultState();
  try {
    const raw = JSON.parse(readFileSync(telemetryPath(), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultState();
    const value = raw as Record<string, unknown>;
    const queue = Array.isArray(value.queue)
      ? value.queue.flatMap((event) => {
          const parsed = productEventSchema.safeParse(event);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
    return {
      version: TELEMETRY_FILE_VERSION,
      enabled: value.enabled !== false,
      disclosureShown: value.disclosureShown === true,
      ...(typeof value.anonymousId === 'string' ? { anonymousId: value.anonymousId } : {}),
      queue: queue.slice(-MAX_QUEUED_EVENTS),
    };
  } catch {
    return defaultState();
  }
}

function writeState(state: TelemetryState): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = telemetryPath();
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function environmentBlocker(): string | null {
  if (process.env.ABLO_TELEMETRY_DISABLED === '1') return 'ABLO_TELEMETRY_DISABLED';
  if (process.env.DO_NOT_TRACK === '1') return 'DO_NOT_TRACK';
  const ciVariables = ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'TF_BUILD'];
  return ciVariables.find((name) => truthyEnvironmentValue(process.env[name])) ?? null;
}

function truthyEnvironmentValue(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

function durationBucket(
  durationMs: number
): 'under_1s' | '1s_to_5s' | '5s_to_30s' | '30s_to_2m' | 'over_2m' {
  if (durationMs < 1_000) return 'under_1s';
  if (durationMs < 5_000) return '1s_to_5s';
  if (durationMs < 30_000) return '5s_to_30s';
  if (durationMs < 120_000) return '30s_to_2m';
  return 'over_2m';
}

export function runTelemetryCommand(argv: readonly string[]): void {
  const action = argv[0] ?? 'status';
  if (argv.length > 1 || !['status', 'enable', 'disable', 'reset'].includes(action)) {
    throw new Error('Usage: ablo telemetry status|enable|disable|reset');
  }
  if (action === 'enable') setTelemetryEnabled(true);
  if (action === 'disable') setTelemetryEnabled(false);
  if (action === 'reset') resetTelemetry();

  const status = telemetryStatus();
  if (action === 'reset') {
    console.log('Telemetry identity and queued events reset.');
  }
  console.log(`Telemetry: ${status.effective ? 'enabled' : 'disabled'}`);
  if (status.blockedBy) console.log(`Environment override: ${status.blockedBy}`);
  console.log(`Queued events: ${status.queuedEvents}`);
}
