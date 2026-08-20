import type { WorkflowError } from '../../../foundation/errors/errors.ts';
import type {
  ManagedAuthorityPlanState,
  ManagedTaskDiffReviewState,
  ManagedTaskStrategyState,
} from '../../lifecycle/managed-workflow-state-contract.ts';
import {
  managedWorkflowCommandUsageLines,
  renderManagedWorkflowGuidanceCatalog,
  resolveManagedWorkflowCommand,
} from '../catalog/managed-workflow-command-registry.ts';
export type {
  WorkflowCommandDeprecation,
  WorkflowCommandGuidance,
  WorkflowGuidanceCatalog,
  WorkflowGuidanceStatus,
} from '../catalog/managed-workflow-command-registry.ts';

export type WorkflowNextStep = Readonly<{
  command: string;
  why: string;
}>;

export type WorkflowNextStepBindings = Readonly<{
  sessionId?: string;
  changeId?: string;
  taskId?: string;
  investigationOrTaskId?: string;
}>;

type TaskStrategyGuidanceKind =
  | 'resume'
  | 'waiting'
  | 'retry'
  | 'grant-required'
  | 'exhausted'
  | 'task-complete'
  | 'status-only';

const TASK_STRATEGY_STATE_GUIDANCE = {
  'not-required': 'task-complete',
  'session-terminal': 'status-only',
  'transformation-required': 'resume',
  'transformation-produced': 'task-complete',
  'red-authoring': 'resume',
  'implementation-required': 'resume',
  ready: 'resume',
  'reservation-persisted': 'resume',
  'collaboration-grant-required': 'grant-required',
  'waiting-for-provider': 'waiting',
  'provider-succeeded-awaiting-import': 'resume',
  'provider-failed': 'retry',
  'correction-required': 'resume',
  'correction-exhausted': 'exhausted',
  'caller-supplied-awaiting-import': 'resume',
  'patch-imported': 'task-complete',
} as const satisfies Record<ManagedTaskStrategyState, TaskStrategyGuidanceKind>;

type TaskDiffReviewGuidanceKind =
  | 'satisfied'
  | 'default'
  | 'direct-human'
  | 'reconcile'
  | 'external-grant'
  | 'waiting'
  | 'inspect';

const TASK_DIFF_REVIEW_STATE_GUIDANCE = {
  'not-required': 'satisfied',
  ready: 'default',
  'collaboration-grant-required': 'waiting',
  'external-grant-resume-required': 'external-grant',
  'direct-human-attestation-required': 'direct-human',
  'external-reconciliation-required': 'waiting',
  satisfied: 'satisfied',
  'challenge-response-required': 'inspect',
  'challenge-closure-required': 'waiting',
  'changes-required': 'waiting',
  'waiting-for-provider': 'waiting',
  'provider-succeeded-awaiting-reconciliation': 'reconcile',
  'provider-failed': 'waiting',
} as const satisfies Record<
  ManagedTaskDiffReviewState,
  TaskDiffReviewGuidanceKind
>;

type AuthorityPlanGuidanceKind =
  'approve' | 'resume-publication' | 'attest' | 'status-only';

const AUTHORITY_PLAN_STATE_GUIDANCE = {
  prepared: 'approve',
  'applying-local': 'approve',
  'local-applied': 'resume-publication',
  'awaiting-attestation': 'attest',
  'attestation-issued': 'resume-publication',
  completed: 'status-only',
} as const satisfies Record<
  ManagedAuthorityPlanState,
  AuthorityPlanGuidanceKind
>;

export const WORKFLOW_GUIDANCE_CATALOG = renderManagedWorkflowGuidanceCatalog();

export function workflowCommandGuidance(id: string) {
  return resolveManagedWorkflowCommand(id);
}

export function workflowGuidanceUsageLines(): readonly string[] {
  return managedWorkflowCommandUsageLines();
}

