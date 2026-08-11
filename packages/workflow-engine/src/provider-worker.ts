import path from 'node:path';
import { spawn } from 'node:child_process';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import {
  assertReadOnlyProbe,
  type ExecutionFailureKind,
  type ReadOnlyProbeRequest,
} from './execution-core.ts';
import { readInvestigationSession } from './investigation-session-store.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import {
  PLAN_REVIEW_OUTPUT_SCHEMA,
  PLAN_REVIEW_OUTPUT_VALIDATOR,
  PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA,
} from './plan-review.ts';
import {
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_OUTPUT_VALIDATOR,
  TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA,
} from './task-diff-review-artifact.ts';
import { assertTaskDiffReviewProviderOwnerCurrent } from './task-diff-review-lifecycle.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
  blindSurveyOutputValidator,
  assertProviderInvocationAcceptanceBindingCurrent,
  claimProviderInvocationForWorker,
  claimProviderInvocationForWorkerUnderLifecycleLock,
  completeProviderInvocationFromRunner,
  failProviderInvocation,
  prepareProviderInvocationAcceptanceBinding,
  releaseProviderInvocationWorkerFence,
  readPlanReviewSnapshotRuntime,
  readProviderInvocation,
  readProviderInvocationRequest,
  type ProviderInvocationFailure,
  type ProviderInvocationRecord,
} from './provider-invocation-store.ts';
import {
  isProposeExemptionInvestigationId,
  readProposeExemptionSession,
} from './propose-exemption-store.ts';
import {
  runBuiltInProvider,
  type ProviderRunInput,
  type ProviderRunOptions,
  type ProviderRunnerReport,
} from './provider-runner.ts';
import { extractProviderRepairFailure } from './provider-execution-governance.ts';
import {
  processProviderFailureRetry,
  pumpProviderRetrySchedules,
  type ProviderRetrySchedulePumpOptions,
} from './provider-retry-scheduler.ts';
import { runEvidenceRetentionMaintenance } from './retention-control.ts';
import {
  recordTaskMandateProviderInvocationUnderLifecycleLock,
  withActiveTaskMandateBinding,
} from './task-mandate.ts';
import { recordProviderWorkerMaintenanceWarning } from './provider-worker-maintenance.ts';

export {
  listProviderWorkerMaintenanceWarnings,
  type ProviderWorkerMaintenanceWarning,
} from './provider-worker-maintenance.ts';

export type ProviderWorkerResult = {
  schemaVersion: 1;
  kind: 'provider-worker-result';
  invocationId: string;
  state: 'leased' | 'succeeded' | 'failed';
  revision: number;
  launched: boolean;
  failure: { kind: string; code: string; message: string } | null;
};

export type ProviderWorkerOptions = {
  workerId?: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  runner?: (
    input: ProviderRunInput,
    options: ProviderRunOptions,
  ) => ProviderRunnerReport;
  automaticRetry?: {
    enabled?: boolean;
    now?: string;
    dispatcher?: (cwd: string, invocationId: string) => unknown;
  };
  schedulePump?: Omit<ProviderRetrySchedulePumpOptions, 'limit'> & {
    enabled?: boolean;
    limit?: number;
  };
  retentionNow?: string;
  retentionMaintenance?: typeof runEvidenceRetentionMaintenance;
};

export type ProviderDispatchResult = {
  schemaVersion: 1;
  kind: 'provider-worker-dispatch';
  invocationId: string;
  pid: number;
};

type ProviderDispatcherHost = {
  spawn(
    executable: string,
    args: string[],
    options: {
      cwd: string;
      detached: true;
      stdio: 'ignore';
      env: NodeJS.ProcessEnv;
    },
  ): { pid?: number; unref(): void };
};

/** Production detached dispatch of the hidden lifecycle-owned worker command. */
export function dispatchProviderWorker(
  cwd: string,
  invocationId: string,
): ProviderDispatchResult {
  return createProviderWorkerDispatcher(realDispatcherHost())(
    cwd,
    invocationId,
  );
}

