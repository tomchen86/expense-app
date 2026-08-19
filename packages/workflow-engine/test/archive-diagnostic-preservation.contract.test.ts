import assert from 'node:assert/strict';
import test from 'node:test';

import { boundedArchiveCauseDiagnostic } from '../src/application/archive/archive-transformation.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';

test('a workflow cause keeps the code, message, and structured details', () => {
  const cause = workflowError(
    'SPEC_SCENARIO_PRESERVATION_FAILED',
    'Requirement "Serialized Completion Authority" drops existing scenario identities.',
    ExitCode.verification,
    {
      details: {
        requirement: 'Serialized Completion Authority',
        missingScenarios: [
          'Concurrent transition is requested',
          'Existing manual staging is present',
        ],
      },
    },
  );
  assert.deepEqual(boundedArchiveCauseDiagnostic(cause), {
    causeCode: 'SPEC_SCENARIO_PRESERVATION_FAILED',
    causeMessage:
      'Requirement "Serialized Completion Authority" drops existing scenario identities.',
    causeDetails: {
      requirement: 'Serialized Completion Authority',
      missingScenarios: [
        'Concurrent transition is requested',
        'Existing manual staging is present',
      ],
    },
  });
});

test('a cause without details reports only what it has', () => {
  const cause = workflowError(
    'ARCHIVE_REBUILT_SPECS_INVALID',
    'Strict validation rejected rebuilt base specs.',
    ExitCode.verification,
  );
  assert.deepEqual(boundedArchiveCauseDiagnostic(cause), {
    causeCode: 'ARCHIVE_REBUILT_SPECS_INVALID',
    causeMessage: 'Strict validation rejected rebuilt base specs.',
  });
});

test('a non-workflow cause is not described beyond its absence', () => {
  assert.deepEqual(boundedArchiveCauseDiagnostic(new Error('raw failure')), {});
  assert.deepEqual(boundedArchiveCauseDiagnostic('a string'), {});
  assert.deepEqual(boundedArchiveCauseDiagnostic(undefined), {});
});

test('an oversized payload is dropped rather than propagated', () => {
  // Diagnostics travel into logs and reports; an unbounded subprocess payload
  // must not ride along just because the failure happened to be structured.
  const cause = workflowError('X_FAILED', 'y', ExitCode.verification, {
    details: { blob: 'z'.repeat(20_000) },
  });
  const projected = boundedArchiveCauseDiagnostic(cause);
  assert.equal(projected.causeCode, 'X_FAILED');
  assert.equal(projected.causeDetails, undefined);
});

test('an oversized message is dropped without losing the code', () => {
  const cause = workflowError(
    'X_FAILED',
    'm'.repeat(20_000),
    ExitCode.verification,
  );
  assert.deepEqual(boundedArchiveCauseDiagnostic(cause), {
    causeCode: 'X_FAILED',
  });
});
