import type { CheckEvidence } from './check-runner.ts';
import { ExitCode, workflowError } from './errors.ts';
import type { AuthoritySession } from './maintainer-session.ts';
import {
  readImmutableReport,
  writeImmutableReport,
  type WorkflowReport,
} from './report-store.ts';

export function writeAuthorityCheckReport(
  reportsRoot: string,
  input: {
    sessionId: string;
    changeId: string;
    grantId: string;
    baseCommit: string;
    policyBlob: string;
    contractDigest: string;
    allowedPaths: string[];
    changedPaths: string[];
    requiredChecks: string[];
    checks: CheckEvidence[];
    fingerprint: string;
    createdAt: string;
  },
): string {
  const report: WorkflowReport = {
    schemaVersion: 1,
    kind: 'authority-check',
    sessionId: input.sessionId,
    changeId: input.changeId,
    taskId: 'authority-maintenance',
    createdAt: input.createdAt,
    grantId: input.grantId,
    baseCommit: input.baseCommit,
    policyBlob: input.policyBlob,
    contractDigest: input.contractDigest,
    allowedPaths: input.allowedPaths,
    changedPaths: input.changedPaths,
    requiredChecks: input.requiredChecks,
    checks: input.checks,
    fingerprint: input.fingerprint,
  };
  return writeImmutableReport(reportsRoot, report);
}

export function readCurrentAuthorityCheckReport(
  reportsRoot: string,
  session: AuthoritySession,
  changedPaths: string[],
  fingerprint: string,
): WorkflowReport & {
  kind: 'authority-check';
  checks: CheckEvidence[];
} {
  if (!session.latestCheckReportId) {
    throw staleAuthorityReport('AUTHORITY_CHECK_REPORT_REQUIRED');
  }
  const report = readImmutableReport(
    reportsRoot,
    session.sessionId,
    session.latestCheckReportId,
  );
  const checks = Array.isArray(report.checks)
    ? (report.checks as unknown[])
    : [];
  const checksAreExact =
    checks.length === session.requiredChecks.length &&
    checks.every((value, index) => {
      const expected = session.pinnedChecks[index];
      if (!isRecord(value) || !expected) return false;
      return (
        value.checkId === session.requiredChecks[index] &&
        value.outcome === 'passed' &&
        value.exitCode === 0 &&
        value.runner === expected.runner.runner &&
        value.runnerDigest === expected.runner.digest &&
        value.destructiveDatabase === expected.definition.destructiveDatabase
      );
    });
  if (
    report.kind !== 'authority-check' ||
    report.sessionId !== session.sessionId ||
    report.changeId !== session.changeId ||
    report.taskId !== 'authority-maintenance' ||
    report.grantId !== session.grantId ||
    report.baseCommit !== session.baseCommit ||
    report.policyBlob !== session.policyBlob ||
    report.contractDigest !== session.contractDigest ||
    JSON.stringify(report.allowedPaths) !==
      JSON.stringify(session.allowedPaths) ||
    JSON.stringify(report.changedPaths) !== JSON.stringify(changedPaths) ||
    JSON.stringify(report.requiredChecks) !==
      JSON.stringify(session.requiredChecks) ||
    report.fingerprint !== fingerprint ||
    !checksAreExact
  ) {
    throw staleAuthorityReport('AUTHORITY_CHECK_REPORT_STALE');
  }
  return report as WorkflowReport & {
    kind: 'authority-check';
    checks: CheckEvidence[];
  };
}

function staleAuthorityReport(code: string) {
  return workflowError(
    code,
    'A current passing authority-check report is required before commit.',
    ExitCode.verification,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
