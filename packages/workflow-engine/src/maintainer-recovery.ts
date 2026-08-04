import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  authorityAuditLedgerPaths,
  scanAuthorityAuditLedger,
  type AuthorityAuditAppendInput,
  type AuthorityAuditEventType,
  type AuthorityAuditLedgerEntry,
  type AuthorityAuditLedgerScope,
  type Sha256Digest,
} from './authority-audit-ledger.ts';
import {
  authorityAuditAppendInputForEvent,
  buildAuthorityAuditEvent,
  recordAuthorityAuditEvent,
  verifyAuthorityAuditEvents,
  type AuthorityAuditEventInput,
} from './authority-audit-service.ts';
import {
  authorityApplicationReceiptTagRef,
  createAuthorityApplicationReceiptPayload,
  publishAuthorityApplicationReceipt,
  signedGrantEnvelopeDigest,
} from './authority-application-receipt.ts';
import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  authorityCandidateCommitMessage,
  authorityCommitMessage,
  commitChangedPaths,
  commitFacts,
  rollbackExactStaging,
  updateManagedRef,
} from './git-transitions.ts';
import { discoverRepository, runGit } from './git.ts';
import {
  canonicalMaintainerGrantV2Envelope,
  isMaintainerGrantV2Envelope,
} from './maintainer-grant-v2.ts';
import { parseMaintainerPolicy } from './maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from './maintainer-signer.ts';
import {
  failAuthoritySession,
  markAuthoritySessionCommitted,
  readAuthoritySession,
  type AuthoritySession,
} from './maintainer-session.ts';
import {
  acceptApplyPrestate,
  readDurableRefGenerationLedger,
  recordDurableRefGenerationTransitionUnderLifecycleLock,
} from './maintainer-candidate.ts';
import {
  consumeMaintainerReservationUnderLifecycleLock,
  inspectMaintainerGrants,
  maintainerGrantStorePaths,
  readTerminalMaintainerGrant,
  terminallyExpireMaintainerReservationUnderLifecycleLock,
  terminallyFailMaintainerReservationUnderLifecycleLock,
  terminallyInvalidateMaintainerReservationUnderLifecycleLock,
} from './maintainer-store.ts';
import { parseManagedTrailers } from './managed-trailers.ts';
import { assertSessionId } from './paths.ts';
import { withRepositoryLifecycleOperation } from './session-store.ts';
import {
  assertActiveTaskMandateBindingUnderLifecycleLock,
  type TaskMandateBinding,
} from './task-mandate.ts';

export type AuthorityCommitJournalState =
  | 'preparing'
  | 'commit-created'
  | 'cas-prepared'
  | 'ref-updated'
  | 'rollback-prepared'
  | 'rolled-back'
  | 'consumed'
  | 'audited'
  | 'revoked';

