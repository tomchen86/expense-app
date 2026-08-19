import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectChangeAssurance } from '../src/assurance-inspection.ts';
import { planClassSampleAudits } from '../src/modules/investigation/domain/class-sample-audit.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { projectReviewShadowMetrics } from '../src/modules/assurance/planning-shadow-metrics.ts';
import {
  ledgerIndexPath,
  ledgerObjectPath,
  updateLedgerIndex,
  writeLedgerEntry,
} from '../src/semantic-ledger-store.ts';
import { createLedgerEntry } from '../src/modules/why-knowledge/semantic-ledger.ts';
import { PROPOSE_POLICY_DIGEST } from '../src/modules/provider-orchestration/provider-contracts.ts';
import { driveProposeToDispositions } from './propose-drive-fixture.ts';

const TERM = 'PlanningShadowMetricNeedle';
const MEMBER = 'PLANNING_SHADOW_MEMBER';

test('assurance inspection projects only durable planning facts and names every unknown', () => {
  const changeId = 'planning-shadow-metrics';
  const fixture = driveProposeToDispositions(changeId, {
    mainTerm: TERM,
    explicitPaths: ['metric/member.ts'],
    explicitSymbols: [],
    files: {
      'metric/member.ts': `${MEMBER} ${TERM}\n`,
      'metric/member.js': `${MEMBER} ${TERM}\n`,
      'metric/member.json': `${MEMBER} ${TERM}\n`,
      'metric/control.yaml': `CONTROL ${TERM}\n`,
      'workflow/path-roles.json': `${canonicalJson({
        schemaVersion: 1,
        kind: 'path-role-registry',
        roles: { ordinary: ['metric/**'] },
      })}\n`,
    },
  });

  try {
    const groups = fixture.output.work?.groups ?? [];
    const members = groups
      .filter((group) =>
        group.hits.some(({ window }) => window?.includes(MEMBER)),
      )
      .map(({ groupId }) => groupId)
      .sort();
    assert.equal(members.length, 3);
    const memberSet = new Set(members);
    const classes = [
      {
        schemaVersion: 1 as const,
        kind: 'class-disposition' as const,
        classId: 'metric-members',
        predicate: { contains: MEMBER },
        classification: 'load-bearing' as const,
        rationale: 'These exact marker-bearing members share one rationale.',
        author: 'codex',
        members,
      },
    ];
    const samplePlan = planClassSampleAudits(
      crypto.createHash('sha256').update(fixture.investigationId).digest('hex'),
      classes,
    );
    const audits = samplePlan.flatMap(({ classId, sampled }) =>
      sampled.map((groupId, index) => ({
        classId,
        groupId,
        outcome:
          index === 0 ? ('rationale-wrong' as const) : ('passed' as const),
      })),
    );
    const individual = groups
      .filter(({ groupId }) => !memberSet.has(groupId))
      .map(({ groupId }) => ({
        groupId,
        classification: 'load-bearing' as const,
        rationale: 'This control is judged individually.',
        author: 'codex',
      }));

    const afterDispositions = fixture.submit({
      dispositions: individual,
      classes,
      sampleAudits: audits,
    });
    assert.equal(afterDispositions.state, 'awaiting-ledger-answers');
    const sealed = fixture.submit({
      answers: (afterDispositions.work?.fullBlobManifest ?? []).map(
        ({ manifestEntryId }) => ({
          manifestEntryId,
          why: 'This file participates in the metrics fixture.',
          protectedInvariant: 'Metrics remain bound to stored evidence.',
          reviewerQuestion: 'Can an absent metric be reported as zero?',
          answer: 'No; absent evidence is explicitly not-recorded.',
          semanticAuthor: 'codex',
          readComplete: true as const,
        }),
      ),
    });
    assert.equal(sealed.state, 'awaiting-planning-contribution');

    const metrics = inspectChangeAssurance(
      fixture.repository,
      changeId,
    ).shadowMetrics;
    assert.equal(metrics.investigationId, fixture.investigationId);
    assert.deepEqual(metrics.planning.compression, {
      status: 'recorded',
      value: {
        baselineDispositionCount: groups.length,
        classRationaleCount: 1,
        individualDispositionCount: individual.length,
        splitWorkItemCount: 0,
        sampleAuditAnswerCount: audits.length,
        authoredWorkItemCount: 1 + individual.length + audits.length,
        compressionRatio:
          groups.length / (1 + individual.length + audits.length),
      },
    });
    assert.equal(metrics.planning.discrimination.status, 'recorded');
    assert.deepEqual(metrics.planning.discrimination.value?.classes, [
      {
        classId: 'metric-members',
        memberCount: 3,
        // One additional path-surface group has no comparable stored window;
        // the discrimination contract correctly excludes it from the control
        // denominator rather than lending the predicate a free rejection.
        controlCount: 1,
        controlRejected: 1,
        rejectionRate: 1,
        threshold: 0.9,
      },
    ]);
    assert.deepEqual(metrics.planning.sampleFailures, {
      status: 'recorded',
      value: {
        auditedCount: audits.length,
        failedCount: 1,
        failureRate: 1 / audits.length,
        byOutcome: {
          'member-misclassified': 0,
          'rationale-wrong': 1,
          'type-wrong': 0,
        },
      },
    });
    assert.equal(metrics.planning.escalation.status, 'recorded');
    assert.equal(metrics.planning.escalation.value?.assessmentEscalated, false);

    assert.deepEqual(metrics.ledger.reuse, {
      status: 'recorded',
      value: {
        owedCount: 4,
        carriedCount: 0,
        reuseRate: 0,
      },
    });
    assert.deepEqual(metrics.ledger.fullBlobBytesAvoided, {
      status: 'recorded',
      value: 0,
    });
    assert.equal(metrics.ledger.freshness.status, 'not-recorded');
    assert.equal(metrics.review.challenges.status, 'not-recorded');
    assert.equal(metrics.review.requiredSetCoverage.status, 'not-recorded');
    assert.deepEqual(metrics.escapedScopeDefects, {
      status: 'external-required',
      value: null,
      reason:
        'Escaped-scope defects require an independently supplied defect observation; this investigation cannot certify its own escapes.',
    });
  } finally {
    fixture.dispose();
  }
});

