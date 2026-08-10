import fs from 'node:fs';
import path from 'node:path';

import {
  deriveAuthorityAuditRepositoryId,
  scanAuthorityAuditLedger,
  type AuthorityAuditLedgerScope,
} from './authority-audit-ledger.ts';
import {
  authorityRefusalDigest,
  withAuthorityRefusalAudit,
} from './authority-refusal-audit.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  createSignedAuthorityCommitObject,
  resolveCommitIdentity,
  stageExactPaths,
  updateManagedRef,
} from './git-transitions.ts';
import {
  discoverRepository,
  fingerprintWorkingState,
  listChangedPaths,
  runGit,
} from './git.ts';
import {
  beginAuthorityCommitJournal,
  recordAuthorityCasPrepared,
  recordAuthorityCommitCreated,
  recordAuthorityRefUpdated,
  expireAuthorityCommitBeforeCas,
  recoverAuthorityCommit,
  rollbackAuthorityCommitAfterCas,
  verifyCreatedAuthorityCommit,
  type AuthorityCommitResult,
} from './maintainer-recovery.ts';
import {
  acceptApplyPrestate,
  readDurableRefGenerationLedger,
  recordDurableRefGenerationTransitionUnderLifecycleLock,
} from './maintainer-candidate.ts';
import { readCurrentAuthorityCheckReport } from './maintainer-report.ts';
import {
  failAuthoritySession,
  inspectActiveAuthoritySession,
  readAuthoritySession,
  verifiedV2AuthorityLifecycleRefusalBinding,
  type AuthoritySession,
  type AuthoritySessionOptions,
} from './maintainer-session.ts';
import { maintainerGrantStorePaths } from './maintainer-store.ts';
import { createInteractiveSshSigner } from './maintainer-signer.ts';
import { withRepositoryLifecycleOperation } from './session-store.ts';

export type AuthorityCommitOptions = AuthoritySessionOptions & {
  testCrashAfter?: 'commit-created' | 'ref-cas' | 'ref-updated';
  clock?: () => Date;
  testBeforeRefUpdate?: () => void;
  testPoststateVerification?: () => void;
  testBeforeConsume?: () => void;
  testBeforeAudit?: (eventType: 'cas' | 'grant-consume') => void;
};

export class SimulatedAuthorityCrash extends Error {
  constructor(state: 'commit-created' | 'ref-cas' | 'ref-updated') {
    super(`Simulated authority crash after ${state}.`);
    this.name = 'SimulatedAuthorityCrash';
  }
}

class AuthorityGrantExpiredBeforeCas extends Error {
  readonly observedAt: Date;

  constructor(observedAt: Date) {
    super('The authority grant expired before the protected ref CAS.');
    this.name = 'AuthorityGrantExpiredBeforeCas';
    this.observedAt = observedAt;
  }
}

class AuthorityPoststateVerificationFailed extends Error {
  readonly observedAt: Date;

  constructor(observedAt: Date, message: string) {
    super(message);
    this.name = 'AuthorityPoststateVerificationFailed';
    this.observedAt = observedAt;
  }
}

