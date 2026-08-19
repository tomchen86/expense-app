import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import {
  discoverRepository,
  fingerprintRepositoryProjection,
  type GitState,
} from '../../repository-transaction/git.ts';
import {
  createInvestigationV3Blocker,
  validateForAuthority,
  type InvestigationManifestV3,
  type InvestigationV3Blocker,
  type InvestigationV3FailureCode,
} from '../../../modules/investigation/manifest/investigation-manifest.ts';

const DIGEST = /^[0-9a-f]{64}$/;

export type InvestigationManifestPublicationPaths = {
  manifestPath: string;
  currentRefPath: string;
  journalPath: string;
};

export type InvestigationManifestPublicationSnapshot = {
  repositoryId: string;
  changeId: string;
  investigationId: string;
  sessionRevision: number;
  sessionSnapshotDigest: string;
  currentRefDigest: string;
};

export type InvestigationManifestPublicationLifecycleIdentity = Omit<
  InvestigationManifestPublicationSnapshot,
  'currentRefDigest'
>;

export type InvestigationManifestPublicationPhase =
  | 'candidate-written'
  | 'journal-prepared'
  | 'manifest-installed'
  | 'current-ref-published'
  | 'journal-committed';

export type InvestigationManifestPublicationObservationSource =
  | {
      operation: 'publish' | 'inspect' | 'resume';
      paths: InvestigationManifestPublicationPaths;
    }
  | { operation: 'read-ref'; currentRefPath: string };

export type InvestigationManifestPublicationStateObservation = Readonly<{
  schemaVersion: 1;
  kind: 'investigation-manifest-publication-state';
  source: InvestigationManifestPublicationObservationSource;
  recoveryKind: 'none' | 'pre-ref' | 'post-ref' | 'committed' | 'blocked';
  artifacts: readonly Readonly<{
    path: string;
    state: 'unsafe' | 'missing' | 'file' | 'symlink' | 'directory' | 'other';
    contentSha256: string | null;
  }>[];
}>;

export function investigationManifestPublicationNamespace(
  identity: Pick<
    InvestigationManifestPublicationLifecycleIdentity,
    'repositoryId' | 'changeId' | 'investigationId'
  >,
): string {
  return `investigation-v3-publication/${digest({
    schema: 'investigation-manifest-publication-namespace.v1',
    repositoryId: identity.repositoryId,
    changeId: identity.changeId,
    investigationId: identity.investigationId,
  })}`;
}

export function investigationManifestPublicationSourceMatchesLifecycle(
  source: InvestigationManifestPublicationObservationSource,
  lifecycle: InvestigationManifestPublicationLifecycleIdentity,
): boolean {
  const namespace = investigationManifestPublicationNamespace(lifecycle);
  const marker = `${namespace}/`;
  const sourcePaths =
    source.operation === 'read-ref'
      ? [source.currentRefPath]
      : [
          source.paths.manifestPath,
          source.paths.currentRefPath,
          source.paths.journalPath,
        ];
  const roots = sourcePaths.map((candidate) => {
    if (
      typeof candidate !== 'string' ||
      path.isAbsolute(candidate) ||
      candidate.includes('\\') ||
      candidate.split('/').some((segment) => segment === '..')
    ) {
      return null;
    }
    const offset = candidate.indexOf(marker);
    if (offset < 0 || (offset > 0 && candidate[offset - 1] !== '/')) {
      return null;
    }
    return candidate.slice(0, offset + namespace.length);
  });
  return roots[0] !== null && roots.every((root) => root === roots[0]);
}

export type InvestigationManifestPublicationFailure = Readonly<{
  schemaVersion: 1;
  kind: 'investigation-manifest-publication-failure';
  lifecycle: InvestigationManifestPublicationLifecycleIdentity;
  blocker: InvestigationV3Blocker;
  source: Readonly<{
    schemaVersion: 1;
    observation: InvestigationManifestPublicationObservationSource;
    failureIdentity: string;
    emittedPublicationStateDigest: `sha256:${string}`;
    emittedGitStateDigest: `sha256:${string}`;
    recoveryPolicy: 'central-grant' | 'idempotent-post-ref';
    emissionDigest: `sha256:${string}`;
  }>;
}>;

type WithTransitionLock = <T>(
  operation: (snapshot: InvestigationManifestPublicationSnapshot) => T,
) => T;

type CurrentManifestRef = {
  schemaVersion: 1;
  kind: 'investigation-manifest-current';
  repositoryId: string;
  changeId: string;
  investigationId: string;
  manifestDigest: string;
  investigationTargetDigest: string;
  manifestPath: string;
};

type PublicationJournal = {
  schemaVersion: 1;
  kind: 'investigation-manifest-publication';
  state: 'prepared' | 'committed';
  transactionId: string;
  paths: InvestigationManifestPublicationPaths & { candidatePath: string };
  expected: InvestigationManifestPublicationSnapshot;
  manifestDigest: string;
  investigationTargetDigest: string;
  currentRef: CurrentManifestRef;
};

type PublicationResult =
  | {
      outcome: 'published';
      manifestDigest: string;
      investigationTargetDigest: string;
      transactionId: string;
    }
  | {
      outcome: 'blocked';
      blocker: InvestigationV3Blocker;
      failure: InvestigationManifestPublicationFailure;
    };

/**
 * Low-level, lock-scoped Manifest publication transaction. It neither requests
 * nor consumes a human grant. Once the central transition registry exists, a
 * registered transition definition is the only authority surface that may
 * invoke this executor for a protected recovery choice.
 */
