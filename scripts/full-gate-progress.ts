import crypto from 'node:crypto';

import {
  summarizeFullGateTelemetry,
  type FullGateTelemetryOutcomeCounts,
} from './full-gate-telemetry-summary.ts';
import {
  digestWorkflowTestFileSet,
  type FullGateCoverageExpectation,
} from './workflow-test-inventory.ts';

export const FULL_GATE_INACTIVITY_INSPECTION_MS = 3 * 60_000;

export type FullGateIdentityBindings = Readonly<{
  projectedTreeOid: string;
  generatedArtifactsDigest: `sha256:${string}`;
  command: readonly string[];
  workingDirectory: string;
  nodeVersion: string;
  platform: string;
}>;

export type FullGateIdentity = Readonly<{
  kind: 'full-gate-run-identity.v1';
  bindings: FullGateIdentityBindings;
  digest: `sha256:${string}`;
}>;

export type FullGateProgressSnapshot = Readonly<{
  kind: 'full-gate-progress-snapshot.v1';
  authority: 'observational-only';
  runId: string;
  identityDigest: `sha256:${string}`;
  state: 'running' | 'buffered' | 'inspecting' | 'complete' | 'failed';
  elapsedMs: number;
  quietMs: number;
  processAlive: boolean;
  cpuDeltaSeconds: number | null;
  logBytes: number;
  completed: number;
  pass: number;
  fail: number;
  total: number | null;
  firstFailureName: string | null;
  firstFailureLogLocator: Readonly<{
    path: string;
    byteOffset: number;
  }> | null;
}>;

export type FullGateProgressState = Readonly<{
  runId: string;
  identityDigest: `sha256:${string}`;
  expectedTotal: number | null;
  startedAtMs: number;
  lastActivityAtMs: number;
  lastCpuTotalSeconds: number | null;
  lastLogBytes: number;
  lastCompleted: number;
  lastPass: number;
  lastFail: number;
  lastSnapshotState: FullGateProgressSnapshot['state'] | null;
}>;

export type FullGateObservation = Readonly<{
  nowMs: number;
  processAlive: boolean;
  processSucceeded?: boolean | null;
  processTreeInspected: boolean;
  cpuTotalSeconds: number | null;
  logBytes: number;
  completed: number;
  pass: number;
  fail: number;
  total?: number | null;
  firstFailureName?: string | null;
  firstFailureLogLocator?: Readonly<{
    path: string;
    byteOffset: number;
  }> | null;
}>;

export type FullGateProgressTransition =
  | 'none'
  | 'started'
  | 'progress'
  | 'buffered'
  | 'inspection'
  | 'failure'
  | 'recovery'
  | 'complete';

export type FullGateTapProgress = Readonly<{
  completed: number;
  pass: number;
  fail: number;
  total: number | null;
  cancelled: number;
  skipped: number;
  todo: number;
  durationMs: number | null;
}>;

export type FullGateFirstFailure = Readonly<{
  name: string;
  byteOffset: number;
}>;

export type FullGateFailureLocation = Readonly<{
  index: number;
  name: string;
  logLine: number;
  byteOffset: number;
}>;

export type FullGateFailureLocations = Readonly<{
  failures: readonly FullGateFailureLocation[];
  observedFailureCount: number;
  truncated: boolean;
}>;

export type FullGateCoverageEvidence = Readonly<{
  kind: 'full-gate-coverage-evidence.v1';
  inventoryDigest: `sha256:${string}`;
  expectedFileCount: number;
  expectedFileSetDigest: `sha256:${string}`;
  observedFileCount: number;
  observedFileSetDigest: `sha256:${string}`;
  fileSetMatches: boolean;
  telemetryDigest: `sha256:${string}`;
  telemetryBytes: number;
  footerComplete: boolean;
  testNodeCount: number;
  unattributedTestNodeCount: number;
  outcomeCounts: FullGateTelemetryOutcomeCounts;
}>;

export type FullGateReceipt = Readonly<{
  kind: 'full-gate-run-receipt.v2';
  authority: 'observational-only';
  runId: string;
  identity: FullGateIdentity;
  headCommit: string;
  completedHeadCommit: string | null;
  completedIdentityDigest: `sha256:${string}` | null;
  identityStable: boolean;
  reason: string | null;
  outcome: 'passed' | 'failed' | 'interrupted';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  progress: FullGateTapProgress;
  rawLogDigest: `sha256:${string}`;
  rawLogBytes: number;
  standardErrorDigest: `sha256:${string}`;
  standardErrorBytes: number;
  coverage: FullGateCoverageEvidence;
  completedAt: string;
  receiptDigest: `sha256:${string}`;
}>;

