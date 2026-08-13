import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { issueCollaborationGrant } from '../src/collaboration-grant.ts';
import { collaborationGrantStorePaths } from '../src/collaboration-grant-store.ts';
import { discoverRepository } from '../src/git.ts';
import { renderHandoff } from '../src/handoff.ts';
import { finalizeTask } from '../src/lifecycle.ts';
import type { MaintainerSignerProvider } from '../src/maintainer-signer.ts';
import { commitPlanningTransition } from '../src/planning-transition.ts';
import { startSession } from '../src/session.ts';
import {
  assertCurrentTaskDiffReviewSatisfied,
  beginTaskDiffReview,
  inspectTaskDiffReviewStatus,
  submitExternalTaskDiffReview,
} from '../src/task-diff-review-lifecycle.ts';
import type { TaskDiffReviewSubmission } from '../src/task-diff-review-artifact.ts';
import { TASK_DIFF_REVIEW_COVERAGE } from '../src/task-diff-review.ts';
import {
  createFixtureRepository,
  git,
  runtimeRoot,
  sourceRepositoryRoot,
  writeReadyV2ExemptChange,
} from './fixture.ts';

test('grant-backed TaskDiffReview status is structurally strict and never performs SSH verification', () => {
  const signing = invalidSigningFixture();
  const repository = createReviewFixture(signing.trustedSigner);
  const originalMkdtempSync = fs.mkdtempSync;
  let verificationTemporaryDirectories = 0;
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = true;\n',
    );
    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_REQUIRED'),
    );
    const paused = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(paused.state, 'collaboration-grant-required');
    if (paused.state !== 'collaboration-grant-required') {
      assert.fail('expected external review authority pause');
    }
    const grant = issueCollaborationGrant(
      repository,
      {
        changeId: paused.subject.changeId,
        taskId: paused.subject.taskId,
        baselineCommit: paused.subject.baseCommit,
        baselineTree: paused.subject.baseTree,
        targetDigest: paused.subject.subjectDigest,
        lifecyclePhase: 'task-diff-review',
        rolePair: {
          authorRole: 'task-implementer',
          conflictingRole: 'task-diff-reviewer',
        },
        availableActor: {
          kind: 'caller',
          callerId: 'independent-reviewer',
          assurance: 'self-declared',
        },
        degradedForm: 'caller-supplied',
        reason: 'No provider-independent reviewer is callable.',
        ttlMinutes: 30,
        maxUses: 1,
      },
      {
        grantId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        now: new Date(),
        signer: signing.signer,
      },
    );
    const blobObjectId = paused.subject.transitions.find(
      ({ path: changedPath }) => changedPath === 'src/feature.ts',
    )?.after?.objectId;
    assert.ok(blobObjectId);
    assert.throws(
      () =>
        submitExternalTaskDiffReview(
          repository,
          session.sessionId,
          {
            schemaVersion: 1,
            kind: 'task-diff-review-submission-input.v1',
            subjectDigest: paused.subject.subjectDigest,
            submission: validSubmission(blobObjectId, paused.subject),
          },
          {
            explicitActor: 'codex',
            environment: {},
            collaborationGrant: {
              grantId: grant.grantId,
              now: new Date(Date.now() + 1_000),
              verifier: signing.signer,
            },
          },
        ),
      hasCode('COLLABORATION_SIGNATURE_INVALID'),
    );

    Object.defineProperty(fs, 'mkdtempSync', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        if (String(args[0]).includes('workflow-maintainer-verify-')) {
          verificationTemporaryDirectories += 1;
        }
        return Reflect.apply(originalMkdtempSync, fs, args);
      },
    });
    const before = snapshotTree(runtimeRoot(repository));
    assert.equal(
      inspectTaskDiffReviewStatus(repository, session.sessionId).state,
      'satisfied',
    );
    assert.deepEqual(snapshotTree(runtimeRoot(repository)), before);
    assert.equal(verificationTemporaryDirectories, 0);

    assert.throws(
      () => assertCurrentTaskDiffReviewSatisfied(repository, session.sessionId),
      hasCode('COLLABORATION_SIGNATURE_INVALID'),
    );
    assert.equal(verificationTemporaryDirectories, 1);

    const terminalPath = path.join(
      collaborationGrantStorePaths(
        discoverRepository(repository).gitCommonDirectory,
      ).terminal,
      `${grant.grantId}.json`,
    );
    const terminal = JSON.parse(fs.readFileSync(terminalPath, 'utf8')) as {
      use: { targetDigest: string };
    };
    terminal.use.targetDigest = '0'.repeat(64);
    fs.writeFileSync(terminalPath, `${JSON.stringify(terminal)}\n`);
    assert.throws(
      () => inspectTaskDiffReviewStatus(repository, session.sessionId),
      hasCode('COLLABORATION_GRANT_STATE_AMBIGUOUS'),
    );
  } finally {
    Object.defineProperty(fs, 'mkdtempSync', {
      configurable: true,
      writable: true,
      value: originalMkdtempSync,
    });
    signing.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createReviewFixture(trustedSigner: {
  identity: string;
  publicKey: string;
  fingerprint: string;
}): string {
  const repository = createFixtureRepository();
  const documentPolicyPath = path.join(
    repository,
    'workflow/document-policy.json',
  );
  const documentPolicy = JSON.parse(
    fs.readFileSync(documentPolicyPath, 'utf8'),
  ) as { documents: Record<string, unknown> };
  documentPolicy.documents['docs/CURRENT_AND_NEXT_STEPS.md'] = {
    mode: 'generated',
    enforcement: 'active',
    transition: 'completion',
  };
  fs.writeFileSync(
    documentPolicyPath,
    `${JSON.stringify(documentPolicy, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
  renderHandoff(repository);
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/path-roles.json'),
    path.join(repository, 'workflow/path-roles.json'),
  );
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
    path.join(repository, 'workflow/maintainer-policy.json'),
  );
  const maintainerPolicyPath = path.join(
    repository,
    'workflow/maintainer-policy.json',
  );
  const maintainerPolicy = JSON.parse(
    fs.readFileSync(maintainerPolicyPath, 'utf8'),
  ) as {
    repository: { origin: string };
    trustedSigners: Array<typeof trustedSigner>;
  };
  maintainerPolicy.trustedSigners = [trustedSigner];
  fs.writeFileSync(
    maintainerPolicyPath,
    `${JSON.stringify(maintainerPolicy, null, 2)}\n`,
  );
  const adapterPolicyPath = path.join(
    repository,
    'workflow/ai-adapter-policy.json',
  );
  const adapterPolicy = JSON.parse(
    fs.readFileSync(adapterPolicyPath, 'utf8'),
  ) as { providers: Record<'codex' | 'claude', { enabled: boolean }> };
  adapterPolicy.providers.codex.enabled = false;
  adapterPolicy.providers.claude.enabled = false;
  fs.writeFileSync(
    adapterPolicyPath,
    `${JSON.stringify(adapterPolicy, null, 2)}\n`,
  );
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Configure TaskDiffReview fixture']);
  git(repository, ['checkout', '-b', 'work/demo-change']);
  writeReadyV2ExemptChange(repository, 'demo-change', {
    diffReview: 'required',
  });
  commitPlanningTransition(repository, 'demo-change');
  git(repository, [
    'remote',
    'add',
    'origin',
    maintainerPolicy.repository.origin,
  ]);
  return repository;
}

function invalidSigningFixture(): {
  signer: MaintainerSignerProvider;
  trustedSigner: { identity: string; publicKey: string; fingerprint: string };
  dispose(): void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-signing-'));
  const keyPath = path.join(root, 'key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
  const trustedKeyPath = path.join(root, 'trusted-key');
  execFileSync('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-f',
    trustedKeyPath,
  ]);
  const publicKey = fs
    .readFileSync(`${trustedKeyPath}.pub`, 'utf8')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
  const fingerprint = execFileSync(
    'ssh-keygen',
    ['-l', '-E', 'sha256', '-f', `${trustedKeyPath}.pub`],
    { encoding: 'utf8' },
  ).match(/SHA256:[A-Za-z0-9+/]+/)?.[0];
  assert.ok(fingerprint);
  const identity = 'status-maintainer';
  const signer: MaintainerSignerProvider = {
    assertHumanPresent() {},
    identity: () => identity,
    sign(payload, namespace) {
      const payloadPath = path.join(root, 'payload');
      fs.writeFileSync(payloadPath, payload, { mode: 0o600 });
      execFileSync('ssh-keygen', [
        '-Y',
        'sign',
        '-f',
        keyPath,
        '-n',
        namespace!,
        payloadPath,
      ]);
      const signature = fs.readFileSync(`${payloadPath}.sig`, 'utf8');
      fs.rmSync(payloadPath, { force: true });
      fs.rmSync(`${payloadPath}.sig`, { force: true });
      return signature;
    },
    verify() {},
  };
  return {
    signer,
    trustedSigner: { identity, publicKey, fingerprint },
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function validSubmission(
  blobObjectId: string,
  subject: ReturnType<typeof inspectTaskDiffReviewStatus>['subject'],
): TaskDiffReviewSubmission {
  return {
    schemaVersion: 1,
    verdict: 'advisory-approve',
    coverage: [...TASK_DIFF_REVIEW_COVERAGE],
    scopeAssessment: {
      kind: 'no-challenge',
      evidence: [
        {
          kind: 'repository-location',
          path: 'src/feature.ts',
          line: 1,
          blobObjectId,
          observation: 'The exact candidate preserves the declared invariant.',
        },
      ],
    },
    findings: [],
    suggestions: [],
    riskPathDispositions: subject.reviewRequirement.riskPaths.map(
      ({ path: riskPath, role }) => ({
        path: riskPath,
        role: role as TaskDiffReviewSubmission['riskPathDispositions'][number]['role'],
        outcome: 'no-challenge',
      }),
    ),
    residualRisk: 'No release-blocking residual risk was identified.',
    uncertainty: 'Review is limited to the exact canonical candidate.',
  };
}

function snapshotTree(directory: string): Array<readonly [string, string]> {
  return fs
    .readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .map(String)
    .sort()
    .filter((relativePath) =>
      fs.lstatSync(path.join(directory, relativePath)).isFile(),
    )
    .map(
      (relativePath) =>
        [
          relativePath,
          fs.readFileSync(path.join(directory, relativePath), 'hex'),
        ] as const,
    );
}

function hasCode(expected: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === expected;
}