export function projectWorkflowNextSteps(
  requestedCommandIds: readonly string[],
  bindings: WorkflowNextStepBindings = {},
): readonly WorkflowNextStep[] {
  const commandIds = requestedCommandIds.filter(
    (id, index) => requestedCommandIds.indexOf(id) === index,
  );
  return limitNextSteps(commandIds.map((id) => nextStep(id, bindings)));
}

export function workflowResultNextSteps(
  result: Readonly<Record<string, unknown>>,
  invocation: readonly string[] = [],
): readonly WorkflowNextStep[] {
  const commandId = typeof result.command === 'string' ? result.command : null;
  if (commandId === 'guide') return Object.freeze([]);
  const bindings = resultBindings(result, invocation);
  if (commandId === 'status') return statusNextSteps(result, bindings);
  if (commandId === 'review-diff') {
    return taskDiffReviewNextSteps(result, bindings, invocation);
  }
  if (commandId === 'maintainer' && result.action === 'review-diff-attest') {
    return taskDiffReviewNextSteps(result, bindings, invocation);
  }
  if (commandId === 'authority-plan') {
    return authorityPlanNextSteps(record(result.result));
  }
  if (commandId === 'resume') {
    return taskStrategyNextSteps(record(result.result), bindings);
  }
  const entry =
    commandId === null
      ? null
      : (WORKFLOW_GUIDANCE_CATALOG.commands.find(
          ({ id }) => id === commandId,
        ) ?? null);
  return projectWorkflowNextSteps(
    entry !== null && entry.successors.length > 0
      ? entry.successors
      : ['guide'],
    bindings,
  );
}

function authorityPlanNextSteps(
  plan: Readonly<Record<string, unknown>> | undefined,
): readonly WorkflowNextStep[] {
  const planId = stringField(plan, 'planId');
  const state = stringField(plan, 'state');
  const guidance = stateGuidance(AUTHORITY_PLAN_STATE_GUIDANCE, state);
  if (planId === undefined) return projectWorkflowNextSteps(['guide']);
  const status = explicitNextStep(
    'authority-plan',
    `pnpm workflow authority-plan status ${shellQuote(planId)} --json`,
  );
  if (guidance === 'approve') {
    return limitNextSteps([
      explicitNextStep(
        'authority-plan',
        `pnpm workflow authority-plan approve-and-apply ${shellQuote(planId)} --json`,
      ),
      status,
    ]);
  }
  if (guidance === 'resume-publication' && state === 'local-applied') {
    const publishCommand = stringField(
      record(plan?.localApplication),
      'publishCommand',
    );
    return limitNextSteps([
      ...(publishCommand === undefined
        ? []
        : [explicitNextStep('authority-plan', publishCommand)]),
      explicitNextStep(
        'authority-plan',
        `pnpm workflow authority-plan resume ${shellQuote(planId)} --json`,
      ),
      status,
    ]);
  }
  if (guidance === 'attest') {
    return limitNextSteps([
      explicitNextStep(
        'authority-plan',
        `pnpm workflow authority-plan attest ${shellQuote(planId)} --json`,
      ),
      status,
    ]);
  }
  if (guidance === 'resume-publication' && state === 'attestation-issued') {
    const publishCommand = stringField(
      record(plan?.attestation),
      'publishCommand',
    );
    return limitNextSteps([
      ...(publishCommand === undefined
        ? []
        : [explicitNextStep('authority-plan', publishCommand)]),
      explicitNextStep(
        'authority-plan',
        `pnpm workflow authority-plan resume ${shellQuote(planId)} --json`,
      ),
      status,
    ]);
  }
  return Object.freeze([status]);
}