export type AuthorityCommitJournal = {
  schemaVersion: 4;
  state: AuthorityCommitJournalState;
  sessionId: string;
  grantId: string;
  changeId: string;
  repositoryRoot: string;
  branch: string;
  baseCommit: string;
  expectedTree: string;
  previousIndexTree: string;
  allowedPaths: string[];
  subject: string;
  messageDigest: string;
  policyBlob: string;
  signer: string;
  mandateBinding: TaskMandateBinding | null;
  commitHash: string | null;
  externalAuditRoot: string | null;
  auditRepositoryId: Sha256Digest | null;
  casAuditRecordDigest: Sha256Digest | null;
  poststateAuditRecordDigest: Sha256Digest | null;
  consumeAuditRecordDigest: Sha256Digest | null;
  errorAuditRecordDigest: Sha256Digest | null;
  rollbackAuditRecordDigest: Sha256Digest | null;
  refUpdatedAt: string | null;
  poststateVerifiedAt: string | null;
  consumedAt: string | null;
  rollbackStartedAt: string | null;
  rolledBackAt: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AuthorityCommitResult = {
  session: AuthoritySession;
  grantId: string;
  commitHash: string;
  changedPaths: string[];
  journalState: 'consumed' | 'audited';
};

export type AuthorityRecoveryOptions = {
  testBeforeConsume?: () => void;
  testBeforeAudit?: (eventType: 'cas' | 'grant-consume') => void;
  receiptSigner?: MaintainerSignerProvider;
};

export function beginAuthorityCommitJournal(
  session: AuthoritySession,
  input: {
    expectedTree: string;
    previousIndexTree: string;
    changedPaths: string[];
    subject: string;
    now: Date;
    auditScope?: AuthorityAuditLedgerScope | null;
  },
): AuthorityCommitJournal {
  const timestamp = exactDate(input.now).toISOString();
  const auditScope = input.auditScope ?? null;
  if (
    (session.grantVersion === 2 && auditScope === null) ||
    (session.grantVersion === 1 && auditScope !== null) ||
    (session.grantVersion === 2 && session.mandateBinding === null) ||
    (session.grantVersion === 1 && session.mandateBinding !== null) ||
    (auditScope !== null &&
      (auditScope.repositoryRoot !== session.repositoryRoot ||
        auditScope.externalAuditRoot !==
          session.mandateBinding?.externalAuditRoot))
  ) {
    throw recoveryError(
      'AUTHORITY_AUDIT_SCOPE_MISMATCH',
      'Authority audit scope does not match the pinned grant and repository.',
    );
  }
  if (auditScope !== null) authorityAuditLedgerPaths(auditScope);
  const journal: AuthorityCommitJournal = {
    schemaVersion: 4,
    state: 'preparing',
    sessionId: session.sessionId,
    grantId: session.grantId,
    changeId: session.changeId,
    repositoryRoot: session.repositoryRoot,
    branch: session.branch,
    baseCommit: session.baseCommit,
    expectedTree: assertObjectId(input.expectedTree),
    previousIndexTree: assertObjectId(input.previousIndexTree),
    allowedPaths: [...input.changedPaths],
    subject: input.subject,
    messageDigest: digest(
      `${expectedAuthorityMessage(session, input.subject)}\n`,
    ),
    policyBlob: assertObjectId(session.policyBlob),
    signer: session.signer,
    mandateBinding: session.mandateBinding,
    commitHash: null,
    externalAuditRoot: auditScope?.externalAuditRoot ?? null,
    auditRepositoryId: auditScope?.repositoryId ?? null,
    casAuditRecordDigest: null,
    poststateAuditRecordDigest: null,
    consumeAuditRecordDigest: null,
    errorAuditRecordDigest: null,
    rollbackAuditRecordDigest: null,
    refUpdatedAt: null,
    poststateVerifiedAt: null,
    consumedAt: null,
    rollbackStartedAt: null,
    rolledBackAt: null,
    reason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  writeJournal(session.gitCommonDirectory, journal, true);
  return journal;
}

export function recordAuthorityCommitCreated(
  gitCommonDirectory: string,
  journal: AuthorityCommitJournal,
  commitHash: string,
  now: Date,
): AuthorityCommitJournal {
  return transitionJournal(gitCommonDirectory, journal, 'preparing', {
    state: 'commit-created',
    commitHash: assertObjectId(commitHash),
    updatedAt: exactDate(now).toISOString(),
  });
}

export function recordAuthorityRefUpdated(
  gitCommonDirectory: string,
  journal: AuthorityCommitJournal,
  now: Date,
): AuthorityCommitJournal {
  return transitionJournal(gitCommonDirectory, journal, 'cas-prepared', {
    state: 'ref-updated',
    refUpdatedAt: exactDate(now).toISOString(),
    updatedAt: exactDate(now).toISOString(),
  });
}

export function recordAuthorityCasPrepared(
  gitCommonDirectory: string,
  journal: AuthorityCommitJournal,
  now: Date,
): AuthorityCommitJournal {
  return transitionJournal(gitCommonDirectory, journal, 'commit-created', {
    state: 'cas-prepared',
    updatedAt: exactDate(now).toISOString(),
  });
}

export function recoverAuthorityCommit(
  cwd: string,
  requestedSessionId: string,
  now = new Date(),
  options: AuthorityRecoveryOptions = {},
): AuthorityCommitResult {
  const session = readAuthoritySession(cwd, requestedSessionId);
  const journal = readAuthorityCommitJournal(
    session.gitCommonDirectory,
    session.sessionId,
  );
  assertJournalMatchesSession(journal, session);
  const auditScope = authorityAuditScopeForJournal(session, journal);

  if (
    journal.state === 'rollback-prepared' ||
    journal.state === 'rolled-back'
  ) {
    rollbackAuthorityCommitAfterCas(
      cwd,
      session.sessionId,
      journal.reason ?? 'Resume journaled poststate rollback',
      now,
    );
    throw recoveryError(
      'AUTHORITY_RECOVERY_ROLLED_BACK',
      'The failed authority apply was rolled back during recovery.',
    );
  }

  const grantState = inspectMaintainerGrants(
    session.gitCommonDirectory,
    session.grantId,
  )[0];
  if (
    journal.state !== 'cas-prepared' &&
    (grantState?.state === 'expired' ||
      (grantState?.state === 'reserved' &&
        Date.parse(grantState.expiresAt) <= exactDate(now).getTime() &&
        discoverRepository(cwd).head === journal.baseCommit))
  ) {
    expireAuthorityCommitBeforeCas(cwd, session.sessionId, now);
    throw recoveryError(
      'AUTHORITY_GRANT_EXPIRED_BEFORE_CAS',
      'The authority grant expired before the protected ref was updated.',
    );
  }

  if (journal.state === 'revoked') {
    throw recoveryError(
      'AUTHORITY_RECOVERY_REVOKED',
      'The authority transaction was terminally revoked.',
    );
  }
  if (journal.state === 'preparing') {
    revokePreparingTransaction(cwd, session, journal, now);
  }

  try {
    return withRepositoryLifecycleOperation(
      maintainerGrantStorePaths(session.gitCommonDirectory).runtime,
      (assertOwned) => {
        assertOwned();
        const currentSession = readAuthoritySession(cwd, session.sessionId);
        assertJournalMatchesSession(journal, currentSession);
        const currentJournal = readAuthorityCommitJournal(
          session.gitCommonDirectory,
          session.sessionId,
        );
        if (currentJournal.state === 'audited') {
          return finalizeAudited(
            cwd,
            currentSession,
            currentJournal,
            auditScope,
            now,
            options,
          );
        }
        if (currentJournal.state === 'consumed') {
          return finalizeConsumed(
            cwd,
            currentSession,
            currentJournal,
            auditScope,
            now,
            options,
          );
        }
        if (
          currentJournal.state !== 'commit-created' &&
          currentJournal.state !== 'cas-prepared' &&
          currentJournal.state !== 'ref-updated'
        ) {
          throw recoveryError(
            'AUTHORITY_JOURNAL_DIVERGED',
            'Authority journal state changed during recovery.',
          );
        }
        const commitHash = requireCommitHash(currentJournal);
        verifyJournaledCommit(cwd, currentSession, currentJournal, commitHash);
        const git = discoverRepository(cwd);
        const indexTree = runGit(git.repositoryRoot, ['write-tree']).trim();
        if (indexTree !== currentJournal.expectedTree) {
          throw recoveryError(
            'AUTHORITY_RECOVERY_INDEX_DIVERGED',
            'The Git index differs from the journaled authority tree.',
          );
        }
        let advanced = currentJournal;
        const targetRef = `refs/heads/${currentSession.branch}`;
        const expectedGeneration = currentSession.expectedRefGeneration;
        if (git.head === currentJournal.baseCommit) {
          if (currentSession.mandateBinding === null) {
            throw recoveryError(
              'AUTHORITY_TASK_MANDATE_BINDING_REQUIRED',
              'Pre-CAS recovery requires the durable Task Mandate binding.',
            );
          }
          assertActiveTaskMandateBindingUnderLifecycleLock(
            cwd,
            currentSession.mandateBinding,
            assertOwned,
            { now, signer: options.receiptSigner },
          );
          if (currentJournal.state === 'cas-prepared') {
            rejectAmbiguousAuthorityCas(
              git.repositoryRoot,
              currentSession,
              currentJournal,
              indexTree,
              now,
              assertOwned,
            );
          }
          if (currentJournal.state !== 'commit-created') {
            throw recoveryError(
              'AUTHORITY_RECOVERY_REF_DIVERGED',
              'The ref-updated journal no longer points to its candidate.',
            );
          }
          if (expectedGeneration !== null) {
            acceptApplyPrestate(
              readDurableRefGenerationLedger(
                currentSession.gitCommonDirectory,
                targetRef,
                true,
              ),
              currentJournal.baseCommit,
              expectedGeneration,
            );
          }
          advanced = recordAuthorityCasPrepared(
            session.gitCommonDirectory,
            advanced,
            now,
          );
          updateManagedRef(
            git.repositoryRoot,
            currentJournal.baseCommit,
            commitHash,
            targetRef,
          );
          if (expectedGeneration !== null) {
            recordDurableRefGenerationTransitionUnderLifecycleLock(
              currentSession.gitCommonDirectory,
              {
                ref: targetRef,
                expectedOid: currentJournal.baseCommit,
                expectedGeneration,
                nextOid: commitHash,
                reason: 'apply',
                at: exactDate(now).toISOString(),
              },
              assertOwned,
            );
          }
        } else if (git.head !== commitHash) {
          throw recoveryError(
            'AUTHORITY_RECOVERY_REF_DIVERGED',
            'The branch no longer points to the journaled base or commit.',
          );
        } else if (expectedGeneration !== null) {
          const ledger = readDurableRefGenerationLedger(
            currentSession.gitCommonDirectory,
            targetRef,
            true,
          );
          if (
            ledger.currentOid === currentJournal.baseCommit &&
            ledger.generation === expectedGeneration
          ) {
            recordDurableRefGenerationTransitionUnderLifecycleLock(
              currentSession.gitCommonDirectory,
              {
                ref: targetRef,
                expectedOid: currentJournal.baseCommit,
                expectedGeneration,
                nextOid: commitHash,
                reason: 'apply',
                at: exactDate(now).toISOString(),
              },
              assertOwned,
            );
          } else if (
            ledger.currentOid !== commitHash ||
            ledger.generation !== expectedGeneration + 1
          ) {
            throw recoveryError(
              'AUTHORITY_RECOVERY_REF_GENERATION_DIVERGED',
              'The protected ref generation ledger differs from the journaled transition.',
            );
          }
        }
        if (advanced.state === 'cas-prepared') {
          advanced = recordAuthorityRefUpdated(
            session.gitCommonDirectory,
            advanced,
            now,
          );
        }
        assertOwned();
        assertAppliedTransactionPoststate(
          git.repositoryRoot,
          targetRef,
          commitHash,
          advanced.expectedTree,
        );
        if (auditScope !== null) {
          advanced = ensureTransactionAuditReceipt(
            currentSession,
            advanced,
            auditScope,
            'cas',
            now,
            options,
          );
          if (advanced.poststateVerifiedAt === null) {
            advanced = transitionJournal(
              currentSession.gitCommonDirectory,
              advanced,
              'ref-updated',
              {
                state: 'ref-updated',
                poststateVerifiedAt: exactDate(now).toISOString(),
                updatedAt: exactDate(now).toISOString(),
              },
            );
          }
          advanced = ensureTransactionAuditReceipt(
            currentSession,
            advanced,
            auditScope,
            'poststate',
            now,
            options,
          );
        }
        options.testBeforeConsume?.();
        consumeMaintainerReservationUnderLifecycleLock(
          session.gitCommonDirectory,
          session.grantId,
          session.sessionId,
          commitHash,
          now,
        );
        const consumed = transitionJournal(
          session.gitCommonDirectory,
          advanced,
          'ref-updated',
          {
            state: 'consumed',
            consumedAt: exactDate(now).toISOString(),
            updatedAt: exactDate(now).toISOString(),
          },
        );
        return finalizeConsumed(
          cwd,
          currentSession,
          consumed,
          auditScope,
          now,
          options,
        );
      },
      { allowMaintainerGrantId: session.grantId },
    );
  } catch (error) {
    const inspection = inspectMaintainerGrants(
      session.gitCommonDirectory,
      session.grantId,
    )[0];
    if (
      inspection?.state === 'consumed' &&
      inspection.commitHash === journal.commitHash
    ) {
      throw recoveryError(
        'AUTHORITY_RECOVERY_FINALIZATION_REQUIRED',
        'The grant is consumed but journal finalization must be retried.',
      );
    }
    const observedJournal = readAuthorityCommitJournal(
      session.gitCommonDirectory,
      session.sessionId,
    );
    if (
      inspection?.state === 'reserved' &&
      observedJournal.state === 'ref-updated' &&
      observedJournal.commitHash !== null &&
      discoverRepository(cwd).head === observedJournal.commitHash
    ) {
      throw recoveryError(
        'AUTHORITY_RECOVERY_FINALIZATION_REQUIRED',
        'The ref is applied and grant consumption must be retried to completion.',
      );
    }
    revokeAmbiguousTransaction(session, journal, error, now);
    throw error;
  }
}

function rejectAmbiguousAuthorityCas(
  repositoryRoot: string,
  session: AuthoritySession,
  journal: AuthorityCommitJournal,
  indexTree: string,
  now: Date,
  assertOwned: () => void,
): never {
  const timestamp = exactDate(now);
  const error = recoveryError(
    'AUTHORITY_CAS_OUTCOME_AMBIGUOUS',
    'The ref returned to its base after CAS preparation; replay is forbidden.',
  );
  if (session.expectedRefGeneration !== null) {
    recordDurableRefGenerationTransitionUnderLifecycleLock(
      session.gitCommonDirectory,
      {
        ref: `refs/heads/${session.branch}`,
        expectedOid: journal.baseCommit,
        expectedGeneration: session.expectedRefGeneration,
        nextOid: journal.baseCommit,
        reason: 'uncertain-cas',
        at: timestamp.toISOString(),
      },
      assertOwned,
    );
  }
  terminallyInvalidateMaintainerReservationUnderLifecycleLock(
    session.gitCommonDirectory,
    session.grantId,
    session.sessionId,
    error.message,
    timestamp,
  );
  if (indexTree === journal.expectedTree) {
    rollbackExactStaging(
      repositoryRoot,
      journal.previousIndexTree,
      journal.expectedTree,
      error,
    );
  }
  transitionJournal(session.gitCommonDirectory, journal, 'cas-prepared', {
    state: 'revoked',
    reason: error.message,
    updatedAt: timestamp.toISOString(),
  });
  throw error;
}

export function expireAuthorityCommitBeforeCas(
  cwd: string,
  requestedSessionId: string,
  now = new Date(),
): void {
  const session = readAuthoritySession(cwd, requestedSessionId);
  const timestamp = exactDate(now);
  const expiryError = recoveryError(
    'AUTHORITY_GRANT_EXPIRED_BEFORE_CAS',
    'The authority grant expired before the protected ref was updated.',
  );
  withRepositoryLifecycleOperation(
    maintainerGrantStorePaths(session.gitCommonDirectory).runtime,
    (assertOwned) => {
      assertOwned();
      const journal = readAuthorityCommitJournal(
        session.gitCommonDirectory,
        session.sessionId,
      );
      assertJournalMatchesSession(journal, session);
      if (journal.state !== 'commit-created' && journal.state !== 'revoked') {
        throw recoveryError(
          'AUTHORITY_EXPIRY_STATE_INVALID',
          'Only a pre-CAS commit-created transaction may expire.',
        );
      }
      const git = discoverRepository(cwd);
      const indexTree = runGit(git.repositoryRoot, ['write-tree']).trim();
      if (
        git.head !== journal.baseCommit ||
        (indexTree !== journal.expectedTree &&
          indexTree !== journal.previousIndexTree)
      ) {
        throw recoveryError(
          'AUTHORITY_EXPIRY_PRESTATE_DIVERGED',
          'The pre-CAS transaction diverged before expiry cleanup.',
        );
      }
      terminallyExpireMaintainerReservationUnderLifecycleLock(
        session.gitCommonDirectory,
        session.grantId,
        session.sessionId,
        expiryError.message,
        timestamp,
      );
      if (journal.state === 'commit-created') {
        transitionJournal(
          session.gitCommonDirectory,
          journal,
          'commit-created',
          {
            state: 'revoked',
            reason: expiryError.message,
            updatedAt: timestamp.toISOString(),
          },
        );
      }
      if (indexTree === journal.expectedTree) {
        rollbackExactStaging(
          git.repositoryRoot,
          journal.previousIndexTree,
          journal.expectedTree,
          expiryError,
        );
      }
    },
    { allowMaintainerGrantId: session.grantId },
  );
  if (session.state === 'active') {
    failAuthoritySession(session, expiryError, timestamp);
  }
}

export function rollbackAuthorityCommitAfterCas(
  cwd: string,
  requestedSessionId: string,
  reason: string,
  now = new Date(),
): void {
  const session = readAuthoritySession(cwd, requestedSessionId);
  const timestamp = exactDate(now);
  const rollbackReason =
    reason.trim().length > 0
      ? reason.trim().slice(0, 1_000)
      : 'Authority poststate verification failed';
  withRepositoryLifecycleOperation(
    maintainerGrantStorePaths(session.gitCommonDirectory).runtime,
    (assertOwned) => {
      assertOwned();
      let journal = readAuthorityCommitJournal(
        session.gitCommonDirectory,
        session.sessionId,
      );
      assertJournalMatchesSession(journal, session);
      const auditScope = authorityAuditScopeForJournal(session, journal);
      if (journal.state === 'ref-updated') {
        journal = transitionJournal(
          session.gitCommonDirectory,
          journal,
          'ref-updated',
          {
            state: 'rollback-prepared',
            reason: rollbackReason,
            rollbackStartedAt: timestamp.toISOString(),
            updatedAt: timestamp.toISOString(),
          },
        );
      }
      if (
        journal.state === 'rollback-prepared' &&
        journal.rollbackStartedAt === null
      ) {
        journal = transitionJournal(
          session.gitCommonDirectory,
          journal,
          'rollback-prepared',
          {
            state: 'rollback-prepared',
            rollbackStartedAt: journal.updatedAt,
            updatedAt: journal.updatedAt,
          },
        );
      }
      if (journal.state === 'rolled-back') {
        if (
          journal.rollbackStartedAt === null ||
          journal.rolledBackAt === null
        ) {
          journal = transitionJournal(
            session.gitCommonDirectory,
            journal,
            'rolled-back',
            {
              state: 'rolled-back',
              rollbackStartedAt: journal.rollbackStartedAt ?? journal.updatedAt,
              rolledBackAt: journal.rolledBackAt ?? journal.updatedAt,
              updatedAt: journal.updatedAt,
            },
          );
        }
        if (auditScope !== null) {
          journal = ensureTransactionAuditReceipt(
            session,
            journal,
            auditScope,
            'cas',
            timestamp,
          );
          journal = ensureTransactionAuditReceipt(
            session,
            journal,
            auditScope,
            'error',
            timestamp,
          );
          ensureTransactionAuditReceipt(
            session,
            journal,
            auditScope,
            'rollback',
            timestamp,
          );
        }
        return;
      }
      if (journal.state !== 'rollback-prepared') {
        throw recoveryError(
          'AUTHORITY_ROLLBACK_STATE_INVALID',
          'Only a ref-updated authority transaction may roll back.',
        );
      }
      const commitHash = requireCommitHash(journal);
      verifyJournaledCommit(cwd, session, journal, commitHash);
      const git = discoverRepository(cwd);
      const indexTree = runGit(git.repositoryRoot, ['write-tree']).trim();
      if (
        (git.head !== commitHash && git.head !== journal.baseCommit) ||
        (indexTree !== journal.expectedTree &&
          indexTree !== journal.previousIndexTree)
      ) {
        throw recoveryError(
          'AUTHORITY_ROLLBACK_PRESTATE_DIVERGED',
          'Authority rollback prestate differs from its journal.',
        );
      }
      if (auditScope !== null) {
        journal = ensureTransactionAuditReceipt(
          session,
          journal,
          auditScope,
          'cas',
          timestamp,
        );
        journal = ensureTransactionAuditReceipt(
          session,
          journal,
          auditScope,
          'error',
          timestamp,
        );
      }
      terminallyFailMaintainerReservationUnderLifecycleLock(
        session.gitCommonDirectory,
        session.grantId,
        session.sessionId,
        rollbackReason,
        timestamp,
      );
      const targetRef = `refs/heads/${session.branch}`;
      if (git.head === commitHash) {
        updateManagedRef(
          git.repositoryRoot,
          commitHash,
          journal.baseCommit,
          targetRef,
        );
      }
      if (session.expectedRefGeneration !== null) {
        const ledger = readDurableRefGenerationLedger(
          session.gitCommonDirectory,
          targetRef,
          true,
        );
        const appliedGeneration = session.expectedRefGeneration + 1;
        if (
          ledger.currentOid === commitHash &&
          ledger.generation === appliedGeneration
        ) {
          recordDurableRefGenerationTransitionUnderLifecycleLock(
            session.gitCommonDirectory,
            {
              ref: targetRef,
              expectedOid: commitHash,
              expectedGeneration: appliedGeneration,
              nextOid: journal.baseCommit,
              reason: 'rollback',
              at: timestamp.toISOString(),
            },
            assertOwned,
          );
        } else if (
          ledger.currentOid !== journal.baseCommit ||
          ledger.generation !== appliedGeneration + 1
        ) {
          throw recoveryError(
            'AUTHORITY_ROLLBACK_GENERATION_DIVERGED',
            'Authority rollback ref generation differs from its journal.',
          );
        }
      }
      if (indexTree === journal.expectedTree) {
        rollbackExactStaging(
          git.repositoryRoot,
          journal.previousIndexTree,
          journal.expectedTree,
          new Error(rollbackReason),
        );
      }
      assertRolledBackTransactionPoststate(
        git.repositoryRoot,
        targetRef,
        journal.baseCommit,
        session.baselineTree,
      );
      journal = transitionJournal(
        session.gitCommonDirectory,
        journal,
        'rollback-prepared',
        {
          state: 'rolled-back',
          reason: rollbackReason,
          rolledBackAt: timestamp.toISOString(),
          updatedAt: timestamp.toISOString(),
        },
      );
      if (auditScope !== null) {
        ensureTransactionAuditReceipt(
          session,
          journal,
          auditScope,
          'rollback',
          timestamp,
        );
      }
    },
    { allowMaintainerGrantId: session.grantId },
  );
  if (session.state === 'active') {
    failAuthoritySession(
      session,
      recoveryError('AUTHORITY_POSTSTATE_VERIFICATION_FAILED', rollbackReason),
      timestamp,
    );
  }
}

export function readAuthorityCommitJournal(
  gitCommonDirectory: string,
  requestedSessionId: string,
): AuthorityCommitJournal {
  const sessionId = assertSessionId(requestedSessionId);
  const journalPath = path.join(
    maintainerGrantStorePaths(gitCommonDirectory).journals,
    `${sessionId}.json`,
  );
  const stats = fs.lstatSync(journalPath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw recoveryError(
      'AUTHORITY_JOURNAL_INVALID',
      'Authority recovery journal is missing or unsafe.',
    );
  }
  try {
    const raw = fs.readFileSync(journalPath, 'utf8');
    const value = JSON.parse(raw) as unknown;
    if (raw !== `${JSON.stringify(value)}\n`) {
      throw new Error('invalid journal');
    }
    const journal = isJournal(value)
      ? value
      : normalizeLegacyAuthorityCommitJournal(value);
    if (journal === null || journal.sessionId !== sessionId) {
      throw new Error('invalid journal');
    }
    return journal;
  } catch {
    throw recoveryError(
      'AUTHORITY_JOURNAL_INVALID',
      'Authority recovery journal is malformed.',
    );
  }
}

export function verifyCreatedAuthorityCommit(
  cwd: string,
  session: AuthoritySession,
  journal: AuthorityCommitJournal,
): void {
  assertJournalMatchesSession(journal, session);
  if (journal.state !== 'commit-created') {
    throw recoveryError(
      'AUTHORITY_JOURNAL_COMMIT_MISSING',
      'Authority commit verification requires a created commit object.',
    );
  }
  verifyJournaledCommit(cwd, session, journal, requireCommitHash(journal));
}

function finalizeConsumed(
  cwd: string,
  session: AuthoritySession,
  journal: AuthorityCommitJournal,
  auditScope: AuthorityAuditLedgerScope | null,
  now: Date,
  options: AuthorityRecoveryOptions,
): AuthorityCommitResult {
  const commitHash = requireCommitHash(journal);
  verifyJournaledCommit(cwd, session, journal, commitHash);
  const terminal = inspectMaintainerGrants(
    session.gitCommonDirectory,
    session.grantId,
  )[0];
  if (
    terminal?.state !== 'consumed' ||
    terminal.commitHash !== commitHash ||
    terminal.reservationSessionId !== session.sessionId
  ) {
    throw recoveryError(
      'AUTHORITY_TERMINAL_STATE_DIVERGED',
      'Consumed journal and terminal grant state do not match.',
    );
  }
  if (session.grantVersion === 2) {
    if (auditScope === null || journal.casAuditRecordDigest === null) {
      throw recoveryError(
        'AUTHORITY_AUDIT_STATE_INVALID',
        'Consumed v2 authority state is missing its bound external audit scope or CAS receipt.',
      );
    }
    assertAppliedTransactionPoststate(
      session.repositoryRoot,
      `refs/heads/${session.branch}`,
      commitHash,
      journal.expectedTree,
    );
    let verified = ensureTransactionAuditReceipt(
      session,
      journal,
      auditScope,
      'cas',
      now,
    );
    if (verified.poststateVerifiedAt === null) {
      const verifiedAt =
        verified.consumedAt ?? verified.refUpdatedAt ?? verified.updatedAt;
      verified = transitionJournal(
        session.gitCommonDirectory,
        verified,
        'consumed',
        {
          state: 'consumed',
          poststateVerifiedAt: verifiedAt,
          updatedAt: verified.updatedAt,
        },
      );
    }
    verified = ensureTransactionAuditReceipt(
      session,
      verified,
      auditScope,
      'poststate',
      now,
    );
    verified = ensureTransactionAuditReceipt(
      session,
      verified,
      auditScope,
      'grant-consume',
      now,
      options,
    );
    const audited = transitionJournal(
      session.gitCommonDirectory,
      verified,
      'consumed',
      {
        state: 'audited',
        updatedAt: exactDate(now).toISOString(),
      },
    );
    return finalizeAudited(cwd, session, audited, auditScope, now, options);
  }
  const committed =
    session.state === 'committed'
      ? session
      : markAuthoritySessionCommitted(cwd, session, commitHash, now);
  if (committed.commitHash !== commitHash) {
    throw recoveryError(
      'AUTHORITY_SESSION_DIVERGED',
      'Committed authority session references another commit.',
    );
  }
  return result(committed, journal, commitHash);
}

function finalizeAudited(
  cwd: string,
  session: AuthoritySession,
  journal: AuthorityCommitJournal,
  auditScope: AuthorityAuditLedgerScope | null,
  now: Date,
  options: AuthorityRecoveryOptions,
): AuthorityCommitResult {
  const commitHash = requireCommitHash(journal);
  verifyJournaledCommit(cwd, session, journal, commitHash);
  if (
    session.grantVersion !== 2 ||
    auditScope === null ||
    journal.casAuditRecordDigest === null ||
    journal.poststateAuditRecordDigest === null ||
    journal.consumeAuditRecordDigest === null
  ) {
    throw recoveryError(
      'AUTHORITY_AUDIT_STATE_INVALID',
      'Audited authority state is incomplete or belongs to a legacy grant.',
    );
  }
  const terminal = inspectMaintainerGrants(
    session.gitCommonDirectory,
    session.grantId,
  )[0];
  if (
    terminal?.state !== 'consumed' ||
    terminal.commitHash !== commitHash ||
    terminal.reservationSessionId !== session.sessionId
  ) {
    throw recoveryError(
      'AUTHORITY_TERMINAL_STATE_DIVERGED',
      'Audited journal and terminal grant state do not match.',
    );
  }
  let verified = ensureTransactionAuditReceipt(
    session,
    journal,
    auditScope,
    'cas',
    now,
  );
  verified = ensureTransactionAuditReceipt(
    session,
    verified,
    auditScope,
    'poststate',
    now,
  );
  verified = ensureTransactionAuditReceipt(
    session,
    verified,
    auditScope,
    'grant-consume',
    now,
  );
  ensurePortableApplicationReceipt(
    session,
    verified,
    auditScope,
    options.receiptSigner,
  );
  const committed =
    session.state === 'committed'
      ? session
      : markAuthoritySessionCommitted(cwd, session, commitHash, now);
  if (committed.commitHash !== commitHash) {
    throw recoveryError(
      'AUTHORITY_SESSION_DIVERGED',
      'Committed authority session references another commit.',
    );
  }
  return result(committed, journal, commitHash);
}

function ensurePortableApplicationReceipt(
  session: AuthoritySession,
  journal: AuthorityCommitJournal,
  auditScope: AuthorityAuditLedgerScope,
  providedSigner: MaintainerSignerProvider | undefined,
): void {
  const terminal = readTerminalMaintainerGrant(
    session.gitCommonDirectory,
    session.grantId,
  );
  if (
    terminal.state !== 'consumed' ||
    terminal.sessionId !== session.sessionId ||
    terminal.commitHash !== journal.commitHash ||
    terminal.recordedAt !== journal.consumedAt ||
    !isMaintainerGrantV2Envelope(terminal.envelope)
  ) {
    throw recoveryError(
      'AUTHORITY_APPLICATION_RECEIPT_TERMINAL_MISMATCH',
      'Portable authority receipt requires the exact consumed v2 terminal grant state.',
    );
  }
  const envelope = terminal.envelope;
  const candidate = envelope.payload.candidateBundle;
  if (
    candidate === null ||
    journal.commitHash === null ||
    journal.refUpdatedAt === null ||
    journal.poststateVerifiedAt === null ||
    journal.consumedAt === null ||
    journal.casAuditRecordDigest === null ||
    journal.poststateAuditRecordDigest === null ||
    journal.consumeAuditRecordDigest === null ||
    session.expectedRefGeneration === null ||
    session.candidateBundleDigest !== candidate.candidateBundleDigest ||
    envelope.payload.effectsManifestDigest !==
      candidate.effectsManifestDigest ||
    session.candidateCommit !== candidate.candidateCommit ||
    session.resultTree !== candidate.resultTree ||
    candidate.targetRef !== `refs/heads/${session.branch}` ||
    candidate.expectedOldCommit !== journal.baseCommit ||
    candidate.expectedRefGeneration !== session.expectedRefGeneration ||
    candidate.candidateCommit !== journal.commitHash ||
    candidate.resultTree !== journal.expectedTree
  ) {
    throw recoveryError(
      'AUTHORITY_APPLICATION_RECEIPT_BINDING_INVALID',
      'Portable authority receipt inputs differ from the exact candidate transaction.',
    );
  }
  const policyContent = runGit(session.repositoryRoot, [
    'show',
    `${session.baseCommit}:workflow/maintainer-policy.json`,
  ]);
  const policy = parseMaintainerPolicy(JSON.parse(policyContent));
  const grantTagRef = `${policy.auditTagPrefix}${session.grantId}`;
  const receipt = createAuthorityApplicationReceiptPayload({
    grantId: session.grantId,
    repositoryId: envelope.payload.repositoryId,
    repositoryOrigin: envelope.payload.repositoryOrigin,
    changeId: session.changeId,
    signer: session.signer,
    grantTagRef,
    grantEnvelopeDigest: signedGrantEnvelopeDigest(
      canonicalMaintainerGrantV2Envelope(envelope),
    ),
    candidateBundleDigest: candidate.candidateBundleDigest,
    effectsManifestDigest: candidate.effectsManifestDigest,
    candidatePatchDigest: envelope.payload.patchDigest,
    candidateCommit: candidate.candidateCommit,
    candidateTree: candidate.resultTree,
    targetRef: candidate.targetRef,
    oldRefOid: candidate.expectedOldCommit,
    oldRefGeneration: candidate.expectedRefGeneration,
    newRefOid: candidate.candidateCommit,
    newRefGeneration: candidate.expectedRefGeneration + 1,
    casAt: journal.refUpdatedAt,
    casAuditReceiptDigest: journal.casAuditRecordDigest,
    auditRepositoryId: auditScope.repositoryId,
    poststateVerifiedAt: journal.poststateVerifiedAt,
    poststateAuditReceiptDigest: journal.poststateAuditRecordDigest,
    terminalGrantState: 'consumed',
    terminalReservationId: session.sessionId,
    terminalCommit: candidate.candidateCommit,
    terminalConsumedAt: terminal.recordedAt,
    grantConsumeAuditReceiptDigest: journal.consumeAuditRecordDigest,
    issuedAt: journal.updatedAt,
  });
  const receiptRef = authorityApplicationReceiptTagRef(policy, session.grantId);
  const alreadyPublished = runGit(
    session.repositoryRoot,
    ['rev-parse', '--verify', receiptRef],
    true,
  ).trim();
  let signer = providedSigner;
  if (!alreadyPublished) {
    signer ??= createInteractiveSshSigner(session.repositoryRoot, policy);
    signer.assertHumanPresent();
  }
  publishAuthorityApplicationReceipt(
    session.repositoryRoot,
    policy,
    receipt,
    signer,
  );
}

function authorityAuditScopeForJournal(
  session: AuthoritySession,
  journal: AuthorityCommitJournal,
): AuthorityAuditLedgerScope | null {
  if (session.grantVersion === 1) {
    if (
      journal.externalAuditRoot !== null ||
      journal.auditRepositoryId !== null ||
      journal.mandateBinding !== null ||
      journal.casAuditRecordDigest !== null ||
      journal.poststateAuditRecordDigest !== null ||
      journal.consumeAuditRecordDigest !== null ||
      journal.errorAuditRecordDigest !== null ||
      journal.rollbackAuditRecordDigest !== null
    ) {
      throw recoveryError(
        'AUTHORITY_AUDIT_STATE_INVALID',
        'Legacy authority state unexpectedly contains v2 audit authority.',
      );
    }
    return null;
  }
  if (
    journal.externalAuditRoot === null ||
    journal.auditRepositoryId === null ||
    journal.mandateBinding === null ||
    session.mandateBinding === null ||
    canonicalJson(journal.mandateBinding) !==
      canonicalJson(session.mandateBinding) ||
    journal.externalAuditRoot !== session.mandateBinding.externalAuditRoot
  ) {
    throw recoveryError(
      'AUTHORITY_AUDIT_ROOT_MISMATCH',
      'Recovery requires the exact external audit root bound before the authority CAS.',
    );
  }
  const scope: AuthorityAuditLedgerScope = {
    externalAuditRoot: journal.externalAuditRoot,
    repositoryRoot: session.repositoryRoot,
    repositoryId: journal.auditRepositoryId,
  };
  authorityAuditLedgerPaths(scope);
  return scope;
}

type TransactionAuditEvent = Extract<
  AuthorityAuditEventType,
  'cas' | 'poststate' | 'grant-consume' | 'error' | 'rollback'
>;

type AuditReceiptField =
  | 'casAuditRecordDigest'
  | 'poststateAuditRecordDigest'
  | 'consumeAuditRecordDigest'
  | 'errorAuditRecordDigest'
  | 'rollbackAuditRecordDigest';

function ensureTransactionAuditReceipt(
  session: AuthoritySession,
  journal: AuthorityCommitJournal,
  scope: AuthorityAuditLedgerScope,
  eventType: TransactionAuditEvent,
  now: Date,
  options: AuthorityRecoveryOptions = {},
): AuthorityCommitJournal {
  const field = auditReceiptField(eventType);
  const eventInput = transactionAuditEventInput(session, journal, eventType);
  const input = authorityAuditAppendInputForEvent(
    buildAuthorityAuditEvent(scope.repositoryId, eventInput),
  );
  const expectedDigest = journal[field];
  if (expectedDigest !== null) {
    const existing = scanAuthorityAuditLedger(scope).records.find(
      ({ recordDigest }) => recordDigest === expectedDigest,
    );
    const projected = verifyAuthorityAuditEvents(scope).events.some(
      ({ ledger }) => ledger.recordDigest === expectedDigest,
    );
    if (
      existing === undefined ||
      !auditRecordMatches(existing, input) ||
      !projected
    ) {
      throw recoveryError(
        'AUTHORITY_AUDIT_RECEIPT_DIVERGED',
        'A journaled authority audit receipt differs from the external ledger.',
      );
    }
    return journal;
  }
  if (eventType === 'cas' || eventType === 'grant-consume') {
    options.testBeforeAudit?.(eventType);
  }
  const entry = recordAuthorityAuditEvent(scope, eventInput).ledger;
  const update = {
    state: journal.state,
    updatedAt: exactDate(now).toISOString(),
    [field]: entry.recordDigest,
  } as Partial<AuthorityCommitJournal> & {
    state: AuthorityCommitJournalState;
    updatedAt: string;
  };
  return transitionJournal(
    session.gitCommonDirectory,
    journal,
    journal.state,
    update,
  );
}

function transactionAuditEventInput(
  session: AuthoritySession,
  journal: AuthorityCommitJournal,
  eventType: TransactionAuditEvent,
): AuthorityAuditEventInput {
  const commitHash = requireCommitHash(journal);
  const occurredAt = auditEventTimestamp(journal, eventType);
  if (occurredAt === null) {
    throw recoveryError(
      'AUTHORITY_AUDIT_STATE_INVALID',
      'Authority audit event is missing its durable transaction timestamp.',
    );
  }
  const targetRef = `refs/heads/${session.branch}`;
  const grantDigest = prefixedDigest(session.grantDigest);
  if (session.candidateBundleDigest === null) {
    throw recoveryError(
      'AUTHORITY_AUDIT_STATE_INVALID',
      'A v2 authority audit event requires its exact immutable candidate digest.',
    );
  }
  const candidateBundleDigest = prefixedDigest(session.candidateBundleDigest);
  const basePrestateDigest = auditValueDigest({
    schemaVersion: 1,
    kind: 'authority-apply-prestate.v1',
    targetRef,
    baseCommit: journal.baseCommit,
    expectedRefGeneration: session.expectedRefGeneration,
  });
  const appliedPoststateDigest = auditValueDigest({
    schemaVersion: 1,
    kind: 'authority-apply-poststate.v1',
    targetRef,
    commitHash,
    resultTree: journal.expectedTree,
    refGeneration:
      session.expectedRefGeneration === null
        ? null
        : session.expectedRefGeneration + 1,
  });
  const rolledBackPoststateDigest = auditValueDigest({
    schemaVersion: 1,
    kind: 'authority-rollback-poststate.v1',
    targetRef,
    commitHash: journal.baseCommit,
    resultTree: session.baselineTree,
    refGeneration:
      session.expectedRefGeneration === null
        ? null
        : session.expectedRefGeneration + 2,
  });
  const prestateDigest =
    eventType === 'cas' || eventType === 'grant-consume'
      ? basePrestateDigest
      : appliedPoststateDigest;
  const poststateDigest =
    eventType === 'rollback'
      ? rolledBackPoststateDigest
      : appliedPoststateDigest;
  const outcome = auditResult(session, journal, eventType, commitHash);
  return {
    eventType,
    occurredAt,
    idempotencyKey: auditValueDigest({
      schemaVersion: 1,
      kind: 'authority-audit-idempotency.v1',
      eventType,
      sessionId: session.sessionId,
      grantDigest,
      commitHash,
    }),
    grantDigest,
    candidateBundleDigest,
    prestateDigest,
    poststateDigest,
    actor: { kind: 'human', identity: session.signer },
    taskId: session.mandateBinding?.mandateTaskId ?? null,
    changeId: session.changeId,
    workflowId: null,
    command: {
      name: `authority.${eventType}`,
      argvDigest: outcome.outcomeDigest,
    },
    providerInvocation: null,
    externalEffect: null,
    result: outcome.result,
    outcomeDigest: outcome.outcomeDigest,
    errorCode: eventType === 'error' ? 'AUTHORITY_TRANSACTION_FAILED' : null,
  };
}

function auditResult(
  session: AuthoritySession,
  journal: AuthorityCommitJournal,
  eventType: TransactionAuditEvent,
  commitHash: string,
): Pick<AuthorityAuditEventInput, 'result' | 'outcomeDigest'> {
  const common = {
    schemaVersion: 1,
    eventType,
    grantId: session.grantId,
    commitHash,
    changedPaths: journal.allowedPaths,
  };
  if (eventType === 'error' || eventType === 'rollback') {
    if (journal.reason === null) {
      throw recoveryError(
        'AUTHORITY_AUDIT_STATE_INVALID',
        'Rollback audit events require their durable failure reason digest.',
      );
    }
    const reasonDigest = auditValueDigest({
      schemaVersion: 1,
      kind: 'authority-failure-reason.v1',
      reason: journal.reason,
    });
    return {
      result: eventType === 'error' ? 'failed' : 'rolled-back',
      outcomeDigest: auditValueDigest({
        ...common,
        kind:
          eventType === 'error'
            ? 'authority-poststate-error-result.v1'
            : 'authority-rollback-result.v1',
        reasonDigest,
        ...(eventType === 'rollback' ? { rollbackTo: journal.baseCommit } : {}),
      }),
    };
  }
  return {
    result: 'succeeded',
    outcomeDigest: auditValueDigest({
      ...common,
      kind:
        eventType === 'cas'
          ? 'authority-cas-result.v1'
          : eventType === 'poststate'
            ? 'authority-poststate-result.v1'
            : 'authority-grant-consume-result.v1',
    }),
  };
}

function auditEventTimestamp(
  journal: AuthorityCommitJournal,
  eventType: TransactionAuditEvent,
): string | null {
  switch (eventType) {
    case 'cas':
      return journal.refUpdatedAt;
    case 'poststate':
      return journal.poststateVerifiedAt;
    case 'grant-consume':
      return journal.consumedAt;
    case 'error':
      return journal.rollbackStartedAt;
    case 'rollback':
      return journal.rolledBackAt;
  }
}

function auditReceiptField(
  eventType: TransactionAuditEvent,
): AuditReceiptField {
  switch (eventType) {
    case 'cas':
      return 'casAuditRecordDigest';
    case 'poststate':
      return 'poststateAuditRecordDigest';
    case 'grant-consume':
      return 'consumeAuditRecordDigest';
    case 'error':
      return 'errorAuditRecordDigest';
    case 'rollback':
      return 'rollbackAuditRecordDigest';
  }
}

function auditRecordMatches(
  entry: AuthorityAuditLedgerEntry,
  input: AuthorityAuditAppendInput,
): boolean {
  const { record } = entry;
  return (
    record.eventType === input.eventType &&
    record.occurredAt === input.occurredAt &&
    record.idempotencyKey === input.idempotencyKey &&
    record.grantDigest === input.grantDigest &&
    record.candidateBundleDigest === input.candidateBundleDigest &&
    record.prestateDigest === input.prestateDigest &&
    record.poststateDigest === input.poststateDigest &&
    record.result === input.result &&
    record.resultDigest === input.resultDigest
  );
}

function assertAppliedTransactionPoststate(
  repositoryRoot: string,
  targetRef: string,
  commitHash: string,
  expectedTree: string,
): void {
  const observedRef = runGit(repositoryRoot, [
    'rev-parse',
    '--verify',
    targetRef,
  ]).trim();
  const observedTree = runGit(repositoryRoot, [
    'rev-parse',
    '--verify',
    `${commitHash}^{tree}`,
  ]).trim();
  if (observedRef !== commitHash || observedTree !== expectedTree) {
    throw recoveryError(
      'AUTHORITY_POSTSTATE_VERIFICATION_FAILED',
      'The applied authority ref or result tree differs from its exact journaled poststate.',
    );
  }
}

function assertRolledBackTransactionPoststate(
  repositoryRoot: string,
  targetRef: string,
  baseCommit: string,
  baselineTree: string,
): void {
  const observedRef = runGit(repositoryRoot, [
    'rev-parse',
    '--verify',
    targetRef,
  ]).trim();
  const observedTree = runGit(repositoryRoot, [
    'rev-parse',
    '--verify',
    `${baseCommit}^{tree}`,
  ]).trim();
  if (observedRef !== baseCommit || observedTree !== baselineTree) {
    throw recoveryError(
      'AUTHORITY_ROLLBACK_POSTSTATE_DIVERGED',
      'The rolled-back authority ref or tree differs from its exact journaled poststate.',
    );
  }
}

function auditValueDigest(value: unknown): Sha256Digest {
  return `sha256:${digest(canonicalJson(value))}`;
}

function prefixedDigest(value: string): Sha256Digest {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw recoveryError(
      'AUTHORITY_AUDIT_STATE_INVALID',
      'Authority audit binding requires an exact SHA-256 digest.',
    );
  }
  return `sha256:${value}`;
}

function verifyJournaledCommit(
  cwd: string,
  session: AuthoritySession,
  journal: AuthorityCommitJournal,
  commitHash: string,
): void {
  const git = discoverRepository(cwd);
  if (
    git.repositoryRealPath !== journal.repositoryRoot ||
    git.gitCommonDirectory !== session.gitCommonDirectory ||
    git.branch !== journal.branch
  ) {
    throw recoveryError(
      'AUTHORITY_RECOVERY_REPOSITORY_DIVERGED',
      'Authority recovery repository or branch differs from the journal.',
    );
  }
  const facts = commitFacts(git.repositoryRoot, commitHash);
  const expectedMessage = expectedAuthorityMessage(session, journal.subject);
  const trailers = parseManagedTrailers(facts.message);
  const exactTrailers =
    session.grantVersion === 2
      ? trailers?.kind === 'authority-candidate' &&
        trailers.changeId === journal.changeId
      : trailers?.kind === 'authority' &&
        trailers.changeId === journal.changeId &&
        trailers.grantId === journal.grantId;
  if (
    JSON.stringify(facts.parents) !== JSON.stringify([journal.baseCommit]) ||
    facts.tree !== journal.expectedTree ||
    facts.message !== `${expectedMessage}\n` ||
    digest(facts.message) !== journal.messageDigest ||
    JSON.stringify(commitChangedPaths(git.repositoryRoot, commitHash)) !==
      JSON.stringify(journal.allowedPaths) ||
    !exactTrailers
  ) {
    throw recoveryError(
      'AUTHORITY_COMMIT_INVALID',
      'The journaled commit does not match the exact authority transaction.',
    );
  }
  verifyCommitSignature(git.repositoryRoot, session, commitHash);
}

function expectedAuthorityMessage(
  session: AuthoritySession,
  subject: string,
): string {
  return session.grantVersion === 2
    ? authorityCandidateCommitMessage(subject, session.changeId)
    : authorityCommitMessage(subject, session.changeId, session.grantId);
}

function verifyCommitSignature(
  repositoryRoot: string,
  session: AuthoritySession,
  commitHash: string,
): void {
  const policyContent = runGit(repositoryRoot, [
    'show',
    `${session.baseCommit}:workflow/maintainer-policy.json`,
  ]);
  const policy = parseMaintainerPolicy(JSON.parse(policyContent));
  const policyBlob = runGit(repositoryRoot, [
    'rev-parse',
    `${session.baseCommit}:workflow/maintainer-policy.json`,
  ]).trim();
  const signer = policy.trustedSigners.find(
    ({ identity }) => identity === session.signer,
  );
  if (!signer || policyBlob !== session.policyBlob) {
    throw recoveryError(
      'AUTHORITY_COMMIT_SIGNER_INVALID',
      'The journaled signer is not trusted by the exact parent policy.',
    );
  }
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-authority-verify-'),
  );
  fs.chmodSync(temporaryDirectory, 0o700);
  const allowedSigners = path.join(temporaryDirectory, 'allowed-signers');
  try {
    fs.writeFileSync(
      allowedSigners,
      `${signer.identity} ${signer.publicKey}\n`,
      { mode: 0o600 },
    );
    const verification = runGit(repositoryRoot, [
      '-c',
      'gpg.format=ssh',
      '-c',
      `gpg.ssh.allowedSignersFile=${allowedSigners}`,
      'show',
      '-s',
      '--format=%G?%x00%GS%x00%GF',
      commitHash,
    ]).trimEnd();
    const [status, identity, fingerprint] = verification.split('\0');
    if (
      status !== 'G' ||
      identity !== signer.identity ||
      fingerprint !== signer.fingerprint
    ) {
      throw new Error('signature mismatch');
    }
  } catch {
    throw recoveryError(
      'AUTHORITY_COMMIT_SIGNATURE_INVALID',
      'The authority commit signature is missing, invalid, or untrusted.',
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function revokePreparingTransaction(
  cwd: string,
  session: AuthoritySession,
  journal: AuthorityCommitJournal,
  now: Date,
): never {
  try {
    withRepositoryLifecycleOperation(
      maintainerGrantStorePaths(session.gitCommonDirectory).runtime,
      (assertOwned) => {
        assertOwned();
        const git = discoverRepository(cwd);
        const indexTree = runGit(git.repositoryRoot, ['write-tree']).trim();
        if (
          git.head !== journal.baseCommit ||
          indexTree !== journal.expectedTree
        ) {
          throw recoveryError(
            'AUTHORITY_RECOVERY_PREPARING_DIVERGED',
            'Preparing transaction no longer matches its base and staged tree.',
          );
        }
        rollbackExactStaging(
          git.repositoryRoot,
          journal.previousIndexTree,
          journal.expectedTree,
          new Error('authority preparing recovery'),
        );
        transitionJournal(session.gitCommonDirectory, journal, 'preparing', {
          state: 'revoked',
          reason: 'Commit object was not durably journaled',
          updatedAt: exactDate(now).toISOString(),
        });
      },
      { allowMaintainerGrantId: session.grantId },
    );
  } catch (error) {
    revokeAmbiguousTransaction(session, journal, error, now);
    throw error;
  }
  const error = recoveryError(
    'AUTHORITY_RECOVERY_REVOKED',
    'Preparing authority transaction was rolled back and revoked.',
  );
  failAuthoritySession(session, error, now);
  throw error;
}

function revokeAmbiguousTransaction(
  session: AuthoritySession,
  journal: AuthorityCommitJournal,
  cause: unknown,
  now: Date,
): void {
  try {
    const observed = readAuthorityCommitJournal(
      session.gitCommonDirectory,
      session.sessionId,
    );
    if (
      observed.state !== 'consumed' &&
      observed.state !== 'audited' &&
      observed.state !== 'revoked'
    ) {
      transitionJournal(session.gitCommonDirectory, observed, observed.state, {
        state: 'revoked',
        reason:
          cause instanceof Error ? cause.message : 'Ambiguous recovery state',
        updatedAt: exactDate(now).toISOString(),
      });
    }
  } catch {
    // The terminal grant record remains the fail-closed authority if the
    // private journal itself is too damaged to update safely.
  }
  if (session.state === 'active') {
    failAuthoritySession(session, cause, now);
  }
}

function transitionJournal(
  gitCommonDirectory: string,
  expected: AuthorityCommitJournal,
  expectedState: AuthorityCommitJournalState,
  update: Partial<AuthorityCommitJournal> & {
    state: AuthorityCommitJournalState;
    updatedAt: string;
  },
): AuthorityCommitJournal {
  const current = readAuthorityCommitJournal(
    gitCommonDirectory,
    expected.sessionId,
  );
  if (
    current.state !== expectedState ||
    JSON.stringify(current) !== JSON.stringify(expected)
  ) {
    throw recoveryError(
      'AUTHORITY_JOURNAL_DIVERGED',
      'Authority journal changed during its transaction.',
    );
  }
  const next = { ...current, ...update };
  writeJournal(gitCommonDirectory, next, false);
  return next;
}

function writeJournal(
  gitCommonDirectory: string,
  journal: AuthorityCommitJournal,
  create: boolean,
): void {
  const directory = maintainerGrantStorePaths(gitCommonDirectory).journals;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStats = fs.lstatSync(directory);
  if (
    !directoryStats.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    fs.realpathSync(directory) !== path.resolve(directory)
  ) {
    throw recoveryError(
      'AUTHORITY_JOURNAL_DIRECTORY_UNSAFE',
      'Authority journal directory is unsafe.',
    );
  }
  fs.chmodSync(directory, 0o700);
  const target = path.join(directory, `${journal.sessionId}.json`);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(journal)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (create) {
      fs.linkSync(temporary, target);
      fs.unlinkSync(temporary);
    } else {
      fs.renameSync(temporary, target);
    }
    const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(directoryDescriptor);
    fs.closeSync(directoryDescriptor);
  } catch (error) {
    if (create && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw recoveryError(
        'AUTHORITY_JOURNAL_EXISTS',
        'Authority session already has a commit transaction.',
      );
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function assertJournalMatchesSession(
  journal: AuthorityCommitJournal,
  session: AuthoritySession,
): void {
  if (
    journal.sessionId !== session.sessionId ||
    journal.grantId !== session.grantId ||
    journal.changeId !== session.changeId ||
    journal.repositoryRoot !== session.repositoryRoot ||
    journal.branch !== session.branch ||
    journal.baseCommit !== session.baseCommit ||
    journal.policyBlob !== session.policyBlob ||
    journal.signer !== session.signer ||
    canonicalJson(journal.mandateBinding) !==
      canonicalJson(session.mandateBinding) ||
    JSON.stringify(journal.allowedPaths) !==
      JSON.stringify([...journal.allowedPaths].sort()) ||
    journal.allowedPaths.some((entry) => !session.allowedPaths.includes(entry))
  ) {
    throw recoveryError(
      'AUTHORITY_JOURNAL_SESSION_MISMATCH',
      'Authority journal does not match the pinned authority session.',
    );
  }
}

const CURRENT_JOURNAL_KEYS = [
  'schemaVersion',
  'state',
  'sessionId',
  'grantId',
  'changeId',
  'repositoryRoot',
  'branch',
  'baseCommit',
  'expectedTree',
  'previousIndexTree',
  'allowedPaths',
  'subject',
  'messageDigest',
  'policyBlob',
  'signer',
  'mandateBinding',
  'commitHash',
  'externalAuditRoot',
  'auditRepositoryId',
  'casAuditRecordDigest',
  'poststateAuditRecordDigest',
  'consumeAuditRecordDigest',
  'errorAuditRecordDigest',
  'rollbackAuditRecordDigest',
  'refUpdatedAt',
  'poststateVerifiedAt',
  'consumedAt',
  'rollbackStartedAt',
  'rolledBackAt',
  'reason',
  'createdAt',
  'updatedAt',
].sort();

const JOURNAL_V4_ADDED_KEYS = ['mandateBinding'];

const JOURNAL_V3_KEYS = CURRENT_JOURNAL_KEYS.filter(
  (key) => !JOURNAL_V4_ADDED_KEYS.includes(key),
);

const JOURNAL_V3_ADDED_KEYS = [
  'poststateAuditRecordDigest',
  'errorAuditRecordDigest',
  'rollbackAuditRecordDigest',
  'poststateVerifiedAt',
  'rollbackStartedAt',
  'rolledBackAt',
];

const JOURNAL_V2_KEYS = JOURNAL_V3_KEYS.filter(
  (key) => !JOURNAL_V3_ADDED_KEYS.includes(key),
);

const LEGACY_JOURNAL_V1_KEYS = JOURNAL_V2_KEYS.filter(
  (key) =>
    ![
      'externalAuditRoot',
      'auditRepositoryId',
      'casAuditRecordDigest',
      'consumeAuditRecordDigest',
      'refUpdatedAt',
      'consumedAt',
    ].includes(key),
);

function isJournal(value: unknown): value is AuthorityCommitJournal {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, CURRENT_JOURNAL_KEYS) &&
    value.schemaVersion === 4 &&
    hasValidJournalCore(value) &&
    (value.mandateBinding === null ||
      isJournalTaskMandateBinding(value.mandateBinding)) &&
    (value.externalAuditRoot === null ||
      typeof value.externalAuditRoot === 'string') &&
    (value.auditRepositoryId === null ||
      isPrefixedDigest(value.auditRepositoryId)) &&
    (value.casAuditRecordDigest === null ||
      isPrefixedDigest(value.casAuditRecordDigest)) &&
    (value.poststateAuditRecordDigest === null ||
      isPrefixedDigest(value.poststateAuditRecordDigest)) &&
    (value.consumeAuditRecordDigest === null ||
      isPrefixedDigest(value.consumeAuditRecordDigest)) &&
    (value.errorAuditRecordDigest === null ||
      isPrefixedDigest(value.errorAuditRecordDigest)) &&
    (value.rollbackAuditRecordDigest === null ||
      isPrefixedDigest(value.rollbackAuditRecordDigest)) &&
    (value.refUpdatedAt === null || isTimestamp(value.refUpdatedAt)) &&
    (value.poststateVerifiedAt === null ||
      isTimestamp(value.poststateVerifiedAt)) &&
    (value.consumedAt === null || isTimestamp(value.consumedAt)) &&
    (value.rollbackStartedAt === null ||
      isTimestamp(value.rollbackStartedAt)) &&
    (value.rolledBackAt === null || isTimestamp(value.rolledBackAt))
  );
}

function normalizeLegacyAuthorityCommitJournal(
  value: unknown,
): AuthorityCommitJournal | null {
  if (!isRecord(value)) return null;
  if (
    value.schemaVersion === 3 &&
    hasExactKeys(value, JOURNAL_V3_KEYS) &&
    hasValidJournalCore(value)
  ) {
    return normalizeJournalV3(value);
  }
  if (
    (value.schemaVersion === 1 || value.schemaVersion === 2) &&
    hasExactKeys(value, JOURNAL_V2_KEYS) &&
    hasValidJournalCore(value)
  ) {
    return normalizeJournalV2(value);
  }
  if (
    value.schemaVersion !== 1 ||
    !hasExactKeys(value, LEGACY_JOURNAL_V1_KEYS) ||
    !hasValidJournalCore(value) ||
    ![
      'preparing',
      'commit-created',
      'ref-updated',
      'consumed',
      'revoked',
    ].includes(String(value.state))
  ) {
    return null;
  }
  const normalized = {
    ...value,
    schemaVersion: 4,
    mandateBinding: null,
    externalAuditRoot: null,
    auditRepositoryId: null,
    casAuditRecordDigest: null,
    poststateAuditRecordDigest: null,
    consumeAuditRecordDigest: null,
    errorAuditRecordDigest: null,
    rollbackAuditRecordDigest: null,
    refUpdatedAt: null,
    poststateVerifiedAt: null,
    consumedAt: null,
    rollbackStartedAt: null,
    rolledBackAt: null,
  };
  return isJournal(normalized) ? normalized : null;
}

function normalizeJournalV2(
  value: Record<string, unknown>,
): AuthorityCommitJournal | null {
  const normalized = {
    ...value,
    schemaVersion: 4,
    mandateBinding: null,
    poststateAuditRecordDigest: null,
    errorAuditRecordDigest: null,
    rollbackAuditRecordDigest: null,
    poststateVerifiedAt: null,
    rollbackStartedAt: null,
    rolledBackAt: null,
  };
  return isJournal(normalized) ? normalized : null;
}

function normalizeJournalV3(
  value: Record<string, unknown>,
): AuthorityCommitJournal | null {
  const normalized = {
    ...value,
    schemaVersion: 4,
    mandateBinding: null,
  };
  return isJournal(normalized) ? normalized : null;
}

function isJournalTaskMandateBinding(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(
      value,
      [
        'schemaVersion',
        'mandateTaskId',
        'mandateId',
        'mandateDigest',
        'changeId',
        'externalAuditRoot',
      ].sort(),
    ) &&
    value.schemaVersion === 1 &&
    typeof value.mandateTaskId === 'string' &&
    typeof value.mandateId === 'string' &&
    typeof value.mandateDigest === 'string' &&
    /^[0-9a-f]{64}$/.test(value.mandateDigest) &&
    typeof value.changeId === 'string' &&
    typeof value.externalAuditRoot === 'string' &&
    path.isAbsolute(value.externalAuditRoot) &&
    path.normalize(value.externalAuditRoot) === value.externalAuditRoot
  );
}

function hasValidJournalCore(value: Record<string, unknown>): boolean {
  return (
    [
      'preparing',
      'commit-created',
      'cas-prepared',
      'ref-updated',
      'rollback-prepared',
      'rolled-back',
      'consumed',
      'audited',
      'revoked',
    ].includes(String(value.state)) &&
    typeof value.sessionId === 'string' &&
    typeof value.grantId === 'string' &&
    typeof value.changeId === 'string' &&
    typeof value.repositoryRoot === 'string' &&
    typeof value.branch === 'string' &&
    typeof value.subject === 'string' &&
    typeof value.signer === 'string' &&
    Array.isArray(value.allowedPaths) &&
    value.allowedPaths.every((entry) => typeof entry === 'string') &&
    isObjectId(value.baseCommit) &&
    isObjectId(value.expectedTree) &&
    isObjectId(value.previousIndexTree) &&
    isObjectId(value.policyBlob) &&
    typeof value.messageDigest === 'string' &&
    /^[0-9a-f]{64}$/.test(value.messageDigest) &&
    (value.commitHash === null || isObjectId(value.commitHash)) &&
    (value.reason === null || typeof value.reason === 'string') &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((entry, index) => entry === expected[index])
  );
}

function result(
  session: AuthoritySession,
  journal: AuthorityCommitJournal,
  commitHash: string,
): AuthorityCommitResult {
  return {
    session,
    grantId: journal.grantId,
    commitHash,
    changedPaths: [...journal.allowedPaths],
    journalState: journal.state === 'audited' ? 'audited' : 'consumed',
  };
}

function requireCommitHash(journal: AuthorityCommitJournal): string {
  if (!journal.commitHash) {
    throw recoveryError(
      'AUTHORITY_JOURNAL_COMMIT_MISSING',
      'Authority journal does not identify its commit object.',
    );
  }
  return journal.commitHash;
}

function assertObjectId(value: string): string {
  if (!isObjectId(value)) {
    throw recoveryError(
      'AUTHORITY_OBJECT_ID_INVALID',
      'Authority transaction requires full Git object IDs.',
    );
  }
  return value;
}

function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value);
}

function isPrefixedDigest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function exactDate(value: Date): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw recoveryError(
      'AUTHORITY_RECOVERY_TIME_INVALID',
      'Authority recovery requires an exact timestamp.',
    );
  }
  return date;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function recoveryError(code: string, message: string) {
  return workflowError(code, message, ExitCode.staleState);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
