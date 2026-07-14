import { digestRequiredCheckDefinitions } from './contract-digests.ts';
import { parseTasks } from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { readImmutableReport, type WorkflowReport } from './report-store.ts';
import { runtimePaths } from './session-store.ts';
import type { SessionInspection } from './verification.ts';

export function readSessionReport(
  inspection: SessionInspection,
  reportId: string,
): WorkflowReport {
  const runtime = runtimePaths(
    inspection.git.gitCommonDirectory,
    inspection.contract.config.runtimeDirectory,
  );
  return readImmutableReport(
    runtime.reports,
    inspection.session.sessionId,
    reportId,
  );
}

export function assertInspectionReport(
  report: WorkflowReport,
  inspection: SessionInspection,
  kind: WorkflowReport['kind'],
  errorCode: string,
): void {
  if (
    report.kind !== kind ||
    report.sessionId !== inspection.session.sessionId ||
    report.changeId !== inspection.session.changeId ||
    report.taskId !== inspection.session.taskId ||
    !same(report.baseline, inspection.session.baseline) ||
    report.branch !== inspection.session.branch ||
    !same(report.artifactDigests, inspection.artifactDigests) ||
    !same(report.allowedPaths, inspection.session.allowedPaths) ||
    !same(report.requiredChecks, inspection.session.requiredChecks) ||
    !same(
      report.requiredCheckDigests,
      digestRequiredCheckDefinitions(
        inspection.contract.checks,
        inspection.session.requiredChecks,
      ),
    ) ||
    !same(report.changedPaths, inspection.changedPaths) ||
    report.fingerprint !== inspection.fingerprint
  ) {
    throw staleReport(errorCode);
  }
}

export function assertReportChecks(
  report: WorkflowReport,
  inspection: SessionInspection,
  checkIds: string[],
  errorCode: string,
): void {
  const checks = report.checks;
  if (!Array.isArray(checks) || checks.length !== checkIds.length) {
    throw staleReport(errorCode);
  }
  for (const [index, checkId] of checkIds.entries()) {
    const evidence = checks[index];
    const definition = inspection.contract.checks.checks[checkId];
    if (
      !isRecord(evidence) ||
      evidence.checkId !== checkId ||
      evidence.outcome !== 'passed' ||
      evidence.exitCode !== 0 ||
      typeof evidence.runner !== 'string' ||
      !isDigest(evidence.runnerDigest) ||
      evidence.destructiveDatabase !== definition.destructiveDatabase ||
      (definition.destructiveDatabase
        ? typeof evidence.databaseIdentity !== 'string' ||
          !evidence.databaseIdentity
        : evidence.databaseIdentity !== undefined)
    ) {
      throw staleReport(errorCode);
    }
  }
}

export function assertCompletionTaskIds(
  report: WorkflowReport,
  inspection: SessionInspection,
  errorCode: string,
): string[] {
  const taskIds = reportTaskIds(report, errorCode);
  const baselineTasks = parseTasks(inspection.baselineTasks);
  const currentIndex = baselineTasks.findIndex(
    ({ id }) => id === inspection.session.taskId,
  );
  const earlier = baselineTasks.slice(0, currentIndex);
  const incomplete = earlier.filter(({ completed }) => !completed);
  const allowed = [[inspection.session.taskId]];
  const predecessor = baselineTasks[currentIndex - 1];
  if (
    predecessor &&
    incomplete.length === 1 &&
    incomplete[0].id === predecessor.id
  ) {
    allowed.push([predecessor.id, inspection.session.taskId]);
  }
  if (!allowed.some((candidate) => same(candidate, taskIds))) {
    throw staleReport(errorCode);
  }
  return taskIds;
}

export function reportTaskIds(
  report: WorkflowReport,
  errorCode: string,
): string[] {
  return reportStringArray(report, 'completedTaskIds', errorCode);
}

export function reportStringArray(
  report: WorkflowReport,
  field: string,
  errorCode: string,
): string[] {
  const value = report[field];
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string')
  ) {
    throw staleReport(errorCode);
  }
  return value;
}

export function reportString(
  report: WorkflowReport,
  field: string,
  errorCode: string,
): string {
  const value = report[field];
  if (typeof value !== 'string') {
    throw staleReport(errorCode);
  }
  return value;
}

export function staleReport(code: string) {
  return workflowError(
    code,
    'The workflow report no longer matches the exact repository projection.',
    ExitCode.staleState,
  );
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
