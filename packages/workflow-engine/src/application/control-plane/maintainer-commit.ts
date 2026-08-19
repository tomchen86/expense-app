import fs from 'node:fs';
import path from 'node:path';

import {
  deriveAuthorityAuditRepositoryId,
  scanAuthorityAuditLedger,
  type AuthorityAuditLedgerScope,
} from '../../runtime/storage-journal/authority-audit-ledger.ts';
import {
  authorityRefusalDigest,
  withAuthorityRefusalAudit,
} from '../../modules/authority/authority-refusal-audit.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  createSignedAuthorityCommitObject,
  previewExactStaging,
  resolveCommitIdentity,
  rollbackExactStaging,
  stageExactPaths,
  updateManagedRef,
} from '../../runtime/repository-transaction/git-transitions.ts';
import {
  armPostApprovalAdmissionDeadline,
  assertPostApprovalAdmissionDeadline,
  assertPostApprovalAdmissionPhase,
  createPostApprovalAdmissionDeadline,
  discoverRepository,
  enterPostApprovalCompletionObligation,
  enterPostApprovalTerminalCleanup,
  fingerprintWorkingState,
  isPostApprovalAdmissionFailure,
  listChangedPaths,
  runGit,
  withPostApprovalAdmissionDeadline,
  type PostApprovalBudgetTestOptions,
} from '../../runtime/repository-transaction/git.ts';
import {
  beginAuthorityCommitJournal,
  failAuthorityCommitBeforeCas,
  recordAuthorityCasPrepared,
  recordAuthorityCommitCreated,
  recordAuthorityRefUpdated,
  expireAuthorityCommitBeforeCas,
  readAuthorityCommitJournal,
  recoverAuthorityCommit,
  rollbackAuthorityCommitAfterCas,
  verifyCreatedAuthorityCommit,
  type AuthorityCommitResult,
} from './maintainer-recovery.ts';
import {
  acceptApplyPrestate,
  readDurableRefGenerationLedger,
  recordDurableRefGenerationTransitionUnderLifecycleLock,
} from '../../modules/authority/maintainer-candidate.ts';
import { readCurrentAuthorityCheckReport } from '../../runtime/storage-journal/maintainer-report.ts';
import {
  failAuthoritySession,
  inspectActiveAuthoritySession,
  readAuthoritySession,
  verifiedV2AuthorityLifecycleRefusalBinding,
  type AuthoritySession,
  type AuthoritySessionOptions,
} from './maintainer-session.ts';
import { maintainerGrantStorePaths } from '../../runtime/storage-journal/maintainer-store.ts';
import { createInteractiveSshSigner } from '../../adapters/signing/ssh/maintainer-signer.ts';
import { withRepositoryLifecycleOperation } from '../../runtime/session-workspace/session-store.ts';

export type AuthorityCommitOptions = AuthoritySessionOptions & {
  testCrashAfter?:
    'index-staged' | 'commit-created' | 'ref-cas' | 'ref-updated';
  clock?: () => Date;
  testBeforeRefUpdate?: () => void;
  testPoststateVerification?: () => void;
  testBeforeConsume?: () => void;
  testBeforeAudit?: (eventType: 'cas' | 'grant-consume') => void;
  /** Test-only deterministic seam; production always uses the code-owned cap. */
  testPostApprovalBudget?: PostApprovalBudgetTestOptions;
};

