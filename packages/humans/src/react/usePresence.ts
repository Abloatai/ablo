'use client';

import { useCallback, useEffect } from 'react';
import type { PresenceSession } from '@abloatai/transaction/presence';
import { AbloValidationError } from '@abloatai/transaction/errors';
import {
  getModelClientMeta,
  type ModelOperations,
} from '../local/client/createModelOperations.js';
import type { AbloClient as Ablo } from '../client.js';
import type { SchemaRecord } from '@abloatai/transaction/schema/schema';
import type { ResolveModels as DefaultModels } from '@abloatai/transaction/types/global';
import { useAbloClient } from './useAbloClient.js';
import { useReactive } from './useReactive.js';

export type PresenceModelSelector<R extends SchemaRecord, T, C, U = C> =
  (ablo: Ablo<R>) => ModelOperations<T, C, U>;

/**
 * Declare that this component is reading one row and return every live session
 * reading or otherwise acting on that row. Ablo owns the lease, refresh,
 * reconnect, and cleanup mechanics for the component's lifetime.
 */
export function usePresence<T, C, U = C>(
  modelClient: ModelOperations<T, C, U>,
  recordId: string,
  options?: usePresence.Options,
): readonly PresenceSession[];
export function usePresence<
  R extends SchemaRecord = DefaultModels,
  T = Record<string, unknown>,
  C = unknown,
  U = C,
>(
  select: PresenceModelSelector<R, T, C, U>,
  recordId: string,
  options?: usePresence.Options,
): readonly PresenceSession[];
export function usePresence<
  R extends SchemaRecord = DefaultModels,
  T = Record<string, unknown>,
  C = unknown,
  U = C,
>(
  modelOrSelect: ModelOperations<T, C, U> | PresenceModelSelector<R, T, C, U>,
  recordId: string,
  options?: usePresence.Options,
): readonly PresenceSession[] {
  const engine = useAbloClient<R>();
  if (recordId.length === 0) {
    throw new AbloValidationError(
      'usePresence requires a non-empty record id.',
      { code: 'invalid_request', param: 'recordId' },
    );
  }
  const modelClient = typeof modelOrSelect === 'function'
    ? engine
      ? modelOrSelect(engine)
      : null
    : modelOrSelect;
  const presence = modelClient ? getModelClientMeta(modelClient)?.presence : undefined;
  if (modelClient !== null && presence === undefined) {
    throw new AbloValidationError(
      'usePresence requires a model from the reactive Ablo client.',
      { code: 'invalid_request', param: 'modelClient' },
    );
  }

  const subscribe = useCallback((notify: () => void) => presence?.subscribe(notify) ?? (() => undefined), [presence]);
  const sessions = useReactive(() => presence?.get(recordId, options) ?? [], { subscribe });
  useEffect(() => presence?.read(recordId), [presence, recordId]);
  return sessions;
}

export namespace usePresence {
  export interface Bound<S extends SchemaRecord> {
    <T, C, U = C>(
      model: ModelOperations<T, C, U> | PresenceModelSelector<S, T, C, U>,
      recordId: string,
      options?: Options,
    ): readonly PresenceSession[];
  }

  export type Options = import('@abloatai/transaction/presence').PresenceQueryOptions;
}
