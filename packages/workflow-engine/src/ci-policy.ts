import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';
import { assertChangeId, assertTaskId, normalizePolicyPath } from './paths.ts';

export type BootstrapException = {
  changeId: string;
  taskIds: string[];
  compatibilityCommits: BootstrapCompatibilityCommit[];
  introductionPaths: string[];
  allowedPaths: string[];
};

export type BootstrapCompatibilityCommit = {
  taskId: string;
  subject: string;
  changedPaths: string[];
};

export type PlanningBootstrapException = {
  changeId: string;
  subject: string;
  expectedParent: string;
  changedPaths: string[];
  fileDigests: Record<string, string>;
};

export function loadCiPolicy(repositoryRoot: string): BootstrapException[] {
  return loadPolicyDocument(repositoryRoot).bootstrapExceptions;
}

export function loadPlanningBootstrapPolicy(
  repositoryRoot: string,
): PlanningBootstrapException[] {
  return loadPolicyDocument(repositoryRoot).planningBootstrapExceptions;
}

function loadPolicyDocument(repositoryRoot: string): {
  bootstrapExceptions: BootstrapException[];
  planningBootstrapExceptions: PlanningBootstrapException[];
} {
  const policyPath = path.join(repositoryRoot, 'workflow/ci-policy.json');
  if (!fs.existsSync(policyPath)) {
    return { bootstrapExceptions: [], planningBootstrapExceptions: [] };
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  } catch {
    throw invalidPolicy();
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.bootstrapExceptions)
  ) {
    throw invalidPolicy();
  }
  const allowedRootKeys = [
    'schemaVersion',
    'bootstrapExceptions',
    'planningBootstrapExceptions',
  ];
  if (Object.keys(value).some((key) => !allowedRootKeys.includes(key))) {
    throw invalidPolicy();
  }
  const exceptions = value.bootstrapExceptions.map(parseException);
  const planningValues = value.planningBootstrapExceptions ?? [];
  if (!Array.isArray(planningValues)) {
    throw invalidPolicy();
  }
  const planningBootstrapExceptions = planningValues.map(
    parsePlanningBootstrapException,
  );
  if (
    new Set(exceptions.map(({ changeId }) => changeId)).size !==
      exceptions.length ||
    new Set(planningBootstrapExceptions.map(({ changeId }) => changeId))
      .size !== planningBootstrapExceptions.length ||
    planningBootstrapExceptions.length > 1
  ) {
    throw invalidPolicy();
  }
  return {
    bootstrapExceptions: exceptions,
    planningBootstrapExceptions,
  };
}

function parsePlanningBootstrapException(
  value: unknown,
): PlanningBootstrapException {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'changeId',
          'subject',
          'expectedParent',
          'changedPaths',
          'fileDigests',
        ].includes(key),
    ) ||
    typeof value.changeId !== 'string' ||
    typeof value.subject !== 'string' ||
    !value.subject ||
    value.subject.length > 200 ||
    /[\r\n\0]/.test(value.subject) ||
    typeof value.expectedParent !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.expectedParent) ||
    !isStringArray(value.changedPaths) ||
    value.changedPaths.length === 0 ||
    !isRecord(value.fileDigests)
  ) {
    throw invalidPolicy();
  }
  const changedPaths = value.changedPaths.map(normalizePolicyPath).sort();
  const fileDigests = Object.fromEntries(
    Object.entries(value.fileDigests)
      .map(([filePath, digest]) => {
        if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
          throw invalidPolicy();
        }
        return [normalizePolicyPath(filePath), digest] as const;
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  if (
    new Set(changedPaths).size !== changedPaths.length ||
    JSON.stringify(Object.keys(fileDigests)) !== JSON.stringify(changedPaths)
  ) {
    throw invalidPolicy();
  }
  return {
    changeId: assertChangeId(value.changeId),
    subject: value.subject,
    expectedParent: value.expectedParent,
    changedPaths,
    fileDigests,
  };
}

function parseException(value: unknown): BootstrapException {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'changeId',
          'taskIds',
          'compatibilityCommits',
          'introductionPaths',
          'allowedPaths',
        ].includes(key),
    ) ||
    typeof value.changeId !== 'string' ||
    !isStringArray(value.taskIds) ||
    !Array.isArray(value.compatibilityCommits) ||
    !isStringArray(value.introductionPaths) ||
    !isStringArray(value.allowedPaths) ||
    value.taskIds.length === 0 ||
    value.introductionPaths.length === 0 ||
    value.allowedPaths.length === 0
  ) {
    throw invalidPolicy();
  }
  const changeId = assertChangeId(String(value.changeId));
  const taskIds = value.taskIds.map(assertTaskId);
  const compatibilityCommits = value.compatibilityCommits.map(
    parseCompatibilityCommit,
  );
  const introductionPaths = value.introductionPaths.map(normalizePolicyPath);
  const allowedPaths = value.allowedPaths.map(normalizePolicyPath);
  if (
    [taskIds, introductionPaths, allowedPaths].some(
      (items) => new Set(items).size !== items.length,
    ) ||
    new Set(
      compatibilityCommits.map(
        ({ taskId, subject }) => `${taskId}\0${subject}`,
      ),
    ).size !== compatibilityCommits.length
  ) {
    throw invalidPolicy();
  }
  return {
    changeId,
    taskIds,
    compatibilityCommits,
    introductionPaths,
    allowedPaths,
  };
}

function parseCompatibilityCommit(
  value: unknown,
): BootstrapCompatibilityCommit {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !['taskId', 'subject', 'changedPaths'].includes(key),
    ) ||
    typeof value.taskId !== 'string' ||
    typeof value.subject !== 'string' ||
    value.subject.length === 0 ||
    value.subject.length > 200 ||
    /[\r\n\0]/.test(value.subject) ||
    !isStringArray(value.changedPaths) ||
    value.changedPaths.length === 0
  ) {
    throw invalidPolicy();
  }
  const changedPaths = value.changedPaths.map(normalizePolicyPath).sort();
  if (new Set(changedPaths).size !== changedPaths.length) {
    throw invalidPolicy();
  }
  return {
    taskId: assertTaskId(value.taskId),
    subject: value.subject,
    changedPaths,
  };
}

function invalidPolicy() {
  return workflowError(
    'CI_POLICY_INVALID',
    'workflow/ci-policy.json is invalid.',
    ExitCode.guard,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}