/** The only dispatch injection seam; registered tests never launch a model. */
export function createProviderWorkerDispatcherForTesting(
  host: ProviderDispatcherHost,
): (cwd: string, invocationId: string) => ProviderDispatchResult {
  return createProviderWorkerDispatcher(host);
}

/**
 * Claim and execute one exact durable provider invocation. Replays never
 * manufacture replacement work: an already leased or terminal record is
 * rendered from its durable state, while only `prepared` may acquire a lease.
 */
export function runProviderWorker(
  cwd: string,
  requestedInvocationId: string,
  options: ProviderWorkerOptions = {},
): ProviderWorkerResult {
  const context = loadInvestigationRuntimeContext(cwd);
  const initial = readProviderInvocation(
    context.runtime,
    requestedInvocationId,
  );
  if (initial.state !== 'prepared') {
    if (initial.state === 'succeeded' || initial.state === 'failed') {
      runTerminalFollowups(cwd, initial, options);
    }
    return renderWorkerResult(initial, false);
  }

  const request = readProviderInvocationRequest(
    context.runtime,
    initial.invocationId,
  );
  const taskDiffReviewOwner =
    request.purpose === 'task-diff-review'
      ? assertTaskDiffReviewProviderOwnerCurrent(cwd, initial.invocationId)
      : null;
  const semantic = semanticContract(request);
  const reviewSnapshot = readPlanReviewSnapshotRuntime(
    context.runtime,
    initial.invocationId,
  );
  const claimInput = {
    workerId:
      options.workerId ??
      `provider-worker-${process.pid}-${initial.invocationId}`,
    leaseDurationMs: request.limits.timeoutMs,
    expectedRevision: initial.revision,
  };
  const claim = initial.mandateBinding
    ? withActiveTaskMandateBinding(
        cwd,
        initial.mandateBinding.mandateTaskId,
        {},
        (activeBinding, assertOwned) => {
          const owner =
            taskDiffReviewOwner === null
              ? isProposeExemptionInvestigationId(initial.investigationId)
                ? readProposeExemptionSession(
                    context.runtime,
                    initial.investigationId,
                  )
                : readInvestigationSession(
                    context.runtime,
                    initial.investigationId,
                  )
              : assertTaskDiffReviewProviderOwnerCurrent(
                  cwd,
                  initial.invocationId,
                );
          if (
            owner.changeId !== initial.changeId ||
            canonicalJson(owner.mandateBinding ?? null) !==
              canonicalJson(activeBinding) ||
            canonicalJson(initial.mandateBinding) !==
              canonicalJson(activeBinding)
          ) {
            throw workflowError(
              'TASK_MANDATE_BINDING_STALE',
              'Provider worker invocation no longer matches its durable Task Mandate owner.',
              ExitCode.staleState,
            );
          }
          recordTaskMandateProviderInvocationUnderLifecycleLock(
            cwd,
            activeBinding,
            {
              providerId: request.providerId,
              invocationId: initial.invocationId,
              requestDigest: request.requestDigest,
              occurredAt: initial.createdAt,
            },
            assertOwned,
          );
          return claimProviderInvocationForWorkerUnderLifecycleLock(
            context.runtime,
            initial.invocationId,
            claimInput,
            assertOwned,
          );
        },
      )
    : claimProviderInvocationForWorker(
        context.runtime,
        initial.invocationId,
        claimInput,
      );
  const runner = options.runner ?? runBuiltInProvider;
  let terminal: ProviderInvocationRecord;
  try {
    const acceptanceBinding = prepareProviderInvocationAcceptanceBinding(
      context.runtime,
      request.invocationId,
    );
    const report = runner(
      {
        providerId: request.providerId,
        repositoryRoot: context.git.repositoryRoot,
        invocationDirectory: path.join(
          context.runtime.invocations,
          request.invocationId,
        ),
        request,
        semanticOutputSchema: semantic.schema,
        outputValidator: semantic.validator,
        governedRuntimeInputs:
          reviewSnapshot?.files.map(({ id, path: filePath }) => ({
            id,
            path: filePath,
          })) ?? [],
        acceptanceBinding,
        reviewSnapshotRoot: reviewSnapshot?.root ?? null,
        sourceEnvironment: options.environment ?? process.env,
      },
      { platform: options.platform ?? process.platform },
    );
    assertProviderInvocationAcceptanceBindingCurrent(
      context.runtime,
      acceptanceBinding,
    );
    terminal = completeProviderInvocationFromRunner(
      context.runtime,
      request.invocationId,
      {
        expectedRevision: claim.record.revision,
        leaseGeneration: claim.record.leaseGeneration,
        leaseToken: claim.leaseToken,
        report,
        acceptanceBinding,
      },
    );
  } catch (error) {
    const failure = classifyProviderFailure(error);
    const repair = extractProviderRepairFailure(error, semantic.schema);
    terminal = failProviderInvocation(context.runtime, request.invocationId, {
      expectedRevision: claim.record.revision,
      leaseGeneration: claim.record.leaseGeneration,
      leaseToken: claim.leaseToken,
      failure,
      ...(repair === null ? {} : { repair }),
    });
  } finally {
    releaseProviderInvocationWorkerFence(
      context.runtime,
      request.invocationId,
      claim.workerFenceToken,
    );
  }
  runTerminalFollowups(cwd, terminal, options);
  return renderWorkerResult(terminal, true);
}

