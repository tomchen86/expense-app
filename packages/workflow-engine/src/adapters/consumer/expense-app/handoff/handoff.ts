import fs from 'node:fs';
import path from 'node:path';

import {
  AtomicTextSafetyError,
  replaceTextAtomic,
} from '../../../../runtime/repository-transaction/atomic-text.ts';
import {
  loadChangeContract,
  loadWorkflowConfig,
  parseTasks,
  type ChangeContract,
  type ParsedTask,
} from '../work-registry/contracts.ts';
import {
  ExitCode,
  workflowError,
} from '../../../../foundation/errors/errors.ts';
import { readIssueData } from '../documents/issues.ts';
import { assertChangeId } from '../../../../runtime/session-workspace/paths.ts';

const SECTIONS = [
  'Current Change',
  'Current Task',
  'Next Task',
  'Current Focus',
  'Known Blockers',
  'References',
];

type HandoffChange = {
  changeId: string;
  tasks: ParsedTask[];
};

export function renderHandoff(repositoryRoot: string): string {
  const rendered = projectHandoff(repositoryRoot);
  writeTextAtomic(handoffPath(repositoryRoot), rendered);
  return rendered;
}

export function projectHandoff(repositoryRoot: string): string {
  return buildHandoff(repositoryRoot);
}

/** Build completion handoff bytes from an exact prospective tasks projection. */
export function projectHandoffForTaskProjection(
  repositoryRoot: string,
  requestedChangeId: string,
  projectedTasks: string,
): string {
  const changeId = assertChangeId(requestedChangeId);
  return buildHandoff(repositoryRoot, undefined, {
    changeId,
    tasks: parseTasks(projectedTasks),
  });
}

/**
 * Render the handoff for one explicit lifecycle-owned change. The existing
 * handoff bytes are deliberately not consulted: generated output is never an
 * authority input for the transition that replaces it.
 */
export function renderHandoffForChange(
  repositoryRoot: string,
  requestedChangeId: string,
): string {
  const changeId = assertChangeId(requestedChangeId);
  const rendered = buildHandoff(repositoryRoot, changeId);
  writeTextAtomic(handoffPath(repositoryRoot), rendered);
  return rendered;
}

function buildHandoff(
  repositoryRoot: string,
  selectedChangeId?: string,
  projectedChange?: HandoffChange,
): string {
  const contract = selectChange(
    repositoryRoot,
    selectedChangeId,
    projectedChange,
  );
  const currentIndex =
    contract === null
      ? -1
      : contract.tasks.findIndex(({ completed }) => !completed);
  const current =
    contract === null || currentIndex === -1
      ? undefined
      : contract.tasks[currentIndex];
  const next =
    contract !== null && current
      ? contract.tasks.slice(currentIndex + 1)[0]
      : undefined;
  const blockers = readBlockers(repositoryRoot);
  return [
    '# Current and Next Steps',
    '',
    'This generated handoff contains semantic project state only. Its sources are tracked OpenSpec change records and structured issue data.',
    '',
    '## Current Change',
    '',
    contract === null ? 'None.' : `\`${contract.changeId}\``,
    '',
    '## Current Task',
    '',
    contract === null
      ? 'None — no active change.'
      : current
        ? `\`${current.id}\` — ${current.title}`
        : 'None — all tasks are complete.',
    '',
    '## Next Task',
    '',
    next ? `\`${next.id}\` — ${next.title}` : 'None.',
    '',
    '## Current Focus',
    '',
    contract === null
      ? 'No active OpenSpec change; follow the Roadmap for the next explicit transition.'
      : current
        ? current.title
        : 'No implementation tasks remain; follow the Roadmap for the next explicit transition.',
    '',
    '## Known Blockers',
    '',
    ...(blockers.length > 0
      ? blockers.map((issue) => `- \`${issue.id}\` — ${issue.title}`)
      : ['None.']),
    '',
    '## References',
    '',
    '- [Roadmap](ROADMAP.md)',
    '- [Change records](../openspec/changes/)',
    '- [Base specifications](../openspec/specs/)',
    '- [Issue log](ISSUE_LOG.md)',
    '- [System architecture](architecture/ARCHITECTURE.md)',
    '',
  ].join('\n');
}

