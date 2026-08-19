import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendAssuranceAssessment,
  coverageTier,
  effectiveFloors,
  floorsForHitPaths,
  startAssuranceChain,
  type AssuranceFloors,
} from '../src/modules/assurance/assurance-assessment-chain.ts';
import { parsePathRoleRegistry } from '../src/modules/source/path-role-registry.ts';
import { isWorkflowError } from './fixture.ts';

const LOW: AssuranceFloors = {
  planning: 'compression-allowed',
  evidence: 'bounded-context-allowed',
  review: 'sampled',
  cost: 'budgeted',
};

const HIGH: AssuranceFloors = {
  planning: 'individual-only',
  evidence: 'full-blob-required',
  review: 'target-complete',
  cost: 'unbudgeted',
};

function chain() {
  return startAssuranceChain({
    changeId: 'demo-change',
    floors: LOW,
    reasons: ['author-requested'],
    at: '2026-08-04T00:00:00.000Z',
  });
}

test('the effective floor is the highest any stage has asserted', () => {
  const raised = appendAssuranceAssessment(chain(), {
    stage: 'scan-discovered',
    floors: HIGH,
    reasons: ['hit-path-role:grant'],
    at: '2026-08-04T00:01:00.000Z',
  });
  assert.deepEqual(effectiveFloors(raised), HIGH);
  assert.equal(coverageTier(raised), 'critical');
});

test('a later stage cannot lower what an earlier stage established', () => {
  const raised = appendAssuranceAssessment(chain(), {
    stage: 'scan-discovered',
    floors: HIGH,
    reasons: ['hit-path-role:grant'],
    at: '2026-08-04T00:01:00.000Z',
  });
  const attempted = appendAssuranceAssessment(raised, {
    stage: 'planning-discovered',
    floors: LOW,
    reasons: ['scope-narrowed-during-planning'],
    at: '2026-08-04T00:02:00.000Z',
  });
  // The assessment is still recorded — the history says someone judged it
  // lower — but the effective floor does not move down.
  assert.equal(attempted.assessments.length, 3);
  assert.deepEqual(effectiveFloors(attempted), HIGH);
});

test('each policy rises independently', () => {
  const mixed = appendAssuranceAssessment(chain(), {
    stage: 'engine-start',
    floors: { ...LOW, review: 'target-complete' },
    reasons: ['change-class:authority'],
    at: '2026-08-04T00:01:00.000Z',
  });
  assert.deepEqual(effectiveFloors(mixed), {
    planning: 'compression-allowed',
    evidence: 'bounded-context-allowed',
    review: 'target-complete',
    cost: 'budgeted',
  });
});

test('assessments are append-only and never rewrite history', () => {
  const original = chain();
  const before = JSON.stringify(original);
  appendAssuranceAssessment(original, {
    stage: 'engine-start',
    floors: HIGH,
    reasons: ['change-class:authority'],
    at: '2026-08-04T00:01:00.000Z',
  });
  assert.equal(JSON.stringify(original), before);
  assert.equal(original.assessments.length, 1);
});

test('stages may not run backwards', () => {
  const advanced = appendAssuranceAssessment(chain(), {
    stage: 'planning-discovered',
    floors: LOW,
    reasons: ['no-new-consumers'],
    at: '2026-08-04T00:01:00.000Z',
  });
  assert.throws(
    () =>
      appendAssuranceAssessment(advanced, {
        stage: 'engine-start',
        floors: LOW,
        reasons: ['late-start-assessment'],
        at: '2026-08-04T00:02:00.000Z',
      }),
    (error) => isWorkflowError(error, 'ASSURANCE_ASSESSMENT_INVALID'),
  );
});

test('an assessment without a reason is refused', () => {
  assert.throws(
    () =>
      appendAssuranceAssessment(chain(), {
        stage: 'engine-start',
        floors: HIGH,
        reasons: [],
        at: '2026-08-04T00:01:00.000Z',
      }),
    (error) => isWorkflowError(error, 'ASSURANCE_ASSESSMENT_INVALID'),
  );
});

test('time may not run backwards within a chain', () => {
  assert.throws(
    () =>
      appendAssuranceAssessment(chain(), {
        stage: 'engine-start',
        floors: HIGH,
        reasons: ['change-class:authority'],
        at: '2026-08-03T00:00:00.000Z',
      }),
    (error) => isWorkflowError(error, 'ASSURANCE_ASSESSMENT_INVALID'),
  );
});

test('the coverage tier is a projection, not a stored decision', () => {
  assert.equal(coverageTier(chain()), 'standard');
  const elevated = appendAssuranceAssessment(chain(), {
    stage: 'scan-discovered',
    floors: { ...LOW, evidence: 'full-blob-required' },
    reasons: ['degraded-extraction'],
    at: '2026-08-04T00:01:00.000Z',
  });
  assert.equal(coverageTier(elevated), 'elevated');
});

test('a reviewer may escalate after planning is assessed', () => {
  let current = chain();
  for (const [stage, at] of [
    ['engine-start', '2026-08-04T00:01:00.000Z'],
    ['scan-discovered', '2026-08-04T00:02:00.000Z'],
    ['planning-discovered', '2026-08-04T00:03:00.000Z'],
    ['reviewer-escalation', '2026-08-04T00:04:00.000Z'],
  ] as const) {
    current = appendAssuranceAssessment(current, {
      stage,
      floors: stage === 'reviewer-escalation' ? HIGH : LOW,
      reasons: [`${stage}-assessed`],
      at,
    });
  }
  assert.equal(current.assessments.length, 5);
  assert.deepEqual(effectiveFloors(current), HIGH);
  assert.equal(coverageTier(current), 'critical');
});

test('a risky hit path raises the floors the scan stage records', () => {
  const registry = parsePathRoleRegistry({
    schemaVersion: 1,
    kind: 'path-role-registry',
    roles: {
      grant: [
        'packages/workflow-engine/src/modules/authority/maintainer-candidate.ts',
      ],
      ordinary: ['apps/**'],
    },
  });
  // An ordinary hit leaves the floor where it was; a grant hit lifts planning
  // to individual-only, which is what forbids folding it into a class.
  assert.deepEqual(floorsForHitPaths(registry, ['apps/mobile/App.tsx']), {
    floors: {
      planning: 'compression-allowed',
      evidence: 'bounded-context-allowed',
      review: 'sampled',
      cost: 'budgeted',
    },
    reasons: [],
  });
  const risky = floorsForHitPaths(registry, [
    'apps/mobile/App.tsx',
    'packages/workflow-engine/src/modules/authority/maintainer-candidate.ts',
  ]);
  assert.equal(risky.floors.planning, 'individual-only');
  assert.deepEqual(risky.reasons, [
    'hit-path-role:grant:packages/workflow-engine/src/modules/authority/maintainer-candidate.ts',
  ]);
});

test('an unregistered hit path raises the floor rather than passing silently', () => {
  const registry = parsePathRoleRegistry({
    schemaVersion: 1,
    kind: 'path-role-registry',
    roles: { ordinary: ['apps/**'] },
  });
  const result = floorsForHitPaths(registry, ['scripts/release.sh']);
  assert.equal(result.floors.planning, 'individual-only');
  assert.deepEqual(result.reasons, [
    'hit-path-unregistered:scripts/release.sh',
  ]);
});
