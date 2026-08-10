#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST } from '../bootstrap/built-in-engine-closure-pin.js';
import { canonicalJson } from './canonical-json.js';
import { loadWorkflowConfig } from './contracts.js';
import { ExitCode, WorkflowError, workflowError } from './errors.js';
import { discoverRepository, runGit } from './git.js';
import { bootstrapInterventionUsage, dispatchBootstrapInterventionCommand, } from './intervention-control-bootstrap-cli.js';
import { persistTrustedBootstrapSessionSnapshot, readLocalEngineBinding, } from './intervention-control-bootstrap.js';
import { readControlPlaneSupervisorState } from './intervention-control-updater.js';
import { parseMaintainerPolicy } from './maintainer-policy.js';
import { createInteractiveSshSigner, } from './maintainer-signer.js';
import { listActiveWorkflowSessionIds, readSessionFile, runtimePaths, } from './session-store.js';
/**
 * Direct local recovery entry for intervention commands. This deliberately
 * excludes src/cli.ts, while its remaining src-dependent closure is recorded
 * by bootstrap/harness-bootstrap-dependency-closure.json.
 */
export function runHarnessBootstrapCli(argv, cwd = process.cwd(), overrides = {}) {
    const json = argv.includes('--json');
    const withoutOutputFlag = argv.filter((argument) => argument !== '--json');
    const args = withoutOutputFlag[0] === 'intervention'
        ? withoutOutputFlag.slice(1)
        : withoutOutputFlag;
    try {
        if (args.length === 0 ||
            args[0] === '--help' ||
            args[0] === '-h' ||
            args[0] === 'help') {
            process.stdout.write(`${bootstrapInterventionUsage()}\n`);
            return 0;
        }
        const output = {
            kind: 'harness-bootstrap-cli-result.v1',
            ok: true,
            result: dispatchBootstrapInterventionCommand(args, cwd, createHarnessBootstrapDependencies(cwd, overrides)),
        };
        process.stdout.write(`${json ? JSON.stringify(output) : JSON.stringify(output, null, 2)}\n`);
        return 0;
    }
    catch (error) {
        const failure = error instanceof WorkflowError
            ? error
            : workflowError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error), ExitCode.internal);
        const output = {
            ok: false,
            error: {
                code: failure.code,
                message: failure.message,
                ...(failure.details ? { details: failure.details } : {}),
                ...(failure.recovery ? { recovery: failure.recovery } : {}),
            },
        };
        process.stderr.write(`${json ? JSON.stringify(output) : JSON.stringify(output, null, 2)}\n`);
        return failure.exitCode;
    }
}
export function createHarnessBootstrapDependencies(cwd, overrides = {}) {
    let resolvedSigner = overrides.maintenanceSigner;
    const resolveSigner = () => {
        if (resolvedSigner === undefined) {
            const repository = discoverRepository(cwd);
            const policy = parseMaintainerPolicy(JSON.parse(runGit(repository.repositoryRoot, [
                'show',
                `${repository.head}:workflow/maintainer-policy.json`,
            ])));
            resolvedSigner = createInteractiveSshSigner(repository.repositoryRoot, policy);
        }
        return resolvedSigner;
    };
    return {
        now: overrides.now ?? (() => new Date()),
        maintenanceSigner: {
            assertHumanPresent: () => resolveSigner().assertHumanPresent(),
            identity: () => resolveSigner().identity(),
            sign: (payload, namespace) => resolveSigner().sign(payload, namespace),
            verify: (payload, signature, identity, namespace) => resolveSigner().verify(payload, signature, identity, namespace),
        },
        presentMaintenanceSummary: overrides.presentMaintenanceSummary ??
            ((summary) => {
                process.stderr.write(`\n${summary.humanReadable}\n\n`);
            }),
        resolveParentDurableState: ({ parentChangeId, stateRoot }) => resolveHarnessBootstrapParentState(cwd, parentChangeId, stateRoot),
        verifyHumanSignature(payload, signature, signerIdentity, namespace) {
            if (overrides.verifyHumanSignature) {
                return overrides.verifyHumanSignature(payload, signature, signerIdentity, namespace);
            }
            try {
                resolveSigner().verify(payload, signature, signerIdentity, namespace);
                return true;
            }
            catch {
                return false;
            }
        },
    };
}
export function resolveHarnessBootstrapParentState(cwd, parentChangeId, stateRoot) {
    const repository = discoverRepository(cwd);
    const config = loadWorkflowConfig(repository.repositoryRoot);
    const runtime = runtimePaths(repository.gitCommonDirectory, config.runtimeDirectory);
    const candidates = listActiveWorkflowSessionIds(runtime)
        .map((sessionId) => ({
        sessionId,
        sessionPath: path.join(runtime.sessions, `${sessionId}.json`),
    }))
        .map((entry) => ({ ...entry, session: readSessionFile(entry.sessionPath) }))
        .filter(({ session }) => session.changeId === parentChangeId);
    if (candidates.length === 0) {
        throw workflowError('HARNESS_BOOTSTRAP_PARENT_SESSION_NOT_FOUND', 'No active durable workflow session exists for the requested parent change.', ExitCode.staleState);
    }
    if (candidates.length !== 1) {
        throw workflowError('HARNESS_BOOTSTRAP_PARENT_SESSION_AMBIGUOUS', 'More than one active durable workflow session claims the parent change.', ExitCode.staleState);
    }
    const { session } = candidates[0];
    const expectedBranch = `work/${parentChangeId}`;
    if (session.state !== 'active' ||
        session.repositoryRoot !== repository.repositoryRealPath ||
        session.gitCommonDirectory !== repository.gitCommonDirectory ||
        session.branch !== expectedBranch ||
        repository.branch !== expectedBranch ||
        session.baseline.head !== repository.head ||
        session.baseline.tree !== repository.tree) {
        throw workflowError('HARNESS_BOOTSTRAP_PARENT_SESSION_STALE', 'Durable parent session identity, branch, or baseline differs from the current worktree.', ExitCode.staleState);
    }
    const expectedStateRoot = path.join(runtime.root, 'intervention-control');
    if (stateRoot !== expectedStateRoot) {
        throw workflowError('HARNESS_BOOTSTRAP_STATE_ROOT_MISMATCH', 'Bootstrap dispatcher state root differs from the durable workflow runtime.', ExitCode.verification);
    }
    const localBinding = readOptionalParentBinding(stateRoot, parentChangeId);
    let engineBinding = BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST;
    let sessionSchema = `workflow-session.v${session.schemaVersion}`;
    if (localBinding !== null) {
        if (localBinding.parentChangeId !== parentChangeId ||
            localBinding.parentWorkspacePath !== repository.repositoryRealPath ||
            localBinding.parentBranch !== `refs/heads/${expectedBranch}` ||
            localBinding.interventionState !== 'adopted' ||
            localBinding.blocker !== null) {
            throw workflowError('HARNESS_BOOTSTRAP_PARENT_BINDING_CONFLICT', 'Existing local engine binding is not a committed parent overlay.', ExitCode.staleState);
        }
        engineBinding = localBinding.engineDigest;
        sessionSchema = localBinding.sessionSchema;
    }
    else {
        const supervisor = readOptionalSupervisor(stateRoot);
        if (supervisor !== null) {
            engineBinding = supervisor.activeArtifact.executableDigest;
        }
    }
    return {
        parent: {
            changeId: parentChangeId,
            status: 'active',
            engineBinding,
            sessionSchema,
            blocker: null,
        },
        sessionSnapshotPath: persistTrustedBootstrapSessionSnapshot(stateRoot, session),
        pendingIntent: canonicalJson({
            kind: 'harness-bootstrap-parent-resume-intent.v1',
            sessionId: session.sessionId,
            changeId: session.changeId,
            taskId: session.taskId,
            branch: session.branch,
            baseline: session.baseline,
        }),
        policyDigest: digestCanonical({
            kind: 'harness-bootstrap-parent-policy-binding.v1',
            changeId: session.changeId,
            taskId: session.taskId,
            artifacts: session.artifacts,
            allowedPaths: session.allowedPaths,
            requiredChecks: session.requiredChecks,
            requiredCheckDigests: session.requiredCheckDigests ?? {},
            planningAssurance: session.planningAssurance ?? null,
            mandateBinding: session.mandateBinding ?? null,
        }),
    };
}
function readOptionalParentBinding(stateRoot, parentChangeId) {
    const identity = crypto
        .createHash('sha256')
        .update(`parent-session\0${parentChangeId}`)
        .digest('hex');
    const bindingPath = path.join(stateRoot, 'local-parent-sessions', `${identity}.json`);
    if (!fs.lstatSync(bindingPath, { throwIfNoEntry: false }))
        return null;
    return readLocalEngineBinding(bindingPath);
}
function readOptionalSupervisor(stateRoot) {
    try {
        return readControlPlaneSupervisorState(stateRoot);
    }
    catch (error) {
        if (error instanceof WorkflowError &&
            error.code === 'CONTROL_PLANE_SUPERVISOR_NOT_FOUND') {
            return null;
        }
        throw error;
    }
}
function digestCanonical(value) {
    return `sha256:${crypto
        .createHash('sha256')
        .update(canonicalJson(value))
        .digest('hex')}`;
}
const entryPath = process.argv[1];
if (entryPath &&
    import.meta.url === pathToFileURL(path.resolve(entryPath)).href) {
    process.exitCode = runHarnessBootstrapCli(process.argv.slice(2));
}
