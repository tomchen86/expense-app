import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSampleAudits } from '../src/class-sample-audit.ts';
import { isWorkflowError } from './fixture.ts';

test('a sampled member cannot overwrite an earlier audit outcome', () => {
  assert.throws(
    () =>
      resolveSampleAudits(
        [
          {
            classId: 'equivalent-timeouts',
            memberCount: 3,
            sampled: ['group-a'],
          },
        ],
        [
          {
            classId: 'equivalent-timeouts',
            groupId: 'group-a',
            outcome: 'rationale-wrong',
          },
          {
            classId: 'equivalent-timeouts',
            groupId: 'group-a',
            outcome: 'passed',
          },
        ],
      ),
    (error) => isWorkflowError(error, 'CLASS_SAMPLE_AUDIT_INVALID'),
  );
});