function createProviderWorkerDispatcher(host: ProviderDispatcherHost) {
  return (
    cwd: string,
    requestedInvocationId: string,
  ): ProviderDispatchResult => {
    const context = loadInvestigationRuntimeContext(cwd);
    const record = readProviderInvocation(
      context.runtime,
      requestedInvocationId,
    );
    if (record.state !== 'prepared') {
      throw workflowError(
        'PROVIDER_INVOCATION_DISPATCH_CONFLICT',
        'Only the exact prepared provider invocation can be dispatched.',
        ExitCode.conflict,
      );
    }
    const child = host.spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(import.meta.dirname, 'cli.ts'),
        'provider-worker',
        record.invocationId,
        '--json',
      ],
      {
        cwd: context.git.repositoryRoot,
        detached: true,
        stdio: 'ignore',
        env: process.env,
      },
    );
    if (!Number.isSafeInteger(child.pid) || child.pid! < 1) {
      throw workflowError(
        'PROVIDER_WORKER_DISPATCH_FAILED',
        'The lifecycle-owned provider worker could not be dispatched.',
        ExitCode.verification,
      );
    }
    child.unref();
    return {
      schemaVersion: 1,
      kind: 'provider-worker-dispatch',
      invocationId: record.invocationId,
      pid: child.pid!,
    };
  };
}

function realDispatcherHost(): ProviderDispatcherHost {
  return {
    spawn(executable, args, options) {
      return spawn(executable, args, options);
    },
  };
}

