/**
 * `ablo check` is the database-compatibility projection of the canonical
 * three-state deployment skeleton. It intentionally has no private catalog
 * query, severity vocabulary, or model loop of its own.
 */
import { plan } from './plan/index';

export async function check(argv: readonly string[]): Promise<void> {
  await plan(argv);
}
