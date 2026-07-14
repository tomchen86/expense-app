import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';
import { renderIssueLog } from './issue-renderer.ts';

export type IssueCategory = 'feature' | 'bug' | 'enhancement';
export type IssueStatus =
  'proposed' | 'in-progress' | 'done' | 'blocked' | 'icebox';
export type IssuePriority = 'Now' | 'Next' | 'Later';

export type Issue = {
  id: string;
  category: IssueCategory;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  requirement: { label: string; href: string } | null;
  references: string[];
  notes: string;
  closed?: { date: string; notes: string };
};

export type IssueData = {
  schemaVersion: 1;
  lastUpdated: string;
  issues: Issue[];
};

export type IssueUpdateField = 'title' | 'status' | 'priority' | 'notes';

export function readIssueData(repositoryRoot: string): IssueData {
  const sourcePath = issueSourcePath(repositoryRoot);
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  } catch (error) {
    throw workflowError(
      'ISSUE_SOURCE_UNREADABLE',
      'Unable to read JSON-compatible issue YAML.',
      ExitCode.verification,
      {
        details: {
          path: relative(repositoryRoot, sourcePath),
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    );
  }
  if (!isIssueData(value)) {
    throw workflowError(
      'ISSUE_SOURCE_INVALID',
      'Structured issue data does not match schema version 1.',
      ExitCode.verification,
    );
  }
  assertUniqueAndOrdered(value.issues);
  return value;
}

export function writeIssueData(repositoryRoot: string, data: IssueData): void {
  if (!isIssueData(data)) {
    throw workflowError(
      'ISSUE_SOURCE_INVALID',
      'Structured issue data does not match schema version 1.',
      ExitCode.usage,
    );
  }
  data.issues.sort((left, right) => left.id.localeCompare(right.id));
  assertUniqueAndOrdered(data.issues);
  writeTextAtomic(
    issueSourcePath(repositoryRoot),
    `${JSON.stringify(data, null, 2)}\n`,
  );
}

export function addIssue(repositoryRoot: string, issue: Issue): IssueData {
  const data = readIssueData(repositoryRoot);
  if (data.issues.some(({ id }) => id === issue.id)) {
    throw issueError('ISSUE_ALREADY_EXISTS', `Issue ${issue.id} exists.`);
  }
  const updated: IssueData = {
    ...data,
    lastUpdated: today(),
    issues: [...data.issues, issue],
  };
  writeIssueData(repositoryRoot, updated);
  return updated;
}

export function updateIssue(
  repositoryRoot: string,
  issueId: string,
  field: IssueUpdateField,
  value: string,
): IssueData {
  const data = readIssueData(repositoryRoot);
  const issue = findIssue(data, issueId);
  const updatedIssue: Issue = { ...issue, [field]: value };
  if (!isIssue(updatedIssue)) {
    throw issueError(
      'INVALID_ISSUE_UPDATE',
      `Value is invalid for issue field ${field}.`,
    );
  }
  const updated = replaceIssue(data, updatedIssue);
  writeIssueData(repositoryRoot, updated);
  return updated;
}

export function closeIssue(
  repositoryRoot: string,
  issueId: string,
  date: string,
  notes: string,
): IssueData {
  const data = readIssueData(repositoryRoot);
  const issue = findIssue(data, issueId);
  const updated = replaceIssue(data, {
    ...issue,
    status: 'done',
    closed: { date, notes },
  });
  writeIssueData(repositoryRoot, updated);
  return updated;
}

export function renderIssues(repositoryRoot: string): string {
  const rendered = renderIssueLog(readIssueData(repositoryRoot));
  writeTextAtomic(issueLogPath(repositoryRoot), rendered);
  return rendered;
}

export function validateIssueLog(repositoryRoot: string): void {
  const expected = renderIssueLog(readIssueData(repositoryRoot));
  let actual: string;
  try {
    actual = fs.readFileSync(issueLogPath(repositoryRoot), 'utf8');
  } catch {
    throw issueError(
      'ISSUE_LOG_MISSING',
      'Generated docs/ISSUE_LOG.md is missing.',
    );
  }
  if (actual !== expected) {
    throw issueError(
      'ISSUE_LOG_DRIFT',
      'docs/ISSUE_LOG.md differs from deterministic structured issue output.',
    );
  }
}

function replaceIssue(data: IssueData, replacement: Issue): IssueData {
  return {
    ...data,
    lastUpdated: today(),
    issues: data.issues.map((issue) =>
      issue.id === replacement.id ? replacement : issue,
    ),
  };
}

function findIssue(data: IssueData, issueId: string): Issue {
  const issue = data.issues.find(({ id }) => id === issueId);
  if (!issue) {
    throw issueError('UNKNOWN_ISSUE', `Issue ${issueId} does not exist.`);
  }
  return issue;
}

function isIssueData(value: unknown): value is IssueData {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    isDate(value.lastUpdated) &&
    Array.isArray(value.issues) &&
    value.issues.every(isIssue)
  );
}

function isIssue(value: unknown): value is Issue {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  const allowed = [
    'id',
    'category',
    'title',
    'status',
    'priority',
    'requirement',
    'references',
    'notes',
    'closed',
  ];
  return (
    keys.every((key) => allowed.includes(key)) &&
    isIssueIdForCategory(value.id, value.category) &&
    isNonEmpty(value.title) &&
    ['proposed', 'in-progress', 'done', 'blocked', 'icebox'].includes(
      String(value.status),
    ) &&
    ['Now', 'Next', 'Later'].includes(String(value.priority)) &&
    (value.requirement === null || isRequirement(value.requirement)) &&
    Array.isArray(value.references) &&
    value.references.every(isNonEmpty) &&
    typeof value.notes === 'string' &&
    (value.closed === undefined || isClosed(value.closed))
  );
}

function isIssueIdForCategory(
  id: unknown,
  category: unknown,
): category is IssueCategory {
  const match = typeof id === 'string' ? /^ISS-(\d{3})$/.exec(id) : null;
  if (!match || !['feature', 'bug', 'enhancement'].includes(String(category))) {
    return false;
  }
  const number = Number(match[1]);
  return (
    (category === 'feature' && number < 100) ||
    (category === 'bug' && number >= 100 && number < 200) ||
    (category === 'enhancement' && number >= 200)
  );
}

function isRequirement(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    isNonEmpty(value.label) &&
    isNonEmpty(value.href)
  );
}

function isClosed(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    isDate(value.date) &&
    isNonEmpty(value.notes)
  );
}

function assertUniqueAndOrdered(issues: Issue[]): void {
  const ids = issues.map(({ id }) => id);
  if (
    new Set(ids).size !== ids.length ||
    JSON.stringify(ids) !== JSON.stringify([...ids].sort())
  ) {
    throw issueError(
      'ISSUE_ORDER_INVALID',
      'Issue IDs must be unique and lexicographically ordered.',
    );
  }
}

function writeTextAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw issueError('ISSUE_PATH_UNSAFE', 'Managed issue path is not a file.');
  }
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', existing?.mode ?? 0o644);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function issueSourcePath(repositoryRoot: string): string {
  return path.join(repositoryRoot, 'docs/issues/issues.yaml');
}

function issueLogPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, 'docs/ISSUE_LOG.md');
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  );
}

function isNonEmpty(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issueError(code: string, message: string) {
  return workflowError(code, message, ExitCode.verification);
}

function relative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}