test('assurance inspection projects ledger savings only from the sealed reuse node', () => {
  const changeId = 'planning-shadow-ledger-metrics';
  const target = 'metric/reused.ts';
  const content = `${TERM} exact reusable source\n`;
  const fixture = driveProposeToDispositions(changeId, {
    mainTerm: TERM,
    explicitPaths: [target],
    explicitSymbols: [],
    files: {
      ...ledgerFiles(target, content),
      [target]: content,
      'workflow/path-roles.json': `${canonicalJson({
        schemaVersion: 1,
        kind: 'path-role-registry',
        roles: { ordinary: ['metric/**'] },
      })}\n`,
    },
  });

  try {
    const afterDispositions = fixture.submit({
      dispositions: (fixture.output.work?.groups ?? []).map(({ groupId }) => ({
        groupId,
        classification: 'load-bearing' as const,
        rationale: 'The exact reusable source remains load-bearing.',
        author: 'codex',
      })),
    });
    assert.equal(afterDispositions.semanticReuse?.carriedCount, 1);
    const sealed = fixture.submit({
      answers: (afterDispositions.work?.fullBlobManifest ?? []).map(
        ({ manifestEntryId }) => ({
          manifestEntryId,
          why: 'Any source not carried by the ledger is explained here.',
          protectedInvariant: 'Ledger reuse is exact-byte bound.',
          reviewerQuestion: 'Did the source bytes remain exact?',
          answer: 'Yes; the engine compared the pinned blob digest.',
          semanticAuthor: 'codex',
          readComplete: true as const,
        }),
      ),
    });
    assert.equal(sealed.state, 'awaiting-planning-contribution');

    const metrics = inspectChangeAssurance(
      fixture.repository,
      changeId,
    ).shadowMetrics;
    assert.deepEqual(metrics.ledger.reuse, {
      status: 'recorded',
      value: {
        owedCount: 1,
        carriedCount: 1,
        reuseRate: 0.5,
      },
    });
    assert.deepEqual(metrics.ledger.fullBlobBytesAvoided, {
      status: 'recorded',
      value: Buffer.byteLength(content),
    });
    assert.deepEqual(metrics.ledger.freshness, {
      status: 'recorded',
      value: {
        populationCount: 1,
        policyStaleCount: 0,
        policyStaleRate: 0,
        identityAmbiguousCount: 0,
        identityAmbiguityRate: 0,
        dependencyChangedCount: 0,
        dependencyInvalidationRate: 0,
      },
    });
  } finally {
    fixture.dispose();
  }
});

test('review shadow projection counts only exact required-set evidence', () => {
  const projected = projectReviewShadowMetrics({
    review: {
      findings: [
        {
          evidence: [
            {
              kind: 'repository-location',
              path: 'src/covered.ts',
            },
          ],
        },
      ],
      suggestions: [],
      scopeAssessment: { kind: 'challenges' },
    },
    requirement: {
      requiredTargetIds: ['covered', 'missing'],
      targetBindings: [
        {
          targetId: 'covered',
          evidenceKind: 'repository-location',
          path: 'src/covered.ts',
        },
        {
          targetId: 'missing',
          evidenceKind: 'repository-location',
          path: 'src/missing.ts',
        },
      ],
    },
  });

  assert.deepEqual(projected, {
    challenges: { status: 'recorded', value: { challengeCount: 1 } },
    requiredSetCoverage: {
      status: 'recorded',
      value: {
        requiredCount: 2,
        coveredCount: 1,
        coverageRate: 0.5,
        missingTargetIds: ['missing'],
      },
    },
  });
});

function ledgerFiles(target: string, content: string): Record<string, string> {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'planning-metrics-ledger-'),
  );
  try {
    const sourceDigest = `sha256:${crypto
      .createHash('sha256')
      .update(content)
      .digest('hex')}`;
    const entry = createLedgerEntry({
      schemaVersion: 1,
      kind: 'semantic-ledger-entry',
      subject: {
        subjectId: 'file.planning-shadow-metric',
        kind: 'file',
        path: target,
      },
      binding: {
        baselineCommit: '1'.repeat(40),
        blobDigest: sourceDigest,
        sourceDigest,
        semanticDigest: sourceDigest,
        extractorVersion: 'planning-shadow-metric.v1',
      },
      why: {
        responsibility: 'Exercise exact-byte ledger metric projection.',
        protectedInvariants: ['Only current exact bytes may be carried.'],
        failureModes: [],
        reviewerQuestions: [],
      },
      semanticDependencies: [],
      policyDigest: `sha256:${PROPOSE_POLICY_DIGEST}`,
      provenance: {
        changeId: 'planning-shadow-ledger-source',
        createdAtCommit: '1'.repeat(40),
      },
      supersedes: null,
      status: 'current',
    });
    writeLedgerEntry(root, entry);
    updateLedgerIndex(root, [entry]);
    return {
      [ledgerObjectPath(entry.entryId)]: fs.readFileSync(
        path.join(root, ledgerObjectPath(entry.entryId)),
        'utf8',
      ),
      [ledgerIndexPath()]: fs.readFileSync(
        path.join(root, ledgerIndexPath()),
        'utf8',
      ),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
