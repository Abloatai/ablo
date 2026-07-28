/**
 * The one HTTP boundary between the CLI and Ablo's API.
 *
 * Owns the base URL, the `/api` mount, bearer auth, dial-failure
 * classification, the error-envelope decode, and the success-shape parse — so
 * a command never reads a `Response` or an error envelope itself. Every
 * non-2xx becomes the typed {@link AbloError} the registry describes
 * (`translateHttpError`, the same mapping every SDK transport uses), every
 * dial failure an `AbloConnectionError` naming what was dialled, and every
 * 2xx body is parsed against the route's wire schema HERE — code below this
 * boundary takes `z.infer<…>` and never re-parses.
 *
 * Before this module, four commands each carried their own copy of this
 * boundary: a hand-cast envelope in `disconnect`, manual type guards in
 * `remoteValidation`, a local zod pair in `connectSetup`, and a bare
 * `request()` in `projects`. Each decoded `code ?? error.code` again, and each
 * invented its own words for an unreachable host.
 */

import { z } from 'zod';
import {
  AbloConnectionError,
  AbloError,
  AbloServerError,
  translateHttpError,
} from '@abloatai/transaction/errors';
import { ABLO_DEFAULT_BASE_URL } from '@abloatai/transaction/auth/hostedEndpoints';

/** The default base URL for the hosted service. */
export const DEFAULT_URL = ABLO_DEFAULT_BASE_URL;

/**
 * The API base URL every command dials, trimmed: `ABLO_API_URL` when set,
 * otherwise {@link DEFAULT_URL}. Defined once so a command can't disagree with
 * its neighbors about where the control plane is.
 */
export function apiBaseUrl(): string {
  return (process.env.ABLO_API_URL ?? DEFAULT_URL).replace(/\/+$/, '');
}

/**
 * The slice of a fetch response this boundary reads. Global `fetch` satisfies
 * it structurally; tests inject a plain-object fake without needing the
 * runtime's `Response`/`Headers` globals.
 */
export interface ControlPlaneHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type ControlPlaneFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  }
) => Promise<ControlPlaneHttpResponse>;

export interface ControlPlaneRequest<S extends z.ZodType> {
  /**
   * The route as the published contract names it, e.g. `/v1/datasources`.
   * The server mounts every route under `/api`, so the full URL is built here
   * — a bare `/v1/…` matches no route and comes back as the global "Not
   * found", which is why no caller assembles its own.
   */
  readonly path: string;
  readonly method?: 'GET' | 'POST' | 'DELETE';
  /** Bearer credential; omit for unauthenticated routes. */
  readonly apiKey?: string;
  /** JSON body, serialized here when present. */
  readonly body?: unknown;
  /** Base URL override (a `--url` flag); defaults to {@link apiBaseUrl}. */
  readonly baseUrl?: string;
  /** Abort the request after this long. No timeout when omitted. */
  readonly timeoutMs?: number;
  /** The route's wire schema — the ONE place this response is checked. */
  readonly responseSchema: S;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: ControlPlaneFetch;
}

/**
 * Perform one request against the control plane and return the parsed,
 * typed response. Never returns an unparsed body, and never fails silently:
 *
 *   - a dial failure throws `AbloConnectionError` (`api_unreachable`) naming
 *     the target, so the renderer can show what was dialled;
 *   - a non-2xx throws the typed error its envelope describes, with the
 *     registry code, `x-request-id`, and domain details intact;
 *   - a 2xx whose body does not match `responseSchema` throws
 *     `response_unrecognized` rather than degrading to `undefined` fields
 *     deep in a success message.
 */
export async function requestControlPlane<S extends z.ZodType>(
  req: ControlPlaneRequest<S>
): Promise<z.infer<S>> {
  const base = (req.baseUrl ?? apiBaseUrl()).replace(/\/+$/, '');
  const url = `${base}/api${req.path}`;
  const doFetch: ControlPlaneFetch = req.fetchImpl ?? fetch;
  const ctrl = req.timeoutMs !== undefined ? new AbortController() : null;
  const timer = ctrl
    ? setTimeout(() => {
        ctrl.abort();
      }, req.timeoutMs)
    : null;
  let res: ControlPlaneHttpResponse;
  try {
    res = await doFetch(url, {
      method: req.method ?? 'GET',
      headers: {
        ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(req.apiKey ? { authorization: `Bearer ${req.apiKey}` } : {}),
      },
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
  } catch (err) {
    throw new AbloConnectionError(
      `Couldn't reach ${base} — ${err instanceof Error ? err.message : String(err)}.`,
      { code: 'api_unreachable', details: { target: base }, cause: err }
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  const requestId = res.headers?.get('x-request-id') ?? undefined;
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) throw translateHttpError(res.status, body, requestId);

  const parsed = req.responseSchema.safeParse(body);
  if (!parsed.success) {
    throw new AbloServerError(
      `The server's answer from ${req.path} wasn't in a shape this CLI recognizes. ` +
        'The CLI may be older than the server — update @abloatai/cli and retry.',
      {
        code: 'response_unrecognized',
        ...(requestId !== undefined ? { requestId } : {}),
        details: { target: base, path: req.path },
      }
    );
  }
  return parsed.data;
}

/**
 * The same request, resolved to a result instead of a throw — for callers
 * that must never fail (a status probe, a best-effort preflight) and want to
 * branch on the typed error rather than catch at every call site.
 */
export async function tryControlPlane<S extends z.ZodType>(
  req: ControlPlaneRequest<S>
): Promise<{ ok: true; value: z.infer<S> } | { ok: false; error: AbloError }> {
  try {
    return { ok: true, value: await requestControlPlane(req) };
  } catch (err) {
    return { ok: false, error: err instanceof AbloError ? err : new AbloError(String(err)) };
  }
}
