import type { WorkflowError } from './errors.ts';

export type WorkflowGuidanceStatus =
  'preferred' | 'compatible' | 'deprecated' | 'read-only' | 'recovery';

export type WorkflowCommandDeprecation = Readonly<{
  phase: 1;
  replacementCommandId: string;
  replacement: string;
  reason: string;
}>;

export type WorkflowCommandGuidance = Readonly<{
  id: string;
  usage: readonly string[];
  status: WorkflowGuidanceStatus;
  purpose: string;
  preconditions: readonly string[];
  consequences: readonly string[];
  successors: readonly string[];
  deprecation?: WorkflowCommandDeprecation;
}>;

export type WorkflowGuidanceCatalog = Readonly<{
  schemaVersion: 1;
  kind: 'workflow-command-guide.v1';
  catalogVersion: 'managed-task-lifecycle.v1';
  authority: 'advisory';
  commands: readonly WorkflowCommandGuidance[];
}>;

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

const FINALIZE_REPLACEMENT =
  'pnpm workflow finalize <session-id> --message <subject> [--json]';

const commands: WorkflowCommandGuidance[] = [
  command({
    id: 'guide',
    usage: ['pnpm workflow guide [--json]'],
    status: 'read-only',
    purpose: 'Inspect the versioned managed-task workflow command guide.',
    preconditions: [],
    consequences: ['Reads command guidance without changing repository state.'],
    successors: [],
  }),
  command({
    id: 'open-task',
    usage: [
      'pnpm workflow open-task <change-id> --task <task-id> --mandate <mandate-task-id> [--json]',
    ],
    status: 'preferred',
    purpose:
      'Atomically commit the owned planning draft and open its exact task session.',
    preconditions: [
      'The planning draft, task mandate, branch, and repository identity are current.',
    ],
    consequences: [
      'Creates the managed planning transition and activates its exact task session.',
    ],
    successors: ['status', 'check', 'finalize'],
  }),
  command({
    id: 'start',
    usage: [
      'pnpm workflow start <change-id> --task <task-id> --mandate <mandate-task-id> [--json]',
    ],
    status: 'compatible',
    purpose: 'Open an authorized task session for an already committed plan.',
    preconditions: [
      'The exact planning transition is committed and the mandate is active.',
    ],
    consequences: ['Activates one exact task session and its lifecycle lock.'],
    successors: ['status', 'check', 'finalize'],
  }),
  command({
    id: 'revise-task',
    usage: ['pnpm workflow revise-task <session-id> --reason <text> [--json]'],
    status: 'preferred',
    purpose: 'Prepare a reviewed planning-only revision of one active task.',
    preconditions: ['The session can enter its revision transaction.'],
    consequences: [
      'Preserves implementation bytes while recording an exact revision transaction.',
    ],
    successors: ['status', 'resume-task'],
  }),
  command({
    id: 'resume-task',
    usage: [
      'pnpm workflow resume-task <session-id> [--approval <approval-id>] [--json]',
    ],
    status: 'preferred',
    purpose:
      'Resume the exact durable task revision without replaying ceremony.',
    preconditions: [
      'The supplied approval, when required, matches the revision.',
    ],
    consequences: [
      'Advances only the exact persisted revision and preserves same-digest evidence.',
    ],
    successors: ['status', 'check', 'finalize'],
  }),
  command({
    id: 'resume',
    usage: [
      'pnpm workflow resume <session-id> [--actor <provider>] [--grant <grant-id>] [--input <typed-envelope.json>] [--json]',
    ],
    status: 'preferred',
    purpose: 'Resume the next exact durable implementation-strategy substate.',
    preconditions: [
      'The active task and any collaboration grant or typed RED-revision input match the current strategy subject.',
    ],
    consequences: [
      'Seals, schedules, or reconciles only the next persisted strategy transition.',
    ],
    successors: ['status'],
  }),
  command({
    id: 'status',
    usage: ['pnpm workflow status [investigation-or-task-id] [--json]'],
    status: 'read-only',
    purpose: 'Inspect durable investigation, task, and recovery state.',
    preconditions: [],
    consequences: ['Reads state without advancing a transaction.'],
    successors: [],
  }),
  command({
    id: 'check',
    usage: ['pnpm workflow check <session-id> [--json]'],
    status: 'compatible',
    purpose: 'Produce current check evidence for the compatible task path.',
    preconditions: ['The session and its task scope are current.'],
    consequences: ['Persists check evidence bound to the exact current diff.'],
    successors: ['complete-task', 'finalize'],
  }),
  command({
    id: 'complete-task',
    usage: ['pnpm workflow complete-task <session-id> [--json]'],
    status: 'compatible',
    purpose: 'Apply the compatible task and document completion projection.',
    preconditions: ['Current passing check evidence exists.'],
    consequences: ['Projects completion but does not stage or commit it.'],
    successors: ['finish', 'rollback-completion'],
  }),
  command({
    id: 'finish',
    usage: ['pnpm workflow finish <session-id> [--json]'],
    status: 'compatible',
    purpose: 'Check and stage the compatible exact completion tree.',
    preconditions: [
      'The completion projection and its review gates are current.',
    ],
    consequences: ['Stages the exact authorized tree without committing it.'],
    successors: ['commit'],
  }),
  command({
    id: 'review-diff',
    usage: [
      'pnpm workflow review-diff <session-id> [--actor <provider>] [--grant <grant-id>] [--input <typed-response.json>] [--json]',
      'pnpm workflow review-diff <inspect|status|reconcile> <session-id> [--json]',
    ],
    status: 'preferred',
    purpose: 'Inspect, run, or reconcile the exact required TaskDiff review.',
    preconditions: [
      'The review subject and any collaboration grant match the current candidate.',
    ],
    consequences: [
      'Records advisory review output; only the shared closure verifier can authorize challenge closure.',
    ],
    successors: ['status', 'finalize'],
  }),
  command({
    id: 'finalize',
    usage: [FINALIZE_REPLACEMENT],
    status: 'preferred',
    purpose: 'Check, project, stage, and commit one exact candidate tree.',
    preconditions: [
      'The session, strategy evidence, reconciliation, and TaskDiff review gate are current.',
    ],
    consequences: [
      'Runs the durable projected-finalize transaction and commits its exact checked tree.',
    ],
    successors: ['status'],
  }),
  command({
    id: 'finalize-recover',
    usage: [
      'pnpm workflow finalize-recover <session-id> [--cancel <transaction-id> --reason <text>] [--json]',
    ],
    status: 'recovery',
    purpose:
      'Resume or explicitly cancel one exact durable finalize transaction.',
    preconditions: [
      "The requested transaction is the session's exact active journal.",
    ],
    consequences: [
      'Reconciles only the persisted transaction phase and never invents a replacement.',
    ],
    successors: ['status', 'finalize'],
  }),
  command({
    id: 'finalize-task',
    usage: ['pnpm workflow finalize-task <session-id> [--json]'],
    status: 'deprecated',
    purpose:
      'Compatibility surface for the projected-finalize transaction without commit.',
    preconditions: [
      'The session satisfies the same gates as the preferred finalize command.',
    ],
    consequences: [
      'Runs the same durable projected-finalize transaction and leaves commit separate.',
    ],
    successors: ['commit'],
    deprecation: {
      phase: 1,
      replacementCommandId: 'finalize',
      replacement: FINALIZE_REPLACEMENT,
      reason:
        'New callers use one durable finalization and commit transaction; finalize-task remains a compatibility surface.',
    },
  }),
  command({
    id: 'rollback-completion',
    usage: [
      'pnpm workflow rollback-completion <session-id> --reason <text> [--json]',
    ],
    status: 'recovery',
    purpose: 'Restore an uncommitted compatible completion projection.',
    preconditions: [
      'The session has a completion projection but is not finished.',
    ],
    consequences: [
      'Restores exact projection bytes and records the rollback reason.',
    ],
    successors: ['status', 'check', 'finalize'],
  }),
  command({
    id: 'commit',
    usage: ['pnpm workflow commit <session-id> --message <subject> [--json]'],
    status: 'compatible',
    purpose:
      'Commit an exact tree already staged by a compatible lifecycle path.',
    preconditions: [
      'The staged tree and finish evidence are exact and current.',
    ],
    consequences: [
      'Creates the managed task commit with engine-owned trailers.',
    ],
    successors: ['status'],
  }),
  command({
    id: 'abort',
    usage: ['pnpm workflow abort <session-id> --reason <text> [--json]'],
    status: 'preferred',
    purpose:
      'Abandon an active pre-completion session without discarding files.',
    preconditions: ['The session has not completed, finished, or committed.'],
    consequences: ['Records abandonment and releases the lifecycle lock.'],
    successors: ['status'],
  }),
];

