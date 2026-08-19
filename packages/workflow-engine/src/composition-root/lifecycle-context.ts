import path from 'node:path';

import { loadWorkflowConfig } from '../adapters/consumer/expense-app/work-registry/contracts.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import { listStagedPaths } from '../runtime/repository-transaction/git-transitions.ts';
import {
  discoverRepository,
  runGit,
} from '../runtime/repository-transaction/git.ts';
import {
  assertInvestigationId,
  assertSessionId,
  investigationRuntimePaths,
} from '../runtime/session-workspace/paths.ts';
import type { WorkflowReport } from '../runtime/storage-journal/report-store.ts';
import {
  reportString,
  reportStringArray,
  staleReport,
} from '../runtime/storage-journal/report-validation.ts';
import {
  readSessionFile,
  runtimePaths,
  withSessionOperation,
} from '../runtime/session-workspace/session-store.ts';
import type { SessionInspection } from '../application/finalize/verification.ts';

export function loadActiveSessionContext(
  cwd: string,
  requestedSessionId: string,
) {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  const sessionId = assertSessionId(requestedSessionId);
  const session = readSessionFile(
    path.join(runtime.sessions, `${sessionId}.json`),
  );
  if (session.state !== 'active') {
    throw workflowError(
      'SESSION_NOT_ACTIVE',
      `Session ${sessionId} is ${session.state}.`,
      ExitCode.staleState,
    );
  }
  return { git, config, runtime, session };
}

export function loadInvestigationRuntimeContext(cwd: string) {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  return {
    git,
    config,
    runtime: investigationRuntimePaths(
      git.gitCommonDirectory,
      config.runtimeDirectory,
    ),
    lifecycleRuntime: runtimePaths(
      git.gitCommonDirectory,
      config.runtimeDirectory,
    ),
  };
}

export function assertInvestigationSubjectId(value: string): string {
  return assertInvestigationId(value);
}

export function runSessionOperation<T>(
  cwd: string,
  requestedSessionId: string,
  operation: () => T,
): T {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  return withSessionOperation(
    runtime,
    assertSessionId(requestedSessionId),
    operation,
  );
}

export function assertFinishProjection(
  report: WorkflowReport,
  inspection: SessionInspection,
): void {
  const stagedPaths = reportStringArray(
    report,
    'stagedPaths',
    'FINISH_REPORT_STALE',
  );
  const currentStaged = listStagedPaths(
    inspection.git.repositoryRoot,
    inspection.session.baseline.head,
  );
  const tree = runGit(inspection.git.repositoryRoot, ['write-tree']).trim();
  if (
    JSON.stringify(stagedPaths) !== JSON.stringify(currentStaged) ||
    JSON.stringify(stagedPaths) !== JSON.stringify(inspection.changedPaths) ||
    reportString(report, 'tree', 'FINISH_REPORT_STALE') !== tree
  ) {
    throw staleReport('FINISH_REPORT_STALE');
  }
}
