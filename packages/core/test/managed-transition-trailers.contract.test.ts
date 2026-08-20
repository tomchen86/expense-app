import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  hasManagedTrailerLine,
  ManagedTrailerSyntaxError,
  parseManagedTrailers,
} from '../src/managed-transition-trailers.ts';

const GENERATION = 'a'.repeat(64);
const AMENDS = 'b'.repeat(64);
const REVIEW = 'c'.repeat(64);

test('managed transition trailer grammar preserves every landed transition form', () => {
  const vectors = [
    {
      message: 'Complete task\n\nChange: demo-change\nTask: 1.2\n',
      parsed: { kind: 'task', changeId: 'demo-change', taskId: '1.2' },
    },
    {
      message: 'Plan demo-change\n\nChange: demo-change\nTransition: plan\n',
      parsed: {
        kind: 'plan',
        changeId: 'demo-change',
        transition: 'plan',
      },
    },
    {
      message:
        'Archive demo-change\n\nChange: demo-change\nTransition: archive',
      parsed: {
        kind: 'archive',
        changeId: 'demo-change',
        transition: 'archive',
      },
    },
    {
      message:
        'Repair authority\n\nChange: demo-change\nTransition: authority-maintenance\nGrant: 11111111-1111-4111-8111-111111111111\n',
      parsed: {
        kind: 'authority',
        changeId: 'demo-change',
        transition: 'authority-maintenance',
        grantId: '11111111-1111-4111-8111-111111111111',
      },
    },
    {
      message:
        'Freeze authority candidate\n\nChange: demo-change\nTransition: authority-candidate\n',
      parsed: {
        kind: 'authority-candidate',
        changeId: 'demo-change',
        transition: 'authority-candidate',
      },
    },
    {
      message: [
        'Amend plan demo-change',
        '',
        'Change: demo-change',
        'Transition: amend-plan',
        `Planning-Generation: ${GENERATION}`,
        `Amends-Planning-Generation: ${AMENDS}`,
        'Execution-Impact: required',
        `Plan-Review: ${REVIEW}`,
      ].join('\n'),
      parsed: {
        kind: 'amend-plan',
        changeId: 'demo-change',
        transition: 'amend-plan',
        planningGeneration: GENERATION,
        amendsPlanningGeneration: AMENDS,
        executionImpact: 'required',
        planReview: REVIEW,
      },
    },
  ] as const;

  for (const vector of vectors) {
    assert.deepEqual(parseManagedTrailers(vector.message), vector.parsed);
  }
});

test('managed transition trailer grammar keeps unmanaged and malformed messages distinct', () => {
  assert.equal(parseManagedTrailers('Add ordinary behavior\n'), undefined);
  assert.equal(hasManagedTrailerLine('Add ordinary behavior\n'), false);
  assert.equal(
    hasManagedTrailerLine('Attempt\n\n change : demo-change\n'),
    true,
  );

  for (const message of [
    'Bad case\n\nchange: demo-change\nTask: 1.2\n',
    'Mixed\n\nChange: demo-change\nTask: 1.1\nTransition: plan\n',
    'Missing grant\n\nChange: demo-change\nTransition: authority-maintenance\n',
    [
      'Self amendment',
      '',
      'Change: demo-change',
      'Transition: amend-plan',
      `Planning-Generation: ${GENERATION}`,
      `Amends-Planning-Generation: ${GENERATION}`,
      'Execution-Impact: none',
      `Plan-Review: ${REVIEW}`,
    ].join('\n'),
  ]) {
    assert.throws(
      () => parseManagedTrailers(message),
      (error) =>
        error instanceof ManagedTrailerSyntaxError &&
        error.name === 'ManagedTrailerSyntaxError' &&
        error.message ===
          'Commit message contains a non-canonical managed trailer block.',
    );
  }
});

test('managed transition trailer grammar is exported without consumer authority', () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { exports?: Record<string, string> };
  assert.equal(
    manifest.exports?.['./managed-transition-trailers'],
    './src/managed-transition-trailers.ts',
  );
  const source = fs.readFileSync(
    new URL('../src/managed-transition-trailers.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /workflow-engine|workflowError|expense-app|openspec/iu,
  );
  assert.doesNotMatch(source, /^import\s/mu);
});