export class SimulatedAuthorityCrash extends Error {
  constructor(
    state: 'index-staged' | 'commit-created' | 'ref-cas' | 'ref-updated',
  ) {
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
  let deadline = options.postApprovalDeadline;
  try {
    if (deadline === undefined) {
      const session = readAuthoritySession(cwd, requestedSessionId);
      const journalPath = path.join(
        maintainerGrantStorePaths(session.gitCommonDirectory).journals,
        `${session.sessionId}.json`,
      );
      if (session.grantVersion === 1) {
        return commitAuthoritySessionWithDeadline(
          cwd,
          requestedSessionId,
          subject,
          options,
        );
      }
      deadline = createPostApprovalAdmissionDeadline(
        options.testPostApprovalBudget,
      );
      if (fs.existsSync(journalPath)) {
        const journal = readAuthorityCommitJournal(
          session.gitCommonDirectory,
          session.sessionId,
        );
        if (authorityJournalRequiresCompletion(journal.state)) {
          enterPostApprovalCompletionObligation(deadline, {
            allowExpired: true,
          });
        }
      }
      if (deadline.phase === 'unarmed') {
        armPostApprovalAdmissionDeadline(deadline);
      }
    }
    const phaseSession = readAuthoritySession(cwd, requestedSessionId);
    if (phaseSession.grantVersion === 2) {
      const phaseJournalPath = path.join(
        maintainerGrantStorePaths(phaseSession.gitCommonDirectory).journals,
        `${phaseSession.sessionId}.json`,
      );
      if (fs.existsSync(phaseJournalPath)) {
        const phaseJournal = readAuthorityCommitJournal(
          phaseSession.gitCommonDirectory,
          phaseSession.sessionId,
        );
        if (authorityJournalRequiresCompletion(phaseJournal.state)) {
          enterPostApprovalCompletionObligation(deadline, {
            allowExpired: true,
          });
        } else {
          assertPostApprovalAdmissionPhase(deadline);
        }
      } else {
        assertPostApprovalAdmissionPhase(deadline);
      }
    }
    if (deadline.phase === 'unarmed') {
      armPostApprovalAdmissionDeadline(deadline);
    }
    return withPostApprovalAdmissionDeadline(deadline, () =>
      commitAuthoritySessionWithDeadline(cwd, requestedSessionId, subject, {
        ...options,
        postApprovalDeadline: deadline,
      }),
    );
  } catch (error) {
    if (isPostApprovalAdmissionFailure(error)) {
      enterPostApprovalTerminalCleanup(deadline);
      const session = readAuthoritySession(cwd, requestedSessionId);
      const journalPath = path.join(
        maintainerGrantStorePaths(session.gitCommonDirectory).journals,
        `${session.sessionId}.json`,
      );
      if (fs.existsSync(journalPath)) {
        const journal = readAuthorityCommitJournal(
          session.gitCommonDirectory,
          session.sessionId,
        );
        if (
          journal.state === 'preparing' ||
          journal.state === 'commit-created'
        ) {
          failAuthorityCommitBeforeCas(
            cwd,
            requestedSessionId,
            error,
            operationNow(options),
          );
        }
      } else if (session.state === 'active') {
        failAuthoritySession(session, error, operationNow(options));
      }
    }
    throw error;
  }
}

function commitAuthoritySessionWithDeadline(
  cwd: string,
  requestedSessionId: string,
  subject: string,
  options: AuthorityCommitOptions,
): AuthorityCommitResult {
  const discovered = discoverRepository(cwd);
  const store = maintainerGrantStorePaths(discovered.gitCommonDirectory);
  const journalPath = path.join(store.journals, `${requestedSessionId}.json`);
  if (fs.existsSync(journalPath)) {
    return recoverAuthorityCommit(cwd, requestedSessionId, options.now, {
      testBeforeConsume: options.testBeforeConsume,
      testBeforeAudit: options.testBeforeAudit,
      receiptSigner: options.signer,
      postApprovalDeadline: options.postApprovalDeadline,
    });
  }

  let inspection: ReturnType<typeof inspectActiveAuthoritySession>;
  try {
    inspection = inspectActiveAuthoritySession(cwd, requestedSessionId, {
      ...options,
      now: operationNow(options),
    });
  } catch (error) {
    if (isPostApprovalAdmissionFailure(error)) {
      enterPostApprovalTerminalCleanup(options.postApprovalDeadline);
    }
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
    const stagedProjection: {
      current: {
        repositoryRoot: string;
        previousIndexTree: string;
        workflowTree: string;
      } | null;
    } = { current: null };
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
      assertPostApprovalAdmissionDeadline(options.postApprovalDeadline);

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
          let staged: ReturnType<typeof stageExactPaths>;
          let journal: ReturnType<typeof beginAuthorityCommitJournal>;
          if (current.session.grantVersion === 2) {
            const preview = previewExactStaging(
              current.git.repositoryRoot,
              current.session.baseCommit,
              changedPaths,
            );
            if (
              current.session.resultTree === null ||
              current.session.resultTree !== preview.tree
            ) {
              throw commitError(
                'AUTHORITY_CANDIDATE_TREE_MISMATCH',
                'The prospective tree differs from the immutable candidate result tree.',
              );
            }
            assertPostApprovalAdmissionDeadline(options.postApprovalDeadline);
            journal = beginAuthorityCommitJournal(current.session, {
              expectedTree: preview.tree,
              previousIndexTree: preview.previousIndexTree,
              changedPaths,
              subject,
              now: exactDate(options.now ?? new Date()),
              auditScope,
            });
            journalCreated = true;
            staged = stageExactPaths(
              current.git.repositoryRoot,
              current.session.baseCommit,
              changedPaths,
              {
                expectedTree: preview.tree,
                expectedPreviousIndexTree: preview.previousIndexTree,
              },
            );
            stagedProjection.current = {
              repositoryRoot: current.git.repositoryRoot,
              previousIndexTree: staged.previousIndexTree,
              workflowTree: staged.tree,
            };
            if (options.testCrashAfter === 'index-staged') {
              throw new SimulatedAuthorityCrash('index-staged');
            }
          } else {
            staged = stageExactPaths(
              current.git.repositoryRoot,
              current.session.baseCommit,
              changedPaths,
            );
            stagedProjection.current = {
              repositoryRoot: current.git.repositoryRoot,
              previousIndexTree: staged.previousIndexTree,
              workflowTree: staged.tree,
            };
            assertPostApprovalAdmissionDeadline(options.postApprovalDeadline);
            journal = beginAuthorityCommitJournal(current.session, {
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
          assertPostApprovalAdmissionDeadline(options.postApprovalDeadline);
          journal = recordAuthorityCasPrepared(
            current.session.gitCommonDirectory,
            journal,
            casTime,
          );
          enterPostApprovalCompletionObligation(options.postApprovalDeadline, {
            allowExpired: true,
          });
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
        postApprovalDeadline: options.postApprovalDeadline,
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
      if (isPostApprovalAdmissionFailure(error)) {
        enterPostApprovalTerminalCleanup(options.postApprovalDeadline);
        if (journalCreated) {
          const observed = readAuthorityCommitJournal(
            inspection.session.gitCommonDirectory,
            inspection.session.sessionId,
          );
          if (
            observed.state === 'preparing' ||
            observed.state === 'commit-created'
          ) {
            failAuthorityCommitBeforeCas(
              cwd,
              requestedSessionId,
              error,
              operationNow(options),
            );
          }
        } else {
          failAuthoritySession(
            inspection.session,
            error,
            operationNow(options),
          );
          const staged = stagedProjection.current;
          if (staged !== null) {
            try {
              rollbackExactStaging(
                staged.repositoryRoot,
                staged.previousIndexTree,
                staged.workflowTree,
                error,
              );
            } catch {
              // A foreign index is never overwritten during denial cleanup.
              // The failed grant remains the durable authority boundary.
            }
          }
        }
        throw error;
      }
      if (journalCreated) {
        try {
          return recoverAuthorityCommit(cwd, requestedSessionId, options.now, {
            testBeforeConsume: options.testBeforeConsume,
            testBeforeAudit: options.testBeforeAudit,
            receiptSigner: signer,
            postApprovalDeadline: options.postApprovalDeadline,
          });
        } catch (recoveryError) {
          if (isPostApprovalAdmissionFailure(recoveryError)) {
            throw recoveryError;
          }
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

function authorityJournalRequiresCompletion(
  state: ReturnType<typeof readAuthorityCommitJournal>['state'],
): boolean {
  return (
    state === 'cas-prepared' ||
    state === 'ref-updated' ||
    state === 'rollback-prepared' ||
    state === 'rolled-back' ||
    state === 'consumed' ||
    state === 'audited'
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
