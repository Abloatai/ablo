import { Ablo, createAbloReact } from '@abloatai/ablo/react';
import { schema } from '../schema.js';
export const { AbloProvider, useAblo, usePresence } = createAbloReact(schema);
export function createClient(account: string) {
  return Ablo({ schema, persistence: 'memory', baseURL: import.meta.env.VITE_ABLO_BASE_URL || undefined, session: { endpoint: `/api/accounts/${encodeURIComponent(account)}/session` } });
}
export async function post(path: string, data = {}) {
  const response = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error(await response.text());
  return response;
}
