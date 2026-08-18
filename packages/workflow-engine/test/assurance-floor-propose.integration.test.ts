import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import { isWorkflowError, runtimeRoot } from './fixture.ts';
import { driveProposeToDispositions } from './propose-drive-fixture.ts';

const TERM = 'UnderReportedNeedle';
const CLASS_MARKER = 'ORDINARY_CLASS_MARKER';
const DIGEST = /^[0-9a-f]{64}$/;

test('a critical scan hit forbids even a low-reported ordinary class and persists the exact assessment', () => {
  const changeId = 'assurance-critical-class-floor';
  const fixture = driveProposeToDispositions(changeId, {
    mainTerm: TERM,
    explicitPaths: ['src/ordinary.ts'],
    explicitSymbols: [],
    files: {
      'src/ordinary.ts': `${CLASS_MARKER} ${TERM}\n`,
      'src/ordinary.js': `${CLASS_MARKER} ${TERM}\n`,
      'src/critical.yaml': `critical: ${TERM}\n`,
      'workflow/path-roles.json': registry({
        lifecycle: ['src/critical.yaml'],
        // The exact lifecycle rule must outrank this tempting broad fallback.
        ordinary: ['src/**'],
      }),
    },
  });
  try {
    const assessment = fixture.output.work?.assuranceAssessment;
    assert.ok(assessment, 'propose reports the assessment it enforces');
    assert.equal(assessment.floors.planning, 'individual-only');
    assert.equal(assessment.coverageTier, 'critical');
    assert.match(assessment.nodeId, DIGEST);
    assert.match(assessment.resultDigest, DIGEST);
    assert.match(assessment.policyDigest, DIGEST);
    assert.equal(
      assessment.reasons.some((reason) =>
        reason.startsWith('hit-path-role:lifecycle:src/critical.yaml'),
      ),
      true,
    );

    const groups = fixture.output.work?.groups ?? [];
    const members = groups.filter(
      (group) =>
        group.paths.length > 0 &&
        group.paths.every((hitPath) => hitPath.startsWith('src/ordinary.')) &&
        group.hits.length > 0 &&
        group.hits.every(
          ({ window }) => window !== null && window.includes(CLASS_MARKER),
        ),
    );
    assert.ok(members.length > 0, 'fixture offers an ordinary class');
    const memberIds = new Set(members.map(({ groupId }) => groupId));
    const others = groups.filter(({ groupId }) => !memberIds.has(groupId));

    assert.throws(
      () =>
        fixture.submit({
          dispositions: others.map(individual),
          classes: [classOver([...memberIds])],
        }),
      (error) => isWorkflowError(error, 'ASSURANCE_PLANNING_FLOOR_VIOLATION'),
    );

    // The floor has a legal recovery: replace the compressed claim with exact
    // per-group dispositions under the same immutable scan assessment.
    const afterDispositions = fixture.submit({
      dispositions: groups.map(individual),
    });
    assert.equal(afterDispositions.state, 'awaiting-ledger-answers');
    const sealed = fixture.submit({
      answers: (afterDispositions.work?.fullBlobManifest ?? []).map(
        ({ manifestEntryId }) => whyAnswer(manifestEntryId),
      ),
    });
    assert.equal(sealed.state, 'awaiting-planning-contribution');
    assert.ok(sealed.investigation);

    const shadowBytes = fs.readFileSync(
      path.join(
        runtimeRoot(fixture.repository),
        'investigations',
        'shadow-v3',
        `${sealed.investigation.investigationId}.json`,
      ),
      'utf8',
    );
    const shadow = JSON.parse(shadowBytes) as {
      authorityEligible: boolean;
      cutoverState: string;
      result: { outcome: string; manifest?: { schemaVersion: number } };
    };
    assert.equal(shadow.authorityEligible, false);
    assert.equal(shadow.cutoverState, 'central-fail-grant-covered-shadow');
    assert.equal(shadow.result.outcome, 'matched');
    assert.equal(shadow.result.manifest?.schemaVersion, 3);
    for (const forbidden of [
      'MaterializedEvidenceView',
      'nodeId',
      'nodeSchema',
      'provenanceParentNodeIds',
      'semanticParentResultDigests',
    ]) {
      assert.equal(shadowBytes.includes(`"${forbidden}"`), false);
    }

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
    ) as {
      schemaVersion: number;
      kind: string;
      nodes: Array<Record<string, unknown>>;
    };
    assert.notEqual(artifact.schemaVersion, 3);
    assert.equal(artifact.kind, 'investigation-artifact');
    const persisted = artifact.nodes.find(
      (node) => node.type === 'assurance-assessment',
    );
    assert.ok(persisted, 'the enforced assessment is durable evidence');
    assert.equal(persisted.nodeId, assessment.nodeId);
    assert.equal(persisted.resultDigest, assessment.resultDigest);
    assert.equal(persisted.policyDigest, assessment.policyDigest);
    assert.deepEqual(persisted.output, {
      schemaVersion: 1,
      kind: 'assurance-assessment',
      changeId,
      declaredChangeClasses: [],
      hitPathCount: assessment.hitPathCount,
      floors: assessment.floors,
      coverageTier: assessment.coverageTier,
      escalated: assessment.escalated,
      reasons: assessment.reasons,
      chain: assessment.chain,
    });
  } finally {
    fixture.dispose();
  }
});