export function validateHandoff(repositoryRoot: string): void {
  const expected = buildHandoff(repositoryRoot);
  assertHandoffBytes(repositoryRoot, expected);
}

export function validateHandoffForChange(
  repositoryRoot: string,
  requestedChangeId: string,
): void {
  const changeId = assertChangeId(requestedChangeId);
  const expected = buildHandoff(repositoryRoot, changeId);
  assertHandoffBytes(repositoryRoot, expected);
}

function assertHandoffBytes(repositoryRoot: string, expected: string): void {
  let actual: string;
  try {
    actual = fs.readFileSync(handoffPath(repositoryRoot), 'utf8');
  } catch {
    throw invalidHandoff('HANDOFF_MISSING', 'Generated handoff is missing.');
  }
  const sections = [...actual.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  if (
    actual !== expected ||
    JSON.stringify(sections) !== JSON.stringify(SECTIONS) ||
    /\b[0-9a-f]{40,64}\b/i.test(actual) ||
    /session-[A-Za-z0-9-]+/.test(actual)
  ) {
    throw invalidHandoff(
      'HANDOFF_DRIFT',
      'Semantic handoff differs from its controlled sources.',
    );
  }
}

function selectChange(
  repositoryRoot: string,
  explicitChangeId?: string,
  projectedChange?: HandoffChange,
): HandoffChange | null {
  const config = loadWorkflowConfig(repositoryRoot);
  const root = path.join(repositoryRoot, config.changeRoot);
  const contracts = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
    .map((entry) => loadChangeContract(repositoryRoot, entry.name));
  if (projectedChange) {
    const projectedIndex = contracts.findIndex(
      ({ changeId }) => changeId === projectedChange.changeId,
    );
    if (projectedIndex < 0) {
      throw invalidHandoff(
        'HANDOFF_CHANGE_INVALID',
        'The prospective handoff change has no tracked task contract.',
      );
    }
    contracts[projectedIndex] = {
      ...contracts[projectedIndex],
      tasks: projectedChange.tasks,
    };
  }
  const active = contracts.filter((contract) =>
    contract.tasks.some(({ completed }) => !completed),
  );
  if (explicitChangeId !== undefined) {
    const explicit = contracts.find(
      (contract) => contract.changeId === explicitChangeId,
    );
    if (!explicit) {
      throw invalidHandoff(
        'HANDOFF_CHANGE_INVALID',
        'The lifecycle-owned handoff change has no tracked task contract.',
      );
    }
    return explicit;
  }
  if (active.length === 1) {
    return active[0];
  }
  if (active.length === 0) return null;
  throw invalidHandoff(
    'HANDOFF_CHANGE_AMBIGUOUS',
    'The handoff requires at most one active change.',
  );
}

function readBlockers(repositoryRoot: string) {
  if (!fs.existsSync(path.join(repositoryRoot, 'docs/issues/issues.yaml'))) {
    return [];
  }
  return readIssueData(repositoryRoot).issues.filter(
    (issue) => issue.status === 'blocked' && !issue.closed,
  );
}

function writeTextAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw invalidHandoff(
      'HANDOFF_PATH_UNSAFE',
      'Managed handoff path is not a plain file.',
    );
  }
  if (existing && fs.readFileSync(filePath, 'utf8') === content) {
    return;
  }
  try {
    replaceTextAtomic(filePath, content, {
      allowCreate: true,
      defaultMode: existing?.mode ?? 0o644,
    });
  } catch (error) {
    if (error instanceof AtomicTextSafetyError) {
      throw invalidHandoff(
        'HANDOFF_PATH_UNSAFE',
        'Managed handoff path is not a plain file.',
      );
    }
    throw error;
  }
}

function handoffPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, 'docs/CURRENT_AND_NEXT_STEPS.md');
}

function invalidHandoff(code: string, message: string) {
  return workflowError(code, message, ExitCode.verification);
}
