import {
  datasourceResnapshotResponseSchema,
  type DatasourceResnapshotResponse,
} from '@abloatai/transaction/wire';
import { requestControlPlane } from '../controlPlane';

/** Request or safely resume the registered source's initial snapshot. */
export function requestInitialSnapshot(input: {
  readonly apiKey: string;
  readonly apiUrl?: string;
}): Promise<DatasourceResnapshotResponse> {
  return requestControlPlane({
    path: '/v1/datasources/resnapshot',
    method: 'POST',
    ...(input.apiUrl ? { baseUrl: input.apiUrl } : {}),
    apiKey: input.apiKey,
    body: {},
    responseSchema: datasourceResnapshotResponseSchema,
  });
}
