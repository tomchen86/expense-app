import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';
import {
  assertChangeId,
  assertPolicyPathInsideRepository,
  assertTaskId,
  normalizePolicyPath,
} from './paths.ts';

export type WorkflowConfig = {
  schemaVersion: 1;
  repositoryName: string;
  changeRoot: string;
  runtimeDirectory: string;
  protectedBranches: string[];
  branchTemplate: string;
};

export type CheckDefinition = {
  command: string[];
  destructiveDatabase: boolean;
};

export type ChecksConfig = {
  schemaVersion: 1;
  checks: Record<string, CheckDefinition>;
};

export type ParsedCheckCommand =
  | {
      runner: 'node';
      args: string[];
      entrypoints: string[];
    }
  | {
      runner: 'node-package-bin';
      workspace: string;
      packageName: string;
      binName: string;
      args: string[];
    };

export type TaskPolicy = {
  allowedPaths: string[];
  requiredChecks: string[];
};

export type GuardContract = {
  schemaVersion: 1;
  changeId: string;
  tasks: Record<string, TaskPolicy>;
};

export type ParsedTask = {
  id: string;
  completed: boolean;
  title: string;
};

export type ChangeContract = {
  changeId: string;
  changeDirectory: string;
  config: WorkflowConfig;
  checks: ChecksConfig;
  guard: GuardContract;
  tasks: ParsedTask[];
  artifactPaths: string[];
  artifactDigests: Record<string, string>;
};

export function loadWorkflowConfig(repositoryRoot: string): WorkflowConfig {
  const configPath = path.join(repositoryRoot, 'workflow/config.json');
  const value = readJson(configPath, 'workflow configuration');

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.repositoryName !== 'string' ||
    typeof value.changeRoot !== 'string' ||
    typeof value.runtimeDirectory !== 'string' ||
    !isStringArray(value.protectedBranches) ||
    typeof value.branchTemplate !== 'string' ||
    !value.branchTemplate.includes('{changeId}')
  ) {
    throw invalidContract(
      'INVALID_WORKFLOW_CONFIG',
      'workflow/config.json does not match schema version 1.',
      configPath,
    );
  }

  normalizePolicyPath(value.changeRoot);
  normalizePolicyPath(value.runtimeDirectory);

  return value as WorkflowConfig;
}

export function loadChecksConfig(repositoryRoot: string): ChecksConfig {
  const checksPath = path.join(repositoryRoot, 'workflow/checks.json');
  const value = readJson(checksPath, 'check configuration');

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isRecord(value.checks)
  ) {
    throw invalidContract(
      'INVALID_CHECKS_CONFIG',
      'workflow/checks.json does not match schema version 1.',
      checksPath,
    );
  }

  for (const [checkId, definition] of Object.entries(value.checks)) {
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(checkId) ||
      !isRecord(definition) ||
      !isStringArray(definition.command) ||
      !parseCheckCommand(definition.command) ||
      typeof definition.destructiveDatabase !== 'boolean'
    ) {
      throw invalidContract(
        'INVALID_CHECK_DEFINITION',
        `Invalid check definition: ${checkId}`,
        checksPath,
      );
    }
  }

  return value as ChecksConfig;
}

export function parseCheckCommand(
  command: string[],
): ParsedCheckCommand | undefined {
  if (
    command.length < 2 ||
    command.some(
      (part) =>
        part.trim() !== part ||
        [...part].some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint <= 31 || codePoint === 127;
        }),
    )
  ) {
    return undefined;
  }

  if (command[0] === 'node') {
    const args = command.slice(1);
    const entrypoints = nodeEntrypoints(args);
    return entrypoints ? { runner: 'node', args, entrypoints } : undefined;
  }
  if (command[0] !== 'node-package-bin' || command.length < 4) {
    return undefined;
  }

  const [, workspace, packageName, binName, ...args] = command;
  if (
    (workspace !== '.' && !isExactPolicyPath(workspace)) ||
    !isPackageName(packageName) ||
    !isPackageSegment(binName)
  ) {
    return undefined;
  }

  return {
    runner: 'node-package-bin',
    workspace,
    packageName,
    binName,
    args,
  };
}

