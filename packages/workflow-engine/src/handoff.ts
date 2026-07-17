import fs from 'node:fs';
import path from 'node:path';

import { AtomicTextSafetyError, replaceTextAtomic } from './atomic-text.ts';
import {
  loadChangeContract,
  loadWorkflowConfig,
  parseTasks,
  type ChangeContract,
  type ParsedTask,
} from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { runGit } from './git.ts';
import { readIssueData } from './issues.ts';
import { assertChangeId } from './paths.ts';

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
  const rendered = buildHandoff(repositoryRoot);
  writeTextAtomic(handoffPath(repositoryRoot), rendered);
  return rendered;
}

function buildHandoff(repositoryRoot: string): string {
  const contract = selectChange(repositoryRoot);
  const currentIndex = contract.tasks.findIndex(({ completed }) => !completed);
  const current =
    currentIndex === -1 ? undefined : contract.tasks[currentIndex];
  const next = current ? contract.tasks.slice(currentIndex + 1)[0] : undefined;
  const blockers = readBlockers(repositoryRoot);
  return [
    '# Current and Next Steps',
    '',
    'This generated handoff contains semantic project state only. Its sources are tracked OpenSpec change records and structured issue data.',
    '',
    '## Current Change',
    '',
    `\`${contract.changeId}\``,
    '',
    '## Current Task',
    '',
    current
      ? `\`${current.id}\` — ${current.title}`
      : 'None — all tasks are complete.',
    '',
    '## Next Task',
    '',
    next ? `\`${next.id}\` — ${next.title}` : 'None.',
    '',
    '## Current Focus',
    '',
    current
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

function selectChange(repositoryRoot: string): HandoffChange {
  const config = loadWorkflowConfig(repositoryRoot);
  const root = path.join(repositoryRoot, config.changeRoot);
  const contracts = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
    .map((entry) => loadChangeContract(repositoryRoot, entry.name));
  const active = contracts.filter((contract) =>
    contract.tasks.some(({ completed }) => !completed),
  );
  const selectedChangeId = readSelectedChangeId(repositoryRoot);
  if (selectedChangeId) {
    assertSelectedChangeId(selectedChangeId);
    const selected = contracts.find(
      (contract) => contract.changeId === selectedChangeId,
    );
    if (selected) return selected;

    const branchSelected = selectBranchChange(
      repositoryRoot,
      config.branchTemplate,
      active,
    );
    if (branchSelected) return branchSelected;

    const archived = loadArchivedChange(root, selectedChangeId);
    if (archived) return archived;
    throw invalidHandoff(
      'HANDOFF_ARCHIVE_INVALID',
      'The previously selected change has no unique, complete, plain archived task contract.',
    );
  }

  const branchSelected = selectBranchChange(
    repositoryRoot,
    config.branchTemplate,
    active,
  );
  if (branchSelected) return branchSelected;
  if (active.length === 1) {
    return active[0];
  }
  if (active.length === 0 && contracts.length === 1) {
    return contracts[0];
  }
  throw invalidHandoff(
    'HANDOFF_CHANGE_AMBIGUOUS',
    'The handoff requires one active change or one previously selected completed change.',
  );
}

function selectBranchChange(
  repositoryRoot: string,
  branchTemplate: string,
  active: ChangeContract[],
): ChangeContract | undefined {
  const branch = runGit(
    repositoryRoot,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    true,
  ).trim();
  if (!branch) return undefined;
  return active.find(
    ({ changeId }) =>
      branchTemplate.replaceAll('{changeId}', changeId) === branch,
  );
}

function loadArchivedChange(
  changeRoot: string,
  changeId: string,
): HandoffChange | undefined {
  const archiveRoot = path.join(changeRoot, 'archive');
  const archiveStats = fs.lstatSync(archiveRoot, { throwIfNoEntry: false });
  if (!archiveStats) return undefined;
  if (!archiveStats.isDirectory() || archiveStats.isSymbolicLink()) {
    throw invalidArchivedChange();
  }
  const candidates = fs
    .readdirSync(archiveRoot)
    .filter((name) => isCanonicalArchiveName(name, changeId));
  if (candidates.length === 0) return undefined;
  if (candidates.length !== 1) throw invalidArchivedChange();

  const directory = path.join(archiveRoot, candidates[0]);
  const directoryStats = fs.lstatSync(directory, { throwIfNoEntry: false });
  const tasksPath = path.join(directory, 'tasks.md');
  const tasksStats = fs.lstatSync(tasksPath, { throwIfNoEntry: false });
  if (
    !directoryStats?.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    !tasksStats?.isFile() ||
    tasksStats.isSymbolicLink() ||
    tasksStats.nlink !== 1
  ) {
    throw invalidArchivedChange();
  }
  const tasks = parseTasks(fs.readFileSync(tasksPath, 'utf8'));
  if (tasks.length === 0 || tasks.some(({ completed }) => !completed)) {
    throw invalidArchivedChange();
  }
  return { changeId, tasks };
}

function isCanonicalArchiveName(name: string, changeId: string): boolean {
  if (!name.endsWith(`-${changeId}`)) return false;
  const date = name.slice(0, name.length - changeId.length - 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === date
  );
}

function assertSelectedChangeId(changeId: string): void {
  try {
    assertChangeId(changeId);
  } catch {
    throw invalidHandoff(
      'HANDOFF_CHANGE_INVALID',
      'The selected handoff change ID is invalid.',
    );
  }
}

function invalidArchivedChange() {
  return invalidHandoff(
    'HANDOFF_ARCHIVE_INVALID',
    'The previously selected change has no unique, complete, plain archived task contract.',
  );
}

function readSelectedChangeId(repositoryRoot: string): string | undefined {
  const filePath = handoffPath(repositoryRoot);
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.isSymbolicLink()) return undefined;
  const content = fs.readFileSync(filePath, 'utf8');
  const matches = [
    ...content.matchAll(/^## Current Change\n\n`([^`\n]+)`(?:\n|$)/gm),
  ];
  return matches.length === 1 ? matches[0]?.[1] : undefined;
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
