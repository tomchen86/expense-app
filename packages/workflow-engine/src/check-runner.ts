import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import type { CheckDefinition } from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { normalizeChangedPath } from './paths.ts';
import {
  resolveCheckRunner,
  type ResolvedCheckRunner,
} from './runner-resolution.ts';

export type CheckEvidence = {
  checkId: string;
  outcome: 'passed';
  exitCode: 0;
  runner: string;
  runnerDigest: string;
  destructiveDatabase: boolean;
  databaseIdentity?: string;
  completedAt?: string;
  externalSnapshotDigest?: string;
  maxAgeMs?: number;
};

export type CheckEvidenceMetadata = {
  completedAt: () => Date;
  externalSnapshotDigest?: string;
  maxAgeMs?: number;
};

export type PinnedCheckRunner = Readonly<ResolvedCheckRunner>;

export type ExpectedRedCheckResult = Readonly<{
  checkId: string;
  exitCode: number;
  runner: string;
  runnerDigest: string;
  failureCategory:
    | 'assertion'
    | 'behavior-mismatch'
    | 'syntax'
    | 'missing-dependency'
    | 'unsafe-database'
    | 'unrelated';
  selector: string;
  testPaths: readonly string[];
  stdoutDigest: string;
  stderrDigest: string;
  failureFingerprint: string;
}>;

const RED_RESULT_PREFIX = 'WORKFLOW_RED_CHECK_RESULT ';

export function pinCheckRunner(
  repositoryRoot: string,
  checkId: string,
  definition: CheckDefinition,
): PinnedCheckRunner {
  return resolveCheckRunner(repositoryRoot, checkId, definition);
}