export function createFullGateIdentity(
  bindings: FullGateIdentityBindings,
): FullGateIdentity {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(bindings.projectedTreeOid)) {
    throw new TypeError('projectedTreeOid must be a canonical Git object ID.');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(bindings.generatedArtifactsDigest)) {
    throw new TypeError('generatedArtifactsDigest must be a SHA-256 digest.');
  }
  if (
    bindings.command.length === 0 ||
    bindings.command.some(
      (argument) => argument.length === 0 || /[\0\r\n]/.test(argument),
    )
  ) {
    throw new TypeError('Full-gate command bindings are malformed.');
  }
  if (
    pathIsAbsoluteOrEscaping(bindings.workingDirectory) ||
    bindings.nodeVersion.length === 0 ||
    bindings.platform.length === 0
  ) {
    throw new TypeError('Full-gate runtime bindings are malformed.');
  }
  const normalized = Object.freeze({
    projectedTreeOid: bindings.projectedTreeOid,
    generatedArtifactsDigest: bindings.generatedArtifactsDigest,
    command: Object.freeze([...bindings.command]),
    workingDirectory: bindings.workingDirectory,
    nodeVersion: bindings.nodeVersion,
    platform: bindings.platform,
  });
  return Object.freeze({
    kind: 'full-gate-run-identity.v1',
    bindings: normalized,
    digest: sha256(canonicalJson(normalized)),
  });
}

export function createFullGateProgress(input: {
  runId: string;
  identityDigest: `sha256:${string}`;
  expectedTotal: number | null;
  startedAtMs: number;
}): FullGateProgressState {
  return Object.freeze({
    runId: input.runId,
    identityDigest: input.identityDigest,
    expectedTotal: input.expectedTotal,
    startedAtMs: input.startedAtMs,
    lastActivityAtMs: input.startedAtMs,
    lastCpuTotalSeconds: 0,
    lastLogBytes: 0,
    lastCompleted: 0,
    lastPass: 0,
    lastFail: 0,
    lastSnapshotState: null,
  });
}

