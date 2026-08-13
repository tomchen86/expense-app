import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import { ExitCode, workflowError } from './errors.js';
import { normalizeChangedPath } from './paths.js';
import { resolveCheckRunner, } from './runner-resolution.js';
export const OBSERVED_CHECK_FAILURE_EXCERPT_BYTES = 8 * 1024;
const RED_RESULT_PREFIX = 'WORKFLOW_RED_CHECK_RESULT ';
export function pinCheckRunner(repositoryRoot, checkId, definition) {
    return resolveCheckRunner(repositoryRoot, checkId, definition);
}
export function runCheck(repositoryRoot, checkId, definition, pinnedRunner, environment, databaseIdentity, evidenceMetadata) {
    const outcome = runObservedCheck(repositoryRoot, checkId, definition, pinnedRunner, environment, databaseIdentity, evidenceMetadata);
    if (outcome.outcome === 'failed') {
        throw workflowError('CHECK_FAILED', `Required check ${checkId} exited non-zero.`, ExitCode.verification, {
            details: {
                checkId,
                exitCode: outcome.exitCode,
                signal: null,
            },
        });
    }
    return outcome;
}
/**
 * Execute one engine-owned check while retaining a bounded, authenticated
 * observation for an ordinary non-zero result. Transport failures, signals,
 * and max-buffer failures still throw and can never be mistaken for a
 * semantic GREEN failure.
 */
