import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approvalSubjectDigest,
  createApprovalSubject,
  createGrantChallenge,
  type GrantRequestInput,
} from '../src/grant-core.ts';
import {
  createTransitionRegistry,
  type TransitionDefinition,
} from '../src/grant-transition-registry.ts';
import { isWorkflowError } from './fixture.ts';

const NOW = new Date('2026-08-18T01:00:00.000Z');
const EXPIRES_AT = '2026-08-18T01:05:00.000Z';
const STATE_DIGEST = digest('1');
const PARAMETER_SCHEMA_DIGEST = digest('2');
const CONSEQUENCE_DIGEST = digest('3');

test('a domain module supplies facts and candidate IDs while the registry supplies the trusted choice and transition', () => {
  const registry = createTransitionRegistry([abortDefinition()]);
  const challenge = createGrantChallenge(request(), registry, {
    challengeId: '11111111-1111-4111-8111-111111111111',
    now: NOW,
    expiresAt: EXPIRES_AT,
  });

  assert.equal(challenge.sourceModuleId, 'investigation');
  assert.equal(challenge.failureCode, 'reviewer-terms-exhausted');
  assert.deepEqual(challenge.facts, {
    investigationId: 'investigation-1',
    remainingUses: 0,
  });
  assert.equal(challenge.stateBinding.digest, STATE_DIGEST);
  assert.equal(challenge.choices.length, 1);
  assert.equal(challenge.choices[0]?.transitionId, 'investigation.abort.v1');
  assert.equal(
    challenge.choices[0]?.parameterSchemaDigest,
    PARAMETER_SCHEMA_DIGEST,
  );
  assert.equal(challenge.choices[0]?.consequenceDigest, CONSEQUENCE_DIGEST);
  assert.equal(
    challenge.choices[0]?.proposedReason,
    'The reviewer budget is exhausted and the investigation cannot continue.',
  );
  assert.deepEqual(registry.renderTrustedChoice(challenge.choices[0]!), {
    title: 'Abort investigation',
    consequences: ['The investigation becomes terminal.'],
  });
  assert.match(challenge.challengeDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(challenge), true);
  assert.equal(Object.isFrozen(challenge.choices), true);
});

test('the producer boundary rejects caller labels, callbacks, unknown transitions, and retry-only choices', () => {
  const registry = createTransitionRegistry([
    abortDefinition(),
    retryDefinition(),
  ]);
  const unsafe = request() as GrantRequestInput & {
    label: string;
    execute: () => void;
  };
  unsafe.label = 'Harmless retry';
  unsafe.execute = () => undefined;

  assert.throws(
    () =>
      createGrantChallenge(unsafe, registry, {
        challengeId: '22222222-2222-4222-8222-222222222222',
        now: NOW,
        expiresAt: EXPIRES_AT,
      }),
    (error) => isWorkflowError(error, 'GRANT_REQUEST_INVALID'),
  );

  assert.throws(
    () =>
      createGrantChallenge(
        {
          ...request(),
          candidates: [
            {
              ...request().candidates[0]!,
              transitionId: 'investigation.unregistered.v1',
            },
          ],
        },
        registry,
        {
          challengeId: '33333333-3333-4333-8333-333333333333',
          now: NOW,
          expiresAt: EXPIRES_AT,
        },
      ),
    (error) => isWorkflowError(error, 'GRANT_TRANSITION_UNKNOWN'),
  );

  assert.throws(
    () =>
      createGrantChallenge(
        {
          ...request(),
          candidates: [
            {
              transitionId: 'investigation.retry.v1',
              parameters: {},
              allowedReasonCodes: ['retry-after-review'],
              reasonRequired: true,
              proposedReason:
                'Retry after a human reviews the exhausted reviewer budget.',
            },
          ],
        },
        registry,
        {
          challengeId: '44444444-4444-4444-8444-444444444444',
          now: NOW,
          expiresAt: EXPIRES_AT,
        },
      ),
    (error) => isWorkflowError(error, 'GRANT_NON_RETRY_RESOLUTION_REQUIRED'),
  );

  assert.throws(
    () =>
      createGrantChallenge(
        {
          ...request(),
          candidates: [
            {
              ...request().candidates[0]!,
              proposedReason: '   ',
            },
          ],
        },
        registry,
        {
          challengeId: '77777777-7777-4777-8777-777777777777',
          now: NOW,
          expiresAt: EXPIRES_AT,
        },
      ),
    (error) => isWorkflowError(error, 'GRANT_REASON_INVALID'),
  );
});

