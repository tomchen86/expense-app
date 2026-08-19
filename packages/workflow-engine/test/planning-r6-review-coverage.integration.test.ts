import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import type { EvidenceNode } from '../src/adapters/compatibility/investigation-v2/evidence-node.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import {
  PLAN_REVIEW_COVERAGE,
  type PlanReviewReport,
  type PlanReviewSubmission,
} from '../src/modules/assurance/plan-review.ts';
import { assertPlanReviewCoverageRequirementSatisfied } from '../src/modules/assurance/plan-review-coverage.ts';
import type { ProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import { PROPOSE_POLICY_DIGEST } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  PROVIDER_RUNNER_RESIDUALS,
  type ProviderRunnerReport,
} from '../src/runtime/provider-execution/provider-runner.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import { commitPlanningTransition } from '../src/application/propose/planning-transition.ts';
import {
  createPlanningContributionEnvelope,
  createPlanReviewDispositionsEnvelope,
  createPlanReviewProgressEnvelope,
  getProposeStatus,
  resumePropose,
} from '../src/application/propose/propose-orchestrator.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import {
  resumeTask,
  reviseTask,
} from '../src/application/revise/task-revision.ts';
import {
  ledgerIndexPath,
  ledgerObjectPath,
} from '../src/runtime/storage-journal/semantic-ledger-store.ts';
import { createLedgerEntry } from '../src/modules/why-knowledge/semantic-ledger.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  writeReadyV2ExemptChange,
} from './fixture.ts';
import { installPlanReviewAuthority } from './plan-review-authority-fixture.ts';
import { driveProposeToDispositions } from './propose-drive-fixture.ts';

const TARGET = 'src/r6-covered-target.ts';
const TARGET_CONTENT = 'PlanningR6CoverageNeedle production contract\n';
const TERM = 'PlanningR6CoverageNeedle';

test('ordinary planning with no semantic reuse still seals the global review population', () => {
  const prepared = prepareCoverageReview('r6-coverage-global', {
    includeLedger: false,
  });
  try {
    const investigation = JSON.parse(
      fs.readFileSync(
        path.join(
          prepared.repository,
          'openspec/changes',
          prepared.changeId,
          'investigation.json',
        ),
        'utf8',
      ),
    ) as { nodes: EvidenceNode[] };
    const coverageNodes = investigation.nodes.filter(
      ({ type }) => type === 'plan-review-coverage-requirement',
    );
    assert.equal(coverageNodes.length, 1);
    const output = coverageNodes[0]!.output as {
      schemaVersion: number;
      activation: string;
      targetBindings: Array<{
        path: string;
        invariants: string[];
        riskFactors: string[];
        freshness: string;
        evidenceMode: string;
        degradedExtraction: boolean;
        cost: { rawBytes: number; reviewUnits: number };
      }>;
      costProfile: {
        targetCount: number;
        rawBytes: number;
        reviewUnits: number;
      };
    };
    assert.equal(output.schemaVersion, 2);
    assert.equal(output.activation, 'global');
    const target = output.targetBindings.find(
      ({ path: targetPath }) => targetPath === TARGET,
    );
    assert.ok(target);
    assert.ok(
      target.invariants.includes('Required targets cannot be omitted.'),
    );
    assert.ok(target.riskFactors.length > 0);
    assert.equal(target.freshness, 'missing-ledger-entry');
    assert.equal(target.evidenceMode, 'full-blob');
    assert.equal(typeof target.degradedExtraction, 'boolean');
    assert.equal(target.cost.rawBytes, Buffer.byteLength(TARGET_CONTENT));
    assert.ok(target.cost.reviewUnits > 0);
    assert.equal(output.costProfile.targetCount, output.targetBindings.length);
    assert.ok(output.costProfile.rawBytes >= Buffer.byteLength(TARGET_CONTENT));
  } finally {
    prepared.dispose();
  }
});