export function workflowFailureRecoveryCommand(
  error: Pick<WorkflowError, 'code' | 'recovery'>,
  invocation: readonly string[],
): string {
  const sessionId = sessionIdFromInvocation(invocation);
  if (
    sessionId !== undefined &&
    ['TASK_DIFF_REVIEW_REQUIRED', 'TASK_DIFF_REVIEW_CHALLENGE_OPEN'].includes(
      error.code,
    )
  ) {
    return nextStep('review-diff', { sessionId }).command;
  }
  if (
    sessionId !== undefined &&
    error.code === 'TASK_DIFF_REVIEW_CHANGES_REQUIRED'
  ) {
    return nextStep('status', { sessionId }).command;
  }
  if (sessionId !== undefined && error.code === 'FINALIZE_RECOVERY_REQUIRED') {
    return nextStep('finalize-recover', { sessionId }).command;
  }
  if (
    sessionId !== undefined &&
    ['REVISION_LEASE_EXPIRED', 'REVISION_REQUIRES_APPROVAL'].includes(
      error.code,
    )
  ) {
    return nextStep('status', { sessionId }).command;
  }
  if (error.code === 'MAINTAINER_INTERACTIVE_REQUIRED') {
    const replay = renderWorkflowInvocation(invocation);
    if (replay !== null) return replay;
  }
  if (isLiteralWorkflowRecovery(error.recovery)) return error.recovery;
  return nextStep('guide', {}).command;
}

function statusNextSteps(
  result: Readonly<Record<string, unknown>>,
  bindings: WorkflowNextStepBindings,
): readonly WorkflowNextStep[] {
  const candidates: WorkflowNextStep[] = [];
  const finalize = record(result.finalize);
  const finalizeRecovery = stringField(finalize, 'recoveryCommand');
  if (finalizeRecovery !== undefined) {
    candidates.push(explicitNextStep('finalize-recover', finalizeRecovery));
  }
  const openTask = record(result.openTask);
  const openTaskRecovery = stringField(openTask, 'recoveryCommand');
  if (openTaskRecovery !== undefined) {
    candidates.push(explicitNextStep('open-task', openTaskRecovery));
  }
  const strategy = record(result.taskStrategy);
  if (strategy !== undefined) {
    candidates.push(...taskStrategyNextSteps(strategy, bindings));
    return limitNextSteps(candidates);
  }
  const taskRevision = record(result.taskRevision);
  const revisionRetry = stringField(taskRevision, 'retryCommand');
  if (taskRevision?.retrySafe === true && revisionRetry !== undefined) {
    candidates.push(explicitNextStep('resume-task', revisionRetry));
  }
  const session = record(result.session);
  if (session?.state === 'active') {
    candidates.push(
      ...projectWorkflowNextSteps(
        ['check', 'review-diff', 'finalize'],
        bindings,
      ),
    );
  } else if (session?.state === 'revising') {
    candidates.push(
      ...projectWorkflowNextSteps(['resume-task', 'status'], bindings),
    );
  }
  return limitNextSteps(
    candidates.length > 0 ? candidates : [nextStep('guide', bindings)],
  );
}

function taskStrategyNextSteps(
  strategy: Readonly<Record<string, unknown>> | undefined,
  bindings: WorkflowNextStepBindings,
): readonly WorkflowNextStep[] {
  const state = stringField(strategy, 'state');
  const guidance = stateGuidance(TASK_STRATEGY_STATE_GUIDANCE, state);
  if (guidance === 'resume') {
    return projectWorkflowNextSteps(['resume', 'status'], bindings);
  }
  if (guidance === 'waiting') {
    return projectWorkflowNextSteps(['status', 'resume'], bindings);
  }
  if (guidance === 'retry') {
    return projectWorkflowNextSteps(['resume', 'status', 'guide'], bindings);
  }
  if (guidance === 'grant-required') {
    return projectWorkflowNextSteps(['status', 'guide'], bindings);
  }
  if (guidance === 'exhausted') {
    if (bindings.sessionId === undefined) {
      return projectWorkflowNextSteps(['status', 'guide'], bindings);
    }
    return Object.freeze([
      nextStep('status', bindings),
      explicitNextStep(
        'abort',
        `pnpm workflow abort ${shellQuote(bindings.sessionId)} --reason 'Correction budget exhausted' --json`,
      ),
      nextStep('guide', bindings),
    ]);
  }
  if (guidance === 'task-complete') {
    return projectWorkflowNextSteps(['check', 'finalize', 'status'], bindings);
  }
  return projectWorkflowNextSteps(['status'], bindings);
}

