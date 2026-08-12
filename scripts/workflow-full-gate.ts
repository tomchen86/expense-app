import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  advanceFullGateProgress,
  canReuseFullGateReceipt,
  createFullGateIdentity,
  createFullGateProgress,
  createFullGateReceipt,
  FULL_GATE_INACTIVITY_INSPECTION_MS,
  FullGateTapCounter,
  progressOutputFor,
  renderFullGateProgress,
  type FullGateIdentity,
  type FullGateProgressSnapshot,
  type FullGateProgressState,
  type FullGateReceipt,
  type FullGateProgressTransition,
} from './full-gate-progress.ts';

const DEFAULT_SAMPLE_INTERVAL_MS = 5_000;
const DUPLICATE_GATE_EXIT_CODE = 75;
const GENERATED_ARTIFACT_PATHS = Object.freeze([
  'docs/CURRENT_AND_NEXT_STEPS.md',
  'docs/ISSUE_LOG.md',
  'packages/workflow-engine/bootstrap/built-in-engine-closure-pin.ts',
  'packages/workflow-engine/bootstrap/built-in-engine-closure.json',
  'packages/workflow-engine/bootstrap/harness-bootstrap-dependency-closure.json',
  'packages/workflow-engine/bootstrap/harness-bootstrap-runtime-closure-pin.ts',
  'packages/workflow-engine/bootstrap/recovery-runtime',
  'workflow/openspec-assets',
]);

export type FullGateCommand = Readonly<{
  executable: string;
  args: readonly string[];
}>;

type FullGateLockOwner = Readonly<{
  kind: 'full-gate-run-lock.v1';
  runId: string;
  pid: number;
  identityDigest: `sha256:${string}`;
  createdAt: string;
}>;

export type FullGateLock = Readonly<
  | {
      acquired: true;
      path: string;
      runId: string;
      owner: FullGateLockOwner;
    }
  | {
      acquired: false;
      path: string;
      runId: string;
      owner: FullGateLockOwner | null;
    }
>;

type FullGateRunResult = Readonly<{
  exitCode: number;
  reused: boolean;
  runId: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  receiptPath: string | null;
}>;

type FullGateRunOptions = Readonly<{
  cwd: string;
  stateRoot?: string;
  command?: FullGateCommand;
  expectedTotal?: number | null;
  reason?: string | null;
  terminal?: boolean;
  writeProgress?: (line: string) => void;
  sampleIntervalMs?: number;
}>;

type ProcessTreeSample = Readonly<{
  cpuTotalSeconds: number | null;
  inspected: boolean;
  processes: readonly Readonly<{
    pid: number;
    parentPid: number;
    state: string;
    cpuSeconds: number;
  }>[];
}>;

export function buildFullGateCommand(cwd: string): FullGateCommand {
  const canonicalCwd = fs.realpathSync(path.resolve(cwd));
  const repositoryRoot = repositoryRootFor(canonicalCwd);
  const entrypoints = [
    path.join(
      repositoryRoot,
      'packages/workflow-engine/test/contracts.test.ts',
    ),
    path.join(
      repositoryRoot,
      'packages/workflow-engine/test/session.integration.test.ts',
    ),
  ];
  return Object.freeze({
    executable: process.execPath,
    args: Object.freeze([
      '--experimental-strip-types',
      '--test',
      ...entrypoints.map((entrypoint) =>
        normalizeRelativePath(path.relative(canonicalCwd, entrypoint)),
      ),
    ]),
  });
}

