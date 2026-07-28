import path from 'node:path';
import { spawn } from 'node:child_process';

import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import {
  PLAN_REVIEW_OUTPUT_SCHEMA,
  PLAN_REVIEW_OUTPUT_VALIDATOR,
  PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA,
} from './plan-review.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
  blindSurveyOutputValidator,
  claimProviderInvocation,
  completeProviderInvocationFromRunner,
  failProviderInvocation,
  readPlanReviewSnapshotRuntime,
  readProviderInvocation,
  readProviderInvocationRequest,
} from './provider-invocation-store.ts';
import {
  runBuiltInProvider,
  type ProviderRunInput,
  type ProviderRunOptions,
  type ProviderRunnerReport,
} from './provider-runner.ts';

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
    return renderWorkerResult(initial, false);
  }

  const request = readProviderInvocationRequest(
    context.runtime,
    initial.invocationId,
  );
  const semantic = semanticContract(request);
  const reviewSnapshot = readPlanReviewSnapshotRuntime(
    context.runtime,
    initial.invocationId,
  );
  const claim = claimProviderInvocation(context.runtime, initial.invocationId, {
    workerId:
      options.workerId ??
      `provider-worker-${process.pid}-${initial.invocationId}`,
    leaseDurationMs: request.limits.timeoutMs,
    expectedRevision: initial.revision,
  });
  const runner = options.runner ?? runBuiltInProvider;
  try {
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
        reviewSnapshotRoot: reviewSnapshot?.root ?? null,
        sourceEnvironment: options.environment ?? process.env,
      },
      { platform: options.platform ?? process.platform },
    );
    const completed = completeProviderInvocationFromRunner(
      context.runtime,
      request.invocationId,
      {
        expectedRevision: claim.record.revision,
        leaseGeneration: claim.record.leaseGeneration,
        leaseToken: claim.leaseToken,
        report,
      },
    );
    return renderWorkerResult(completed, true);
  } catch (error) {
    const failure = classifyProviderFailure(error);
    const failed = failProviderInvocation(
      context.runtime,
      request.invocationId,
      {
        expectedRevision: claim.record.revision,
        leaseGeneration: claim.record.leaseGeneration,
        leaseToken: claim.leaseToken,
        failure,
      },
    );
    return renderWorkerResult(failed, true);
  }
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
  throw workflowError(
    'PROVIDER_OUTPUT_SCHEMA_UNSUPPORTED',
    'Provider invocation does not reference a code-owned semantic contract.',
    ExitCode.verification,
  );
}

function classifyProviderFailure(error: unknown) {
  const code =
    error instanceof WorkflowError
      ? error.code
      : 'PROVIDER_WORKER_UNEXPECTED_FAILURE';
  return {
    kind: 'retryable' as const,
    code,
    message: `Provider invocation failed durably (${code}).`,
  };
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