export function commitAuthoritySession(
  cwd: string,
  requestedSessionId: string,
  subject: string,
  options: AuthorityCommitOptions = {},
): AuthorityCommitResult {
  const discovered = discoverRepository(cwd);
  const store = maintainerGrantStorePaths(discovered.gitCommonDirectory);
  const journalPath = path.join(store.journals, `${requestedSessionId}.json`);
  if (fs.existsSync(journalPath)) {
    return recoverAuthorityCommit(cwd, requestedSessionId, options.now, {
      testBeforeConsume: options.testBeforeConsume,
      testBeforeAudit: options.testBeforeAudit,
      receiptSigner: options.signer,
    });
  }

  let inspection: ReturnType<typeof inspectActiveAuthoritySession>;
  try {
    inspection = inspectActiveAuthoritySession(cwd, requestedSessionId, {
      ...options,
      now: operationNow(options),
    });
  } catch (error) {
    const session = readAuthoritySession(cwd, requestedSessionId);
    if (session.state === 'active') {
      failAuthoritySession(session, error, operationNow(options));
    }
    throw error;
  }
  const auditScope = prepareAuthorityAuditScope(
    inspection.session,
    inspection.envelope.payload.repositoryId,
  );
  const executeCommit = (): AuthorityCommitResult => {
    const signer =
      options.signer ??
      createInteractiveSshSigner(
        inspection.git.repositoryRoot,
        inspection.policy,
      );
    let journalCreated = false;
    try {
      signer.assertHumanPresent();
      if (signer.identity() !== inspection.session.signer) {
        throw commitError(
          'AUTHORITY_COMMIT_SIGNER_MISMATCH',
          'The human-present signer differs from the signed grant.',
        );
      }
      assertGitSigningConfiguration(inspection.git.repositoryRoot);
      // Preflight the commit identity before any journal or index mutation so
      // a missing local user.name/user.email fails while the session is still
      // fully recoverable instead of surfacing later as an opaque rollback.
      resolveCommitIdentity(
        inspection.git.repositoryRoot,
        options.environment ?? process.env,
      );

      const result = withRepositoryLifecycleOperation(
        store.runtime,
        (assertOwned) => {
          assertOwned();
          const current = inspectActiveAuthoritySession(
            cwd,
            requestedSessionId,
            {
              ...options,
              now: operationNow(options),
              lifecycleAssertOwned: assertOwned,
            },
          );
          if (
            JSON.stringify(current.session) !==
            JSON.stringify(inspection.session)
          ) {
            throw commitError(
              'AUTHORITY_SESSION_CHANGED',
              'Authority session changed before commit creation.',
            );
          }
          const targetRef = `refs/heads/${current.session.branch}`;
          if (current.session.expectedRefGeneration !== null) {
            const ledger = readDurableRefGenerationLedger(
              current.session.gitCommonDirectory,
              targetRef,
              true,
            );
            acceptApplyPrestate(
              ledger,
              current.session.baseCommit,
              current.session.expectedRefGeneration,
            );
          }
          const changedPaths = listChangedPaths(
            current.git.repositoryRoot,
            current.session.baseCommit,
          );
          if (
            changedPaths.length === 0 ||
            changedPaths.some(
              (filePath) => !current.session.allowedPaths.includes(filePath),
            )
          ) {
            throw commitError(
              'AUTHORITY_COMMIT_SCOPE_INVALID',
              'Authority commit requires at least one change and only exact grant paths.',
            );
          }
          const fingerprint = fingerprintWorkingState(
            current.git.repositoryRoot,
            current.git.head,
            current.git.statusEntries,
          );
          readCurrentAuthorityCheckReport(
            store.runtime.reports,
            current.session,
            changedPaths,
            fingerprint,
          );
          const staged = stageExactPaths(
            current.git.repositoryRoot,
            current.session.baseCommit,
            changedPaths,
          );
          let journal = beginAuthorityCommitJournal(current.session, {
            expectedTree: staged.tree,
            previousIndexTree: staged.previousIndexTree,
            changedPaths,
            subject,
            now: exactDate(options.now ?? new Date()),
            auditScope,
          });
          journalCreated = true;
          if (
            current.session.resultTree !== null &&
            current.session.resultTree !== staged.tree
          ) {
            throw commitError(
              'AUTHORITY_CANDIDATE_TREE_MISMATCH',
              'The staged tree differs from the immutable candidate result tree.',
            );
          }
          const commitHash =
            current.session.candidateCommit ??
            createSignedAuthorityCommitObject(
              current.git.repositoryRoot,
              staged.tree,
              current.session.baseCommit,
              subject,
              current.session.changeId,
              current.session.grantId,
              options.environment,
            );
          journal = recordAuthorityCommitCreated(
            current.session.gitCommonDirectory,
            journal,
            commitHash,
            exactDate(options.now ?? new Date()),
          );
          verifyCreatedAuthorityCommit(cwd, current.session, journal);
          if (options.testCrashAfter === 'commit-created') {
            throw new SimulatedAuthorityCrash('commit-created');
          }
          options.testBeforeRefUpdate?.();
          const casTime = operationNow(options);
          if (
            Date.parse(current.envelope.payload.expiresAt) <= casTime.getTime()
          ) {
            throw new AuthorityGrantExpiredBeforeCas(casTime);
          }
          journal = recordAuthorityCasPrepared(
            current.session.gitCommonDirectory,
            journal,
            casTime,
          );
          updateManagedRef(
            current.git.repositoryRoot,
            current.session.baseCommit,
            commitHash,
            targetRef,
          );
          if (options.testCrashAfter === 'ref-cas') {
            throw new SimulatedAuthorityCrash('ref-cas');
          }
          if (current.session.expectedRefGeneration !== null) {
            recordDurableRefGenerationTransitionUnderLifecycleLock(
              current.session.gitCommonDirectory,
              {
                ref: targetRef,
                expectedOid: current.session.baseCommit,
                expectedGeneration: current.session.expectedRefGeneration,
                nextOid: commitHash,
                reason: 'apply',
                at: casTime.toISOString(),
              },
              assertOwned,
            );
          }
          journal = recordAuthorityRefUpdated(
            current.session.gitCommonDirectory,
            journal,
            casTime,
          );
          if (options.testCrashAfter === 'ref-updated') {
            throw new SimulatedAuthorityCrash('ref-updated');
          }
          try {
            assertAppliedPoststate(
              current.git.repositoryRoot,
              targetRef,
              commitHash,
              staged.tree,
            );
            options.testPoststateVerification?.();
          } catch (error) {
            throw new AuthorityPoststateVerificationFailed(
              casTime,
              error instanceof Error
                ? error.message
                : 'Authority poststate verification failed.',
            );
          }
          return { commitHash, journal };
        },
        { allowMaintainerGrantId: inspection.session.grantId },
      );
      if (!result.commitHash) {
        throw commitError(
          'AUTHORITY_COMMIT_INVALID',
          'Authority commit transaction did not create a commit.',
        );
      }
      return recoverAuthorityCommit(cwd, requestedSessionId, options.now, {
        testBeforeConsume: options.testBeforeConsume,
        testBeforeAudit: options.testBeforeAudit,
        receiptSigner: signer,
      });
    } catch (error) {
      if (error instanceof SimulatedAuthorityCrash) {
        throw error;
      }
      if (error instanceof AuthorityGrantExpiredBeforeCas) {
        expireAuthorityCommitBeforeCas(
          cwd,
          requestedSessionId,
          error.observedAt,
        );
        throw workflowError(
          'AUTHORITY_GRANT_EXPIRED_BEFORE_CAS',
          error.message,
          ExitCode.staleState,
        );
      }
      if (error instanceof AuthorityPoststateVerificationFailed) {
        rollbackAuthorityCommitAfterCas(
          cwd,
          requestedSessionId,
          error.message,
          error.observedAt,
        );
        throw workflowError(
          'AUTHORITY_POSTSTATE_VERIFICATION_FAILED',
          error.message,
          ExitCode.verification,
        );
      }
      if (journalCreated) {
        try {
          return recoverAuthorityCommit(cwd, requestedSessionId, options.now, {
            testBeforeConsume: options.testBeforeConsume,
            testBeforeAudit: options.testBeforeAudit,
            receiptSigner: signer,
          });
        } catch {
          // Recovery rolled the transaction back (or refused); the actionable
          // root cause is the original commit failure, not the recovery
          // wrapper, so surface the original error.
          throw error;
        }
      }
      // Failures before the journal exists left the repository untouched.
      // Environment preconditions (terminal, signing config, identity) and
      // retryable staging preconditions (scope, changed session, stale check
      // report) keep the session active so the maintainer can repair the
      // environment and retry without re-signing.
      if (isRecoverableCommitPrecondition(error)) {
        throw error;
      }
      failAuthoritySession(inspection.session, error, options.now);
      throw error;
    }
  };
  if (auditScope === null) return executeCommit();
  return withAuthorityRefusalAudit(
    verifiedV2AuthorityLifecycleRefusalBinding(
      inspection.git.repositoryRealPath,
      inspection.envelope,
      {
        operation: 'authority.commit',
        subjectId: inspection.session.sessionId,
        bindingEvidence: {
          auditScope,
          session: inspection.session,
        },
        refusalIdentity: {
          sessionId: inspection.session.sessionId,
          subjectDigest: authorityRefusalDigest(subject),
          workingStateDigest: authorityRefusalDigest({
            head: inspection.git.head,
            statusEntries: inspection.git.statusEntries,
          }),
        },
      },
    ),
    {
      now: options.now,
      serviceHooks: options.testRefusalAuditServiceHooks,
    },
    executeCommit,
  );
}