function nodeEntrypoints(args: string[]): string[] | undefined {
  let entrypoints: string[];
  if (args[0] === '--test') {
    entrypoints = args.slice(1);
  } else if (args[0] === '--experimental-strip-types' && args[1] === '--test') {
    entrypoints = args.slice(2);
  } else {
    if (!args[0] || args[0].startsWith('-')) {
      return undefined;
    }
    entrypoints = [args[0]];
  }

  return entrypoints.length > 0 && entrypoints.every(isExactPolicyPath)
    ? entrypoints
    : undefined;
}

function isExactPolicyPath(value: string): boolean {
  if (value.startsWith('-')) {
    return false;
  }
  try {
    normalizePolicyPath(value);
    return value !== '.' && !value.endsWith('/**');
  } catch {
    return false;
  }
}

function isPackageName(value: string): boolean {
  if (value.length > 214) {
    return false;
  }
  const segments = value.startsWith('@') ? value.slice(1).split('/') : [value];
  return (
    (segments.length === 1 || segments.length === 2) &&
    segments.every(isPackageSegment)
  );
}

function isPackageSegment(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(value);
}

export function loadChangeContract(
  repositoryRoot: string,
  requestedChangeId: string,
): ChangeContract {
  const changeId = assertChangeId(requestedChangeId);
  const config = loadWorkflowConfig(repositoryRoot);
  const checks = loadChecksConfig(repositoryRoot);
  const changeDirectory = path.join(
    repositoryRoot,
    config.changeRoot,
    changeId,
  );
  const proposalPath = path.join(changeDirectory, 'proposal.md');
  const designPath = path.join(changeDirectory, 'design.md');
  const tasksPath = path.join(changeDirectory, 'tasks.md');
  const guardPath = path.join(changeDirectory, 'guard.json');

  for (const requiredPath of [proposalPath, designPath, tasksPath, guardPath]) {
    if (!fs.statSync(requiredPath, { throwIfNoEntry: false })?.isFile()) {
      throw invalidContract(
        'MISSING_CHANGE_ARTIFACT',
        `Required change artifact is missing: ${relative(repositoryRoot, requiredPath)}`,
        requiredPath,
      );
    }
  }

  const specPaths = listMarkdownFiles(path.join(changeDirectory, 'specs'));
  if (specPaths.length === 0) {
    throw invalidContract(
      'MISSING_DELTA_SPEC',
      `Change ${changeId} must contain at least one delta spec.`,
      path.join(changeDirectory, 'specs'),
    );
  }

  const guard = parseGuardContract(guardPath, changeId);
  const tasks = parseTasks(fs.readFileSync(tasksPath, 'utf8'));

  if (tasks.length === 0) {
    throw invalidContract(
      'EMPTY_TASK_LIST',
      `Change ${changeId} has no parseable tasks.`,
      tasksPath,
    );
  }

  const markdownTaskIds = new Set(tasks.map((task) => task.id));
  const guardTaskIds = new Set(Object.keys(guard.tasks));
  const missingPolicies = [...markdownTaskIds].filter(
    (taskId) => !guardTaskIds.has(taskId),
  );
  const unknownPolicies = [...guardTaskIds].filter(
    (taskId) => !markdownTaskIds.has(taskId),
  );

  if (missingPolicies.length > 0 || unknownPolicies.length > 0) {
    throw invalidContract(
      'TASK_POLICY_MISMATCH',
      `tasks.md and guard.json task IDs differ for change ${changeId}.`,
      guardPath,
      { missingPolicies, unknownPolicies },
    );
  }

  for (const [taskId, policy] of Object.entries(guard.tasks)) {
    assertTaskId(taskId);
    validateTaskPolicy(repositoryRoot, taskId, policy, checks);
  }

  const artifactPaths = [
    proposalPath,
    designPath,
    tasksPath,
    guardPath,
    ...specPaths,
    path.join(repositoryRoot, 'workflow/config.json'),
    path.join(repositoryRoot, 'workflow/checks.json'),
  ];

  return {
    changeId,
    changeDirectory,
    config,
    checks,
    guard,
    tasks,
    artifactPaths,
    artifactDigests: digestArtifacts(repositoryRoot, artifactPaths),
  };
}

