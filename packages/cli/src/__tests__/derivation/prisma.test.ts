/**
 * `ablo pull prisma` against the derivation conformance battery.
 *
 * Wiring only — a fixture and a suite list. Every assertion lives in
 * `conformance.ts`, shared with every other source. A suite this source cannot
 * satisfy is commented out here with the reason, so the gap is a line a
 * reviewer sees rather than a skip buried in a shared file.
 */

import { parsePrismaSchema } from '../../prismaPull';
import { ALL_SUITES, runConformance } from './conformance';
import { PRISMA_SCHEMA } from './fixtures/prisma';

runConformance({
  source: 'pull prisma',
  lower: () => parsePrismaSchema(PRISMA_SCHEMA),
  suites: ALL_SUITES,
});