function semanticContract(
  request: ReturnType<typeof readProviderInvocationRequest>,
) {
  if (
    request.purpose === 'survey' &&
    request.outputSchema.id === BLIND_SURVEY_OUTPUT_SCHEMA.id &&
    request.outputSchema.version === BLIND_SURVEY_OUTPUT_SCHEMA.version &&
    request.outputSchema.digest === BLIND_SURVEY_OUTPUT_SCHEMA.digest
  ) {
    return {
      schema: BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
      validator: blindSurveyOutputValidator(request),
    };
  }
  if (
    request.purpose === 'plan-review' &&
    request.outputSchema.id === PLAN_REVIEW_OUTPUT_SCHEMA.id &&
    request.outputSchema.version === PLAN_REVIEW_OUTPUT_SCHEMA.version &&
    request.outputSchema.digest === PLAN_REVIEW_OUTPUT_SCHEMA.digest
  ) {
    return {
      schema: PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA,
      validator: PLAN_REVIEW_OUTPUT_VALIDATOR,
    };
  }
  if (
    request.purpose === 'task-diff-review' &&
    request.outputSchema.id === TASK_DIFF_REVIEW_OUTPUT_SCHEMA.id &&
    request.outputSchema.version === TASK_DIFF_REVIEW_OUTPUT_SCHEMA.version &&
    request.outputSchema.digest === TASK_DIFF_REVIEW_OUTPUT_SCHEMA.digest
  ) {
    return {
      schema: TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA,
      validator: TASK_DIFF_REVIEW_OUTPUT_VALIDATOR,
    };
  }
  throw workflowError(
    'PROVIDER_OUTPUT_SCHEMA_UNSUPPORTED',
    'Provider invocation does not reference a code-owned semantic contract.',
    ExitCode.verification,
  );
}

function classifyProviderFailure(error: unknown): ProviderInvocationFailure {
  const code =
    error instanceof WorkflowError
      ? error.code
      : 'PROVIDER_WORKER_UNEXPECTED_FAILURE';
  const staleContext = new Set([
    'PROVIDER_CONTEXT_STALE_OR_WRONG',
    'PROVIDER_ACCEPTANCE_BINDING_STALE',
    'PROVIDER_REPAIR_AUTHORITY_STALE',
    'PROVIDER_INVOCATION_TERMINALLY_RESOLVED',
    'EXECUTION_CONTEXT_CAS_MISMATCH',
    'EXECUTION_CONTEXT_STALE_EPOCH',
    'EXECUTION_CONTEXT_STALE_MANIFEST',
  ]).has(code);
  const probe = providerFailureProbe(error);
  const executionKind = providerExecutionFailureKind(
    code,
    staleContext,
    probe !== null,
  );
  const retryAfterMs = providerRetryAfterMs(error);
  return {
    kind: staleContext
      ? ('repository-reconciliation-required' as const)
      : ('retryable' as const),
    code,
    message: `Provider invocation failed durably (${code}).`,
    ...(executionKind === null ? {} : { executionKind }),
    ...(retryAfterMs === null ? {} : { retryAfterMs }),
    ...(executionKind === 'probe-transient' && probe !== null ? { probe } : {}),
  };
}

function providerExecutionFailureKind(
  code: string,
  staleContext: boolean,
  hasExactProbe: boolean,
): ExecutionFailureKind | null {
  if (staleContext) return 'unknown-side-effect';
  if (code === 'ENVIRONMENT_PROBE_TRANSIENT' && !hasExactProbe) return null;
  const exact = new Map<string, ExecutionFailureKind>([
    ['PROVIDER_TIMEOUT', 'provider-timeout'],
    ['NETWORK_TRANSIENT', 'network'],
    ['PROVIDER_RATE_LIMIT', 'rate-limit'],
    ['PROVIDER_PROCESS_CRASH', 'provider-process-crash'],
    ['PROVIDER_UNAVAILABLE', 'provider-capacity'],
    ['PROVIDER_CAPACITY', 'provider-capacity'],
    ['PROVIDER_OUTPUT_LIMIT_EXCEEDED', 'stdout-truncated'],
    ['PROVIDER_PROCESS_NONZERO', 'process-nonzero'],
    ['PROVIDER_NATIVE_OUTPUT_INVALID', 'schema-mismatch'],
    ['OUTPUT_JSON_PARSE_FAILED', 'json-parse'],
    ['OUTPUT_SCHEMA_MISMATCH', 'schema-mismatch'],
    ['OUTPUT_REQUIRED_FIELD_MISSING', 'missing-required-field'],
    ['OUTPUT_CITATION_OUT_OF_RANGE', 'citation-out-of-range'],
    ['ENVIRONMENT_PROBE_TRANSIENT', 'probe-transient'],
    ['NEEDS_USER_DECISION', 'needs-user-decision'],
    ['STATE_CORRUPTION', 'state-corruption'],
    ['PROVIDER_WORKER_UNEXPECTED_FAILURE', 'worker-crash'],
  ]);
  return exact.get(code) ?? null;
}