export function publishInvestigationManifestV3(input: {
  repositoryRoot: string;
  paths: InvestigationManifestPublicationPaths;
  manifest: InvestigationManifestV3;
  expected: InvestigationManifestPublicationSnapshot;
  withTransitionLock: WithTransitionLock;
  observePhase?: (phase: InvestigationManifestPublicationPhase) => void;
}): PublicationResult {
  let mutationPhase: InvestigationManifestPublicationPhase | null = null;
  let failureCandidate: unknown = {
    paths: input.paths,
    expected: input.expected,
    manifestDigest: input.manifest.manifestDigest,
  };
  try {
    assertPublicationSourceLifecycleBinding(
      { operation: 'publish', paths: input.paths },
      lifecycleIdentity(input.expected),
    );
    const paths = normalizePaths(input.repositoryRoot, input.paths);
    const validated = validateForAuthority({
      repositoryRoot: input.repositoryRoot,
      manifest: input.manifest,
      expected: authorityExpected(input.expected),
    });
    if (validated.outcome !== 'verified') {
      return publicationBlockedWithCode({
        repositoryRoot: input.repositoryRoot,
        lifecycle: lifecycleIdentity(input.expected),
        source: { operation: 'publish', paths: input.paths },
        candidate: {
          expected: input.expected,
          manifestDigest: input.manifest.manifestDigest,
          validationFailureIdentity: validated.blocker.failureIdentity,
        },
        failureCode: validated.blocker.failureCode,
        message: 'Manifest failed authority validation before publication.',
      });
    }

    const currentRef = currentRefFor(input.paths.manifestPath, input.manifest);
    const transactionId = digest({
      schema: 'investigation-manifest-publication-transaction.v1',
      expected: input.expected,
      currentRef,
    });
    const candidatePath = candidateRelativePath(
      input.paths.manifestPath,
      transactionId,
    );
    const journal: PublicationJournal = {
      schemaVersion: 1,
      kind: 'investigation-manifest-publication',
      state: 'prepared',
      transactionId,
      paths: { ...input.paths, candidatePath },
      expected: structuredClone(input.expected),
      manifestDigest: input.manifest.manifestDigest,
      investigationTargetDigest:
        input.manifest.investigationApproval.investigationTargetDigest,
      currentRef,
    };
    failureCandidate = journal;
    return input.withTransitionLock((snapshot) => {
      assertSnapshot(snapshot, input.expected);
      if (
        publicationRefDigest(
          input.repositoryRoot,
          input.paths.currentRefPath,
        ) !== input.expected.currentRefDigest
      ) {
        throw publicationFailure(
          'REVIEW_TARGET_STALE',
          'Current investigation authority ref changed before publication.',
        );
      }
      assertManifestTargetPreservesCurrentAuthority(
        paths.currentRef,
        currentRef,
      );
      mutationPhase = 'candidate-written';
      writeCanonical(paths.absolute(candidatePath), input.manifest);
      input.observePhase?.('candidate-written');
      mutationPhase = 'journal-prepared';
      writeCanonical(paths.journal, journal);
      input.observePhase?.('journal-prepared');
      mutationPhase = 'manifest-installed';
      installCandidate(paths.absolute(candidatePath), paths.manifest, journal);
      input.observePhase?.('manifest-installed');
      mutationPhase = 'current-ref-published';
      writeCanonical(paths.currentRef, currentRef);
      input.observePhase?.('current-ref-published');
      mutationPhase = 'journal-committed';
      writeCanonical(paths.journal, { ...journal, state: 'committed' });
      input.observePhase?.('journal-committed');
      return publishedResult(journal);
    });
  } catch (error) {
    return publicationBlocked({
      repositoryRoot: input.repositoryRoot,
      lifecycle: lifecycleIdentity(input.expected),
      source: { operation: 'publish', paths: input.paths },
      candidate: failureCandidate,
      mutationPhase,
      error,
    });
  }
}

export function inspectInvestigationManifestPublication(input: {
  repositoryRoot: string;
  paths: InvestigationManifestPublicationPaths;
  lifecycle: InvestigationManifestPublicationLifecycleIdentity;
}):
  | { outcome: 'none' }
  | {
      outcome: 'recoverable';
      transactionId: string;
      recoveryKind: 'pre-ref';
      blocker: InvestigationV3Blocker;
      failure: InvestigationManifestPublicationFailure;
    }
  | {
      outcome: 'recoverable';
      transactionId: string;
      recoveryKind: 'post-ref';
    }
  | { outcome: 'committed'; transactionId: string }
  | {
      outcome: 'blocked';
      blocker: InvestigationV3Blocker;
      failure: InvestigationManifestPublicationFailure;
    } {
  try {
    assertPublicationSourceLifecycleBinding(
      { operation: 'inspect', paths: input.paths },
      input.lifecycle,
    );
    const paths = normalizePaths(input.repositoryRoot, input.paths);
    if (!fs.existsSync(paths.journal)) {
      const candidate = validatedCandidateResidue(
        input.repositoryRoot,
        input.paths,
        input.lifecycle,
      );
      if (candidate === null) return { outcome: 'none' };
      return publicationBlockedWithCode({
        repositoryRoot: input.repositoryRoot,
        lifecycle: input.lifecycle,
        source: { operation: 'inspect', paths: input.paths },
        candidate: {
          paths: input.paths,
          candidatePath: candidate.candidatePath,
          transactionId: candidate.transactionId,
        },
        failureCode: 'PUBLICATION_RECOVERY_REQUIRED',
        message:
          'Manifest publication stopped after candidate creation and before its journal was durable.',
      });
    }
    const journal = readJournal(paths.journal, input.paths);
    assertLifecycleIdentity(journal.expected, input.lifecycle);
    if (journal.state === 'committed') {
      assertInstalledState(paths, journal);
      return { outcome: 'committed', transactionId: journal.transactionId };
    }
    const candidate = paths.absolute(journal.paths.candidatePath);
    if (!fs.existsSync(candidate) && !fs.existsSync(paths.manifest)) {
      throw publicationFailure(
        'REPLAY_INPUT_MISSING',
        'Prepared publication has neither candidate nor installed Manifest.',
      );
    }
    if (currentRefMatches(paths.currentRef, journal.currentRef)) {
      assertInstalledState(paths, journal);
      return {
        outcome: 'recoverable',
        transactionId: journal.transactionId,
        recoveryKind: 'post-ref',
      };
    }
    const failure = publicationBlockedWithCode({
      repositoryRoot: input.repositoryRoot,
      lifecycle: input.lifecycle,
      source: { operation: 'inspect', paths: input.paths },
      candidate: { journal, recoveryKind: 'pre-ref' },
      failureCode: 'PUBLICATION_RECOVERY_REQUIRED',
      message:
        'Manifest publication stopped before its current authority ref was installed.',
    });
    return {
      outcome: 'recoverable',
      transactionId: journal.transactionId,
      recoveryKind: 'pre-ref',
      blocker: failure.blocker,
      failure: failure.failure,
    };
  } catch (error) {
    return publicationBlocked({
      repositoryRoot: input.repositoryRoot,
      lifecycle: input.lifecycle,
      source: { operation: 'inspect', paths: input.paths },
      candidate: input.paths,
      error,
    });
  }
}