test('an approval subject binds the exact choice, human reason, state, expiry, and nonce', () => {
  const registry = createTransitionRegistry([abortDefinition()]);
  const challenge = createGrantChallenge(request(), registry, {
    challengeId: '55555555-5555-4555-8555-555555555555',
    now: NOW,
    expiresAt: EXPIRES_AT,
  });
  const subject = createApprovalSubject(
    challenge,
    {
      choiceId: challenge.choices[0]!.choiceId,
      approvalMethod: 'human-presence',
      reasonCode: 'cannot-complete-review',
      reason: 'The required reviewer input cannot be recovered.',
      sessionNonce: 'nonce-11111111111111111111111111111111',
    },
    { now: NOW },
  );

  assert.equal(subject.challengeDigest, challenge.challengeDigest);
  assert.equal(subject.choiceId, challenge.choices[0]?.choiceId);
  assert.equal(subject.approvalMethod, 'human-presence');
  assert.equal(subject.reasonCode, 'cannot-complete-review');
  assert.equal(
    subject.reason,
    'The required reviewer input cannot be recovered.',
  );
  assert.match(subject.reasonDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(subject.stateDigest, STATE_DIGEST);
  assert.equal(subject.expiresAt, EXPIRES_AT);
  assert.match(approvalSubjectDigest(subject), /^sha256:[0-9a-f]{64}$/);

  assert.throws(
    () => approvalSubjectDigest({ ...subject, reason: 'A different reason.' }),
    (error) => isWorkflowError(error, 'GRANT_APPROVAL_SUBJECT_INVALID'),
  );
  const differentSubject = createApprovalSubject(
    challenge,
    {
      choiceId: challenge.choices[0]!.choiceId,
      approvalMethod: 'ssh',
      reasonCode: 'cannot-complete-review',
      reason: 'A different reason.',
      sessionNonce: 'nonce-33333333333333333333333333333333',
    },
    { now: NOW },
  );
  assert.notEqual(
    approvalSubjectDigest(differentSubject),
    approvalSubjectDigest(subject),
  );
  assert.throws(
    () =>
      createApprovalSubject(
        challenge,
        {
          choiceId: challenge.choices[0]!.choiceId,
          approvalMethod: 'human-presence',
          reasonCode: 'unregistered-reason',
          reason: 'Try to substitute another rationale.',
          sessionNonce: 'nonce-22222222222222222222222222222222',
        },
        { now: NOW },
      ),
    (error) => isWorkflowError(error, 'GRANT_REASON_NOT_ALLOWED'),
  );
});

function request(): GrantRequestInput {
  return {
    sourceModuleId: 'investigation',
    failureCode: 'reviewer-terms-exhausted',
    facts: {
      investigationId: 'investigation-1',
      remainingUses: 0,
    },
    stateBinding: {
      kind: 'investigation-state',
      digest: STATE_DIGEST,
    },
    candidates: [
      {
        transitionId: 'investigation.abort.v1',
        parameters: { terminalReason: 'reviewer-terms-exhausted' },
        allowedReasonCodes: ['cannot-complete-review'],
        reasonRequired: true,
        proposedReason:
          'The reviewer budget is exhausted and the investigation cannot continue.',
      },
    ],
  };
}

function abortDefinition(): TransitionDefinition<{
  terminalReason: string;
}> {
  return {
    transitionId: 'investigation.abort.v1',
    parameterSchemaDigest: PARAMETER_SCHEMA_DIGEST,
    consequenceDigest: CONSEQUENCE_DIGEST,
    resolutionKind: 'non-retry',
    validateParameters(value) {
      assert.deepEqual(value, {
        terminalReason: 'reviewer-terms-exhausted',
      });
      return value as { terminalReason: string };
    },
    renderTrustedChoice() {
      return {
        title: 'Abort investigation',
        consequences: ['The investigation becomes terminal.'],
      };
    },
    observeState() {
      return { kind: 'investigation-state', digest: STATE_DIGEST };
    },
    async execute({ parameters }) {
      return { outcome: 'completed', details: parameters };
    },
  };
}

function retryDefinition(): TransitionDefinition<Record<string, never>> {
  return {
    transitionId: 'investigation.retry.v1',
    parameterSchemaDigest: digest('4'),
    consequenceDigest: digest('5'),
    resolutionKind: 'retry',
    validateParameters(value) {
      assert.deepEqual(value, {});
      return {};
    },
    renderTrustedChoice() {
      return {
        title: 'Retry investigation',
        consequences: ['The same operation runs again.'],
      };
    },
    observeState() {
      return { kind: 'investigation-state', digest: STATE_DIGEST };
    },
    async execute() {
      return { outcome: 'completed', details: {} };
    },
  };
}

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
