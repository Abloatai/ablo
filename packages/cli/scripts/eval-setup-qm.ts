import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  analyzeSetupCompatibility,
  discoverDatabaseColumnsFromSqlSource,
  discoverTransactionalRequirementsFromSqlSource,
} from '../src/setup/compatibility';

const QM_COMMIT = '9ff90fc770d60658ae6c350b691204b5a5b3e394';
const root = resolve(
  process.env.ABLO_SETUP_BENCHMARK_YC_SOFTWARE_QM_ROOT
    ?? '/private/tmp/ablo-setup-benchmark-qm',
);
const observedCommit = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).stdout.trim();
if (observedCommit !== QM_COMMIT) {
  throw new Error(`QM eval requires ${QM_COMMIT}; observed ${observedCommit || 'no commit'}.`);
}

const path = 'src/tasks/postgres-task-store.ts';
const source = readFileSync(resolve(root, path), 'utf8');
const columns = discoverDatabaseColumnsFromSqlSource({ path, source });
const requirements = discoverTransactionalRequirementsFromSqlSource({ path, source });
const compatibility = analyzeSetupCompatibility({
  columns,
  requirements,
});

if (compatibility.status !== 'compatible') {
  throw new Error(`QM mapping remains ${compatibility.status}: ${compatibility.blockers.map(({ code }) => code).join(', ')}`);
}

const result = {
  caseId: 'yc-software-qm-task-store',
  repositoryCommit: observedCommit,
  status: compatibility.status,
  requirements: requirements.map(({ table, conditionalAtomicMutation, transactionBoundTypedResult }) => ({
    table,
    conditionalAtomicMutation,
    transactionBoundTypedResult,
  })),
  mappings: compatibility.mappings.map(({ evidence: _evidence, ...mapping }) => mapping),
};
const encoded = `${JSON.stringify(result, null, 2)}\n`;
if (process.env.ABLO_SETUP_EVAL_OUTPUT) {
  writeFileSync(resolve(process.env.ABLO_SETUP_EVAL_OUTPUT), encoded);
}
process.stdout.write(encoded);
