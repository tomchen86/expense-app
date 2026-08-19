import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { ExitCode, WorkflowError, workflowError, } from '../../foundation/errors/errors.js';
import { createTrustedExecutionEnvironment } from '../provider-execution/execution-environment.js';
import { normalizeChangedPath } from '../session-workspace/paths.js';
export const POST_APPROVAL_ADMISSION_LIMIT_MS = 10_000;
const postApprovalDeadlineStorage = new AsyncLocalStorage();
export function createPostApprovalAdmissionDeadline(testOptions = {}) {
    const limitMs = testOptions.limitMs ?? POST_APPROVAL_ADMISSION_LIMIT_MS;
    if (!Number.isInteger(limitMs) ||
        limitMs < 1 ||
        limitMs > POST_APPROVAL_ADMISSION_LIMIT_MS) {
        throw workflowError('AUTHORITY_POST_APPROVAL_BUDGET_INVALID', 'Post-approval admission uses a positive code-owned timeout bound.', ExitCode.usage);
    }
    return {
        limitMs,
        monotonicNow: testOptions.monotonicNow ?? (() => performance.now()),
        enforceProcessTimeout: testOptions.monotonicNow === undefined,
        testHooks: {
            onArm: testOptions.onArm,
            beforeGit: testOptions.beforeGit,
            beforeProcess: testOptions.beforeProcess,
            onCompletionObligatory: testOptions.onCompletionObligatory,
        },
        phase: 'unarmed',
        startedAtMonotonicMs: null,
        lastObservedMonotonicMs: null,
    };
}
export function withPostApprovalAdmissionDeadline(deadline, operation) {
    return postApprovalDeadlineStorage.run(deadline, operation);
}
export function armPostApprovalAdmissionDeadline(deadline) {
    if (deadline.phase !== 'unarmed') {
        throw workflowError('AUTHORITY_POST_APPROVAL_BUDGET_INVALID', 'Post-approval admission may be armed exactly once.', ExitCode.guard);
    }
    deadline.startedAtMonotonicMs = readPostApprovalMonotonicClock(deadline);
    deadline.phase = 'admission';
    deadline.testHooks.onArm?.();
}
export function assertPostApprovalAdmissionDeadline(deadline) {
    if (deadline === undefined || deadline.phase !== 'admission')
        return;
    remainingPostApprovalAdmissionMillis(deadline);
}
export function assertPostApprovalAdmissionPhase(deadline) {
    if (deadline.phase === 'unarmed' || deadline.phase === 'admission')
        return;
    throw workflowError('AUTHORITY_POST_APPROVAL_BUDGET_INVALID', 'Pre-CAS authority work requires an unarmed or active admission deadline.', ExitCode.guard);
}
export function enterPostApprovalCompletionObligation(deadline, options = {}) {
    if (deadline === undefined || deadline.phase === 'completion-obligatory') {
        return;
    }
    if (deadline.phase === 'terminal-cleanup') {
        throw workflowError('AUTHORITY_POST_APPROVAL_BUDGET_INVALID', 'A terminal-cleanup authority transaction cannot become completion-obligatory.', ExitCode.guard);
    }
    if (deadline.phase === 'unarmed') {
        if (options.allowExpired) {
            deadline.phase = 'completion-obligatory';
            deadline.testHooks.onCompletionObligatory?.();
            return;
        }
        armPostApprovalAdmissionDeadline(deadline);
    }
    if (!options.allowExpired)
        assertPostApprovalAdmissionDeadline(deadline);
    deadline.phase = 'completion-obligatory';
    deadline.testHooks.onCompletionObligatory?.();
}
export function enterPostApprovalTerminalCleanup(deadline) {
    if (deadline === undefined || deadline.phase === 'terminal-cleanup')
        return;
    if (deadline.phase === 'completion-obligatory') {
        throw workflowError('AUTHORITY_POST_APPROVAL_BUDGET_INVALID', 'A completion-obligatory authority transaction cannot return to pre-CAS cleanup.', ExitCode.guard);
    }
    deadline.phase = 'terminal-cleanup';
}
export function enterActivePostApprovalTerminalCleanup() {
    enterPostApprovalTerminalCleanup(postApprovalDeadlineStorage.getStore());
}
export function isPostApprovalAdmissionFailure(error) {
    if (error === null || typeof error !== 'object' || !('code' in error)) {
        return false;
    }
    return (error.code === 'AUTHORITY_POST_APPROVAL_TIMEOUT' ||
        error.code === 'AUTHORITY_POST_APPROVAL_CLOCK_INVALID');
}
export function postApprovalSubprocessBudget(kind, executable, args) {
    const deadline = postApprovalDeadlineStorage.getStore();
    if (deadline === undefined || deadline.phase !== 'admission') {
        return undefined;
    }
    const timeoutMs = Math.max(1, Math.ceil(remainingPostApprovalAdmissionMillis(deadline)));
    try {
        deadline.testHooks.beforeProcess?.({
            kind,
            executable,
            args: [...args],
            timeoutMs,
        });
    }
    catch (error) {
        if (isProcessTimeout(error))
            throw postApprovalAdmissionTimeout();
        throw error;
    }
    assertPostApprovalAdmissionDeadline(deadline);
    return {
        processTimeoutMs: deadline.enforceProcessTimeout ? timeoutMs : undefined,
    };
}
export function normalizePostApprovalSubprocessError(budget, error) {
    if (budget !== undefined && isProcessTimeout(error)) {
        throw postApprovalAdmissionTimeout();
    }
}
function remainingPostApprovalAdmissionMillis(deadline) {
    if (deadline.phase !== 'admission' ||
        deadline.startedAtMonotonicMs === null) {
        throw workflowError('AUTHORITY_POST_APPROVAL_BUDGET_INVALID', 'Post-approval admission deadline is not active.', ExitCode.guard);
    }
    const remaining = deadline.startedAtMonotonicMs +
        deadline.limitMs -
        readPostApprovalMonotonicClock(deadline);
    if (!Number.isFinite(remaining) || remaining <= 0) {
        throw postApprovalAdmissionTimeout();
    }
    return remaining;
}
function readPostApprovalMonotonicClock(deadline) {
    const observed = deadline.monotonicNow();
    if (!Number.isFinite(observed) ||
        (deadline.lastObservedMonotonicMs !== null &&
            observed < deadline.lastObservedMonotonicMs)) {
        throw workflowError('AUTHORITY_POST_APPROVAL_CLOCK_INVALID', 'Post-approval admission requires a finite monotonic clock.', ExitCode.unsafeEnvironment);
    }
    deadline.lastObservedMonotonicMs = observed;
    return observed;
}
function activePostApprovalGitTimeout(args) {
    const deadline = postApprovalDeadlineStorage.getStore();
    if (deadline === undefined || deadline.phase !== 'admission')
        return undefined;
    const timeoutMs = Math.max(1, Math.ceil(remainingPostApprovalAdmissionMillis(deadline)));
    try {
        deadline.testHooks.beforeGit?.({ args: [...args], timeoutMs });
    }
    catch (error) {
        if (isProcessTimeout(error))
            throw postApprovalAdmissionTimeout();
        throw error;
    }
    assertPostApprovalAdmissionDeadline(deadline);
    return {
        processTimeoutMs: deadline.enforceProcessTimeout ? timeoutMs : undefined,
    };
}
function postApprovalAdmissionTimeout() {
    return workflowError('AUTHORITY_POST_APPROVAL_TIMEOUT', 'Post-approval admission exceeded its code-owned operational deadline before CAS.', ExitCode.staleState);
}
function isProcessTimeout(error) {
    return (error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ETIMEDOUT');
}
export function discoverRepository(cwd) {
    const repositoryRoot = runGit(cwd, ['rev-parse', '--show-toplevel']).trim();
    const repositoryRealPath = fs.realpathSync(repositoryRoot);
    const commonDirectoryValue = runGit(repositoryRoot, [
        'rev-parse',
        '--git-common-dir',
    ]).trim();
    const gitCommonDirectory = fs.realpathSync(path.isAbsolute(commonDirectoryValue)
        ? commonDirectoryValue
        : path.resolve(repositoryRoot, commonDirectoryValue));
    const branchValue = runGit(repositoryRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true).trim();
    const head = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
    const tree = runGit(repositoryRoot, ['rev-parse', 'HEAD^{tree}']).trim();
    const hiddenIndexEntries = splitNull(runGit(repositoryRoot, ['ls-files', '-v', '-z'])).filter(hasHiddenIndexFlag);
    if (hiddenIndexEntries.length > 0) {
        throw workflowError('UNSAFE_INDEX_FLAGS', 'Git index contains assume-unchanged or skip-worktree entries.', ExitCode.unsafeEnvironment, {
            details: {
                entryCount: hiddenIndexEntries.length,
                paths: hiddenIndexEntries.map((entry) => entry.slice(2)),
            },
            recovery: 'Clear assume-unchanged and skip-worktree flags before using the workflow.',
        });
    }
    const rawStatus = runGit(repositoryRoot, [
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
    ]);
    const controlledUntrackedPaths = listControlledUntrackedPaths(repositoryRoot);
    return {
        repositoryRoot,
        repositoryRealPath,
        gitCommonDirectory,
        branch: branchValue || null,
        head,
        tree,
        statusEntries: [
            ...splitNull(rawStatus),
            ...controlledUntrackedPaths.map((entry) => `controlled-untracked:${entry}`),
        ],
    };
}
export function listChangedPaths(repositoryRoot, baselineHead) {
    const diffPaths = splitNull(runGit(repositoryRoot, [
        'diff',
        '--name-only',
        '--no-renames',
        '-z',
        '--diff-filter=ACDMRTUXB',
        baselineHead,
        '--',
    ]));
    const untrackedPaths = listControlledUntrackedPaths(repositoryRoot);
    return [
        ...new Set([...diffPaths, ...untrackedPaths].map(normalizeChangedPath)),
    ].sort();
}
export function fingerprintWorkingState(repositoryRoot, baselineHead, statusEntries) {
    return fingerprintState(repositoryRoot, baselineHead, statusEntries, true);
}
// macOS may rewrite com.apple.provenance asynchronously without changing the
// Git projection. Persisted evidence therefore omits tracked and controlled-
// changed entry ctime only on Darwin; check mutation detection stays strict.
export function fingerprintRepositoryProjection(repositoryRoot, baselineHead, statusEntries) {
    return fingerprintState(repositoryRoot, baselineHead, statusEntries, process.platform !== 'darwin', true);
}
export function fingerprintRepositoryProjectionExcludingPaths(repositoryRoot, baselineHead, statusEntries, excludedPaths) {
    return fingerprintState(repositoryRoot, baselineHead, statusEntries, process.platform !== 'darwin', true, false, undefined, new Set(excludedPaths));
}
/**
 * Reconstruct the repository projection that existed before workflow-owned
 * staging. The caller must separately prove that the pinned candidate was
 * created from an empty managed index and that the current index is the exact
 * candidate tree. This keeps report currentness sensitive to worktree and
 * ignored-path drift without treating the later staging phase as candidate
 * mutation.
 */
export function fingerprintUnstagedRepositoryProjection(repositoryRoot, baselineHead, statusEntries) {
    return fingerprintState(repositoryRoot, baselineHead, statusEntries, process.platform !== 'darwin', true, true, '');
}
export function fingerprintRepositoryWorktree(repositoryRoot, baselineHead) {
    return fingerprintState(repositoryRoot, baselineHead, [], process.platform !== 'darwin', false, true);
}
function fingerprintState(repositoryRoot, baselineHead, statusEntries, includeVolatileMetadata, includeIndex = true, trackedFromBaseline = false, pinnedIndexState, excludedPaths = new Set()) {
    try {
        const digest = crypto.createHash('sha256');
        const trackedPaths = (trackedFromBaseline
            ? listTrackedPathsAtCommit(repositoryRoot, baselineHead)
            : listTrackedPaths(repositoryRoot)).filter((entry) => !excludedPaths.has(entry));
        const changedPaths = listChangedPaths(repositoryRoot, baselineHead).filter((entry) => !excludedPaths.has(entry));
        const ignoredPaths = listRepositoryIgnoredPaths(repositoryRoot).filter((entry) => !excludedPaths.has(entry));
        if (includeIndex) {
            const indexState = pinnedIndexState ??
                runGit(repositoryRoot, [
                    'diff',
                    '--cached',
                    '--raw',
                    '-z',
                    baselineHead,
                    '--',
                ]);
            updateFramed(digest, 'index', indexState);
            for (const statusEntry of statusEntries) {
                if (statusEntryNamesExcludedPath(statusEntry, excludedPaths))
                    continue;
                updateFramed(digest, 'status', statusEntry);
            }
        }
        for (const trackedPath of trackedPaths) {
            updateFramed(digest, 'tracked-path', trackedPath);
            fingerprintTrackedEntry(digest, repositoryRoot, trackedPath, includeVolatileMetadata);
        }
        for (const changedPath of changedPaths) {
            updateFramed(digest, 'changed-path', changedPath);
            const absolutePath = path.join(repositoryRoot, changedPath);
            const stats = fs.lstatSync(absolutePath, {
                bigint: true,
                throwIfNoEntry: false,
            });
            if (!stats) {
                updateFramed(digest, 'changed-kind', 'missing');
                continue;
            }
            updateFramed(digest, 'changed-stat', fingerprintStats(stats, includeVolatileMetadata));
            if (stats.isSymbolicLink()) {
                updateFramed(digest, 'changed-kind', 'symlink');
                updateFramed(digest, 'changed-link', fs.readlinkSync(absolutePath));
            }
            else if (stats.isFile()) {
                updateFramed(digest, 'changed-kind', 'file');
                updateFramed(digest, 'changed-content', fs.readFileSync(absolutePath));
            }
            else if (stats.isDirectory()) {
                updateFramed(digest, 'changed-kind', 'directory');
            }
            else {
                throw new Error('unsupported changed filesystem entry');
            }
        }
        for (const ignoredPath of ignoredPaths) {
            updateFramed(digest, 'ignored-path', ignoredPath);
            fingerprintIgnoredEntry(digest, repositoryRoot, ignoredPath);
        }
        return digest.digest('hex');
    }
    catch (error) {
        if (error instanceof WorkflowError) {
            throw error;
        }
        throw workflowError('WORKTREE_FINGERPRINT_FAILED', 'Unable to fingerprint the current Git working state safely.', ExitCode.staleState);
    }
}
function statusEntryNamesExcludedPath(entry, excludedPaths) {
    for (const excludedPath of excludedPaths) {
        if (entry === `controlled-untracked:${excludedPath}` ||
            entry === `? ${excludedPath}` ||
            entry === `! ${excludedPath}` ||
            entry.endsWith(` ${excludedPath}`)) {
            return true;
        }
    }
    return false;
}
export function runGit(cwd, args, allowFailure = false) {
    return executeGit(cwd, args, allowFailure, {});
}
/**
 * The remote-tracking ref for a protected branch. Authority operations resolve
 * the protected base through this single spelling rather than a bare local
 * branch, whose freshness is not a contract; both maintainer attestation and
 * archive eligibility consume it so the rule cannot diverge.
 */
export function protectedBranchRef(branch) {
    return `refs/remotes/origin/${branch}`;
}
export function runGitWithEnvironment(cwd, args, environment) {
    return executeGit(cwd, args, false, environment);
}
function executeGit(cwd, args, allowFailure, environment) {
    const executable = resolveGitExecutable();
    const postApprovalTimeout = activePostApprovalGitTimeout(args);
    const commandArgs = args[0] === 'diff'
        ? ['diff', '--no-ext-diff', '--no-textconv', ...args.slice(1)]
        : args;
    const result = spawnSync(executable, [
        '--no-pager',
        '--no-optional-locks',
        '--no-replace-objects',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.fileMode=true',
        '-C',
        cwd,
        ...commandArgs,
    ], {
        encoding: 'utf8',
        shell: false,
        maxBuffer: 64 * 1024 * 1024,
        timeout: postApprovalTimeout?.processTimeoutMs,
        env: {
            ...createTrustedExecutionEnvironment([executable]),
            ...environment,
        },
    });
    if (result.error) {
        if (postApprovalTimeout !== undefined && isProcessTimeout(result.error)) {
            throw postApprovalAdmissionTimeout();
        }
        throw workflowError('GIT_EXECUTION_FAILED', `Unable to run Git: ${result.error.message}`, ExitCode.unsafeEnvironment, { details: { args } });
    }
    if (result.status !== 0 && !allowFailure) {
        throw workflowError('GIT_COMMAND_FAILED', `Git command failed: git ${args.join(' ')}`, ExitCode.unsafeEnvironment, {
            details: {
                args,
                status: result.status,
                stderr: result.stderr.trim(),
            },
        });
    }
    return result.stdout;
}
/**
 * Binary-safe trusted Git primitive for reading pinned objects. It shares the
 * resolved absolute system Git, `shell:false`, clean trusted environment, and
 * the no-pager/locks/replace-objects/fsmonitor hardening, returns raw stdout as
 * a Buffer, accepts optional Buffer stdin (for batched `cat-file`), and adds
 * `GIT_NO_LAZY_FETCH=1` so object reads never trigger a network fetch. It never
 * searches the caller PATH and never runs a shell.
 */
export function runGitBuffer(cwd, args, options = {}) {
    const requestedTimeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(requestedTimeoutMs) || requestedTimeoutMs < 1) {
        throw workflowError('GIT_TIMEOUT_INVALID', 'Git timeout must be a positive integer number of milliseconds.', ExitCode.usage, { details: { timeoutMs: requestedTimeoutMs } });
    }
    const postApprovalTimeout = activePostApprovalGitTimeout(args);
    const timeoutMs = postApprovalTimeout === undefined ||
        postApprovalTimeout.processTimeoutMs === undefined
        ? requestedTimeoutMs
        : Math.min(requestedTimeoutMs, postApprovalTimeout.processTimeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
        throw workflowError('GIT_TIMEOUT_INVALID', 'Git timeout must be a positive integer number of milliseconds.', ExitCode.usage, { details: { timeoutMs } });
    }
    const executable = resolveGitExecutable();
    const commandArgs = args[0] === 'diff'
        ? ['diff', '--no-ext-diff', '--no-textconv', ...args.slice(1)]
        : args;
    const result = spawnSync(executable, [
        '--no-pager',
        '--no-optional-locks',
        '--no-replace-objects',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.fileMode=true',
        '-C',
        cwd,
        ...commandArgs,
    ], {
        shell: false,
        maxBuffer: 80 * 1024 * 1024,
        timeout: timeoutMs,
        input: options.input,
        env: {
            ...createTrustedExecutionEnvironment([executable]),
            GIT_NO_LAZY_FETCH: '1',
        },
    });
    if (result.error) {
        if (postApprovalTimeout !== undefined && isProcessTimeout(result.error)) {
            throw postApprovalAdmissionTimeout();
        }
        throw workflowError('GIT_EXECUTION_FAILED', `Unable to run Git: ${result.error.message}`, ExitCode.unsafeEnvironment, { details: { args } });
    }
    if (result.status !== 0 && !options.allowFailure) {
        throw workflowError('GIT_COMMAND_FAILED', `Git command failed: git ${args.join(' ')}`, ExitCode.unsafeEnvironment, {
            details: {
                args,
                status: result.status,
                stderr: result.stderr?.toString('utf8').trim(),
            },
        });
    }
    return result.stdout;
}
let pinnedGitExecutable;
export function resolveGitExecutable() {
    if (pinnedGitExecutable) {
        return pinnedGitExecutable;
    }
    for (const candidate of gitExecutableCandidates()) {
        try {
            if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
                continue;
            }
            fs.accessSync(candidate, fs.constants.X_OK);
            pinnedGitExecutable = fs.realpathSync(candidate);
            return pinnedGitExecutable;
        }
        catch {
            continue;
        }
    }
    throw workflowError('GIT_EXECUTABLE_UNAVAILABLE', 'Git is not available from a trusted system location.', ExitCode.unsafeEnvironment);
}
function gitExecutableCandidates() {
    if (process.platform === 'win32') {
        const programFiles = ['C:\\Program Files', 'C:\\Program Files (x86)'];
        return programFiles.flatMap((directory) => [
            path.join(directory, 'Git', 'cmd', 'git.exe'),
            path.join(directory, 'Git', 'bin', 'git.exe'),
        ]);
    }
    return ['/usr/bin/git', '/bin/git'];
}
function hasHiddenIndexFlag(entry) {
    const tag = entry[0];
    return tag === 'S' || (tag >= 'a' && tag <= 'z');
}
function listControlledUntrackedPaths(repositoryRoot) {
    return splitNull(runGit(repositoryRoot, [
        'ls-files',
        '--others',
        '--exclude-per-directory=.gitignore',
        '-z',
        '--',
    ])).map(normalizeChangedPath);
}
function listTrackedPaths(repositoryRoot) {
    return splitNull(runGit(repositoryRoot, ['ls-files', '--cached', '-z', '--'])).map(normalizeChangedPath);
}
function listTrackedPathsAtCommit(repositoryRoot, commit) {
    return splitNull(runGit(repositoryRoot, [
        'ls-tree',
        '-r',
        '--name-only',
        '-z',
        commit,
        '--',
    ])).map(normalizeChangedPath);
}
function listRepositoryIgnoredPaths(repositoryRoot) {
    return splitNull(runGit(repositoryRoot, [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-per-directory=.gitignore',
        '-z',
        '--',
    ])).map(normalizeGitIgnoredPath);
}
function normalizeGitIgnoredPath(value) {
    const candidate = value.endsWith('/') ? value.slice(0, -1) : value;
    return normalizeChangedPath(candidate);
}
function fingerprintIgnoredEntry(digest, repositoryRoot, ignoredPath) {
    const absolutePath = path.join(repositoryRoot, ignoredPath);
    const stats = fs.lstatSync(absolutePath, {
        bigint: true,
        throwIfNoEntry: false,
    });
    if (!stats) {
        updateFramed(digest, 'ignored-kind', 'missing');
        return;
    }
    updateFramed(digest, 'ignored-stat', fingerprintStats(stats, true));
    if (stats.isSymbolicLink()) {
        updateFramed(digest, 'ignored-kind', 'symlink');
        updateFramed(digest, 'ignored-link', fs.readlinkSync(absolutePath));
    }
    else if (stats.isFile()) {
        updateFramed(digest, 'ignored-kind', 'file');
    }
    else if (stats.isDirectory()) {
        updateFramed(digest, 'ignored-kind', 'directory');
    }
    else {
        throw new Error('unsupported ignored filesystem entry');
    }
}
function fingerprintTrackedEntry(digest, repositoryRoot, trackedPath, includeVolatileMetadata, budget) {
    const absolutePath = path.join(repositoryRoot, trackedPath);
    const stats = fs.lstatSync(absolutePath, {
        bigint: true,
        throwIfNoEntry: false,
    });
    if (!stats) {
        updateFramed(digest, 'tracked-kind', 'missing');
        return;
    }
    updateFramed(digest, 'tracked-stat', fingerprintStats(stats, includeVolatileMetadata));
    if (stats.isSymbolicLink()) {
        updateFramed(digest, 'tracked-kind', 'symlink');
        updateFramed(digest, 'tracked-link', fs.readlinkSync(absolutePath));
    }
    else if (stats.isFile()) {
        updateFramed(digest, 'tracked-kind', 'file');
        if (budget) {
            updateFramedFile(digest, 'tracked-content', absolutePath, stats, budget);
        }
        else {
            updateFramed(digest, 'tracked-content', fs.readFileSync(absolutePath));
        }
    }
    else if (stats.isDirectory()) {
        updateFramed(digest, 'tracked-kind', 'directory');
    }
    else {
        throw new Error('unsupported tracked filesystem entry');
    }
}
function fingerprintStats(stats, includeVolatileMetadata) {
    return [
        stats.dev,
        stats.ino,
        stats.mode,
        stats.nlink,
        stats.uid,
        stats.gid,
        stats.size,
        stats.mtimeNs,
        ...(includeVolatileMetadata ? [stats.ctimeNs] : []),
    ].join(':');
}
function updateFramed(digest, domain, value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    digest.update(`${domain.length}:${domain}:${bytes.length}:`);
    digest.update(bytes);
}
function updateBoundedFramed(digest, domain, value, budget) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    consumeProjectionBytes(budget, bytes.length);
    updateFramed(digest, domain, bytes);
}
function updateFramedFile(digest, domain, absolutePath, expected, budget) {
    if (expected.size < 0n ||
        expected.size > BigInt(MAX_GOVERNED_PROJECTION_FILE_BYTES)) {
        throw new Error('Governed projection file-size limit exceeded.');
    }
    const size = Number(expected.size);
    consumeProjectionBytes(budget, size);
    const domainPrefix = `${domain.length}:${domain}:${size}:`;
    digest.update(domainPrefix);
    const noFollow = process.platform !== 'win32' && typeof fs.constants.O_NOFOLLOW === 'number'
        ? fs.constants.O_NOFOLLOW
        : 0;
    const descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow);
    try {
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() ||
            opened.dev !== expected.dev ||
            opened.ino !== expected.ino ||
            opened.size !== expected.size ||
            opened.mode !== expected.mode ||
            opened.nlink !== expected.nlink) {
            throw new Error('Governed projection file identity changed.');
        }
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let consumed = 0;
        while (consumed < size) {
            const requested = Math.min(buffer.length, size - consumed);
            const read = fs.readSync(descriptor, buffer, 0, requested, null);
            if (read <= 0) {
                throw new Error('Governed projection file was truncated.');
            }
            digest.update(buffer.subarray(0, read));
            consumed += read;
        }
        const after = fs.fstatSync(descriptor, { bigint: true });
        if (consumed !== size ||
            after.dev !== expected.dev ||
            after.ino !== expected.ino ||
            after.size !== expected.size ||
            after.mode !== expected.mode ||
            after.nlink !== expected.nlink ||
            after.mtimeNs !== expected.mtimeNs) {
            throw new Error('Governed projection file changed while being read.');
        }
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function readDirectoryEntriesBounded(absoluteDirectory, budget) {
    const entries = [];
    const directory = fs.opendirSync(absoluteDirectory);
    try {
        for (;;) {
            const entry = directory.readSync();
            if (!entry) {
                break;
            }
            consumeProjectionEntries(budget, 1);
            entries.push(entry);
        }
    }
    finally {
        directory.closeSync();
    }
    return entries;
}
function consumeProjectionEntries(budget, count) {
    if (!Number.isSafeInteger(count) ||
        count < 0 ||
        count > budget.remainingEntries) {
        throw new Error('Governed projection entry limit exceeded.');
    }
    budget.remainingEntries -= count;
}
function consumeProjectionBytes(budget, count) {
    if (!Number.isSafeInteger(count) ||
        count < 0 ||
        count > budget.remainingBytes) {
        throw new Error('Governed projection aggregate byte limit exceeded.');
    }
    budget.remainingBytes -= count;
}
function splitNull(value) {
    return value.split('\0').filter(Boolean);
}
/**
 * The fixed governed-projection category order. Comparison reports drift in this
 * order so callers observe a stable category vocabulary.
 */
