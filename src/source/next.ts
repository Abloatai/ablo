/**
 * Next.js App Router adapter for Data Source. The core `dataSource()` already
 * returns a Web-standard `(Request) => Promise<Response>`, which Next App Router
 * accepts directly — so this is pure ergonomics: wire an ORM `adapter` in via the
 * bridge and hand back a named `POST` so the customer's route file is the minimum:
 *
 *   // app/api/ablo/source/route.ts
 *   import { dataSourceNext } from '@abloatai/ablo/source/next';
 *   import { prismaDataSource } from '@abloatai/ablo/source';
 *   import { schema } from '@/ablo/schema';
 *   import { prisma } from '@/lib/prisma';
 *
 *   export const { POST } = dataSourceNext({
 *     schema,
 *     apiKey: process.env.ABLO_API_KEY!,
 *     adapter: prismaDataSource(prisma, schema),
 *   });
 *
 * Day-one scope: Next + the adapter form only. Hand-written handlers use the core
 * `dataSource()` directly; Hono/Express are the same one-liner and land on demand
 * — not pre-built.
 */

import type { SchemaRecord } from '../schema/schema.js';
import { dataSource, type DataSourceOptions } from './index.js';

/**
 * Next options ARE the core options — the `adapter` field lives on the core
 * handler now, so there is no bridging, no cast, and no per-model-typed boundary
 * at the call site. Pass `{ schema, apiKey, adapter }`.
 */
export type DataSourceNextOptions<S extends SchemaRecord, TAuth = unknown> =
  DataSourceOptions<S, TAuth>;

export function dataSourceNext<const S extends SchemaRecord, TAuth = unknown>(
  options: DataSourceNextOptions<S, TAuth>,
): { readonly POST: (request: Request) => Promise<Response> } {
  return { POST: dataSource(options) };
}
