import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import {
  COLLABORATION_GRANT_AUTHORIZED_EFFECT,
  COLLABORATION_GRANT_POLICY_DIGEST,
  COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
  COLLABORATION_GRANT_REPLAY_SCOPE,
  COLLABORATION_GRANT_RESIDUALS,
  COLLABORATION_GRANT_SIGNATURE_NAMESPACE,
  DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE,
  canonicalCollaborationGrantEnvelope,
  canonicalCollaborationGrantPayload,
  createDirectHumanReviewAttestation,
  directHumanReviewAttestationDigest,
  issueCollaborationGrant,
  parseCollaborationGrantEnvelope,
  assertUniqueCollaborationGrantUses,
  validateCollaborationGrantEnvelope,
  type CollaborationGrantEnvelope,
  type CollaborationGrantExpectedBinding,
  type CollaborationGrantRequest,
} from '../src/collaboration-grant.ts';
import {
  collaborationGrantStorePaths,
  consumeCollaborationGrant,
  consumeCollaborationGrantUnderLifecycleLock,
  failCollaborationReservationUnderLifecycleLock,
  inspectCollaborationGrants,
  readExactConsumedCollaborationGrantUse,
  readReservedCollaborationGrantUnderLifecycleLock,
  reserveCollaborationGrant,
  reserveCollaborationGrantUnderLifecycleLock,
  revokeCollaborationGrant,
  validateCollaborationGrantUseSet,
  validateCollaborationGrantUseProjection,
  type CollaborationConsumptionRequest,
} from '../src/collaboration-grant-store.ts';
import {
  createInvestigationCheckpointEnvelope,
  resumeInvestigationSession,
} from '../src/investigation-session.ts';
import type { MaintainerPolicy } from '../src/maintainer-policy.ts';
import type { MaintainerSignerProvider } from '../src/maintainer-signer.ts';
import { investigationRuntimePaths } from '../src/paths.ts';
import { PLAN_REVIEW_COVERAGE } from '../src/plan-review.ts';
import {
  createPlanningContributionEnvelope,
  createPlanReviewProgressEnvelope,
  createProviderProgressEnvelope,
  getProposeStatus,
  resumePropose,
  startPropose,
} from '../src/propose-orchestrator.ts';
import type {
  ProviderInvocationRequest,
  ProviderProcessOutcome,
} from '../src/provider-contracts.ts';
import {
  PROVIDER_RUNNER_RESIDUALS,
  type ProviderRunnerReport,
} from '../src/provider-runner.ts';
import { runProviderWorker } from '../src/provider-worker.ts';
import {
  claimProviderInvocation,
  completeProviderInvocation,
  readProviderInvocationRequest,
} from '../src/provider-invocation-store.ts';
import {
  admitRoleResult,
  authorizeGrantedOrdinaryRole,
  scheduleOrdinaryRole,
  type RoleParticipant,
} from '../src/role-scheduler.ts';
import { withRepositoryLifecycleOperation } from '../src/session-store.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  sourceRepositoryRoot,
} from './fixture.ts';

const NOW = new Date('2026-07-24T00:00:00.000Z');
const GRANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET_DIGEST = '1'.repeat(64);
const CONTENT_NODE_ID = '2'.repeat(64);
const CONTENT_RESULT_DIGEST = '3'.repeat(64);
const TRANSITION_DIGEST = '4'.repeat(64);

const POLICY: MaintainerPolicy = {
  schemaVersion: 1,
  repository: {
    id: 'github:R_fixture',
    origin: 'https://github.com/example/fixture.git',
  },
  phase: 'bootstrap',
  auditTagPrefix: 'refs/tags/workflow-grant/',
  signatureNamespace: 'expense-app.workflow.maintainer-grant.v1',
  maxTtlMinutes: 30,
  maxUses: 1,
  bootstrapEligiblePaths: [
    'packages/workflow-engine/src/**',
    'workflow/maintainer-policy.json',
  ],
  sealedImmutablePaths: [
    'packages/workflow-engine/src/maintainer-policy.ts',
    'workflow/maintainer-policy.json',
  ],
  requiredChecks: ['fixture'],
  trustedSigners: [
    {
      identity: 'fixture-maintainer',
      publicKey:
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
      fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
    },
  ],
};