const GOVERNED_PROJECTION_CATEGORIES = [
    'refs',
    'git-control',
    'index',
    'tracked-worktree',
    'untracked-worktree',
    'ignored-worktree-manifest',
    'planning-artifacts',
    'governed-runtime-inputs',
];
const MAX_GOVERNED_PROJECTION_ENTRIES = 100_000;
const MAX_GOVERNED_PROJECTION_FILE_BYTES = 128 * 1024 * 1024;
const MAX_GOVERNED_PROJECTION_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_GOVERNED_PROJECTION_DEPTH = 64;
// macOS may asynchronously rewrite com.apple.provenance and bump ctime without
// any governed change, so the projection omits volatile ctime on Darwin exactly
// as the persisted repository projection does.
const INCLUDE_VOLATILE_PROJECTION_METADATA = process.platform !== 'darwin';
/**
 * Capture the engine-owned governed projection of a repository before or after a
 * bounded provider process. It binds the current worktree's symbolic HEAD,
 * resolved commit/tree, exact index stages/flags and staged tree, tracked,
 * untracked, and ignored worktree manifests, planning artifacts, and exact
 * governed runtime inputs. Refs not selected by the current worktree live in
 * shared Git-common-directory state and are deliberately outside this
 * invocation projection so unrelated concurrent activity does not stale the
 * bounded result. Equality of two projections establishes only that this
 * observed governed surface did not change; it does not prove shared-ref or
 * same-user process confinement, or global filesystem immutability.
 */