function providerFailureProbe(
  error: unknown,
): Readonly<ReadOnlyProbeRequest> | null {
  if (!(error instanceof WorkflowError) || error.details?.probe === undefined) {
    return null;
  }
  try {
    return assertReadOnlyProbe(error.details.probe);
  } catch {
    return null;
  }
}

function providerRetryAfterMs(error: unknown): number | null {
  const value =
    error instanceof WorkflowError ? error.details?.retryAfterMs : null;
  return Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 86_400_000
    ? (value as number)
    : null;
}

function runTerminalFollowups(
  cwd: string,
  terminal: ProviderInvocationRecord,
  options: ProviderWorkerOptions,
): void {
  const retryEnabled =
    terminal.state === 'failed' &&
    (options.automaticRetry?.enabled ?? options.runner === undefined);
  if (retryEnabled) {
    try {
      processProviderFailureRetry(cwd, terminal.invocationId, {
        ...(options.automaticRetry?.now === undefined
          ? {}
          : { now: options.automaticRetry.now }),
        dispatcher:
          options.automaticRetry?.dispatcher ?? dispatchProviderWorker,
      });
    } catch (error) {
      recordTerminalWarning(cwd, terminal, 'automatic-retry', error);
    }
  }
  const pumpEnabled =
    options.schedulePump?.enabled ?? options.runner === undefined;
  if (pumpEnabled) {
    try {
      pumpProviderRetrySchedules(cwd, {
        limit: options.schedulePump?.limit ?? 10,
        ...(options.schedulePump?.now === undefined
          ? {}
          : { now: options.schedulePump.now }),
        dispatcher: options.schedulePump?.dispatcher ?? dispatchProviderWorker,
        ...(options.schedulePump?.probeExecutor === undefined
          ? {}
          : { probeExecutor: options.schedulePump.probeExecutor }),
        ...(options.schedulePump?.faultInjector === undefined
          ? {}
          : { faultInjector: options.schedulePump.faultInjector }),
      });
    } catch (error) {
      recordTerminalWarning(cwd, terminal, 'retry-schedule-pump', error);
    }
  }
  try {
    const maintain =
      options.retentionMaintenance ?? runEvidenceRetentionMaintenance;
    maintain(cwd, {
      limit: 10,
      ...(options.retentionNow === undefined
        ? {}
        : { now: options.retentionNow }),
    });
  } catch (error) {
    recordTerminalWarning(cwd, terminal, 'retention-maintenance', error);
  }
}

function recordTerminalWarning(
  cwd: string,
  terminal: ProviderInvocationRecord,
  operation:
    'automatic-retry' | 'retry-schedule-pump' | 'retention-maintenance',
  error: unknown,
): void {
  try {
    recordProviderWorkerMaintenanceWarning(cwd, terminal, operation, error);
  } catch (warningError) {
    process.emitWarning(
      `Provider worker ${operation} failed after durable ${terminal.state}; its warning journal also failed (${warningError instanceof WorkflowError ? warningError.code : 'PROVIDER_WORKER_MAINTENANCE_WARNING_UNSAFE'}).`,
      {
        code: 'PROVIDER_WORKER_MAINTENANCE_WARNING_UNSAFE',
        type: 'ProviderWorkerMaintenanceWarning',
      },
    );
  }
}

function renderWorkerResult(
  record: ReturnType<typeof readProviderInvocation>,
  launched: boolean,
): ProviderWorkerResult {
  return {
    schemaVersion: 1,
    kind: 'provider-worker-result',
    invocationId: record.invocationId,
    state: record.state === 'prepared' ? 'leased' : record.state,
    revision: record.revision,
    launched,
    failure: record.failure,
  };
}
