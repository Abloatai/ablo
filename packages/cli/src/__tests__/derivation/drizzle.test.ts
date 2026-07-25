/**
 * `ablo pull drizzle` against the derivation conformance battery.
 *
 * Wiring only — see `prisma.test.ts` for the shape and `conformance.ts` for the
 * assertions.
 */

import { lowerDrizzleModule } from '../../drizzlePull';
import { ALL_SUITES, runConformance } from './conformance';
import * as tables from './fixtures/drizzle';

runConformance({
  source: 'pull drizzle',
  // Spread rather than cast: the command hands the lowering a module namespace
  // object, and a shallow copy of one is exactly that without a type assertion.
  lower: () => lowerDrizzleModule({ ...tables }),
  suites: ALL_SUITES,
});