export function captureGovernedProviderProjection(repositoryRoot, runtimeInputs = []) {
    try {
        const first = sampleGovernedProviderProjectionCategories(repositoryRoot, runtimeInputs);
        const categories = sampleGovernedProviderProjectionCategories(repositoryRoot, runtimeInputs);
        if (GOVERNED_PROJECTION_CATEGORIES.some((category) => first[category] !== categories[category])) {
            throw workflowError('GOVERNED_PROJECTION_UNSTABLE', 'Governed provider projection changed while it was being sampled.', ExitCode.staleState);
        }
        const overall = crypto.createHash('sha256');
        for (const category of GOVERNED_PROJECTION_CATEGORIES) {
            updateFramed(overall, category, categories[category] ?? '');
        }
        return { categories, digest: overall.digest('hex') };
    }
    catch (error) {
        if (error instanceof WorkflowError) {
            throw error;
        }
        throw workflowError('GOVERNED_PROJECTION_FAILED', 'Unable to capture the governed provider projection safely.', ExitCode.staleState);
    }
}
function sampleGovernedProviderProjectionCategories(repositoryRoot, runtimeInputs) {
    const budget = {
        remainingEntries: MAX_GOVERNED_PROJECTION_ENTRIES,
        remainingBytes: MAX_GOVERNED_PROJECTION_TOTAL_BYTES,
    };
    return {
        refs: digestRefsProjection(repositoryRoot, budget),
        'git-control': digestGitControlProjection(repositoryRoot, budget),
        index: digestIndexProjection(repositoryRoot, budget),
        'tracked-worktree': digestTrackedWorktreeProjection(repositoryRoot, budget),
        'untracked-worktree': digestUntrackedWorktreeProjection(repositoryRoot, budget),
        'ignored-worktree-manifest': digestIgnoredWorktreeProjection(repositoryRoot, budget),
        'planning-artifacts': digestPlanningArtifactsProjection(repositoryRoot, budget),
        'governed-runtime-inputs': digestGovernedRuntimeInputs(runtimeInputs, budget),
    };
}
/**
 * Compare two governed projections, naming every category whose digest changed
 * in the fixed category order. `unchanged` is true only when no category and the
 * overall digest are identical.
 */
