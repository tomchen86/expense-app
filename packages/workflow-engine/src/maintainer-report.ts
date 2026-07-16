import type { CheckEvidence } from './check-runner.ts';
import { writeImmutableReport, type WorkflowReport } from './report-store.ts';

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
