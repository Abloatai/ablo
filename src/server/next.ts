/**
 * `@abloatai/ablo/server/next` — mount Ablo's HTTP surface in a consumer's
 * Next.js App Router, the Better-Auth `toNextJsHandler` way:
 *
 * ```ts
 * // app/api/ablo/[...all]/route.ts
 * import { toAbloHandler } from '@abloatai/ablo/server/next';
 * import { ablo } from '@/lib/ablo';        // your configured Ablo HTTP app
 * export const { GET, POST } = toAbloHandler(ablo);
 * ```
 *
 * Ablo's HTTP endpoints (bootstrap / query / the commit fallback) are stateless
 * request→response, so they drop straight into a route handler. The realtime
 * WebSocket channel is deliberately NOT served here — it is a persistent
 * connection a serverless route handler cannot host, and stays an Ablo-hosted
 * (or long-running Node) service. That is the HTTP/WSS split the architecture
 * draws on purpose (see docs/plans/sync-gateway-audit-log-architecture.md).
 *
 * The package owns this MOUNT PRIMITIVE; the host owns the infra-bound app it
 * wraps (the Hono app holding the Hub + routes + auth). Mirrors Better Auth,
 * where `betterAuth()` builds the `.handler` and `toNextJsHandler` just maps it
 * onto the HTTP verbs.
 */

/**
 * Anything that resolves a Web `Request` to a `Response` — e.g. a Hono app's
 * `.fetch`, a Better-Auth-style `{ handler }`, or a bare function.
 */
export type AbloFetchHandler = (request: Request) => Response | Promise<Response>;

/** The shapes `toAbloHandler` accepts: a Hono-style `{ fetch }`, a
 *  `{ handler }`, or a bare `(Request) => Response`. */
export type AbloHttpApp =
  | { readonly fetch: AbloFetchHandler }
  | { readonly handler: AbloFetchHandler }
  | AbloFetchHandler;

function resolveFetch(app: AbloHttpApp): AbloFetchHandler {
  if (typeof app === 'function') return app;
  if ('fetch' in app) return app.fetch;
  return app.handler;
}

/** The route-handler object a Next.js App Router `route.ts` re-exports. One
 *  handler bound to every method the `[...all]` catch-all may receive. */
export interface AbloRouteHandlers {
  readonly GET: AbloFetchHandler;
  readonly POST: AbloFetchHandler;
  readonly PATCH: AbloFetchHandler;
  readonly PUT: AbloFetchHandler;
  readonly DELETE: AbloFetchHandler;
  readonly OPTIONS: AbloFetchHandler;
}

/**
 * Wrap a configured Ablo HTTP app into Next.js App Router route handlers.
 * Mirrors Better Auth's `toNextJsHandler` — accepts the app's `fetch`/`handler`
 * (or a bare function) and returns one handler per verb.
 */
export function toAbloHandler(app: AbloHttpApp): AbloRouteHandlers {
  const fetch = resolveFetch(app);
  const handler: AbloFetchHandler = (request) => fetch(request);
  return {
    GET: handler,
    POST: handler,
    PATCH: handler,
    PUT: handler,
    DELETE: handler,
    OPTIONS: handler,
  };
}
