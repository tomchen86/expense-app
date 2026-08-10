import assert from 'node:assert/strict';
import test from 'node:test';

import { findMissingScenarioIdentities } from '../src/archive-delta-verifier.ts';

const BEFORE = [
  '### Requirement: Serialized Completion Authority',
  '',
  'The engine SHALL serialize completion.',
  '',
  '#### Scenario: Concurrent transition is requested',
  '',
  '- **WHEN** two transitions race',
  '- **THEN** exactly one acquires the lock',
  '',
  '#### Scenario: Existing manual staging is present',
  '',
  '- **WHEN** the index is dirty',
  '- **THEN** the transition fails closed',
].join('\n');

test('a MODIFIED block that drops a live scenario is reported', () => {
  const after = [
    '### Requirement: Serialized Completion Authority',
    '',
    'The engine SHALL serialize completion, rewritten.',
    '',
    '#### Scenario: Concurrent transition is requested',
    '',
    '- **WHEN** two transitions race',
    '- **THEN** exactly one acquires the lock',
  ].join('\n');
  assert.deepEqual(findMissingScenarioIdentities(BEFORE, after), [
    'Existing manual staging is present',
  ]);
});

test('rewriting a requirement while keeping every scenario identity is allowed', () => {
  const after = [
    '### Requirement: Serialized Completion Authority',
    '',
    'Completely rewritten prose that says the same thing.',
    '',
    '#### Scenario: Concurrent transition is requested',
    '',
    '- **THEN** exactly one acquires the lock',
    '',
    '#### Scenario: Existing manual staging is present',
    '',
    '- **THEN** the transition fails closed',
    '',
    '#### Scenario: A brand new case',
    '',
    '- **THEN** it also holds',
  ].join('\n');
  assert.deepEqual(findMissingScenarioIdentities(BEFORE, after), []);
});

test('a renamed scenario reads as a dropped identity, not a rename', () => {
  // Scenario titles are exact identities during apply; a reviewer may see a
  // faithful rewording, but the apply step sees one identity vanish.
  const after = [
    '### Requirement: Serialized Completion Authority',
    '',
    '#### Scenario: Concurrent transition is requested',
    '',
    '#### Scenario: Manual staging already exists',
  ].join('\n');
  assert.deepEqual(findMissingScenarioIdentities(BEFORE, after), [
    'Existing manual staging is present',
  ]);
});

test('every dropped identity is reported, in the order the base spec declares them', () => {
  const after = ['### Requirement: Serialized Completion Authority'].join('\n');
  assert.deepEqual(findMissingScenarioIdentities(BEFORE, after), [
    'Concurrent transition is requested',
    'Existing manual staging is present',
  ]);
});

test('a requirement with no scenarios before has nothing to preserve', () => {
  const before = ['### Requirement: Bare', '', 'Prose only.'].join('\n');
  assert.deepEqual(
    findMissingScenarioIdentities(before, '### Requirement: Bare'),
    [],
  );
});

test('scenario identity ignores surrounding whitespace but not wording', () => {
  const before = '#### Scenario:   Spaced   out  ';
  assert.deepEqual(
    findMissingScenarioIdentities(before, '#### Scenario: Spaced   out'),
    [],
  );
  assert.deepEqual(
    findMissingScenarioIdentities(before, '#### Scenario: Spaced out'),
    ['Spaced   out'],
  );
});