function taskDiffReviewNextSteps(
  result: Readonly<Record<string, unknown>>,
  bindings: WorkflowNextStepBindings,
  invocation: readonly string[],
): readonly WorkflowNextStep[] {
  const reviewResult = record(result.result);
  const subject = record(reviewResult?.subject);
  const requirement =
    record(reviewResult?.reviewRequirement) ??
    record(subject?.reviewRequirement);
  const satisfied =
    reviewResult?.state === 'satisfied' ||
    reviewResult?.state === 'not-required' ||
    requirement?.required === false;
  if (satisfied) {
    return projectWorkflowNextSteps(['finalize', 'status'], bindings);
  }
  const sessionId = bindings.sessionId;
  if (sessionId === undefined) {
    return projectWorkflowNextSteps(['status', 'guide'], bindings);
  }
  const reviewStatus = explicitNextStep(
    'review-diff',
    `pnpm workflow review-diff status ${shellQuote(sessionId)} --json`,
  );
  const generalStatus = nextStep('status', bindings);
  const state = stringField(reviewResult, 'state');
  const guidance = stateGuidance(TASK_DIFF_REVIEW_STATE_GUIDANCE, state);
  if (guidance === 'direct-human') {
    const grantId = stringField(reviewResult, 'grantId');
    const inputPath = invocationOptionValue(invocation, '--input');
    if (grantId !== undefined && inputPath !== undefined) {
      return limitNextSteps([
        explicitNextStep(
          'maintainer-review-diff-attest',
          `pnpm workflow maintainer review-diff-attest ${shellQuote(sessionId)} --input ${shellQuote(inputPath)} --grant ${shellQuote(grantId)} --json`,
        ),
        reviewStatus,
        generalStatus,
      ]);
    }
  }
  if (guidance === 'reconcile') {
    return limitNextSteps([
      explicitNextStep(
        'review-diff',
        `pnpm workflow review-diff reconcile ${shellQuote(sessionId)} --json`,
      ),
      reviewStatus,
      generalStatus,
    ]);
  }
  if (guidance === 'external-grant') {
    const grantId = stringField(reviewResult, 'grantId');
    if (grantId !== undefined) {
      return limitNextSteps([
        explicitNextStep(
          'review-diff',
          `pnpm workflow review-diff ${shellQuote(sessionId)} --grant ${shellQuote(grantId)} --json`,
        ),
        reviewStatus,
        generalStatus,
      ]);
    }
  }
  if (guidance === 'waiting' || guidance === 'direct-human') {
    return limitNextSteps([reviewStatus, generalStatus, nextStep('guide', {})]);
  }
  if (guidance === 'inspect') {
    return limitNextSteps([
      explicitNextStep(
        'review-diff',
        `pnpm workflow review-diff inspect ${shellQuote(sessionId)} --json`,
      ),
      reviewStatus,
      nextStep('guide', {}),
    ]);
  }
  return projectWorkflowNextSteps(['review-diff', 'status'], bindings);
}

function limitNextSteps(
  candidates: readonly WorkflowNextStep[],
): readonly WorkflowNextStep[] {
  const unique = candidates.filter(
    ({ command }, index) =>
      candidates.findIndex((candidate) => candidate.command === command) ===
      index,
  );
  if (unique.length <= 3) return Object.freeze(unique);
  return Object.freeze([unique[0]!, unique[1]!, nextStep('guide', {})]);
}

function explicitNextStep(
  commandId: string,
  renderedCommand: string,
): WorkflowNextStep {
  return Object.freeze({
    command: renderedCommand,
    why: workflowCommandGuidance(commandId).purpose,
  });
}

