import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import type { EvidenceNode } from '../src/evidence-node.ts';
import { discoverRepository } from '../src/git.ts';
import { investigationRuntimePaths } from '../src/paths.ts';
import {
  PLAN_REVIEW_COVERAGE,
  type PlanReviewReport,
  type PlanReviewSubmission,
} from '../src/plan-review.ts';
import { assertPlanReviewCoverageRequirementSatisfied } from '../src/plan-review-coverage.ts';
import type { ProviderInvocationRequest } from '../src/provider-contracts.ts';
import { PROPOSE_POLICY_DIGEST } from '../src/provider-contracts.ts';
import {
  PROVIDER_RUNNER_RESIDUALS,
  type ProviderRunnerReport,
} from '../src/provider-runner.ts';
import { runProviderWorker } from '../src/provider-worker.ts';
import {
  createPlanningContributionEnvelope,
  createPlanReviewProgressEnvelope,
  getProposeStatus,
  resumePropose,
} from '../src/propose-orchestrator.ts';
import {
  ledgerIndexPath,
  ledgerObjectPath,
} from '../src/semantic-ledger-store.ts';
import { createLedgerEntry } from '../src/semantic-ledger.ts';
import { isWorkflowError } from './fixture.ts';
import { driveProposeToDispositions } from './propose-drive-fixture.ts';

const TARGET = 'src/r6-covered-target.ts';
const TARGET_CONTENT = 'PlanningR6CoverageNeedle production contract\n';
const TERM = 'PlanningR6CoverageNeedle';

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
      }>;
    };
    assert.equal(output.coverageTier, 'critical');
    assert.match(output.sealedSamplingSeed, /^[0-9a-f]{64}$/);
    assert.ok(
      output.targetBindings.some(
        ({ path: targetPath, source }) =>
          targetPath === TARGET && source === 'carried-ledger-subject',
      ),
    );
    assert.ok(
      output.targetBindings.some(
        ({ path: targetPath, source }) =>
          targetPath === TARGET && source === 'planned-mutation',
      ),
    );
    assert.ok(output.requiredTargetIds.length >= 2);
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
  const prepared = prepareCoverageReview('r6-coverage-complete');
  try {
    completeProviderReview(prepared, noChallengeSubmission('covered-target'));
    const completed = resumePropose(
      prepared.repository,
      prepared.changeId,
      createPlanReviewProgressEnvelope(
        getProposeStatus(prepared.repository, prepared.investigationId),
      ),
    );
    assert.equal(completed.state, 'planning-complete');
  } finally {
    prepared.dispose();
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

function prepareCoverageReview(changeId: string) {
  const fixture = driveProposeToDispositions(changeId, {
    mainTerm: TERM,
    surveyTerm: TERM,
    explicitPaths: [TARGET],
    explicitSymbols: [],
    files: {
      [TARGET]: TARGET_CONTENT,
      ...ledgerFiles(changeId),
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
  assert.equal(afterDispositions.semanticReuse?.carriedCount, 1);
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
  };
}

function completeProviderReview(
  prepared: ReturnType<typeof prepareCoverageReview>,
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
): PlanReviewSubmission {
  return {
    schemaVersion: 2,
    verdict: 'advisory-approve',
    coverage: [...PLAN_REVIEW_COVERAGE],
    scopeAssessment: {
      kind: 'no-challenge',
      evidence: [
        evidence === 'covered-target'
          ? {
              kind: 'repository-location',
              path: TARGET,
              line: 1,
              observation:
                'The exact planned mutation and carried ledger subject were reviewed.',
            }
          : {
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
