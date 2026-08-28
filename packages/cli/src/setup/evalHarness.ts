/**
 * Diff-authoritative setup-agent evaluation. The runner may be Codex, Claude,
 * or a test double; its transcript and self-reported success never determine
 * the result.
 */

import {
  setupAdaptationTaskSchema,
  setupEvalResultSchema,
  setupEvalVerificationSchema,
  SETUP_CONTRACT_VERSION,
  type SetupAdaptationTask,
  type SetupAgentBundle,
  type SetupEvalResult,
  type SetupEvalVerification,
  type SetupAgentHandoff,
} from './contracts';
import { captureSetupWorkspace, evaluateSetupDiff } from './evaluation';
import { buildSetupAgentBundle } from './skill';

export interface SetupEvalAgentRun {
  readonly status: 'completed' | 'failed' | 'timed_out';
  readonly exitCode: number | null;
  readonly handoff?: SetupAgentHandoff | null;
  readonly telemetry?: {
    readonly documentationLists: number;
    readonly documentationReads: readonly string[];
    readonly documentationReadWords?: number;
    readonly documentationSearches: readonly string[];
    readonly repositoryLists: number;
    readonly repositoryReads: readonly string[];
    readonly writes: readonly string[];
    readonly checks: number;
  };
}

export interface SetupEvalAgentRunner {
  readonly id: string;
  readonly model: string | null;
  run(input: {
    readonly applicationRoot: string;
    readonly bundle: SetupAgentBundle;
    readonly timeoutMs: number;
  }): Promise<SetupEvalAgentRun>;
}

export interface SetupEvalVerifier {
  readonly id: string;
  verify(input: {
    readonly applicationRoot: string;
    readonly record: SetupAdaptationTask;
    readonly agent: SetupEvalAgentRun;
  }): Promise<Omit<SetupEvalVerification, 'id' | 'durationMs'>>;
}

export async function runSetupWritePathEval(input: {
  readonly caseId: string;
  readonly record: SetupAdaptationTask;
  readonly runner: SetupEvalAgentRunner;
  readonly verifiers: readonly SetupEvalVerifier[];
  /** Exact agent bundle under test. Docs evals use this to inject pinned pages. */
  readonly bundle?: SetupAgentBundle;
  readonly timeoutMs?: number;
  readonly expectedOutcome?: 'passed' | 'blocked';
  readonly now?: () => Date;
}): Promise<SetupEvalResult> {
  const record = setupAdaptationTaskSchema.parse(input.record);
  const now = input.now ?? (() => new Date());
  const started = now();
  const before = captureSetupWorkspace(record.repositoryRoot, now);
  const bundle = input.bundle ?? buildSetupAgentBundle(record, now);
  if (bundle.record.recordId !== record.recordId) {
    throw new Error('Setup eval bundle and record must describe the same task.');
  }
  let agent: SetupEvalAgentRun;
  try {
    agent = await input.runner.run({
      applicationRoot: record.applicationRoot,
      bundle,
      timeoutMs: input.timeoutMs ?? 20 * 60_000,
    });
  } catch {
    agent = { status: 'failed', exitCode: null };
  }
  const after = captureSetupWorkspace(record.repositoryRoot, now);
  const diff = evaluateSetupDiff({ before, after, record, now });
  const verification: SetupEvalVerification[] = [];
  for (const verifier of input.verifiers) {
    const verificationStarted = Date.now();
    try {
      const result = await verifier.verify({ applicationRoot: record.applicationRoot, record, agent });
      verification.push(setupEvalVerificationSchema.parse({
        id: verifier.id,
        ...result,
        durationMs: Date.now() - verificationStarted,
      }));
    } catch (error) {
      verification.push(setupEvalVerificationSchema.parse({
        id: verifier.id,
        status: 'error',
        detail: error instanceof Error ? error.message : 'Verifier threw a non-Error value.',
        durationMs: Date.now() - verificationStarted,
      }));
    }
  }
  const finished = now();
  const verificationFailed = verification.some(({ status }) => status !== 'pass');
  const correctlyBlocked = input.expectedOutcome === 'blocked' &&
    agent.status === 'completed' &&
    agent.handoff?.outcome === 'blocked' &&
    agent.handoff.blockers.length > 0 &&
    diff.changes.length === 0 &&
    !verificationFailed;
  const outcome = diff.outcome === 'unsafe'
    ? 'unsafe'
    : correctlyBlocked
      ? 'blocked'
      : agent.status !== 'completed' || verificationFailed
      ? 'failed'
      : diff.outcome === 'incomplete'
        ? 'incomplete'
        : 'passed';

  return setupEvalResultSchema.parse({
    schemaVersion: SETUP_CONTRACT_VERSION,
    kind: 'ablo_setup_eval_result',
    caseId: input.caseId,
    runner: input.runner.id,
    model: input.runner.model,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: Math.max(0, finished.getTime() - started.getTime()),
    inputs: {
      recordId: record.recordId,
      skillId: bundle.skill.id,
      skillVersion: bundle.skill.version,
      files: bundle.skill.files.map(({ path, sha256 }) => ({ path, sha256 })),
    },
    agent: { ...agent, handoff: agent.handoff ?? null },
    diff,
    verification,
    outcome,
    summary: correctlyBlocked
      ? `Agent reported a blocker; no files changed; ${verification.length}/${verification.length} independent blocker gate(s) passed.`
      : `Agent ${agent.status}; diff ${diff.outcome}; ${verification.filter(({ status }) => status === 'pass').length}/${verification.length} verification gate(s) passed.`,
  });
}