test('carried semantic reuse seals an engine-owned required review set into the immutable planning snapshot', () => {
  const prepared = prepareCoverageReview('r6-coverage-visible');
  try {
    const investigation = JSON.parse(
      fs.readFileSync(
        path.join(
          prepared.repository,
          'openspec/changes',
          prepared.changeId,
          'investigation.json',
        ),
        'utf8',
      ),
    ) as { nodes: EvidenceNode[] };
    const coverageNodes = investigation.nodes.filter(
      ({ type }) => type === 'plan-review-coverage-requirement',
    );
    assert.equal(coverageNodes.length, 1);
    const output = coverageNodes[0]!.output as {
      coverageTier: string;
      sealedSamplingSeed: string;
      manifest: { targets: Array<{ targetId: string; stratum: string }> };
      requiredTargetIds: string[];
      targetBindings: Array<{
        targetId: string;
        path: string;
        source: string;
        reusedFromLedger: boolean;
      }>;
    };
    assert.equal(output.coverageTier, 'critical');
    assert.match(output.sealedSamplingSeed, /^[0-9a-f]{64}$/);
    assert.ok(
      output.targetBindings.some(
        ({ path: targetPath, source, reusedFromLedger }) =>
          targetPath === TARGET &&
          source === 'planned-mutation' &&
          reusedFromLedger,
      ),
    );
    assert.ok(output.requiredTargetIds.length >= 1);
    for (const required of output.requiredTargetIds) {
      assert.ok(
        output.manifest.targets.some(({ targetId }) => targetId === required),
      );
    }

    const invocationRoot = path.join(
      investigationRuntimePaths(
        discoverRepository(prepared.repository).gitCommonDirectory,
        'workflow-engine',
      ).invocations,
      prepared.invocationId,
    );
    const durableManifest = JSON.parse(
      fs.readFileSync(path.join(invocationRoot, 'manifest.json'), 'utf8'),
    ) as {
      planningTarget: {
        artifacts: Array<{ path: string; snapshotFile: string }>;
      };
    };
    const investigationArtifact = durableManifest.planningTarget.artifacts.find(
      ({ path: artifactPath }) => artifactPath.endsWith('/investigation.json'),
    );
    assert.ok(investigationArtifact);
    const snapshottedInvestigation = fs.readFileSync(
      path.join(
        invocationRoot,
        'review-root',
        investigationArtifact.snapshotFile,
      ),
      'utf8',
    );
    assert.match(snapshottedInvestigation, /plan-review-coverage-requirement/);
  } finally {
    prepared.dispose();
  }
});

test('plan commit rejects a provider submission that omits an engine-required target', () => {
  const prepared = prepareCoverageReview('r6-coverage-omitted');
  try {
    completeProviderReview(prepared, noChallengeSubmission('proposal-only'));
    assert.throws(
      () =>
        resumePropose(
          prepared.repository,
          prepared.changeId,
          createPlanReviewProgressEnvelope(
            getProposeStatus(prepared.repository, prepared.investigationId),
          ),
        ),
      (error) => isWorkflowError(error, 'REVIEW_COVERAGE_INCOMPLETE'),
    );
  } finally {
    prepared.dispose();
  }
});

