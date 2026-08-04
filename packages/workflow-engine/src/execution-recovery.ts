import path from 'node:path';

import { projectProviderInvocationExecution } from './execution-core.ts';
import {
  listExecutionJobStates,
  materializeLegacyProviderExecutionJob,
  readExecutionJobState,
  reconcileLegacyProviderExecutionJob,
  type DurableExecutionReconciliation,
  type LegacyProviderExecutionEntry,
} from './execution-store.ts';
import { listProviderInvocationLifecycleProjections } from './investigation-session-store.ts';
import {
  assertInvestigationId,
  assertInvocationId,
  type InvestigationRuntimePaths,
} from './paths.ts';
import {
  providerCompletionCandidateExists,
  readProviderInvocation,
  readProviderInvocationRequest,
  recoverProviderInvocationCompletionUnderLifecycleLock,
} from './provider-invocation-store.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperation,
} from './session-store.ts';

export type ExecutionMaterializationReport = Readonly<{
  schemaVersion: 1;
  scope:
    | { kind: 'repository'; investigationId: null }
    | { kind: 'investigation'; investigationId: string };
  jobs: Array<{
    jobId: string;
    investigationId: string;
    invocationIds: string[];
    priorRevision: number | null;
    resultingRevision: number;
    changed: boolean;
  }>;
}>;

export function materializeAllLegacyExecution(
  paths: InvestigationRuntimePaths,
): ExecutionMaterializationReport {
  return materializeLegacyExecution(paths, null);
}

export function materializeLegacyExecutionInvestigation(
  paths: InvestigationRuntimePaths,
  requestedInvestigationId: string,
): ExecutionMaterializationReport {
  return materializeLegacyExecution(
    paths,
    assertInvestigationId(requestedInvestigationId),
  );
}

export function reconcileLegacyProviderInvocation(
  paths: InvestigationRuntimePaths,
  input: {
    invocationId: string;
    expectedExecutionRevision: number;
    expectedLegacyRevision: number;
  },
): DurableExecutionReconciliation {
  const invocationId = assertInvocationId(input.invocationId);
  return withExecutionRecoveryLifecycle(paths, (assertOwned) => {
    let target = readProviderInvocation(paths, invocationId);
    const request = readProviderInvocationRequest(paths, invocationId);
    const targetProjection = projectProviderInvocationExecution({
      record: target,
      request,
    });
    const targetJobId = targetProjection.job.jobId;
    const durable = readExecutionJobState(paths, targetJobId);
    const durableResult = durable?.results.find(
      ({ attemptId }) => attemptId === targetProjection.attempt.attemptId,
    );
    let effectiveLegacyRevision = input.expectedLegacyRevision;
    if (
      durableResult !== undefined &&
      (target.state !== 'succeeded' ||
        providerCompletionCandidateExists(paths, invocationId))
    ) {
      const recovery = recoverProviderInvocationCompletionUnderLifecycleLock(
        paths,
        invocationId,
        {
          expectedLegacyRevision: input.expectedLegacyRevision,
          acceptedOutputDigest: durableResult.outputDigest.replace(
            /^sha256:/u,
            '',
          ),
        },
        assertOwned,
      );
      target = recovery.record;
      effectiveLegacyRevision = target.revision;
    }
    const entries = scanLegacyExecutionEntries(paths).filter(
      (entry) =>
        projectProviderInvocationExecution(entry).job.jobId === targetJobId,
    );
    assertOwned();
    const reconciled = reconcileLegacyProviderExecutionJob(paths, {
      entries,
      triggerInvocationId: invocationId,
      expectedExecutionRevision: input.expectedExecutionRevision,
      expectedLegacyRevision: effectiveLegacyRevision,
    });
    assertOwned();
    return reconciled;
  });
}

function materializeLegacyExecution(
  paths: InvestigationRuntimePaths,
  investigationId: string | null,
): ExecutionMaterializationReport {
  return withExecutionRecoveryLifecycle(paths, (assertOwned) => {
    const groups = groupLegacyExecutionEntries(
      scanLegacyExecutionEntries(paths).filter(
        ({ record }) =>
          investigationId === null ||
          record.investigationId === investigationId,
      ),
    );
    const jobs: ExecutionMaterializationReport['jobs'] = [];
    for (const [jobId, entries] of groups) {
      assertOwned();
      const before = readExecutionJobState(paths, jobId);
      const state = materializeLegacyProviderExecutionJob(paths, entries, {
        expectedRevision: before?.revision ?? null,
      });
      jobs.push({
        jobId,
        investigationId: state.workflow.workflowId,
        invocationIds: entries.map(({ record }) => record.invocationId).sort(),
        priorRevision: before?.revision ?? null,
        resultingRevision: state.revision,
        changed: before === null || before.revision !== state.revision,
      });
    }
    assertOwned();
    // A safe store-only scan verifies filename bindings, exact canonical
    // schemas, and private directory/file shape before reporting completion.
    listExecutionJobStates(paths);
    return deepFreeze({
      schemaVersion: 1,
      scope:
        investigationId === null
          ? { kind: 'repository' as const, investigationId: null }
          : { kind: 'investigation' as const, investigationId },
      jobs,
    });
  });
}

function scanLegacyExecutionEntries(
  paths: InvestigationRuntimePaths,
): LegacyProviderExecutionEntry[] {
  return listProviderInvocationLifecycleProjections(paths)
    .map(({ invocationId }) => ({
      record: readProviderInvocation(paths, invocationId),
      request: readProviderInvocationRequest(paths, invocationId),
    }))
    .sort(
      (left, right) =>
        left.record.investigationId.localeCompare(
          right.record.investigationId,
        ) ||
        left.record.purpose.localeCompare(right.record.purpose) ||
        left.record.attempt - right.record.attempt ||
        left.record.invocationId.localeCompare(right.record.invocationId),
    );
}

function groupLegacyExecutionEntries(
  entries: LegacyProviderExecutionEntry[],
): Array<[string, LegacyProviderExecutionEntry[]]> {
  const groups = new Map<string, LegacyProviderExecutionEntry[]>();
  for (const entry of entries) {
    const jobId = projectProviderInvocationExecution(entry).job.jobId;
    const group = groups.get(jobId) ?? [];
    group.push(entry);
    groups.set(jobId, group);
  }
  return [...groups.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function withExecutionRecoveryLifecycle<T>(
  paths: InvestigationRuntimePaths,
  operation: (assertOwned: () => void) => T,
): T {
  const runtimeRoot = path.dirname(paths.root);
  return withRepositoryLifecycleOperation(
    runtimePaths(path.dirname(runtimeRoot), path.basename(runtimeRoot)),
    operation,
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
