import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildInvestigationManifestDraft,
  sealInvestigationManifestDraft,
  type ExemptionInvestigationAuthoringState,
} from '../src/investigation-manifest.ts';
import {
  inspectInvestigationManifestPublication,
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
      currentRefDigest: currentRefDigest(repository, paths.currentRefPath),
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
      currentRefDigest: currentRefDigest(repository, paths.currentRefPath),
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
    });
    assert.equal(inspection.outcome, 'recoverable');

    const resumed = resumeInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      withTransitionLock: (operation) => operation(expected),
    });
    assert.equal(resumed.outcome, 'published');
    const after = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
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
      currentRefDigest: currentRefDigest(repository, paths.currentRefPath),
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
    assert.equal(
      inspectInvestigationManifestPublication({
        repositoryRoot: repository,
        paths,
      }).outcome,
      'recoverable',
    );

    const resumed = resumeInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      withTransitionLock: (operation) =>
        operation({
          ...expected,
          currentRefDigest: currentRefDigest(repository, paths.currentRefPath),
        }),
    });
    assert.equal(resumed.outcome, 'published');
    assert.equal(
      inspectInvestigationManifestPublication({
        repositoryRoot: repository,
        paths,
      }).outcome,
      'committed',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('replacement publication keeps the prior authority readable until a fresh Manifest path is switched', () => {
  const repository = createRepository();
  try {
    const first = sealedExemption(repository, 3);
    const currentRefPath =
      '.git/workflow-engine/v3-test/replacement-current.json';
    const firstPaths = {
      manifestPath:
        '.git/workflow-engine/v3-test/replacement-generation-1.json',
      currentRefPath,
      journalPath:
        '.git/workflow-engine/v3-test/replacement-generation-1-journal.json',
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
      manifestPath:
        '.git/workflow-engine/v3-test/replacement-generation-2.json',
      currentRefPath,
      journalPath:
        '.git/workflow-engine/v3-test/replacement-generation-2-journal.json',
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
      journalPath:
        '.git/workflow-engine/v3-test/replacement-generation-3-journal.json',
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
    });
    const resume = resumeInvestigationManifestPublication({
      repositoryRoot: repository,
      paths: unsafe,
      withTransitionLock: (operation) => operation(expected),
    });
    const refState = readInvestigationPublicationRefState({
      repositoryRoot: repository,
      currentRefPath: '../unsafe-current.json',
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
    currentRefDigest: currentRefDigest(repository, currentRefPath),
  };
}

function readJsonAt<T>(repository: string, relativePath: string): T {
  return JSON.parse(
    fs.readFileSync(path.join(repository, relativePath), 'utf8'),
  ) as T;
}

function publicationPaths(prefix: string) {
  return {
    manifestPath: `.git/workflow-engine/v3-test/${prefix}-manifest.json`,
    currentRefPath: `.git/workflow-engine/v3-test/${prefix}-current.json`,
    journalPath: `.git/workflow-engine/v3-test/${prefix}-journal.json`,
  };
}

function currentRefDigest(repository: string, currentRefPath: string): string {
  const state = readInvestigationPublicationRefState({
    repositoryRoot: repository,
    currentRefPath,
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