export function resumeInvestigationManifestPublication(input: {
  repositoryRoot: string;
  paths: InvestigationManifestPublicationPaths;
  lifecycle: InvestigationManifestPublicationLifecycleIdentity;
  withTransitionLock: WithTransitionLock;
  observePhase?: (phase: InvestigationManifestPublicationPhase) => void;
}): PublicationResult {
  let paths: ReturnType<typeof normalizePaths>;
  let journal: PublicationJournal;
  let mutationPhase: InvestigationManifestPublicationPhase | null = null;
  try {
    assertPublicationSourceLifecycleBinding(
      { operation: 'resume', paths: input.paths },
      input.lifecycle,
    );
    paths = normalizePaths(input.repositoryRoot, input.paths);
    journal = readJournal(paths.journal, input.paths);
    assertLifecycleIdentity(journal.expected, input.lifecycle);
    if (journal.state === 'committed') {
      assertInstalledState(paths, journal);
      return publishedResult(journal);
    }
  } catch (error) {
    return publicationBlocked({
      repositoryRoot: input.repositoryRoot,
      lifecycle: input.lifecycle,
      source: { operation: 'resume', paths: input.paths },
      candidate: input.paths,
      error,
    });
  }

  try {
    return input.withTransitionLock((snapshot) => {
      assertSnapshotIdentity(snapshot, journal.expected);
      const desiredRefInstalled = currentRefMatches(
        paths.currentRef,
        journal.currentRef,
      );
      const currentRefDigest = publicationRefDigest(
        input.repositoryRoot,
        input.paths.currentRefPath,
      );
      if (
        currentRefDigest !== journal.expected.currentRefDigest &&
        !desiredRefInstalled
      ) {
        throw publicationFailure(
          'REVIEW_TARGET_STALE',
          'Current investigation authority ref changed during recovery.',
        );
      }

      const candidate = paths.absolute(journal.paths.candidatePath);
      const source = fs.existsSync(candidate) ? candidate : paths.manifest;
      const rawManifest = readJson(source);
      const validated = validateForAuthority({
        repositoryRoot: input.repositoryRoot,
        manifest: rawManifest,
        expected: authorityExpected(journal.expected),
      });
      if (
        validated.outcome !== 'verified' ||
        validated.manifestDigest !== journal.manifestDigest ||
        validated.investigationTargetDigest !==
          journal.investigationTargetDigest
      ) {
        throw publicationFailure(
          'RECONSTRUCTION_MISMATCH',
          'Prepared publication Manifest no longer matches its journal.',
        );
      }
      if (!desiredRefInstalled) {
        assertManifestTargetPreservesCurrentAuthority(
          paths.currentRef,
          journal.currentRef,
        );
      }
      if (source === candidate) {
        mutationPhase = 'manifest-installed';
        installCandidate(candidate, paths.manifest, journal);
        input.observePhase?.('manifest-installed');
      } else {
        assertManifestMatchesJournal(paths.manifest, journal);
      }
      if (desiredRefInstalled) mutationPhase = 'current-ref-published';
      if (!desiredRefInstalled) {
        mutationPhase = 'current-ref-published';
        writeCanonical(paths.currentRef, journal.currentRef);
        input.observePhase?.('current-ref-published');
      }
      mutationPhase = 'journal-committed';
      writeCanonical(paths.journal, { ...journal, state: 'committed' });
      input.observePhase?.('journal-committed');
      return publishedResult(journal);
    });
  } catch (error) {
    return publicationBlocked({
      repositoryRoot: input.repositoryRoot,
      lifecycle: input.lifecycle,
      source: { operation: 'resume', paths: input.paths },
      candidate: journal,
      mutationPhase,
      error,
    });
  }
}

export function readInvestigationPublicationRefState(input: {
  repositoryRoot: string;
  currentRefPath: string;
  lifecycle: InvestigationManifestPublicationLifecycleIdentity;
}):
  | { outcome: 'read'; currentRefDigest: string }
  | {
      outcome: 'blocked';
      blocker: InvestigationV3Blocker;
      failure: InvestigationManifestPublicationFailure;
    } {
  try {
    assertPublicationSourceLifecycleBinding(
      { operation: 'read-ref', currentRefPath: input.currentRefPath },
      input.lifecycle,
    );
    return {
      outcome: 'read',
      currentRefDigest: publicationRefDigest(
        input.repositoryRoot,
        input.currentRefPath,
      ),
    };
  } catch (error) {
    return publicationBlocked({
      repositoryRoot: input.repositoryRoot,
      lifecycle: input.lifecycle,
      source: { operation: 'read-ref', currentRefPath: input.currentRefPath },
      candidate: { currentRefPath: input.currentRefPath },
      error,
    });
  }
}

function assertPublicationSourceLifecycleBinding(
  source: InvestigationManifestPublicationObservationSource,
  lifecycle: InvestigationManifestPublicationLifecycleIdentity,
): void {
  if (
    !investigationManifestPublicationSourceMatchesLifecycle(source, lifecycle)
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication paths are outside the lifecycle-owned namespace.',
    );
  }
}

/**
 * Read-only, source-owned observation used by the central Grant adapter. It
 * contains no Grant state and never follows a symlink or trusts journal bytes.
 */
export function observeInvestigationManifestPublicationState(input: {
  repositoryRoot: string;
  source: InvestigationManifestPublicationObservationSource;
}): InvestigationManifestPublicationStateObservation {
  let artifacts: InvestigationManifestPublicationStateObservation['artifacts'];
  let recoveryKind: InvestigationManifestPublicationStateObservation['recoveryKind'];
  try {
    artifacts =
      input.source.operation === 'read-ref'
        ? [
            observePublicationArtifact(
              input.repositoryRoot,
              input.source.currentRefPath,
            ),
          ]
        : observePublicationArtifacts(input.repositoryRoot, input.source.paths);
    recoveryKind = publicationRecoveryKind(input.repositoryRoot, input.source);
  } catch {
    const declared =
      input.source.operation === 'read-ref'
        ? [input.source.currentRefPath]
        : [
            input.source.paths.manifestPath,
            input.source.paths.currentRefPath,
            input.source.paths.journalPath,
          ];
    artifacts = Object.freeze(
      [...new Set(declared)].sort().map((artifactPath) =>
        Object.freeze({
          path: artifactPath,
          state: 'unsafe' as const,
          contentSha256: null,
        }),
      ),
    );
    recoveryKind = 'blocked';
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: 'investigation-manifest-publication-state' as const,
    source: structuredClone(input.source),
    recoveryKind,
    artifacts: Object.freeze(artifacts),
  });
}

function publicationRefDigest(
  repositoryRoot: string,
  relativePath: string,
): string {
  const observed = readStablePublicationFile(repositoryRoot, relativePath);
  if (observed === null) {
    return digest({
      schema: 'investigation-publication-ref-state.v1',
      exists: false,
    });
  }
  return digest({
    schema: 'investigation-publication-ref-state.v1',
    exists: true,
    contentSha256: crypto.createHash('sha256').update(observed).digest('hex'),
  });
}

function normalizePaths(
  repositoryRoot: string,
  paths: InvestigationManifestPublicationPaths,
): {
  repositoryRoot: string;
  manifest: string;
  currentRef: string;
  journal: string;
  absolute: (relativePath: string) => string;
} {
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const manifest = resolveRelative(root, paths.manifestPath);
  const currentRef = resolveRelative(root, paths.currentRefPath);
  const journal = resolveRelative(root, paths.journalPath);
  if (new Set([manifest, currentRef, journal]).size !== 3) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication paths must be distinct.',
    );
  }
  return {
    repositoryRoot: root,
    manifest,
    currentRef,
    journal,
    absolute: (relativePath) => resolveRelative(root, relativePath),
  };
}

function resolveRelative(repositoryRoot: string, relativePath: string): string {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes('\0') ||
    relativePath.split('/').some((segment) => segment === '..')
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication path must be repository-relative.',
    );
  }
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const absolute = path.resolve(root, relativePath);
  if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication path escapes the repository.',
    );
  }
  assertPlainPublicationDirectoryChain(root, path.dirname(absolute), true);
  return absolute;
}

function candidateRelativePath(
  manifestPath: string,
  transactionId: string,
): string {
  return `${manifestPath}.${transactionId}.candidate`;
}

function candidateResidue(
  repositoryRoot: string,
  paths: InvestigationManifestPublicationPaths,
): string[] {
  const manifest = resolveRelative(repositoryRoot, paths.manifestPath);
  const directory = path.dirname(manifest);
  const prefix = `${path.basename(manifest)}.`;
  const suffix = '.candidate';
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stats) return [];
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Manifest publication directory is unsafe.',
    );
  }
  return fs
    .readdirSync(directory)
    .filter((name) => {
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) return false;
      return DIGEST.test(name.slice(prefix.length, -suffix.length));
    })
    .map((name) =>
      path.posix.join(path.posix.dirname(paths.manifestPath), name),
    )
    .sort();
}