export function projectWorkingTreeOid(repositoryRoot: string): string {
  const unresolved = git(repositoryRoot, ['ls-files', '-u']);
  if (unresolved.trim().length > 0) {
    throw new Error(
      'Full gate refuses a repository with unresolved Git entries.',
    );
  }
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-full-gate-index-'),
  );
  const indexPath = path.join(temporaryRoot, 'index');
  const environment = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    git(repositoryRoot, ['read-tree', 'HEAD'], environment);
    git(repositoryRoot, ['add', '-A', '--', '.'], environment);
    return git(repositoryRoot, ['write-tree'], environment).trim();
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function acquireFullGateLock(
  stateRoot: string,
  identity: FullGateIdentity,
  runId: string,
  pid: number,
): FullGateLock {
  const locks = ensurePrivateDirectory(path.join(stateRoot, 'locks'));
  const staleLocks = ensurePrivateDirectory(
    path.join(stateRoot, 'stale-locks'),
  );
  const lockPath = path.join(locks, `${digestHex(identity.digest)}.json`);
  const owner: FullGateLockOwner = Object.freeze({
    kind: 'full-gate-run-lock.v1',
    runId,
    pid,
    identityDigest: identity.digest,
    createdAt: new Date().toISOString(),
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writePrivateFileNoReplace(lockPath, serializeJson(owner));
      return Object.freeze({
        acquired: true as const,
        path: lockPath,
        runId,
        owner,
      });
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
    const observed = readLockOwner(lockPath);
    if (observed !== null && processIsAlive(observed.pid)) {
      return Object.freeze({
        acquired: false as const,
        path: lockPath,
        runId,
        owner: observed,
      });
    }
    const quarantined = path.join(
      staleLocks,
      `${path.basename(lockPath, '.json')}.${Date.now()}.${crypto.randomUUID()}.json`,
    );
    try {
      fs.renameSync(lockPath, quarantined);
      fsyncDirectory(staleLocks);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
  }
  return Object.freeze({
    acquired: false as const,
    path: lockPath,
    runId,
    owner: readLockOwner(lockPath),
  });
}

export function releaseFullGateLock(lock: FullGateLock): void {
  if (!lock.acquired) return;
  const observed = readLockOwner(lock.path);
  if (observed?.runId !== lock.runId) return;
  fs.unlinkSync(lock.path);
  fsyncDirectory(path.dirname(lock.path));
}

export async function runFullGateForTesting(
  options: FullGateRunOptions & { command: FullGateCommand; stateRoot: string },
): Promise<FullGateRunResult> {
  return runFullGate(options);
}

export async function runFullGate(
  options: FullGateRunOptions,
): Promise<FullGateRunResult> {
  const sampleIntervalMs =
    options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  if (!Number.isInteger(sampleIntervalMs) || sampleIntervalMs <= 0) {
    throw new TypeError('sampleIntervalMs must be a positive integer.');
  }
  const cwd = fs.realpathSync(path.resolve(options.cwd));
  const repositoryRoot = repositoryRootFor(cwd);
  const command = options.command ?? buildFullGateCommand(cwd);
  const stateRoot =
    options.stateRoot ??
    path.join(
      gitCommonDirectoryFor(repositoryRoot),
      'workflow-engine/full-gate',
    );
  ensurePrivateDirectory(stateRoot);
  const identity = createFullGateIdentity({
    projectedTreeOid: projectWorkingTreeOid(repositoryRoot),
    generatedArtifactsDigest: generatedArtifactsDigest(repositoryRoot),
    command: [command.executable, ...command.args],
    workingDirectory:
      normalizeRelativePath(path.relative(repositoryRoot, cwd)) || '.',
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
  });
  const reason = normalizeReason(options.reason);
  const terminal = options.terminal ?? Boolean(process.stderr.isTTY);
  const reusable =
    reason === null ? findReusableReceipt(stateRoot, identity) : null;
  const writeProgress =
    options.writeProgress ??
    ((line: string) => {
      process.stderr.write(line.startsWith('\r') ? line : `${line}\n`);
    });
  if (reusable !== null) {
    writeProgress(
      `FULL GATE REUSED · ${reusable.receipt.progress.total}/${reusable.receipt.progress.total} · tree ${identity.bindings.projectedTreeOid} · receipt ${reusable.receipt.runId}`,
    );
    return Object.freeze({
      exitCode: 0,
      reused: true,
      runId: reusable.receipt.runId,
      stdoutLogPath: reusable.stdoutLogPath,
      stderrLogPath: reusable.stderrLogPath,
      receiptPath: reusable.receiptPath,
    });
  }

  const runId = createRunId();
  const lock = acquireFullGateLock(stateRoot, identity, runId, process.pid);
  if (!lock.acquired) {
    writeProgress(
      `FULL GATE BLOCKED · identical tree already running · run ${lock.owner?.runId ?? 'unknown'}`,
    );
    return Object.freeze({
      exitCode: DUPLICATE_GATE_EXIT_CODE,
      reused: false,
      runId,
      stdoutLogPath: '',
      stderrLogPath: '',
      receiptPath: null,
    });
  }

  let stdoutFd: number | null = null;
  let stderrFd: number | null = null;
  try {
    const runRoot = ensurePrivateDirectory(path.join(stateRoot, 'runs', runId));
    const stdoutLogPath = path.join(runRoot, 'stdout.log');
    const stderrLogPath = path.join(runRoot, 'stderr.log');
    const openedStdoutFd = fs.openSync(stdoutLogPath, 'wx', 0o600);
    stdoutFd = openedStdoutFd;
    const openedStderrFd = fs.openSync(stderrLogPath, 'wx', 0o600);
    stderrFd = openedStderrFd;
    const headCommit = git(repositoryRoot, ['rev-parse', 'HEAD']).trim();
    const expectedTotal =
      options.expectedTotal ?? findExpectedTotal(stateRoot, identity);
    const tap = new FullGateTapCounter();
    const startedAtMs = Date.now();
    let progress: FullGateProgressState = createFullGateProgress({
      runId,
      identityDigest: identity.digest,
      expectedTotal,
      startedAtMs,
    });
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let lastProcessTree: ProcessTreeSample = Object.freeze({
      cpuTotalSeconds: null,
      inspected: false,
      processes: Object.freeze([]),
    });
    let childError: Error | null = null;
    let timer: NodeJS.Timeout | undefined;

    const child = spawn(command.executable, [...command.args], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const emitSnapshot = (
      requestedTransition?: FullGateProgressTransition,
      processAlive = true,
      processSucceeded: boolean | null = null,
    ): FullGateProgressSnapshot => {
      lastProcessTree = sampleProcessTree(child.pid);
      const nowMs = Date.now();
      const quietCandidate = Math.max(0, nowMs - progress.lastActivityAtMs);
      const result = advanceFullGateProgress(progress, {
        nowMs,
        processAlive,
        processSucceeded,
        processTreeInspected:
          quietCandidate >= FULL_GATE_INACTIVITY_INSPECTION_MS &&
          lastProcessTree.inspected,
        cpuTotalSeconds: lastProcessTree.cpuTotalSeconds,
        logBytes: stdoutBytes + stderrBytes,
        completed: tap.progress().completed,
        pass: tap.progress().pass,
        fail: tap.progress().fail,
        total: tap.progress().total,
      });
      progress = result.progress;
      const transition = requestedTransition ?? result.transition;
      writeLatestSnapshot(stateRoot, {
        snapshot: result.snapshot,
        rendered: renderFullGateProgress(result.snapshot),
        transition,
        stdoutLogPath,
        stderrLogPath,
        processTree: lastProcessTree.processes,
        updatedAt: new Date().toISOString(),
      });
      const output = progressOutputFor(result.snapshot, transition, terminal);
      if (output !== null) writeProgress(output);
      return result.snapshot;
    };

    child.stdout.on('data', (chunk: Buffer) => {
      fs.writeSync(openedStdoutFd, chunk);
      stdoutBytes += chunk.length;
      tap.push(chunk);
      if (tap.takeFirstFailureTransition()) emitSnapshot('failure');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      fs.writeSync(openedStderrFd, chunk);
      stderrBytes += chunk.length;
    });
    child.once('error', (error) => {
      childError = error;
    });

    const forwardSignal = (signal: NodeJS.Signals) => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill(signal);
    };
    const interrupt = () => forwardSignal('SIGINT');
    const terminate = () => forwardSignal('SIGTERM');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);

    try {
      emitSnapshot('started');
      timer = setInterval(() => emitSnapshot(), sampleIntervalMs);
      const closed = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      clearInterval(timer);
      timer = undefined;
      tap.push('\n');
      fs.fsyncSync(openedStdoutFd);
      fs.fsyncSync(openedStderrFd);
      fs.closeSync(openedStdoutFd);
      stdoutFd = null;
      fs.closeSync(openedStderrFd);
      stderrFd = null;
      const finalProgress = tap.progress();
      let completedHeadCommit: string | null = null;
      let completedIdentityDigest: `sha256:${string}` | null = null;
      let identityStable = false;
      try {
        completedHeadCommit = git(repositoryRoot, ['rev-parse', 'HEAD']).trim();
        const completedIdentity = createFullGateIdentity({
          projectedTreeOid: projectWorkingTreeOid(repositoryRoot),
          generatedArtifactsDigest: generatedArtifactsDigest(repositoryRoot),
          command: [command.executable, ...command.args],
          workingDirectory:
            normalizeRelativePath(path.relative(repositoryRoot, cwd)) || '.',
          nodeVersion: process.version,
          platform: `${process.platform}-${process.arch}`,
        });
        completedIdentityDigest = completedIdentity.digest;
        identityStable =
          completedHeadCommit === headCommit &&
          completedIdentity.digest === identity.digest;
      } catch {
        identityStable = false;
      }
      const processSucceeded =
        identityStable &&
        closed.code === 0 &&
        closed.signal === null &&
        finalProgress.total !== null &&
        finalProgress.total > 0 &&
        finalProgress.fail === 0 &&
        finalProgress.cancelled === 0;
      emitSnapshot('complete', false, processSucceeded);
      if (terminal) process.stderr.write('\n');
      const stdoutLog = readPrivateFile(stdoutLogPath);
      const stderrLog = readPrivateFile(stderrLogPath);
      const receipt = createFullGateReceipt({
        runId,
        identity,
        headCommit,
        completedHeadCommit,
        completedIdentityDigest,
        identityStable,
        reason,
        exitCode: closed.code,
        signal: closed.signal,
        rawLog: stdoutLog,
        standardError: stderrLog,
        completedAt: new Date().toISOString(),
      });
      const receiptPath = publishReceipt(stateRoot, receipt);
      if (childError !== null) throw childError;
      return Object.freeze({
        exitCode:
          receipt.outcome === 'passed'
            ? 0
            : closed.code !== null && closed.code !== 0
              ? closed.code
              : 1,
        reused: false,
        runId,
        stdoutLogPath,
        stderrLogPath,
        receiptPath,
      });
    } finally {
      if (timer !== undefined) clearInterval(timer);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
      if (stdoutFd !== null) fs.closeSync(stdoutFd);
      if (stderrFd !== null) fs.closeSync(stderrFd);
    }
  } finally {
    releaseFullGateLock(lock);
  }
}

function repositoryRootFor(cwd: string): string {
  return fs.realpathSync(
    path.resolve(
      git(path.resolve(cwd), ['rev-parse', '--show-toplevel']).trim(),
    ),
  );
}

function gitCommonDirectoryFor(repositoryRoot: string): string {
  const observed = git(repositoryRoot, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]).trim();
  return fs.realpathSync(path.resolve(repositoryRoot, observed));
}

