'use client';

import { useEffect, useState } from 'react';
import type { PresenceSession } from '@abloatai/transaction/presence';
import { AbloValidationError } from '@abloatai/transaction/errors';
import {
  getModelClientMeta,
  type ModelOperations,
} from '../local/client/createModelOperations.js';
import type { AbloClient as Ablo } from '../client.js';
import type { SchemaRecord } from '@abloatai/transaction/schema/schema';
import type { ResolveSchema } from '@abloatai/transaction/types/global';
import { useAbloClientImpl } from './useAblo.js';

type DefaultModels = ResolveSchema extends { models: infer M }
  ? M extends SchemaRecord
    ? M
    : SchemaRecord
  : SchemaRecord;

export type PresenceModelSelector<R extends SchemaRecord, T, C> =
  (ablo: Ablo<R>) => ModelOperations<T, C>;

/**
 * Declare that this component is reading one row and return every live session
 * reading or otherwise acting on that row. Ablo owns the lease, refresh,
 * reconnect, and cleanup mechanics for the component's lifetime.
 */
export function usePresence<T, C>(
  modelClient: ModelOperations<T, C>,
  recordId: string,
): readonly PresenceSession[];
export function usePresence<
  R extends SchemaRecord = DefaultModels,
  T = Record<string, unknown>,
  C = unknown,
>(
  select: PresenceModelSelector<R, T, C>,
  recordId: string,
): readonly PresenceSession[];
export function usePresence<
  R extends SchemaRecord = DefaultModels,
  T = Record<string, unknown>,
  C = unknown,
>(
  modelOrSelect: ModelOperations<T, C> | PresenceModelSelector<R, T, C>,
  recordId: string,
): readonly PresenceSession[] {
  const engine = useAbloClientImpl<R>(null);
  return usePresenceImpl(engine, modelOrSelect, recordId);
}

/** @internal Shared by the global hook and schema-bound React factory. */
export function usePresenceImpl<R extends SchemaRecord, T, C>(
  engine: Ablo<R> | null,
  modelOrSelect: ModelOperations<T, C> | PresenceModelSelector<R, T, C>,
  recordId: string,
): readonly PresenceSession[] {
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

  const [, render] = useState(0);

  useEffect(
    () => presence?.subscribe(() => { render((version) => version + 1); }),
    [presence],
  );

  useEffect(() => presence?.read(recordId), [presence, recordId]);

  return presence?.get(recordId) ?? [];
}
