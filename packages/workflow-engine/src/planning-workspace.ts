import fs from 'node:fs';
import path from 'node:path';

import { replaceTextAtomic } from './atomic-text.ts';
import { canonicalJson } from './canonical-json.ts';
import { loadWorkflowConfig } from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  assertPlainDirectory,
  ensurePlainDirectory,
} from './filesystem-safety.ts';
import { discoverRepository, listChangedPaths, runGit } from './git.ts';
import { assertChangeId } from './paths.ts';
import { assertPlanningPaths } from './planning-paths.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperation,
} from './session-store.ts';

const FULL_COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_RECORD_BYTES = 16 * 1024;

export type PlanningDraftWorkspaceRecord = Readonly<{
  schemaVersion: 1;
  kind: 'planning-draft-workspace.v1';
  changeId: string;
  branch: string;
  baseCommit: string;
  gitCommonDirectory: string;
  worktreePath: string;
  createdAt: string;
}>;

export type PreparedPlanningDraftWorkspace = PlanningDraftWorkspaceRecord &
  Readonly<{ status: 'created' | 'reused' }>;

export type PreparePlanningDraftWorkspaceOptions = Readonly<{
  baseCommit?: string;
  workspaceParent?: string;
  adoptCurrentWorktree?: boolean;
  now?: Date;
  testBeforeWorktreeAdd?: () => void;
}>;

type WorktreeRegistration = Readonly<{
  worktreePath: string;
  head: string;
  branch: string | null;
}>;