function operationNow(options: AuthorityCommitOptions): Date {
  return exactDate(options.clock?.() ?? options.now ?? new Date());
}

function prepareAuthorityAuditScope(
  session: AuthoritySession,
  repositoryIdentity: string,
): AuthorityAuditLedgerScope | null {
  if (session.grantVersion === 1) return null;
  if (session.mandateBinding === null) {
    throw workflowError(
      'AUTHORITY_TASK_MANDATE_BINDING_REQUIRED',
      'Maintainer grant v2 requires its durable Task Mandate binding.',
      ExitCode.guard,
    );
  }
  const scope: AuthorityAuditLedgerScope = {
    externalAuditRoot: session.mandateBinding.externalAuditRoot,
    repositoryRoot: session.repositoryRoot,
    repositoryId: deriveAuthorityAuditRepositoryId(repositoryIdentity),
  };
  scanAuthorityAuditLedger(scope);
  return scope;
}

function assertAppliedPoststate(
  repositoryRoot: string,
  targetRef: string,
  commitHash: string,
  expectedTree: string,
): void {
  const observedCommit = runGit(repositoryRoot, [
    'rev-parse',
    '--verify',
    targetRef,
  ]).trim();
  const observedTree = runGit(repositoryRoot, [
    'rev-parse',
    '--verify',
    `${commitHash}^{tree}`,
  ]).trim();
  if (observedCommit !== commitHash || observedTree !== expectedTree) {
    throw new Error(
      'The protected ref or committed tree differs from the verified candidate.',
    );
  }
}

