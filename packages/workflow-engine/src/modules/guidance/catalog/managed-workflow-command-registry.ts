export type WorkflowGuidanceStatus =
  'preferred' | 'compatible' | 'deprecated' | 'read-only' | 'recovery';

export const MANAGED_WORKFLOW_COMMAND_IDS = [
  'guide',
  'open-task',
  'start',
  'revise-task',
  'resume-task',
  'resume',
  'status',
  'check',
  'complete-task',
  'finish',
  'review-diff',
  'maintainer-review-diff-attest',
  'authority-plan',
  'finalize',
  'finalize-recover',
  'finalize-task',
  'rollback-completion',
  'commit',
  'abort',
] as const;

export type ManagedWorkflowCommandId =
  (typeof MANAGED_WORKFLOW_COMMAND_IDS)[number];

export type WorkflowCommandDeprecation = Readonly<{
  phase: 1;
  replacementCommandId: ManagedWorkflowCommandId;
  replacement: string;
  reason: string;
}>;

export type WorkflowCommandGuidance = Readonly<{
  id: ManagedWorkflowCommandId;
  usage: readonly string[];
  status: WorkflowGuidanceStatus;
  purpose: string;
  preconditions: readonly string[];
  consequences: readonly string[];
  successors: readonly ManagedWorkflowCommandId[];
  deprecation?: WorkflowCommandDeprecation;
}>;

export type WorkflowGuidanceCatalog = Readonly<{
  schemaVersion: 1;
  kind: 'workflow-command-guide.v1';
  catalogVersion: 'managed-task-lifecycle.v2';
  authority: 'advisory';
  commands: readonly WorkflowCommandGuidance[];
}>;

export type ManagedWorkflowCommandDefinition = WorkflowCommandGuidance &
  Readonly<{
    route: readonly string[];
  }>;

export type ManagedWorkflowCommandRegistry = Readonly<{
  entries: readonly ManagedWorkflowCommandDefinition[];
  resolve: (id: string) => WorkflowCommandGuidance;
  resolveRoute: (route: readonly string[]) => WorkflowCommandGuidance;
  usageLines: () => readonly string[];
  renderCatalog: () => WorkflowGuidanceCatalog;
}>;

const FINALIZE_REPLACEMENT =
  'pnpm workflow finalize <session-id> --message <subject> [--full-gate] [--json]';
const OPEN_TASK_REPLACEMENT =
  'pnpm workflow open-task <change-id> [--task <task-id>] [--mandate <mandate-task-id>] [--json]';