export function preparePlanningDraftWorkspace(
  cwd: string,
  changeIdValue: string,
  options: PreparePlanningDraftWorkspaceOptions = {},
): PreparedPlanningDraftWorkspace {
  const changeId = assertChangeId(changeIdValue);
  const repository = discoverRepository(cwd);
  const config = loadWorkflowConfig(repository.repositoryRoot);
  const runtime = runtimePaths(
    repository.gitCommonDirectory,
    config.runtimeDirectory,
  );

  return withRepositoryLifecycleOperation(runtime, (assertOwned) => {
    assertOwned();
    const baseCommit = resolveBaseCommit(
      repository.repositoryRoot,
      options.baseCommit ?? repository.head,
    );
    const branch = config.branchTemplate.replaceAll('{changeId}', changeId);
    const adoptCurrentWorktree = options.adoptCurrentWorktree === true;
    if (adoptCurrentWorktree && options.workspaceParent !== undefined) {
      throw planningWorkspaceError(
        'PLANNING_WORKSPACE_PATH_INVALID',
        'Current-worktree adoption cannot also select a workspace parent.',
      );
    }
    const worktreePath = adoptCurrentWorktree
      ? repository.repositoryRealPath
      : path.join(resolveWorkspaceParent(repository, options), changeId);
    if (!adoptCurrentWorktree) {
      assertWorkspaceOutsideAuthorityRoots(
        worktreePath,
        repository.repositoryRealPath,
        repository.gitCommonDirectory,
      );
    }
    const existingRecord = readPlanningDraftWorkspaceRecord(
      repository.gitCommonDirectory,
      config.runtimeDirectory,
      changeId,
    );
    const registrations = listWorktreeRegistrations(repository.repositoryRoot);
    const exactRegistration = registrations.find(
      (entry) => entry.worktreePath === worktreePath,
    );
    const branchRegistration = registrations.find(
      (entry) => entry.branch === branch,
    );

    if (exactRegistration) {
      const primaryWorktree = isPrimaryWorktree(
        worktreePath,
        repository.gitCommonDirectory,
      );
      if (adoptCurrentWorktree && !primaryWorktree && !existingRecord) {
        throw planningWorkspaceError(
          'PLANNING_WORKSPACE_OWNERSHIP_MISMATCH',
          'Only the repository primary worktree can be adopted as a pre-existing planning workspace.',
        );
      }
      const record = validateReusableWorkspace({
        repositoryRoot: repository.repositoryRoot,
        gitCommonDirectory: repository.gitCommonDirectory,
        changeRoot: config.changeRoot,
        changeId,
        branch,
        baseCommit,
        worktreePath,
        registration: exactRegistration,
        existingRecord,
        enforcePlanningPathBoundary: !primaryWorktree,
      });
      if (!existingRecord) {
        persistPlanningDraftWorkspace(
          repository.gitCommonDirectory,
          config.runtimeDirectory,
          record,
        );
      }
      assertOwned();
      return { ...record, status: 'reused' };
    }

    if (adoptCurrentWorktree) {
      throw planningWorkspaceError(
        'PLANNING_WORKSPACE_OWNERSHIP_MISMATCH',
        'The current repository is not an exact registered Git worktree.',
      );
    }

    if (existingRecord || branchRegistration || pathExists(worktreePath)) {
      throw planningWorkspaceError(
        pathExists(worktreePath)
          ? 'PLANNING_WORKSPACE_OCCUPIED'
          : 'PLANNING_WORKSPACE_OWNERSHIP_MISMATCH',
        `Planning workspace ownership for ${changeId} is not exact.`,
      );
    }

    const existingBranchOid = readBranchOid(repository.repositoryRoot, branch);
    if (existingBranchOid !== null) {
      throw planningWorkspaceError(
        'PLANNING_WORKSPACE_OWNERSHIP_MISMATCH',
        `Planning branch ${branch} already exists without its owned worktree.`,
      );
    }

    options.testBeforeWorktreeAdd?.();
    assertOwned();
    try {
      runGit(repository.repositoryRoot, [
        'worktree',
        'add',
        '-b',
        branch,
        worktreePath,
        baseCommit,
      ]);
    } catch (error) {
      cleanupExactCreatedBranch(repository.repositoryRoot, branch, baseCommit);
      if (pathExists(worktreePath)) {
        throw planningWorkspaceError(
          'PLANNING_WORKSPACE_OCCUPIED',
          `Planning workspace path ${worktreePath} became occupied.`,
        );
      }
      throw error;
    }

    const registration = listWorktreeRegistrations(
      repository.repositoryRoot,
    ).find((entry) => entry.worktreePath === worktreePath);
    if (!registration) {
      throw planningWorkspaceError(
        'PLANNING_WORKSPACE_OWNERSHIP_MISMATCH',
        'Git did not register the created planning worktree exactly.',
      );
    }
    const createdAt = resolveCreatedAt(options.now ?? new Date());
    const record = validateReusableWorkspace({
      repositoryRoot: repository.repositoryRoot,
      gitCommonDirectory: repository.gitCommonDirectory,
      changeRoot: config.changeRoot,
      changeId,
      branch,
      baseCommit,
      worktreePath,
      registration,
      existingRecord: null,
      createdAt,
      enforcePlanningPathBoundary: true,
    });
    persistPlanningDraftWorkspace(
      repository.gitCommonDirectory,
      config.runtimeDirectory,
      record,
    );
    assertOwned();
    return { ...record, status: 'created' };
  });
}

export function readPlanningDraftWorkspace(
  cwd: string,
  changeIdValue: string,
): PlanningDraftWorkspaceRecord | null {
  const changeId = assertChangeId(changeIdValue);
  const repository = discoverRepository(cwd);
  const config = loadWorkflowConfig(repository.repositoryRoot);
  return readPlanningDraftWorkspaceRecord(
    repository.gitCommonDirectory,
    config.runtimeDirectory,
    changeId,
  );
}

export function inspectPlanningDraftWorkspace(
  cwd: string,
  changeIdValue: string,
): PlanningDraftWorkspaceRecord | null {
  const changeId = assertChangeId(changeIdValue);
  const repository = discoverRepository(cwd);
  const config = loadWorkflowConfig(repository.repositoryRoot);
  const record = readPlanningDraftWorkspaceRecord(
    repository.gitCommonDirectory,
    config.runtimeDirectory,
    changeId,
  );
  if (!record) {
    return null;
  }
  const registration = listWorktreeRegistrations(
    repository.repositoryRoot,
  ).find((entry) => entry.worktreePath === record.worktreePath);
  if (!registration) {
    throw planningWorkspaceError(
      'PLANNING_WORKSPACE_OWNERSHIP_MISMATCH',
      'The durable planning workspace is no longer registered with Git.',
    );
  }
  return validateReusableWorkspace({
    repositoryRoot: repository.repositoryRoot,
    gitCommonDirectory: repository.gitCommonDirectory,
    changeRoot: config.changeRoot,
    changeId,
    branch: record.branch,
    baseCommit: record.baseCommit,
    worktreePath: record.worktreePath,
    registration,
    existingRecord: record,
    enforcePlanningPathBoundary: !isPrimaryWorktree(
      record.worktreePath,
      repository.gitCommonDirectory,
    ),
  });
}