const RECOVERABLE_COMMIT_PRECONDITIONS = new Set([
  'MAINTAINER_INTERACTIVE_REQUIRED',
  'AUTHORITY_GIT_SIGNING_REQUIRED',
  'COMMIT_IDENTITY_REQUIRED',
  'AUTHORITY_COMMIT_SCOPE_INVALID',
  'AUTHORITY_SESSION_CHANGED',
]);

function isRecoverableCommitPrecondition(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code: unknown }).code
      : undefined;
  return typeof code === 'string' && RECOVERABLE_COMMIT_PRECONDITIONS.has(code);
}

function assertGitSigningConfiguration(repositoryRoot: string): void {
  const format = runGit(
    repositoryRoot,
    ['config', '--local', '--get', 'gpg.format'],
    true,
  ).trim();
  const key = runGit(
    repositoryRoot,
    ['config', '--local', '--get', 'user.signingkey'],
    true,
  ).trim();
  if (format !== 'ssh' || !key) {
    throw workflowError(
      'AUTHORITY_GIT_SIGNING_REQUIRED',
      'Authority commit requires local gpg.format=ssh and user.signingkey configuration.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function exactDate(value: Date): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw commitError(
      'AUTHORITY_COMMIT_TIME_INVALID',
      'Authority commit requires an exact timestamp.',
    );
  }
  return date;
}

function commitError(code: string, message: string) {
  return workflowError(code, message, ExitCode.staleState);
}