function nextStep(
  commandId: string,
  bindings: WorkflowNextStepBindings,
): WorkflowNextStep {
  const guidance = workflowCommandGuidance(commandId);
  let rendered = guidance.usage[0]!;
  const replacements: ReadonlyArray<readonly [string, string | undefined]> = [
    ['<session-id>', bindings.sessionId],
    ['<change-id>', bindings.changeId],
    ['<task-id>', bindings.taskId],
    [
      '<investigation-or-task-id>',
      bindings.investigationOrTaskId ?? bindings.sessionId,
    ],
    [
      '[investigation-or-task-id]',
      bindings.investigationOrTaskId ?? bindings.sessionId,
    ],
  ];
  for (const [placeholder, value] of replacements) {
    if (value !== undefined) rendered = rendered.replaceAll(placeholder, value);
  }
  rendered = rendered
    .replaceAll('[--json]', '--json')
    .replaceAll(/\s+\[[^\]]+\]/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim();
  return Object.freeze({ command: rendered, why: guidance.purpose });
}

function resultBindings(
  result: Readonly<Record<string, unknown>>,
  invocation: readonly string[],
): WorkflowNextStepBindings {
  const nestedResult = record(result.result);
  const candidates = [
    result,
    nestedResult,
    record(result.session),
    record(result.openTask),
    record(nestedResult?.session),
    record(nestedResult?.subject),
  ].filter((candidate): candidate is Readonly<Record<string, unknown>> =>
    Boolean(candidate),
  );
  const sessionId =
    firstString(candidates, 'sessionId') ?? sessionIdFromInvocation(invocation);
  const changeId = firstString(candidates, 'changeId');
  const taskId = firstString(candidates, 'taskId');
  const investigationId = firstString(candidates, 'investigationId');
  return Object.freeze({
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(changeId === undefined ? {} : { changeId }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(sessionId === undefined && investigationId === undefined
      ? {}
      : { investigationOrTaskId: sessionId ?? investigationId }),
  });
}

function sessionIdFromInvocation(
  invocation: readonly string[],
): string | undefined {
  if (invocation[0] === 'review-diff') {
    return ['inspect', 'status', 'reconcile'].includes(invocation[1] ?? '')
      ? invocation[2]
      : invocation[1];
  }
  if (
    invocation[0] === 'maintainer' &&
    invocation[1] === 'review-diff-attest'
  ) {
    return invocation[2];
  }
  return [
    'revise-task',
    'resume-task',
    'resume',
    'status',
    'check',
    'complete-task',
    'finish',
    'finalize',
    'finalize-recover',
    'finalize-task',
    'rollback-completion',
    'commit',
    'abort',
  ].includes(invocation[0] ?? '')
    ? invocation[1]
    : undefined;
}

function invocationOptionValue(
  invocation: readonly string[],
  option: string,
): string | undefined {
  const index = invocation.indexOf(option);
  const value = index === -1 ? undefined : invocation[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

function isLiteralWorkflowRecovery(value: string | undefined): value is string {
  if (value === undefined || value !== value.trim()) return false;
  const tokens = value.split(' ');
  return (
    tokens.length >= 4 &&
    tokens[0] === 'pnpm' &&
    tokens[1] === 'workflow' &&
    tokens.at(-1) === '--json' &&
    tokens.every((token) => /^[A-Za-z0-9_./:@=+-]+$/.test(token))
  );
}

function renderWorkflowInvocation(
  invocation: readonly string[],
): string | null {
  if (
    invocation.length === 0 ||
    invocation.some((argument) => /[\0\r\n]/.test(argument))
  ) {
    return null;
  }
  const normalized =
    invocation.at(-1) === '--json' ? invocation : [...invocation, '--json'];
  return `pnpm workflow ${normalized.map(shellQuote).join(' ')}`;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@=+,-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function firstString(
  candidates: readonly Readonly<Record<string, unknown>>[],
  key: string,
): string | undefined {
  for (const candidate of candidates) {
    const value = candidate[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function stringField(
  candidate: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = candidate?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stateGuidance<const T extends Readonly<Record<string, string>>>(
  projection: T,
  state: string | undefined,
): T[keyof T] | null {
  return state !== undefined && Object.hasOwn(projection, state)
    ? projection[state as keyof T]
    : null;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