function validatedCandidateResidue(
  repositoryRoot: string,
  paths: InvestigationManifestPublicationPaths,
  lifecycle: InvestigationManifestPublicationLifecycleIdentity,
): { candidatePath: string; transactionId: string } | null {
  const candidates = candidateResidue(repositoryRoot, paths);
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Candidate-only publication residue is ambiguous.',
    );
  }
  const candidatePath = candidates[0]!;
  const candidate = readJson(resolveRelative(repositoryRoot, candidatePath));
  const expected: InvestigationManifestPublicationSnapshot = {
    ...lifecycle,
    currentRefDigest: publicationRefDigest(
      repositoryRoot,
      paths.currentRefPath,
    ),
  };
  const validated = validateForAuthority({
    repositoryRoot,
    manifest: candidate,
    expected: authorityExpected(expected),
  });
  if (validated.outcome !== 'verified') {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Candidate-only publication residue is not a valid Manifest for the current lifecycle.',
    );
  }
  const currentRef = currentRefFor(paths.manifestPath, validated.manifest);
  const transactionId = digest({
    schema: 'investigation-manifest-publication-transaction.v1',
    expected,
    currentRef,
  });
  if (
    candidatePath !== candidateRelativePath(paths.manifestPath, transactionId)
  ) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Candidate-only publication residue does not match its lifecycle transaction.',
    );
  }
  return { candidatePath, transactionId };
}

function observePublicationArtifacts(
  repositoryRoot: string,
  paths: InvestigationManifestPublicationPaths,
): InvestigationManifestPublicationStateObservation['artifacts'] {
  const declared = [
    paths.manifestPath,
    paths.currentRefPath,
    paths.journalPath,
  ];
  let candidates: string[] = [];
  try {
    candidates = candidateResidue(repositoryRoot, paths);
  } catch {
    // The declared artifact observations below retain the unsafe state.
  }
  const journalCandidate = observedJournalCandidatePath(repositoryRoot, paths);
  if (journalCandidate !== null) candidates.push(journalCandidate);
  return [...new Set([...declared, ...candidates])]
    .sort()
    .map((relativePath) =>
      observePublicationArtifact(repositoryRoot, relativePath),
    );
}