export function runCheck(
  repositoryRoot: string,
  checkId: string,
  definition: CheckDefinition,
  pinnedRunner: PinnedCheckRunner,
  environment: NodeJS.ProcessEnv,
  databaseIdentity?: string,
  evidenceMetadata?: CheckEvidenceMetadata,
): CheckEvidence {
  const resolved = resolveCheckRunner(repositoryRoot, checkId, definition);
  assertRunnerUnchanged(checkId, pinnedRunner, resolved);
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(resolved.executable, resolved.args, {
      cwd: repositoryRoot,
      shell: false,
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    throw executionFailure(checkId, error);
  }

  if (result.error) {
    throw executionFailure(checkId, result.error);
  }

  if (result.status !== 0) {
    throw workflowError(
      result.signal ? 'CHECK_TERMINATED' : 'CHECK_FAILED',
      result.signal
        ? `Required check ${checkId} was terminated by a signal.`
        : `Required check ${checkId} exited non-zero.`,
      ExitCode.verification,
      {
        details: {
          checkId,
          exitCode: result.status,
          signal: result.signal,
        },
      },
    );
  }

  const resolvedAfter = resolveCheckRunner(repositoryRoot, checkId, definition);
  assertRunnerUnchanged(checkId, pinnedRunner, resolvedAfter);
  const completedAt = evidenceMetadata?.completedAt();
  if (
    evidenceMetadata &&
    (!(completedAt instanceof Date) ||
      !Number.isFinite(completedAt.getTime()) ||
      (evidenceMetadata.externalSnapshotDigest !== undefined &&
        !/^[0-9a-f]{64}$/.test(evidenceMetadata.externalSnapshotDigest)) ||
      (evidenceMetadata.maxAgeMs !== undefined &&
        (!Number.isSafeInteger(evidenceMetadata.maxAgeMs) ||
          evidenceMetadata.maxAgeMs < 1)) ||
      (evidenceMetadata.externalSnapshotDigest === undefined) !==
        (evidenceMetadata.maxAgeMs === undefined))
  ) {
    throw workflowError(
      'CHECK_EVIDENCE_METADATA_INVALID',
      `Required check ${checkId} has invalid evidence metadata.`,
      ExitCode.staleState,
      { details: { checkId } },
    );
  }

  return {
    checkId,
    outcome: 'passed',
    exitCode: 0,
    runner: resolved.runner,
    runnerDigest: resolved.digest,
    destructiveDatabase: definition.destructiveDatabase,
    ...(definition.destructiveDatabase && databaseIdentity
      ? { databaseIdentity }
      : {}),
    ...(evidenceMetadata ? { completedAt: completedAt!.toISOString() } : {}),
    ...(evidenceMetadata?.externalSnapshotDigest
      ? {
          externalSnapshotDigest: evidenceMetadata.externalSnapshotDigest,
          maxAgeMs: evidenceMetadata.maxAgeMs!,
        }
      : {}),
  };
}

/**
 * Execute one baseline-pinned RED runner and admit only its structured failure
 * observation. This never treats a provider or test author claim as evidence:
 * the registered runner must emit the envelope during this engine-owned child
 * process, and the engine binds its exact output bytes into the fingerprint.
 */
export function runExpectedRedCheck(
  repositoryRoot: string,
  checkId: string,
  definition: CheckDefinition,
  pinnedRunner: PinnedCheckRunner,
  environment: NodeJS.ProcessEnv,
): ExpectedRedCheckResult {
  const resolved = resolveCheckRunner(repositoryRoot, checkId, definition);
  assertRunnerUnchanged(checkId, pinnedRunner, resolved);
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(resolved.executable, resolved.args, {
      cwd: repositoryRoot,
      shell: false,
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw executionFailure(checkId, error);
  }
  if (result.error) throw executionFailure(checkId, result.error);
  if (result.signal !== null || result.status === null) {
    throw workflowError(
      'EXPECTED_RED_CHECK_TERMINATED',
      `RED check ${checkId} did not produce an ordinary bounded failure.`,
      ExitCode.verification,
      { details: { checkId, signal: result.signal } },
    );
  }
  if (result.status === 0) {
    throw workflowError(
      'EXPECTED_RED_CHECK_PASSED',
      `RED check ${checkId} passed before implementation.`,
      ExitCode.verification,
      { details: { checkId } },
    );
  }
  const stdout =
    typeof result.stdout === 'string'
      ? result.stdout
      : (result.stdout?.toString('utf8') ?? '');
  const stderr =
    typeof result.stderr === 'string'
      ? result.stderr
      : (result.stderr?.toString('utf8') ?? '');
  const envelope = parseExpectedRedEnvelope(stdout);
  const stdoutDigest = sha256(stdout);
  const stderrDigest = sha256(stderr);
  const evidence = {
    checkId,
    exitCode: result.status,
    runner: resolved.runner,
    runnerDigest: resolved.digest,
    failureCategory: envelope.failureCategory,
    selector: envelope.selector,
    testPaths: envelope.testPaths,
    stdoutDigest,
    stderrDigest,
  };
  const resolvedAfter = resolveCheckRunner(repositoryRoot, checkId, definition);
  assertRunnerUnchanged(checkId, pinnedRunner, resolvedAfter);
  return Object.freeze({
    ...evidence,
    failureFingerprint: sha256(canonicalJson(evidence)),
  });
}

function parseExpectedRedEnvelope(stdout: string): Readonly<{
  failureCategory: ExpectedRedCheckResult['failureCategory'];
  selector: string;
  testPaths: readonly string[];
}> {
  const records = stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(RED_RESULT_PREFIX));
  if (records.length !== 1) throw redEnvelopeInvalid();
  let value: unknown;
  try {
    value = JSON.parse(records[0]!.slice(RED_RESULT_PREFIX.length));
  } catch {
    throw redEnvelopeInvalid();
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(
        [
          'failureCategory',
          'kind',
          'outcome',
          'schemaVersion',
          'selector',
          'testPaths',
        ].sort(),
      )
  ) {
    throw redEnvelopeInvalid();
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.kind !== 'workflow-red-check-result.v1' ||
    candidate.outcome !== 'expected-red' ||
    ![
      'assertion',
      'behavior-mismatch',
      'syntax',
      'missing-dependency',
      'unsafe-database',
      'unrelated',
    ].includes(String(candidate.failureCategory)) ||
    typeof candidate.selector !== 'string' ||
    candidate.selector.trim() !== candidate.selector ||
    Buffer.byteLength(candidate.selector, 'utf8') < 1 ||
    Buffer.byteLength(candidate.selector, 'utf8') > 1024 ||
    !Array.isArray(candidate.testPaths) ||
    candidate.testPaths.length === 0 ||
    candidate.testPaths.length > 512 ||
    candidate.testPaths.some((entry) => typeof entry !== 'string')
  ) {
    throw redEnvelopeInvalid();
  }
  let testPaths: string[];
  try {
    testPaths = (candidate.testPaths as string[])
      .map(normalizeChangedPath)
      .sort();
  } catch {
    throw redEnvelopeInvalid();
  }
  if (
    new Set(testPaths).size !== testPaths.length ||
    canonicalJson(testPaths) !== canonicalJson(candidate.testPaths)
  ) {
    throw redEnvelopeInvalid();
  }
  return Object.freeze({
    failureCategory:
      candidate.failureCategory as ExpectedRedCheckResult['failureCategory'],
    selector: candidate.selector,
    testPaths: Object.freeze(testPaths),
  });
}

function redEnvelopeInvalid() {
  return workflowError(
    'EXPECTED_RED_CHECK_RESULT_INVALID',
    'The RED runner did not emit one exact structured failure result.',
    ExitCode.verification,
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertRunnerUnchanged(
  checkId: string,
  expected: PinnedCheckRunner,
  actual: ResolvedCheckRunner,
): void {
  if (
    actual.runner !== expected.runner ||
    actual.executable !== expected.executable ||
    actual.digest !== expected.digest ||
    JSON.stringify(actual.args) !== JSON.stringify(expected.args)
  ) {
    throw workflowError(
      'CHECK_RUNNER_CHANGED',
      `Required check ${checkId} changed its resolved runner during verification.`,
      ExitCode.staleState,
      { details: { checkId } },
    );
  }
}

function executionFailure(checkId: string, error: unknown) {
  return workflowError(
    'CHECK_EXECUTION_FAILED',
    `Required check ${checkId} could not be executed.`,
    ExitCode.verification,
    {
      details: {
        checkId,
        errorCode:
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          typeof error.code === 'string'
            ? error.code
            : 'UNKNOWN',
      },
    },
  );
}
