import fs from 'node:fs';
import path from 'node:path';

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
  recordAuthorityCommitCreated,
  recordAuthorityRefUpdated,
  recoverAuthorityCommit,
  verifyCreatedAuthorityCommit,
  type AuthorityCommitResult,
} from './maintainer-recovery.ts';
import { readCurrentAuthorityCheckReport } from './maintainer-report.ts';
import {
  failAuthoritySession,
  inspectActiveAuthoritySession,
  type AuthoritySessionOptions,
} from './maintainer-session.ts';
import { maintainerGrantStorePaths } from './maintainer-store.ts';
import { createInteractiveSshSigner } from './maintainer-signer.ts';
import { withRepositoryLifecycleOperation } from './session-store.ts';

export type AuthorityCommitOptions = AuthoritySessionOptions & {
  testCrashAfter?: 'commit-created' | 'ref-updated';
};

export class SimulatedAuthorityCrash extends Error {
  constructor(state: 'commit-created' | 'ref-updated') {
    super(`Simulated authority crash after ${state}.`);
    this.name = 'SimulatedAuthorityCrash';
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
    return recoverAuthorityCommit(cwd, requestedSessionId, options.now);
  }

  const inspection = inspectActiveAuthoritySession(
    cwd,
    requestedSessionId,
    options,
  );
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
          options,
        );
        if (
          JSON.stringify(current.session) !== JSON.stringify(inspection.session)
        ) {
          throw commitError(
            'AUTHORITY_SESSION_CHANGED',
            'Authority session changed before commit creation.',
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
        });
        journalCreated = true;
        const commitHash = createSignedAuthorityCommitObject(
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
        updateManagedRef(
          current.git.repositoryRoot,
          current.session.baseCommit,
          commitHash,
        );
        journal = recordAuthorityRefUpdated(
          current.session.gitCommonDirectory,
          journal,
          exactDate(options.now ?? new Date()),
        );
        if (options.testCrashAfter === 'ref-updated') {
          throw new SimulatedAuthorityCrash('ref-updated');
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
    return recoverAuthorityCommit(cwd, requestedSessionId, options.now);
  } catch (error) {
    if (error instanceof SimulatedAuthorityCrash) {
      throw error;
    }
    if (journalCreated) {
      try {
        return recoverAuthorityCommit(cwd, requestedSessionId, options.now);
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