test('propose pauses for an exact grant and admits a same-provider fresh-session survey', () => {
  const repository = collaborationFixture();
  const changeId = 'granted-propose';
  const signer = fixtureSigner();
  try {
    const adapterPolicyPath = path.join(
      repository,
      'workflow/ai-adapter-policy.json',
    );
    const adapterPolicy = JSON.parse(
      fs.readFileSync(adapterPolicyPath, 'utf8'),
    ) as { providers: { claude: { enabled: boolean } } };
    adapterPolicy.providers.claude.enabled = false;
    fs.writeFileSync(
      adapterPolicyPath,
      `${JSON.stringify(adapterPolicy, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(repository, 'src/granted-survey-target.ts'),
      'export const GrantedSurveyNeedle = true;\n',
    );
    git(repository, [
      'add',
      'workflow/ai-adapter-policy.json',
      'src/granted-survey-target.ts',
    ]);
    git(repository, ['commit', '-m', 'Prepare granted propose fixture']);
    git(repository, ['checkout', '-b', `work/${changeId}`]);

    const intent = {
      schemaVersion: 1 as const,
      summary: 'Extend the granted survey target.',
      explicitPaths: ['src/granted-survey-target.ts'],
      explicitSymbols: ['GrantedSurveyNeedle'],
      explicitConfigKeys: [],
      renamePairs: [],
    };
    const paused = startPropose(repository, changeId, intent, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(paused.state, 'human-action-required');
    assert.equal(paused.nextAction, 'human-action');
    assert.equal(paused.investigation, null);
    assert.equal(paused.inputSchema?.kind, 'collaboration-grant-selection');
    const request = paused.inputSchema
      ?.grantRequest as CollaborationGrantRequest;
    assert.deepEqual(request, {
      changeId,
      taskId: null,
      baselineCommit: git(repository, ['rev-parse', 'HEAD']).trim(),
      baselineTree: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
      targetDigest: sha256(canonicalJson(intent)),
      lifecyclePhase: 'blind-survey',
      rolePair: {
        authorRole: 'investigation-author',
        conflictingRole: 'blind-surveyor',
      },
      availableActor: {
        kind: 'provider',
        providerId: 'codex',
        assurance: 'self-declared',
      },
      degradedForm: 'same-provider-fresh-session',
      reason:
        'No provider-independent blind surveyor is callable for this exact investigation.',
      ttlMinutes: 30,
      maxUses: 1,
    });

    const issued = issueCollaborationGrant(repository, request, {
      now: NOW,
      grantId: 'abababab-abab-4bab-8bab-abababababab',
      signer,
    });
    const started = startPropose(repository, changeId, intent, {
      explicitActor: 'codex',
      environment: {},
      collaborationGrant: {
        grantId: issued.grantId,
        now: new Date(NOW.getTime() + 60_000),
        verifier: signer,
      },
    });
    assert.equal(started.state, 'awaiting-main-terms');
    assert.equal(started.investigation?.provider.providerId, 'codex');
    const runtime = investigationRuntimePaths(
      fs.realpathSync(path.join(repository, '.git')),
      'workflow-engine',
    );
    const providerRequest = readProviderInvocationRequest(
      runtime,
      started.investigation!.providerInvocationId,
    );
    assert.equal(providerRequest.roleAssignment.providerId, 'codex');
    assert.equal(
      providerRequest.roleAssignment.achievedIndependence,
      'session-independent',
    );
    assert.equal('grantId' in providerRequest.roleAssignment, true);
    assert.notEqual(providerRequest.roleAssignment.sessionId, 'author-codex');

    const mainTerms = createInvestigationCheckpointEnvelope(
      started.investigation!,
      {
        reference: 'main-granted-survey',
        terms: [
          {
            kind: 'symbol',
            value: 'GrantedSurveyNeedle',
            rationale: 'The target symbol is part of the requested change.',
            expectedRelationship: 'Existing consumers may depend on it.',
          },
        ],
      },
    );
    const waiting = resumeInvestigationSession(
      repository,
      started.investigation!.investigationId,
      mainTerms,
    );
    completeFixtureProviderInvocation(providerRequest, repository);
    const providerProgress = createProviderProgressEnvelope(waiting);
    resumeInvestigationSession(
      repository,
      started.investigation!.investigationId,
    );
    const grantStore = collaborationGrantStorePaths(
      fs.realpathSync(path.join(repository, '.git')),
    );
    const beforeStatus = snapshotGrantStore(grantStore.root);
    assert.throws(
      () =>
        getProposeStatus(repository, started.investigation!.investigationId, {
          now: new Date(NOW.getTime() + 120_000),
          verifier: signer,
        }),
      (error) =>
        isWorkflowError(error, 'COLLABORATION_GRANT_ADMISSION_REQUIRED'),
    );
    assert.deepEqual(snapshotGrantStore(grantStore.root), beforeStatus);
    const afterProviderProgress = resumePropose(
      repository,
      changeId,
      providerProgress,
      {
        collaborationGrantValidation: {
          now: new Date(NOW.getTime() + 120_000),
          verifier: signer,
        },
      },
    );
    assert.equal(afterProviderProgress.state, 'awaiting-group-dispositions');
    const inspected = inspectCollaborationGrants(
      fs.realpathSync(path.join(repository, '.git')),
      issued.grantId,
    );
    assert.equal(inspected[0]?.state, 'consumed');
    assert.equal(
      inspected[0]?.use?.assignment.achievedIndependence,
      'session-independent',
    );
    assert.equal(
      inspected[0]?.use?.assignment.orchestration,
      'engine-spawned-provider',
    );
    const consumedSnapshot = snapshotGrantStore(grantStore.root);
    const firstStatus = getProposeStatus(
      repository,
      started.investigation!.investigationId,
      {
        now: new Date(NOW.getTime() + 120_000),
        verifier: signer,
      },
    );
    const secondStatus = getProposeStatus(
      repository,
      started.investigation!.investigationId,
      {
        now: new Date(NOW.getTime() + 120_000),
        verifier: signer,
      },
    );
    assert.deepEqual(secondStatus, firstStatus);
    assert.deepEqual(snapshotGrantStore(grantStore.root), consumedSnapshot);
    const heldStatus = withRepositoryLifecycleOperation(
      grantStore.runtime,
      () =>
        getProposeStatus(repository, started.investigation!.investigationId, {
          now: new Date(NOW.getTime() + 120_000),
          verifier: signer,
        }),
    );
    assert.deepEqual(heldStatus, firstStatus);
    assert.deepEqual(snapshotGrantStore(grantStore.root), consumedSnapshot);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('exact PlanReview preserves materialized planning while waiting for a same-provider grant', () => {
  const repository = collaborationFixture();
  const changeId = 'granted-plan-review';
  const signer = fixtureSigner();
  try {
    const adapterPolicyPath = path.join(
      repository,
      'workflow/ai-adapter-policy.json',
    );
    const adapterPolicy = JSON.parse(
      fs.readFileSync(adapterPolicyPath, 'utf8'),
    ) as { providers: { claude: { enabled: boolean } } };
    adapterPolicy.providers.claude.enabled = false;
    fs.writeFileSync(
      adapterPolicyPath,
      `${JSON.stringify(adapterPolicy, null, 2)}\n`,
    );
    fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'docs/granted-review.md'),
      '# Granted review\n',
    );
    git(repository, [
      'add',
      'workflow/ai-adapter-policy.json',
      'docs/granted-review.md',
    ]);
    git(repository, ['commit', '-m', 'Prepare granted review fixture']);
    git(repository, ['checkout', '-b', `work/${changeId}`]);

    const started = startPropose(
      repository,
      changeId,
      {
        schemaVersion: 1,
        kind: 'investigation-exemption-request',
        intent: {
          schemaVersion: 1,
          summary: 'Clarify granted review documentation.',
          explicitPaths: ['docs/granted-review.md'],
          explicitSymbols: [],
          explicitConfigKeys: [],
          renamePairs: [],
        },
        exemption: {
          category: 'documentation-only',
          declaredPaths: ['docs/granted-review.md'],
          declaredChangeClasses: ['documentation-only'],
          rationale: 'The change is limited to tracked documentation wording.',
          semanticAuthor: {
            id: 'codex',
            provenance: 'runtime-hint:codex',
          },
          nonTrivialBehaviorReliance: 'none-declared',
          researchBudgetMinutes: null,
        },
      },
      { explicitActor: 'codex', environment: {} },
    );
    const planning = createPlanningContributionEnvelope(started, {
      proposal: '# Proposal\n\nClarify granted review documentation.\n',
      design: '# Design\n\nUpdate documentation wording only.\n',
      specs: [
        {
          path: 'specs/demo/spec.md',
          content: [
            '# Delta',
            '',
            '## ADDED Requirements',
            '',
            '### Requirement: Granted review wording',
            '',
            'The guide SHALL remain clear.',
            '',
            '#### Scenario: Reader opens the guide',
            '',
            '- **WHEN** the guide is read',
            '- **THEN** the wording is clear',
            '',
          ].join('\n'),
        },
      ],
      tasks: '# Tasks\n\n- [ ] 1.1 Clarify granted review documentation\n',
      guard: {
        schemaVersion: 1,
        changeId,
        tasks: {
          '1.1': {
            allowedPaths: ['docs/granted-review.md'],
            requiredChecks: ['fixture'],
          },
        },
      },
      executionTasks: {
        '1.1': {
          strategy: 'direct-reviewed',
          enforcement: 'available',
          allowedPaths: ['docs/granted-review.md'],
          requiredChecks: ['fixture'],
          diffReview: 'policy-required',
          exemptionKind: 'documentation-only',
          exemptionReason: 'The task edits documentation only.',
          legacyBootstrap: null,
        },
      },
    });
    const paused = resumePropose(repository, changeId, planning);
    assert.equal(paused.state, 'human-action-required');
    assert.equal(paused.inputSchema?.kind, 'collaboration-grant-selection');
    assert.equal(paused.inputSchema?.lifecyclePhase, 'plan-review');
    const request = paused.inputSchema
      ?.grantRequest as CollaborationGrantRequest;
    assert.equal(request.targetDigest, paused.inputSchema?.subjectDigest);
    assert.equal(request.availableActor.kind, 'provider');
    assert.equal(
      fs.existsSync(
        path.join(repository, 'openspec/changes', changeId, 'proposal.md'),
      ),
      true,
    );

    const issued = issueCollaborationGrant(repository, request, {
      now: NOW,
      grantId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
      signer,
    });
    const waiting = resumePropose(repository, changeId, planning, {
      collaborationGrant: {
        grantId: issued.grantId,
        now: new Date(NOW.getTime() + 60_000),
        verifier: signer,
      },
    });
    assert.equal(waiting.state, 'waiting-for-plan-review');
    assert.equal(waiting.planReview?.providerId, 'codex');
    const paths = investigationRuntimePaths(
      fs.realpathSync(path.join(repository, '.git')),
      'workflow-engine',
    );
    const providerRequest = readProviderInvocationRequest(
      paths,
      waiting.planReview!.invocationId,
    );
    assert.equal(providerRequest.roleAssignment.providerId, 'codex');
    assert.equal(
      providerRequest.roleAssignment.achievedIndependence,
      'session-independent',
    );
    assert.equal('grantId' in providerRequest.roleAssignment, true);
    assert.equal(
      inspectCollaborationGrants(
        fs.realpathSync(path.join(repository, '.git')),
        issued.grantId,
      )[0]?.state,
      'reserved',
    );

    runProviderWorker(repository, waiting.planReview!.invocationId, {
      runner(input): ProviderRunnerReport {
        return fakeProviderRunnerReport(input.request, {
          schemaVersion: 2,
          verdict: 'advisory-approve',
          coverage: [...PLAN_REVIEW_COVERAGE],
          scopeAssessment: { kind: 'challenges' },
          findings: [
            {
              kind: 'challenge',
              severity: 'low',
              category: 'missing-scope',
              currentChangeImpact: 'required',
              summary: 'Confirm the exact documentation scope.',
              evidence: [
                {
                  kind: 'repository-location',
                  path: 'docs/granted-review.md',
                  line: 1,
                  observation:
                    'The exact planning target is limited to the declared guide.',
                },
              ],
            },
          ],
          proposedTerms: [],
          suggestions: [],
          residualRisk: 'Documentation meaning remains advisory.',
          uncertainty: 'No additional scope challenge was identified.',
        });
      },
    });
    const completed = resumePropose(
      repository,
      changeId,
      createPlanReviewProgressEnvelope(
        resumePropose(repository, changeId, planning, {
          collaborationGrantValidation: {
            now: new Date(NOW.getTime() + 120_000),
            verifier: signer,
          },
        }),
      ),
      {
        collaborationGrantValidation: {
          now: new Date(NOW.getTime() + 120_000),
          verifier: signer,
        },
      },
    );
    assert.equal(completed.state, 'awaiting-challenge-dispositions');
    assert.equal(
      inspectCollaborationGrants(
        fs.realpathSync(path.join(repository, '.git')),
        issued.grantId,
      )[0]?.state,
      'consumed',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('collaboration issuance is canonical, domain-separated, and has no authority side effects', () => {
  const repository = collaborationFixture();
  const namespaces: string[] = [];
  const signer = fixtureSigner(namespaces);
  try {
    const request = sameProviderRequest(repository);
    const refsBefore = git(repository, ['for-each-ref', '--format=%(refname)']);
    const headBefore = git(repository, ['rev-parse', 'HEAD']).trim();
    const indexBefore = git(repository, ['write-tree']).trim();
    const issued = issueCollaborationGrant(repository, request, {
      now: NOW,
      grantId: GRANT_ID,
      signer,
    });

    assert.equal(
      canonicalCollaborationGrantPayload(issued.envelope.payload),
      `${JSON.stringify(issued.envelope.payload)}\n`,
    );
    assert.equal(
      canonicalCollaborationGrantEnvelope(issued.envelope),
      `${JSON.stringify(issued.envelope)}\n`,
    );
    assert.deepEqual(
      parseCollaborationGrantEnvelope(
        canonicalCollaborationGrantEnvelope(issued.envelope),
      ),
      issued.envelope,
    );
    assert.deepEqual(namespaces, [
      COLLABORATION_GRANT_SIGNATURE_NAMESPACE,
      COLLABORATION_GRANT_SIGNATURE_NAMESPACE,
    ]);
    assert.notEqual(
      COLLABORATION_GRANT_SIGNATURE_NAMESPACE,
      POLICY.signatureNamespace,
    );
    assert.notEqual(
      DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE,
      COLLABORATION_GRANT_SIGNATURE_NAMESPACE,
    );
    assert.equal(issued.envelope.payload.maxUses, 1);
    assert.equal(
      issued.envelope.payload.authorizedEffect,
      COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    );
    assert.equal(
      'allowedPaths' in issued.envelope.payload,
      false,
      'collaboration grants must not acquire authority path scope',
    );
    assert.equal('tagRef' in issued, false);
    assert.equal('publishCommand' in issued, false);
    assert.equal(
      git(repository, ['for-each-ref', '--format=%(refname)']),
      refsBefore,
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), headBefore);
    assert.equal(git(repository, ['write-tree']).trim(), indexBefore);
    assert.equal(git(repository, ['status', '--porcelain']).trim(), '');

    const common = fs.realpathSync(path.join(repository, '.git'));
    const paths = collaborationGrantStorePaths(common);
    assert.equal(
      issued.availableEnvelopePath,
      path.join(paths.available, `${GRANT_ID}.json`),
    );
    assert.equal(
      fs.existsSync(
        path.join(
          common,
          'workflow-engine/maintainer-grants/available',
          `${GRANT_ID}.json`,
        ),
      ),
      false,
    );
    assert.equal(fs.statSync(paths.root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(issued.availableEnvelopePath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('collaboration grant CLI requires a controlling TTY and has no unattended escape hatch', () => {
  const repository = collaborationFixture();
  try {
    const request = sameProviderRequest(repository);
    const cli = path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/src/cli.ts',
    );
    const args = collaborationCliArguments(cli, request);
    const nonInteractive = spawnSync(process.execPath, args, {
      cwd: repository,
      encoding: 'utf8',
    });
    assert.equal(nonInteractive.status, 12, nonInteractive.stderr);
    assert.equal(
      JSON.parse(nonInteractive.stderr).error.code,
      'MAINTAINER_INTERACTIVE_REQUIRED',
    );
    assert.equal(
      fs.existsSync(
        path.join(repository, '.git/workflow-engine/collaboration-grants'),
      ),
      false,
    );

    const unattended = spawnSync(
      process.execPath,
      [...args.slice(0, -1), '--unattended', '--json'],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(unattended.status, 2, unattended.stderr);
    assert.equal(JSON.parse(unattended.stderr).error.code, 'INVALID_USAGE');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('signed collaboration binding rejects every substituted transition fact', () => {
  const repository = collaborationFixture();
  const signer = fixtureSigner();
  try {
    const request = sameProviderRequest(repository);
    const issued = issueCollaborationGrant(repository, request, {
      now: NOW,
      grantId: GRANT_ID,
      signer,
    });
    const expected = expectedBinding(issued.envelope);
    assert.doesNotThrow(() =>
      validateCollaborationGrantEnvelope(issued.envelope, POLICY, {
        now: new Date(NOW.getTime() + 60_000),
        expected,
        verifier: signer,
      }),
    );

    const substitutions: CollaborationGrantExpectedBinding[] = [
      { ...expected, repositoryId: 'github:R_other' },
      {
        ...expected,
        repositoryOrigin: 'https://github.com/example/other.git',
      },
      { ...expected, policyBlob: '9'.repeat(expected.policyBlob.length) },
      {
        ...expected,
        collaborationPolicyDigest: '8'.repeat(64),
      },
      { ...expected, changeId: 'other-change' },
      { ...expected, taskId: '6.2' },
      {
        ...expected,
        baselineCommit: 'a'.repeat(expected.baselineCommit.length),
      },
      { ...expected, baselineTree: 'b'.repeat(expected.baselineTree.length) },
      { ...expected, targetDigest: 'c'.repeat(64) },
      { ...expected, lifecyclePhase: 'plan-review' },
      {
        ...expected,
        rolePair: {
          authorRole: 'plan-author',
          conflictingRole: 'plan-reviewer',
        },
      },
      {
        ...expected,
        availableActor: {
          kind: 'provider',
          providerId: 'claude',
          assurance: 'runtime-hint',
        },
      },
      { ...expected, degradedForm: 'caller-supplied' },
    ];
    for (const substituted of substitutions) {
      assert.throws(
        () =>
          validateCollaborationGrantEnvelope(issued.envelope, POLICY, {
            now: new Date(NOW.getTime() + 60_000),
            expected: substituted,
            verifier: signer,
          }),
        (error) =>
          isWorkflowError(error, 'COLLABORATION_GRANT_BINDING_MISMATCH'),
      );
    }

    const extra = JSON.parse(
      canonicalCollaborationGrantEnvelope(issued.envelope),
    );
    extra.payload.allowedPaths = ['workflow/checks.json'];
    assert.throws(
      () => parseCollaborationGrantEnvelope(`${JSON.stringify(extra)}\n`),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_INVALID'),
    );

    const altered = structuredClone(issued.envelope);
    altered.payload.reason = 'Altered exact continuation reason';
    assert.throws(
      () =>
        validateCollaborationGrantEnvelope(altered, POLICY, {
          now: new Date(NOW.getTime() + 60_000),
          expected: { ...expected, reason: altered.payload.reason },
          verifier: signer,
        }),
      (error) => isWorkflowError(error, 'COLLABORATION_SIGNATURE_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('collaboration store reserves once across worktrees and rejects replay', () => {
  const repository = collaborationFixture();
  const signer = fixtureSigner();
  let linkedWorktree: string | undefined;
  try {
    const issued = issueCollaborationGrant(
      repository,
      sameProviderRequest(repository),
      { now: NOW, grantId: GRANT_ID, signer },
    );
    linkedWorktree = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-collaboration-linked-'),
    );
    fs.rmdirSync(linkedWorktree);
    git(repository, [
      'worktree',
      'add',
      '-b',
      'work/collaboration-linked',
      linkedWorktree,
      'HEAD',
    ]);
    const common = fs.realpathSync(path.join(repository, '.git'));
    const linkedCommon = fs.realpathSync(
      git(linkedWorktree, ['rev-parse', '--git-common-dir']).trim(),
    );
    assert.equal(linkedCommon, common);

    const reservation = reserveCollaborationGrant(linkedWorktree, GRANT_ID, {
      transitionDigest: TRANSITION_DIGEST,
      now: new Date(NOW.getTime() + 60_000),
      expected: expectedBinding(issued.envelope),
      verifier: signer,
    });
    assert.equal(reservation.state, 'reserved');
    assert.equal(reservation.transitionDigest, TRANSITION_DIGEST);
    assert.throws(
      () =>
        reserveCollaborationGrant(repository, GRANT_ID, {
          transitionDigest: '5'.repeat(64),
          now: new Date(NOW.getTime() + 60_000),
          expected: expectedBinding(issued.envelope),
          verifier: signer,
        }),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_UNAVAILABLE'),
    );

    const assignment = authorizeGrantedOrdinaryRole({
      role: 'blind-surveyor',
      author: participant('codex', 'author-session'),
      targetDigest: TARGET_DIGEST,
      reservation,
      actualParticipant: participant('codex', 'fresh-session'),
      callableProviderIds: ['codex'],
    });
    const consumption: CollaborationConsumptionRequest = {
      transitionDigest: TRANSITION_DIGEST,
      assignment,
      contentAdmission: {
        kind: 'blind-survey',
        nodeId: CONTENT_NODE_ID,
        resultDigest: CONTENT_RESULT_DIGEST,
        current: true,
      },
      now: new Date(NOW.getTime() + 120_000),
    };
    const consumed = consumeCollaborationGrant(common, GRANT_ID, consumption);
    assert.equal(consumed.state, 'consumed');
    assert.equal(consumed.use?.grantId, GRANT_ID);
    assert.equal(
      consumed.use?.signedEnvelopeDigest,
      crypto
        .createHash('sha256')
        .update(canonicalCollaborationGrantEnvelope(issued.envelope))
        .digest('hex'),
    );
    assert.deepEqual(
      consumed.use?.retainedObligations,
      COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
    );
    assert.equal(
      consumed.use?.assignment.achievedIndependence,
      'session-independent',
    );
    assert.equal(
      consumed.use?.assignment.requiredIndependence,
      'provider-independent',
    );
    assert.equal(
      consumed.use?.reservedAt,
      new Date(NOW.getTime() + 60_000).toISOString(),
    );
    assert.equal(consumed.use?.replayScope, COLLABORATION_GRANT_REPLAY_SCOPE);
    assert.deepEqual(consumed.use?.residuals, COLLABORATION_GRANT_RESIDUALS);
    assert.ok(consumed.use);
    const admitted = admitRoleResult({
      assignment,
      author: assignment.author,
      participant: assignment.participant,
      content: roleContent('blind-survey'),
      providerInvocation: {
        invocationId: 'same-provider-invocation',
        requestDigest: '5'.repeat(64),
        outputDigest: '6'.repeat(64),
        providerId: 'codex',
        sessionId: 'fresh-session',
        targetDigest: TARGET_DIGEST,
        engineSpawned: true,
      },
      grantUse: consumed.use,
      grantValidation: {
        now: new Date(NOW.getTime() + 120_000),
        expectedBinding: expectedBinding(issued.envelope),
        policy: POLICY,
        verifier: signer,
        transitionDigest: TRANSITION_DIGEST,
      },
    });
    assert.equal(admitted.form, 'granted-same-provider');
    assert.equal(admitted.achievedIndependence, 'session-independent');

    const paths = collaborationGrantStorePaths(common);
    const reservedResidual = path.join(paths.reserved, `${GRANT_ID}.json`);
    fs.writeFileSync(reservedResidual, `${JSON.stringify(reservation)}\n`, {
      mode: 0o600,
    });
    const exactResidual = fs.readFileSync(reservedResidual, 'utf8');
    assert.deepEqual(
      readExactConsumedCollaborationGrantUse(common, GRANT_ID, consumption),
      consumed.use,
    );
    assert.equal(fs.readFileSync(reservedResidual, 'utf8'), exactResidual);

    const mismatchedResidual = JSON.parse(exactResidual);
    mismatchedResidual.transitionDigest = '5'.repeat(64);
    fs.writeFileSync(
      reservedResidual,
      `${JSON.stringify(mismatchedResidual)}\n`,
      { mode: 0o600 },
    );
    assert.throws(
      () =>
        readExactConsumedCollaborationGrantUse(common, GRANT_ID, consumption),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_STATE_AMBIGUOUS'),
    );
    const mismatchedTransitionBytes = fs.readFileSync(reservedResidual, 'utf8');
    assert.throws(
      () =>
        consumeCollaborationGrant(common, GRANT_ID, {
          ...consumption,
          now: new Date(NOW.getTime() + 180_000),
        }),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_STATE_AMBIGUOUS'),
    );
    assert.equal(
      fs.readFileSync(reservedResidual, 'utf8'),
      mismatchedTransitionBytes,
    );
    mismatchedResidual.transitionDigest = TRANSITION_DIGEST;
    mismatchedResidual.envelope.payload.reason =
      'Mismatching interrupted reservation';
    fs.writeFileSync(
      reservedResidual,
      `${JSON.stringify(mismatchedResidual)}\n`,
      { mode: 0o600 },
    );
    assert.throws(
      () =>
        readExactConsumedCollaborationGrantUse(common, GRANT_ID, consumption),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_STATE_AMBIGUOUS'),
    );
    fs.writeFileSync(reservedResidual, exactResidual, { mode: 0o600 });

    const repeated = consumeCollaborationGrant(common, GRANT_ID, {
      ...consumption,
      now: new Date(NOW.getTime() + 180_000),
    });
    assert.deepEqual(repeated, consumed);
    assert.throws(
      () =>
        consumeCollaborationGrant(common, GRANT_ID, {
          transitionDigest: TRANSITION_DIGEST,
          assignment,
          contentAdmission: {
            kind: 'blind-survey',
            nodeId: '6'.repeat(64),
            resultDigest: CONTENT_RESULT_DIGEST,
            current: true,
          },
          now: new Date(NOW.getTime() + 180_000),
        }),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_UNAVAILABLE'),
    );
  } finally {
    if (linkedWorktree && fs.existsSync(repository)) {
      try {
        git(repository, ['worktree', 'remove', '--force', linkedWorktree]);
      } catch {
        fs.rmSync(linkedWorktree, { recursive: true, force: true });
      }
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('grant reserve and consume compose under an already-owned lifecycle lock', () => {
  const repository = collaborationFixture();
  const signer = fixtureSigner();
  try {
    const issued = issueCollaborationGrant(
      repository,
      sameProviderRequest(repository),
      { now: NOW, grantId: GRANT_ID, signer },
    );
    const common = fs.realpathSync(path.join(repository, '.git'));
    const paths = collaborationGrantStorePaths(common);
    const consumed = withRepositoryLifecycleOperation(
      paths.runtime,
      (assertOwned) => {
        const reservation = reserveCollaborationGrantUnderLifecycleLock(
          repository,
          GRANT_ID,
          {
            transitionDigest: TRANSITION_DIGEST,
            now: new Date(NOW.getTime() + 60_000),
            expected: expectedBinding(issued.envelope),
            verifier: signer,
          },
          assertOwned,
        );
        const assignment = authorizeGrantedOrdinaryRole({
          role: 'blind-surveyor',
          author: participant('codex', 'author-session'),
          targetDigest: TARGET_DIGEST,
          reservation,
          actualParticipant: participant('codex', 'fresh-session'),
          callableProviderIds: ['codex'],
        });
        return consumeCollaborationGrantUnderLifecycleLock(
          common,
          GRANT_ID,
          {
            transitionDigest: TRANSITION_DIGEST,
            assignment,
            contentAdmission: {
              kind: 'blind-survey',
              nodeId: CONTENT_NODE_ID,
              resultDigest: CONTENT_RESULT_DIGEST,
              current: true,
            },
            now: new Date(NOW.getTime() + 120_000),
          },
          assertOwned,
        );
      },
    );
    assert.equal(consumed.state, 'consumed');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('reserved grants can be read and failed under the governing lifecycle lock', () => {
  const repository = collaborationFixture();
  const signer = fixtureSigner();
  try {
    const issued = issueCollaborationGrant(
      repository,
      sameProviderRequest(repository),
      { now: NOW, grantId: GRANT_ID, signer },
    );
    const common = fs.realpathSync(path.join(repository, '.git'));
    const paths = collaborationGrantStorePaths(common);
    const failed = withRepositoryLifecycleOperation(
      paths.runtime,
      (assertOwned) => {
        const reserved = reserveCollaborationGrantUnderLifecycleLock(
          repository,
          GRANT_ID,
          {
            transitionDigest: TRANSITION_DIGEST,
            now: new Date(NOW.getTime() + 60_000),
            expected: expectedBinding(issued.envelope),
            verifier: signer,
          },
          assertOwned,
        );
        assert.deepEqual(
          readReservedCollaborationGrantUnderLifecycleLock(
            common,
            GRANT_ID,
            assertOwned,
          ),
          reserved,
        );
        return failCollaborationReservationUnderLifecycleLock(
          common,
          GRANT_ID,
          TRANSITION_DIGEST,
          'Provider execution failed before content admission',
          new Date(NOW.getTime() + 120_000),
          assertOwned,
        );
      },
    );
    assert.equal(failed.state, 'failed');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('expired and revoked collaboration grants never authorize a transition', () => {
  for (const terminal of ['expired', 'revoked'] as const) {
    const repository = collaborationFixture();
    const grantId =
      terminal === 'expired'
        ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        : 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    try {
      const signer = fixtureSigner();
      const issued = issueCollaborationGrant(
        repository,
        { ...sameProviderRequest(repository), ttlMinutes: 1 },
        { now: NOW, grantId, signer },
      );
      if (terminal === 'revoked') {
        const unattended = fixtureSigner();
        unattended.assertHumanPresent = () => {
          throw new Error('no controlling terminal');
        };
        assert.throws(() =>
          revokeCollaborationGrant(repository, grantId, {
            reason: 'Retire unused collaboration authority',
            signer: unattended,
            verifier: signer,
          }),
        );
        assert.equal(
          inspectCollaborationGrants(
            fs.realpathSync(path.join(repository, '.git')),
            grantId,
          )[0]?.state,
          'available',
        );
        const revoked = revokeCollaborationGrant(repository, grantId, {
          reason: 'Retire unused collaboration authority',
          now: new Date(NOW.getTime() + 30_000),
          signer,
          verifier: signer,
        });
        assert.equal(revoked.state, 'revoked');
        assert.deepEqual(
          revokeCollaborationGrant(repository, grantId, {
            reason: 'Retire unused collaboration authority',
            now: new Date(NOW.getTime() + 40_000),
            signer,
            verifier: signer,
          }),
          revoked,
        );
        assert.throws(
          () =>
            revokeCollaborationGrant(repository, grantId, {
              reason: 'A different reason must not replace the tombstone',
              signer,
              verifier: signer,
            }),
          (error) => isWorkflowError(error, 'HUMAN_REVOCATION_CONFLICT'),
        );
      }
      assert.throws(
        () =>
          reserveCollaborationGrant(repository, grantId, {
            transitionDigest: TRANSITION_DIGEST,
            now:
              terminal === 'expired'
                ? new Date(NOW.getTime() + 61_000)
                : new Date(NOW.getTime() + 40_000),
            expected: expectedBinding(issued.envelope),
            verifier: signer,
          }),
        (error) =>
          isWorkflowError(
            error,
            terminal === 'expired'
              ? 'COLLABORATION_GRANT_EXPIRED'
              : 'COLLABORATION_GRANT_UNAVAILABLE',
          ),
      );
      assert.equal(
        inspectCollaborationGrants(
          fs.realpathSync(path.join(repository, '.git')),
          grantId,
        )[0]?.state,
        terminal,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('same-provider grants require the only callable provider and a fresh engine session', () => {
  const fixture = reservedFixture('same-provider-fresh-session');
  try {
    const author = participant('codex', 'author-session');
    const assigned = authorizeGrantedOrdinaryRole({
      role: 'blind-surveyor',
      author,
      targetDigest: TARGET_DIGEST,
      reservation: fixture.reservation,
      actualParticipant: participant('codex', 'fresh-session'),
      callableProviderIds: ['codex'],
    });
    assert.deepEqual(
      {
        providerId: assigned.providerId,
        sessionId: assigned.sessionId,
        engineSpawned: assigned.engineSpawned,
        requiredIndependence: assigned.requiredIndependence,
        achievedIndependence: assigned.achievedIndependence,
        providerIndependent: assigned.providerIndependent,
        sessionIndependent: assigned.sessionIndependent,
        orchestration: assigned.orchestration,
      },
      {
        providerId: 'codex',
        sessionId: 'fresh-session',
        engineSpawned: true,
        requiredIndependence: 'provider-independent',
        achievedIndependence: 'session-independent',
        providerIndependent: false,
        sessionIndependent: true,
        orchestration: 'engine-spawned-provider',
      },
    );
    for (const invalid of [
      {
        actualParticipant: participant('codex', 'author-session'),
        callableProviderIds: ['codex'] as const,
      },
      {
        actualParticipant: participant('claude', 'fresh-session'),
        callableProviderIds: ['codex', 'claude'] as const,
      },
      {
        actualParticipant: participant('codex', 'fresh-session'),
        callableProviderIds: ['codex', 'claude'] as const,
      },
      {
        actualParticipant: {
          ...participant('codex', 'fresh-session'),
          engineSpawned: false,
        },
        callableProviderIds: ['codex'] as const,
      },
    ]) {
      assert.throws(
        () =>
          authorizeGrantedOrdinaryRole({
            role: 'blind-surveyor',
            author,
            targetDigest: TARGET_DIGEST,
            reservation: fixture.reservation,
            actualParticipant: invalid.actualParticipant,
            callableProviderIds: [...invalid.callableProviderIds],
          }),
        (error) => isWorkflowError(error, 'COLLABORATION_GRANT_ROLE_INVALID'),
      );
    }
  } finally {
    fixture.cleanup();
  }
});

test('ordinary scheduling never upgrades an unknown author provider to provider-independent', () => {
  assert.deepEqual(
    scheduleOrdinaryRole({
      role: 'blind-surveyor',
      author: {
        providerId: undefined,
        sessionId: undefined,
        principalId: undefined,
        identityAssurance: 'self-declared',
        engineSpawned: false,
      },
      targetDigest: TARGET_DIGEST,
      candidates: [
        {
          providerId: 'claude',
          sessionId: 'candidate-session',
          enabled: true,
          available: true,
        },
      ],
    }),
    {
      outcome: 'collaboration-grant-required',
      role: 'blind-surveyor',
      requiredIndependence: 'provider-independent',
      reason: 'NO_PROVIDER_INDEPENDENT_CANDIDATE',
    },
  );
});

test('no-callable degraded forms record no provider invocation or independence', () => {
  for (const degradedForm of [
    'caller-supplied',
    'direct-human-review',
  ] as const) {
    const fixture = reservedFixture(degradedForm);
    try {
      const role =
        degradedForm === 'direct-human-review'
          ? ('plan-reviewer' as const)
          : ('blind-surveyor' as const);
      const actualParticipant: RoleParticipant = {
        providerId: undefined,
        sessionId: undefined,
        principalId:
          degradedForm === 'direct-human-review'
            ? 'fixture-maintainer'
            : 'fixture-caller',
        identityAssurance:
          degradedForm === 'direct-human-review'
            ? 'adapter-assigned'
            : 'self-declared',
        engineSpawned: false,
      };
      const directHumanReview =
        degradedForm === 'direct-human-review'
          ? {
              attestation: createDirectHumanReviewAttestation(
                fixture.repository,
                {
                  grantEnvelope: fixture.reservation.envelope,
                  transitionDigest: TRANSITION_DIGEST,
                  reviewNodeId: CONTENT_NODE_ID,
                  reviewResultDigest: CONTENT_RESULT_DIGEST,
                },
                {
                  now: new Date(NOW.getTime() + 90_000),
                  signer: fixture.signer,
                },
              ),
              policy: POLICY,
              verifier: fixture.signer,
              now: new Date(NOW.getTime() + 90_000),
              reviewNodeId: CONTENT_NODE_ID,
              reviewResultDigest: CONTENT_RESULT_DIGEST,
            }
          : undefined;
      if (degradedForm === 'direct-human-review') {
        assert.throws(
          () =>
            authorizeGrantedOrdinaryRole({
              role,
              author: participant('codex', 'author-session'),
              targetDigest: TARGET_DIGEST,
              reservation: fixture.reservation,
              actualParticipant,
              callableProviderIds: [],
            }),
          (error) => isWorkflowError(error, 'COLLABORATION_GRANT_ROLE_INVALID'),
        );
      }
      const assignment = authorizeGrantedOrdinaryRole({
        role,
        author: participant('codex', 'author-session'),
        targetDigest: TARGET_DIGEST,
        reservation: fixture.reservation,
        actualParticipant,
        callableProviderIds: [],
        directHumanReview,
      });
      assert.equal(assignment.providerId, null);
      assert.equal(assignment.sessionId, null);
      assert.equal(assignment.engineSpawned, false);
      assert.equal(assignment.providerIndependent, false);
      assert.equal(assignment.sessionIndependent, false);
      assert.equal(assignment.achievedIndependence, 'none');
      assert.equal(
        assignment.orchestration,
        degradedForm === 'direct-human-review'
          ? 'direct-human-review'
          : 'caller-supplied',
      );
      assert.equal(
        assignment.authorizedEffect,
        COLLABORATION_GRANT_AUTHORIZED_EFFECT,
      );
      assert.equal(
        assignment.directHumanReviewAttestationDigest,
        directHumanReview
          ? directHumanReviewAttestationDigest(directHumanReview.attestation)
          : null,
      );
      assert.equal(
        assignment.participant.identityAssurance,
        degradedForm === 'direct-human-review'
          ? 'maintainer-signed'
          : 'self-declared',
      );
      assert.equal(
        Object.keys(assignment).some((key) => /skip|waive|approve/i.test(key)),
        false,
      );
      if (directHumanReview) {
        assert.ok(
          fixture.namespaces.includes(DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE),
        );
        const tamperedAttestation = structuredClone(
          directHumanReview.attestation,
        );
        tamperedAttestation.signature = fixtureSignature(
          'tampered review bytes',
          DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE,
        );
        assert.throws(
          () =>
            authorizeGrantedOrdinaryRole({
              role,
              author: participant('codex', 'author-session'),
              targetDigest: TARGET_DIGEST,
              reservation: fixture.reservation,
              actualParticipant,
              callableProviderIds: [],
              directHumanReview: {
                ...directHumanReview,
                attestation: tamperedAttestation,
              },
            }),
          (error) => isWorkflowError(error, 'COLLABORATION_SIGNATURE_INVALID'),
        );
        const consumed = consumeCollaborationGrant(
          fixture.common,
          fixture.grantId,
          {
            transitionDigest: TRANSITION_DIGEST,
            assignment,
            contentAdmission: {
              kind: 'plan-review',
              nodeId: CONTENT_NODE_ID,
              resultDigest: CONTENT_RESULT_DIGEST,
              current: true,
            },
            directHumanReviewAttestation: directHumanReview.attestation,
            now: new Date(NOW.getTime() + 120_000),
          },
        );
        assert.ok(consumed.use);
        assert.doesNotThrow(() =>
          validateCollaborationGrantUseProjection(consumed.use, {
            now: new Date(NOW.getTime() + 120_000),
            expectedBinding: expectedBinding(fixture.reservation.envelope),
            policy: POLICY,
            verifier: fixture.signer,
            transitionDigest: TRANSITION_DIGEST,
            expectedAssignment: assignment,
            contentAdmission: {
              kind: 'plan-review',
              nodeId: CONTENT_NODE_ID,
              resultDigest: CONTENT_RESULT_DIGEST,
              current: true,
            },
          }),
        );
        const admitted = admitRoleResult({
          assignment,
          author: assignment.author,
          participant: assignment.participant,
          content: roleContent('plan-review'),
          providerInvocation: null,
          grantUse: consumed.use,
          grantValidation: {
            now: new Date(NOW.getTime() + 120_000),
            expectedBinding: expectedBinding(fixture.reservation.envelope),
            policy: POLICY,
            verifier: fixture.signer,
            transitionDigest: TRANSITION_DIGEST,
          },
        });
        assert.equal(admitted.form, 'direct-human-attestation');
        assert.equal(admitted.providerInvocation, null);
        assert.ok(admitted.directHumanReviewAttestation);
      }

      assert.throws(
        () =>
          authorizeGrantedOrdinaryRole({
            role,
            author: participant('codex', 'author-session'),
            targetDigest: TARGET_DIGEST,
            reservation: fixture.reservation,
            actualParticipant,
            callableProviderIds: ['codex'],
          }),
        (error) => isWorkflowError(error, 'COLLABORATION_GRANT_ROLE_INVALID'),
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test('aggregate grant uses reject a duplicate claim across one subject', () => {
  const first = {
    grantId: 'grant-aaaaaaaaaaaaaaaa',
    signedEnvelopeDigest: 'a'.repeat(64),
    transitionDigest: 'b'.repeat(64),
  };
  const second = {
    grantId: 'grant-bbbbbbbbbbbbbbbb',
    signedEnvelopeDigest: 'c'.repeat(64),
    transitionDigest: 'd'.repeat(64),
  };

  assertUniqueCollaborationGrantUses([]);
  assertUniqueCollaborationGrantUses([first, second]);

  // Every grant is issued with maxUses: 1, so the same grant replayed at a
  // second transition is a duplicate claim even though each use is well formed.
  assert.throws(
    () =>
      assertUniqueCollaborationGrantUses([
        first,
        { ...first, transitionDigest: 'e'.repeat(64) },
      ]),
    (error) => isWorkflowError(error, 'COLLABORATION_GRANT_USE_DUPLICATE'),
  );
  // A re-signed envelope replayed under a fresh grant ID is equally rejected.
  assert.throws(
    () =>
      assertUniqueCollaborationGrantUses([
        first,
        { ...second, signedEnvelopeDigest: first.signedEnvelopeDigest },
      ]),
    (error) => isWorkflowError(error, 'COLLABORATION_GRANT_USE_DUPLICATE'),
  );
});

test('invalid content admission terminally fails a reserved grant', () => {
  const fixture = reservedFixture('caller-supplied');
  try {
    const assignment = authorizeGrantedOrdinaryRole({
      role: 'blind-surveyor',
      author: participant('codex', 'author-session'),
      targetDigest: TARGET_DIGEST,
      reservation: fixture.reservation,
      actualParticipant: {
        providerId: undefined,
        sessionId: undefined,
        principalId: 'fixture-caller',
        identityAssurance: 'self-declared',
        engineSpawned: false,
      },
      callableProviderIds: [],
    });
    assert.throws(
      () =>
        consumeCollaborationGrant(fixture.common, fixture.grantId, {
          transitionDigest: TRANSITION_DIGEST,
          assignment,
          contentAdmission: {
            kind: 'blind-survey',
            nodeId: CONTENT_NODE_ID,
            resultDigest: CONTENT_RESULT_DIGEST,
            current: false,
          } as never,
          now: new Date(NOW.getTime() + 120_000),
        }),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_USE_INVALID'),
    );
    assert.equal(
      inspectCollaborationGrants(fixture.common, fixture.grantId)[0]?.state,
      'failed',
    );
  } finally {
    fixture.cleanup();
  }
});

test('grant consumption requires structured survey or review content and retains every assurance obligation', () => {
  const fixture = reservedFixture('caller-supplied');
  try {
    const assignment = authorizeGrantedOrdinaryRole({
      role: 'blind-surveyor',
      author: participant('codex', 'author-session'),
      targetDigest: TARGET_DIGEST,
      reservation: fixture.reservation,
      actualParticipant: {
        providerId: undefined,
        sessionId: undefined,
        principalId: 'fixture-caller',
        identityAssurance: 'self-declared',
        engineSpawned: false,
      },
      callableProviderIds: [],
    });
    const consumed = consumeCollaborationGrant(
      fixture.common,
      fixture.grantId,
      {
        transitionDigest: TRANSITION_DIGEST,
        assignment,
        contentAdmission: {
          kind: 'blind-survey',
          nodeId: CONTENT_NODE_ID,
          resultDigest: CONTENT_RESULT_DIGEST,
          current: true,
        },
        now: new Date(NOW.getTime() + 120_000),
      },
    );
    assert.deepEqual(
      consumed.use?.retainedObligations,
      COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
    );
    assert.deepEqual(COLLABORATION_GRANT_RETAINED_OBLIGATIONS, [
      'engine-search-floor',
      'typed-term-contributions',
      'effective-union-scan',
      'hit-dispositions',
      'why-ledger',
      'structured-role-content',
      'challenge-dispositions',
      'registered-checks',
      'allowed-paths',
      'freshness',
      'managed-transition-authority',
    ]);
    const use = consumed.use;
    assert.ok(use);
    assert.doesNotThrow(() =>
      validateCollaborationGrantUseProjection(use, {
        now: new Date(NOW.getTime() + 120_000),
        expectedBinding: expectedBinding(use.envelope),
        policy: POLICY,
        verifier: fixture.signer,
        transitionDigest: TRANSITION_DIGEST,
        expectedAssignment: assignment,
        contentAdmission: {
          kind: 'blind-survey',
          nodeId: CONTENT_NODE_ID,
          resultDigest: CONTENT_RESULT_DIGEST,
          current: true,
        },
      }),
    );
    const validationOptions = {
      now: new Date(NOW.getTime() + 120_000),
      expectedBinding: expectedBinding(use.envelope),
      policy: POLICY,
      verifier: fixture.signer,
      transitionDigest: TRANSITION_DIGEST,
      expectedAssignment: assignment,
      contentAdmission: {
        kind: 'blind-survey' as const,
        nodeId: CONTENT_NODE_ID,
        resultDigest: CONTENT_RESULT_DIGEST,
        current: true as const,
      },
    };
    assert.equal(
      validateCollaborationGrantUseSet([
        { value: use, options: validationOptions },
      ]).length,
      1,
    );
    const admitted = admitRoleResult({
      assignment,
      author: assignment.author,
      participant: assignment.participant,
      content: roleContent('blind-survey'),
      providerInvocation: null,
      grantUse: use,
      grantValidation: {
        now: validationOptions.now,
        expectedBinding: validationOptions.expectedBinding,
        policy: validationOptions.policy,
        verifier: validationOptions.verifier,
        transitionDigest: validationOptions.transitionDigest,
      },
    });
    assert.equal(admitted.form, 'granted-caller-supplied');
    assert.equal(admitted.orchestration, 'caller-supplied');
    assert.equal(admitted.providerInvocation, null);
    assert.match(admitted.resultDigest, /^[0-9a-f]{64}$/);
    assert.throws(
      () =>
        admitRoleResult({
          assignment,
          author: assignment.author,
          participant: assignment.participant,
          content: roleContent('blind-survey'),
          providerInvocation: {
            invocationId: 'fabricated',
            requestDigest: '5'.repeat(64),
            outputDigest: '6'.repeat(64),
            providerId: 'codex',
            sessionId: 'fabricated',
            targetDigest: TARGET_DIGEST,
            engineSpawned: true,
          },
          grantUse: use,
          grantValidation: {
            now: validationOptions.now,
            expectedBinding: validationOptions.expectedBinding,
            policy: validationOptions.policy,
            verifier: validationOptions.verifier,
            transitionDigest: validationOptions.transitionDigest,
          },
        }),
      (error) => isWorkflowError(error, 'ROLE_RESULT_INVALID'),
    );
    assert.throws(
      () =>
        validateCollaborationGrantUseSet([
          { value: use, options: validationOptions },
          { value: structuredClone(use), options: validationOptions },
        ]),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_USE_INVALID'),
    );
    assert.throws(
      () =>
        validateCollaborationGrantUseProjection(
          {
            ...use,
            structuredContent: {
              ...use.structuredContent,
              nodeId: '9'.repeat(64),
            },
          },
          {
            now: new Date(NOW.getTime() + 120_000),
            expectedBinding: expectedBinding(use.envelope),
            policy: POLICY,
            verifier: fixture.signer,
            transitionDigest: TRANSITION_DIGEST,
            expectedAssignment: assignment,
            contentAdmission: {
              kind: 'blind-survey',
              nodeId: CONTENT_NODE_ID,
              resultDigest: CONTENT_RESULT_DIGEST,
              current: true,
            },
          },
        ),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_USE_INVALID'),
    );
  } finally {
    fixture.cleanup();
  }
});

function roleContent(kind: 'blind-survey' | 'plan-review') {
  return {
    kind,
    nodeId: CONTENT_NODE_ID,
    resultDigest: CONTENT_RESULT_DIGEST,
    outputSchema: {
      id: `${kind}-output.v1`,
      version: 1,
      digest: '5'.repeat(64),
    },
    evaluator: `${kind}-evaluator.v1`,
    policyDigest: '6'.repeat(64),
    contentDigest: CONTENT_RESULT_DIGEST,
    current: true as const,
  };
}

function collaborationFixture(): string {
  const repository = createFixtureRepository();
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(POLICY, null, 2)}\n`,
  );
  git(repository, ['remote', 'add', 'origin', POLICY.repository.origin]);
  git(repository, ['add', 'workflow/maintainer-policy.json']);
  git(repository, ['commit', '-m', 'Add fixture maintainer policy']);
  return repository;
}

function sameProviderRequest(repository: string): CollaborationGrantRequest {
  const baselineCommit = git(repository, ['rev-parse', 'HEAD']).trim();
  return {
    changeId: 'demo-change',
    taskId: null,
    baselineCommit,
    baselineTree: git(repository, [
      'rev-parse',
      `${baselineCommit}^{tree}`,
    ]).trim(),
    targetDigest: TARGET_DIGEST,
    lifecyclePhase: 'blind-survey',
    rolePair: {
      authorRole: 'investigation-author',
      conflictingRole: 'blind-surveyor',
    },
    availableActor: {
      kind: 'provider',
      providerId: 'codex',
      assurance: 'runtime-hint',
    },
    degradedForm: 'same-provider-fresh-session',
    reason: 'No alternate provider is callable for this exact survey.',
    ttlMinutes: 30,
    maxUses: 1,
  };
}

function expectedBinding(
  envelope: CollaborationGrantEnvelope,
): CollaborationGrantExpectedBinding {
  const payload = envelope.payload;
  return {
    repositoryId: payload.repositoryId,
    repositoryOrigin: payload.repositoryOrigin,
    policyBlob: payload.policyBlob,
    collaborationPolicyDigest: payload.collaborationPolicyDigest,
    changeId: payload.changeId,
    taskId: payload.taskId,
    baselineCommit: payload.baselineCommit,
    baselineTree: payload.baselineTree,
    targetDigest: payload.targetDigest,
    lifecyclePhase: payload.lifecyclePhase,
    rolePair: payload.rolePair,
    availableActor: payload.availableActor,
    degradedForm: payload.degradedForm,
    reason: payload.reason,
  };
}

function fixtureSigner(namespaces: string[] = []): MaintainerSignerProvider {
  return {
    assertHumanPresent() {},
    identity() {
      return 'fixture-maintainer';
    },
    sign(payload, namespace) {
      assert.ok(namespace);
      namespaces.push(namespace);
      return fixtureSignature(payload, namespace);
    },
    verify(payload, signature, identity, namespace) {
      assert.ok(namespace);
      namespaces.push(namespace);
      if (
        identity !== 'fixture-maintainer' ||
        signature !== fixtureSignature(payload, namespace)
      ) {
        const error = new Error('invalid collaboration signature') as Error & {
          code: string;
        };
        error.code = 'MAINTAINER_SIGNATURE_INVALID';
        throw error;
      }
    },
  };
}

function fixtureSignature(payload: string, namespace: string): string {
  const encoded = crypto
    .createHash('sha256')
    .update(`${namespace}\0${payload}`)
    .digest('base64');
  return [
    '-----BEGIN SSH SIGNATURE-----',
    encoded,
    '-----END SSH SIGNATURE-----',
    '',
  ].join('\n');
}

function completeFixtureProviderInvocation(
  request: ProviderInvocationRequest,
  repository: string,
): void {
  const paths = investigationRuntimePaths(
    fs.realpathSync(path.join(repository, '.git')),
    'workflow-engine',
  );
  const claim = claimProviderInvocation(paths, request.invocationId, {
    workerId: 'granted-propose-worker',
    leaseDurationMs: 60_000,
  });
  const output = {
    reference: request.invocationId,
    terms: [{ kind: 'symbol', value: 'GrantedSurveyNeedle' }],
  };
  const wireResult = {
    schemaVersion: 1,
    requestDigest: request.requestDigest,
    invocationId: request.invocationId,
    nonce: request.nonce,
    purpose: request.purpose,
    providerId: request.providerId,
    roleAssignmentDigest: request.roleAssignmentDigest,
    capabilityProfile: request.capabilityProfile,
    repositoryId: request.repositoryId,
    baseCommit: request.baseCommit,
    baseTree: request.baseTree,
    targetDigest: request.targetDigest,
    inputManifestDigest: request.inputManifestDigest,
    authorizationNodeId: request.authorizationNodeId,
    outputSchema: request.outputSchema,
    evaluatorVersion: request.evaluatorVersion,
    policyDigest: request.policyDigest,
    limits: request.limits,
    observedTouchedPaths: [],
    output,
  };
  const outcome: ProviderProcessOutcome = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnErrorCode: null,
    elapsedMs: 1,
    stdout: JSON.stringify(wireResult),
    stderr: '',
  };
  completeProviderInvocation(paths, request.invocationId, {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    outcome,
  });
}

function fakeProviderRunnerReport(
  request: ProviderInvocationRequest,
  semanticOutput: unknown,
): ProviderRunnerReport {
  return {
    invocationId: request.invocationId,
    providerId: request.providerId,
    purpose: request.purpose,
    requestDigest: request.requestDigest,
    semanticOutput,
    semanticOutputDigest: sha256(canonicalJson(semanticOutput)),
    assurance: 'unchanged-governed-projection',
    projection: {
      unchanged: true,
      changedCategories: [],
      beforeDigest: 'a'.repeat(64),
      afterDigest: 'a'.repeat(64),
    },
    sameUserProcessConfined: false,
    residuals: [...PROVIDER_RUNNER_RESIDUALS],
    executable: {
      candidatePath: '/opt/homebrew/bin/codex',
      realPath: '/opt/homebrew/bin/codex',
      device: '1',
      inode: '2',
      mode: 0o100755,
      uid: 501,
      gid: 20,
      size: 1024,
      mtimeNs: '123456789',
      sha256: 'b'.repeat(64),
    },
    elapsedMs: 5,
  };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function participant(
  providerId: 'codex' | 'claude',
  sessionId: string,
): RoleParticipant {
  return {
    providerId,
    sessionId,
    principalId: 'fixture-agent',
    identityAssurance: 'runtime-hint',
    engineSpawned: true,
  };
}

function reservedFixture(
  degradedForm:
    'same-provider-fresh-session' | 'caller-supplied' | 'direct-human-review',
) {
  const repository = collaborationFixture();
  const grantId =
    degradedForm === 'same-provider-fresh-session'
      ? 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
      : degradedForm === 'caller-supplied'
        ? 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
        : 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const namespaces: string[] = [];
  const signer = fixtureSigner(namespaces);
  const base = sameProviderRequest(repository);
  const request: CollaborationGrantRequest =
    degradedForm === 'same-provider-fresh-session'
      ? base
      : degradedForm === 'caller-supplied'
        ? {
            ...base,
            availableActor: {
              kind: 'caller',
              callerId: 'fixture-caller',
              assurance: 'self-declared',
            },
            degradedForm,
          }
        : {
            ...base,
            lifecyclePhase: 'plan-review',
            rolePair: {
              authorRole: 'plan-author',
              conflictingRole: 'plan-reviewer',
            },
            availableActor: {
              kind: 'direct-human',
              identity: 'fixture-maintainer',
              assurance: 'maintainer-signed',
            },
            degradedForm,
          };
  const issued = issueCollaborationGrant(repository, request, {
    now: NOW,
    grantId,
    signer,
  });
  const common = fs.realpathSync(path.join(repository, '.git'));
  const reservation = reserveCollaborationGrant(repository, grantId, {
    transitionDigest: TRANSITION_DIGEST,
    now: new Date(NOW.getTime() + 60_000),
    expected: expectedBinding(issued.envelope),
    verifier: signer,
  });
  return {
    repository,
    common,
    grantId,
    signer,
    namespaces,
    reservation,
    cleanup() {
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}

function collaborationCliArguments(
  cli: string,
  request: CollaborationGrantRequest,
): string[] {
  if (request.availableActor.kind !== 'provider') {
    throw new Error('fixture expects provider actor');
  }
  return [
    '--experimental-strip-types',
    cli,
    'maintainer',
    'collaboration-grant',
    '--change',
    request.changeId,
    '--base',
    request.baselineCommit,
    '--target',
    request.targetDigest,
    '--phase',
    request.lifecyclePhase,
    '--author-role',
    request.rolePair.authorRole,
    '--conflicting-role',
    request.rolePair.conflictingRole,
    '--provider',
    request.availableActor.providerId,
    '--actor-assurance',
    request.availableActor.assurance,
    '--degraded',
    request.degradedForm,
    '--reason',
    request.reason,
    '--ttl',
    '30m',
    '--uses',
    '1',
    '--json',
  ];
}

function snapshotGrantStore(root: string): Array<{
  path: string;
  mode: number;
  content: string;
}> {
  if (!fs.existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else {
        files.push(absolute);
      }
    }
  };
  visit(root);
  return files.map((absolute) => ({
    path: path.relative(root, absolute),
    mode: fs.lstatSync(absolute).mode & 0o777,
    content: fs.readFileSync(absolute, 'utf8'),
  }));
}