test('an all-ordinary scan retains the existing class-compression path', () => {
  const fixture = driveProposeToDispositions('assurance-ordinary-class-floor', {
    mainTerm: TERM,
    explicitPaths: ['src/ordinary.ts'],
    explicitSymbols: [],
    files: {
      'src/ordinary.ts': `${CLASS_MARKER} ${TERM}\n`,
      'src/ordinary.js': `${CLASS_MARKER} ${TERM}\n`,
      'src/control.yaml': `control: ${TERM}\n`,
      'workflow/path-roles.json': registry({
        ordinary: ['src/**'],
      }),
    },
  });
  try {
    const assessment = fixture.output.work?.assuranceAssessment;
    assert.ok(assessment);
    assert.equal(assessment.floors.planning, 'compression-allowed');
    assert.equal(assessment.floors.review, 'core-complete');
    assert.equal(assessment.coverageTier, 'elevated');

    const groups = fixture.output.work?.groups ?? [];
    const members = groups.filter(
      (group) =>
        group.hits.length > 0 &&
        group.hits.every(
          ({ window }) => window !== null && window.includes(CLASS_MARKER),
        ),
    );
    assert.ok(members.length > 0);
    const memberIds = new Set(members.map(({ groupId }) => groupId));
    const result = fixture.submit({
      dispositions: groups
        .filter(({ groupId }) => !memberIds.has(groupId))
        .map(individual),
      classes: [classOver([...memberIds])],
    });
    assert.equal(result.state, 'awaiting-ledger-answers');
  } finally {
    fixture.dispose();
  }
});

function registry(roles: Record<string, string[]>): string {
  return `${canonicalJson({
    schemaVersion: 1,
    kind: 'path-role-registry',
    roles,
  })}\n`;
}

function individual(group: { groupId: string }) {
  return {
    groupId: group.groupId,
    classification: 'load-bearing' as const,
    rationale: 'This group is judged on its exact evidence.',
    author: 'codex',
  };
}

function classOver(members: string[]) {
  return {
    schemaVersion: 1 as const,
    kind: 'class-disposition' as const,
    classId: 'low-reported-ordinary-references',
    predicate: { contains: CLASS_MARKER },
    classification: 'irrelevant' as const,
    rationale:
      'These ordinary references are reported as irrelevant under one shared predicate.',
    author: 'codex',
    members,
  };
}

function whyAnswer(manifestEntryId: string) {
  return {
    manifestEntryId,
    why: 'This complete source participates in the planned behavior.',
    protectedInvariant:
      'Critical scan evidence keeps individual disposition authority.',
    reviewerQuestion:
      'Could an ordinary class lower the floor raised by a critical path?',
    answer:
      'No. Propose enforces the monotonic assessment before class expansion.',
    semanticAuthor: 'codex',
    readComplete: true as const,
  };
}
