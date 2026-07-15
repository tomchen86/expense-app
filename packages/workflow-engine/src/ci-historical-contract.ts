import { readFileAtCommit } from './ci-git.ts';
import {
  parseCheckCommand,
  parseTasks,
  type CheckDefinition,
  type ParsedTask,
} from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { assertChangeId, assertTaskId, normalizePolicyPath } from './paths.ts';

export type HistoricalTaskAuthority = {
  changeId: string;
  taskId: string;
  tasksPath: string;
  tasks: ParsedTask[];
  allowedPaths: string[];
  requiredChecks: string[];
  checkDefinitions: Record<string, string>;
};

type HistoricalTaskPolicy = {
  allowedPaths: string[];
  requiredChecks: string[];
  checkDefinitions: Record<string, string>;
};

export function loadHistoricalTaskAuthority(
  repositoryRoot: string,
  commit: string,
  requestedChangeId: string,
  requestedTaskId: string,
  changeRoot = 'openspec/changes',
): HistoricalTaskAuthority {
  const changeId = assertChangeId(requestedChangeId);
  const taskId = assertTaskId(requestedTaskId);
  const tasksPath = `${changeRoot}/${changeId}/tasks.md`;
  const tasksContent = requiredFile(repositoryRoot, commit, tasksPath);
  const tasks = parseTasks(tasksContent);

  const guardPath = `${changeRoot}/${changeId}/guard.json`;
  const guard = parseJson(
    requiredFile(repositoryRoot, commit, guardPath),
    'CI_PARENT_GUARD_INVALID',
  );
  if (
    !isRecord(guard) ||
    !hasExactKeys(guard, ['changeId', 'schemaVersion', 'tasks']) ||
    guard.schemaVersion !== 1 ||
    guard.changeId !== changeId ||
    !isRecord(guard.tasks)
  ) {
    throw ciContractError(
      'CI_PARENT_GUARD_INVALID',
      'The parent guard contract is invalid.',
    );
  }
  const guardTasks = guard.tasks;
  const taskIds = tasks.map(({ id }) => id).sort();
  const guardTaskIds = Object.keys(guardTasks).sort();
  if (JSON.stringify(taskIds) !== JSON.stringify(guardTaskIds)) {
    throw ciContractError(
      'CI_PARENT_GUARD_INVALID',
      'The parent tasks and guard policies are not one-to-one.',
    );
  }

  const checks = parseJson(
    requiredFile(repositoryRoot, commit, 'workflow/checks.json'),
    'CI_PARENT_CHECKS_INVALID',
  );
  if (
    !isRecord(checks) ||
    !hasExactKeys(checks, ['checks', 'schemaVersion']) ||
    checks.schemaVersion !== 1 ||
    !isRecord(checks.checks)
  ) {
    throw ciContractError(
      'CI_PARENT_CHECKS_INVALID',
      'The parent check registry is invalid.',
    );
  }
  const registry = parseCheckRegistry(checks.checks);
  const policies = Object.fromEntries(
    taskIds.map((currentTaskId) => [
      currentTaskId,
      parseTaskPolicy(guardTasks[currentTaskId], registry),
    ]),
  );
  const task = tasks.find(({ id }) => id === taskId);
  if (!task || task.completed) {
    throw ciContractError(
      'CI_MANAGED_TRAILER_UNKNOWN',
      'A task commit must name an incomplete task in its parent contract.',
    );
  }
  const policy = policies[taskId];

  return {
    changeId,
    taskId,
    tasksPath,
    tasks,
    allowedPaths: policy.allowedPaths,
    requiredChecks: policy.requiredChecks,
    checkDefinitions: policy.checkDefinitions,
  };
}

export function canonicalCheckDefinition(definition: CheckDefinition): string {
  return JSON.stringify({
    command: definition.command,
    destructiveDatabase: definition.destructiveDatabase,
  });
}

function parseCheckRegistry(
  value: Record<string, unknown>,
): Record<string, CheckDefinition> {
  return Object.fromEntries(
    Object.entries(value).map(([checkId, definition]) => {
      if (
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(checkId) ||
        !isRecord(definition) ||
        !hasExactKeys(definition, ['command', 'destructiveDatabase']) ||
        !isStringArray(definition.command) ||
        !parseCheckCommand(definition.command) ||
        typeof definition.destructiveDatabase !== 'boolean'
      ) {
        throw ciContractError(
          'CI_PARENT_CHECKS_INVALID',
          `The parent check definition is invalid: ${checkId}.`,
        );
      }
      return [
        checkId,
        {
          command: definition.command,
          destructiveDatabase: definition.destructiveDatabase,
        },
      ];
    }),
  );
}

function parseTaskPolicy(
  value: unknown,
  registry: Record<string, CheckDefinition>,
): HistoricalTaskPolicy {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['allowedPaths', 'requiredChecks']) ||
    !isStringArray(value.allowedPaths) ||
    value.allowedPaths.length === 0 ||
    !isStringArray(value.requiredChecks) ||
    value.requiredChecks.length === 0
  ) {
    throw ciContractError(
      'CI_PARENT_GUARD_INVALID',
      'A parent task policy is invalid.',
    );
  }
  const allowedPaths = value.allowedPaths.map(normalizePolicyPath);
  const requiredChecks = value.requiredChecks.map((checkId) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(checkId)) {
      throw ciContractError(
        'CI_PARENT_GUARD_INVALID',
        'A parent task policy contains an invalid check ID.',
      );
    }
    return checkId;
  });
  if (
    new Set(allowedPaths).size !== allowedPaths.length ||
    new Set(requiredChecks).size !== requiredChecks.length
  ) {
    throw ciContractError(
      'CI_PARENT_GUARD_INVALID',
      'A parent task policy contains duplicate authority.',
    );
  }
  const checkDefinitions = Object.fromEntries(
    requiredChecks.map((checkId) => {
      const definition = registry[checkId];
      if (!definition) {
        throw ciContractError(
          'CI_PARENT_CHECKS_INVALID',
          `The parent check definition is missing: ${checkId}.`,
        );
      }
      return [checkId, canonicalCheckDefinition(definition)];
    }),
  );
  return { allowedPaths, requiredChecks, checkDefinitions };
}

function requiredFile(
  repositoryRoot: string,
  commit: string,
  filePath: string,
): string {
  const content = readFileAtCommit(repositoryRoot, commit, filePath);
  if (content === undefined) {
    throw ciContractError(
      'CI_PARENT_CONTRACT_MISSING',
      `The parent contract is missing ${filePath}.`,
    );
  }
  return content;
}

function parseJson(content: string, code: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw ciContractError(code, 'A historical workflow contract is invalid.');
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function ciContractError(code: string, message: string) {
  return workflowError(code, message, ExitCode.verification);
}