function generatedArtifactsDigest(repositoryRoot: string): `sha256:${string}` {
  const hash = crypto.createHash('sha256');
  const tracked = git(repositoryRoot, [
    'ls-files',
    '-z',
    '--',
    ...GENERATED_ARTIFACT_PATHS,
  ])
    .split('\0')
    .filter(Boolean)
    .sort();
  hash.update(`declared\0${GENERATED_ARTIFACT_PATHS.join('\0')}\0`);
  for (const repositoryPath of tracked) {
    const filePath = path.join(repositoryRoot, ...repositoryPath.split('/'));
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Generated artifact is not a plain file: ${filePath}`);
    }
    hash.update(`${repositoryPath}\0${stats.mode & 0o777}\0`);
    hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function findReusableReceipt(
  stateRoot: string,
  identity: FullGateIdentity,
): Readonly<{
  receipt: FullGateReceipt;
  receiptPath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
}> | null {
  const receiptRoot = path.join(
    stateRoot,
    'receipts',
    digestHex(identity.digest),
  );
  if (!fs.existsSync(receiptRoot)) return null;
  assertPrivateDirectory(receiptRoot);
  const entries = fs
    .readdirSync(receiptRoot, { withFileTypes: true, recursive: false })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const entry of entries) {
    const receiptPath = path.join(receiptRoot, entry);
    try {
      const receipt = JSON.parse(
        readPrivateFile(receiptPath).toString(),
      ) as FullGateReceipt;
      if (`${receipt.runId}.json` !== entry) continue;
      const stdoutLogPath = path.join(
        stateRoot,
        'runs',
        receipt.runId,
        'stdout.log',
      );
      const stderrLogPath = path.join(
        stateRoot,
        'runs',
        receipt.runId,
        'stderr.log',
      );
      const stdoutLog = readPrivateFile(stdoutLogPath);
      const stderrLog = readPrivateFile(stderrLogPath);
      if (canReuseFullGateReceipt(receipt, identity, stdoutLog, stderrLog)) {
        return Object.freeze({
          receipt,
          receiptPath,
          stdoutLogPath,
          stderrLogPath,
        });
      }
    } catch {
      // A malformed or unsafe local receipt is never reusable. Keep scanning
      // older append-only receipts for the same exact identity.
    }
  }
  return null;
}

function findExpectedTotal(
  stateRoot: string,
  identity: FullGateIdentity,
): number | null {
  const receiptsRoot = path.join(stateRoot, 'receipts');
  if (!fs.existsSync(receiptsRoot)) return null;
  assertPrivateDirectory(receiptsRoot);
  const identityDirectories = fs
    .readdirSync(receiptsRoot, { withFileTypes: true, recursive: false })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const identityDirectory of identityDirectories) {
    const directory = path.join(receiptsRoot, identityDirectory);
    const entries = fs
      .readdirSync(directory, { withFileTypes: true, recursive: false })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const entry of entries) {
      try {
        const receipt = JSON.parse(
          readPrivateFile(path.join(directory, entry)).toString(),
        ) as FullGateReceipt;
        if (
          receipt.outcome === 'passed' &&
          receipt.progress.total !== null &&
          sameGateConfiguration(receipt.identity, identity)
        ) {
          return receipt.progress.total;
        }
      } catch {
        // Invalid historical metadata cannot seed the progress denominator.
      }
    }
  }
  return null;
}

function sameGateConfiguration(
  left: FullGateIdentity,
  right: FullGateIdentity,
): boolean {
  return (
    JSON.stringify(left.bindings.command) ===
      JSON.stringify(right.bindings.command) &&
    left.bindings.workingDirectory === right.bindings.workingDirectory &&
    left.bindings.nodeVersion === right.bindings.nodeVersion &&
    left.bindings.platform === right.bindings.platform
  );
}

function publishReceipt(stateRoot: string, receipt: FullGateReceipt): string {
  const directory = ensurePrivateDirectory(
    path.join(stateRoot, 'receipts', digestHex(receipt.identity.digest)),
  );
  const receiptPath = path.join(directory, `${receipt.runId}.json`);
  writePrivateFileNoReplace(receiptPath, serializeJson(receipt));
  return receiptPath;
}

function writeLatestSnapshot(
  stateRoot: string,
  value: Readonly<Record<string, unknown>>,
): void {
  ensurePrivateDirectory(stateRoot);
  const target = path.join(stateRoot, 'latest.json');
  const temporary = path.join(
    stateRoot,
    `.latest.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, serializeJson(value));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  if (
    existing !== undefined &&
    (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
  ) {
    throw new Error('Full-gate latest snapshot target is unsafe.');
  }
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
  fsyncDirectory(stateRoot);
}

function sampleProcessTree(rootPid: number | undefined): ProcessTreeSample {
  if (rootPid === undefined) {
    return Object.freeze({
      cpuTotalSeconds: null,
      inspected: false,
      processes: Object.freeze([]),
    });
  }
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,time=,state='], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || result.error !== undefined) {
    return Object.freeze({
      cpuTotalSeconds: null,
      inspected: false,
      processes: Object.freeze([]),
    });
  }
  const all = result.stdout
    .split('\n')
    .map(parseProcessLine)
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const retained = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of all) {
      if (retained.has(process.parentPid) && !retained.has(process.pid)) {
        retained.add(process.pid);
        changed = true;
      }
    }
  }
  const processes = Object.freeze(
    all.filter((process) => retained.has(process.pid)),
  );
  return Object.freeze({
    cpuTotalSeconds: processes.reduce(
      (total, process) => total + process.cpuSeconds,
      0,
    ),
    inspected: true,
    processes,
  });
}

