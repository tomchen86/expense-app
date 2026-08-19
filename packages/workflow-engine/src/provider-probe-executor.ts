import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

import { loadAiAdapterPolicy } from './ai-adapter-policy.ts';
import { canonicalJson } from './foundation/canonical-json/canonical-json.ts';
import {
  assertReadOnlyProbe,
  type ReadOnlyProbeRequest,
} from './modules/provider-orchestration/execution-core.ts';
import { readExecutionJobState } from './execution-store.ts';
import { WorkflowError } from './foundation/errors/errors.ts';
import { runGitBuffer } from './git.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import {
  readProviderInvocation,
  readProviderInvocationRequest,
} from './provider-invocation-store.ts';

const MAX_FILE_PROBE_BYTES = 64 * 1024;

export type ProviderReadOnlyProbeContext = Readonly<{
  executionJobId: string;
  failedAttemptId: string;
  failedInvocationId: string;
  failureCode: string;
}>;

export type ProviderReadOnlyProbeExecutionResult = Readonly<{
  state: 'succeeded' | 'failed';
  code: string;
  observationDigest: string;
  elapsedMs: number;
}>;

/**
 * Execute one code-owned read-only probe. No probe kind launches a provider,
 * writes repository or runtime state, or accepts a command/argument vector.
 * Results retain only a digest of the bounded observation.
 */
export function executeProviderReadOnlyProbe(
  cwd: string,
  requestInput: Readonly<ReadOnlyProbeRequest>,
  probeContext: ProviderReadOnlyProbeContext,
): ProviderReadOnlyProbeExecutionResult {
  const request = assertReadOnlyProbe(requestInput);
  const started = performance.now();
  try {
    const observation = observeProviderEnvironment(cwd, request, probeContext);
    const elapsedMs = elapsedSince(started);
    if (elapsedMs > request.timeoutMs) {
      return probeResult(
        'failed',
        'PROVIDER_PROBE_TIMEOUT',
        { kind: request.kind, timeoutMs: request.timeoutMs },
        elapsedMs,
      );
    }
    return probeResult(
      'succeeded',
      'PROVIDER_PROBE_SUCCEEDED',
      observation,
      elapsedMs,
    );
  } catch (error) {
    const elapsedMs = elapsedSince(started);
    return probeResult(
      'failed',
      elapsedMs > request.timeoutMs
        ? 'PROVIDER_PROBE_TIMEOUT'
        : error instanceof WorkflowError
          ? error.code
          : 'PROVIDER_PROBE_EXECUTION_FAILED',
      {
        kind: request.kind,
        errorCode:
          error instanceof WorkflowError
            ? error.code
            : 'PROVIDER_PROBE_EXECUTION_FAILED',
      },
      elapsedMs,
    );
  }
}

