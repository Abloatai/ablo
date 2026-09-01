/**
 * Machine-checked names on the public `Ablo({ ... })` configuration surface.
 *
 * Documentation reads this tuple. Type equality below makes a constructor
 * option change fail compilation until the reference inventory changes with it.
 * `onCommitReceipt` is an internal transport callback, so it is deliberately
 * removed from the public factory type before the equality check.
 */

import type { AbloHttpClientOptions } from '../transport/http/client.js';
import type { SchemaRecord } from '../schema/schema.js';

export type PublicAbloOptions<S extends SchemaRecord = SchemaRecord> = Omit<
  AbloHttpClientOptions<S>,
  'onCommitReceipt' | 'transport'
> & {
  readonly transport?: 'http' | 'websocket';
};

export const PUBLIC_ABLO_OPTION_KEYS = [
  'schema',
  'apiKey',
  'session',
  'authToken',
  'baseURL',
  'dangerouslyAllowBrowser',
  'fetch',
  'bootstrapBaseUrl',
  'defaultHeaders',
  'defaultQuery',
  'observability',
  'durableWrites',
  'commitOutbox',
  'commitOutboxScope',
  'transport',
  'timeoutMs',
  'groups',
  'collaborationEvents',
  'cursorStore',
  'cursorKey',
  'reconnectDelay',
  'maxReconnectDelay',
  'connectTimeoutMs',
] as const;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? true
    : false;
type Expect<T extends true> = T;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _PublicAbloOptionsExact = Expect<
  Equal<(typeof PUBLIC_ABLO_OPTION_KEYS)[number], keyof PublicAbloOptions & string>
>;
