import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { replaceTextAtomic } from './atomic-text.ts';
import { canonicalJson } from './canonical-json.ts';
import {
  createInvestigationV3Blocker,
  validateForAuthority,
  type InvestigationManifestV3,
  type InvestigationV3Blocker,
  type InvestigationV3FailureCode,
} from './investigation-manifest.ts';

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

export type InvestigationManifestPublicationPhase =
  | 'candidate-written'
  | 'journal-prepared'
  | 'manifest-installed'
  | 'current-ref-published'
  | 'journal-committed';

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
  | { outcome: 'blocked'; blocker: InvestigationV3Blocker };

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
  let failureCandidate: unknown = {
    paths: input.paths,
    expected: input.expected,
    manifestDigest: input.manifest.manifestDigest,
  };
  try {
    const paths = normalizePaths(input.repositoryRoot, input.paths);
    const validated = validateForAuthority({
      repositoryRoot: input.repositoryRoot,
      manifest: input.manifest,
      expected: authorityExpected(input.expected),
    });
    if (validated.outcome !== 'verified') return validated;

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
      writeCanonical(paths.absolute(candidatePath), input.manifest);
      input.observePhase?.('candidate-written');
      writeCanonical(paths.journal, journal);
      input.observePhase?.('journal-prepared');
      installCandidate(
        paths.absolute(candidatePath),
        paths.manifest,
        input.manifest.manifestDigest,
      );
      input.observePhase?.('manifest-installed');
      writeCanonical(paths.currentRef, currentRef);
      input.observePhase?.('current-ref-published');
      writeCanonical(paths.journal, { ...journal, state: 'committed' });
      input.observePhase?.('journal-committed');
      return publishedResult(journal);
    });
  } catch (error) {
    return publicationBlocked(failureCandidate, error);
  }
}

export function inspectInvestigationManifestPublication(input: {
  repositoryRoot: string;
  paths: InvestigationManifestPublicationPaths;
}):
  | { outcome: 'none' }
  | { outcome: 'recoverable'; transactionId: string }
  | { outcome: 'committed'; transactionId: string }
  | { outcome: 'blocked'; blocker: InvestigationV3Blocker } {
  try {
    const paths = normalizePaths(input.repositoryRoot, input.paths);
    if (!fs.existsSync(paths.journal)) return { outcome: 'none' };
    const journal = readJournal(paths.journal, input.paths);
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
    return { outcome: 'recoverable', transactionId: journal.transactionId };
  } catch (error) {
    return publicationBlocked(input.paths, error);
  }
}

export function resumeInvestigationManifestPublication(input: {
  repositoryRoot: string;
  paths: InvestigationManifestPublicationPaths;
  withTransitionLock: WithTransitionLock;
  observePhase?: (phase: InvestigationManifestPublicationPhase) => void;
}): PublicationResult {
  let paths: ReturnType<typeof normalizePaths>;
  let journal: PublicationJournal;
  try {
    paths = normalizePaths(input.repositoryRoot, input.paths);
    journal = readJournal(paths.journal, input.paths);
    if (journal.state === 'committed') {
      assertInstalledState(paths, journal);
      return publishedResult(journal);
    }
  } catch (error) {
    return publicationBlocked(input.paths, error);
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
        installCandidate(candidate, paths.manifest, journal.manifestDigest);
        input.observePhase?.('manifest-installed');
      } else {
        assertManifestDigest(paths.manifest, journal.manifestDigest);
      }
      if (!desiredRefInstalled) {
        writeCanonical(paths.currentRef, journal.currentRef);
        input.observePhase?.('current-ref-published');
      }
      writeCanonical(paths.journal, { ...journal, state: 'committed' });
      input.observePhase?.('journal-committed');
      return publishedResult(journal);
    });
  } catch (error) {
    return publicationBlocked(journal, error);
  }
}

export function readInvestigationPublicationRefState(input: {
  repositoryRoot: string;
  currentRefPath: string;
}):
  | { outcome: 'read'; currentRefDigest: string }
  | { outcome: 'blocked'; blocker: InvestigationV3Blocker } {
  try {
    return {
      outcome: 'read',
      currentRefDigest: publicationRefDigest(
        input.repositoryRoot,
        input.currentRefPath,
      ),
    };
  } catch (error) {
    return publicationBlocked({ currentRefPath: input.currentRefPath }, error);
  }
}

