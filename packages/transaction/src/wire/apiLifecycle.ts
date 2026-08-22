/**
 * What a caller can rely on about the HTTP surface not moving under it: where
 * the version is written, what a removal looks like before it happens, and how
 * much warning it comes with.
 *
 * An agent decides whether to integrate against an API partly on whether the
 * API can change without telling it. That decision needs facts, not a promise,
 * so each of these is a value some other surface derives from — the path
 * segment every route is mounted under, the header every response carries, and
 * the two standard fields a withdrawal is announced on. {@link API_LIFECYCLE}
 * is the same set written as prose, and it is what the published OpenAPI
 * document's description carries: the policy and the routes it governs are then
 * one artifact, and a reader who has the spec has the policy.
 *
 * Two axes, deliberately separate:
 *
 *   - The PATH version ({@link API_PATH_VERSION}) is the breaking axis. It
 *     changes only when a shape a caller sends or reads changes incompatibly,
 *     and the old segment keeps serving through the notice window.
 *   - The CONTRACT date on {@link API_VERSION_HEADER} is the additive axis. It
 *     moves when something observable is added — a new error code, a new field
 *     — and a caller pinned to an older reading keeps working. Its value is
 *     `ERROR_CONTRACT_VERSION`, stamped by the server on every response.
 */

/**
 * The path segment every route is mounted under: `/api/v1/...`. Callers address
 * this literally, and the OpenAPI document's paths are written from it, so the
 * spec cannot advertise a version the server does not serve.
 */
export const API_PATH_VERSION = 'v1';

/**
 * Carries the date-stamped contract version on every response. A client that
 * records the value it was built against can tell that the server has moved
 * without waiting for a field it does not recognize to break something.
 */
export const API_VERSION_HEADER = 'Ablo-Version';

/**
 * Announces that a route will be withdrawn, as an sf-Date of the moment the
 * deprecation took effect (RFC 9745): `Deprecation: @1774483200`. It appears
 * while the route still works — a deprecated route answers normally.
 */
export const API_DEPRECATION_HEADER = 'Deprecation';

/**
 * The moment the route stops answering, as an HTTP-date (RFC 8594):
 * `Sunset: Tue, 08 Sep 2026 00:00:00 GMT`. Paired with
 * {@link API_DEPRECATION_HEADER}, the two bound the window a caller has.
 */
export const API_SUNSET_HEADER = 'Sunset';

/**
 * The minimum gap between the two headers above. A number rather than a
 * sentence because it is the part a caller plans against, and because the
 * published policy renders it rather than restating it.
 */
export const API_DEPRECATION_NOTICE_DAYS = 180;

/**
 * The policy, in the words it is published in.
 *
 * Written here rather than in the document that shows it because two documents
 * show it — the OpenAPI description and the site's API page — and a policy
 * stated twice is a policy that will eventually say two things.
 */
export const API_LIFECYCLE = `## Versioning

Every route is mounted under \`/${API_PATH_VERSION}\`, and that segment is part
of the address you call. A change that would break a caller — a field removed, a
type narrowed, a status changed — arrives as a new segment beside this one, never
as a change to this one. Additive changes do land here: a new field on a
response, a new optional parameter, a new error code. Ignore what you do not
recognize and you will not be broken by them.

Every response carries \`${API_VERSION_HEADER}\`, a date stamp for the contract
the server is serving. Record the value your integration was built against and
compare it if behavior surprises you.

## Deprecation

A route being withdrawn says so on itself, for at least
${API_DEPRECATION_NOTICE_DAYS} days before it stops answering:

- \`${API_DEPRECATION_HEADER}\` — an sf-Date of when the deprecation took effect
  (RFC 9745). The route still answers normally while this is present.
- \`${API_SUNSET_HEADER}\` — an HTTP-date of when it stops answering (RFC 8594).
- \`Link\` with \`rel="deprecation"\` pointing at what to read, and
  \`rel="successor-version"\` at what to call instead when there is one.

The same operations are marked \`deprecated: true\` in this document. Treating
either signal as a build failure is the intended use; nothing is removed without
both.`;