test('exact evidence for every required binding permits the immutable plan-commit replay', () => {
  const prepared = prepareCoverageReview('r6-coverage-complete', {
    includeLedger: false,
  });
  try {
    completeProviderReview(
      prepared,
      noChallengeSubmission('covered-target', coverageTargetPaths(prepared)),
    );
    const completed = resumePropose(
      prepared.repository,
      prepared.changeId,
      createPlanReviewProgressEnvelope(
        getProposeStatus(prepared.repository, prepared.investigationId),
      ),
    );
    assert.equal(completed.state, 'planning-complete');
    const planDigest = (
      completed as typeof completed & {
        planDigest?: {
          schemaVersion: number;
          kind: string;
          proposalWhy: string;
          keyDecisions: string[];
          touchedFilesAndWhy: Array<{
            path: string;
            why: string;
            protectedInvariant: string;
          }>;
          openQuestions: string[];
          rendered: string;
        };
      }
    ).planDigest;
    assert.ok(planDigest);
    assert.equal(planDigest.schemaVersion, 1);
    assert.equal(planDigest.kind, 'workflow-plan-digest.v1');
    assert.match(planDigest.proposalWhy, /semantic review coverage/i);
    assert.ok(
      planDigest.keyDecisions.some((decision) =>
        /seals required review targets/i.test(decision),
      ),
    );
    assert.deepEqual(
      planDigest.touchedFilesAndWhy.map(({ path }) => path),
      [TARGET],
    );
    assert.match(
      planDigest.touchedFilesAndWhy[0]!.why,
      /owns review coverage behavior/i,
    );
    assert.match(
      planDigest.touchedFilesAndWhy[0]!.protectedInvariant,
      /cannot be omitted/i,
    );
    assert.deepEqual(planDigest.openQuestions, []);
    assert.match(planDigest.rendered, /^# Plan Digest/m);
    assert.match(planDigest.rendered, /## Touched Files and Why/);
  } finally {
    prepared.dispose();
  }
});

test('a revising task regenerates ordinary investigation and PlanReview before same-session resume', () => {
  const repository = createFixtureRepository();
  const authority = installPlanReviewAuthority(repository);
  const startedAt = new Date();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.writeFileSync(path.join(repository, TARGET), TARGET_CONTENT);
    fs.writeFileSync(
      path.join(repository, 'workflow/path-roles.json'),
      `${canonicalJson({
        schemaVersion: 1,
        kind: 'path-role-registry',
        roles: { ordinary: ['src/**'] },
      })}\n`,
    );
    git(repository, [
      'add',
      TARGET,
      'workflow/path-roles.json',
      'workflow/maintainer-policy.json',
    ]);
    git(repository, ['commit', '-m', 'Prepare revision review fixture']);
    writeReadyV2ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');

    const session = startSession(repository, 'demo-change', '1.1');
    const implementation = `${TARGET_CONTENT}export const revised = true;\n`;
    fs.writeFileSync(path.join(repository, TARGET), implementation);
    reviseTask(repository, session.sessionId, 'regenerate-reviewed-plan', {
      now: () => startedAt,
    });
    const preRevisionHead = git(repository, ['rev-parse', 'HEAD']).trim();

    const fixture = driveProposeToDispositions('demo-change', {
      repository,
      mainTerm: TERM,
      surveyTerm: TERM,
      explicitPaths: [TARGET],
      explicitSymbols: [],
    });
    const afterDispositions = fixture.submit({
      dispositions: (fixture.output.work?.groups ?? []).map(({ groupId }) => ({
        groupId,
        classification: 'load-bearing' as const,
        rationale: 'The target owns the R6 production coverage contract.',
        author: 'codex',
      })),
    });
    const sealed = fixture.submit({
      answers: (afterDispositions.work?.fullBlobManifest ?? []).map(
        ({ manifestEntryId }) => ({
          manifestEntryId,
          why: 'The target owns review coverage behavior.',
          protectedInvariant: 'Required targets cannot be omitted.',
          reviewerQuestion: 'Does plan commit replay every required target?',
          answer: 'Yes, against the immutable review snapshot.',
          semanticAuthor: 'codex',
          readComplete: true as const,
        }),
      ),
    });
    assert.equal(sealed.state, 'awaiting-planning-contribution');
    const materialized = resumePropose(
      repository,
      'demo-change',
      createPlanningContributionEnvelope(
        sealed,
        planningPayload('demo-change'),
      ),
    );
    assert.equal(materialized.state, 'waiting-for-plan-review');
    completeProviderReview(
      {
        repository,
        invocationId: materialized.planReview!.invocationId,
      },
      noChallengeSubmission(
        'covered-target',
        coverageTargetPaths({ repository, changeId: 'demo-change' }),
      ),
    );
    const reviewed = resumePropose(
      repository,
      'demo-change',
      createPlanReviewProgressEnvelope(
        getProposeStatus(repository, fixture.investigationId),
      ),
    );

    assert.equal(reviewed.state, 'revision-plan-reviewed');
    assert.equal(reviewed.nextAction, 'resume-task');
    assert.equal(reviewed.planningTransition, null);
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      preRevisionHead,
    );
    assert.equal(
      fs.readFileSync(path.join(repository, TARGET), 'utf8'),
      implementation,
    );

    const resumed = resumeTask(repository, session.sessionId, {
      now: () => new Date(startedAt.getTime() + 60_000),
    });
    assert.equal(resumed.session.sessionId, session.sessionId);
    assert.equal(resumed.session.state, 'active');
    assert.notEqual(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      preRevisionHead,
    );
    assert.equal(
      fs.readFileSync(path.join(repository, TARGET), 'utf8'),
      implementation,
    );
    assert.equal(
      resumed.session.planningAssurance?.applicabilityKind,
      'sealed-investigation',
    );
  } finally {
    authority.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('coverage replay detects a carried target digest change and requires delta review', () => {
  const prepared = prepareCoverageReview('r6-coverage-delta');
  try {
    const investigation = JSON.parse(
      fs.readFileSync(
        path.join(
          prepared.repository,
          'openspec/changes',
          prepared.changeId,
          'investigation.json',
        ),
        'utf8',
      ),
    ) as { nodes: EvidenceNode[] };
    const requirementNode = investigation.nodes.find(
      ({ type }) => type === 'plan-review-coverage-requirement',
    )!;
    const requirement = requirementNode.output as {
      baselineCommit: string;
      baselineTree: string;
    };
    const index = JSON.parse(
      fs.readFileSync(
        path.join(prepared.repository, ledgerIndexPath()),
        'utf8',
      ),
    ) as {
      subjects: Record<string, { currentEntryId: string }>;
    };
    const entryId = index.subjects['file.r6-covered-target']!.currentEntryId;
    fs.writeFileSync(
      path.join(prepared.repository, ledgerObjectPath(entryId)),
      '{}\n',
      'utf8',
    );

    assert.throws(
      () =>
        assertPlanReviewCoverageRequirementSatisfied({
          repositoryRoot: prepared.repository,
          requirementNode,
          review: noChallengeSubmission(
            'covered-target',
            coverageTargetPaths(prepared),
          ) as unknown as PlanReviewReport,
          expectedChangeId: prepared.changeId,
          expectedBaseline: {
            head: requirement.baselineCommit,
            tree: requirement.baselineTree,
          },
        }),
      (error) => isWorkflowError(error, 'REVIEW_DELTA_REQUIRED'),
    );
  } finally {
    prepared.dispose();
  }
});

test('global review challenges require and replay an independent signed closure', () => {
  const prepared = prepareCoverageReview('r6-challenge-authority');
  try {
    completeProviderReview(
      prepared,
      challengeSubmission(coverageTargetPaths(prepared), 'medium'),
    );
    const awaiting = resumePropose(
      prepared.repository,
      prepared.changeId,
      createPlanReviewProgressEnvelope(
        getProposeStatus(prepared.repository, prepared.investigationId),
      ),
    );
    assert.equal(awaiting.state, 'awaiting-challenge-dispositions');
    const reviewArtifact = JSON.parse(
      fs.readFileSync(
        path.join(
          prepared.repository,
          'openspec/changes',
          prepared.changeId,
          'plan-review.json',
        ),
        'utf8',
      ),
    ) as { nodes: EvidenceNode[] };
    const reviewNode = reviewArtifact.nodes.find(
      ({ type }) => type === 'plan-review',
    );
    assert.ok(reviewNode);
    const challengeId = (
      reviewNode.output as { findings: Array<{ findingId: string }> }
    ).findings[0]!.findingId;
    const envelope = createPlanReviewDispositionsEnvelope(awaiting, [
      {
        challengeId,
        decision: 'rebutted',
        rationale:
          'The exact required-set evidence demonstrates that the concern is already covered.',
        author: prepared.authority.identity,
        supersededBy: null,
      },
    ]);
    assert.throws(
      () => resumePropose(prepared.repository, prepared.changeId, envelope),
      (error) => isWorkflowError(error, 'MAINTAINER_INTERACTIVE_REQUIRED'),
    );
    const forgedAuthor = structuredClone(envelope);
    forgedAuthor.dispositions[0]!.author = 'codex';
    assert.throws(
      () =>
        resumePropose(prepared.repository, prepared.changeId, forgedAuthor, {
          challengeDispositionAuthority: {
            now: new Date('2026-08-10T00:00:00.000Z'),
            role: 'reviewer',
            signer: prepared.authority.signer,
          },
        }),
      (error) => isWorkflowError(error, 'PLAN_REVIEW_INVALID'),
    );
    const completed = resumePropose(
      prepared.repository,
      prepared.changeId,
      envelope,
      {
        challengeDispositionAuthority: {
          now: new Date('2026-08-10T00:00:00.000Z'),
          role: 'reviewer',
          signer: prepared.authority.signer,
        },
      },
    );
    assert.equal(completed.state, 'planning-complete');
  } finally {
    prepared.dispose();
  }
});

test('forbidden-floor challenges cannot be waived by a signed domain owner', () => {
  const prepared = prepareCoverageReview('r6-forbidden-floor');
  try {
    completeProviderReview(
      prepared,
      challengeSubmission(coverageTargetPaths(prepared), 'critical'),
    );
    const awaiting = resumePropose(
      prepared.repository,
      prepared.changeId,
      createPlanReviewProgressEnvelope(
        getProposeStatus(prepared.repository, prepared.investigationId),
      ),
    );
    const challengeId = currentChallengeId(prepared);
    const envelope = createPlanReviewDispositionsEnvelope(awaiting, [
      {
        challengeId,
        decision: 'waived',
        rationale: 'A critical policy floor must reject this waiver.',
        author: prepared.authority.identity,
        supersededBy: null,
      },
    ]);
    assert.throws(
      () =>
        resumePropose(prepared.repository, prepared.changeId, envelope, {
          challengeDispositionAuthority: {
            now: new Date('2026-08-10T00:00:00.000Z'),
            role: 'domain-owner',
            signer: prepared.authority.signer,
          },
        }),
      (error) => isWorkflowError(error, 'REVIEW_CHALLENGE_INVALID'),
    );
    const artifact = JSON.parse(
      fs.readFileSync(
        path.join(
          prepared.repository,
          'openspec/changes',
          prepared.changeId,
          'plan-review.json',
        ),
        'utf8',
      ),
    ) as { currentRefs: { planReviewDisposition?: string } };
    assert.equal(artifact.currentRefs.planReviewDisposition, undefined);
  } finally {
    prepared.dispose();
  }
});

function prepareCoverageReview(
  changeId: string,
  options: { includeLedger?: boolean } = {},
) {
  const includeLedger = options.includeLedger ?? true;
  let authority: ReturnType<typeof installPlanReviewAuthority> | null = null;
  const fixture = driveProposeToDispositions(changeId, {
    mainTerm: TERM,
    surveyTerm: TERM,
    explicitPaths: [TARGET],
    explicitSymbols: [],
    prepareRepository(repository) {
      authority = installPlanReviewAuthority(repository);
    },
    files: {
      [TARGET]: TARGET_CONTENT,
      ...(includeLedger ? ledgerFiles(changeId) : {}),
      'workflow/path-roles.json': `${canonicalJson({
        schemaVersion: 1,
        kind: 'path-role-registry',
        roles: { ordinary: ['src/**'] },
      })}\n`,
    },
  });
  const afterDispositions = fixture.submit({
    dispositions: (fixture.output.work?.groups ?? []).map(({ groupId }) => ({
      groupId,
      classification: 'load-bearing' as const,
      rationale: 'The target owns the R6 production coverage contract.',
      author: 'codex',
    })),
  });
  assert.equal(
    afterDispositions.semanticReuse?.carriedCount,
    includeLedger ? 1 : 0,
  );
  const sealed = fixture.submit({
    answers: (afterDispositions.work?.fullBlobManifest ?? []).map(
      ({ manifestEntryId }) => ({
        manifestEntryId,
        why: 'The target owns review coverage behavior.',
        protectedInvariant: 'Required targets cannot be omitted.',
        reviewerQuestion: 'Does plan commit replay every required target?',
        answer: 'Yes, against the immutable review snapshot.',
        semanticAuthor: 'codex',
        readComplete: true as const,
      }),
    ),
  });
  assert.equal(sealed.state, 'awaiting-planning-contribution');
  const materialized = resumePropose(
    fixture.repository,
    changeId,
    createPlanningContributionEnvelope(sealed, planningPayload(changeId)),
  );
  assert.equal(materialized.state, 'waiting-for-plan-review');
  return {
    ...fixture,
    invocationId: materialized.planReview!.invocationId,
    authority: authority!,
    dispose() {
      fixture.dispose();
      authority?.dispose();
    },
  };
}

function completeProviderReview(
  prepared: { repository: string; invocationId: string },
  submission: PlanReviewSubmission,
): void {
  runProviderWorker(prepared.repository, prepared.invocationId, {
    runner(input): ProviderRunnerReport {
      return fakePlanReviewRunnerReport(
        input.request,
        submission,
        input.invocationDirectory,
      );
    },
  });
}

function noChallengeSubmission(
  evidence: 'proposal-only' | 'covered-target',
  coveredPaths: readonly string[] = [TARGET],
): PlanReviewSubmission {
  return {
    schemaVersion: 2,
    verdict: 'advisory-approve',
    coverage: [...PLAN_REVIEW_COVERAGE],
    scopeAssessment: {
      kind: 'no-challenge',
      evidence:
        evidence === 'covered-target'
          ? coveredPaths.map((targetPath) => ({
              kind: 'repository-location',
              path: targetPath,
              line: 1,
              observation:
                'The exact engine-required review target was reviewed.',
            }))
          : [
              {
                kind: 'planning-location',
                path: 'openspec/changes/r6-coverage-omitted/proposal.md',
                line: 1,
                observation:
                  'Only the proposal was cited; the required production target was omitted.',
              },
            ],
    },
    findings: [],
    proposedTerms: [],
    suggestions: [],
    residualRisk: 'The review remains advisory and cannot prove correctness.',
    uncertainty: 'Runtime behavior remains subject to task-level checks.',
  };
}

function challengeSubmission(
  coveredPaths: readonly string[],
  severity: 'critical' | 'medium',
): PlanReviewSubmission {
  return {
    schemaVersion: 2,
    verdict: 'advisory-reject',
    coverage: [...PLAN_REVIEW_COVERAGE],
    scopeAssessment: { kind: 'challenges' },
    findings: [
      {
        kind: 'challenge',
        severity,
        category: 'missing-scope',
        currentChangeImpact: 'required',
        summary: 'Confirm every engine-required review target is covered.',
        evidence: coveredPaths.map((targetPath) => ({
          kind: 'repository-location' as const,
          path: targetPath,
          line: 1,
          observation: 'The exact required target was reviewed.',
        })),
      },
    ],
    proposedTerms: [],
    suggestions: [],
    residualRisk: 'Challenge closure must remain independently authorized.',
    uncertainty: 'No review can prove all future runtime behavior.',
  };
}

function currentChallengeId(
  prepared: ReturnType<typeof prepareCoverageReview>,
): string {
  const artifact = JSON.parse(
    fs.readFileSync(
      path.join(
        prepared.repository,
        'openspec/changes',
        prepared.changeId,
        'plan-review.json',
      ),
      'utf8',
    ),
  ) as { nodes: EvidenceNode[] };
  const reviewNode = artifact.nodes.find(({ type }) => type === 'plan-review');
  assert.ok(reviewNode);
  return (reviewNode.output as { findings: Array<{ findingId: string }> })
    .findings[0]!.findingId;
}

function coverageTargetPaths(prepared: {
  repository: string;
  changeId: string;
}): string[] {
  const investigation = JSON.parse(
    fs.readFileSync(
      path.join(
        prepared.repository,
        'openspec/changes',
        prepared.changeId,
        'investigation.json',
      ),
      'utf8',
    ),
  ) as { nodes: EvidenceNode[] };
  const requirement = investigation.nodes.find(
    ({ type }) => type === 'plan-review-coverage-requirement',
  )?.output as
    | {
        requiredTargetIds: string[];
        targetBindings: Array<{ targetId: string; path: string }>;
      }
    | undefined;
  assert.ok(requirement);
  const required = new Set(requirement.requiredTargetIds);
  return [
    ...new Set(
      requirement.targetBindings
        .filter(({ targetId }) => required.has(targetId))
        .map(({ path: targetPath }) => targetPath),
    ),
  ].sort();
}

function planningPayload(changeId: string) {
  return {
    proposal: '# Proposal\n\nEnforce semantic review coverage.\n',
    design: [
      '# Design',
      '',
      'The engine seals required review targets into investigation evidence.',
      '',
      '## Investigation Ledger',
      '',
      '<!-- workflow:investigation-ledger:start v1 -->',
      '',
      '<!-- workflow:investigation-ledger:end v1 -->',
      '',
    ].join('\n'),
    specs: [
      {
        path: 'specs/demo/spec.md',
        content: [
          '# Delta',
          '',
          '## ADDED Requirements',
          '',
          '### Requirement: Required review target',
          '',
          'The system SHALL bind every required target to the PlanReview.',
          '',
          '#### Scenario: A target is omitted',
          '',
          '- **WHEN** the reviewer omits a required target',
          '- **THEN** plan commit is blocked',
          '',
        ].join('\n'),
      },
    ],
    tasks: '# Tasks\n\n- [ ] 1.1 Enforce review coverage\n',
    guard: {
      schemaVersion: 1 as const,
      changeId,
      tasks: {
        '1.1': {
          allowedPaths: [TARGET],
          requiredChecks: ['fixture'],
        },
      },
    },
    executionTasks: {
      '1.1': {
        strategy: 'direct-reviewed' as const,
        enforcement: 'available' as const,
        allowedPaths: [TARGET],
        requiredChecks: ['fixture'],
        diffReview: 'policy-required' as const,
        exemptionKind: 'narrowly-scoped-non-behavioral' as const,
        exemptionReason:
          'The fixture exercises planning control flow without product behavior.',
        legacyBootstrap: null,
      },
    },
  };
}

function ledgerFiles(changeId: string): Record<string, string> {
  const sourceDigest = prefixedSha256(TARGET_CONTENT);
  const entry = createLedgerEntry({
    schemaVersion: 1,
    kind: 'semantic-ledger-entry',
    subject: {
      subjectId: 'file.r6-covered-target',
      kind: 'file',
      path: TARGET,
    },
    binding: {
      baselineCommit: '1'.repeat(40),
      blobDigest: sourceDigest,
      sourceDigest,
      semanticDigest: prefixedSha256('semantic-r6-covered-target'),
      extractorVersion: 'fixture.v1',
    },
    why: {
      responsibility: 'Own the R6 coverage production contract.',
      protectedInvariants: ['Carried understanding remains review-visible.'],
      failureModes: [],
      reviewerQuestions: ['Can a provider omit this carried subject?'],
    },
    semanticDependencies: [],
    policyDigest: `sha256:${PROPOSE_POLICY_DIGEST}`,
    provenance: { changeId, createdAtCommit: '1'.repeat(40) },
    supersedes: null,
    status: 'current',
  });
  return {
    [ledgerObjectPath(entry.entryId)]: `${canonicalJson(entry)}\n`,
    [ledgerIndexPath()]: `${canonicalJson({
      schemaVersion: 1,
      kind: 'semantic-ledger-index',
      subjects: {
        [entry.subject.subjectId]: { currentEntryId: entry.entryId },
      },
    })}\n`,
  };
}

function fakePlanReviewRunnerReport(
  request: ProviderInvocationRequest,
  semanticOutput: unknown,
  invocationDirectory: string,
): ProviderRunnerReport {
  const runtime = path.join(invocationDirectory, 'runtime');
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  for (const [name, content] of [
    ['prompt.json', '{}\n'],
    ['schema.json', '{}\n'],
    ['semantic-output.json', `${canonicalJson(semanticOutput)}\n`],
  ] as const) {
    fs.writeFileSync(path.join(runtime, name), content, { mode: 0o600 });
  }
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
      candidatePath: '/opt/homebrew/bin/claude',
      realPath: '/opt/homebrew/bin/claude',
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

function prefixedSha256(value: string): string {
  return `sha256:${sha256(value)}`;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
