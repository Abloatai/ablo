import { PostHog } from 'posthog-node';
import { sanitizePostHogProperties } from './posthog';

export interface ObservabilityConfig {
  projectToken: string;
  host: string;
  environment: string;
  release?: string | undefined;
}

/** Owned server transport: exception parsing uses the SDK, logs use standard OTLP JSON. */
export function createObservability(service: string, config: ObservabilityConfig) {
  const url = new URL(config.host);
  if (!config.projectToken.startsWith('phc_') ||
      !(['https://us.i.posthog.com', 'https://eu.i.posthog.com'].includes(url.origin) ||
        process.env.NODE_ENV === 'test' && ['127.0.0.1', 'localhost'].includes(url.hostname))) {
    throw new Error('Invalid PostHog ingestion configuration');
  }
  const common = { service, environment: config.environment, release: config.release,
    $process_person_profile: false, $geoip_disable: true };
  const client = new PostHog(config.projectToken, {
    host: config.host, disableGeoip: true, flushInterval: 1000, requestTimeout: 2000,
    before_send: event => event ? { ...event, properties: sanitizePostHogProperties({ ...event.properties, ...common }) } : event,
  });
  client.on('error', () => { /* Telemetry failures must never print payloads or credentials. */ });
  const pending = new Set<Promise<void>>();
  return {
    client,
    capture(error: unknown, properties: Record<string, unknown>, fingerprint?: string) {
      client.captureException(error, `${service}:anonymous`, {
        ...properties, ...common, ...(typeof properties.severity === 'string' ? { $exception_level: properties.severity } : {}), ...(fingerprint ? { $exception_fingerprint: fingerprint } : {}),
      });
    },
    log(message: string, properties: Record<string, unknown>, level = 'WARN') {
      // shortcut: thirty concurrent log exports bound memory; use a collector if sustained volume exceeds this.
      if (pending.size >= 30) return;
      const safe = sanitizePostHogProperties(properties);
      const attributes = Object.entries(safe).filter(([, value]) => value !== undefined).map(([key, value]) => ({
        key, value: typeof value === 'boolean' ? { boolValue: value }
          : typeof value === 'number' ? { doubleValue: value }
            : { stringValue: typeof value === 'string' ? value : JSON.stringify(value) },
      }));
      const body = { resourceLogs: [{ resource: { attributes: [
        { key: 'service.name', value: { stringValue: service } },
        { key: 'deployment.environment.name', value: { stringValue: config.environment } },
        ...(config.release ? [{ key: 'service.version', value: { stringValue: config.release } }] : []),
      ] }, scopeLogs: [{ scope: { name: 'ablo' }, logRecords: [{
        timeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
        severityText: level, severityNumber: level === 'INFO' ? 9 : level === 'WARN' ? 13 : 17,
        body: { stringValue: String(sanitizePostHogProperties({ message }).message) }, attributes,
      }] }] }] };
      const request = fetch(`${url.origin}/i/v1/logs`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.projectToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(2000),
      }).then(response => { if (!response.ok) throw new Error('Log export rejected'); }).catch(() => {}).finally(() => pending.delete(request));
      pending.add(request);
    },
    async flush(timeoutMs = 2000): Promise<boolean> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.all([client.flush(), ...pending]).then(() => true, () => false),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
        ]);
      } finally { clearTimeout(timer); }
    },
  };
}