function publicationRefDigest(
  repositoryRoot: string,
  relativePath: string,
): string {
  const absolute = resolveRelative(repositoryRoot, relativePath);
  if (!fs.existsSync(absolute)) {
    return digest({
      schema: 'investigation-publication-ref-state.v1',
      exists: false,
    });
  }
  const stats = fs.lstatSync(absolute);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Investigation current-ref path is unsafe.',
    );
  }
  return digest({
    schema: 'investigation-publication-ref-state.v1',
    exists: true,
    contentSha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(absolute))
      .digest('hex'),
  });
}

function normalizePaths(
  repositoryRoot: string,
  paths: InvestigationManifestPublicationPaths,
): {
  manifest: string;
  currentRef: string;
  journal: string;
  absolute: (relativePath: string) => string;
} {
  const manifest = resolveRelative(repositoryRoot, paths.manifestPath);
  const currentRef = resolveRelative(repositoryRoot, paths.currentRefPath);
  const journal = resolveRelative(repositoryRoot, paths.journalPath);
  if (new Set([manifest, currentRef, journal]).size !== 3) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication paths must be distinct.',
    );
  }
  return {
    manifest,
    currentRef,
    journal,
    absolute: (relativePath) => resolveRelative(repositoryRoot, relativePath),
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
  const root = path.resolve(repositoryRoot);
  const absolute = path.resolve(root, relativePath);
  if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication path escapes the repository.',
    );
  }
  return absolute;
}

function candidateRelativePath(
  manifestPath: string,
  transactionId: string,
): string {
  return `${manifestPath}.${transactionId}.candidate`;
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

function writeCanonical(filePath: string, value: unknown): void {
  replaceTextAtomic(filePath, `${canonicalJson(value)}\n`, {
    allowCreate: true,
    defaultMode: 0o600,
  });
  fsyncDirectory(path.dirname(filePath));
}

function installCandidate(
  candidatePath: string,
  manifestPath: string,
  expectedDigest: string,
): void {
  assertManifestDigest(candidatePath, expectedDigest);
  const existing = fs.lstatSync(manifestPath, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Manifest publication target is unsafe.',
    );
  }
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.renameSync(candidatePath, manifestPath);
  fsyncDirectory(path.dirname(manifestPath));
  assertManifestDigest(manifestPath, expectedDigest);
}

function assertManifestDigest(filePath: string, expectedDigest: string): void {
  const parsed = readJson(filePath);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !('manifestDigest' in parsed) ||
    parsed.manifestDigest !== expectedDigest
  ) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Publication file does not carry the journalled Manifest digest.',
    );
  }
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
  assertManifestDigest(paths.manifest, journal.manifestDigest);
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
  const expectedTransaction = digest({
    schema: 'investigation-manifest-publication-transaction.v1',
    expected: journal.expected,
    currentRef: journal.currentRef,
  });
  if (
    expectedTransaction !== journal.transactionId ||
    journal.currentRef.manifestDigest !== journal.manifestDigest ||
    journal.currentRef.investigationTargetDigest !==
      journal.investigationTargetDigest
  ) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Publication journal binding does not match recomputation.',
    );
  }
  return journal;
}

function readJson(filePath: string): unknown {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats || !stats.isFile() || stats.isSymbolicLink()) {
    throw publicationFailure(
      'REPLAY_INPUT_MISSING',
      'Publication artifact is absent or unsafe.',
    );
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication artifact is not canonical JSON.',
    );
  }
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

function publicationBlocked(
  candidate: unknown,
  error: unknown,
): { outcome: 'blocked'; blocker: InvestigationV3Blocker } {
  return {
    outcome: 'blocked',
    blocker: createInvestigationV3Blocker({
      attemptedTransition: 'publication',
      candidate,
      failureCode:
        error instanceof PublicationFailure
          ? error.code
          : 'RECONSTRUCTION_MISMATCH',
      message:
        error instanceof Error
          ? error.message
          : 'Unknown Manifest publication failure.',
    }),
  };
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}
