import path from 'node:path';

import { assertCommitObject } from './commit-object-validation.ts';
import { ExitCode, workflowError } from './errors.ts';
import { commitFacts, updateManagedRef } from './git-transitions.ts';
import { type loadActiveSessionContext } from './lifecycle-context.ts';
import { readImmutableReport } from './report-store.ts';
import {
  reportString,
  reportStringArray,
  staleReport,
} from './report-validation.ts';
import {
  releaseOwnedLock,
  type runtimePaths,
  type WorkflowSession,
  writeJsonAtomic,
} from './session-store.ts';

export type CommitSessionResult = {
  session: WorkflowSession;
  reportId: string;
  commitHash: string;
};

export function resumePendingCommit(
  context: ReturnType<typeof loadActiveSessionContext>,
  subject: string,
): CommitSessionResult {
  const session = context.session;
  if (
    !session.commitReportId ||
    !session.commitHash ||
    !session.finishReportId
  ) {
    throw workflowError(
      'PENDING_COMMIT_INVALID',
      'Pending managed commit state is incomplete.',
      ExitCode.staleState,
    );
  }
  const report = readImmutableReport(
    context.runtime.reports,
    session.sessionId,
    session.commitReportId,
  );
  const facts = commitFacts(context.git.repositoryRoot, session.commitHash);
  const changedPaths = reportStringArray(
    report,
    'changedPaths',
    'PENDING_COMMIT_INVALID',
  );
  assertCommitObject(
    context.git.repositoryRoot,
    session,
    subject,
    facts,
    reportString(report, 'tree', 'PENDING_COMMIT_INVALID'),
    changedPaths,
  );
  if (
    report.kind !== 'commit' ||
    report.parentReportId !== session.finishReportId ||
    report.commitHash !== session.commitHash
  ) {
    throw staleReport('PENDING_COMMIT_INVALID');
  }
  if (context.git.head === session.baseline.head) {
    updateManagedRef(
      context.git.repositoryRoot,
      session.baseline.head,
      session.commitHash,
    );
  } else if (context.git.head !== session.commitHash) {
    throw workflowError(
      'PENDING_COMMIT_HEAD_DIVERGED',
      'HEAD does not match the pending managed commit or its baseline.',
      ExitCode.staleState,
    );
  }
  return finalizeCommittedSession(context.runtime, session);
}

export function finalizeCommittedSession(
  runtime: ReturnType<typeof runtimePaths>,
  pending: WorkflowSession,
): CommitSessionResult {
  if (!pending.commitReportId || !pending.commitHash) {
    throw workflowError(
      'PENDING_COMMIT_INVALID',
      'Pending managed commit state is incomplete.',
      ExitCode.staleState,
    );
  }
  const committed: WorkflowSession = {
    ...pending,
    state: 'committed',
    committedAt: new Date().toISOString(),
  };
  writeJsonAtomic(
    path.join(runtime.sessions, `${pending.sessionId}.json`),
    committed,
  );
  releaseOwnedLock(
    path.join(runtime.locks, `${pending.changeId}.lock`),
    pending.sessionId,
  );
  return {
    session: committed,
    reportId: pending.commitReportId,
    commitHash: pending.commitHash,
  };
}
