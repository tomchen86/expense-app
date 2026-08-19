import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  createDirectHumanReviewAttestation,
  issueCollaborationGrant,
} from '../src/modules/authority/collaboration-grant.ts';
import { discoverRepository } from '../src/git.ts';
import { renderHandoff } from '../src/handoff.ts';
import { finalizeTask } from '../src/application/finalize/lifecycle.ts';
import {
  verifySshSignatureWithPublicKey,
  type MaintainerSignerProvider,
} from '../src/maintainer-signer.ts';
import { commitPlanningTransition } from '../src/application/propose/planning-transition.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import {
  inspectTaskDiffReviewStatus,
  inspectTaskDiffReviewSubject,
  resumeDirectHumanTaskDiffReview,
  submitExternalTaskDiffReview,
  submitExternalTaskDiffReviewContinuation,
} from '../src/application/finalize/task-diff-review-lifecycle.ts';
import {
  createTaskDiffReviewChallengeResponse,
  type TaskDiffReviewSubmission,
} from '../src/modules/assurance/task-diff-review-artifact.ts';
import { taskDiffExternalContinuationTargetDigest } from '../src/task-diff-review-external-store.ts';
import {
  TASK_DIFF_REVIEW_COVERAGE,
  type TaskDiffReviewSubject,
} from '../src/modules/assurance/task-diff-review.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  runtimeRoot,
  sourceRepositoryRoot,
  writeReadyV2ExemptChange,
} from './fixture.ts';

