import assert from 'node:assert/strict';
import test from 'node:test';

import {
  floorsForChangeClass,
  reconcileDeclaredClass,
} from '../src/assurance-assessment-chain.ts';
import { INVESTIGATION_CHANGE_CLASSES } from '../src/investigation-applicability.ts';
import { parsePathRoleRegistry } from '../src/path-role-registry.ts';
import { isWorkflowError } from './fixture.ts';

const REGISTRY = parsePathRoleRegistry({
  schemaVersion: 1,
  kind: 'path-role-registry',
  roles: {
    grant: ['packages/workflow-engine/src/maintainer-candidate.ts'],
    ordinary: ['apps/**', 'docs/**'],
  },
});

test('every declared change class maps to a floor', () => {
  // A class the table forgot would silently pay the base rate, which is the
  // one failure this table exists to prevent.
  for (const changeClass of INVESTIGATION_CHANGE_CLASSES) {
    const { floors, reasons } = floorsForChangeClass(changeClass);
    assert.ok(floors.planning, changeClass);
    assert.ok(reasons.length > 0, changeClass);
  }
});

test('a documentation-only change pays the base rate', () => {
  const { floors } = floorsForChangeClass('documentation-only');
  assert.equal(floors.planning, 'compression-allowed');
  assert.equal(floors.review, 'sampled');
});

test('classes with unknown consumers owe complete review', () => {
  for (const changeClass of ['shared-contract', 'public-api'] as const) {
    assert.equal(
      floorsForChangeClass(changeClass).floors.review,
      'target-complete',
      changeClass,
    );
  }
});

test('rename-removal forbids compression because dropped identities look like nothing', () => {
  // A rename reads as a deletion to anything matching on identity; folding
  // those hits into one class rationale is how a live scenario disappears.
  assert.equal(
    floorsForChangeClass('rename-removal').floors.planning,
    'individual-only',
  );
});

test('migration owes full evidence, not merely bounded context', () => {
  assert.equal(
    floorsForChangeClass('migration').floors.evidence,
    'full-blob-required',
  );
});

test('an unknown change class is refused rather than defaulted', () => {
  assert.throws(
    () => floorsForChangeClass('invented-class' as never),
    (error) => isWorkflowError(error, 'ASSURANCE_ASSESSMENT_INVALID'),
  );
});

test('a light declaration contradicted by where the hits landed escalates', () => {
  const result = reconcileDeclaredClass('documentation-only', REGISTRY, [
    'docs/WORKFLOW.md',
    'packages/workflow-engine/src/maintainer-candidate.ts',
  ]);
  assert.equal(result.escalated, true);
  assert.equal(result.floors.planning, 'individual-only');
  // The escalation has to say what contradicted what, or it is unarguable.
  assert.ok(
    result.reasons.some((reason) =>
      reason.includes('declared-class:documentation-only'),
    ),
    JSON.stringify(result.reasons),
  );
  assert.ok(
    result.reasons.some((reason) =>
      reason.includes('packages/workflow-engine/src/maintainer-candidate.ts'),
    ),
    JSON.stringify(result.reasons),
  );
});

test('a declaration the evidence agrees with does not escalate', () => {
  const result = reconcileDeclaredClass('documentation-only', REGISTRY, [
    'docs/WORKFLOW.md',
    'apps/mobile/App.tsx',
  ]);
  assert.equal(result.escalated, false);
  assert.equal(result.floors.planning, 'compression-allowed');
});

test('an honestly heavy declaration is not escalated by its own consequences', () => {
  // Declaring rename-removal already buys individual-only; the hit paths
  // agreeing with that is not a contradiction to report.
  const result = reconcileDeclaredClass('rename-removal', REGISTRY, [
    'packages/workflow-engine/src/maintainer-candidate.ts',
  ]);
  assert.equal(result.escalated, false);
  assert.equal(result.floors.planning, 'individual-only');
});

test('the declared floor still applies where the hits say nothing', () => {
  const result = reconcileDeclaredClass('public-api', REGISTRY, [
    'apps/mobile/App.tsx',
  ]);
  assert.equal(result.floors.review, 'target-complete');
  assert.equal(result.escalated, false);
});