function validateReusableWorkspace(input: {
  repositoryRoot: string;
  gitCommonDirectory: string;
  changeRoot: string;
  changeId: string;
  branch: string;
  baseCommit: string;
  worktreePath: string;
  registration: WorktreeRegistration;
  existingRecord: PlanningDraftWorkspaceRecord | null;
  createdAt?: string;
  enforcePlanningPathBoundary: boolean;
}): PlanningDraftWorkspaceRecord {
  if (
    input.registration.branch !== input.branch ||
    input.registration.head !== input.baseCommit ||
    fs.realpathSync(input.worktreePath) !== input.worktreePath
  ) {
    throw planningWorkspaceError(
      'PLANNING_WORKSPACE_OWNERSHIP_MISMATCH',
      'Planning worktree Git ownership no longer matches its pinned draft.',
    );
  }
  const worktree = discoverRepository(input.worktreePath);
  if (
    worktree.repositoryRealPath !== input.worktreePath ||
    worktree.gitCommonDirectory !== input.gitCommonDirectory ||
    worktree.branch !== input.branch ||
    worktree.head !== input.baseCommit
  ) {
    throw planningWorkspaceError(
      'PLANNING_WORKSPACE_OWNERSHIP_MISMATCH',
      'Planning worktree repository identity is not exact.',
    );
  }
  if (input.enforcePlanningPathBoundary) {
    const changedPaths = listChangedPaths(input.worktreePath, input.baseCommit);
    try {
      assertPlanningPaths(
        input.changeRoot,
        input.changeId,
        changedPaths,
        [],
        'expense-app-v2',
      );
    } catch {
      throw planningWorkspaceError(
        'PLANNING_WORKSPACE_DIRTY',
        'Planning worktree contains bytes outside its named planning tree.',
      );
    }
  }

  const record: PlanningDraftWorkspaceRecord = {
    schemaVersion: 1,
    kind: 'planning-draft-workspace.v1',
    changeId: input.changeId,
    branch: input.branch,
    baseCommit: input.baseCommit,
    gitCommonDirectory: input.gitCommonDirectory,
    worktreePath: input.worktreePath,
    createdAt:
      input.existingRecord?.createdAt ??
      input.createdAt ??
      resolveCreatedAt(new Date()),
  };
  if (
    input.existingRecord &&
    canonicalJson(input.existingRecord) !== canonicalJson(record)
  ) {
    throw planningWorkspaceError(
      'PLANNING_WORKSPACE_OWNERSHIP_MISMATCH',
      'Durable planning workspace ownership does not match Git.',
    );
  }
  return record;
}

function isPrimaryWorktree(
  repositoryRoot: string,
  gitCommonDirectory: string,
): boolean {
  const gitDirectoryValue = runGit(repositoryRoot, [
    'rev-parse',
    '--git-dir',
  ]).trim();
  const gitDirectory = fs.realpathSync(
    path.isAbsolute(gitDirectoryValue)
      ? gitDirectoryValue
      : path.resolve(repositoryRoot, gitDirectoryValue),
  );
  return gitDirectory === gitCommonDirectory;
}