test('human-only TaskDiffReview resume signs only an exact durable pause and recovers consumed work', () => {
  const signing = createSigningFixture();
  const repository = createReviewFixture(signing);
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
    const subject = inspectTaskDiffReviewSubject(repository, session.sessionId);
    const initialInput = initialInputFor(subject);
    const issuedAt = new Date();
    const initialGrant = issueDirectHumanGrant(
      repository,
      signing,
      subject,
      subject.subjectDigest,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      issuedAt,
    );
    const afterGrantSignatures = signing.signCalls();

    assert.throws(
      () =>
        resumeDirectHumanTaskDiffReview(
          repository,
          session.sessionId,
          initialInput,
          initialGrant.grantId,
          { now: plus(issuedAt, 10_000), signer: signing.signer },
        ),
      hasCode('TASK_DIFF_DIRECT_HUMAN_RESUME_INVALID'),
    );
    assert.equal(signing.signCalls(), afterGrantSignatures);

    const pausedInitial = submitExternalTaskDiffReview(
      repository,
      session.sessionId,
      initialInput,
      {
        explicitActor: 'codex',
        environment: {},
        collaborationGrant: {
          grantId: initialGrant.grantId,
          now: plus(issuedAt, 20_000),
          verifier: signing.signer,
        },
      },
    );
    assert.equal(pausedInitial.state, 'direct-human-attestation-required');
    if (pausedInitial.state !== 'direct-human-attestation-required') {
      assert.fail('expected initial direct-human pause');
    }
    assert.throws(
      () =>
        resumeDirectHumanTaskDiffReview(
          repository,
          session.sessionId,
          initialInput,
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          { now: plus(issuedAt, 30_000), signer: signing.signer },
        ),
      hasCode('TASK_DIFF_DIRECT_HUMAN_RESUME_INVALID'),
    );
    const mismatchedInitial = {
      ...initialInput,
      submission: {
        ...initialInput.submission,
        residualRisk: 'Different authority-free bytes must not reuse a pause.',
      },
    };
    assert.throws(
      () =>
        resumeDirectHumanTaskDiffReview(
          repository,
          session.sessionId,
          mismatchedInitial,
          initialGrant.grantId,
          { now: plus(issuedAt, 40_000), signer: signing.signer },
        ),
      hasCode('TASK_DIFF_DIRECT_HUMAN_RESUME_INVALID'),
    );
    assert.equal(signing.signCalls(), afterGrantSignatures);

    const reviewed = resumeDirectHumanTaskDiffReview(
      repository,
      session.sessionId,
      initialInput,
      initialGrant.grantId,
      { now: plus(issuedAt, 50_000), signer: signing.signer },
    );
    assert.equal(reviewed.state, 'challenge-response-required');
    assert.equal(signing.signCalls(), afterGrantSignatures + 1);
    assert.deepEqual(
      resumeDirectHumanTaskDiffReview(
        repository,
        session.sessionId,
        initialInput,
        initialGrant.grantId,
        { now: plus(issuedAt, 60_000), signer: signing.signer },
      ),
      reviewed,
    );
    assert.equal(signing.signCalls(), afterGrantSignatures + 1);
    if (
      reviewed.state !== 'challenge-response-required' ||
      !('review' in reviewed)
    ) {
      assert.fail('expected challenged external review');
    }

    const closureRequest = closureRequestFor(reviewed.review);
    const response = createTaskDiffReviewChallengeResponse({
      review: reviewed.review,
      responses: closureRequest.responses,
    });
    const closureInput = {
      schemaVersion: 1 as const,
      kind: 'task-diff-review-closure-input.v1' as const,
      subjectDigest: closureRequest.subjectDigest,
      reviewRecordDigest: closureRequest.reviewRecordDigest,
      responseDigest: response.responseDigest,
      proposedDispositions: closureRequest.proposedDispositions,
    };
    const targetDigest = taskDiffExternalContinuationTargetDigest({
      subjectDigest: reviewed.review.subjectDigest,
      reviewRecordDigest: reviewed.review.recordDigest,
      responseDigest: response.responseDigest,
    });
    const continuationGrant = issueDirectHumanGrant(
      repository,
      signing,
      reviewed.review.subject,
      targetDigest,
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      issuedAt,
    );
    const pausedClosure = submitExternalTaskDiffReviewContinuation(
      repository,
      session.sessionId,
      response,
      closureInput,
      {
        collaborationGrant: {
          grantId: continuationGrant.grantId,
          now: plus(issuedAt, 70_000),
          verifier: signing.signer,
        },
      },
    );
    assert.equal(pausedClosure.state, 'direct-human-attestation-required');
    if (pausedClosure.state !== 'direct-human-attestation-required') {
      assert.fail('expected continuation direct-human pause');
    }

    const beforeInspect = snapshotTree(runtimeRoot(repository));
    const inspected = inspectTaskDiffReviewStatus(
      repository,
      session.sessionId,
    );
    assert.deepEqual(snapshotTree(runtimeRoot(repository)), beforeInspect);
    assert.equal(inspected.state, 'direct-human-attestation-required');
    if (
      inspected.state !== 'direct-human-attestation-required' ||
      !('source' in inspected) ||
      inspected.source !== 'external-continuation'
    ) {
      assert.fail('expected exact external continuation pause projection');
    }
    assert.equal(inspected.grantId, continuationGrant.grantId);
    assert.equal(inspected.contentNodeId, pausedClosure.contentNodeId);
    assert.equal(
      inspected.contentResultDigest,
      pausedClosure.contentResultDigest,
    );

    const continuationAttestation = createDirectHumanReviewAttestation(
      repository,
      {
        grantEnvelope: continuationGrant.envelope,
        transitionDigest: pausedClosure.transitionDigest,
        reviewNodeId: pausedClosure.contentNodeId,
        reviewResultDigest: pausedClosure.contentResultDigest,
      },
      { now: plus(issuedAt, 80_000), signer: signing.signer },
    );
    assert.throws(
      () =>
        submitExternalTaskDiffReviewContinuation(
          repository,
          session.sessionId,
          response,
          closureInput,
          {
            collaborationGrant: {
              grantId: continuationGrant.grantId,
              now: plus(issuedAt, 90_000),
              verifier: signing.signer,
              directHumanReviewAttestation: continuationAttestation,
            },
            testCrashAfter: 'grant-consumed',
          },
        ),
      /Simulated external TaskDiffReview continuation interruption/,
    );
    const afterCrashSignatures = signing.signCalls();
    const consumedStatus = inspectTaskDiffReviewStatus(
      repository,
      session.sessionId,
    );
    assert.equal(consumedStatus.state, 'external-reconciliation-required');
    assert.ok('source' in consumedStatus);
    assert.equal(consumedStatus.source, 'external-continuation');

    const completed = resumeDirectHumanTaskDiffReview(
      repository,
      session.sessionId,
      closureRequest,
      continuationGrant.grantId,
      { now: plus(issuedAt, 100_000), signer: signing.signer },
    );
    assert.equal(completed.state, 'satisfied');
    assert.equal(signing.signCalls(), afterCrashSignatures);
    assert.deepEqual(
      resumeDirectHumanTaskDiffReview(
        repository,
        session.sessionId,
        closureRequest,
        continuationGrant.grantId,
        { now: plus(issuedAt, 110_000), signer: signing.signer },
      ),
      completed,
    );
    assert.equal(signing.signCalls(), afterCrashSignatures);
  } finally {
    signing.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function initialInputFor(subject: TaskDiffReviewSubject) {
  const transition = subject.transitions.find(
    ({ path: candidate }) => candidate === 'src/feature.ts',
  );
  assert.ok(transition?.after);
  const evidence = [
    {
      kind: 'repository-location' as const,
      path: 'src/feature.ts',
      line: 1,
      blobObjectId: transition.after.objectId,
      observation: 'The exact candidate may violate the task invariant.',
    },
  ];
  const submission: TaskDiffReviewSubmission = {
    schemaVersion: 1,
    verdict: 'advisory-reject',
    coverage: [...TASK_DIFF_REVIEW_COVERAGE],
    scopeAssessment: { kind: 'challenges' },
    findings: [
      {
        kind: 'challenge',
        severity: 'high',
        category: 'correctness-and-invariants',
        currentChangeImpact: 'required',
        summary: 'The changed branch may violate the task invariant.',
        evidence,
      },
    ],
    suggestions: [],
    riskPathDispositions: subject.reviewRequirement.riskPaths.map(
      ({ path: riskPath, role }) => ({
        path: riskPath,
        role: role as TaskDiffReviewSubmission['riskPathDispositions'][number]['role'],
        outcome: 'challenge-raised' as const,
      }),
    ),
    residualRisk: 'The challenge requires authenticated closure.',
    uncertainty: 'Review is limited to the exact candidate.',
  };
  return {
    schemaVersion: 1 as const,
    kind: 'task-diff-review-submission-input.v1' as const,
    subjectDigest: subject.subjectDigest,
    submission,
  };
}

function closureRequestFor(
  review: Parameters<typeof createTaskDiffReviewChallengeResponse>[0]['review'],
) {
  return {
    schemaVersion: 1 as const,
    kind: 'task-diff-review-external-closure-request.v1' as const,
    subjectDigest: review.subjectDigest,
    reviewRecordDigest: review.recordDigest,
    responses: review.challenges.map((challenge) => ({
      challengeId: challenge.challengeId,
      rationale: 'The exact checked candidate answers this challenge.',
      evidence: [challenge.evidence[0]!],
    })),
    proposedDispositions: review.challenges.map((challenge) => ({
      challengeId: challenge.challengeId,
      decision: 'rebutted' as const,
      rationale: 'The authenticated direct human rebuts this challenge.',
      supersededBy: null,
    })),
  };
}

function issueDirectHumanGrant(
  repository: string,
  signing: ReturnType<typeof createSigningFixture>,
  subject: TaskDiffReviewSubject,
  targetDigest: string,
  grantId: string,
  now: Date,
) {
  return issueCollaborationGrant(
    repository,
    {
      changeId: 'demo-change',
      taskId: '1.1',
      baselineCommit: subject.baseCommit,
      baselineTree: subject.baseTree,
      targetDigest,
      lifecyclePhase: 'task-diff-review',
      rolePair: {
        authorRole: 'task-implementer',
        conflictingRole: 'task-diff-reviewer',
      },
      availableActor: {
        kind: 'direct-human',
        identity: signing.trustedSigner.identity,
        assurance: 'maintainer-signed',
      },
      degradedForm: 'direct-human-review',
      reason: 'Exact direct-human TaskDiffReview authority.',
      ttlMinutes: 30,
      maxUses: 1,
    },
    { grantId, now, signer: signing.signer },
  );
}

function createReviewFixture(
  signing: ReturnType<typeof createSigningFixture>,
): string {
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
  const maintainerPolicyPath = path.join(
    repository,
    'workflow/maintainer-policy.json',
  );
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
    maintainerPolicyPath,
  );
  const maintainerPolicy = JSON.parse(
    fs.readFileSync(maintainerPolicyPath, 'utf8'),
  ) as { repository: { origin: string }; trustedSigners: unknown[] };
  maintainerPolicy.trustedSigners = [signing.trustedSigner];
  fs.writeFileSync(
    maintainerPolicyPath,
    `${JSON.stringify(maintainerPolicy, null, 2)}\n`,
  );
  git(repository, [
    'remote',
    'add',
    'origin',
    maintainerPolicy.repository.origin,
  ]);
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
  configureChecks(
    repository,
    {
      fixture: {
        command: ['node', 'scripts/pass.mjs'],
        destructiveDatabase: false,
      },
    },
    ['fixture'],
  );
  git(repository, ['checkout', '-b', 'work/demo-change']);
  writeReadyV2ExemptChange(repository, 'demo-change', {
    diffReview: 'required',
  });
  commitPlanningTransition(repository, 'demo-change');
  return repository;
}

function createSigningFixture(): {
  signer: MaintainerSignerProvider;
  trustedSigner: {
    identity: string;
    publicKey: string;
    fingerprint: string;
  };
  signCalls(): number;
  dispose(): void;
} {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'direct-human-resume-signing-')),
  );
  const keyPath = path.join(root, 'review-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
  const publicKey = fs
    .readFileSync(`${keyPath}.pub`, 'utf8')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
  const fingerprint = execFileSync(
    'ssh-keygen',
    ['-l', '-E', 'sha256', '-f', `${keyPath}.pub`],
    { encoding: 'utf8' },
  ).match(/SHA256:[A-Za-z0-9+/]+/)?.[0];
  if (!fingerprint) throw new Error('fixture fingerprint missing');
  const identity = 'task-diff-review-maintainer';
  let signatures = 0;
  const signer: MaintainerSignerProvider = {
    assertHumanPresent() {},
    identity: () => identity,
    sign(payload, namespace) {
      signatures += 1;
      assert.ok(namespace);
      const payloadPath = path.join(root, 'payload');
      fs.writeFileSync(payloadPath, payload, { mode: 0o600 });
      execFileSync('ssh-keygen', [
        '-Y',
        'sign',
        '-f',
        keyPath,
        '-n',
        namespace,
        payloadPath,
      ]);
      const signature = fs.readFileSync(`${payloadPath}.sig`, 'utf8');
      fs.rmSync(payloadPath, { force: true });
      fs.rmSync(`${payloadPath}.sig`, { force: true });
      return signature;
    },
    verify(payload, signature, requestedIdentity, namespace) {
      assert.ok(namespace);
      verifySshSignatureWithPublicKey(
        payload,
        signature,
        requestedIdentity,
        publicKey,
        namespace,
      );
    },
  };
  return {
    signer,
    trustedSigner: { identity, publicKey, fingerprint },
    signCalls: () => signatures,
    dispose() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function snapshotTree(root: string): readonly string[] {
  if (!fs.existsSync(root)) return [];
  const visit = (directory: string): string[] =>
    fs
      .readdirSync(directory)
      .sort()
      .flatMap((name) => {
        const target = path.join(directory, name);
        const relative = path.relative(root, target);
        const stat = fs.lstatSync(target);
        if (stat.isDirectory())
          return [`d:${relative}:${stat.mode}`, ...visit(target)];
        return [
          `f:${relative}:${stat.mode}:${stat.size}:${canonicalJson(fs.readFileSync(target).toString('base64'))}`,
        ];
      });
  return visit(root);
}

function plus(date: Date, milliseconds: number): Date {
  return new Date(date.getTime() + milliseconds);
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code;
}
