import type { ParsedTask, WorkflowConfig } from '../../contracts.ts';

export type FinalizeCheckEscalation = 'all-tasks-terminal' | 'explicit' | null;

export type FinalizeCheckPolicy = Readonly<{
  requiredChecks: readonly string[];
  checkEscalation: FinalizeCheckEscalation;
}>;

/**
 * Resolve the check set for one exact projected task tree. Intermediate
 * projections retain the task checks exactly. A terminal policy may replace
 * only checks it explicitly covers, while preserving every independent task
 * check; an explicit request applies that same escalation early.
 */
export function resolveFinalizeCheckPolicy(
  tasks: readonly ParsedTask[],
  taskRequiredChecks: readonly string[],
  config: Pick<WorkflowConfig, 'allTasksTerminalChecks'>,
  forceTerminalChecks = false,
): FinalizeCheckPolicy {
  const terminalChecks = config.allTasksTerminalChecks ?? [];
  const allTasksTerminal =
    tasks.length > 0 && tasks.every((task) => task.completed);
  const shouldEscalate = allTasksTerminal || forceTerminalChecks;
  const requiredChecks = shouldEscalate
    ? escalatedChecks(taskRequiredChecks, terminalChecks)
    : [...taskRequiredChecks];
  return Object.freeze({
    requiredChecks: Object.freeze(requiredChecks),
    checkEscalation:
      shouldEscalate && terminalChecks.length > 0
        ? allTasksTerminal
          ? 'all-tasks-terminal'
          : 'explicit'
        : null,
  });
}

export function resolveExplicitFinalizeChecks(
  taskRequiredChecks: readonly string[],
  config: Pick<WorkflowConfig, 'allTasksTerminalChecks'>,
): readonly string[] {
  return Object.freeze(
    escalatedChecks(taskRequiredChecks, config.allTasksTerminalChecks ?? []),
  );
}

function escalatedChecks(
  taskRequiredChecks: readonly string[],
  terminalChecks: NonNullable<WorkflowConfig['allTasksTerminalChecks']>,
): string[] {
  const subsumed = new Set(terminalChecks.flatMap((policy) => policy.subsumes));
  return orderedUnion(
    taskRequiredChecks.filter((checkId) => !subsumed.has(checkId)),
    terminalChecks.map((policy) => policy.checkId),
  );
}

function orderedUnion(
  first: readonly string[],
  second: readonly string[],
): string[] {
  const seen = new Set<string>();
  return [...first, ...second].filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