export function parseTasks(markdown: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  const seen = new Set<string>();
  const pattern = /^- \[([ xX])\] (\d+(?:\.\d+)+)\s+(.+)$/gm;

  for (const match of markdown.matchAll(pattern)) {
    const id = assertTaskId(match[2]);
    if (seen.has(id)) {
      throw workflowError(
        'DUPLICATE_TASK_ID',
        `Duplicate task ID in tasks.md: ${id}`,
        ExitCode.guard,
      );
    }
    seen.add(id);
    tasks.push({
      id,
      completed: match[1].toLowerCase() === 'x',
      title: match[3].trim(),
    });
  }

  return tasks;
}

export function digestArtifacts(
  repositoryRoot: string,
  artifactPaths: string[],
): Record<string, string> {
  return Object.fromEntries(
    artifactPaths
      .map((artifactPath) => [
        relative(repositoryRoot, artifactPath),
        crypto
          .createHash('sha256')
          .update(fs.readFileSync(artifactPath))
          .digest('hex'),
      ])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function parseGuardContract(
  guardPath: string,
  expectedChangeId: string,
): GuardContract {
  const value = readJson(guardPath, 'guard policy');

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.changeId !== expectedChangeId ||
    !isRecord(value.tasks) ||
    Object.keys(value.tasks).length === 0
  ) {
    throw invalidContract(
      'INVALID_GUARD_CONTRACT',
      `guard.json is invalid or does not name change ${expectedChangeId}.`,
      guardPath,
    );
  }

  for (const [taskId, policy] of Object.entries(value.tasks)) {
    if (
      !isRecord(policy) ||
      !isStringArray(policy.allowedPaths) ||
      policy.allowedPaths.length === 0 ||
      !isStringArray(policy.requiredChecks) ||
      policy.requiredChecks.length === 0
    ) {
      throw invalidContract(
        'INVALID_TASK_POLICY',
        `Invalid guard policy for task ${taskId}.`,
        guardPath,
      );
    }
  }

  return value as GuardContract;
}

function validateTaskPolicy(
  repositoryRoot: string,
  taskId: string,
  policy: TaskPolicy,
  checks: ChecksConfig,
): void {
  const normalizedPaths = policy.allowedPaths.map((policyPath) => {
    const normalized = normalizePolicyPath(policyPath);
    assertPolicyPathInsideRepository(repositoryRoot, normalized);
    return normalized;
  });

  if (new Set(normalizedPaths).size !== normalizedPaths.length) {
    throw workflowError(
      'DUPLICATE_ALLOWED_PATH',
      `Task ${taskId} contains duplicate allowed paths.`,
      ExitCode.guard,
    );
  }

  if (new Set(policy.requiredChecks).size !== policy.requiredChecks.length) {
    throw workflowError(
      'DUPLICATE_REQUIRED_CHECK',
      `Task ${taskId} contains duplicate required checks.`,
      ExitCode.guard,
    );
  }

  const unknownChecks = policy.requiredChecks.filter(
    (checkId) => !Object.hasOwn(checks.checks, checkId),
  );
  if (unknownChecks.length > 0) {
    throw workflowError(
      'UNKNOWN_REQUIRED_CHECK',
      `Task ${taskId} references unknown checks: ${unknownChecks.join(', ')}`,
      ExitCode.guard,
      { details: { taskId, unknownChecks } },
    );
  }
}

function listMarkdownFiles(directory: string): string[] {
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    return [];
  }

  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function readJson(filePath: string, label: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw workflowError(
      'UNREADABLE_CONTRACT',
      `Unable to read ${label}: ${relative(process.cwd(), filePath)}`,
      ExitCode.unsafeEnvironment,
      {
        details: {
          filePath,
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    );
  }
}

function invalidContract(
  code: string,
  message: string,
  filePath: string,
  details: Record<string, unknown> = {},
): ReturnType<typeof workflowError> {
  return workflowError(code, message, ExitCode.guard, {
    details: { filePath, ...details },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function relative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}
