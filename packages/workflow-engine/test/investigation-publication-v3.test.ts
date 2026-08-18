import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import {
  buildInvestigationManifestDraft,
  sealInvestigationManifestDraft,
  type ExemptionInvestigationAuthoringState,
} from '../src/investigation-manifest.ts';
import {
  inspectInvestigationManifestPublication,
  investigationManifestPublicationNamespace,
  observeInvestigationManifestPublicationState,
  publishInvestigationManifestV3,
  readInvestigationPublicationRefState,
  resumeInvestigationManifestPublication,
} from '../src/investigation-publication.ts';
import { git } from './fixture.ts';

test('v3 publication performs lock-scoped CAS and publishes Manifest before its current ref', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('ordinary');
    const expected = {
      repositoryId: manifest.repositoryId,
      changeId: manifest.changeId,
      investigationId: manifest.investigationId,
      sessionRevision: manifest.authoring.sessionRevision,
      sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
      currentRefDigest: currentRefDigest(
        repository,
        paths.currentRefPath,
        manifest,
      ),
    };
    const phases: string[] = [];
    const published = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
      observePhase: (phase) => phases.push(phase),
    });
    assert.equal(published.outcome, 'published');
    if (published.outcome !== 'published') assert.fail('publication blocked');
    assert.deepEqual(phases, [
      'candidate-written',
      'journal-prepared',
      'manifest-installed',
      'current-ref-published',
      'journal-committed',
    ]);
    const tracked = JSON.parse(
      fs.readFileSync(path.join(repository, paths.manifestPath), 'utf8'),
    ) as { manifestDigest: string };
    const current = JSON.parse(
      fs.readFileSync(path.join(repository, paths.currentRefPath), 'utf8'),
    ) as { manifestDigest: string };
    assert.equal(tracked.manifestDigest, manifest.manifestDigest);
    assert.equal(current.manifestDigest, manifest.manifestDigest);

    const stale = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected: { ...expected, currentRefDigest: '0'.repeat(64) },
      withTransitionLock: (operation) => operation(expected),
    });
    assert.equal(stale.outcome, 'blocked');
    if (stale.outcome === 'blocked') {
      assert.equal(stale.blocker.failureCode, 'REVIEW_TARGET_STALE');
      assert.equal(
        stale.failure.kind,
        'investigation-manifest-publication-failure',
      );
      assert.deepEqual(stale.failure.blocker, stale.blocker);
      assert.deepEqual(stale.failure.lifecycle, {
        repositoryId: expected.repositoryId,
        changeId: expected.changeId,
        investigationId: expected.investigationId,
        sessionRevision: expected.sessionRevision,
        sessionSnapshotDigest: expected.sessionSnapshotDigest,
      });
      assert.equal(stale.failure.source.observation.operation, 'publish');
      assert.equal(
        stale.failure.source.failureIdentity,
        stale.blocker.failureIdentity,
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a crash between Manifest install and ref publication is classified and resumable', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('crash');
    const expected = {
      repositoryId: manifest.repositoryId,
      changeId: manifest.changeId,
      investigationId: manifest.investigationId,
      sessionRevision: manifest.authoring.sessionRevision,
      sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
      currentRefDigest: currentRefDigest(
        repository,
        paths.currentRefPath,
        manifest,
      ),
    };
    const interrupted = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
      observePhase: (phase) => {
        if (phase === 'manifest-installed') {
          throw new Error('simulated crash');
        }
      },
    });
    assert.equal(interrupted.outcome, 'blocked');
    assert.equal(
      fs.existsSync(path.join(repository, paths.currentRefPath)),
      false,
    );
    const inspection = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(inspection.outcome, 'recoverable');
    if (inspection.outcome === 'recoverable') {
      assert.equal(inspection.recoveryKind, 'pre-ref');
      if (inspection.recoveryKind === 'pre-ref') {
        assert.equal(
          inspection.blocker.failureCode,
          'PUBLICATION_RECOVERY_REQUIRED',
        );
      }
    }

    const resumed = resumeInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
      withTransitionLock: (operation) => operation(expected),
    });
    assert.equal(resumed.outcome, 'published');
    const after = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(after.outcome, 'committed');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('recovery accepts the transaction-installed ref while preserving lifecycle identity', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('ref-installed-crash');
    const expected = {
      repositoryId: manifest.repositoryId,
      changeId: manifest.changeId,
      investigationId: manifest.investigationId,
      sessionRevision: manifest.authoring.sessionRevision,
      sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
      currentRefDigest: currentRefDigest(
        repository,
        paths.currentRefPath,
        manifest,
      ),
    };
    const interrupted = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
      observePhase: (phase) => {
        if (phase === 'current-ref-published') {
          throw new Error('simulated crash after authority ref publication');
        }
      },
    });
    assert.equal(interrupted.outcome, 'blocked');
    const inspection = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(inspection.outcome, 'recoverable');
    if (inspection.outcome === 'recoverable') {
      assert.equal(inspection.recoveryKind, 'post-ref');
      assert.equal('blocker' in inspection, false);
    }

    const resumed = resumeInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
      withTransitionLock: (operation) =>
        operation({
          ...expected,
          currentRefDigest: currentRefDigest(
            repository,
            paths.currentRefPath,
            manifest,
          ),
        }),
    });
    assert.equal(resumed.outcome, 'published');
    assert.equal(
      inspectInvestigationManifestPublication({
        repositoryRoot: repository,
        paths,
        lifecycle: publicationLifecycle(manifest),
      }).outcome,
      'committed',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a candidate-only pre-journal crash is classified as a precise restart blocker', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('candidate-only-crash');
    const expected = {
      repositoryId: manifest.repositoryId,
      changeId: manifest.changeId,
      investigationId: manifest.investigationId,
      sessionRevision: manifest.authoring.sessionRevision,
      sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
      currentRefDigest: currentRefDigest(
        repository,
        paths.currentRefPath,
        manifest,
      ),
    };
    const interrupted = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
      observePhase: (phase) => {
        if (phase === 'candidate-written') {
          throw new Error('simulated candidate-only crash');
        }
      },
    });
    assert.equal(interrupted.outcome, 'blocked');
    if (interrupted.outcome === 'blocked') {
      assert.equal(
        interrupted.blocker.failureCode,
        'PUBLICATION_RECOVERY_REQUIRED',
      );
    }

    const inspection = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(inspection.outcome, 'blocked');
    if (inspection.outcome === 'blocked') {
      assert.equal(
        inspection.blocker.failureCode,
        'PUBLICATION_RECOVERY_REQUIRED',
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('an unknown pre-mutation publication exception retains the generic mismatch code', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('generic-pre-mutation-error');
    const expected = publicationExpected(
      repository,
      paths.currentRefPath,
      manifest,
    );
    const blocked = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: () => {
        throw new Error('unexpected lock adapter failure');
      },
    });
    assert.equal(blocked.outcome, 'blocked');
    if (blocked.outcome === 'blocked') {
      assert.equal(blocked.blocker.failureCode, 'RECONSTRUCTION_MISMATCH');
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('replacement publication keeps the prior authority readable until a fresh Manifest path is switched', () => {
  const repository = createRepository();
  try {
    const first = sealedExemption(repository, 3);
    const namespace = publicationTestNamespace();
    const currentRefPath = `${namespace}/replacement-current.json`;
    const firstPaths = {
      manifestPath: `${namespace}/replacement-generation-1.json`,
      currentRefPath,
      journalPath: `${namespace}/replacement-generation-1-journal.json`,
    };
    const firstExpected = publicationExpected(
      repository,
      firstPaths.currentRefPath,
      first,
    );
    assert.equal(
      publishInvestigationManifestV3({
        repositoryRoot: repository,
        paths: firstPaths,
        manifest: first,
        expected: firstExpected,
        withTransitionLock: (operation) => operation(firstExpected),
      }).outcome,
      'published',
    );

    const second = sealedExemption(repository, 4);
    const secondPaths = {
      manifestPath: `${namespace}/replacement-generation-2.json`,
      currentRefPath,
      journalPath: `${namespace}/replacement-generation-2-journal.json`,
    };
    const secondExpected = publicationExpected(
      repository,
      secondPaths.currentRefPath,
      second,
    );
    const interrupted = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths: secondPaths,
      manifest: second,
      expected: secondExpected,
      withTransitionLock: (operation) => operation(secondExpected),
      observePhase: (phase) => {
        if (phase === 'manifest-installed') {
          throw new Error('simulated replacement crash before ref switch');
        }
      },
    });
    assert.equal(interrupted.outcome, 'blocked');

    const currentBeforeResume = readJsonAt<{
      manifestPath: string;
      manifestDigest: string;
    }>(repository, currentRefPath);
    assert.equal(currentBeforeResume.manifestPath, firstPaths.manifestPath);
    assert.equal(currentBeforeResume.manifestDigest, first.manifestDigest);
    assert.equal(
      readJsonAt<{ manifestDigest: string }>(
        repository,
        firstPaths.manifestPath,
      ).manifestDigest,
      first.manifestDigest,
    );
    assert.equal(
      readJsonAt<{ manifestDigest: string }>(
        repository,
        secondPaths.manifestPath,
      ).manifestDigest,
      second.manifestDigest,
    );

    const resumed = resumeInvestigationManifestPublication({
      repositoryRoot: repository,
      paths: secondPaths,
      lifecycle: publicationLifecycle(second),
      withTransitionLock: (operation) => operation(secondExpected),
    });
    assert.equal(resumed.outcome, 'published');
    const currentAfterResume = readJsonAt<{
      manifestPath: string;
      manifestDigest: string;
    }>(repository, currentRefPath);
    assert.equal(currentAfterResume.manifestPath, secondPaths.manifestPath);
    assert.equal(currentAfterResume.manifestDigest, second.manifestDigest);

    const unsafeReplacementPaths = {
      manifestPath: secondPaths.manifestPath,
      currentRefPath,
      journalPath: `${namespace}/replacement-generation-3-journal.json`,
    };
    const third = sealedExemption(repository, 5);
    const thirdExpected = publicationExpected(
      repository,
      currentRefPath,
      third,
    );
    const unsafeReplacement = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths: unsafeReplacementPaths,
      manifest: third,
      expected: thirdExpected,
      withTransitionLock: (operation) => operation(thirdExpected),
    });
    assert.equal(unsafeReplacement.outcome, 'blocked');
    if (unsafeReplacement.outcome === 'blocked') {
      assert.equal(
        unsafeReplacement.blocker.failureCode,
        'MANIFEST_UNREPRESENTABLE',
      );
    }
    assert.equal(
      readJsonAt<{ manifestDigest: string }>(
        repository,
        secondPaths.manifestPath,
      ).manifestDigest,
      second.manifestDigest,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('every public publication transition reduces unsafe paths to a structured v3 blocker', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const unsafe = {
      manifestPath: '../manifest.json',
      currentRefPath: '.git/workflow-engine/v3-test/unsafe-current.json',
      journalPath: '.git/workflow-engine/v3-test/unsafe-journal.json',
    };
    const expected = {
      repositoryId: manifest.repositoryId,
      changeId: manifest.changeId,
      investigationId: manifest.investigationId,
      sessionRevision: manifest.authoring.sessionRevision,
      sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
      currentRefDigest: '0'.repeat(64),
    };
    const publish = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths: unsafe,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
    });
    const inspect = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      paths: unsafe,
      lifecycle: publicationLifecycle(manifest),
    });
    const resume = resumeInvestigationManifestPublication({
      repositoryRoot: repository,
      paths: unsafe,
      lifecycle: publicationLifecycle(manifest),
      withTransitionLock: (operation) => operation(expected),
    });
    const refState = readInvestigationPublicationRefState({
      repositoryRoot: repository,
      currentRefPath: '../unsafe-current.json',
      lifecycle: publicationLifecycle(manifest),
    });
    for (const result of [publish, inspect, resume, refState]) {
      assert.equal(result.outcome, 'blocked');
      if (result.outcome === 'blocked') {
        assert.equal(result.blocker.kind, 'investigation-v3-failure');
        assert.equal(result.blocker.failureCode, 'MANIFEST_UNREPRESENTABLE');
      }
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication rejects a symlinked ancestor without writing through it', () => {
  const repository = createRepository();
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-publication-outside-'),
  );
  try {
    const manifest = sealedExemption(repository);
    const root = `${publicationTestNamespace()}/symlink-ancestor`;
    const alias = path.join(repository, root, 'alias');
    const paths = {
      manifestPath: `${root}/alias/manifest.json`,
      currentRefPath: `${root}/alias/current.json`,
      journalPath: `${root}/alias/journal.json`,
    };
    const expected = publicationExpected(
      repository,
      paths.currentRefPath,
      manifest,
    );
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.symlinkSync(outside, alias);
    const result = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
    });
    assert.equal(result.outcome, 'blocked');
    if (result.outcome === 'blocked') {
      assert.equal(result.blocker.failureCode, 'MANIFEST_UNREPRESENTABLE');
    }
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('current-ref observation rejects pathname substitution before descriptor open', () => {
  const repository = createRepository();
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-publication-ref-race-'),
  );
  const currentRefPath = `${publicationTestNamespace()}/ref-race/current.json`;
  const target = path.join(repository, currentRefPath);
  const canonicalTarget = path.join(
    fs.realpathSync(repository),
    currentRefPath,
  );
  const displaced = `${target}.displaced`;
  const external = path.join(outside, 'external.json');
  writeJson(target, { trusted: true });
  writeJson(external, { external: true });
  const originalOpen = fs.openSync;
  let attackTriggered = false;
  Object.defineProperty(fs, 'openSync', {
    configurable: true,
    value(filePath: fs.PathLike, ...args: unknown[]) {
      if (
        !attackTriggered &&
        path.resolve(String(filePath)) === canonicalTarget
      ) {
        attackTriggered = true;
        fs.renameSync(target, displaced);
        fs.symlinkSync(external, target);
      }
      return (originalOpen as (...values: unknown[]) => number)(
        filePath,
        ...args,
      );
    },
  });
  try {
    const result = readInvestigationPublicationRefState({
      repositoryRoot: repository,
      currentRefPath,
      lifecycle: publicationLifecycle(sealedExemption(repository)),
    });
    assert.equal(attackTriggered, true);
    assert.equal(result.outcome, 'blocked');
    if (result.outcome === 'blocked') {
      assert.equal(result.blocker.failureCode, 'MANIFEST_UNREPRESENTABLE');
    }
  } finally {
    Object.defineProperty(fs, 'openSync', {
      configurable: true,
      value: originalOpen,
    });
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('publication observation never follows an unvalidated journal candidate path', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('journal-candidate-path');
    const expected = publicationExpected(
      repository,
      paths.currentRefPath,
      manifest,
    );
    const interrupted = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
      observePhase: (phase) => {
        if (phase === 'journal-prepared') {
          throw new Error('simulated pre-ref crash');
        }
      },
    });
    assert.equal(interrupted.outcome, 'blocked');
    const journal = readJsonAt<{
      paths: { candidatePath: string };
    }>(repository, paths.journalPath);
    journal.paths.candidatePath = 'README.md';
    writeJson(path.join(repository, paths.journalPath), journal);

    const observation = observeInvestigationManifestPublicationState({
      repositoryRoot: repository,
      source: { operation: 'inspect', paths },
    });
    assert.equal(observation.recoveryKind, 'blocked');
    assert.equal(
      observation.artifacts.some(
        ({ path: artifactPath }) => artifactPath === 'README.md',
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('post-ref recovery rejects a semantically tampered Manifest that retains its old digest field', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('post-ref-semantic-tamper');
    const expected = publicationExpected(
      repository,
      paths.currentRefPath,
      manifest,
    );
    const interrupted = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
      observePhase: (phase) => {
        if (phase === 'current-ref-published') {
          throw new Error('simulated post-ref crash');
        }
      },
    });
    assert.equal(interrupted.outcome, 'blocked');

    const tampered = readJsonAt<Record<string, unknown>>(
      repository,
      paths.manifestPath,
    );
    tampered.changeId = 'cross-wired-change';
    writeJson(path.join(repository, paths.manifestPath), tampered);

    const inspection = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(inspection.outcome, 'blocked');
    if (inspection.outcome === 'blocked') {
      assert.equal(inspection.blocker.failureCode, 'RECONSTRUCTION_MISMATCH');
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('committed recovery rejects a semantically tampered Manifest that retains its old digest field', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('committed-semantic-tamper');
    const expected = publicationExpected(
      repository,
      paths.currentRefPath,
      manifest,
    );
    const published = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
    });
    assert.equal(published.outcome, 'published');

    const tampered = readJsonAt<Record<string, unknown>>(
      repository,
      paths.manifestPath,
    );
    tampered.investigationId = 'cross-wired-investigation';
    writeJson(path.join(repository, paths.manifestPath), tampered);

    const inspection = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(inspection.outcome, 'blocked');
    if (inspection.outcome === 'blocked') {
      assert.equal(inspection.blocker.failureCode, 'RECONSTRUCTION_MISMATCH');
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('forged and malformed candidate-only residue is not classified as a precise publication crash', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const classifications = [
      {
        prefix: 'forged-candidate-only',
        write(candidatePath: string) {
          writeJson(candidatePath, {
            changeId: 'unrelated-change',
            manifestDigest: manifest.manifestDigest,
          });
        },
      },
      {
        prefix: 'malformed-candidate-only',
        write(candidatePath: string) {
          fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
          fs.writeFileSync(candidatePath, '{not-json\n');
        },
      },
    ].map(({ prefix, write }) => {
      const paths = publicationPaths(prefix);
      const candidatePath = path.join(
        repository,
        `${paths.manifestPath}.${'f'.repeat(64)}.candidate`,
      );
      write(candidatePath);
      const inspection = inspectInvestigationManifestPublication({
        repositoryRoot: repository,
        paths,
        lifecycle: publicationLifecycle(manifest),
      });
      return inspection.outcome === 'blocked'
        ? inspection.blocker.failureCode
        : inspection.outcome;
    });

    assert.equal(
      classifications.includes('PUBLICATION_RECOVERY_REQUIRED'),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('post-ref recovery rejects a recomputed journal whose current-ref identity is cross-wired', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('post-ref-journal-cross-wire');
    const expected = publicationExpected(
      repository,
      paths.currentRefPath,
      manifest,
    );
    const interrupted = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
      observePhase: (phase) => {
        if (phase === 'current-ref-published') {
          throw new Error('simulated post-ref crash');
        }
      },
    });
    assert.equal(interrupted.outcome, 'blocked');

    const journal = readJsonAt<{
      transactionId: string;
      paths: {
        manifestPath: string;
        currentRefPath: string;
        journalPath: string;
        candidatePath: string;
      };
      expected: unknown;
      currentRef: Record<string, unknown>;
    }>(repository, paths.journalPath);
    const currentRef = {
      ...journal.currentRef,
      repositoryId: 'cross-wired-repository',
      manifestPath: 'README.md',
    };
    const transactionId = canonicalDigest({
      schema: 'investigation-manifest-publication-transaction.v1',
      expected: journal.expected,
      currentRef,
    });
    writeJson(path.join(repository, paths.journalPath), {
      ...journal,
      transactionId,
      paths: {
        ...journal.paths,
        candidatePath: `${paths.manifestPath}.${transactionId}.candidate`,
      },
      currentRef,
    });
    writeJson(path.join(repository, paths.currentRefPath), currentRef);

    const inspection = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(inspection.outcome, 'blocked');
    if (inspection.outcome === 'blocked') {
      assert.equal(inspection.blocker.failureCode, 'RECONSTRUCTION_MISMATCH');
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication does not write outside the repository when an ancestor is swapped after validation', () => {
  const repository = createRepository();
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-publication-write-race-'),
  );
  const root = `${publicationTestNamespace()}/write-ancestor-race`;
  const ancestor = path.join(repository, root);
  const displaced = `${ancestor}.displaced`;
  const parent = path.join(ancestor, 'nested');
  const paths = {
    manifestPath: `${root}/nested/manifest.json`,
    currentRefPath: `${root}/nested/current.json`,
    journalPath: `${root}/nested/journal.json`,
  };
  fs.mkdirSync(ancestor, { recursive: true });
  fs.mkdirSync(path.join(outside, 'nested'), { recursive: true });
  const canonicalManifestTarget = path.join(
    fs.realpathSync(repository),
    paths.manifestPath,
  );
  const manifest = sealedExemption(repository);
  const expected = publicationExpected(
    repository,
    paths.currentRefPath,
    manifest,
  );
  const originalRename = fs.renameSync;
  let attackTriggered = false;
  Object.defineProperty(fs, 'renameSync', {
    configurable: true,
    value(oldPath: fs.PathLike, newPath: fs.PathLike) {
      if (
        !attackTriggered &&
        path.resolve(String(newPath)) === canonicalManifestTarget
      ) {
        attackTriggered = true;
        originalRename(ancestor, displaced);
        fs.symlinkSync(outside, ancestor);
      }
      return originalRename(oldPath, newPath);
    },
  });
  try {
    const result = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
    });
    assert.equal(attackTriggered, true);
    assert.equal(result.outcome, 'blocked');
    assert.equal(
      fs.existsSync(path.join(outside, 'nested', 'manifest.json')),
      false,
    );
  } finally {
    Object.defineProperty(fs, 'renameSync', {
      configurable: true,
      value: originalRename,
    });
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('publication removes an installed basename when its anchored parent is moved outside the repository', () => {
  const repository = createRepository();
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-publication-parent-move-'),
  );
  const root = `${publicationTestNamespace()}/write-parent-move`;
  const ancestor = path.join(repository, root);
  const movedAncestor = path.join(outside, 'moved-publication');
  const paths = {
    manifestPath: `${root}/nested/manifest.json`,
    currentRefPath: `${root}/nested/current.json`,
    journalPath: `${root}/nested/journal.json`,
  };
  fs.mkdirSync(path.join(ancestor, 'nested'), { recursive: true });
  const canonicalManifestTarget = path.join(
    fs.realpathSync(repository),
    paths.manifestPath,
  );
  const manifest = sealedExemption(repository);
  const expected = publicationExpected(
    repository,
    paths.currentRefPath,
    manifest,
  );
  const originalRename = fs.renameSync;
  let attackTriggered = false;
  Object.defineProperty(fs, 'renameSync', {
    configurable: true,
    value(oldPath: fs.PathLike, newPath: fs.PathLike) {
      if (
        !attackTriggered &&
        path.resolve(String(newPath)) === canonicalManifestTarget
      ) {
        attackTriggered = true;
        originalRename(ancestor, movedAncestor);
      }
      return originalRename(oldPath, newPath);
    },
  });
  try {
    const result = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
    });
    assert.equal(attackTriggered, true);
    assert.equal(result.outcome, 'blocked');
    assert.equal(
      fs.existsSync(path.join(movedAncestor, 'nested', 'manifest.json')),
      false,
    );
  } finally {
    Object.defineProperty(fs, 'renameSync', {
      configurable: true,
      value: originalRename,
    });
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('publication restores the prior current ref when its anchored parent is moved outside the repository', () => {
  const repository = createRepository();
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-publication-ref-parent-move-'),
  );
  const root = `${publicationTestNamespace()}/write-ref-parent-move`;
  const ancestor = path.join(repository, root);
  const movedAncestor = path.join(outside, 'moved-publication');
  const paths = {
    manifestPath: `${root}/nested/manifest.json`,
    currentRefPath: `${root}/nested/current.json`,
    journalPath: `${root}/nested/journal.json`,
  };
  const currentRefPath = path.join(repository, paths.currentRefPath);
  const priorCurrentRef = {
    schemaVersion: 1,
    kind: 'investigation-manifest-current',
    repositoryId: 'expense-app-publication-test',
    changeId: 'prior-publication',
    investigationId: 'prior-investigation',
    manifestPath: `${root}/nested/prior-manifest.json`,
    manifestDigest: digest('prior-manifest'),
    investigationTargetDigest: digest('prior-target'),
  };
  writeJson(currentRefPath, priorCurrentRef);
  fs.chmodSync(currentRefPath, 0o666);
  const priorBytes = fs.readFileSync(currentRefPath);
  const priorMode = fs.statSync(currentRefPath).mode & 0o777;
  const canonicalCurrentRefTarget = path.join(
    fs.realpathSync(repository),
    paths.currentRefPath,
  );
  const manifest = sealedExemption(repository);
  const expected = publicationExpected(
    repository,
    paths.currentRefPath,
    manifest,
  );
  const originalRename = fs.renameSync;
  let attackTriggered = false;
  Object.defineProperty(fs, 'renameSync', {
    configurable: true,
    value(oldPath: fs.PathLike, newPath: fs.PathLike) {
      if (
        !attackTriggered &&
        path.resolve(String(newPath)) === canonicalCurrentRefTarget
      ) {
        attackTriggered = true;
        originalRename(ancestor, movedAncestor);
      }
      return originalRename(oldPath, newPath);
    },
  });
  const originalUmask = process.umask(0o077);
  try {
    const result = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
    });
    assert.equal(attackTriggered, true);
    assert.equal(result.outcome, 'blocked');
    assert.deepEqual(
      fs.readFileSync(path.join(movedAncestor, 'nested', 'current.json')),
      priorBytes,
    );
    assert.equal(
      fs.statSync(path.join(movedAncestor, 'nested', 'current.json')).mode &
        0o777,
      priorMode,
    );
  } finally {
    process.umask(originalUmask);
    Object.defineProperty(fs, 'renameSync', {
      configurable: true,
      value: originalRename,
    });
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

function sealedExemption(repository: string, sessionRevision = 3) {
  const baseline = {
    commitOid: git(repository, ['rev-parse', 'HEAD']).trim(),
    treeOid: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
  };
  const state: ExemptionInvestigationAuthoringState = {
    schemaVersion: 1,
    applicabilityKind: 'exemption',
    repositoryId: 'expense-app-publication-test',
    changeId: 'publication-v3',
    investigationId: 'publication-v3-test',
    normalizedIntent: {
      schemaVersion: 1,
      summary: 'Publish a documentation-only v3 fixture.',
      explicitPaths: ['docs/example.md'],
      explicitSymbols: [],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    authoring: {
      sessionRevision,
      sessionSnapshotDigest: digest(`publication-snapshot-${sessionRevision}`),
    },
    exemption: {
      category: 'documentation-only',
      baseline,
      declaredPaths: ['docs/example.md'],
      declaredChangeClasses: ['documentation-only'],
      rationale: 'The fixture changes documentation only.',
      semanticAuthor: {
        id: 'owner',
        provenance: 'checkpoint:publication-exemption',
      },
      nonTrivialBehaviorReliance: 'none-declared',
      researchBudgetMinutes: null,
    },
  };
  const built = buildInvestigationManifestDraft({
    repositoryRoot: repository,
    state,
  });
  if (built.outcome !== 'built') assert.fail(built.blocker.failureCode);
  const sealed = sealInvestigationManifestDraft({
    draft: built.draft,
    approval: {
      semanticAuthor: {
        id: 'owner',
        provenance: 'checkpoint:publication-approval',
      },
      approvalProvenanceDigest: digest('publication-approval'),
    },
  });
  if (sealed.outcome !== 'sealed') assert.fail(sealed.blocker.failureCode);
  return sealed.manifest;
}

function publicationExpected(
  repository: string,
  currentRefPath: string,
  manifest: ReturnType<typeof sealedExemption>,
) {
  return {
    repositoryId: manifest.repositoryId,
    changeId: manifest.changeId,
    investigationId: manifest.investigationId,
    sessionRevision: manifest.authoring.sessionRevision,
    sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
    currentRefDigest: currentRefDigest(repository, currentRefPath, manifest),
  };
}

function readJsonAt<T>(repository: string, relativePath: string): T {
  return JSON.parse(
    fs.readFileSync(path.join(repository, relativePath), 'utf8'),
  ) as T;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function publicationPaths(prefix: string) {
  const namespace = publicationTestNamespace();
  return {
    manifestPath: `${namespace}/${prefix}-manifest.json`,
    currentRefPath: `${namespace}/${prefix}-current.json`,
    journalPath: `${namespace}/${prefix}-journal.json`,
  };
}

function publicationTestNamespace(): string {
  return `.git/workflow-engine/${investigationManifestPublicationNamespace({
    repositoryId: 'expense-app-publication-test',
    changeId: 'publication-v3',
    investigationId: 'publication-v3-test',
  })}`;
}

function publicationLifecycle(manifest: ReturnType<typeof sealedExemption>) {
  return {
    repositoryId: manifest.repositoryId,
    changeId: manifest.changeId,
    investigationId: manifest.investigationId,
    sessionRevision: manifest.authoring.sessionRevision,
    sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
  };
}

function currentRefDigest(
  repository: string,
  currentRefPath: string,
  manifest: ReturnType<typeof sealedExemption>,
): string {
  const state = readInvestigationPublicationRefState({
    repositoryRoot: repository,
    currentRefPath,
    lifecycle: publicationLifecycle(manifest),
  });
  if (state.outcome !== 'read') assert.fail(state.blocker.failureCode);
  return state.currentRefDigest;
}

function createRepository(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-publication-v3-'),
  );
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'publication-v3@example.test']);
  git(repository, ['config', 'user.name', 'Publication V3 Test']);
  fs.writeFileSync(path.join(repository, 'README.md'), '# fixture\n');
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Create publication fixture']);
  return repository;
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalDigest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}