const MANAGED_WORKFLOW_COMMAND_DEFINITIONS = [
  {
    id: 'guide',
    route: ['guide'],
    usage: ['pnpm workflow guide [--json]'],
    status: 'read-only',
    purpose: 'Inspect the versioned managed-task workflow command guide.',
    preconditions: [],
    consequences: ['Reads command guidance without changing repository state.'],
    successors: [],
  },
  {
    id: 'open-task',
    route: ['open-task'],
    usage: [OPEN_TASK_REPLACEMENT],
    status: 'preferred',
    purpose:
      'Open the selected or next incomplete task, committing an owned draft only when required.',
    preconditions: [
      'The branch and either owned draft or replayable planning generation are current; a protected task scope requires an exact active Task Mandate.',
    ],
    consequences: [
      'Selects the planning-state transition and activates one exact task session.',
    ],
    successors: ['status', 'check', 'finalize'],
  },
  {
    id: 'start',
    route: ['start'],
    usage: [
      'pnpm workflow start <change-id> --task <task-id> [--mandate <mandate-task-id>] [--json]',
    ],
    status: 'deprecated',
    purpose: 'Compatibility alias for opening an already committed plan.',
    preconditions: [
      'The exact planning transition is committed; a protected task scope requires an exact active Task Mandate.',
    ],
    consequences: ['Activates one exact task session and its lifecycle lock.'],
    successors: ['status', 'check', 'finalize'],
    deprecation: {
      phase: 1,
      replacementCommandId: 'open-task',
      replacement: OPEN_TASK_REPLACEMENT,
      reason:
        'open-task selects the correct planning state; start remains a compatibility alias.',
    },
  },
  {
    id: 'revise-task',
    route: ['revise-task'],
    usage: ['pnpm workflow revise-task <session-id> --reason <text> [--json]'],
    status: 'preferred',
    purpose: 'Prepare a reviewed planning-only revision of one active task.',
    preconditions: ['The session can enter its revision transaction.'],
    consequences: [
      'Preserves implementation bytes while recording an exact revision transaction.',
    ],
    successors: ['status', 'resume-task'],
  },
  {
    id: 'resume-task',
    route: ['resume-task'],
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
  },
  {
    id: 'resume',
    route: ['resume'],
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
  },
  {
    id: 'status',
    route: ['status'],
    usage: ['pnpm workflow status [investigation-or-task-id] [--json]'],
    status: 'read-only',
    purpose: 'Inspect durable investigation, task, and recovery state.',
    preconditions: [],
    consequences: ['Reads state without advancing a transaction.'],
    successors: [],
  },
  {
    id: 'check',
    route: ['check'],
    usage: ['pnpm workflow check <session-id> [--json]'],
    status: 'compatible',
    purpose: 'Produce current check evidence for the compatible task path.',
    preconditions: ['The session and its task scope are current.'],
    consequences: ['Persists check evidence bound to the exact current diff.'],
    successors: ['complete-task', 'finalize'],
  },
  {
    id: 'complete-task',
    route: ['complete-task'],
    usage: ['pnpm workflow complete-task <session-id> [--json]'],
    status: 'compatible',
    purpose: 'Apply the compatible task and document completion projection.',
    preconditions: [
      'Current passing check evidence exists and the actual diff does not require protected Apply authority.',
    ],
    consequences: ['Projects completion but does not stage or commit it.'],
    successors: ['finish', 'rollback-completion'],
  },
  {
    id: 'finish',
    route: ['finish'],
    usage: ['pnpm workflow finish <session-id> [--json]'],
    status: 'compatible',
    purpose: 'Check and stage the compatible exact completion tree.',
    preconditions: [
      'The completion projection and its review gates are current.',
    ],
    consequences: ['Stages the exact authorized tree without committing it.'],
    successors: ['commit'],
  },
  {
    id: 'review-diff',
    route: ['review-diff'],
    usage: [
      'pnpm workflow review-diff <session-id> [--actor <provider>] [--grant <grant-id>] [--json]',
      'pnpm workflow review-diff <session-id> --input <typed-envelope.json> [--grant <grant-id>] [--json]',
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
  },
  {
    id: 'maintainer-review-diff-attest',
    route: ['maintainer', 'review-diff-attest'],
    usage: [
      'pnpm workflow maintainer review-diff-attest <session-id> --input <typed-envelope.json> --grant <grant-id> [--json]',
    ],
    status: 'recovery',
    purpose:
      'Sign and resume one exact durable direct-human TaskDiff review pause at the controlling maintainer terminal.',
    preconditions: [
      'The typed authority-free input, grant, and persisted content reference exactly match the current direct-human pause.',
    ],
    consequences: [
      'Creates the attestation internally and resumes only the already-persisted review transaction.',
    ],
    successors: ['review-diff', 'status'],
  },
  {
    id: 'authority-plan',
    route: ['authority-plan'],
    usage: [
      'pnpm workflow authority-plan prepare --intent <intent.json> [--json]',
      'pnpm workflow authority-plan status <plan-id> [--json]',
      'pnpm workflow authority-plan approve-and-apply <plan-id> [--json]',
      'pnpm workflow authority-plan resume <plan-id> [--json]',
      'pnpm workflow authority-plan attest <plan-id> [--json]',
    ],
    status: 'preferred',
    purpose:
      'Prepare, inspect, and resume one durable whole-round authority transaction while keeping signing, push, and merge human-controlled.',
    preconditions: [
      'Prepare receives an exact authority intent on the matching clean work branch; approve and attest run only at the controlling maintainer terminal.',
    ],
    consequences: [
      'Persists each local ceremony, remote handoff, merge observation, attestation, and terminal completion as an immutable authority-plan revision.',
    ],
    successors: [],
  },
  {
    id: 'finalize',
    route: ['finalize'],
    usage: [FINALIZE_REPLACEMENT],
    status: 'preferred',
    purpose:
      'Check, project, stage, and commit one exact ordinary candidate tree.',
    preconditions: [
      'The session, strategy evidence, reconciliation, and TaskDiff review gate are current.',
      'The actual implementation diff contains no protected or unclassified path; otherwise use the returned human-only V2 Apply recovery.',
    ],
    consequences: [
      'Runs targeted task checks; when the change closes (or escalation is explicit), terminal policy replaces only declared covered checks and commits the exact checked tree.',
    ],
    successors: ['status'],
  },
  {
    id: 'finalize-recover',
    route: ['finalize-recover'],
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
  },
  {
    id: 'finalize-task',
    route: ['finalize-task'],
    usage: ['pnpm workflow finalize-task <session-id> [--json]'],
    status: 'deprecated',
    purpose:
      'Compatibility surface for the projected-finalize transaction without commit.',
    preconditions: [
      'The session satisfies the same gates as the preferred finalize command.',
      'The actual implementation diff does not require protected Apply authority.',
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
  },
  {
    id: 'rollback-completion',
    route: ['rollback-completion'],
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
  },
  {
    id: 'commit',
    route: ['commit'],
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
  },
  {
    id: 'abort',
    route: ['abort'],
    usage: ['pnpm workflow abort <session-id> --reason <text> [--json]'],
    status: 'preferred',
    purpose:
      'Abandon an active pre-completion session without discarding files.',
    preconditions: ['The session has not completed, finished, or committed.'],
    consequences: ['Records abandonment and releases the lifecycle lock.'],
    successors: ['status'],
  },
] as const satisfies readonly ManagedWorkflowCommandDefinition[];

export function createManagedWorkflowCommandRegistry(
  definitions: readonly ManagedWorkflowCommandDefinition[],
): ManagedWorkflowCommandRegistry {
  const entries = Object.freeze(definitions.map(freezeDefinition));
  const byId = new Map<string, WorkflowCommandGuidance>();
  const byRoute = new Map<string, WorkflowCommandGuidance>();
  const usageLines: string[] = [];
  const seenUsage = new Set<string>();

  for (const entry of entries) {
    if (byId.has(entry.id)) {
      throw new Error('Managed workflow command IDs must be unique.');
    }
    const routeKey = commandRouteKey(entry.route);
    if (byRoute.has(routeKey)) {
      throw new Error('Managed workflow command routes must be unique.');
    }
    if (
      !entry.id ||
      entry.route.length === 0 ||
      entry.route.some((segment) => !segment || /\s/u.test(segment)) ||
      entry.usage.length === 0 ||
      entry.usage.some((line) => !line.startsWith('pnpm workflow ')) ||
      !entry.purpose ||
      entry.consequences.length === 0 ||
      (entry.status === 'deprecated') !== (entry.deprecation !== undefined)
    ) {
      throw new Error(`Managed workflow command is invalid: ${entry.id}`);
    }
    for (const usage of entry.usage) {
      if (seenUsage.has(usage)) {
        throw new Error('Managed workflow command usage lines must be unique.');
      }
      seenUsage.add(usage);
      usageLines.push(usage);
    }
    const guidance = projectGuidance(entry);
    byId.set(entry.id, guidance);
    byRoute.set(routeKey, guidance);
  }

  for (const entry of entries) {
    const unknownSuccessor = entry.successors.find((id) => !byId.has(id));
    if (unknownSuccessor !== undefined) {
      throw new Error(
        `Managed workflow command ${entry.id} has unknown successor: ${unknownSuccessor}`,
      );
    }
    const replacementCommandId = entry.deprecation?.replacementCommandId;
    if (replacementCommandId !== undefined && !byId.has(replacementCommandId)) {
      throw new Error(
        `Managed workflow command ${entry.id} has unknown replacement: ${replacementCommandId}`,
      );
    }
  }

  const commands = Object.freeze(entries.map(({ id }) => byId.get(id)!));
  const catalog: WorkflowGuidanceCatalog = Object.freeze({
    schemaVersion: 1,
    kind: 'workflow-command-guide.v1',
    catalogVersion: 'managed-task-lifecycle.v2',
    authority: 'advisory',
    commands,
  });
  const frozenUsageLines = Object.freeze(usageLines);

  return Object.freeze({
    entries,
    resolve(id: string): WorkflowCommandGuidance {
      const entry = byId.get(id);
      if (!entry) throw new Error(`Unknown workflow guidance command: ${id}`);
      return entry;
    },
    resolveRoute(route: readonly string[]): WorkflowCommandGuidance {
      const entry = byRoute.get(commandRouteKey(route));
      if (!entry) {
        throw new Error(
          `Unknown workflow guidance command route: ${route.join(' ')}`,
        );
      }
      return entry;
    },
    usageLines(): readonly string[] {
      return frozenUsageLines;
    },
    renderCatalog(): WorkflowGuidanceCatalog {
      return catalog;
    },
  });
}

export const MANAGED_WORKFLOW_COMMAND_REGISTRY =
  createManagedWorkflowCommandRegistry(MANAGED_WORKFLOW_COMMAND_DEFINITIONS);

export function resolveManagedWorkflowCommand(
  id: string,
): WorkflowCommandGuidance {
  return MANAGED_WORKFLOW_COMMAND_REGISTRY.resolve(id);
}

export function resolveManagedWorkflowCommandRoute(
  route: readonly string[],
): WorkflowCommandGuidance {
  return MANAGED_WORKFLOW_COMMAND_REGISTRY.resolveRoute(route);
}

export function managedWorkflowCommandUsageLines(): readonly string[] {
  return MANAGED_WORKFLOW_COMMAND_REGISTRY.usageLines();
}

export function renderManagedWorkflowGuidanceCatalog(): WorkflowGuidanceCatalog {
  return MANAGED_WORKFLOW_COMMAND_REGISTRY.renderCatalog();
}

function freezeDefinition(
  value: ManagedWorkflowCommandDefinition,
): ManagedWorkflowCommandDefinition {
  return Object.freeze({
    id: value.id,
    route: Object.freeze([...value.route]),
    usage: Object.freeze([...value.usage]),
    status: value.status,
    purpose: value.purpose,
    preconditions: Object.freeze([...value.preconditions]),
    consequences: Object.freeze([...value.consequences]),
    successors: Object.freeze([...value.successors]),
    ...(value.deprecation
      ? { deprecation: Object.freeze({ ...value.deprecation }) }
      : {}),
  });
}

function projectGuidance(
  entry: ManagedWorkflowCommandDefinition,
): WorkflowCommandGuidance {
  return Object.freeze({
    id: entry.id,
    usage: entry.usage,
    status: entry.status,
    purpose: entry.purpose,
    preconditions: entry.preconditions,
    consequences: entry.consequences,
    successors: entry.successors,
    ...(entry.deprecation === undefined
      ? {}
      : { deprecation: entry.deprecation }),
  });
}

function commandRouteKey(route: readonly string[]): string {
  return route.join('\0');
}