function parseProcessLine(line: string): {
  pid: number;
  parentPid: number;
  state: string;
  cpuSeconds: number;
} | null {
  const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*$/.exec(line);
  if (match === null) return null;
  const cpuSeconds = parseCpuTime(match[3] ?? '');
  if (cpuSeconds === null) return null;
  return Object.freeze({
    pid: Number(match[1]),
    parentPid: Number(match[2]),
    state: match[4] ?? '',
    cpuSeconds,
  });
}

function parseCpuTime(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (match === null) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

function readLockOwner(lockPath: string): FullGateLockOwner | null {
  try {
    const value = JSON.parse(
      readPrivateFile(lockPath).toString(),
    ) as Partial<FullGateLockOwner>;
    return value.kind === 'full-gate-run-lock.v1' &&
      typeof value.runId === 'string' &&
      Number.isInteger(value.pid) &&
      typeof value.identityDigest === 'string' &&
      typeof value.createdAt === 'string'
      ? (value as FullGateLockOwner)
      : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, 'EPERM');
  }
}

function ensurePrivateDirectory(directory: string): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(
      `Full-gate state path is not a plain directory: ${directory}`,
    );
  }
  fs.chmodSync(directory, 0o700);
  return directory;
}

function assertPrivateDirectory(directory: string): void {
  const stats = fs.lstatSync(directory);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o077) !== 0
  ) {
    throw new Error(`Full-gate state directory is unsafe: ${directory}`);
  }
}

