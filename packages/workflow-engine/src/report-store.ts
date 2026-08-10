import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  isPlanningAssuranceBinding,
  type PlanningAssuranceBinding,
} from './contracts.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import {
  assertPlainDirectory as assertSafePlainDirectory,
  ensurePlainDirectory,
} from './filesystem-safety.ts';
import { assertSessionId } from './paths.ts';

export type WorkflowReport = {
  schemaVersion: 1;
  kind:
    | 'check'
    | 'completion'
    | 'finish'
    | 'commit'
    | 'authority-check'
    | 'implementation-reconciliation';
  sessionId: string;
  changeId: string;
  taskId: string;
  createdAt: string;
  parentReportId?: string;
  planningAssurance?: PlanningAssuranceBinding | null;
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
  ensureReportDirectory(reportsRoot);
  ensureReportDirectory(directory);

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
      const existing = readPlainReportFile(reportPath);
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
  assertReportDirectory(reportsRoot);
  assertReportDirectory(path.join(reportsRoot, sessionId));
  const content = readPlainReportFile(reportPath);
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
    ![
      'check',
      'completion',
      'finish',
      'commit',
      'authority-check',
      'implementation-reconciliation',
    ].includes(String(value.kind)) ||
    value.sessionId !== sessionId ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    (value.planningAssurance !== undefined &&
      value.planningAssurance !== null &&
      !isPlanningAssuranceBinding(value.planningAssurance)) ||
    (value.parentReportId !== undefined && !isDigest(value.parentReportId))
  ) {
    throw invalidReport('REPORT_INVALID', 'Workflow report is invalid.');
  }
  return value as WorkflowReport;
}

function ensureReportDirectory(directory: string): void {
  try {
    ensurePlainDirectory(directory);
  } catch (error) {
    translateUnsafeReportDirectory(error);
  }
}

function assertReportDirectory(directory: string): void {
  try {
    assertSafePlainDirectory(directory);
  } catch (error) {
    translateUnsafeReportDirectory(error);
  }
}

function translateUnsafeReportDirectory(error: unknown): never {
  if (
    error instanceof WorkflowError &&
    error.code === 'RUNTIME_DIRECTORY_UNSAFE'
  ) {
    throw invalidReport(
      'REPORT_DIRECTORY_UNSAFE',
      'Workflow report directory is missing or is not a plain directory.',
    );
  }
  throw error;
}

function readPlainReportFile(reportPath: string): string {
  const before = fs.lstatSync(reportPath, { throwIfNoEntry: false });
  if (!before) {
    throw invalidReport('REPORT_UNREADABLE', 'Workflow report is unavailable.');
  }
  if (!isPlainReportFile(before)) {
    throw unsafeReportFile();
  }

  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      reportPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !isPlainReportFile(opened) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw unsafeReportFile();
    }
    const content = fs.readFileSync(descriptor, 'utf8');
    const afterDescriptor = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(reportPath, { throwIfNoEntry: false });
    if (
      !isPlainReportFile(afterDescriptor) ||
      !afterPath ||
      !isPlainReportFile(afterPath) ||
      afterDescriptor.dev !== opened.dev ||
      afterDescriptor.ino !== opened.ino ||
      afterDescriptor.size !== opened.size ||
      afterPath.dev !== opened.dev ||
      afterPath.ino !== opened.ino
    ) {
      throw unsafeReportFile();
    }
    return content;
  } catch (error) {
    if (error instanceof WorkflowError) {
      throw error;
    }
    throw invalidReport('REPORT_UNREADABLE', 'Workflow report is unavailable.');
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function isPlainReportFile(stats: fs.Stats): boolean {
  return (
    stats.isFile() &&
    !stats.isSymbolicLink() &&
    stats.nlink === 1 &&
    (stats.mode & 0o777) === 0o600
  );
}

function unsafeReportFile(): WorkflowError {
  return invalidReport(
    'REPORT_FILE_UNSAFE',
    'Workflow report path is not a private plain file.',
  );
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