function observePublicationArtifact(
  repositoryRoot: string,
  relativePath: string,
): InvestigationManifestPublicationStateObservation['artifacts'][number] {
  let absolute: string;
  try {
    absolute = resolveRelative(repositoryRoot, relativePath);
  } catch {
    return Object.freeze({
      path: relativePath,
      state: 'unsafe' as const,
      contentSha256: null,
    });
  }
  const stats = fs.lstatSync(absolute, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (!stats) {
    return Object.freeze({
      path: relativePath,
      state: 'missing' as const,
      contentSha256: null,
    });
  }
  if (stats.isSymbolicLink()) {
    return Object.freeze({
      path: relativePath,
      state: 'symlink' as const,
      contentSha256: null,
    });
  }
  if (stats.isDirectory()) {
    return Object.freeze({
      path: relativePath,
      state: 'directory' as const,
      contentSha256: null,
    });
  }
  if (!stats.isFile()) {
    return Object.freeze({
      path: relativePath,
      state: 'other' as const,
      contentSha256: null,
    });
  }
  let bytes: Buffer;
  try {
    bytes =
      readStablePublicationFile(repositoryRoot, relativePath) ??
      Buffer.alloc(0);
  } catch {
    return Object.freeze({
      path: relativePath,
      state: 'unsafe' as const,
      contentSha256: null,
    });
  }
  return Object.freeze({
    path: relativePath,
    state: 'file' as const,
    contentSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  });
}

function publicationRecoveryKind(
  repositoryRoot: string,
  source: InvestigationManifestPublicationObservationSource,
): InvestigationManifestPublicationStateObservation['recoveryKind'] {
  if (source.operation === 'read-ref') {
    const state = observePublicationArtifact(
      repositoryRoot,
      source.currentRefPath,
    ).state;
    return state === 'missing' || state === 'file' ? 'none' : 'blocked';
  }
  try {
    const paths = normalizePaths(repositoryRoot, source.paths);
    if (!fs.existsSync(paths.journal)) {
      return candidateResidue(repositoryRoot, source.paths).length > 0
        ? 'blocked'
        : 'none';
    }
    const journal = readJournal(paths.journal, source.paths);
    if (journal.state === 'committed') {
      assertInstalledState(paths, journal);
      return 'committed';
    }
    if (currentRefMatches(paths.currentRef, journal.currentRef)) {
      assertInstalledState(paths, journal);
      return 'post-ref';
    }
    return 'pre-ref';
  } catch {
    return 'blocked';
  }
}

function observedJournalCandidatePath(
  repositoryRoot: string,
  paths: InvestigationManifestPublicationPaths,
): string | null {
  let journalPath: string;
  try {
    journalPath = resolveRelative(repositoryRoot, paths.journalPath);
  } catch {
    return null;
  }
  try {
    return readJournal(journalPath, paths).paths.candidatePath;
  } catch {
    return null;
  }
}

function currentRefFor(
  manifestPath: string,
  manifest: InvestigationManifestV3,
): CurrentManifestRef {
  return {
    schemaVersion: 1,
    kind: 'investigation-manifest-current',
    repositoryId: manifest.repositoryId,
    changeId: manifest.changeId,
    investigationId: manifest.investigationId,
    manifestDigest: manifest.manifestDigest,
    investigationTargetDigest:
      manifest.investigationApproval.investigationTargetDigest,
    manifestPath,
  };
}

function authorityExpected(snapshot: InvestigationManifestPublicationSnapshot) {
  return {
    repositoryId: snapshot.repositoryId,
    changeId: snapshot.changeId,
    investigationId: snapshot.investigationId,
    sessionRevision: snapshot.sessionRevision,
    sessionSnapshotDigest: snapshot.sessionSnapshotDigest,
  };
}

function assertSnapshot(
  actual: InvestigationManifestPublicationSnapshot,
  expected: InvestigationManifestPublicationSnapshot,
): void {
  assertSnapshotIdentity(actual, expected);
  if (actual.currentRefDigest !== expected.currentRefDigest) {
    throw publicationFailure(
      'REVIEW_TARGET_STALE',
      'Lifecycle snapshot current-ref digest changed before publication.',
    );
  }
}

function assertSnapshotIdentity(
  actual: InvestigationManifestPublicationSnapshot,
  expected: InvestigationManifestPublicationSnapshot,
): void {
  const identity = (snapshot: InvestigationManifestPublicationSnapshot) => ({
    repositoryId: snapshot.repositoryId,
    changeId: snapshot.changeId,
    investigationId: snapshot.investigationId,
    sessionRevision: snapshot.sessionRevision,
    sessionSnapshotDigest: snapshot.sessionSnapshotDigest,
  });
  if (canonicalJson(identity(actual)) !== canonicalJson(identity(expected))) {
    throw publicationFailure(
      'REVIEW_TARGET_STALE',
      'Lifecycle authority snapshot changed before publication.',
    );
  }
}

function lifecycleIdentity(
  snapshot: InvestigationManifestPublicationSnapshot,
): InvestigationManifestPublicationLifecycleIdentity {
  return {
    repositoryId: snapshot.repositoryId,
    changeId: snapshot.changeId,
    investigationId: snapshot.investigationId,
    sessionRevision: snapshot.sessionRevision,
    sessionSnapshotDigest: snapshot.sessionSnapshotDigest,
  };
}

function assertLifecycleIdentity(
  actual: InvestigationManifestPublicationSnapshot,
  expected: InvestigationManifestPublicationLifecycleIdentity,
): void {
  if (canonicalJson(lifecycleIdentity(actual)) !== canonicalJson(expected)) {
    throw publicationFailure(
      'REVIEW_TARGET_STALE',
      'Publication journal lifecycle identity changed before recovery.',
    );
  }
}

function writeCanonical(filePath: string, value: unknown): void {
  const repositoryRoot = publicationRepositoryRoot(filePath);
  const directory = path.dirname(filePath);
  ensurePlainPublicationDirectoryChain(repositoryRoot, directory);
  const parentIdentity = assertPlainPublicationDirectoryChain(
    repositoryRoot,
    directory,
    false,
  );
  const targetName = path.basename(filePath);
  const temporaryName = `${targetName}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let installedIdentity: fs.BigIntStats | null = null;
  try {
    withAnchoredPublicationDirectory(
      repositoryRoot,
      directory,
      parentIdentity,
      () => {
        let descriptor: number | null = null;
        let temporaryIdentity: fs.BigIntStats | null = null;
        let replacementIdentity: fs.BigIntStats | null = null;
        let replacementInstalled = false;
        let previous: PublicationFilePreimage | null = null;
        try {
          descriptor = fs.openSync(
            temporaryName,
            fs.constants.O_CREAT |
              fs.constants.O_EXCL |
              fs.constants.O_RDWR |
              (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
            0o600,
          );
          temporaryIdentity = fs.fstatSync(descriptor, { bigint: true });
          assertAnchoredPublicationDirectoryInsideRepository(repositoryRoot);

          const bytes = Buffer.from(`${canonicalJson(value)}\n`);
          fs.writeFileSync(descriptor, bytes);
          fs.fsyncSync(descriptor);
          const afterWrite = fs.fstatSync(descriptor, { bigint: true });
          if (
            temporaryIdentity.dev !== afterWrite.dev ||
            temporaryIdentity.ino !== afterWrite.ino ||
            !afterWrite.isFile() ||
            afterWrite.nlink !== 1n ||
            afterWrite.size !== BigInt(bytes.length)
          ) {
            throw publicationFailure(
              'MANIFEST_UNREPRESENTABLE',
              'Publication temporary file changed while it was written.',
            );
          }
          const existing = fs.lstatSync(targetName, {
            bigint: true,
            throwIfNoEntry: false,
          });
          if (
            existing !== undefined &&
            (!existing.isFile() ||
              existing.isSymbolicLink() ||
              existing.nlink !== 1n)
          ) {
            throw publicationFailure(
              'MANIFEST_UNREPRESENTABLE',
              'Publication target is not a plain file.',
            );
          }
          previous =
            existing === undefined
              ? null
              : readAnchoredPublicationPreimage(targetName, existing);

          assertAnchoredPublicationDirectoryInsideRepository(repositoryRoot);
          fs.renameSync(temporaryName, targetName);
          replacementInstalled = true;
          replacementIdentity = afterWrite;
          const installed = fs.lstatSync(targetName, {
            bigint: true,
            throwIfNoEntry: false,
          });
          if (
            installed === undefined ||
            installed.dev !== afterWrite.dev ||
            installed.ino !== afterWrite.ino
          ) {
            throw publicationFailure(
              'MANIFEST_UNREPRESENTABLE',
              'Publication target changed during atomic replacement.',
            );
          }
          assertAnchoredPublicationDirectoryInsideRepository(repositoryRoot);
          fsyncDirectory('.');
          assertAnchoredPublicationDirectoryInsideRepository(repositoryRoot);
          installedIdentity = installed;
        } catch (error) {
          if (descriptor !== null) {
            fs.closeSync(descriptor);
            descriptor = null;
          }
          if (replacementInstalled && replacementIdentity !== null) {
            compensateAnchoredPublicationReplacement(
              targetName,
              replacementIdentity,
              previous,
            );
          } else if (temporaryIdentity !== null) {
            unlinkAnchoredPublicationFile(temporaryName, temporaryIdentity);
          }
          throw error;
        } finally {
          if (descriptor !== null) fs.closeSync(descriptor);
        }
      },
    );
    const installed = fs.lstatSync(filePath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    const afterRename = assertPlainPublicationDirectoryChain(
      repositoryRoot,
      directory,
      false,
    );
    if (
      installedIdentity === null ||
      installed === undefined ||
      !samePublicationFileIdentity(installedIdentity, installed) ||
      !samePublicationDirectoryChain(parentIdentity, afterRename)
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication target or parent changed during atomic replacement.',
      );
    }
  } catch (error) {
    if (error instanceof PublicationFailure) throw error;
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      error instanceof Error
        ? `Publication write failed safely: ${error.message}`
        : 'Publication write failed safely.',
    );
  }
}

function ensurePlainPublicationDirectoryChain(
  repositoryRoot: string,
  directory: string,
): void {
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const relative = path.relative(root, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication directory escapes the repository.',
    );
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const existing = fs.lstatSync(current, { throwIfNoEntry: false });
    if (existing === undefined) {
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const observed = fs.lstatSync(current, { throwIfNoEntry: false });
    if (
      observed === undefined ||
      !observed.isDirectory() ||
      observed.isSymbolicLink() ||
      fs.realpathSync(current) !== current
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication path has a non-plain ancestor directory.',
      );
    }
  }
}

function unlinkAnchoredPublicationFile(
  name: string,
  expected: fs.BigIntStats,
): void {
  try {
    const observed = fs.lstatSync(name, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      observed !== undefined &&
      observed.isFile() &&
      !observed.isSymbolicLink() &&
      observed.dev === expected.dev &&
      observed.ino === expected.ino
    ) {
      fs.unlinkSync(name);
    }
  } catch {
    // A changed pathname is never followed or removed.
  }
}

type PublicationFilePreimage = Readonly<{
  bytes: Buffer;
  mode: number;
}>;

function readAnchoredPublicationPreimage(
  name: string,
  expected: fs.BigIntStats,
): PublicationFilePreimage {
  const descriptor = fs.openSync(
    name,
    fs.constants.O_RDONLY |
      (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
  );
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      !samePublicationFileIdentity(expected, before) ||
      !samePublicationFileIdentity(before, after)
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication target changed while its recovery preimage was read.',
      );
    }
    return {
      bytes,
      mode: Number(expected.mode & 0o777n),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function compensateAnchoredPublicationReplacement(
  targetName: string,
  installed: fs.BigIntStats,
  previous: PublicationFilePreimage | null,
): void {
  const observed = fs.lstatSync(targetName, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (
    observed === undefined ||
    !observed.isFile() ||
    observed.isSymbolicLink() ||
    observed.dev !== installed.dev ||
    observed.ino !== installed.ino
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication replacement could not be identified for compensation.',
    );
  }
  if (previous === null) {
    fs.unlinkSync(targetName);
    fsyncDirectory('.');
    return;
  }

  const recoveryName = `${targetName}.${process.pid}.${crypto.randomUUID()}.restore`;
  let descriptor: number | null = null;
  let recoveryIdentity: fs.BigIntStats | null = null;
  try {
    descriptor = fs.openSync(
      recoveryName,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_RDWR |
        (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
      previous.mode,
    );
    fs.fchmodSync(descriptor, previous.mode);
    fs.writeFileSync(descriptor, previous.bytes);
    fs.fsyncSync(descriptor);
    recoveryIdentity = fs.fstatSync(descriptor, { bigint: true });
    if (
      !recoveryIdentity.isFile() ||
      recoveryIdentity.nlink !== 1n ||
      recoveryIdentity.size !== BigInt(previous.bytes.length) ||
      Number(recoveryIdentity.mode & 0o777n) !== previous.mode
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication recovery preimage could not be materialized safely.',
      );
    }
    fs.renameSync(recoveryName, targetName);
    const restoredStats = fs.lstatSync(targetName, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      restoredStats === undefined ||
      !restoredStats.isFile() ||
      restoredStats.isSymbolicLink() ||
      Number(restoredStats.mode & 0o777n) !== previous.mode
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication recovery preimage mode was not restored exactly.',
      );
    }
    const restored = readAnchoredPublicationPreimage(targetName, restoredStats);
    if (!restored.bytes.equals(previous.bytes)) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication recovery preimage was not restored exactly.',
      );
    }
    recoveryIdentity = null;
    fsyncDirectory('.');
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (recoveryIdentity !== null) {
      unlinkAnchoredPublicationFile(recoveryName, recoveryIdentity);
    }
  }
}

function withAnchoredPublicationDirectory<T>(
  repositoryRoot: string,
  directory: string,
  expected: readonly PublicationDirectoryIdentity[],
  operation: () => T,
): T {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    const anchored = fs.lstatSync('.', { bigint: true });
    const parent = expected.at(-1);
    if (
      parent === undefined ||
      !anchored.isDirectory() ||
      anchored.isSymbolicLink() ||
      anchored.dev !== parent.dev ||
      anchored.ino !== parent.ino ||
      anchored.mode !== parent.mode
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication parent directory could not be anchored safely.',
      );
    }
    assertAnchoredPublicationDirectoryInsideRepository(repositoryRoot);
    const result = operation();
    assertAnchoredPublicationDirectoryInsideRepository(repositoryRoot);
    return result;
  } finally {
    process.chdir(previous);
  }
}

function assertAnchoredPublicationDirectoryInsideRepository(
  repositoryRoot: string,
): void {
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const anchored = fs.realpathSync('.');
  if (anchored !== root && !anchored.startsWith(`${root}${path.sep}`)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication parent directory moved outside the repository.',
    );
  }
}

function installCandidate(
  candidatePath: string,
  manifestPath: string,
  journal: PublicationJournal,
): void {
  const candidateIdentity = fs.lstatSync(candidatePath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (
    candidateIdentity === undefined ||
    !candidateIdentity.isFile() ||
    candidateIdentity.isSymbolicLink() ||
    candidateIdentity.nlink !== 1n
  ) {
    throw publicationFailure(
      'REPLAY_INPUT_MISSING',
      'Manifest publication candidate is absent or unsafe.',
    );
  }
  const manifest = assertManifestMatchesJournal(candidatePath, journal);
  const existing = fs.lstatSync(manifestPath, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Manifest publication target is unsafe.',
    );
  }
  writeCanonical(manifestPath, manifest);
  assertManifestMatchesJournal(manifestPath, journal);
  const candidateAfter = fs.lstatSync(candidatePath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (
    candidateAfter === undefined ||
    !samePublicationFileIdentity(candidateIdentity, candidateAfter)
  ) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Manifest publication candidate changed during installation.',
    );
  }
  // The immutable candidate is retained as recovery evidence. Removing it
  // would introduce a destructive pathname transition that POSIX cannot make
  // conditional on the parent still being a repository descendant.
}

function assertManifestMatchesJournal(
  filePath: string,
  journal: PublicationJournal,
): InvestigationManifestV3 {
  const parsed = readJson(filePath);
  const validated = validateForAuthority({
    repositoryRoot: publicationRepositoryRoot(filePath),
    manifest: parsed,
    expected: authorityExpected(journal.expected),
  });
  if (
    validated.outcome !== 'verified' ||
    validated.manifestDigest !== journal.manifestDigest ||
    validated.investigationTargetDigest !== journal.investigationTargetDigest
  ) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Publication Manifest does not match the journalled authority state.',
    );
  }
  return validated.manifest;
}

function currentRefMatches(
  filePath: string,
  expected: CurrentManifestRef,
): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    return canonicalJson(readJson(filePath)) === canonicalJson(expected);
  } catch {
    return false;
  }
}

/**
 * Installing a candidate must never mutate the file named by the currently
 * published authority ref. Callers therefore use a fresh immutable Manifest
 * path for each changed digest and switch only the small current-ref file.
 */
function assertManifestTargetPreservesCurrentAuthority(
  currentRefPath: string,
  next: CurrentManifestRef,
): void {
  if (!fs.existsSync(currentRefPath)) return;
  const current = parseCurrentManifestRef(readJson(currentRefPath));
  if (
    current.manifestPath === next.manifestPath &&
    current.manifestDigest !== next.manifestDigest
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'A changed Manifest must use a fresh path before the authority ref is switched.',
    );
  }
}

function parseCurrentManifestRef(value: unknown): CurrentManifestRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Investigation current ref is malformed.',
    );
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    'schemaVersion',
    'kind',
    'repositoryId',
    'changeId',
    'investigationId',
    'manifestDigest',
    'investigationTargetDigest',
    'manifestPath',
  ];
  if (
    Object.keys(record).length !== expectedKeys.length ||
    !Object.keys(record).every((key) => expectedKeys.includes(key)) ||
    record.schemaVersion !== 1 ||
    record.kind !== 'investigation-manifest-current' ||
    typeof record.repositoryId !== 'string' ||
    typeof record.changeId !== 'string' ||
    typeof record.investigationId !== 'string' ||
    typeof record.manifestDigest !== 'string' ||
    !DIGEST.test(record.manifestDigest) ||
    typeof record.investigationTargetDigest !== 'string' ||
    !DIGEST.test(record.investigationTargetDigest) ||
    typeof record.manifestPath !== 'string'
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Investigation current ref is malformed.',
    );
  }
  return record as CurrentManifestRef;
}

function assertInstalledState(
  paths: ReturnType<typeof normalizePaths>,
  journal: PublicationJournal,
): void {
  assertManifestMatchesJournal(paths.manifest, journal);
  if (!currentRefMatches(paths.currentRef, journal.currentRef)) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Committed publication current ref is missing or stale.',
    );
  }
}

function readJournal(
  journalPath: string,
  expectedPaths: InvestigationManifestPublicationPaths,
): PublicationJournal {
  const value = readJson(journalPath);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication journal is malformed.',
    );
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const expectedKeys = [
    'schemaVersion',
    'kind',
    'state',
    'transactionId',
    'paths',
    'expected',
    'manifestDigest',
    'investigationTargetDigest',
    'currentRef',
  ];
  if (
    keys.length !== expectedKeys.length ||
    !keys.every((key) => expectedKeys.includes(key)) ||
    record.schemaVersion !== 1 ||
    record.kind !== 'investigation-manifest-publication' ||
    (record.state !== 'prepared' && record.state !== 'committed') ||
    typeof record.transactionId !== 'string' ||
    !DIGEST.test(record.transactionId) ||
    typeof record.manifestDigest !== 'string' ||
    !DIGEST.test(record.manifestDigest) ||
    typeof record.investigationTargetDigest !== 'string' ||
    !DIGEST.test(record.investigationTargetDigest)
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication journal identity is malformed.',
    );
  }
  const paths = record.paths as PublicationJournal['paths'];
  if (
    typeof paths !== 'object' ||
    paths === null ||
    canonicalJson({
      manifestPath: paths.manifestPath,
      currentRefPath: paths.currentRefPath,
      journalPath: paths.journalPath,
    }) !== canonicalJson(expectedPaths) ||
    typeof paths.candidatePath !== 'string'
  ) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Publication journal paths do not match the requested transaction.',
    );
  }
  const journal = record as unknown as PublicationJournal;
  const currentRef = parseCurrentManifestRef(journal.currentRef);
  assertPublicationSnapshot(journal.expected);
  const expectedTransaction = digest({
    schema: 'investigation-manifest-publication-transaction.v1',
    expected: journal.expected,
    currentRef: journal.currentRef,
  });
  if (
    expectedTransaction !== journal.transactionId ||
    currentRef.manifestDigest !== journal.manifestDigest ||
    currentRef.investigationTargetDigest !==
      journal.investigationTargetDigest ||
    currentRef.repositoryId !== journal.expected.repositoryId ||
    currentRef.changeId !== journal.expected.changeId ||
    currentRef.investigationId !== journal.expected.investigationId ||
    currentRef.manifestPath !== journal.paths.manifestPath
  ) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Publication journal binding does not match recomputation.',
    );
  }
  if (
    journal.paths.candidatePath !==
    candidateRelativePath(journal.paths.manifestPath, journal.transactionId)
  ) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Publication journal candidate path does not match its transaction.',
    );
  }
  return journal;
}

function assertPublicationSnapshot(
  value: unknown,
): asserts value is InvestigationManifestPublicationSnapshot {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 6
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication journal lifecycle snapshot is malformed.',
    );
  }
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.repositoryId !== 'string' ||
    typeof snapshot.changeId !== 'string' ||
    typeof snapshot.investigationId !== 'string' ||
    typeof snapshot.sessionRevision !== 'number' ||
    !Number.isSafeInteger(snapshot.sessionRevision) ||
    snapshot.sessionRevision < 0 ||
    typeof snapshot.sessionSnapshotDigest !== 'string' ||
    !DIGEST.test(snapshot.sessionSnapshotDigest) ||
    typeof snapshot.currentRefDigest !== 'string' ||
    !DIGEST.test(snapshot.currentRefDigest)
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication journal lifecycle snapshot is malformed.',
    );
  }
}

function readJson(filePath: string): unknown {
  const repositoryRoot = publicationRepositoryRoot(filePath);
  const relativePath = path.relative(repositoryRoot, filePath);
  let bytes: Buffer | null;
  try {
    bytes = readStablePublicationFile(repositoryRoot, relativePath);
  } catch {
    throw publicationFailure(
      'REPLAY_INPUT_MISSING',
      'Publication artifact is absent or unsafe.',
    );
  }
  if (bytes === null) {
    throw publicationFailure(
      'REPLAY_INPUT_MISSING',
      'Publication artifact is absent or unsafe.',
    );
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication artifact is not canonical JSON.',
    );
  }
}

type PublicationDirectoryIdentity = Readonly<{
  path: string;
  dev: bigint;
  ino: bigint;
  mode: bigint;
}>;

function readStablePublicationFile(
  repositoryRoot: string,
  relativePath: string,
): Buffer | null {
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const absolute = resolveRelative(root, relativePath);
  const pathBefore = fs.lstatSync(absolute, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (pathBefore === undefined) return null;
  const parentBefore = assertPlainPublicationDirectoryChain(
    root,
    path.dirname(absolute),
    false,
  );
  if (
    !pathBefore.isFile() ||
    pathBefore.isSymbolicLink() ||
    pathBefore.nlink !== 1n
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication artifact path is unsafe.',
    );
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_RDONLY |
        (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
    );
  } catch {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication artifact could not be opened safely.',
    );
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(absolute, {
      bigint: true,
      throwIfNoEntry: false,
    });
    const parentAfter = assertPlainPublicationDirectoryChain(
      root,
      path.dirname(absolute),
      false,
    );
    if (
      pathAfter === undefined ||
      !samePublicationFileIdentity(pathBefore, before) ||
      !samePublicationFileIdentity(before, after) ||
      !samePublicationFileIdentity(after, pathAfter) ||
      !samePublicationDirectoryChain(parentBefore, parentAfter)
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication artifact changed while it was observed.',
      );
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertPlainPublicationDirectoryChain(
  repositoryRoot: string,
  directory: string,
  allowMissing: boolean,
): readonly PublicationDirectoryIdentity[] {
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  if (root !== path.resolve(repositoryRoot)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication repository root is not canonical.',
    );
  }
  const relative = path.relative(root, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication directory escapes the repository.',
    );
  }
  const identities: PublicationDirectoryIdentity[] = [];
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stats = fs.lstatSync(current, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (stats === undefined) {
      if (allowMissing) break;
      throw publicationFailure(
        'REPLAY_INPUT_MISSING',
        'Publication artifact directory is absent.',
      );
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication path has a non-plain ancestor directory.',
      );
    }
    let canonical: string;
    try {
      canonical = fs.realpathSync(current);
    } catch {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication directory could not be resolved safely.',
      );
    }
    if (canonical !== current) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication path has a non-canonical ancestor directory.',
      );
    }
    identities.push({
      path: current,
      dev: stats.dev,
      ino: stats.ino,
      mode: stats.mode,
    });
  }
  return identities;
}

function samePublicationFileIdentity(
  expected: fs.BigIntStats,
  observed: fs.BigIntStats,
): boolean {
  return (
    expected.isFile() &&
    observed.isFile() &&
    !observed.isSymbolicLink() &&
    expected.dev === observed.dev &&
    expected.ino === observed.ino &&
    expected.mode === observed.mode &&
    expected.nlink === observed.nlink &&
    expected.size === observed.size &&
    expected.mtimeNs === observed.mtimeNs &&
    expected.ctimeNs === observed.ctimeNs
  );
}

function samePublicationDirectoryChain(
  expected: readonly PublicationDirectoryIdentity[],
  observed: readonly PublicationDirectoryIdentity[],
): boolean {
  return (
    expected.length === observed.length &&
    expected.every((entry, index) => {
      const current = observed[index];
      return (
        current !== undefined &&
        entry.path === current.path &&
        entry.dev === current.dev &&
        entry.ino === current.ino &&
        entry.mode === current.mode
      );
    })
  );
}

function publicationRepositoryRoot(filePath: string): string {
  let current = path.resolve(path.dirname(filePath));
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    current = path.dirname(current);
  }
  throw publicationFailure(
    'MANIFEST_UNREPRESENTABLE',
    'Publication artifact is not inside a repository.',
  );
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function publishedResult(journal: PublicationJournal): PublicationResult {
  return {
    outcome: 'published',
    manifestDigest: journal.manifestDigest,
    investigationTargetDigest: journal.investigationTargetDigest,
    transactionId: journal.transactionId,
  };
}

class PublicationFailure extends Error {
  readonly code: InvestigationV3FailureCode;

  constructor(code: InvestigationV3FailureCode, message: string) {
    super(message);
    this.name = 'PublicationFailure';
    this.code = code;
  }
}

function publicationFailure(
  code: InvestigationV3FailureCode,
  message: string,
): PublicationFailure {
  return new PublicationFailure(code, message);
}

function publicationBlocked(input: {
  repositoryRoot: string;
  lifecycle: InvestigationManifestPublicationLifecycleIdentity;
  source: InvestigationManifestPublicationObservationSource;
  candidate: unknown;
  mutationPhase?: InvestigationManifestPublicationPhase | null;
  error: unknown;
}): Extract<PublicationResult, { outcome: 'blocked' }> {
  const recoveryRequired =
    input.mutationPhase === 'candidate-written' ||
    input.mutationPhase === 'journal-prepared' ||
    input.mutationPhase === 'manifest-installed' ||
    input.mutationPhase === 'current-ref-published' ||
    input.mutationPhase === 'journal-committed';
  const recoveryPolicy =
    input.mutationPhase === 'current-ref-published' ||
    input.mutationPhase === 'journal-committed'
      ? 'idempotent-post-ref'
      : 'central-grant';
  return publicationBlockedWithCode({
    ...input,
    failureCode:
      input.error instanceof PublicationFailure
        ? input.error.code
        : recoveryRequired
          ? 'PUBLICATION_RECOVERY_REQUIRED'
          : 'RECONSTRUCTION_MISMATCH',
    recoveryPolicy,
    message:
      input.error instanceof Error
        ? input.error.message
        : 'Unknown Manifest publication failure.',
  });
}

function publicationBlockedWithCode(input: {
  repositoryRoot: string;
  lifecycle: InvestigationManifestPublicationLifecycleIdentity;
  source: InvestigationManifestPublicationObservationSource;
  candidate: unknown;
  failureCode: InvestigationV3FailureCode;
  message: string;
  recoveryPolicy?: 'central-grant' | 'idempotent-post-ref';
}): Extract<PublicationResult, { outcome: 'blocked' }> {
  const blocker = createInvestigationV3Blocker({
    attemptedTransition: 'publication',
    candidate: input.candidate,
    failureCode: input.failureCode,
    message: input.message,
  });
  const publication = observeInvestigationManifestPublicationState({
    repositoryRoot: input.repositoryRoot,
    source: input.source,
  });
  const emittedPublicationStateDigest = prefixedDigest(
    canonicalJson({
      schema: 'investigation-v3-publication-emitted-state.v1',
      publication,
    }),
  );
  const sourceWithoutEmission = {
    schemaVersion: 1 as const,
    observation: structuredClone(input.source),
    failureIdentity: blocker.failureIdentity,
    emittedPublicationStateDigest,
    emittedGitStateDigest: safePublicationGitStateDigest(input.repositoryRoot),
    recoveryPolicy: input.recoveryPolicy ?? 'central-grant',
  };
  const failure: InvestigationManifestPublicationFailure = deepFreeze({
    schemaVersion: 1,
    kind: 'investigation-manifest-publication-failure',
    lifecycle: structuredClone(input.lifecycle),
    blocker,
    source: {
      ...sourceWithoutEmission,
      emissionDigest: prefixedDigest(
        canonicalJson({
          schema: 'investigation-v3-publication-failure-emission.v1',
          lifecycle: input.lifecycle,
          blocker,
          source: sourceWithoutEmission,
        }),
      ),
    },
  });
  return deepFreeze({ outcome: 'blocked', blocker, failure });
}

export function investigationManifestPublicationFailureEmissionDigest(
  failure: Omit<InvestigationManifestPublicationFailure, 'source'> & {
    source: Omit<
      InvestigationManifestPublicationFailure['source'],
      'emissionDigest'
    >;
  },
): `sha256:${string}` {
  return prefixedDigest(
    canonicalJson({
      schema: 'investigation-v3-publication-failure-emission.v1',
      lifecycle: failure.lifecycle,
      blocker: failure.blocker,
      source: failure.source,
    }),
  );
}

export function investigationManifestPublicationStateDigest(
  publication: InvestigationManifestPublicationStateObservation,
): `sha256:${string}` {
  return prefixedDigest(
    canonicalJson({
      schema: 'investigation-v3-publication-emitted-state.v1',
      publication,
    }),
  );
}

export function investigationManifestPublicationGitStateDigest(
  git: GitState,
): `sha256:${string}` {
  let worktreeFingerprint: string;
  try {
    worktreeFingerprint = fingerprintRepositoryProjection(
      git.repositoryRoot,
      git.head,
      git.statusEntries,
    );
  } catch (error) {
    return prefixedDigest(
      canonicalJson({
        schema: 'investigation-v3-publication-git-state-unavailable.v1',
        repositoryRealPath: git.repositoryRealPath,
        gitCommonDirectory: git.gitCommonDirectory,
        branch: git.branch,
        head: git.head,
        tree: git.tree,
        statusEntries: [...git.statusEntries].sort(),
        errorCode: boundedObservationErrorCode(error),
      }),
    );
  }
  return prefixedDigest(
    canonicalJson({
      schema: 'investigation-v3-publication-git-state.v2',
      repositoryRealPath: git.repositoryRealPath,
      gitCommonDirectory: git.gitCommonDirectory,
      branch: git.branch,
      head: git.head,
      tree: git.tree,
      statusEntries: [...git.statusEntries].sort(),
      worktreeFingerprint,
    }),
  );
}

function safePublicationGitStateDigest(
  repositoryRoot: string,
): `sha256:${string}` {
  try {
    return investigationManifestPublicationGitStateDigest(
      discoverRepository(repositoryRoot),
    );
  } catch (error) {
    return prefixedDigest(
      canonicalJson({
        schema: 'investigation-v3-publication-git-discovery-unavailable.v1',
        repositoryRoot: path.resolve(repositoryRoot),
        errorCode: boundedObservationErrorCode(error),
      }),
    );
  }
}

function boundedObservationErrorCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z][A-Z0-9_]{0,255}$/.test(error.code)
  ) {
    return error.code;
  }
  return 'OBSERVATION_UNAVAILABLE';
}

function prefixedDigest(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
