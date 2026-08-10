#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST } from '../bootstrap/built-in-engine-closure-pin.ts';
import {
  deriveAuthorityAuditRepositoryId,
  type AuthorityAuditEventType,
  type AuthorityAuditResult,
} from './authority-audit-ledger.ts';
import {
  authorityRefusalDigest,
  recordAuthorityRefusal,
} from './authority-refusal-audit.ts';
import { recordAuthorityAuditEvent } from './authority-audit-service.ts';
import { canonicalJson } from './canonical-json.ts';
import {
  HARNESS_RECOVERY_SIGNATURE_NAMESPACE,
  canonicalControlPlaneRecoveryGrantPayload,
  findPersistedControlPlaneRecoveryGrantForSource,
  throwControlPlaneRecoveryAlreadyConsumed,
  type ControlPlaneRecoveryAuditRecord,
  type ControlPlaneRecoveryGrantEnvelope,
} from './control-plane-recovery-grant.ts';
import { loadWorkflowConfig } from './contracts.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import { discoverRepository, runGit } from './git.ts';
import {
  bootstrapInterventionStateRoot,
  bootstrapInterventionUsage,
  dispatchBootstrapInterventionCommand,
  type BootstrapInterventionCliDependencies,
  type DurableInterventionParentState,
} from './intervention-control-bootstrap-cli.ts';
import {
  persistTrustedBootstrapSessionSnapshot,
  readLocalEngineBinding,
} from './intervention-control-bootstrap.ts';
import {
  executeControlPlaneRecoveryRollback,
  preflightControlPlaneRecoveryRollback,
  readControlPlaneSupervisorState,
  type ControlPlaneRecoveryApprovalSummary,
  type ControlPlaneRecoveryExecutorDependencies,
  type ControlPlaneRecoveryRollbackResult,
  type ControlPlaneUpdaterAuditRecord,
} from './intervention-control-updater.ts';
import type { MaintenanceApprovalSummary } from './intervention-maintenance.ts';
import { parseMaintainerPolicy } from './maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
  verifySshSignatureWithPublicKey,
} from './maintainer-signer.ts';
import {
  importRecoveryAuthorityDescriptor,
  readRecoveryAuthorityDescriptor,
  verifyRecoveryAuthorityDescriptor,
  type RecoveryAuthorityDescriptorV1,
  type RecoveryAuthorityExpectations,
  type RecoveryAuthorityImportBoundary,
} from './recovery-authority.ts';
import {
  canonicalRecoveryQuarantineGrantPayload,
  executeRecoveryQuarantineEnter,
  executeRecoveryQuarantineRelease,
  readRecoveryQuarantineMarker,
  type RecoveryQuarantineAuditRecord,
  type RecoveryQuarantineDependencies,
  type RecoveryQuarantineEnterResult,
  type RecoveryQuarantineEnvelope,
  type RecoveryQuarantineReleaseResult,
} from './recovery-quarantine.ts';
import {
  RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
  executeRecoveryOperationalTrustRootRestore,
  type RecoveryOperationalTrustRootRestoreAuditRecord,
  type RecoveryOperationalTrustRootRestoreDependencies,
  type RecoveryOperationalTrustRootRestoreResult,
} from './recovery-trust-root-restore.ts';
import {
  listActiveWorkflowSessionIds,
  readSessionFile,
  runtimePaths,
} from './session-store.ts';

interface HarnessBootstrapResult {
  kind: 'harness-bootstrap-cli-result.v1';
  ok: true;
  result:
    | ReturnType<typeof dispatchBootstrapInterventionCommand>
    | ControlPlaneRecoveryRollbackResult
    | RecoveryAuthorityDescriptorV1
    | RecoveryAuthorityStatus
    | RecoveryQuarantineEnterResult
    | RecoveryQuarantineReleaseResult
    | RecoveryOperationalTrustRootRestoreResult;
}

interface RecoveryAuthorityStatus {
  kind: 'recovery-authority-status.v1';
  descriptor: RecoveryAuthorityDescriptorV1;
  quarantine: ReturnType<typeof readRecoveryQuarantineMarker>;
}

interface HarnessRecoveryRefusalAuthority {
  repositoryRoot: string;
  marker: NonNullable<ReturnType<typeof readRecoveryQuarantineMarker>>;
}

export interface HarnessBootstrapRuntimeOverrides {
  now?: () => Date;
  maintenanceSigner?: MaintainerSignerProvider;
  recoverySigner?: MaintainerSignerProvider;
  verifyHumanSignature?: NonNullable<
    BootstrapInterventionCliDependencies['verifyHumanSignature']
  >;
  presentMaintenanceSummary?: (summary: MaintenanceApprovalSummary) => void;
  presentRecoverySummary?: (
    summary: ControlPlaneRecoveryApprovalSummary,
  ) => void;
  controlPlaneAuditSink?: ControlPlaneRecoveryExecutorDependencies['auditSink'];
  recoveryAuditSink?: ControlPlaneRecoveryExecutorDependencies['recoveryAuditSink'];
  recoveryQuarantineAuditSink?: {
    append(record: RecoveryQuarantineAuditRecord): void;
  };
  recoveryTrustRootAuditSink?: {
    append(record: RecoveryOperationalTrustRootRestoreAuditRecord): void;
  };
  /** Test-only interleaving seam before the final quarantine fence read. */
  beforeRecoveryTrustRootExecute?: () => void;
}

/**
 * Direct local recovery entry for intervention commands. This deliberately
 * excludes src/cli.ts, while its remaining src-dependent closure is recorded
 * by bootstrap/harness-bootstrap-dependency-closure.json.
 */
