import path from 'node:path';

import { loadWorkflowConfig } from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { listStagedPaths } from './git-transitions.ts';
import { discoverRepository, runGit } from './git.ts';
import { assertSessionId } from './paths.ts';
import type { WorkflowReport } from './report-store.ts';
import {
  reportString,
  reportStringArray,
  staleReport,
} from './report-validation.ts';
import {
  readSessionFile,
  runtimePaths,
  withSessionOperation,
} from './session-store.ts';
import type { SessionInspection } from './verification.ts';

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
