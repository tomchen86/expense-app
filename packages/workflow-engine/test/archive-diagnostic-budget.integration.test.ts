import assert from 'node:assert/strict';
import test from 'node:test';

import { boundedArchiveCauseDiagnostic } from '../src/archive-transformation.ts';
import { canonicalJson } from '../src/canonical-json.ts';
import { ExitCode, workflowError } from '../src/errors.ts';

const MAX_CAUSE_ENVELOPE_BYTES = 8_192;

test('archive cause diagnostics share one canonical 8KB envelope and retain structured repair identities first', () => {
  const cause = workflowError(
    'SPEC_SCENARIO_PRESERVATION_FAILED',
    `Archive apply failed. ${'m'.repeat(7_900)}`,
    ExitCode.verification,
    {
      details: {
        capability: 'workflow-lifecycle',
        requirement: 'Serialized Completion Authority',
        missingScenarios: [
          'Concurrent transition is requested',
          'Existing manual staging is present',
        ],
        renameCandidates: [
          {
            from: 'Serialized Completion Authority',
            to: 'Serialized Lifecycle Authority',
          },
        ],
        unstructuredProcessOutput: 'z'.repeat(20_000),
      },
    },
  );

  const diagnostic = boundedArchiveCauseDiagnostic(cause);

  assert.ok(
    Buffer.byteLength(canonicalJson(diagnostic), 'utf8') <=
      MAX_CAUSE_ENVELOPE_BYTES,
  );
  assert.equal(diagnostic.causeCode, 'SPEC_SCENARIO_PRESERVATION_FAILED');
  assert.equal(diagnostic.causeMessage, undefined);
  assert.deepEqual(diagnostic.causeDetails, {
    capability: 'workflow-lifecycle',
    requirement: 'Serialized Completion Authority',
    missingScenarios: [
      'Concurrent transition is requested',
      'Existing manual staging is present',
    ],
    renameCandidates: [
      {
        from: 'Serialized Completion Authority',
        to: 'Serialized Lifecycle Authority',
      },
    ],
  });
});

test('individually admissible message and details cannot combine into an oversized cause envelope', () => {
  const cause = workflowError(
    'SPEC_DELTA_NOT_APPLICABLE',
    'm'.repeat(7_000),
    ExitCode.verification,
    {
      details: {
        capability: 'payments',
        requirement: 'Idempotent settlement',
        diagnostic: 'd'.repeat(7_000),
      },
    },
  );

  const diagnostic = boundedArchiveCauseDiagnostic(cause);

  assert.ok(
    Buffer.byteLength(canonicalJson(diagnostic), 'utf8') <=
      MAX_CAUSE_ENVELOPE_BYTES,
  );
  assert.equal(diagnostic.causeCode, 'SPEC_DELTA_NOT_APPLICABLE');
  assert.deepEqual(diagnostic.causeDetails, {
    capability: 'payments',
    requirement: 'Idempotent settlement',
    diagnostic: 'd'.repeat(7_000),
  });
  assert.equal(diagnostic.causeMessage, undefined);
});
