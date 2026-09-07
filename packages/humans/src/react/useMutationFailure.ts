'use client';

import { useEffect, useEffectEvent } from 'react';
import type { AbloClient } from '../client.js';
import type { SchemaRecord } from '@abloatai/transaction/schema/schema';
import { useAbloClient } from './useAbloClient.js';

/** Subscribe for this component's lifetime using the latest committed listener.
 * Replacing the provider client moves the subscription; unmount removes it.
 */
export function useMutationFailure(
  listener: Parameters<AbloClient<SchemaRecord>['onMutationFailure']>[0],
): void {
  const client = useAbloClient();
  const onFailure = useEffectEvent(listener);
  useEffect(() => client?.onMutationFailure(onFailure), [client]);
}
