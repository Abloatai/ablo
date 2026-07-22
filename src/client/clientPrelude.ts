/**
 * The prelude every socket client resolves before anything is constructed.
 *
 * One pass over the options bag settles the values the composition root then
 * spends: the credential and its refresh resolver, the base URL, the logger,
 * and this participant's identity. Nothing here opens a socket, allocates a
 * store, or touches IndexedDB — so a misconfiguration (a secret key in the
 * browser, the removed `databaseUrl` option, a CLI key pointing at another
 * project) fails while the stack still points at the caller's own setup.
 *
 * `./Ablo.ts` calls this once and hands the result to whichever client the
 * plugin list selected.
 */

import type { ParticipantKind } from '../transaction/types/participant.js';
import type { Logger } from '../transaction/logger.js';
import type { SchemaRecord } from '../transaction/schema/schema.js';
import {
  createAuthCredentialSource,
  type AuthCredentialSource,
} from '../transaction/auth/credentialSource.js';
import {
  assertBrowserSafety,
  readProcessEnv,
  rejectRemovedDatabaseUrlOption,
  resolveApiKey,
  resolveAuthToken,
  resolveBaseURL,
  resolveCredentialResolver,
  warnIfCliKeyMismatch,
  type ApiKeySetter,
} from '../transaction/auth/apiKey.js';
import type { AbloOptions, InternalAbloOptions } from './options.js';
import { createConsoleLogger, resolveLogLevel } from './consoleLogger.js';

/** What one pass over the options bag settles, for the builders downstream. */
export interface ClientPrelude<S extends SchemaRecord> {
  /** The same options, widened to the fields only the SDK's own callers set. */
  readonly internalOptions: InternalAbloOptions<S>;
  /** The configured key — a literal key string, or a resolver to call. */
  readonly configuredApiKey: string | ApiKeySetter | null;
  readonly configuredAuthToken: string | null;
  /**
   * The credential lifecycle's single resolver, or `null` when auth is static.
   * It drives both the reactive re-mint (the connection's `credential_stale`
   * state) and the proactive refresh timer with its wake/online/focus triggers.
   */
  readonly credentialResolver: (() => Promise<string | null>) | null;
  readonly authCredentials: AuthCredentialSource;
  readonly logger: Logger;
  readonly url: string;
  /**
   * Identity routing: agents identify by agentId, users by user.id. The server
   * stamps `isAgent` on outbound presence frames from the connection's
   * authenticated identity prefix; the local `self` entry uses the kind we know
   * at construction.
   */
  readonly participantId: string;
  readonly kind: ParticipantKind;
}

/**
 * Resolve the prelude, failing fast on a misconfiguration.
 *
 * Three checks fire here rather than downstream: a secret key reaching the
 * browser, the removed `databaseUrl` option, and a CLI key scoped to a
 * different project than the one being addressed (a warning, not a throw).
 */
export function resolveClientPrelude<S extends SchemaRecord>(
  options: AbloOptions<S>,
): ClientPrelude<S> {
  const internalOptions = options as InternalAbloOptions<S>;
  const env = readProcessEnv();
  const authInput = { options, env };
  const configuredApiKey = resolveApiKey(authInput);
  const configuredAuthToken = resolveAuthToken(authInput);
  const credentialResolver = resolveCredentialResolver(configuredApiKey);
  const authCredentials = createAuthCredentialSource(
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- load-bearing on the self-hosted path; server-internal cap-mint (Phase 3) not shipped
    internalOptions.capabilityToken ?? configuredAuthToken,
  );
  rejectRemovedDatabaseUrlOption(options);
  assertBrowserSafety({
    apiKey: configuredApiKey,
    dangerouslyAllowBrowser: options.dangerouslyAllowBrowser,
  });

  // Custom logger wins; otherwise build the default `[Ablo]` logger at the level
  // resolved from `debug`/`logLevel`/`ABLO_LOG_LEVEL` (default `warn`).
  const logger =
    internalOptions.logger ??
    createConsoleLogger(resolveLogLevel({ debug: options.debug, logLevel: options.logLevel }));
  void warnIfCliKeyMismatch(authInput, (m) => { logger.warn(m); });

  const participantId =
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- self-hosted identity fallback; hosted path derives identity from the apiKey scope
    (internalOptions.kind === 'agent' ? internalOptions.agentId : internalOptions.user?.id) ?? '';
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- self-hosted default; hosted path ignores it (server derives kind from the apiKey scope)
  const kind = internalOptions.kind ?? 'user';

  return {
    internalOptions,
    configuredApiKey,
    configuredAuthToken,
    credentialResolver,
    authCredentials,
    logger,
    url: resolveBaseURL(authInput),
    participantId,
    kind,
  };
}
