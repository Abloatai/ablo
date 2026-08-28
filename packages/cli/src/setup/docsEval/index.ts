import type { SetupEvalVerification } from '../contracts';

export type DocsEvalFinding = NonNullable<SetupEvalVerification['findings']>[number];

function finding(
  code: string,
  detail: string,
  ...evidencePaths: string[]
): DocsEvalFinding {
  return { code, detail, evidencePaths };
}

/** Grade the documented brownfield route without trusting agent prose. */
export function gradeExistingOperationCoordination(input: {
  readonly source: string;
  readonly operationPath: string;
  readonly protectedChanges: readonly string[];
}): readonly DocsEvalFinding[] {
  const { source, operationPath } = input;
  const findings: DocsEvalFinding[] = [];
  const claimIndex = source.search(/\bablo\.taskRuns\.claim\s*\(/);
  const prepareIndex = source.search(/\bawait\s+prepareInSandbox\s*\(\s*input\s*\)/);
  const commitIndex = source.search(/\bexistingTaskService\.commitPrepared\s*\(/);

  if (claimIndex < 0) {
    findings.push(finding(
      'claim_boundary_missing',
      'No taskRuns claim protects the expensive preparation.',
      operationPath,
    ));
  } else {
    const claimCall = source.slice(claimIndex, prepareIndex > claimIndex ? prepareIndex : undefined);
    if (!/\.claim\s*\(\s*input\.id\s*,/.test(claimCall)) {
      findings.push(finding(
        'wrong_claim_grain',
        'The claim must use the stable task identifier, not a row payload.',
        operationPath,
      ));
    }
    if (!/contention\s*:\s*\{\s*mode\s*:\s*['"]skip['"]/.test(claimCall)) {
      findings.push(finding(
        'contention_behavior_missing',
        'The non-winner behavior is not an explicit skip.',
        operationPath,
      ));
    }
    if (!/ttl\s*:/.test(claimCall) || !/heartbeat\s*:\s*\{\s*every\s*:/.test(claimCall)) {
      findings.push(finding(
        'lease_lifecycle_incomplete',
        'The long-running claim needs both a TTL and heartbeat policy.',
        operationPath,
      ));
    }
  }
  if (!/(?:await\s+using\s+\w+\s*=|finally\s*\{[\s\S]*?\.release\s*\()/.test(source)) {
    findings.push(finding(
      'lease_release_missing',
      'The claim is not released on every exit path.',
      operationPath,
    ));
  }
  if (!(claimIndex >= 0 && prepareIndex > claimIndex && commitIndex > prepareIndex)) {
    findings.push(finding(
      'operation_order_wrong',
      'Expected claim, then preparation, then the existing commit operation.',
      operationPath,
    ));
  }
  const skippedBranch = /if\s*\(\s*!\w+\s*\)\s*(?:return\s+\{[\s\S]{0,300}?outcome\s*:\s*['"]skipped['"]|\{[\s\S]{0,600}?return\s+\{[\s\S]{0,300}?outcome\s*:\s*['"]skipped['"])/;
  if (!skippedBranch.test(source)) {
    findings.push(finding(
      'contention_result_missing',
      'A skipped claim must return the existing skipped result without preparing.',
      operationPath,
    ));
  }
  if (commitIndex < 0) {
    findings.push(finding(
      'ownership_boundary_bypassed',
      'The existing task service is no longer the final write path.',
      operationPath,
    ));
  }
  if (/\bablo\.[A-Za-z_$][\w$]*\.(?:create|update|delete)\s*\(|\bablo\.commits\.create\s*\(/.test(source)) {
    findings.push(finding(
      'existing_transaction_replaced',
      'The implementation added an Ablo write instead of preserving the Postgres-owned operation.',
      operationPath,
    ));
  }
  if (/\b(?:subscribe|watch|onChange)\s*\(/.test(source)) {
    findings.push(finding(
      'worker_uses_reactive_transport',
      'The stateless worker route introduced reactive transport behavior.',
      operationPath,
    ));
  }
  for (const path of input.protectedChanges) {
    findings.push(finding(
      path === 'src/graphql/resolver.ts' || path === 'src/tasks/contract.ts'
        ? 'public_api_changed'
        : path === 'src/tasks/existingTaskService.ts' || path === 'src/db.ts'
          ? 'existing_transaction_replaced'
          : 'protected_owner_changed',
      `${path} changed even though the coordination wrapper owns this integration.`,
      path,
    ));
  }
  return findings;
}

/** Grade identifier coordination added to Sandcastle's real parallel planner. */
export function gradeSandcastleIssueCoordination(input: {
  readonly source: string;
  readonly operationPath: string;
  readonly protectedChanges: readonly string[];
}): readonly DocsEvalFinding[] {
  const { source, operationPath } = input;
  const findings: DocsEvalFinding[] = [];
  if (source.split('\n').length < 50) {
    findings.push(finding(
      'source_structure_corrupted',
      'The real multiline planner source was collapsed instead of edited as TypeScript.',
      operationPath,
    ));
  }
  const claimIndex = source.search(/\bablo\.taskRuns\.claim\s*\(/);
  const implementerIndex = source.search(
    /\bsandcastle\.run\s*\(\s*\{[\s\S]{0,1200}?name\s*:\s*["']implementer["']/,
  );
  const mergeIndex = source.search(
    /\bsandcastle\.run\s*\(\s*\{[\s\S]{0,1200}?name\s*:\s*["']merger["']/,
  );

  if (claimIndex < 0) {
    findings.push(finding(
      'claim_boundary_missing',
      'No taskRuns claim protects the per-issue Sandcastle implementation run.',
      operationPath,
    ));
  } else {
    const claimCall = source.slice(
      claimIndex,
      implementerIndex > claimIndex ? implementerIndex : undefined,
    );
    if (!/\.claim\s*\(\s*issue\.id\s*,/.test(claimCall)) {
      findings.push(finding(
        'wrong_claim_grain',
        'The claim must use the planned issue identifier.',
        operationPath,
      ));
    }
    if (!/contention\s*:\s*\{\s*mode\s*:\s*["']skip["']/.test(claimCall)) {
      findings.push(finding(
        'contention_behavior_missing',
        'A second planner must skip an issue already being implemented.',
        operationPath,
      ));
    }
    if (!/ttl\s*:/.test(claimCall) || !/heartbeat\s*:\s*\{\s*every\s*:/.test(claimCall)) {
      findings.push(finding(
        'lease_lifecycle_incomplete',
        'The sandbox run needs both a TTL and heartbeat policy.',
        operationPath,
      ));
    }
  }
  if (!/(?:await\s+using\s+\w+\s*=|finally\s*\{[\s\S]*?\.release\s*\()/.test(source)) {
    findings.push(finding(
      'lease_release_missing',
      'The issue claim is not released on every exit path.',
      operationPath,
    ));
  }
  if (!(claimIndex >= 0 && implementerIndex > claimIndex)) {
    findings.push(finding(
      'operation_order_wrong',
      'Expected the issue claim before the existing implementer run.',
      operationPath,
    ));
  }
  const emptySkip = /if\s*\(\s*!\w+\s*\)\s*(?:return\s*(?:;|(?:null|undefined)\s*;?)|\{[\s\S]{0,300}?return\s*(?:;|(?:null|undefined)\s*;?))/;
  const markedSkip = /if\s*\(\s*!\w+\s*\)\s*\{[\s\S]{0,500}?return\s+\{[\s\S]{0,250}?skipped\s*:\s*true[\s\S]{0,100}?\}/;
  const skippedValue = String.raw`(?:entry\.outcome\.value|outcome\.value|value)\.skipped`;
  const excludesMarkedSkip = new RegExp(
    String.raw`(?:!\s*${skippedValue}|${skippedValue}\s*(?:===\s*false|!==\s*true))`,
  );
  const noCommitSkip = /if\s*\(\s*!\w+\s*\)\s*\{[\s\S]{0,500}?return\s+\{[\s\S]{0,150}?commits\s*:\s*\[\s*\][\s\S]{0,100}?\}/;
  const excludesNoCommitSkip = /outcome\.value\.commits\.length\s*>\s*0/;
  if (
    !emptySkip.test(source)
    && !(markedSkip.test(source) && excludesMarkedSkip.test(source))
    && !(noCommitSkip.test(source) && excludesNoCommitSkip.test(source))
  ) {
    findings.push(finding(
      'contention_result_missing',
      'A contended issue must leave the execution result empty so it is not merged.',
      operationPath,
    ));
  }
  if (mergeIndex < 0 || !source.includes('completedIssues')) {
    findings.push(finding(
      'ownership_boundary_bypassed',
      'The existing completed-issue and merge workflow is no longer the commit path.',
      operationPath,
    ));
  }
  if (/\bablo\.[A-Za-z_$][\w$]*\.(?:create|update|delete)\s*\(|\bablo\.commits\.create\s*\(/.test(source)) {
    findings.push(finding(
      'existing_commit_path_replaced',
      'The implementation added an Ablo write instead of preserving Sandcastle branch merging.',
      operationPath,
    ));
  }
  for (const path of input.protectedChanges) {
    findings.push(finding(
      'protected_owner_changed',
      `${path} changed even though the parallel-planner template owns this integration.`,
      path,
    ));
  }
  return findings;
}
