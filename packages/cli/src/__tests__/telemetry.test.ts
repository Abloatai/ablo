import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  flushProductAnalytics,
  resetTelemetry,
  setTelemetryEnabled,
  telemetryStatus,
  trackCliInitCompleted,
  trackCliInitStarted,
} from '../telemetry';

describe('CLI product telemetry', () => {
  // Each test gets its own throwaway config directory outside the package. A
  // path under `process.cwd()` survives the run, and the release mirror is
  // compared against a fresh snapshot, so a stray directory there reads as a
  // missing commit and refuses the publish.
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'ablo-telemetry-'));
    process.env.ABLO_CONFIG_DIR = configDir;
    delete process.env.CI;
    delete process.env.DO_NOT_TRACK;
    delete process.env.ABLO_TELEMETRY_DISABLED;
    resetTelemetry();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetTelemetry();
    jest.restoreAllMocks();
    delete process.env.ABLO_CONFIG_DIR;
    rmSync(configDir, { recursive: true, force: true });
  });

  it('discloses once, creates a separate identity, and flushes a bounded batch', async () => {
    trackCliInitStarted({ interactive: true });
    trackCliInitCompleted(1_500, 'nextjs');
    expect(console.error).toHaveBeenCalledTimes(1);

    const requests: Array<{ url: string; body: unknown }> = [];
    await flushProductAnalytics({
      baseUrl: 'https://api.example.test',
      fetchImpl: (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) as unknown });
        return Promise.resolve(new Response('{}', { status: 202 }));
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.example.test/api/v1/analytics/events');
    expect(requests[0]?.body).toMatchObject({
      anonymousId: expect.any(String),
      events: [
        { eventName: 'cli_init_started' },
        { eventName: 'cli_init_completed', properties: { durationBucket: '1s_to_5s' } },
      ],
    });
    expect(telemetryStatus().queuedEvents).toBe(0);
  });

  it('honors explicit and environment opt-outs without creating an identity', () => {
    setTelemetryEnabled(false);
    trackCliInitStarted({ interactive: false });
    expect(telemetryStatus()).toMatchObject({ enabled: false, effective: false, queuedEvents: 0 });

    setTelemetryEnabled(true);
    process.env.DO_NOT_TRACK = '1';
    trackCliInitStarted({ interactive: false });
    expect(telemetryStatus()).toMatchObject({
      effective: false,
      blockedBy: 'DO_NOT_TRACK',
      installationIdCreated: false,
    });
  });

  it('keeps transient failures queued and drops permanently rejected events', async () => {
    trackCliInitStarted({ interactive: false });
    await flushProductAnalytics({
      baseUrl: 'https://api.example.test',
      fetchImpl: () => Promise.resolve(new Response('{}', { status: 503 })),
    });
    expect(telemetryStatus().queuedEvents).toBe(1);

    await flushProductAnalytics({
      baseUrl: 'https://api.example.test',
      fetchImpl: () => Promise.resolve(new Response('{}', { status: 400 })),
    });
    expect(telemetryStatus().queuedEvents).toBe(0);
  });

  it('stores no credentials or project data in telemetry.json', () => {
    trackCliInitStarted({ interactive: false });
    const raw = readFileSync(join(process.env.ABLO_CONFIG_DIR!, 'telemetry.json'), 'utf8');
    expect(raw).not.toMatch(/apiKey|workingDirectory|databaseUrl|projectId|token/);
  });
});
