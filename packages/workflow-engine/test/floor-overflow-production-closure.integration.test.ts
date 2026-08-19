import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  createInvestigationCheckpointEnvelope,
  getInvestigationStatus,
} from '../src/investigation-session.ts';
import type { ProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  claimProviderInvocation,
  completeProviderInvocation,
} from '../src/provider-invocation-store.ts';
import {
  createPlanningContributionEnvelope,
  getProposeStatus,
  resumePropose,
  startPropose,
  type PlanningContributionPayload,
} from '../src/application/propose/propose-orchestrator.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';
import { driveProposeToDispositions } from './propose-drive-fixture.ts';

const WIDE_PATH = 'src/wide-surface.ts';
const DIGEST = /^[0-9a-f]{64}$/;

test('author and survey overage cannot evict an engine-floor term', () => {
  const changeId = 'floor-non-engine-overage';
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    setFixtureProviderTimeout(repository, 300_000);
    writeWideSurface(repository, 126);

    const started = startPropose(
      repository,
      changeId,
      {
        schemaVersion: 1,
        summary: 'Refuse a union overage caused outside the engine floor.',
        explicitPaths: [WIDE_PATH],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      {
        explicitActor: 'codex',
        environment: {},
        providerDriver: completeBlindSurvey('BlindSurveyNeedle'),
      },
    );
    const investigationId = started.investigation!.investigationId;

    assert.throws(
      () =>
        resumePropose(
          repository,
          changeId,
          createInvestigationCheckpointEnvelope(
            getInvestigationStatus(repository, investigationId),
            {
              reference: 'main-survey',
              terms: [
                {
                  kind: 'symbol' as const,
                  value: 'MainSurveyNeedle',
                  rationale:
                    'The main investigation identified a non-floor term.',
                  expectedRelationship:
                    'An existing consumer may depend on this symbol.',
                },
              ],
            },
          ),
        ),
      (error) =>
        isWorkflowError(error, 'INVESTIGATION_TERM_NARROWING_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a floor-owned overflow is sealed, escalated, and remains visible after materialization', () => {
  const changeId = 'floor-overflow-durable-decision';
  const fixture = driveProposeToDispositions(changeId, {
    files: { [WIDE_PATH]: wideSurface(148) },
    explicitPaths: [WIDE_PATH],
    explicitSymbols: [],
    // These contributions deduplicate with the floor. The floor itself, rather
    // than a caller contribution, is therefore the only source of the overage.
    mainTerm: 'floorSymbol0',
    surveyTerm: 'floorSymbol0',
  });
  try {
    const trimming = fixture.output.floorTrimming;
    assert.equal(trimming.escalated, true);
    assert.ok(trimming.dropped.length > 0);

    const assessment = fixture.output.work?.assuranceAssessment;
    assert.ok(assessment);
    assert.equal(assessment.escalated, true);
    assert.equal(assessment.floors.planning, 'individual-only');
    assert.equal(assessment.floors.review, 'target-complete');
    assert.equal(assessment.coverageTier, 'critical');
    assert.equal(
      assessment.reasons.some((reason) =>
        reason.startsWith('engine-floor-overflow:'),
      ),
      true,
    );

    const afterDispositions = fixture.submit({
      dispositions: (fixture.output.work?.groups ?? []).map(({ groupId }) => ({
        groupId,
        classification: 'load-bearing' as const,
        rationale: 'The overflow requires exact individual disposition.',
        author: 'codex',
      })),
    });
    const sealed = fixture.submit({
      answers: (afterDispositions.work?.fullBlobManifest ?? []).map(
        ({ manifestEntryId }) => ({
          manifestEntryId,
          why: 'The wide surface owns the deliberately oversized engine floor.',
          protectedInvariant:
            'Floor losses remain explicit and raise assurance monotonically.',
          reviewerQuestion:
            'Did any caller-supplied term displace an engine-floor term?',
          answer:
            'No. Only the floor-owned overflow used the fixed concession order.',
          semanticAuthor: 'codex',
          readComplete: true as const,
        }),
      ),
    });
    assert.equal(sealed.state, 'awaiting-planning-contribution');
    assert.deepEqual(sealed.floorTrimming, trimming);

    const artifact = JSON.parse(
      fs.readFileSync(
        path.join(
          fixture.repository,
          'openspec/changes',
          changeId,
          'investigation.json',
        ),
        'utf8',
      ),
    ) as { nodes: Array<Record<string, unknown>> };
    const decisions = artifact.nodes.filter(
      (node) => node.type === 'investigation-floor-overflow-decision',
    );
    assert.equal(decisions.length, 1);
    const decision = decisions[0]!.output as {
      escalated: boolean;
      reasons: string[];
      dropped: Array<{
        termId: string;
        value: string;
        reason: string;
      }>;
    };
    assert.equal(decision.escalated, true);
    assert.ok(decision.reasons.length > 0);
    assert.deepEqual(
      decision.dropped.map(({ value }) => value).sort(),
      [...trimming.dropped].sort(),
    );
    assert.equal(
      decision.dropped.every(
        ({ termId, reason }) => DIGEST.test(termId) && reason.length > 0,
      ),
      true,
    );

    const seal = artifact.nodes.find(
      (node) => node.type === 'sealed-investigation',
    ) as {
      provenanceParentNodeIds: Record<string, string>;
      output: Record<string, unknown>;
    };
    assert.equal(
      seal.provenanceParentNodeIds['floor-overflow'],
      decisions[0]!.nodeId,
    );
    assert.deepEqual(seal.output.floorTrimming, trimming);
    assert.deepEqual(seal.output.floorOverflowDecision, decision);

    const materialized = resumePropose(
      fixture.repository,
      changeId,
      createPlanningContributionEnvelope(sealed, planningPayload(changeId)),
    );
    assert.notEqual(materialized.materializedArtifacts, null);
    assert.deepEqual(materialized.floorTrimming, trimming);
    assert.deepEqual(
      getProposeStatus(fixture.repository, fixture.investigationId)
        .floorTrimming,
      trimming,
    );
  } finally {
    fixture.dispose();
  }
});

function completeBlindSurvey(term: string) {
  return ({
    paths,
    request,
  }: {
    paths: Parameters<typeof claimProviderInvocation>[0];
    request: ProviderInvocationRequest;
  }) => {
    const claim = claimProviderInvocation(paths, request.invocationId, {
      workerId: 'floor-overflow-worker',
      leaseDurationMs: 60_000,
    });
    completeProviderInvocation(paths, request.invocationId, {
      expectedRevision: claim.record.revision,
      leaseGeneration: claim.record.leaseGeneration,
      leaseToken: claim.leaseToken,
      outcome: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        spawnErrorCode: null,
        elapsedMs: 1,
        stdout: JSON.stringify(
          providerWireResult(request, {
            reference: request.invocationId,
            terms: [{ kind: 'symbol', value: term }],
          }),
        ),
        stderr: '',
      },
    });
  };
}

function providerWireResult(
  request: ProviderInvocationRequest,
  output: unknown,
) {
  return {
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
}

function writeWideSurface(repository: string, exportCount: number): void {
  const target = path.join(repository, WIDE_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, wideSurface(exportCount), 'utf8');
  git(repository, ['add', '--all']);
  git(repository, ['commit', '-m', 'Add wide floor fixture']);
}

function wideSurface(exportCount: number): string {
  return `${Array.from(
    { length: exportCount },
    (_, index) => `export const floorSymbol${index} = ${index};`,
  ).join('\n')}\n`;
}

function setFixtureProviderTimeout(
  repository: string,
  timeoutMs: number,
): void {
  const policyPath = path.join(repository, 'workflow/ai-adapter-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
    limits: { timeoutMs: number };
  };
  policy.limits.timeoutMs = timeoutMs;
  fs.writeFileSync(policyPath, `${canonicalJson(policy)}\n`, 'utf8');
}

function planningPayload(changeId: string): PlanningContributionPayload {
  return {
    proposal: '# Proposal\n\nKeep floor overflow decisions durable.\n',
    design: [
      '# Design',
      '',
      'The engine binds floor overflow decisions into assurance evidence.',
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
          '### Requirement: Durable floor overflow decision',
          '',
          'The system SHALL retain an escalated floor overflow decision.',
          '',
          '#### Scenario: Planning artifacts are materialized',
          '',
          '- **WHEN** the proposal advances beyond investigation sealing',
          '- **THEN** the same floor overflow remains visible',
          '',
        ].join('\n'),
      },
    ],
    tasks: '# Tasks\n\n- [ ] 1.1 Retain floor overflow evidence\n',
    guard: {
      schemaVersion: 1,
      changeId,
      tasks: {
        '1.1': {
          allowedPaths: [WIDE_PATH],
          requiredChecks: ['fixture'],
        },
      },
    },
    executionTasks: {
      '1.1': {
        strategy: 'direct-reviewed',
        enforcement: 'available',
        allowedPaths: [WIDE_PATH],
        requiredChecks: ['fixture'],
        diffReview: 'policy-required',
        exemptionKind: 'narrowly-scoped-non-behavioral',
        exemptionReason:
          'The fixture exercises planning control flow without product behavior.',
        legacyBootstrap: null,
      },
    },
  };
}