assertCatalog(commands);

export const WORKFLOW_GUIDANCE_CATALOG: WorkflowGuidanceCatalog = Object.freeze(
  {
    schemaVersion: 1,
    kind: 'workflow-command-guide.v1',
    catalogVersion: 'managed-task-lifecycle.v1',
    authority: 'advisory',
    commands: Object.freeze(commands),
  },
);

export function workflowCommandGuidance(id: string): WorkflowCommandGuidance {
  const entry = WORKFLOW_GUIDANCE_CATALOG.commands.find(
    (candidate) => candidate.id === id,
  );
  if (!entry) throw new Error(`Unknown workflow guidance command: ${id}`);
  return entry;
}

export function workflowGuidanceUsageLines(): readonly string[] {
  return WORKFLOW_GUIDANCE_CATALOG.commands.flatMap(({ usage }) => usage);
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
    return taskDiffReviewNextSteps(result, bindings);
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
  if (
    [
      'red-authoring',
      'implementation-required',
      'ready',
      'reservation-persisted',
      'provider-succeeded-awaiting-import',
      'caller-supplied-awaiting-import',
      'transformation-required',
    ].includes(state ?? '')
  ) {
    return projectWorkflowNextSteps(['resume', 'status'], bindings);
  }
  if (state === 'waiting-for-provider') {
    return projectWorkflowNextSteps(['status', 'resume'], bindings);
  }
  if (state === 'provider-failed') {
    return projectWorkflowNextSteps(['resume', 'status', 'guide'], bindings);
  }
  if (state === 'collaboration-grant-required') {
    return projectWorkflowNextSteps(['status', 'guide'], bindings);
  }
  if (state === 'correction-exhausted') {
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
  if (
    state === 'patch-imported' ||
    state === 'transformation-produced' ||
    state === 'not-required'
  ) {
    return projectWorkflowNextSteps(['check', 'finalize', 'status'], bindings);
  }
  return projectWorkflowNextSteps(['status'], bindings);
}

function taskDiffReviewNextSteps(
  result: Readonly<Record<string, unknown>>,
  bindings: WorkflowNextStepBindings,
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
  return projectWorkflowNextSteps(
    satisfied ? ['finalize', 'status'] : ['review-diff', 'status'],
    bindings,
  );
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

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function command(value: WorkflowCommandGuidance): WorkflowCommandGuidance {
  return Object.freeze({
    ...value,
    usage: Object.freeze([...value.usage]),
    preconditions: Object.freeze([...value.preconditions]),
    consequences: Object.freeze([...value.consequences]),
    successors: Object.freeze([...value.successors]),
    ...(value.deprecation
      ? { deprecation: Object.freeze({ ...value.deprecation }) }
      : {}),
  });
}

function assertCatalog(entries: readonly WorkflowCommandGuidance[]): void {
  const ids = entries.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Workflow guidance command IDs must be unique.');
  }
  const usage = entries.flatMap((entry) => entry.usage);
  if (new Set(usage).size !== usage.length) {
    throw new Error('Workflow guidance usage lines must be unique.');
  }
  for (const entry of entries) {
    if (
      !entry.id ||
      entry.usage.length === 0 ||
      entry.usage.some((line) => !line.startsWith('pnpm workflow ')) ||
      !entry.purpose ||
      entry.consequences.length === 0 ||
      entry.successors.some((id) => !ids.includes(id)) ||
      (entry.status === 'deprecated') !== (entry.deprecation !== undefined)
    ) {
      throw new Error(`Workflow guidance entry is invalid: ${entry.id}`);
    }
  }
}
