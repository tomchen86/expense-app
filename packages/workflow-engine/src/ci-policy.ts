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

export function loadCiPolicy(repositoryRoot: string): BootstrapException[] {
  const policyPath = path.join(repositoryRoot, 'workflow/ci-policy.json');
  if (!fs.existsSync(policyPath)) {
    return [];
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
  const allowedRootKeys = ['schemaVersion', 'bootstrapExceptions'];
  if (Object.keys(value).some((key) => !allowedRootKeys.includes(key))) {
    throw invalidPolicy();
  }
  const exceptions = value.bootstrapExceptions.map(parseException);
  if (
    new Set(exceptions.map(({ changeId }) => changeId)).size !==
    exceptions.length
  ) {
    throw invalidPolicy();
  }
  return exceptions;
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
