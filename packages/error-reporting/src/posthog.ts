import { sanitizeObservationValue } from '@abloatai/transaction/errorObservation';

/** Preserve symbolication coordinates, excluding source context, locals and SDK-captured PII. */
export function sanitizePostHogProperties(properties: Record<string, any>): Record<string, any> {
  const safe = sanitizeObservationValue(properties) as Record<string, any>;
  if (Array.isArray(properties.$exception_list)) {
    safe.$exception_list = properties.$exception_list.map((exception: Record<string, any>) => ({
      type: sanitizeObservationValue(exception.type),
      value: sanitizeObservationValue(exception.value),
      mechanism: { type: 'generic', handled: typeof properties.handled === 'boolean' ? properties.handled : exception.mechanism?.handled !== false },
      stacktrace: { type: 'raw', frames: Array.isArray(exception.stacktrace?.frames)
        ? exception.stacktrace.frames.map((frame: Record<string, unknown>) => Object.fromEntries(
          ['platform', 'lang', 'function', 'filename', 'lineno', 'colno', 'in_app', 'chunk_id']
            .filter(key => ['string', 'number', 'boolean'].includes(typeof frame[key]))
            .map(key => [key, typeof frame[key] === 'string'
              ? sanitizeObservationValue((frame[key] as string).split(/[?#]/)[0]) : frame[key]]),
        )) : [] },
    }));
  }
  for (const key of ['$current_url', '$referrer', '$initial_current_url', '$initial_referrer']) {
    if (typeof safe[key] === 'string') {
      try { const url = new URL(safe[key]); safe[key] = `${url.origin}${url.pathname}`; }
      catch { delete safe[key]; }
    }
  }
  // Browser ingestion authenticates with this public project token; private credentials stay scrubbed.
  if (typeof properties.token === 'string' && /^phc_[A-Za-z0-9]+$/.test(properties.token)) safe.token = properties.token;
  for (const key of ['$exception_personURL', '$exception_breadcrumbs', '$set', '$set_once', '$ip']) delete safe[key];
  return { ...safe, $process_person_profile: false, $geoip_disable: true };
}