function observeProviderEnvironment(
  cwd: string,
  request: Readonly<ReadOnlyProbeRequest>,
  probeContext: ProviderReadOnlyProbeContext,
): unknown {
  const context = loadInvestigationRuntimeContext(cwd);
  switch (request.kind) {
    case 'repository-head':
      return {
        kind: request.kind,
        head: runGitBuffer(context.git.repositoryRoot, ['rev-parse', 'HEAD'], {
          timeoutMs: request.timeoutMs,
        })
          .toString('utf8')
          .trim(),
      };
    case 'repository-dirty-state':
      return {
        kind: request.kind,
        statusDigest: digestBytes(
          runGitBuffer(
            context.git.repositoryRoot,
            ['status', '--porcelain=v2', '-z', '--untracked-files=all'],
            { timeoutMs: request.timeoutMs },
          ),
        ),
      };
    case 'runtime-version':
      return {
        kind: request.kind,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
      };
    case 'adapter-version': {
      const invocation = readProviderInvocation(
        context.runtime,
        probeContext.failedInvocationId,
      );
      const providerRequest = readProviderInvocationRequest(
        context.runtime,
        invocation.invocationId,
      );
      const policy = loadAiAdapterPolicy(context.git.repositoryRoot);
      return {
        kind: request.kind,
        providerId: providerRequest.providerId,
        evaluatorVersion: providerRequest.evaluatorVersion,
        policyDigest: policy.digest,
      };
    }
    case 'binary-exists':
      return {
        kind: request.kind,
        target: request.target,
        available: findTrustedBinary(request.target!) !== null,
      };
    case 'file-read':
      return observeRepositoryFile(context.git.repositoryRoot, request.target!);
    case 'validator-error':
      return {
        kind: request.kind,
        target: request.target,
        present: probeContext.failureCode === request.target,
      };
    case 'execution-limits': {
      const policy = loadAiAdapterPolicy(context.git.repositoryRoot);
      return {
        kind: request.kind,
        policyDigest: policy.digest,
        limits: policy.policy.limits,
        retryAccounting: policy.policy.retryAccounting,
      };
    }
    case 'lease-state': {
      const invocation = readProviderInvocation(
        context.runtime,
        probeContext.failedInvocationId,
      );
      return {
        kind: request.kind,
        invocationId: invocation.invocationId,
        state: invocation.state,
        leaseGeneration: invocation.leaseGeneration,
        leasePresent: invocation.lease !== null,
      };
    }
    case 'attempt-lineage': {
      const state = readExecutionJobState(
        context.runtime,
        probeContext.executionJobId,
      );
      const attempt = state?.attempts.find(
        ({ attemptId }) => attemptId === probeContext.failedAttemptId,
      );
      return {
        kind: request.kind,
        jobPresent: state !== null,
        workflowId: state?.workflow.workflowId ?? null,
        epoch: state?.job.epoch ?? null,
        attemptId: attempt?.attemptId ?? null,
        retryOf: attempt?.retryOf ?? null,
      };
    }
    case 'dependency-availability':
      return {
        kind: request.kind,
        target: request.target,
        available: resolveDependency(
          context.git.repositoryRoot,
          request.target!,
        ),
      };
  }
}

function observeRepositoryFile(repositoryRoot: string, relative: string) {
  const root = fs.realpathSync(repositoryRoot);
  const absolute = path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!absolute.startsWith(prefix)) {
    throw new Error('Probe target escaped the repository root.');
  }
  const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (stats === undefined) {
    return { kind: 'file-read', target: relative, exists: false };
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('Probe target is not a plain repository file.');
  }
  const real = fs.realpathSync(absolute);
  if (real !== absolute || !real.startsWith(prefix)) {
    throw new Error('Probe target traversed a symbolic link.');
  }
  const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
  const descriptor = fs.openSync(real, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino
    ) {
      throw new Error('Probe target changed during observation.');
    }
    const bytes = Math.min(opened.size, MAX_FILE_PROBE_BYTES);
    const buffer = Buffer.alloc(bytes);
    const read = bytes === 0 ? 0 : fs.readSync(descriptor, buffer, 0, bytes, 0);
    return {
      kind: 'file-read',
      target: relative,
      exists: true,
      size: opened.size,
      prefixDigest: digestBytes(buffer.subarray(0, read)),
      truncated: opened.size > read,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function findTrustedBinary(target: string): string | null {
  const directories = [
    path.dirname(fs.realpathSync(process.execPath)),
    ...(process.platform === 'win32'
      ? ['C:\\Windows\\System32', 'C:\\Windows']
      : ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin']),
  ];
  for (const directory of new Set(directories)) {
    const candidate = path.join(directory, target);
    const stats = fs.statSync(candidate, { throwIfNoEntry: false });
    if (
      stats?.isFile() &&
      (process.platform === 'win32' || (stats.mode & 0o111) !== 0)
    ) {
      return candidate;
    }
  }
  return null;
}

function resolveDependency(repositoryRoot: string, target: string): boolean {
  try {
    const require = createRequire(path.join(repositoryRoot, 'package.json'));
    require.resolve(target);
    return true;
  } catch {
    return false;
  }
}

function probeResult(
  state: ProviderReadOnlyProbeExecutionResult['state'],
  code: string,
  observation: unknown,
  elapsedMs: number,
): ProviderReadOnlyProbeExecutionResult {
  return Object.freeze({
    state,
    code,
    observationDigest: digestCanonical(observation),
    elapsedMs,
  });
}

function elapsedSince(started: number): number {
  return Math.max(0, Math.ceil(performance.now() - started));
}

function digestCanonical(value: unknown): string {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}

function digestBytes(value: Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