export function advanceFullGateProgress(
  previous: FullGateProgressState,
  observation: FullGateObservation,
): Readonly<{
  progress: FullGateProgressState;
  snapshot: FullGateProgressSnapshot;
  transition: FullGateProgressTransition;
  requiresProcessTreeInspection: boolean;
}> {
  assertNonNegativeFinite('nowMs', observation.nowMs);
  assertNonNegativeFinite('logBytes', observation.logBytes);
  assertNonNegativeInteger('completed', observation.completed);
  assertNonNegativeInteger('pass', observation.pass);
  assertNonNegativeInteger('fail', observation.fail);
  const firstFailureName = observation.firstFailureName ?? null;
  const firstFailureLogLocator = observation.firstFailureLogLocator ?? null;
  if (
    (firstFailureName === null) !== (firstFailureLogLocator === null) ||
    (firstFailureName !== null &&
      (firstFailureName.length === 0 || /[\0\r\n]/.test(firstFailureName))) ||
    (firstFailureLogLocator !== null &&
      (firstFailureLogLocator.path.length === 0 ||
        /[\0\r\n]/.test(firstFailureLogLocator.path) ||
        !Number.isInteger(firstFailureLogLocator.byteOffset) ||
        firstFailureLogLocator.byteOffset < 0))
  ) {
    throw new TypeError('first failure log metadata is malformed.');
  }
  if (
    observation.cpuTotalSeconds !== null &&
    (!Number.isFinite(observation.cpuTotalSeconds) ||
      observation.cpuTotalSeconds < 0)
  ) {
    throw new TypeError(
      'cpuTotalSeconds must be null or a non-negative number.',
    );
  }

  const observedCompleted = Math.max(
    previous.lastCompleted,
    observation.completed,
  );
  const observedPass = Math.max(previous.lastPass, observation.pass);
  const observedFail = Math.max(previous.lastFail, observation.fail);
  const observedLogBytes = Math.max(
    previous.lastLogBytes,
    observation.logBytes,
  );
  const cpuDeltaSeconds =
    observation.cpuTotalSeconds === null ||
    previous.lastCpuTotalSeconds === null
      ? null
      : Math.max(0, observation.cpuTotalSeconds - previous.lastCpuTotalSeconds);
  const counterAdvanced = observedCompleted > previous.lastCompleted;
  const cpuAdvanced = (cpuDeltaSeconds ?? 0) > 0;
  const logAdvanced = observedLogBytes > previous.lastLogBytes;
  const activity = counterAdvanced || cpuAdvanced || logAdvanced;
  const lastActivityAtMs = activity
    ? observation.nowMs
    : previous.lastActivityAtMs;
  const quietMs = Math.max(0, observation.nowMs - lastActivityAtMs);
  const requiresProcessTreeInspection =
    observation.processAlive &&
    !activity &&
    quietMs >= FULL_GATE_INACTIVITY_INSPECTION_MS &&
    !observation.processTreeInspected;
  const total = observation.total ?? previous.expectedTotal;
  const state: FullGateProgressSnapshot['state'] = !observation.processAlive
    ? observation.processSucceeded === false || observation.fail > 0
      ? 'failed'
      : 'complete'
    : quietMs >= FULL_GATE_INACTIVITY_INSPECTION_MS &&
        observation.processTreeInspected
      ? 'inspecting'
      : counterAdvanced
        ? 'running'
        : 'buffered';

  let transition: FullGateProgressTransition = 'none';
  if (!observation.processAlive) {
    transition = 'complete';
  } else if (observedFail > previous.lastFail) {
    transition = 'failure';
  } else if (previous.lastSnapshotState === 'inspecting' && activity) {
    transition = 'recovery';
  } else if (state === 'inspecting') {
    transition = 'inspection';
  } else if (counterAdvanced) {
    transition = 'progress';
  } else if (
    state === 'buffered' &&
    previous.lastSnapshotState !== 'buffered'
  ) {
    transition = 'buffered';
  }

  const snapshot = Object.freeze({
    kind: 'full-gate-progress-snapshot.v1' as const,
    authority: 'observational-only' as const,
    runId: previous.runId,
    identityDigest: previous.identityDigest,
    state,
    elapsedMs: Math.max(0, observation.nowMs - previous.startedAtMs),
    quietMs,
    processAlive: observation.processAlive,
    cpuDeltaSeconds,
    logBytes: observedLogBytes,
    completed: observedCompleted,
    pass: observedPass,
    fail: observedFail,
    total,
    firstFailureName,
    firstFailureLogLocator:
      firstFailureLogLocator === null
        ? null
        : Object.freeze({ ...firstFailureLogLocator }),
  });
  const progress = Object.freeze({
    ...previous,
    expectedTotal: total,
    lastActivityAtMs,
    lastCpuTotalSeconds: observation.cpuTotalSeconds,
    lastLogBytes: observedLogBytes,
    lastCompleted: observedCompleted,
    lastPass: observedPass,
    lastFail: observedFail,
    lastSnapshotState: state,
  });
  return Object.freeze({
    progress,
    snapshot,
    transition,
    requiresProcessTreeInspection,
  });
}

export function renderFullGateProgress(
  snapshot: FullGateProgressSnapshot,
): string {
  const elapsedMinutes = Math.floor(snapshot.elapsedMs / 60_000);
  const observed =
    snapshot.completed === 0
      ? 'no completed results observed'
      : `last observed ${snapshot.completed}/${snapshot.total ?? '?'} · fail ${snapshot.fail}`;
  if (snapshot.state === 'inspecting') {
    const quietMinutes = Math.floor(snapshot.quietMs / 60_000);
    return `FULL GATE ${elapsedMinutes}m · progress unavailable · alive, no CPU/log progress for ${quietMinutes}m · inspecting · ${observed}`;
  }
  if (snapshot.state === 'buffered') {
    return `FULL GATE ${elapsedMinutes}m · progress unavailable · output buffered · process alive · ${renderCpu(snapshot.cpuDeltaSeconds)} · ${observed}`;
  }
  const processState =
    snapshot.state === 'complete'
      ? 'complete'
      : snapshot.state === 'failed'
        ? 'failed'
        : 'process alive';
  return `FULL GATE ${elapsedMinutes}m · observed ${snapshot.completed}/${snapshot.total ?? '?'} · fail ${snapshot.fail} · ${processState} · ${renderCpu(snapshot.cpuDeltaSeconds)}`;
}

export function progressOutputFor(
  snapshot: FullGateProgressSnapshot,
  transition: FullGateProgressTransition | 'reused',
  terminal: boolean,
): string | null {
  const rendered = renderFullGateProgress(snapshot);
  if (terminal) return `\r\u001b[2K${rendered}`;
  return [
    'started',
    'failure',
    'inspection',
    'recovery',
    'complete',
    'reused',
  ].includes(transition)
    ? rendered
    : null;
}

