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

const FINALIZE_REPLACEMENT =
  'pnpm workflow finalize <session-id> --message <subject> [--json]';

const commands: WorkflowCommandGuidance[] = [
  command({
    id: 'guide',
    usage: ['pnpm workflow guide [--json]'],
    status: 'read-only',
    purpose: 'Inspect the complete versioned workflow command guide.',
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
      'pnpm workflow review-diff <session-id> [--actor <provider>] [--grant <grant-id>] [--json]',
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