function resolveWorkspaceParent(
  repository: ReturnType<typeof discoverRepository>,
  options: PreparePlanningDraftWorkspaceOptions,
): string {
  const candidate =
    options.workspaceParent ??
    path.join(
      path.dirname(repository.repositoryRealPath),
      `${path.basename(repository.repositoryRealPath)}-worktrees`,
    );
  if (!path.isAbsolute(candidate)) {
    throw planningWorkspaceError(
      'PLANNING_WORKSPACE_PATH_INVALID',
      'Planning workspace parent must be an absolute path.',
    );
  }
  ensurePlainDirectory(candidate);
  assertPlainDirectory(candidate);
  return fs.realpathSync(candidate);
}

function assertWorkspaceOutsideAuthorityRoots(
  candidate: string,
  repositoryRoot: string,
  gitCommonDirectory: string,
): void {
  if (
    pathContainedBy(candidate, repositoryRoot) ||
    pathContainedBy(candidate, gitCommonDirectory)
  ) {
    throw planningWorkspaceError(
      'PLANNING_WORKSPACE_PATH_INVALID',
      'Planning worktree must be outside the source worktree and Git common directory.',
    );
  }
}

function pathContainedBy(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function resolveBaseCommit(repositoryRoot: string, value: string): string {
  if (!FULL_COMMIT_OID.test(value)) {
    throw planningWorkspaceError(
      'PLANNING_WORKSPACE_BASE_INVALID',
      'Planning workspace base must be a full commit OID.',
    );
  }
  let resolved: string;
  try {
    resolved = runGit(repositoryRoot, [
      'rev-parse',
      '--verify',
      `${value}^{commit}`,
    ]).trim();
  } catch {
    throw planningWorkspaceError(
      'PLANNING_WORKSPACE_BASE_INVALID',
      'Planning workspace base commit does not exist.',
    );
  }
  if (resolved !== value) {
    throw planningWorkspaceError(
      'PLANNING_WORKSPACE_BASE_INVALID',
      'Planning workspace base did not resolve exactly.',
    );
  }
  return resolved;
}

function listWorktreeRegistrations(
  repositoryRoot: string,
): WorktreeRegistration[] {
  const fields = runGit(repositoryRoot, [
    'worktree',
    'list',
    '--porcelain',
    '-z',
  ]).split('\0');
  const registrations: WorktreeRegistration[] = [];
  let current: {
    worktreePath?: string;
    head?: string;
    branch?: string | null;
  } = {};
  for (const field of fields) {
    if (field === '') {
      if (current.worktreePath && current.head) {
        registrations.push({
          worktreePath: canonicalExistingPath(current.worktreePath),
          head: current.head,
          branch: current.branch ?? null,
        });
      }
      current = {};
      continue;
    }
    if (field.startsWith('worktree ')) {
      current.worktreePath = field.slice('worktree '.length);
    } else if (field.startsWith('HEAD ')) {
      current.head = field.slice('HEAD '.length);
    } else if (field.startsWith('branch refs/heads/')) {
      current.branch = field.slice('branch refs/heads/'.length);
    }
  }
  return registrations;
}

function canonicalExistingPath(value: string): string {
  const absolute = path.resolve(value);
  return fs.realpathSync(absolute);
}

function readBranchOid(repositoryRoot: string, branch: string): string | null {
  const value = runGit(
    repositoryRoot,
    ['rev-parse', '--verify', `refs/heads/${branch}`],
    true,
  ).trim();
  return value || null;
}

function cleanupExactCreatedBranch(
  repositoryRoot: string,
  branch: string,
  baseCommit: string,
): void {
  if (readBranchOid(repositoryRoot, branch) === baseCommit) {
    runGit(repositoryRoot, [
      'update-ref',
      '-d',
      `refs/heads/${branch}`,
      baseCommit,
    ]);
  }
}

function persistPlanningDraftWorkspace(
  gitCommonDirectory: string,
  runtimeDirectory: string,
  record: PlanningDraftWorkspaceRecord,
): void {
  const recordPath = planningDraftRecordPath(
    gitCommonDirectory,
    runtimeDirectory,
    record.changeId,
  );
  ensurePlainDirectory(path.dirname(recordPath));
  const existing = fs.lstatSync(recordPath, { throwIfNoEntry: false });
  if (existing) {
    const observed = readPlanningDraftWorkspaceRecord(
      gitCommonDirectory,
      runtimeDirectory,
      record.changeId,
    );
    if (canonicalJson(observed) !== canonicalJson(record)) {
      throw planningWorkspaceError(
        'PLANNING_WORKSPACE_OWNERSHIP_MISMATCH',
        'Planning workspace ownership was already claimed differently.',
      );
    }
    return;
  }
  replaceTextAtomic(recordPath, `${canonicalJson(record)}\n`, {
    allowCreate: true,
    defaultMode: 0o600,
  });
  fsyncDirectory(path.dirname(recordPath));
}

function readPlanningDraftWorkspaceRecord(
  gitCommonDirectory: string,
  runtimeDirectory: string,
  changeId: string,
): PlanningDraftWorkspaceRecord | null {
  const recordPath = planningDraftRecordPath(
    gitCommonDirectory,
    runtimeDirectory,
    changeId,
  );
  const before = fs.lstatSync(recordPath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (!before) {
    return null;
  }
  let descriptor: number | undefined;
  try {
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      (before.mode & 0o777n) !== 0o600n ||
      before.size > BigInt(MAX_RECORD_BYTES) ||
      fs.realpathSync(recordPath) !== recordPath
    ) {
      throw new Error('unsafe planning workspace record');
    }
    descriptor = fs.openSync(
      recordPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFile(before, opened)) {
      throw new Error('planning workspace record changed before read');
    }
    const raw = fs.readFileSync(descriptor, 'utf8');
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(recordPath, { bigint: true });
    if (!sameFile(opened, after) || !sameFile(before, pathAfter)) {
      throw new Error('planning workspace record changed during read');
    }
    const value = parsePlanningDraftWorkspaceRecord(raw, changeId);
    if (`${canonicalJson(value)}\n` !== raw) {
      throw new Error('planning workspace record is not canonical');
    }
    return value;
  } catch {
    throw planningWorkspaceError(
      'PLANNING_WORKSPACE_RECORD_CORRUPT',
      'Durable planning workspace ownership is missing, unsafe, or malformed.',
    );
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function parsePlanningDraftWorkspaceRecord(
  raw: string,
  changeId: string,
): PlanningDraftWorkspaceRecord {
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'baseCommit',
      'branch',
      'changeId',
      'createdAt',
      'gitCommonDirectory',
      'kind',
      'schemaVersion',
      'worktreePath',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'planning-draft-workspace.v1' ||
    value.changeId !== changeId ||
    typeof value.branch !== 'string' ||
    typeof value.baseCommit !== 'string' ||
    !FULL_COMMIT_OID.test(value.baseCommit) ||
    typeof value.gitCommonDirectory !== 'string' ||
    !path.isAbsolute(value.gitCommonDirectory) ||
    fs.realpathSync(value.gitCommonDirectory) !== value.gitCommonDirectory ||
    typeof value.worktreePath !== 'string' ||
    !path.isAbsolute(value.worktreePath) ||
    fs.realpathSync(value.worktreePath) !== value.worktreePath ||
    typeof value.createdAt !== 'string' ||
    new Date(value.createdAt).toISOString() !== value.createdAt
  ) {
    throw new Error('invalid planning workspace record');
  }
  return value as PlanningDraftWorkspaceRecord;
}

function planningDraftRecordPath(
  gitCommonDirectory: string,
  runtimeDirectory: string,
  changeId: string,
): string {
  return path.join(
    runtimePaths(gitCommonDirectory, runtimeDirectory).root,
    'planning-drafts',
    `${changeId}.json`,
  );
}

function resolveCreatedAt(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw planningWorkspaceError(
      'PLANNING_WORKSPACE_TIME_INVALID',
      'Planning workspace creation time is invalid.',
    );
  }
  return value.toISOString();
}

function sameFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink &&
    left.mode === right.mode
  );
}

function pathExists(value: string): boolean {
  return fs.lstatSync(value, { throwIfNoEntry: false }) !== undefined;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function planningWorkspaceError(code: string, message: string) {
  return workflowError(code, message, ExitCode.staleState);
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