export class FullGateTapCounter {
  #buffer = Buffer.alloc(0);
  #bufferStartOffset = 0;
  #completed = 0;
  #pass = 0;
  #fail = 0;
  #total: number | null = null;
  #cancelled = 0;
  #skipped = 0;
  #todo = 0;
  #durationMs: number | null = null;
  #failureReported = false;
  #nodeSummaryStarted = false;
  #firstFailure: FullGateFirstFailure | null = null;

  push(chunk: string | Buffer): void {
    const appended = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    this.#buffer = Buffer.concat([this.#buffer, appended]);
    let lineStart = 0;
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a, lineStart);
      if (newline < 0) break;
      let lineEnd = newline;
      if (lineEnd > lineStart && this.#buffer[lineEnd - 1] === 0x0d) {
        lineEnd -= 1;
      }
      this.#consumeLine(
        this.#buffer.subarray(lineStart, lineEnd).toString('utf8'),
        this.#bufferStartOffset + lineStart,
      );
      lineStart = newline + 1;
    }
    if (lineStart > 0) {
      this.#buffer = this.#buffer.subarray(lineStart);
      this.#bufferStartOffset += lineStart;
    }
  }

  progress(): FullGateTapProgress {
    return Object.freeze({
      completed: this.#completed,
      pass: this.#pass,
      fail: this.#fail,
      total: this.#total,
      cancelled: this.#cancelled,
      skipped: this.#skipped,
      todo: this.#todo,
      durationMs: this.#durationMs,
    });
  }

  takeFirstFailureTransition(): boolean {
    if (this.#fail === 0 || this.#failureReported) return false;
    this.#failureReported = true;
    return true;
  }

  firstFailure(): FullGateFirstFailure | null {
    return this.#firstFailure === null
      ? null
      : Object.freeze({ ...this.#firstFailure });
  }

  #consumeLine(line: string, byteOffset: number): void {
    const nodeResult = /^\s*([✔✖]) (.+) \(\d+(?:\.\d+)?(?:ms|s|m)\)$/.exec(
      line,
    );
    if (nodeResult !== null) {
      const failed = nodeResult[1] === '✖';
      if (failed) this.#recordFirstFailure(nodeResult[2]!, byteOffset);
      if (!this.#nodeSummaryStarted) {
        this.#completed += 1;
        if (failed) this.#fail += 1;
        else this.#pass += 1;
      }
      return;
    }
    if (/^ok \d+\b/.test(line)) {
      this.#completed += 1;
      this.#pass += 1;
      return;
    }
    const tapFailure = /^not ok \d+\b(?:\s+-\s+(.+))?/.exec(line);
    if (tapFailure !== null) {
      this.#recordFirstFailure(tapFailure[1] ?? line, byteOffset);
      this.#completed += 1;
      this.#fail += 1;
      return;
    }
    const summary =
      /^(#|ℹ) (tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
    if (summary !== null) {
      const value = Number(summary[3]);
      if (summary[1] === 'ℹ' && summary[2] === 'tests') {
        this.#nodeSummaryStarted = true;
      }
      switch (summary[2]) {
        case 'tests':
          this.#total = value;
          this.#completed = value;
          break;
        case 'pass':
          this.#pass = value;
          break;
        case 'fail':
          this.#fail = value;
          break;
        case 'cancelled':
          this.#cancelled = value;
          break;
        case 'skipped':
          this.#skipped = value;
          break;
        case 'todo':
          this.#todo = value;
          break;
      }
      return;
    }
    const duration = /^(?:#|ℹ) duration_ms (\d+(?:\.\d+)?)$/.exec(line);
    if (duration !== null) this.#durationMs = Number(duration[1]);
  }

  #recordFirstFailure(name: string, byteOffset: number): void {
    if (this.#firstFailure !== null) return;
    const normalized = name.trim();
    if (normalized.length === 0) return;
    this.#firstFailure = Object.freeze({ name: normalized, byteOffset });
  }
}

export function locateFullGateFailures(
  rawLog: Buffer,
  limit = 20,
): FullGateFailureLocations {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
    throw new TypeError('Full-gate failure location limit is invalid.');
  }
  const failures: FullGateFailureLocation[] = [];
  let observedFailureCount = 0;
  let sequentialIndex = 0;
  let nodeSummaryStarted = false;
  forEachRawLogLine(rawLog, (line, logLine, byteOffset) => {
    const nodeResult = /^\s*([✔✖]) (.+) \(\d+(?:\.\d+)?(?:ms|s|m)\)$/.exec(
      line,
    );
    if (nodeResult !== null) {
      if (nodeSummaryStarted) return;
      sequentialIndex += 1;
      if (nodeResult[1] !== '✖') return;
      observedFailureCount += 1;
      if (failures.length < limit) {
        failures.push(
          Object.freeze({
            index: sequentialIndex,
            name: boundedFailureName(nodeResult[2]!),
            logLine,
            byteOffset,
          }),
        );
      }
      return;
    }
    if (/^ℹ tests \d+$/.test(line)) {
      nodeSummaryStarted = true;
      return;
    }
    const tapPass = /^ok (\d+)\b/.exec(line);
    if (tapPass !== null) {
      sequentialIndex = Math.max(sequentialIndex, Number(tapPass[1]));
      return;
    }
    const tapFailure = /^not ok (\d+)\b(?:\s+-\s+(.+))?/.exec(line);
    if (tapFailure === null) return;
    const index = Number(tapFailure[1]);
    sequentialIndex = Math.max(sequentialIndex, index);
    observedFailureCount += 1;
    if (failures.length < limit) {
      failures.push(
        Object.freeze({
          index,
          name: boundedFailureName(tapFailure[2] ?? line),
          logLine,
          byteOffset,
        }),
      );
    }
  });
  return Object.freeze({
    failures: Object.freeze(failures),
    observedFailureCount,
    truncated: observedFailureCount > failures.length,
  });
}

export function validateFullGateCoverage(
  telemetry: Buffer,
  expectation: FullGateCoverageExpectation,
): FullGateCoverageEvidence {
  if (!Buffer.isBuffer(telemetry)) {
    throw new TypeError('Full-gate telemetry evidence must be bytes.');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(expectation.inventoryDigest)) {
    throw new TypeError(
      'Full-gate coverage inventoryDigest must be a SHA-256 digest.',
    );
  }
  if (!Array.isArray(expectation.expectedFiles)) {
    throw new TypeError('Full-gate coverage expectedFiles must be an array.');
  }
  const expectedFiles = [...expectation.expectedFiles];
  const expectedFileSetDigest = digestWorkflowTestFileSet(expectedFiles);
  if (
    !/^sha256:[0-9a-f]{64}$/.test(expectation.expectedFileSetDigest) ||
    expectation.expectedFileSetDigest !== expectedFileSetDigest
  ) {
    throw new TypeError(
      'Full-gate coverage expectedFileSetDigest does not match its expected files.',
    );
  }
  const canonicalExpectedFiles = [...expectedFiles].sort(compareText);
  const summary = summarizeFullGateTelemetry(telemetry);
  const observedFileSetDigest = digestWorkflowTestFileSet(
    summary.observedFiles,
  );
  if (observedFileSetDigest !== summary.observedFileSetDigest) {
    throw new Error(
      'Full-gate telemetry file-set digest is internally inconsistent.',
    );
  }
  const fileSetMatches =
    canonicalExpectedFiles.length === summary.observedFiles.length &&
    canonicalExpectedFiles.every(
      (file, index) => file === summary.observedFiles[index],
    ) &&
    expectedFileSetDigest === observedFileSetDigest;

  return Object.freeze({
    kind: 'full-gate-coverage-evidence.v1' as const,
    inventoryDigest: expectation.inventoryDigest as `sha256:${string}`,
    expectedFileCount: canonicalExpectedFiles.length,
    expectedFileSetDigest,
    observedFileCount: summary.observedFiles.length,
    observedFileSetDigest,
    fileSetMatches,
    telemetryDigest: summary.telemetryDigest,
    telemetryBytes: summary.telemetryBytes,
    footerComplete: summary.footerComplete,
    testNodeCount: summary.testNodeCount,
    unattributedTestNodeCount: summary.unattributedTestNodeCount,
    outcomeCounts: Object.freeze({ ...summary.outcomeCounts }),
  });
}

export function fullGateCoverageMatchesProgress(
  coverage: FullGateCoverageEvidence,
  progress: FullGateTapProgress,
): boolean {
  if (!isCoverageEvidenceShape(coverage)) return false;
  const outcomes = coverage.outcomeCounts;
  return (
    coverage.kind === 'full-gate-coverage-evidence.v1' &&
    /^sha256:[0-9a-f]{64}$/.test(coverage.inventoryDigest) &&
    /^sha256:[0-9a-f]{64}$/.test(coverage.expectedFileSetDigest) &&
    /^sha256:[0-9a-f]{64}$/.test(coverage.observedFileSetDigest) &&
    /^sha256:[0-9a-f]{64}$/.test(coverage.telemetryDigest) &&
    Number.isSafeInteger(coverage.expectedFileCount) &&
    coverage.expectedFileCount > 0 &&
    Number.isSafeInteger(coverage.observedFileCount) &&
    coverage.observedFileCount > 0 &&
    Number.isSafeInteger(coverage.telemetryBytes) &&
    coverage.telemetryBytes > 0 &&
    Number.isSafeInteger(coverage.testNodeCount) &&
    coverage.testNodeCount > 0 &&
    Number.isSafeInteger(coverage.unattributedTestNodeCount) &&
    coverage.unattributedTestNodeCount === 0 &&
    coverage.footerComplete === true &&
    coverage.fileSetMatches === true &&
    coverage.expectedFileCount === coverage.observedFileCount &&
    coverage.expectedFileSetDigest === coverage.observedFileSetDigest &&
    outcomeCountsAreCanonical(outcomes, coverage.testNodeCount) &&
    progress.total !== null &&
    progress.total > 0 &&
    progress.completed === progress.total &&
    coverage.testNodeCount === progress.total &&
    outcomes.passed === progress.pass &&
    outcomes['not-passed'] === progress.fail + progress.cancelled &&
    outcomes.skipped === progress.skipped &&
    outcomes.todo === progress.todo
  );
}

function forEachRawLogLine(
  rawLog: Buffer,
  consume: (line: string, logLine: number, byteOffset: number) => void,
): void {
  let byteOffset = 0;
  let logLine = 1;
  while (byteOffset < rawLog.length) {
    const newline = rawLog.indexOf(0x0a, byteOffset);
    const nextOffset = newline < 0 ? rawLog.length : newline + 1;
    let lineEnd = newline < 0 ? rawLog.length : newline;
    if (lineEnd > byteOffset && rawLog[lineEnd - 1] === 0x0d) lineEnd -= 1;
    consume(
      rawLog.subarray(byteOffset, lineEnd).toString('utf8'),
      logLine,
      byteOffset,
    );
    byteOffset = nextOffset;
    logLine += 1;
  }
}

function boundedFailureName(value: string): string {
  const normalized = value.trim().replaceAll(/\s+/g, ' ');
  if (normalized.length <= 240) return normalized;
  return `${normalized.slice(0, 239)}…`;
}

export function createFullGateReceipt(input: {
  runId: string;
  identity: FullGateIdentity;
  headCommit: string;
  completedHeadCommit: string | null;
  completedIdentityDigest: `sha256:${string}` | null;
  identityStable: boolean;
  reason: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  rawLog: Buffer;
  standardError?: Buffer;
  coverage: FullGateCoverageEvidence;
  completedAt: string;
}): FullGateReceipt {
  const standardError = input.standardError ?? Buffer.alloc(0);
  const counter = new FullGateTapCounter();
  counter.push(input.rawLog);
  const progress = counter.progress();
  const outcome: FullGateReceipt['outcome'] =
    input.signal !== null || input.exitCode === null
      ? 'interrupted'
      : input.identityStable &&
          input.completedHeadCommit === input.headCommit &&
          input.completedIdentityDigest === input.identity.digest &&
          input.exitCode === 0 &&
          progress.total !== null &&
          progress.total > 0 &&
          progress.fail === 0 &&
          progress.cancelled === 0 &&
          fullGateCoverageMatchesProgress(input.coverage, progress)
        ? 'passed'
        : 'failed';
  const unsigned = {
    kind: 'full-gate-run-receipt.v2' as const,
    authority: 'observational-only' as const,
    runId: input.runId,
    identity: input.identity,
    headCommit: input.headCommit,
    completedHeadCommit: input.completedHeadCommit,
    completedIdentityDigest: input.completedIdentityDigest,
    identityStable: input.identityStable,
    reason: input.reason,
    outcome,
    exitCode: input.exitCode,
    signal: input.signal,
    progress,
    rawLogDigest: sha256(input.rawLog),
    rawLogBytes: input.rawLog.length,
    standardErrorDigest: sha256(standardError),
    standardErrorBytes: standardError.length,
    coverage: input.coverage,
    completedAt: input.completedAt,
  };
  return Object.freeze({
    ...unsigned,
    receiptDigest: sha256(canonicalJson(unsigned)),
  });
}

export function canReuseFullGateReceipt(
  receipt: FullGateReceipt,
  identity: FullGateIdentity,
  evidence: Readonly<{
    rawLog: Buffer;
    standardError?: Buffer;
    telemetry: Buffer;
    coverageExpectation: FullGateCoverageExpectation;
  }>,
): boolean {
  if (!isReusableReceiptShape(receipt)) return false;
  const standardError = evidence.standardError ?? Buffer.alloc(0);
  const { receiptDigest: _receiptDigest, ...unsigned } = receipt;
  if (
    receipt.kind !== 'full-gate-run-receipt.v2' ||
    receipt.authority !== 'observational-only' ||
    receipt.outcome !== 'passed' ||
    receipt.identityStable !== true ||
    receipt.completedHeadCommit !== receipt.headCommit ||
    receipt.completedIdentityDigest !== identity.digest ||
    receipt.exitCode !== 0 ||
    receipt.signal !== null ||
    !/^run-\d{17}-[0-9a-f-]{36}$/.test(receipt.runId) ||
    receipt.identity.digest !== identity.digest ||
    canonicalJson(receipt.identity.bindings) !==
      canonicalJson(identity.bindings) ||
    receipt.receiptDigest !== sha256(canonicalJson(unsigned)) ||
    receipt.rawLogBytes !== evidence.rawLog.length ||
    receipt.rawLogDigest !== sha256(evidence.rawLog) ||
    receipt.standardErrorBytes !== standardError.length ||
    receipt.standardErrorDigest !== sha256(standardError)
  ) {
    return false;
  }
  let observedCoverage: FullGateCoverageEvidence;
  try {
    observedCoverage = validateFullGateCoverage(
      evidence.telemetry,
      evidence.coverageExpectation,
    );
  } catch {
    return false;
  }
  if (canonicalJson(observedCoverage) !== canonicalJson(receipt.coverage)) {
    return false;
  }
  const counter = new FullGateTapCounter();
  counter.push(evidence.rawLog);
  const observed = counter.progress();
  return (
    observed.total !== null &&
    observed.total === receipt.progress.total &&
    observed.pass === receipt.progress.pass &&
    observed.fail === 0 &&
    observed.cancelled === 0 &&
    fullGateCoverageMatchesProgress(observedCoverage, observed) &&
    canonicalJson(observed) === canonicalJson(receipt.progress)
  );
}

function isReusableReceiptShape(value: unknown): value is FullGateReceipt {
  if (
    !hasExactKeys(value, [
      'authority',
      'completedAt',
      'completedHeadCommit',
      'completedIdentityDigest',
      'coverage',
      'exitCode',
      'headCommit',
      'identity',
      'identityStable',
      'kind',
      'outcome',
      'progress',
      'rawLogBytes',
      'rawLogDigest',
      'reason',
      'receiptDigest',
      'runId',
      'signal',
      'standardErrorBytes',
      'standardErrorDigest',
    ])
  ) {
    return false;
  }
  const receipt = value as Record<string, unknown>;
  return (
    receipt.kind === 'full-gate-run-receipt.v2' &&
    receipt.authority === 'observational-only' &&
    typeof receipt.runId === 'string' &&
    /^run-\d{17}-[0-9a-f-]{36}$/.test(receipt.runId) &&
    isFullGateIdentityShape(receipt.identity) &&
    isGitObjectId(receipt.headCommit) &&
    isGitObjectId(receipt.completedHeadCommit) &&
    isSha256Digest(receipt.completedIdentityDigest) &&
    receipt.identityStable === true &&
    (receipt.reason === null || typeof receipt.reason === 'string') &&
    receipt.outcome === 'passed' &&
    receipt.exitCode === 0 &&
    receipt.signal === null &&
    isTapProgressShape(receipt.progress) &&
    isSha256Digest(receipt.rawLogDigest) &&
    isNonnegativeSafeInteger(receipt.rawLogBytes) &&
    isSha256Digest(receipt.standardErrorDigest) &&
    isNonnegativeSafeInteger(receipt.standardErrorBytes) &&
    isCoverageEvidenceShape(receipt.coverage) &&
    typeof receipt.completedAt === 'string' &&
    canonicalIsoTimestamp(receipt.completedAt) &&
    isSha256Digest(receipt.receiptDigest)
  );
}

function isFullGateIdentityShape(value: unknown): value is FullGateIdentity {
  if (!hasExactKeys(value, ['bindings', 'digest', 'kind'])) return false;
  const identity = value as Record<string, unknown>;
  if (
    identity.kind !== 'full-gate-run-identity.v1' ||
    !isSha256Digest(identity.digest) ||
    !hasExactKeys(identity.bindings, [
      'command',
      'generatedArtifactsDigest',
      'nodeVersion',
      'platform',
      'projectedTreeOid',
      'workingDirectory',
    ])
  ) {
    return false;
  }
  const bindings = identity.bindings as Record<string, unknown>;
  return (
    isGitObjectId(bindings.projectedTreeOid) &&
    isSha256Digest(bindings.generatedArtifactsDigest) &&
    Array.isArray(bindings.command) &&
    bindings.command.length > 0 &&
    bindings.command.every(
      (argument) =>
        typeof argument === 'string' &&
        argument.length > 0 &&
        !/[\0\r\n]/.test(argument),
    ) &&
    typeof bindings.workingDirectory === 'string' &&
    !pathIsAbsoluteOrEscaping(bindings.workingDirectory) &&
    typeof bindings.nodeVersion === 'string' &&
    bindings.nodeVersion.length > 0 &&
    typeof bindings.platform === 'string' &&
    bindings.platform.length > 0
  );
}

function isTapProgressShape(value: unknown): value is FullGateTapProgress {
  if (
    !hasExactKeys(value, [
      'cancelled',
      'completed',
      'durationMs',
      'fail',
      'pass',
      'skipped',
      'todo',
      'total',
    ])
  ) {
    return false;
  }
  const progress = value as Record<string, unknown>;
  return (
    isNonnegativeSafeInteger(progress.completed) &&
    isNonnegativeSafeInteger(progress.pass) &&
    isNonnegativeSafeInteger(progress.fail) &&
    isNonnegativeSafeInteger(progress.total) &&
    isNonnegativeSafeInteger(progress.cancelled) &&
    isNonnegativeSafeInteger(progress.skipped) &&
    isNonnegativeSafeInteger(progress.todo) &&
    (progress.durationMs === null ||
      (typeof progress.durationMs === 'number' &&
        Number.isFinite(progress.durationMs) &&
        progress.durationMs >= 0))
  );
}

function isCoverageEvidenceShape(
  value: unknown,
): value is FullGateCoverageEvidence {
  if (
    !hasExactKeys(value, [
      'expectedFileCount',
      'expectedFileSetDigest',
      'fileSetMatches',
      'footerComplete',
      'inventoryDigest',
      'kind',
      'observedFileCount',
      'observedFileSetDigest',
      'outcomeCounts',
      'telemetryBytes',
      'telemetryDigest',
      'testNodeCount',
      'unattributedTestNodeCount',
    ])
  ) {
    return false;
  }
  const coverage = value as Record<string, unknown>;
  if (
    coverage.kind !== 'full-gate-coverage-evidence.v1' ||
    !isSha256Digest(coverage.inventoryDigest) ||
    !isNonnegativeSafeInteger(coverage.expectedFileCount) ||
    !isSha256Digest(coverage.expectedFileSetDigest) ||
    !isNonnegativeSafeInteger(coverage.observedFileCount) ||
    !isSha256Digest(coverage.observedFileSetDigest) ||
    typeof coverage.fileSetMatches !== 'boolean' ||
    !isSha256Digest(coverage.telemetryDigest) ||
    !isNonnegativeSafeInteger(coverage.telemetryBytes) ||
    typeof coverage.footerComplete !== 'boolean' ||
    !isNonnegativeSafeInteger(coverage.testNodeCount) ||
    !isNonnegativeSafeInteger(coverage.unattributedTestNodeCount) ||
    !hasExactKeys(coverage.outcomeCounts, [
      'not-passed',
      'passed',
      'skipped',
      'todo',
    ])
  ) {
    return false;
  }
  return outcomeCountsAreCanonical(
    coverage.outcomeCounts as FullGateTelemetryOutcomeCounts,
    coverage.testNodeCount,
  );
}

function renderCpu(value: number | null): string {
  return value === null ? 'CPU unavailable' : `CPU +${Math.round(value)}s`;
}

function assertNonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number.`);
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
}

function outcomeCountsAreCanonical(
  value: FullGateTelemetryOutcomeCounts,
  expectedTotal: number,
): boolean {
  if (value === null || typeof value !== 'object') return false;
  const counts = [value.passed, value['not-passed'], value.skipped, value.todo];
  return (
    counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    counts.reduce((sum, count) => sum + count, 0) === expectedTotal
  );
}

function hasExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isGitObjectId(value: unknown): value is string {
  return (
    typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
  );
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function canonicalIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pathIsAbsoluteOrEscaping(value: string): boolean {
  return (
    value.length === 0 ||
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.split(/[\\/]/).some((segment) => segment === '..') ||
    /[\0\r\n]/.test(value)
  );
}
