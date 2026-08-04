import assert from 'node:assert/strict';
import test from 'node:test';

import { findDeltaApplicabilityFaults } from '../src/archive-delta-verifier.ts';

const BASE = [
  '# workflow-assurance',
  '',
  '### Requirement: Serialized Completion Authority',
  '',
  'The engine SHALL serialize completion.',
  '',
  '#### Scenario: Concurrent transition is requested',
  '',
  '### Requirement: Blocking Session Preflight',
  '',
  '#### Scenario: Dirty worktree is rejected',
].join('\n');

function delta(sections: string): string {
  return sections;
}

test('modifying a requirement the base does not have cannot apply', () => {
  const faults = findDeltaApplicabilityFaults(
    BASE,
    delta(
      [
        '## MODIFIED Requirements',
        '',
        '### Requirement: Imagined Requirement',
        '',
        '#### Scenario: Something',
      ].join('\n'),
    ),
  );
  assert.equal(faults.length, 1);
  assert.equal(faults[0].operation, 'modified');
  assert.equal(faults[0].requirement, 'Imagined Requirement');
  assert.match(faults[0].reason, /not present/i);
});

test('adding a requirement the base already has cannot apply', () => {
  const faults = findDeltaApplicabilityFaults(
    BASE,
    delta(
      [
        '## ADDED Requirements',
        '',
        '### Requirement: Blocking Session Preflight',
        '',
        '#### Scenario: Something',
      ].join('\n'),
    ),
  );
  assert.equal(faults.length, 1);
  assert.equal(faults[0].operation, 'added');
  assert.match(faults[0].reason, /already present/i);
});

test('removing a requirement the base does not have cannot apply', () => {
  const faults = findDeltaApplicabilityFaults(
    BASE,
    delta(
      ['## REMOVED Requirements', '', '### Requirement: Gone Already'].join(
        '\n',
      ),
    ),
  );
  assert.equal(faults.length, 1);
  assert.equal(faults[0].operation, 'removed');
});

test('a rename needs its source present and its destination free', () => {
  const missingSource = findDeltaApplicabilityFaults(
    BASE,
    delta(
      [
        '## RENAMED Requirements',
        '',
        '- FROM: `### Requirement: Never Existed`',
        '- TO: `### Requirement: New Name`',
      ].join('\n'),
    ),
  );
  assert.equal(missingSource.length, 1);
  assert.equal(missingSource[0].operation, 'renamed');

  const occupiedDestination = findDeltaApplicabilityFaults(
    BASE,
    delta(
      [
        '## RENAMED Requirements',
        '',
        '- FROM: `### Requirement: Blocking Session Preflight`',
        '- TO: `### Requirement: Serialized Completion Authority`',
      ].join('\n'),
    ),
  );
  assert.equal(occupiedDestination.length, 1);
  assert.match(occupiedDestination[0].reason, /already present/i);
});

test('a delta that applies cleanly reports nothing', () => {
  const faults = findDeltaApplicabilityFaults(
    BASE,
    delta(
      [
        '## MODIFIED Requirements',
        '',
        '### Requirement: Blocking Session Preflight',
        '',
        '#### Scenario: Dirty worktree is rejected',
        '',
        '## ADDED Requirements',
        '',
        '### Requirement: Brand New',
        '',
        '#### Scenario: Fresh',
      ].join('\n'),
    ),
  );
  assert.deepEqual(faults, []);
});

test('every fault in one delta is reported, not only the first', () => {
  const faults = findDeltaApplicabilityFaults(
    BASE,
    delta(
      [
        '## MODIFIED Requirements',
        '',
        '### Requirement: Not There',
        '',
        '#### Scenario: X',
        '',
        '## REMOVED Requirements',
        '',
        '### Requirement: Also Not There',
      ].join('\n'),
    ),
  );
  assert.equal(faults.length, 2);
  assert.deepEqual(faults.map(({ requirement }) => requirement).sort(), [
    'Also Not There',
    'Not There',
  ]);
});

test('a delta with no recognised sections reports nothing rather than guessing', () => {
  assert.deepEqual(findDeltaApplicabilityFaults(BASE, '# just prose'), []);
});
