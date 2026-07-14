import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';
import { assertSessionId } from './paths.ts';

export type WorkflowReport = {
  schemaVersion: 1;
  kind: 'check' | 'completion' | 'finish' | 'commit';
  sessionId: string;
  changeId: string;
  taskId: string;
  createdAt: string;
  parentReportId?: string;
  [key: string]: unknown;
};

export function writeImmutableReport(
  reportsRoot: string,
  report: WorkflowReport,
): string {
  assertSessionId(report.sessionId);
  if (
    report.parentReportId !== undefined &&
    !/^[0-9a-f]{64}$/.test(report.parentReportId)
  ) {
    throw invalidReport(
      'INVALID_PARENT_REPORT',
      'Parent report ID is invalid.',
    );
  }
  const content = `${JSON.stringify(report, null, 2)}\n`;
  const reportId = digest(content);
  const directory = path.join(reportsRoot, report.sessionId);
  const reportPath = path.join(directory, `${reportId}.json`);
  fs.mkdirSync(directory, { recursive: true });
  assertPlainDirectory(reportsRoot);
  assertPlainDirectory(directory);

  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = fs.openSync(reportPath, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    if (isNodeError(error) && error.code === 'EEXIST') {
      const existing = fs.readFileSync(reportPath, 'utf8');
      if (existing === content) {
        return reportId;
      }
      throw invalidReport(
        'REPORT_ID_COLLISION',
        'An immutable report path contains different content.',
      );
    }
    if (created) {
      fs.rmSync(reportPath, { force: true });
    }
    throw error;
  }
  return reportId;
}

export function readImmutableReport(
  reportsRoot: string,
  sessionId: string,
  reportId: string,
): WorkflowReport {
  assertSessionId(sessionId);
  if (!/^[0-9a-f]{64}$/.test(reportId)) {
    throw invalidReport('INVALID_REPORT_ID', 'Report ID is invalid.');
  }
  const reportPath = path.join(reportsRoot, sessionId, `${reportId}.json`);
  assertPlainDirectory(reportsRoot);
  assertPlainDirectory(path.join(reportsRoot, sessionId));
  let content: string;
  try {
    content = fs.readFileSync(reportPath, 'utf8');
  } catch {
    throw invalidReport('REPORT_UNREADABLE', 'Workflow report is unavailable.');
  }
  if (digest(content) !== reportId) {
    throw invalidReport(
      'REPORT_DIGEST_MISMATCH',
      'Workflow report content does not match its content-addressed ID.',
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw invalidReport('REPORT_UNREADABLE', 'Workflow report is malformed.');
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !['check', 'completion', 'finish', 'commit'].includes(String(value.kind)) ||
    value.sessionId !== sessionId ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    (value.parentReportId !== undefined && !isDigest(value.parentReportId))
  ) {
    throw invalidReport('REPORT_INVALID', 'Workflow report is invalid.');
  }
  return value as WorkflowReport;
}

function assertPlainDirectory(directory: string): void {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw invalidReport(
      'REPORT_DIRECTORY_UNSAFE',
      'Workflow report directory is missing or is not a plain directory.',
    );
  }
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function invalidReport(code: string, message: string) {
  return workflowError(code, message, ExitCode.staleState);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
