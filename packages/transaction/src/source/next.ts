/**
 * A thin Next.js App Router wrapper for a Data Source. The core `dataSource()`
 * already returns a standard `(Request) => Promise<Response>`, which the App Router
 * accepts directly, so this helper adds only convenience: it names the handler
 * `POST` so your route file can export it in one line.
 *
 *   // app/api/ablo/source/route.ts
 *   import { dataSourceNext } from '@abloatai/transaction/source/next';
 *   import { prismaDataSource } from '@abloatai/transaction/source';
 *   import { schema } from '@/ablo/schema';
 *   import { prisma } from '@/lib/prisma';
 *
 *   export const { POST } = dataSourceNext({
 *     schema,
 *     apiKey: process.env.ABLO_API_KEY!,
 *     adapter: prismaDataSource(prisma, schema),
 *   });
 *
 * For hand-written handlers, or another framework, call the core `dataSource()`
 * directly and export its result however that framework expects.
 */

import type { SchemaRecord } from '../schema/schema.js';
import { dataSource, type DataSourceOptions } from './factory.js';

/**
 * The options for `dataSourceNext`, which are exactly the core
 * `DataSourceOptions`. Pass `{ schema, apiKey, adapter }`, the same shape
 * `dataSource()` takes.
 */
export type DataSourceNextOptions<S extends SchemaRecord, TAuth = unknown> =
  DataSourceOptions<S, TAuth>;

export function dataSourceNext<const S extends SchemaRecord, TAuth = unknown>(
  options: DataSourceNextOptions<S, TAuth>,
): { readonly POST: (request: Request) => Promise<Response> } {
  return { POST: dataSource(options) };
}