export function compareGovernedProviderProjections(before, after) {
    const changedCategories = GOVERNED_PROJECTION_CATEGORIES.filter((category) => before.categories[category] !== after.categories[category]);
    return {
        unchanged: changedCategories.length === 0 && before.digest === after.digest,
        changedCategories: [...changedCategories],
        beforeDigest: before.digest,
        afterDigest: after.digest,
    };
}
function digestRefsProjection(repositoryRoot, budget) {
    const digest = crypto.createHash('sha256');
    updateBoundedFramed(digest, 'head-symbolic', runGit(repositoryRoot, ['symbolic-ref', '--quiet', 'HEAD'], true), budget);
    updateBoundedFramed(digest, 'head-oid', runGit(repositoryRoot, ['rev-parse', 'HEAD']), budget);
    updateBoundedFramed(digest, 'head-tree', runGit(repositoryRoot, ['rev-parse', 'HEAD^{tree}']), budget);
    return digest.digest('hex');
}
/**
 * Digest the local Git control surface a provider process could weaponize
 * without touching a tracked worktree path: the repository-local configuration
 * and the executable hook programs and local exclude/attribute inputs under the
 * Git common directory. A change to any of these is governed drift.
 */
const GIT_WORKTREE_CONTROL_FILES = [
    'AUTO_MERGE',
    'BISECT_ANCESTORS_OK',
    'BISECT_EXPECTED_REV',
    'BISECT_HEAD',
    'BISECT_LOG',
    'BISECT_NAMES',
    'BISECT_RUN',
    'BISECT_START',
    'BISECT_TERMS',
    'CHERRY_PICK_HEAD',
    'FETCH_HEAD',
    'MERGE_AUTOSTASH',
    'MERGE_HEAD',
    'MERGE_MODE',
    'MERGE_MSG',
    'MERGE_RR',
    'ORIG_HEAD',
    'REBASE_AUTOSTASH',
    'REBASE_HEAD',
    'REVERT_HEAD',
    'SQUASH_MSG',
    'commondir',
    'config.worktree',
    'gitdir',
    'info/sparse-checkout',
    'index.lock',
];
function digestGitControlProjection(repositoryRoot, budget) {
    const digest = crypto.createHash('sha256');
    updateBoundedFramed(digest, 'config-local', runGit(repositoryRoot, ['config', '--list', '--local', '-z'], true), budget);
    const commonDirectory = localGitCommonDirectory(repositoryRoot);
    for (const relative of [
        'config',
        'config.worktree',
        'info/exclude',
        'info/attributes',
        'info/grafts',
        'objects/info/alternates',
        'shallow',
    ]) {
        updateFramed(digest, 'control-path', relative);
        fingerprintControlEntry(digest, path.join(commonDirectory, relative), budget);
    }
    digestControlTree(digest, path.join(commonDirectory, 'hooks'), 'hooks', budget, 0);
    const gitDirectory = localGitDirectory(repositoryRoot);
    for (const relative of GIT_WORKTREE_CONTROL_FILES) {
        updateFramed(digest, 'worktree-control-path', relative);
        fingerprintControlEntry(digest, path.join(gitDirectory, relative), budget);
    }
    for (const relative of ['rebase-apply', 'rebase-merge', 'sequencer']) {
        digestControlTree(digest, path.join(gitDirectory, relative), `worktree/${relative}`, budget, 0);
    }
    digestControlTree(digest, path.join(commonDirectory, 'rr-cache'), 'common/rr-cache', budget, 0);
    return digest.digest('hex');
}
function digestControlTree(digest, absoluteDirectory, label, budget, depth) {
    if (depth > MAX_GOVERNED_PROJECTION_DEPTH) {
        throw new Error('Governed projection directory depth exceeded.');
    }
    const stats = fs.lstatSync(absoluteDirectory, {
        bigint: true,
        throwIfNoEntry: false,
    });
    if (!stats) {
        updateFramed(digest, 'control-tree', 'missing');
        return;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error('Git control-tree root is not a plain directory.');
    }
    updateFramed(digest, 'control-tree-stat', fingerprintStats(stats, INCLUDE_VOLATILE_PROJECTION_METADATA));
    const entries = readDirectoryEntriesBounded(absoluteDirectory, budget);
    for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
        const childLabel = `${label}/${entry.name}`;
        updateFramed(digest, 'control-path', childLabel);
        const absoluteChild = path.join(absoluteDirectory, entry.name);
        if (entry.isDirectory()) {
            digestControlTree(digest, absoluteChild, childLabel, budget, depth + 1);
        }
        else {
            fingerprintControlEntry(digest, absoluteChild, budget);
        }
    }
}
function fingerprintControlEntry(digest, absolutePath, budget) {
    const stats = fs.lstatSync(absolutePath, {
        bigint: true,
        throwIfNoEntry: false,
    });
    if (!stats) {
        updateFramed(digest, 'control-kind', 'missing');
        return;
    }
    updateFramed(digest, 'control-stat', fingerprintStats(stats, false));
    if (stats.isSymbolicLink()) {
        updateFramed(digest, 'control-kind', 'symlink');
        updateBoundedFramed(digest, 'control-link', fs.readlinkSync(absolutePath), budget);
    }
    else if (stats.isFile()) {
        updateFramed(digest, 'control-kind', 'file');
        updateFramedFile(digest, 'control-content', absolutePath, stats, budget);
    }
    else if (stats.isDirectory()) {
        updateFramed(digest, 'control-kind', 'directory');
    }
    else {
        updateFramed(digest, 'control-kind', 'other');
    }
}
function localGitCommonDirectory(repositoryRoot) {
    const value = runGit(repositoryRoot, [
        'rev-parse',
        '--git-common-dir',
    ]).trim();
    return fs.realpathSync(path.isAbsolute(value) ? value : path.resolve(repositoryRoot, value));
}
function localGitDirectory(repositoryRoot) {
    const value = runGit(repositoryRoot, ['rev-parse', '--git-dir']).trim();
    return fs.realpathSync(path.isAbsolute(value) ? value : path.resolve(repositoryRoot, value));
}
function digestIndexProjection(repositoryRoot, budget) {
    const digest = crypto.createHash('sha256');
    updateBoundedFramed(digest, 'ls-files-stage', runGit(repositoryRoot, ['ls-files', '--stage', '-z', '--']), budget);
    updateBoundedFramed(digest, 'ls-files-flags', runGit(repositoryRoot, ['ls-files', '-v', '-z', '--']), budget);
    updateBoundedFramed(digest, 'diff-cached', runGit(repositoryRoot, ['diff', '--cached', '--raw', '-z', 'HEAD', '--']), budget);
    return digest.digest('hex');
}
function digestTrackedWorktreeProjection(repositoryRoot, budget) {
    const digest = crypto.createHash('sha256');
    const trackedPaths = listTrackedPaths(repositoryRoot);
    consumeProjectionEntries(budget, trackedPaths.length);
    for (const trackedPath of trackedPaths) {
        updateFramed(digest, 'tracked-path', trackedPath);
        fingerprintTrackedEntry(digest, repositoryRoot, trackedPath, INCLUDE_VOLATILE_PROJECTION_METADATA, budget);
    }
    return digest.digest('hex');
}
function digestUntrackedWorktreeProjection(repositoryRoot, budget) {
    const digest = crypto.createHash('sha256');
    const untrackedPaths = listControlledUntrackedPaths(repositoryRoot);
    consumeProjectionEntries(budget, untrackedPaths.length);
    for (const untrackedPath of untrackedPaths) {
        updateFramed(digest, 'untracked-path', untrackedPath);
        fingerprintWorktreeEntry(digest, path.join(repositoryRoot, untrackedPath), 'untracked', true, budget);
    }
    return digest.digest('hex');
}
function digestIgnoredWorktreeProjection(repositoryRoot, budget) {
    const digest = crypto.createHash('sha256');
    const ignoredPaths = listRepositoryIgnoredPaths(repositoryRoot);
    consumeProjectionEntries(budget, ignoredPaths.length);
    for (const ignoredPath of ignoredPaths) {
        updateFramed(digest, 'ignored-path', ignoredPath);
        fingerprintWorktreeEntry(digest, path.join(repositoryRoot, ignoredPath), 'ignored', false, budget);
    }
    return digest.digest('hex');
}
function digestPlanningArtifactsProjection(repositoryRoot, budget) {
    const digest = crypto.createHash('sha256');
    digestPlanningTree(digest, repositoryRoot, 'openspec/changes', budget, 0);
    return digest.digest('hex');
}
function digestPlanningTree(digest, repositoryRoot, relativeDirectory, budget, depth) {
    if (depth > MAX_GOVERNED_PROJECTION_DEPTH) {
        throw new Error('Governed projection directory depth exceeded.');
    }
    const absolute = path.join(repositoryRoot, relativeDirectory);
    const directoryStats = fs.lstatSync(absolute, {
        bigint: true,
        throwIfNoEntry: false,
    });
    if (!directoryStats?.isDirectory()) {
        updateFramed(digest, 'planning-missing', relativeDirectory);
        return;
    }
    const entries = readDirectoryEntriesBounded(absolute, budget);
    for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
        const childRelative = path.join(relativeDirectory, entry.name);
        updateFramed(digest, 'planning-path', childRelative);
        const absoluteChild = path.join(repositoryRoot, childRelative);
        if (entry.isSymbolicLink()) {
            updateFramed(digest, 'planning-kind', 'symlink');
            updateFramed(digest, 'planning-link', fs.readlinkSync(absoluteChild));
        }
        else if (entry.isDirectory()) {
            updateFramed(digest, 'planning-kind', 'directory');
            digestPlanningTree(digest, repositoryRoot, childRelative, budget, depth + 1);
        }
        else if (entry.isFile()) {
            updateFramed(digest, 'planning-kind', 'file');
            const childStats = fs.lstatSync(absoluteChild, {
                bigint: true,
                throwIfNoEntry: false,
            });
            if (!childStats?.isFile()) {
                throw new Error('Planning entry changed while being fingerprinted.');
            }
            updateFramedFile(digest, 'planning-content', absoluteChild, childStats, budget);
        }
        else {
            updateFramed(digest, 'planning-kind', 'other');
        }
    }
}
function digestGovernedRuntimeInputs(inputs, budget) {
    const digest = crypto.createHash('sha256');
    const sorted = [...inputs].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    consumeProjectionEntries(budget, sorted.length);
    for (const input of sorted) {
        updateFramed(digest, 'runtime-id', input.id);
        updateFramed(digest, 'runtime-kind', input.kind ?? 'file');
        if (input.kind === 'directory-closure') {
            const expectedFiles = new Set(input.expectedFiles);
            const mutableContentPaths = new Set(input.mutableContentPaths);
            if (expectedFiles.size !== input.expectedFiles.length ||
                mutableContentPaths.size !== input.mutableContentPaths.length ||
                [...expectedFiles, ...mutableContentPaths].some((relativePath) => relativePath === '' ||
                    relativePath === '..' ||
                    path.isAbsolute(relativePath) ||
                    path.posix.normalize(relativePath) !== relativePath ||
                    relativePath.startsWith('../') ||
                    relativePath.includes('\\') ||
                    relativePath.includes('\0') ||
                    relativePath.includes('/')) ||
                [...mutableContentPaths].some((relativePath) => !expectedFiles.has(relativePath))) {
                throw new Error('Invalid governed runtime directory policy.');
            }
            fingerprintRuntimeDirectoryClosure(digest, input.path, expectedFiles, mutableContentPaths, budget);
        }
        else {
            fingerprintWorktreeEntry(digest, input.path, 'runtime', true, budget);
        }
    }
    return digest.digest('hex');
}
function fingerprintRuntimeDirectoryClosure(digest, absoluteDirectory, expectedFiles, mutableContentPaths, budget) {
    const directoryStats = fs.lstatSync(absoluteDirectory, {
        bigint: true,
        throwIfNoEntry: false,
    });
    if (!directoryStats?.isDirectory() || directoryStats.isSymbolicLink()) {
        updateFramed(digest, 'runtime-tree-kind', directoryStats ? 'not-directory' : 'missing');
        return;
    }
    updateFramed(digest, 'runtime-tree-directory-stat', fingerprintStats(directoryStats, INCLUDE_VOLATILE_PROJECTION_METADATA));
    const entryNames = [];
    let unexpectedEntry = false;
    const directory = fs.opendirSync(absoluteDirectory);
    try {
        for (;;) {
            const entry = directory.readSync();
            if (!entry) {
                break;
            }
            consumeProjectionEntries(budget, 1);
            if (!expectedFiles.has(entry.name)) {
                unexpectedEntry = true;
                break;
            }
            entryNames.push(entry.name);
        }
    }
    finally {
        directory.closeSync();
    }
    if (unexpectedEntry) {
        updateFramed(digest, 'runtime-tree-kind', 'unexpected-entry');
        return;
    }
    entryNames.sort();
    for (const entryName of entryNames) {
        updateFramed(digest, 'runtime-tree-entry', entryName);
    }
    for (const relativePath of [...expectedFiles].sort()) {
        const absolutePath = path.join(absoluteDirectory, relativePath);
        updateFramed(digest, 'runtime-tree-path', relativePath);
        const stats = fs.lstatSync(absolutePath, {
            bigint: true,
            throwIfNoEntry: false,
        });
        if (!stats) {
            updateFramed(digest, 'runtime-tree-kind', 'missing');
        }
        else if (stats.isSymbolicLink()) {
            updateFramed(digest, 'runtime-tree-kind', 'symlink');
            updateFramed(digest, 'runtime-tree-link', fs.readlinkSync(absolutePath));
        }
        else if (stats.isFile()) {
            updateFramed(digest, 'runtime-tree-kind', 'file');
            if (mutableContentPaths.has(relativePath)) {
                updateFramed(digest, 'runtime-tree-mutable-file-identity', [
                    stats.dev,
                    stats.ino,
                    stats.mode,
                    stats.nlink,
                    stats.uid,
                    stats.gid,
                ].join(':'));
            }
            else {
                updateFramed(digest, 'runtime-tree-file-stat', fingerprintStats(stats, INCLUDE_VOLATILE_PROJECTION_METADATA));
                updateFramedFile(digest, 'runtime-tree-file-content', absolutePath, stats, budget);
            }
        }
        else {
            updateFramed(digest, 'runtime-tree-kind', 'other');
            updateFramed(digest, 'runtime-tree-other-stat', fingerprintStats(stats, INCLUDE_VOLATILE_PROJECTION_METADATA));
        }
    }
}
function fingerprintWorktreeEntry(digest, absolutePath, domain, includeContent, budget) {
    const stats = fs.lstatSync(absolutePath, {
        bigint: true,
        throwIfNoEntry: false,
    });
    if (!stats) {
        updateFramed(digest, `${domain}-kind`, 'missing');
        return;
    }
    updateFramed(digest, `${domain}-stat`, fingerprintStats(stats, INCLUDE_VOLATILE_PROJECTION_METADATA));
    if (stats.isSymbolicLink()) {
        updateFramed(digest, `${domain}-kind`, 'symlink');
        updateFramed(digest, `${domain}-link`, fs.readlinkSync(absolutePath));
    }
    else if (stats.isFile()) {
        updateFramed(digest, `${domain}-kind`, 'file');
        if (includeContent) {
            updateFramedFile(digest, `${domain}-content`, absolutePath, stats, budget);
        }
    }
    else if (stats.isDirectory()) {
        updateFramed(digest, `${domain}-kind`, 'directory');
    }
    else {
        updateFramed(digest, `${domain}-kind`, 'other');
    }
}