export function runObservedCheck(repositoryRoot, checkId, definition, pinnedRunner, environment, databaseIdentity, evidenceMetadata) {
    const resolved = resolveCheckRunner(repositoryRoot, checkId, definition);
    assertRunnerUnchanged(checkId, pinnedRunner, resolved);
    let result;
    try {
        result = spawnSync(resolved.executable, resolved.args, {
            cwd: repositoryRoot,
            shell: false,
            env: environment,
            encoding: 'utf8',
            stdio: [
                'ignore',
                'pipe',
                definition.liveStderr === true ? 'inherit' : 'pipe',
            ],
            maxBuffer: 10 * 1024 * 1024,
        });
    }
    catch (error) {
        throw executionFailure(checkId, error);
    }
    if (result.error) {
        throw executionFailure(checkId, result.error);
    }
    if (result.signal !== null || result.status === null) {
        throw workflowError('CHECK_TERMINATED', `Required check ${checkId} was terminated by a signal.`, ExitCode.verification, {
            details: {
                checkId,
                exitCode: result.status,
                signal: result.signal,
            },
        });
    }
    if (result.status !== 0) {
        const stdout = outputText(result.stdout);
        const stderr = definition.liveStderr === true ? '' : outputText(result.stderr);
        const failureBody = {
            checkId,
            outcome: 'failed',
            exitCode: result.status,
            runner: resolved.runner,
            runnerDigest: resolved.digest,
            stdoutDigest: sha256(stdout),
            stderrDigest: sha256(stderr),
            stdoutExcerpt: boundedExcerpt(stdout),
            stderrExcerpt: boundedExcerpt(stderr),
            stdoutTruncated: Buffer.byteLength(stdout, 'utf8') >
                OBSERVED_CHECK_FAILURE_EXCERPT_BYTES,
            stderrTruncated: Buffer.byteLength(stderr, 'utf8') >
                OBSERVED_CHECK_FAILURE_EXCERPT_BYTES,
        };
        const resolvedAfter = resolveCheckRunner(repositoryRoot, checkId, definition);
        assertRunnerUnchanged(checkId, pinnedRunner, resolvedAfter);
        return Object.freeze({
            ...failureBody,
            failureFingerprint: sha256(canonicalJson(failureBody)),
        });
    }
    const resolvedAfter = resolveCheckRunner(repositoryRoot, checkId, definition);
    assertRunnerUnchanged(checkId, pinnedRunner, resolvedAfter);
    const completedAt = evidenceMetadata?.completedAt();
    if (evidenceMetadata &&
        (!(completedAt instanceof Date) ||
            !Number.isFinite(completedAt.getTime()) ||
            (evidenceMetadata.externalSnapshotDigest !== undefined &&
                !/^[0-9a-f]{64}$/.test(evidenceMetadata.externalSnapshotDigest)) ||
            (evidenceMetadata.maxAgeMs !== undefined &&
                (!Number.isSafeInteger(evidenceMetadata.maxAgeMs) ||
                    evidenceMetadata.maxAgeMs < 1)) ||
            (evidenceMetadata.externalSnapshotDigest === undefined) !==
                (evidenceMetadata.maxAgeMs === undefined))) {
        throw workflowError('CHECK_EVIDENCE_METADATA_INVALID', `Required check ${checkId} has invalid evidence metadata.`, ExitCode.staleState, { details: { checkId } });
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
        ...(evidenceMetadata ? { completedAt: completedAt.toISOString() } : {}),
        ...(evidenceMetadata?.externalSnapshotDigest
            ? {
                externalSnapshotDigest: evidenceMetadata.externalSnapshotDigest,
                maxAgeMs: evidenceMetadata.maxAgeMs,
            }
            : {}),
    };
}
export function parseObservedCheckFailure(value) {
    if (!isRecord(value) ||
        JSON.stringify(Object.keys(value).sort()) !==
            JSON.stringify([
                'checkId',
                'outcome',
                'exitCode',
                'runner',
                'runnerDigest',
                'stdoutDigest',
                'stderrDigest',
                'stdoutExcerpt',
                'stderrExcerpt',
                'stdoutTruncated',
                'stderrTruncated',
                'failureFingerprint',
            ].sort()) ||
        typeof value.checkId !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.checkId) ||
        value.outcome !== 'failed' ||
        !Number.isSafeInteger(value.exitCode) ||
        value.exitCode < 1 ||
        value.exitCode > 255 ||
        typeof value.runner !== 'string' ||
        value.runner.trim() !== value.runner ||
        Buffer.byteLength(value.runner, 'utf8') < 1 ||
        Buffer.byteLength(value.runner, 'utf8') > 1024 ||
        !isDigest(value.runnerDigest) ||
        !isDigest(value.stdoutDigest) ||
        !isDigest(value.stderrDigest) ||
        typeof value.stdoutExcerpt !== 'string' ||
        typeof value.stderrExcerpt !== 'string' ||
        Buffer.byteLength(value.stdoutExcerpt, 'utf8') >
            OBSERVED_CHECK_FAILURE_EXCERPT_BYTES ||
        Buffer.byteLength(value.stderrExcerpt, 'utf8') >
            OBSERVED_CHECK_FAILURE_EXCERPT_BYTES ||
        typeof value.stdoutTruncated !== 'boolean' ||
        typeof value.stderrTruncated !== 'boolean' ||
        !isDigest(value.failureFingerprint)) {
        throw observedFailureInvalid();
    }
    const body = {
        checkId: value.checkId,
        outcome: value.outcome,
        exitCode: value.exitCode,
        runner: value.runner,
        runnerDigest: value.runnerDigest,
        stdoutDigest: value.stdoutDigest,
        stderrDigest: value.stderrDigest,
        stdoutExcerpt: value.stdoutExcerpt,
        stderrExcerpt: value.stderrExcerpt,
        stdoutTruncated: value.stdoutTruncated,
        stderrTruncated: value.stderrTruncated,
    };
    if (value.failureFingerprint !== sha256(canonicalJson(body)) ||
        (!value.stdoutTruncated &&
            value.stdoutDigest !== sha256(value.stdoutExcerpt)) ||
        (!value.stderrTruncated &&
            value.stderrDigest !== sha256(value.stderrExcerpt))) {
        throw observedFailureInvalid();
    }
    return Object.freeze({
        ...body,
        failureFingerprint: value.failureFingerprint,
    });
}
/**
 * Execute one baseline-pinned RED runner and admit only its structured failure
 * observation. This never treats a provider or test author claim as evidence:
 * the registered runner must emit the envelope during this engine-owned child
 * process, and the engine binds its exact output bytes into the fingerprint.
 */