function writePrivateFileNoReplace(filePath: string, bytes: string): void {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(filePath));
}

function readPrivateFile(filePath: string): Buffer {
  const stats = fs.lstatSync(filePath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o077) !== 0
  ) {
    throw new Error(`Full-gate state file is unsafe: ${filePath}`);
  }
  return fs.readFileSync(filePath);
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function normalizeReason(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 240 ||
    /[\0\r\n]/.test(value)
  ) {
    throw new TypeError(
      'Full-gate rerun reason must be 1-240 single-line characters.',
    );
  }
  return normalized;
}

function createRunId(): string {
  return `run-${new Date().toISOString().replaceAll(/[-:.TZ]/g, '')}-${crypto.randomUUID()}`;
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join('/');
}

function digestHex(value: `sha256:${string}`): string {
  return value.slice('sha256:'.length);
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === code
  );
}

function git(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  return execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function parseFullGateCli(argv: readonly string[]): {
  status: boolean;
  json: boolean;
  expectedTotal: number | null;
  reason: string | null;
} {
  let status = false;
  let json = false;
  let expectedTotal: number | null = null;
  let reason: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      continue;
    } else if (argument === '--status') {
      status = true;
    } else if (argument === '--json') {
      json = true;
    } else if (argument === '--expected-total') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || !/^[1-9][0-9]*$/.test(value)) {
        throw new TypeError('--expected-total requires a positive integer.');
      }
      expectedTotal = Number(value);
    } else if (argument === '--reason') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined) throw new TypeError('--reason requires text.');
      reason = normalizeReason(value);
    } else {
      throw new TypeError(
        'Usage: workflow-full-gate.ts [--expected-total <count>] [--reason <text>] [--status [--json]]',
      );
    }
  }
  if (status && (expectedTotal !== null || reason !== null)) {
    throw new TypeError('--status cannot be combined with run options.');
  }
  return { status, json, expectedTotal, reason };
}

function showLatest(cwd: string, json: boolean): number {
  const repositoryRoot = repositoryRootFor(cwd);
  const stateRoot = path.join(
    gitCommonDirectoryFor(repositoryRoot),
    'workflow-engine/full-gate',
  );
  const latestPath = path.join(stateRoot, 'latest.json');
  const latest = JSON.parse(readPrivateFile(latestPath).toString()) as {
    rendered: string;
  };
  process.stdout.write(json ? serializeJson(latest) : `${latest.rendered}\n`);
  return 0;
}

async function main(): Promise<number> {
  const parsed = parseFullGateCli(process.argv.slice(2));
  if (parsed.status) return showLatest(process.cwd(), parsed.json);
  const result = await runFullGate({
    cwd: process.cwd(),
    expectedTotal: parsed.expectedTotal,
    reason: parsed.reason,
  });
  return result.exitCode;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      process.stderr.write(
        `FULL GATE FAILED TO START · ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