export function runHarnessBootstrapCli(
  argv: readonly string[],
  cwd = process.cwd(),
  overrides: HarnessBootstrapRuntimeOverrides = {},
): number {
  let refusalAuthority: HarnessRecoveryRefusalAuthority | null = null;
  const json = argv.at(-1) === '--json';
  const outputFlagCount = argv.filter(
    (argument) => argument === '--json',
  ).length;
  const withoutOutputFlag = json ? argv.slice(0, -1) : [...argv];
  const args =
    withoutOutputFlag[0] === 'intervention'
      ? withoutOutputFlag.slice(1)
      : withoutOutputFlag;

  try {
    if (outputFlagCount !== (json ? 1 : 0)) {
      throw workflowError(
        'HARNESS_RECOVERY_COMMAND_UNSUPPORTED',
        harnessBootstrapUsage(),
        ExitCode.usage,
      );
    }
    assertHarnessRecoveryQuarantineRouting(args, cwd, (authority) => {
      refusalAuthority = authority;
    });
    if (
      args.length === 0 ||
      args[0] === '--help' ||
      args[0] === '-h' ||
      args[0] === 'help'
    ) {
      process.stdout.write(`${harnessBootstrapUsage()}\n`);
      return 0;
    }
    const result = isRecoveryAuthorityCommand(args)
      ? dispatchRecoveryAuthorityCommand(args, cwd, overrides)
      : isRecoveryQuarantineCommand(args)
        ? dispatchRecoveryQuarantineCommand(args, cwd, overrides)
        : isControlPlaneRecoveryCommand(args)
          ? dispatchSealedControlPlaneRecovery(args, cwd, overrides)
          : dispatchBootstrapInterventionCommand(
              args,
              cwd,
              createHarnessBootstrapDependencies(cwd, overrides),
            );
    const output: HarnessBootstrapResult = {
      kind: 'harness-bootstrap-cli-result.v1',
      ok: true,
      result,
    };
    process.stdout.write(
      `${json ? JSON.stringify(output) : JSON.stringify(output, null, 2)}\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof WorkflowError && refusalAuthority !== null) {
      auditHarnessRecoveryRefusal(refusalAuthority, args, error, overrides);
    }
    const failure =
      error instanceof WorkflowError
        ? error
        : workflowError(
            'INTERNAL_ERROR',
            error instanceof Error ? error.message : String(error),
            ExitCode.internal,
          );
    const output = {
      ok: false,
      error: {
        code: failure.code,
        message: failure.message,
        ...(failure.details ? { details: failure.details } : {}),
        ...(failure.recovery ? { recovery: failure.recovery } : {}),
      },
    };
    process.stderr.write(
      `${json ? JSON.stringify(output) : JSON.stringify(output, null, 2)}\n`,
    );
    return failure.exitCode;
  }
}

function isRecoveryAuthorityCommand(args: readonly string[]): boolean {
  return args[0] === 'recovery-authority';
}

function isRecoveryQuarantineCommand(args: readonly string[]): boolean {
  return args[0] === 'recovery-quarantine';
}

function isControlPlaneRecoveryCommand(args: readonly string[]): boolean {
  return args[0] === 'control-plane';
}

function assertHarnessRecoveryQuarantineRouting(
  args: readonly string[],
  cwd: string,
  observeRefusalAuthority: (authority: HarnessRecoveryRefusalAuthority) => void,
): void {
  let repository: ReturnType<typeof discoverRepository>;
  try {
    repository = discoverRepository(cwd);
  } catch (error) {
    if (
      args.length === 0 ||
      args[0] === '--help' ||
      args[0] === '-h' ||
      args[0] === 'help'
    ) {
      return;
    }
    throw error;
  }
  const marker = readOptionalRecoveryQuarantineMarker(
    recoveryAuthorityStateRoot(repository.gitCommonDirectory),
  );
  if (marker !== null) {
    observeRefusalAuthority({
      repositoryRoot: repository.repositoryRealPath,
      marker,
    });
  }
  const operationalTrustFence = hasRecoveryOperationalTrustRootFence(
    recoveryAuthorityStateRoot(repository.gitCommonDirectory),
  );
  if (marker !== null) {
    if (
      isExactControlPlaneRollback(args) ||
      isExactRecoveryQuarantineCommand(args, 'release') ||
      isExactRecoveryAuthorityRestoreCommand(args)
    ) {
      return;
    }
    throw workflowError(
      'WORKFLOW_RECOVERY_QUARANTINED',
      'Only exact sealed Recovery Quarantine release, trust-root restore, or control-plane rollback is available while quarantine is active.',
      ExitCode.guard,
    );
  }
  if (operationalTrustFence) {
    if (isExactRecoveryQuarantineCommand(args, 'enter')) return;
    throw workflowError(
      'RECOVERY_OPERATIONAL_TRUST_NOT_ACTIVATED',
      'A restored operational trust root exists without an out-of-band pinned activation channel; only exact Recovery Quarantine entry remains available.',
      ExitCode.guard,
    );
  }
}

function auditHarnessRecoveryRefusal(
  authority: HarnessRecoveryRefusalAuthority,
  args: readonly string[],
  refusal: WorkflowError,
  overrides: HarnessBootstrapRuntimeOverrides,
): void {
  if (refusal.code.startsWith('AUTHORITY_AUDIT_')) return;
  const { marker, repositoryRoot } = authority;
  try {
    recordAuthorityRefusal(
      {
        scope: {
          externalAuditRoot: marker.externalAuditRoot,
          repositoryRoot,
          repositoryId: deriveAuthorityAuditRepositoryId(marker.repositoryId),
        },
        family: 'recovery-authority',
        operation: 'harness-bootstrap.rejection',
        subjectId: marker.enterGrantId,
        actor: { kind: 'engine', identity: 'sealed-recovery-harness' },
        taskId: null,
        changeId: null,
        workflowId: marker.enterGrantId,
        grantDigest: marker.enterEnvelopeDigest,
        candidateBundleDigest: null,
        bindingDigest: marker.markerDigest,
        refusalIdentity: {
          argvDigest: authorityRefusalDigest({ argv: [...args] }),
        },
      },
      refusal,
      { now: overrides.now?.() ?? new Date() },
    );
  } catch (auditError) {
    attachHarnessRefusalAuditFailure(refusal, auditError);
  }
}

function attachHarnessRefusalAuditFailure(
  refusal: WorkflowError,
  auditError: unknown,
): void {
  try {
    const currentCause = (refusal as Error & { cause?: unknown }).cause;
    Object.defineProperty(refusal, 'cause', {
      configurable: true,
      enumerable: false,
      value:
        currentCause === undefined
          ? auditError
          : new AggregateError(
              [currentCause, auditError],
              'Recovery refusal audit also failed.',
            ),
      writable: false,
    });
  } catch {
    // The stable refusal stays authoritative if diagnostic attachment fails.
  }
}

function dispatchRecoveryAuthorityCommand(
  args: readonly string[],
  cwd: string,
  overrides: HarnessBootstrapRuntimeOverrides,
):
  | RecoveryAuthorityDescriptorV1
  | RecoveryAuthorityStatus
  | RecoveryOperationalTrustRootRestoreResult {
  const repository = discoverRepository(cwd);
  const boundary = recoveryImportBoundary(repository);
  if (
    args.length === 5 &&
    args[0] === 'recovery-authority' &&
    args[1] === 'import' &&
    isExactAbsolutePath(args[2]) &&
    args[3] === '--expectations' &&
    isExactAbsolutePath(args[4])
  ) {
    const expectations = readExternalRecoveryExpectations(args[4], boundary);
    const descriptor = verifyRecoveryAuthorityDescriptor(
      readExternalRecoveryInput(args[2], boundary),
      expectations,
    );
    const stateRoot = ensureRecoveryAuthorityStateRoot(
      repository.gitCommonDirectory,
    );
    assertRecoveryQuarantineInactive(stateRoot);
    return importRecoveryAuthorityDescriptor(
      args[2],
      stateRoot,
      expectations,
      boundary,
    );
  }
  if (isExactRecoveryAuthorityRestoreCommand(args)) {
    return dispatchRecoveryOperationalTrustRootRestore(
      args,
      repository,
      boundary,
      overrides,
    );
  }
  if (
    args.length === 4 &&
    args[0] === 'recovery-authority' &&
    args[1] === 'status' &&
    args[2] === '--expectations' &&
    isExactAbsolutePath(args[3])
  ) {
    const expectations = readExternalRecoveryExpectations(args[3], boundary);
    const stateRoot = requireRecoveryAuthorityStateRoot(
      repository.gitCommonDirectory,
    );
    assertRecoveryQuarantineInactive(stateRoot);
    return {
      kind: 'recovery-authority-status.v1',
      descriptor: readRecoveryAuthorityDescriptor(
        stateRoot,
        expectations,
        boundary,
      ),
      quarantine: null,
    };
  }
  throw workflowError(
    'HARNESS_RECOVERY_COMMAND_UNSUPPORTED',
    harnessBootstrapUsage(),
    ExitCode.usage,
  );
}

function dispatchRecoveryOperationalTrustRootRestore(
  args: readonly string[],
  repository: ReturnType<typeof discoverRepository>,
  boundary: RecoveryAuthorityImportBoundary,
  overrides: HarnessBootstrapRuntimeOverrides,
): RecoveryOperationalTrustRootRestoreResult {
  const envelopePath = args[2]!;
  const expectationsPath = args[4]!;
  const expectations = readExternalRecoveryExpectations(
    expectationsPath,
    boundary,
  );
  const stateRoot = requireRecoveryAuthorityStateRoot(
    repository.gitCommonDirectory,
  );
  const descriptor = readRecoveryAuthorityDescriptor(
    stateRoot,
    expectations,
    boundary,
  );
  const externalAuditRoot = readExternalRecoveryTrustRootAuditRoot(
    envelopePath,
    boundary,
  );
  const markerDigest = requireMatchingRecoveryQuarantine(
    stateRoot,
    descriptor,
    externalAuditRoot,
  );
  const dependencies = recoveryOperationalTrustRootDependencies(
    descriptor,
    expectations,
    externalAuditRoot,
    repository.repositoryRealPath,
    overrides,
  );
  overrides.beforeRecoveryTrustRootExecute?.();
  const markerDigestAtExecution = requireMatchingRecoveryQuarantine(
    stateRoot,
    descriptor,
    externalAuditRoot,
  );
  if (markerDigestAtExecution !== markerDigest) {
    throw recoveryTrustRootQuarantineMismatch();
  }
  return executeRecoveryOperationalTrustRootRestore(
    envelopePath,
    stateRoot,
    boundary,
    dependencies,
  );
}

function requireMatchingRecoveryQuarantine(
  stateRoot: string,
  descriptor: RecoveryAuthorityDescriptorV1,
  externalAuditRoot: string,
): string {
  const marker = readRecoveryQuarantineMarker(stateRoot);
  if (marker === null) {
    throw workflowError(
      'RECOVERY_TRUST_ROOT_QUARANTINE_REQUIRED',
      'Operational trust-root restore requires an active canonical Recovery Quarantine marker.',
      ExitCode.guard,
    );
  }
  if (
    marker.repositoryId !== descriptor.repositoryIdentity.repositoryId ||
    marker.authorityDescriptorDigest !== descriptor.descriptorDigest ||
    marker.authorityGeneration !== descriptor.generation ||
    marker.recoveryRuntimeDigest !== descriptor.sealedRuntime.closureDigest ||
    marker.externalAuditRoot !== externalAuditRoot
  ) {
    throw recoveryTrustRootQuarantineMismatch();
  }
  return marker.markerDigest;
}

function recoveryTrustRootQuarantineMismatch(): WorkflowError {
  return workflowError(
    'RECOVERY_TRUST_ROOT_QUARANTINE_MISMATCH',
    'Operational trust-root restore does not bind the exact active Recovery Quarantine marker.',
    ExitCode.verification,
  );
}

function recoveryOperationalTrustRootDependencies(
  descriptor: RecoveryAuthorityDescriptorV1,
  expectations: RecoveryAuthorityExpectations,
  externalAuditRoot: string,
  repositoryRoot: string,
  overrides: HarnessBootstrapRuntimeOverrides,
): RecoveryOperationalTrustRootRestoreDependencies {
  return {
    authorityDescriptor: descriptor,
    authorityExpectations: expectations,
    externalAuditRoot,
    now: overrides.now?.() ?? new Date(),
    verifyHumanSignature(payload, signature, identity, namespace) {
      if (
        namespace !== RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE ||
        identity !== descriptor.signer.identity ||
        descriptor.signer.fingerprint !== expectations.signerFingerprint
      ) {
        return false;
      }
      try {
        verifySshSignatureWithPublicKey(
          payload,
          signature,
          identity,
          descriptor.signer.publicKey,
          namespace,
        );
        return true;
      } catch {
        return false;
      }
    },
    appendAudit:
      overrides.recoveryTrustRootAuditSink?.append ??
      productionRecoveryTrustRootAuditSink(repositoryRoot).append,
  };
}

function productionRecoveryTrustRootAuditSink(repositoryRoot: string) {
  return {
    append(record: RecoveryOperationalTrustRootRestoreAuditRecord): void {
      recordAuthorityAuditEvent(
        {
          externalAuditRoot: record.externalAuditRoot,
          repositoryRoot,
          repositoryId: deriveAuthorityAuditRepositoryId(record.repositoryId),
        },
        {
          eventType: 'recovery',
          occurredAt: record.recordedAt,
          idempotencyKey: record.recordId,
          grantDigest: record.envelopeDigest,
          candidateBundleDigest: record.rootDigest,
          prestateDigest: record.previousPointerDigest,
          poststateDigest: record.newPointerDigest,
          actor: { kind: 'human', identity: record.humanSigner },
          taskId: null,
          changeId: null,
          workflowId: record.grantId,
          command: {
            name: 'recovery-authority.restore-trust-root',
            argvDigest: record.recordDigest,
          },
          providerInvocation: null,
          externalEffect: null,
          result: 'succeeded',
          outcomeDigest: record.terminalDigest,
          errorCode: null,
        },
      );
    },
  };
}

function dispatchRecoveryQuarantineCommand(
  args: readonly string[],
  cwd: string,
  overrides: HarnessBootstrapRuntimeOverrides,
): RecoveryQuarantineEnterResult | RecoveryQuarantineReleaseResult {
  const operation =
    args[1] === 'enter'
      ? ('enter' as const)
      : args[1] === 'release'
        ? ('release' as const)
        : null;
  if (
    operation === null ||
    !isExactRecoveryQuarantineCommand(args, operation)
  ) {
    throw workflowError(
      'HARNESS_RECOVERY_COMMAND_UNSUPPORTED',
      harnessBootstrapUsage(),
      ExitCode.usage,
    );
  }
  const repository = discoverRepository(cwd);
  const boundary = recoveryImportBoundary(repository);
  const expectations = readExternalRecoveryExpectations(args[4], boundary);
  const stateRoot = requireRecoveryAuthorityStateRoot(
    repository.gitCommonDirectory,
  );
  const descriptor = readRecoveryAuthorityDescriptor(
    stateRoot,
    expectations,
    boundary,
  );
  const envelope = readExternalRecoveryEnvelope(args[2], boundary);
  const dependencies = recoveryQuarantineDependencies(
    descriptor,
    expectations,
    envelope,
    repository.repositoryRealPath,
    overrides,
  );
  if (operation === 'enter') assertRecoveryQuarantineInactive(stateRoot);
  return operation === 'enter'
    ? executeRecoveryQuarantineEnter(stateRoot, envelope, dependencies)
    : executeRecoveryQuarantineRelease(stateRoot, envelope, dependencies);
}

function assertRecoveryQuarantineInactive(storageRoot: string): void {
  if (readRecoveryQuarantineMarker(storageRoot) !== null) {
    throw workflowError(
      'WORKFLOW_RECOVERY_QUARANTINED',
      'Recovery Authority import, status, and enter are unavailable while quarantine is active.',
      ExitCode.guard,
    );
  }
}

function recoveryQuarantineDependencies(
  descriptor: RecoveryAuthorityDescriptorV1,
  expectations: RecoveryAuthorityExpectations,
  envelope: RecoveryQuarantineEnvelope,
  repositoryRoot: string,
  overrides: HarnessBootstrapRuntimeOverrides,
): RecoveryQuarantineDependencies {
  const externalAuditRoot = envelope.payload.externalAuditRoot;
  return {
    authorityDescriptor: descriptor,
    authorityExpectations: expectations,
    externalAuditRoot,
    now: overrides.now?.() ?? new Date(),
    verifyHumanSignature(payload, signature, identity, namespace) {
      if (
        identity !== descriptor.signer.identity ||
        descriptor.signer.fingerprint !== expectations.signerFingerprint
      ) {
        return false;
      }
      try {
        verifySshSignatureWithPublicKey(
          payload,
          signature,
          identity,
          descriptor.signer.publicKey,
          namespace,
        );
        return true;
      } catch {
        return false;
      }
    },
    appendAudit:
      overrides.recoveryQuarantineAuditSink?.append ??
      productionRecoveryQuarantineAuditSink(repositoryRoot).append,
  };
}

function productionRecoveryQuarantineAuditSink(repositoryRoot: string) {
  return {
    append(record: RecoveryQuarantineAuditRecord): void {
      recordAuthorityAuditEvent(
        {
          externalAuditRoot: record.externalAuditRoot,
          repositoryRoot,
          repositoryId: deriveAuthorityAuditRepositoryId(record.repositoryId),
        },
        {
          eventType:
            record.event === 'quarantine-entered'
              ? 'recovery'
              : 'grant-consume',
          occurredAt: record.recordedAt,
          idempotencyKey: record.recordId,
          grantDigest: record.envelopeDigest,
          candidateBundleDigest: null,
          prestateDigest:
            record.event === 'quarantine-released' ? record.markerDigest : null,
          poststateDigest:
            record.event === 'quarantine-entered' ? record.markerDigest : null,
          actor: { kind: 'human', identity: record.humanSigner },
          taskId: null,
          changeId: null,
          workflowId: record.grantId,
          command: {
            name:
              record.event === 'quarantine-entered'
                ? 'recovery-quarantine.enter'
                : 'recovery-quarantine.release',
            argvDigest: record.recordDigest,
          },
          providerInvocation: null,
          externalEffect: null,
          result: 'succeeded',
          outcomeDigest: record.receiptDigest,
          errorCode: null,
        },
      );
    },
  };
}

function isExactControlPlaneRollback(args: readonly string[]): boolean {
  return (
    args.length === 3 &&
    args[0] === 'control-plane' &&
    args[1] === 'rollback' &&
    isExactCliIdentifier(args[2])
  );
}

function isExactRecoveryQuarantineCommand(
  args: readonly string[],
  operation: 'enter' | 'release',
): boolean {
  return (
    args.length === 5 &&
    args[0] === 'recovery-quarantine' &&
    args[1] === operation &&
    isExactAbsolutePath(args[2]) &&
    args[3] === '--expectations' &&
    isExactAbsolutePath(args[4])
  );
}

function isExactRecoveryAuthorityRestoreCommand(
  args: readonly string[],
): boolean {
  return (
    args.length === 5 &&
    args[0] === 'recovery-authority' &&
    args[1] === 'restore-trust-root' &&
    isExactAbsolutePath(args[2]) &&
    args[3] === '--expectations' &&
    isExactAbsolutePath(args[4])
  );
}

function recoveryImportBoundary(
  repository: ReturnType<typeof discoverRepository>,
): RecoveryAuthorityImportBoundary {
  return {
    repositoryWorktreeRoot: repository.repositoryRealPath,
    gitCommonDirectory: repository.gitCommonDirectory,
  };
}

function recoveryAuthorityStateRoot(gitCommonDirectory: string): string {
  return path.join(
    gitCommonDirectory,
    'workflow-engine',
    'recovery-authority-state',
  );
}

function ensureRecoveryAuthorityStateRoot(gitCommonDirectory: string): string {
  const engineRoot = path.join(gitCommonDirectory, 'workflow-engine');
  ensurePrivateDirectory(gitCommonDirectory, engineRoot);
  const stateRoot = recoveryAuthorityStateRoot(gitCommonDirectory);
  ensurePrivateDirectory(engineRoot, stateRoot);
  return stateRoot;
}

function requireRecoveryAuthorityStateRoot(gitCommonDirectory: string): string {
  const stateRoot = recoveryAuthorityStateRoot(gitCommonDirectory);
  assertPrivateRecoveryDirectory(stateRoot);
  return stateRoot;
}

function ensurePrivateDirectory(parent: string, directory: string): void {
  assertExactDirectory(parent, false);
  if (path.dirname(directory) !== parent) throw recoveryExternalInputUnsafe();
  if (fs.lstatSync(directory, { throwIfNoEntry: false }) === undefined) {
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  assertPrivateRecoveryDirectory(directory);
}

function assertPrivateRecoveryDirectory(directory: string): void {
  assertExactDirectory(directory, true);
}

function assertExactDirectory(
  directory: string,
  requirePrivateMode: boolean,
): void {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  const currentUid = process.getuid?.();
  if (
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory ||
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    (requirePrivateMode && (stats.mode & 0o777) !== 0o700) ||
    (currentUid !== undefined && stats.uid !== currentUid) ||
    fs.realpathSync(directory) !== directory
  ) {
    throw recoveryExternalInputUnsafe();
  }
}

function readOptionalRecoveryQuarantineMarker(storageRoot: string) {
  if (fs.lstatSync(storageRoot, { throwIfNoEntry: false }) === undefined) {
    return null;
  }
  assertPrivateRecoveryDirectory(storageRoot);
  return readRecoveryQuarantineMarker(storageRoot);
}

function hasRecoveryOperationalTrustRootFence(storageRoot: string): boolean {
  if (fs.lstatSync(storageRoot, { throwIfNoEntry: false }) === undefined) {
    return false;
  }
  assertPrivateRecoveryDirectory(storageRoot);
  const allowed = new Set([
    'recovery-authority',
    'recovery-quarantine',
    'recovery-operational-trust-root',
  ]);
  let present = false;
  for (const entry of fs.readdirSync(storageRoot, { withFileTypes: true })) {
    if (!allowed.has(entry.name) || !entry.isDirectory()) {
      throw recoveryOperationalTrustStateUnsafe();
    }
    assertPrivateRecoveryDirectory(path.join(storageRoot, entry.name));
    if (entry.name === 'recovery-operational-trust-root') present = true;
  }
  return present;
}

function readExternalRecoveryExpectations(
  filePath: string,
  boundary: RecoveryAuthorityImportBoundary,
): RecoveryAuthorityExpectations {
  return readExternalRecoveryInput(
    filePath,
    boundary,
  ) as RecoveryAuthorityExpectations;
}

function readExternalRecoveryEnvelope(
  filePath: string,
  boundary: RecoveryAuthorityImportBoundary,
): RecoveryQuarantineEnvelope {
  const value = readExternalRecoveryInput(filePath, boundary);
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(['payload', 'signature']) ||
    !isRecord(value.payload) ||
    typeof value.payload.externalAuditRoot !== 'string' ||
    !isExactAbsolutePath(value.payload.externalAuditRoot) ||
    typeof value.signature !== 'string' ||
    value.signature.length === 0
  ) {
    throw recoveryExternalInputInvalid();
  }
  return value as unknown as RecoveryQuarantineEnvelope;
}

function readExternalRecoveryTrustRootAuditRoot(
  filePath: string,
  boundary: RecoveryAuthorityImportBoundary,
): string {
  const value = readExternalRecoveryInput(filePath, boundary);
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(['payload', 'replacement', 'signature']) ||
    !isRecord(value.payload) ||
    !isRecord(value.replacement) ||
    typeof value.payload.externalAuditRoot !== 'string' ||
    !isExactAbsolutePath(value.payload.externalAuditRoot) ||
    typeof value.signature !== 'string' ||
    value.signature.length === 0
  ) {
    throw workflowError(
      'RECOVERY_TRUST_ROOT_GRANT_INVALID',
      'Operational trust-root restore requires an exact external pre-signed canonical replacement bundle.',
      ExitCode.verification,
    );
  }
  return value.payload.externalAuditRoot;
}

function readExternalRecoveryInput(
  filePath: string,
  boundary: RecoveryAuthorityImportBoundary,
): unknown {
  if (
    !isExactAbsolutePath(filePath) ||
    pathIsWithin(boundary.repositoryWorktreeRoot, filePath) ||
    pathIsWithin(boundary.gitCommonDirectory, filePath)
  ) {
    throw recoveryExternalInputUnsafe();
  }
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  const currentUid = process.getuid?.();
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== 0o600 ||
    (currentUid !== undefined && before.uid !== currentUid) ||
    before.size < 1 ||
    before.size > 1024 * 1024 ||
    fs.realpathSync(filePath) !== filePath
  ) {
    throw recoveryExternalInputUnsafe();
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const openedBefore = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      !sameRecoveryInputSnapshot(before, openedBefore) ||
      !sameRecoveryInputSnapshot(openedBefore, openedAfter) ||
      !afterPath ||
      !sameRecoveryInputSnapshot(openedAfter, afterPath)
    ) {
      throw recoveryExternalInputUnsafe();
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.endsWith('\n')) throw recoveryExternalInputInvalid();
    const value = JSON.parse(text) as unknown;
    if (`${canonicalJson(value)}\n` !== text) {
      throw recoveryExternalInputInvalid();
    }
    return value;
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw recoveryExternalInputInvalid();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sameRecoveryInputSnapshot(left: fs.Stats, right: fs.Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative.length === 0 ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..')
  );
}

function isExactAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    path.isAbsolute(value) &&
    path.resolve(value) === value
  );
}

function recoveryExternalInputUnsafe(): WorkflowError {
  return workflowError(
    'RECOVERY_AUTHORITY_EXTERNAL_INPUT_UNSAFE',
    'Recovery Authority inputs must be exact private canonical files outside the repository and Git common directory.',
    ExitCode.unsafeEnvironment,
  );
}

function recoveryExternalInputInvalid(): WorkflowError {
  return workflowError(
    'RECOVERY_AUTHORITY_EXTERNAL_INPUT_INVALID',
    'Recovery Authority external input is not exact canonical JSON.',
    ExitCode.verification,
  );
}

function recoveryOperationalTrustStateUnsafe(): WorkflowError {
  return workflowError(
    'RECOVERY_OPERATIONAL_TRUST_STATE_UNSAFE',
    'Recovery Authority state contains an unknown or unsafe operational trust-root entry.',
    ExitCode.unsafeEnvironment,
  );
}

function dispatchSealedControlPlaneRecovery(
  args: readonly string[],
  cwd: string,
  overrides: HarnessBootstrapRuntimeOverrides,
): ControlPlaneRecoveryRollbackResult {
  if (
    args.length !== 3 ||
    args[0] !== 'control-plane' ||
    args[1] !== 'rollback' ||
    !isExactCliIdentifier(args[2])
  ) {
    throw workflowError(
      'HARNESS_RECOVERY_COMMAND_UNSUPPORTED',
      harnessBootstrapUsage(),
      ExitCode.usage,
    );
  }
  const repository = discoverRepository(cwd);
  const stateRoot = bootstrapInterventionStateRoot(
    repository.gitCommonDirectory,
  );
  const { dependencies, signer } = createHarnessRecoveryDependencies(
    cwd,
    repository.repositoryRoot,
    overrides,
  );
  const sourceControlPlaneGrantId = args[2];
  const existing = findPersistedControlPlaneRecoveryGrantForSource(
    stateRoot,
    sourceControlPlaneGrantId,
  );
  if (existing?.state === 'consumed') {
    throwControlPlaneRecoveryAlreadyConsumed();
  }
  let envelope: ControlPlaneRecoveryGrantEnvelope;
  if (
    existing?.state === 'reserved' ||
    existing?.state === 'completion-pending'
  ) {
    envelope = existing.envelope;
  } else {
    signer.assertHumanPresent();
    const issuedAt = (overrides.now?.() ?? new Date()).toISOString();
    const preflight = preflightControlPlaneRecoveryRollback(
      stateRoot,
      sourceControlPlaneGrantId,
      {
        humanSigner: signer.identity(),
        issuedAt,
      },
      dependencies,
    );
    (overrides.presentRecoverySummary ?? defaultRecoverySummaryPresenter)(
      preflight.summary,
    );
    envelope = {
      payload: preflight.payload,
      signature: signer.sign(
        canonicalControlPlaneRecoveryGrantPayload(preflight.payload),
        HARNESS_RECOVERY_SIGNATURE_NAMESPACE,
      ),
    };
  }
  return executeControlPlaneRecoveryRollback(stateRoot, envelope, dependencies);
}

function createHarnessRecoveryDependencies(
  cwd: string,
  repositoryRoot: string,
  overrides: HarnessBootstrapRuntimeOverrides,
): {
  dependencies: ControlPlaneRecoveryExecutorDependencies;
  signer: MaintainerSignerProvider;
} {
  const bootstrapDependencies = createHarnessBootstrapDependencies(cwd, {
    ...overrides,
    maintenanceSigner: overrides.recoverySigner ?? overrides.maintenanceSigner,
  });
  const signer =
    overrides.recoverySigner ?? bootstrapDependencies.maintenanceSigner;
  if (signer === undefined) {
    throw workflowError(
      'HARNESS_RECOVERY_SIGNER_REQUIRED',
      'Sealed recovery requires a controlling-terminal human signer.',
      ExitCode.unsafeEnvironment,
    );
  }
  const verifyHumanSignature = bootstrapDependencies.verifyHumanSignature;
  if (verifyHumanSignature === undefined) {
    throw workflowError(
      'HARNESS_RECOVERY_VERIFIER_REQUIRED',
      'Sealed recovery requires the trusted root signature verifier.',
      ExitCode.unsafeEnvironment,
    );
  }
  return {
    signer,
    dependencies: {
      now: overrides.now ?? (() => new Date()),
      consumedGrantIds: new Set<string>(),
      verifyHumanSignature,
      auditSink:
        overrides.controlPlaneAuditSink ??
        productionControlPlaneAuditSink(repositoryRoot),
      recoveryAuditSink:
        overrides.recoveryAuditSink ??
        productionRecoveryAuditSink(repositoryRoot),
    },
  };
}

function productionControlPlaneAuditSink(repositoryRoot: string) {
  return {
    append(record: ControlPlaneUpdaterAuditRecord): void {
      recordAuthorityAuditEvent(
        {
          externalAuditRoot: record.externalAuditRoot,
          repositoryRoot,
          repositoryId: deriveAuthorityAuditRepositoryId(record.repositoryId),
        },
        {
          eventType: controlPlaneAuditEventType(record),
          occurredAt: record.recordedAt,
          idempotencyKey: record.recordId,
          grantDigest: record.grantEnvelopeDigest,
          candidateBundleDigest: record.promotionBundleDigest,
          prestateDigest: null,
          poststateDigest: record.evidenceDigest,
          actor: { kind: 'engine', identity: 'sealed-control-plane-updater' },
          taskId: record.parentTaskId,
          changeId: record.changeId,
          workflowId: record.txId,
          command: {
            name: 'control-plane.recovery.rollback-source-transaction',
            argvDigest: record.recordDigest,
          },
          providerInvocation: null,
          externalEffect: null,
          result: controlPlaneAuditResult(record),
          outcomeDigest: record.recordDigest,
          errorCode: null,
        },
      );
    },
  };
}

function productionRecoveryAuditSink(repositoryRoot: string) {
  return {
    append(record: ControlPlaneRecoveryAuditRecord): void {
      recordAuthorityAuditEvent(
        {
          externalAuditRoot: record.externalAuditRoot,
          repositoryRoot,
          repositoryId: deriveAuthorityAuditRepositoryId(record.repositoryId),
        },
        {
          eventType:
            record.event === 'authorized' ||
            record.event === 'expired' ||
            record.event === 'failed'
              ? 'recovery'
              : record.event === 'rolled-back'
                ? 'rollback'
                : 'grant-consume',
          occurredAt: record.recordedAt,
          idempotencyKey: record.recordId,
          grantDigest: record.grantEnvelopeDigest,
          candidateBundleDigest: record.promotionBundleDigest,
          prestateDigest: record.prestateDigest,
          poststateDigest: record.poststateDigest,
          actor: {
            kind: record.event === 'authorized' ? 'human' : 'engine',
            identity:
              record.event === 'authorized'
                ? record.humanSigner
                : 'sealed-control-plane-recovery',
          },
          taskId: null,
          changeId: null,
          workflowId: record.sourceControlPlaneGrantId,
          command: {
            name: 'control-plane.recovery.rollback-control-plane',
            argvDigest: record.recordDigest,
          },
          providerInvocation: null,
          externalEffect: null,
          result:
            record.event === 'rolled-back'
              ? 'rolled-back'
              : record.event === 'consumed'
                ? 'succeeded'
                : record.event === 'expired' || record.event === 'failed'
                  ? 'failed'
                  : 'recorded',
          outcomeDigest: record.receiptDigest ?? record.recordDigest,
          errorCode: null,
        },
      );
    },
  };
}

function controlPlaneAuditEventType(
  record: ControlPlaneUpdaterAuditRecord,
): AuthorityAuditEventType {
  switch (record.event) {
    case 'prepared':
      return 'control-plane-grant';
    case 'switched':
      return 'cas';
    case 'rollback-required':
    case 'rolled-back':
      return 'rollback';
    case 'finalized':
      return 'grant-consume';
    default:
      return 'poststate';
  }
}

function controlPlaneAuditResult(
  record: ControlPlaneUpdaterAuditRecord,
): AuthorityAuditResult {
  return record.event === 'finalized'
    ? 'succeeded'
    : record.event === 'rolled-back'
      ? 'rolled-back'
      : 'recorded';
}

function defaultRecoverySummaryPresenter(
  summary: ControlPlaneRecoveryApprovalSummary,
): void {
  process.stderr.write(`\n${summary.humanReadable}\n\n`);
}

function harnessBootstrapUsage(): string {
  return [
    bootstrapInterventionUsage(),
    '  pnpm harness-bootstrap control-plane rollback <control-plane-grant-id> [--json]',
    '  pnpm harness-bootstrap recovery-authority import <external-descriptor.json> --expectations <external-expectations.json> [--json]',
    '  pnpm harness-bootstrap recovery-authority status --expectations <external-expectations.json> [--json]',
    '  pnpm harness-bootstrap recovery-authority restore-trust-root <external-pre-signed-envelope.json> --expectations <external-expectations.json> [--json]',
    '  pnpm harness-bootstrap recovery-quarantine enter <external-signed-envelope.json> --expectations <external-expectations.json> [--json]',
    '  pnpm harness-bootstrap recovery-quarantine release <external-signed-envelope.json> --expectations <external-expectations.json> [--json]',
  ].join('\n');
}

function isExactCliIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    value.trim() === value &&
    !value.startsWith('-') &&
    !value.includes('\0') &&
    !value.includes('\n') &&
    !value.includes('\r')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

export function createHarnessBootstrapDependencies(
  cwd: string,
  overrides: HarnessBootstrapRuntimeOverrides = {},
): BootstrapInterventionCliDependencies {
  let resolvedSigner = overrides.maintenanceSigner;
  const resolveSigner = (): MaintainerSignerProvider => {
    if (resolvedSigner === undefined) {
      const repository = discoverRepository(cwd);
      const policy = parseMaintainerPolicy(
        JSON.parse(
          runGit(repository.repositoryRoot, [
            'show',
            `${repository.head}:workflow/maintainer-policy.json`,
          ]),
        ),
      );
      resolvedSigner = createInteractiveSshSigner(
        repository.repositoryRoot,
        policy,
      );
    }
    return resolvedSigner;
  };
  return {
    now: overrides.now ?? (() => new Date()),
    maintenanceSigner: {
      assertHumanPresent: () => resolveSigner().assertHumanPresent(),
      identity: () => resolveSigner().identity(),
      sign: (payload, namespace) => resolveSigner().sign(payload, namespace),
      verify: (payload, signature, identity, namespace) =>
        resolveSigner().verify(payload, signature, identity, namespace),
    },
    presentMaintenanceSummary:
      overrides.presentMaintenanceSummary ??
      ((summary) => {
        process.stderr.write(`\n${summary.humanReadable}\n\n`);
      }),
    resolveParentDurableState: ({ parentChangeId, stateRoot }) =>
      resolveHarnessBootstrapParentState(cwd, parentChangeId, stateRoot),
    verifyHumanSignature(
      payload: string,
      signature: string,
      signerIdentity: string,
      namespace: string,
    ): boolean {
      if (overrides.verifyHumanSignature) {
        return overrides.verifyHumanSignature(
          payload,
          signature,
          signerIdentity,
          namespace,
        );
      }
      try {
        resolveSigner().verify(payload, signature, signerIdentity, namespace);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function resolveHarnessBootstrapParentState(
  cwd: string,
  parentChangeId: string,
  stateRoot: string,
): DurableInterventionParentState {
  const repository = discoverRepository(cwd);
  const config = loadWorkflowConfig(repository.repositoryRoot);
  const runtime = runtimePaths(
    repository.gitCommonDirectory,
    config.runtimeDirectory,
  );
  const candidates = listActiveWorkflowSessionIds(runtime)
    .map((sessionId) => ({
      sessionId,
      sessionPath: path.join(runtime.sessions, `${sessionId}.json`),
    }))
    .map((entry) => ({ ...entry, session: readSessionFile(entry.sessionPath) }))
    .filter(({ session }) => session.changeId === parentChangeId);
  if (candidates.length === 0) {
    throw workflowError(
      'HARNESS_BOOTSTRAP_PARENT_SESSION_NOT_FOUND',
      'No active durable workflow session exists for the requested parent change.',
      ExitCode.staleState,
    );
  }
  if (candidates.length !== 1) {
    throw workflowError(
      'HARNESS_BOOTSTRAP_PARENT_SESSION_AMBIGUOUS',
      'More than one active durable workflow session claims the parent change.',
      ExitCode.staleState,
    );
  }
  const { session } = candidates[0]!;
  const expectedBranch = `work/${parentChangeId}`;
  if (
    session.state !== 'active' ||
    session.repositoryRoot !== repository.repositoryRealPath ||
    session.gitCommonDirectory !== repository.gitCommonDirectory ||
    session.branch !== expectedBranch ||
    repository.branch !== expectedBranch ||
    session.baseline.head !== repository.head ||
    session.baseline.tree !== repository.tree
  ) {
    throw workflowError(
      'HARNESS_BOOTSTRAP_PARENT_SESSION_STALE',
      'Durable parent session identity, branch, or baseline differs from the current worktree.',
      ExitCode.staleState,
    );
  }

  const expectedStateRoot = path.join(runtime.root, 'intervention-control');
  if (stateRoot !== expectedStateRoot) {
    throw workflowError(
      'HARNESS_BOOTSTRAP_STATE_ROOT_MISMATCH',
      'Bootstrap dispatcher state root differs from the durable workflow runtime.',
      ExitCode.verification,
    );
  }
  const localBinding = readOptionalParentBinding(stateRoot, parentChangeId);
  let engineBinding: DurableInterventionParentState['parent']['engineBinding'] =
    BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST;
  let sessionSchema = `workflow-session.v${session.schemaVersion}`;
  if (localBinding !== null) {
    if (
      localBinding.parentChangeId !== parentChangeId ||
      localBinding.parentWorkspacePath !== repository.repositoryRealPath ||
      localBinding.parentBranch !== `refs/heads/${expectedBranch}` ||
      localBinding.interventionState !== 'adopted' ||
      localBinding.blocker !== null
    ) {
      throw workflowError(
        'HARNESS_BOOTSTRAP_PARENT_BINDING_CONFLICT',
        'Existing local engine binding is not a committed parent overlay.',
        ExitCode.staleState,
      );
    }
    engineBinding = localBinding.engineDigest;
    sessionSchema = localBinding.sessionSchema;
  } else {
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
    sessionSnapshotPath: persistTrustedBootstrapSessionSnapshot(
      stateRoot,
      session,
    ),
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

function readOptionalParentBinding(stateRoot: string, parentChangeId: string) {
  const identity = crypto
    .createHash('sha256')
    .update(`parent-session\0${parentChangeId}`)
    .digest('hex');
  const bindingPath = path.join(
    stateRoot,
    'local-parent-sessions',
    `${identity}.json`,
  );
  if (!fs.lstatSync(bindingPath, { throwIfNoEntry: false })) return null;
  return readLocalEngineBinding(bindingPath);
}

function readOptionalSupervisor(stateRoot: string) {
  try {
    return readControlPlaneSupervisorState(stateRoot);
  } catch (error) {
    if (
      error instanceof WorkflowError &&
      error.code === 'CONTROL_PLANE_SUPERVISOR_NOT_FOUND'
    ) {
      return null;
    }
    throw error;
  }
}

function digestCanonical(value: unknown): `sha256:${string}` {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}

const entryPath = process.argv[1];
if (
  entryPath &&
  import.meta.url === pathToFileURL(path.resolve(entryPath)).href
) {
  process.exitCode = runHarnessBootstrapCli(process.argv.slice(2));
}
