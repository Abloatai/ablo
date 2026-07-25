/**
 * The in-memory reference adapter must pass the shared conformance suite. This
 * both proves the suite is real and locks the reference semantics every ORM
 * adapter is measured against.
 */

import { memoryDataSource } from '../adapters/memory.js';
import { runDataSourceTests } from '../conformance.js';

describe('memoryDataSource conformance', () => {
  runDataSourceTests(memoryDataSource, it);
});