export function runExpectedRedCheck(repositoryRoot, checkId, definition, pinnedRunner, environment) {
    const resolved = resolveCheckRunner(repositoryRoot, checkId, definition);
    assertRunnerUnchanged(checkId, pinnedRunner, resolved);
    let result;
    try {
        result = spawnSync(resolved.executable, resolved.args, {
            cwd: repositoryRoot,
            shell: false,
            env: environment,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 1024 * 1024,
        });
    }
    catch (error) {
        throw executionFailure(checkId, error);
    }
    if (result.error)
        throw executionFailure(checkId, result.error);
    if (result.signal !== null || result.status === null) {
        throw workflowError('EXPECTED_RED_CHECK_TERMINATED', `RED check ${checkId} did not produce an ordinary bounded failure.`, ExitCode.verification, { details: { checkId, signal: result.signal } });
    }
    if (result.status === 0) {
        throw workflowError('EXPECTED_RED_CHECK_PASSED', `RED check ${checkId} passed before implementation.`, ExitCode.verification, { details: { checkId } });
    }
    const stdout = typeof result.stdout === 'string'
        ? result.stdout
        : (result.stdout?.toString('utf8') ?? '');
    const stderr = typeof result.stderr === 'string'
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
function parseExpectedRedEnvelope(stdout) {
    const records = stdout
        .split(/\r?\n/u)
        .filter((line) => line.startsWith(RED_RESULT_PREFIX));
    if (records.length !== 1)
        throw redEnvelopeInvalid();
    let value;
    try {
        value = JSON.parse(records[0].slice(RED_RESULT_PREFIX.length));
    }
    catch {
        throw redEnvelopeInvalid();
    }
    if (typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !==
            JSON.stringify([
                'failureCategory',
                'kind',
                'outcome',
                'schemaVersion',
                'selector',
                'testPaths',
            ].sort())) {
        throw redEnvelopeInvalid();
    }
    const candidate = value;
    if (candidate.schemaVersion !== 1 ||
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
        candidate.testPaths.some((entry) => typeof entry !== 'string')) {
        throw redEnvelopeInvalid();
    }
    let testPaths;
    try {
        testPaths = candidate.testPaths
            .map(normalizeChangedPath)
            .sort();
    }
    catch {
        throw redEnvelopeInvalid();
    }
    if (new Set(testPaths).size !== testPaths.length ||
        canonicalJson(testPaths) !== canonicalJson(candidate.testPaths)) {
        throw redEnvelopeInvalid();
    }
    return Object.freeze({
        failureCategory: candidate.failureCategory,
        selector: candidate.selector,
        testPaths: Object.freeze(testPaths),
    });
}
function redEnvelopeInvalid() {
    return workflowError('EXPECTED_RED_CHECK_RESULT_INVALID', 'The RED runner did not emit one exact structured failure result.', ExitCode.verification);
}
function outputText(value) {
    return typeof value === 'string' ? value : (value?.toString('utf8') ?? '');
}
function boundedExcerpt(value) {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length <= OBSERVED_CHECK_FAILURE_EXCERPT_BYTES)
        return value;
    let end = OBSERVED_CHECK_FAILURE_EXCERPT_BYTES;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80)
        end -= 1;
    return bytes.subarray(0, end).toString('utf8');
}
function observedFailureInvalid() {
    return workflowError('OBSERVED_CHECK_FAILURE_INVALID', 'Observed check failure evidence is invalid.', ExitCode.staleState);
}
function isDigest(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function assertRunnerUnchanged(checkId, expected, actual) {
    if (actual.runner !== expected.runner ||
        actual.executable !== expected.executable ||
        actual.digest !== expected.digest ||
        JSON.stringify(actual.args) !== JSON.stringify(expected.args)) {
        throw workflowError('CHECK_RUNNER_CHANGED', `Required check ${checkId} changed its resolved runner during verification.`, ExitCode.staleState, { details: { checkId } });
    }
}
function executionFailure(checkId, error) {
    return workflowError('CHECK_EXECUTION_FAILED', `Required check ${checkId} could not be executed.`, ExitCode.verification, {
        details: {
            checkId,
            errorCode: typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                typeof error.code === 'string'
                ? error.code
                : 'UNKNOWN',
        },
    });
}
