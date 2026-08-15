import {
  SETUP_CONTRACT_VERSION,
  setupCheckpointSchema,
  setupStepResultSchema,
  type SetupAction,
  type SetupCheckpoint,
  type SetupStepResult,
} from './contracts';

export interface SetupProgramContext<State> {
  readonly programId: string;
  readonly repositoryRoot: string;
  readonly createdAt: string;
  readonly state: State;
  readonly results: ReadonlyMap<string, SetupStepResult>;
  /** Register temporary-state cleanup. Cleanups run once, in reverse order. */
  registerCleanup(cleanup: () => void | Promise<void>): void;
}

export interface SetupProgramStep<State> {
  readonly id: string;
  readonly label: string;
  /** Maximum effect this step itself may perform. Planned future actions do not count. */
  readonly mutation: SetupAction['mutation'];
  readonly approval: SetupAction['approval'];
  readonly dependsOn?: readonly string[];
  readonly show?: (context: SetupProgramContext<State>) => boolean;
  /** Return a typed terminal result to decline the run, or null to proceed. */
  readonly precondition?: (
    context: SetupProgramContext<State>,
  ) => SetupStepResult | null | Promise<SetupStepResult | null>;
  run(context: SetupProgramContext<State>): Promise<SetupStepResult> | SetupStepResult;
  /** Verify and, when needed, refine the result after the effect completes. */
  readonly postcondition?: (
    context: SetupProgramContext<State>,
    result: SetupStepResult,
  ) => SetupStepResult | Promise<SetupStepResult>;
}

export interface SetupProgram<State> {
  readonly id: string;
  readonly steps: readonly SetupProgramStep<State>[];
}

export interface ExecuteSetupProgramOptions {
  readonly onCheckpoint?: (checkpoint: SetupCheckpoint) => void | Promise<void>;
  readonly now?: () => Date;
  /** A validated prior checkpoint. Completed steps are retained; all other steps rerun. */
  readonly resumeFrom?: SetupCheckpoint;
}

function blockedDependencyResult(
  step: SetupProgramStep<unknown>,
  dependencyIds: readonly string[],
  now: string,
): SetupStepResult {
  return setupStepResultSchema.parse({
    stepId: step.id,
    status: 'blocked',
    summary: `${step.label} did not run because a dependency is incomplete.`,
    blockers: dependencyIds.map((id) => `step:${id}`),
    next: `Resolve ${dependencyIds.join(', ')} and resume setup.`,
    facts: [],
    decisions: [],
    actions: [],
    startedAt: now,
    finishedAt: now,
  });
}

export async function executeSetupProgram<State>(
  program: SetupProgram<State>,
  input: { readonly repositoryRoot: string; readonly state: State },
  options: ExecuteSetupProgramOptions = {},
): Promise<readonly SetupStepResult[]> {
  const now = options.now ?? (() => new Date());
  const resumed = options.resumeFrom
    ? setupCheckpointSchema.parse(options.resumeFrom)
    : null;
  if (resumed && resumed.programId !== program.id) {
    throw new Error(`Checkpoint belongs to ${resumed.programId}, not ${program.id}.`);
  }
  if (resumed && resumed.repositoryRoot !== input.repositoryRoot) {
    throw new Error('Checkpoint repository root does not match this setup target.');
  }
  const createdAt = resumed?.createdAt ?? now().toISOString();
  const results = new Map<string, SetupStepResult>();
  const cleanups: Array<() => void | Promise<void>> = [];
  const knownIds = new Set(program.steps.map(({ id }) => id));
  if (knownIds.size !== program.steps.length) {
    throw new Error(`Setup program ${program.id} contains duplicate step IDs.`);
  }
  for (const step of program.steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (!knownIds.has(dependency)) {
        throw new Error(`Setup step ${step.id} depends on unknown step ${dependency}.`);
      }
    }
  }
  for (const prior of resumed?.results ?? []) {
    if (!knownIds.has(prior.stepId)) {
      throw new Error(`Checkpoint contains unknown step ${prior.stepId}.`);
    }
    if (prior.status === 'complete') results.set(prior.stepId, prior);
  }

  let primaryError: unknown;
  try {
    for (const step of program.steps) {
      if (results.has(step.id)) continue;
      const context: SetupProgramContext<State> = {
        programId: program.id,
        repositoryRoot: input.repositoryRoot,
        createdAt,
        state: input.state,
        results,
        registerCleanup: (cleanup) => cleanups.push(cleanup),
      };
      if (step.show && !step.show(context)) continue;

      const blockedBy = (step.dependsOn ?? []).filter(
        (id) => results.get(id)?.status !== 'complete',
      );
      let result: SetupStepResult;
      if (blockedBy.length > 0) {
        result = blockedDependencyResult(
          step as SetupProgramStep<unknown>,
          blockedBy,
          now().toISOString(),
        );
      } else {
        const declined = step.precondition
          ? setupStepResultSchema.nullable().parse(await step.precondition(context))
          : null;
        result = declined ?? setupStepResultSchema.parse(await step.run(context));
        if (!declined && step.postcondition) {
          result = setupStepResultSchema.parse(await step.postcondition(context, result));
        }
      }
      if (result.stepId !== step.id) {
        throw new Error(`Setup step ${step.id} returned a result for ${result.stepId}.`);
      }
      results.set(step.id, result);

      if (options.onCheckpoint) {
        const values = [...results.values()];
        await options.onCheckpoint(setupCheckpointSchema.parse({
          schemaVersion: SETUP_CONTRACT_VERSION,
          kind: 'ablo_setup_checkpoint',
          programId: program.id,
          repositoryRoot: input.repositoryRoot,
          createdAt,
          updatedAt: now().toISOString(),
          completedStepIds: values
            .filter(({ status }) => status === 'complete')
            .map(({ stepId }) => stepId),
          results: values,
        }));
      }
    }
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (primaryError !== undefined) {
      if (cleanupErrors.length > 0) {
        throw new AggregateError([primaryError, ...cleanupErrors], 'Setup and cleanup failed.');
      }
      throw primaryError;
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Setup cleanup failed.');
    }
  }
  return [...results.values()];
}
