import assert from 'node:assert/strict';
import test from 'node:test';

import { createGrantChallenge } from '../src/grant-core.ts';
import {
  createInvestigationGrantRequestFromState,
  investigationGrantTransitionDefinitions,
} from '../src/investigation-grant-transitions.ts';
import {
  humanResolutionDecisionSchemaDigest,
  type InvestigationResolutionState,
} from '../src/investigation-session-store.ts';
import { createTransitionRegistry } from '../src/grant-transition-registry.ts';

test('investigation producer submits stable choices while registry owns presentation and execution', () => {
  const state = resolutionState();
  const request = createInvestigationGrantRequestFromState({
    repositoryId: 'github:R_fixture',
    repositoryHead: '1'.repeat(40),
    repositoryTree: '2'.repeat(40),
    proposedReason:
      'The reviewer budget is exhausted and a human must select the resolution.',
    state,
  });
  assert.equal(request.sourceModuleId, 'investigation');
  assert.equal(request.failureCode, 'investigation-human-action-required');
  assert.equal(request.stateBinding.kind, 'investigation-resolution-state');
  assert.equal(request.candidates.length, 9);
  assert.ok(
    request.candidates.every(
      ({ proposedReason }) =>
        proposedReason ===
        'The reviewer budget is exhausted and a human must select the resolution.',
    ),
  );
  assert.ok(
    request.candidates.every(
      (candidate) =>
        !Object.hasOwn(candidate, 'title') &&
        !Object.hasOwn(candidate, 'consequences') &&
        !Object.hasOwn(candidate, 'execute'),
    ),
  );

  const registry = createTransitionRegistry(
    investigationGrantTransitionDefinitions('/unused'),
  );
  const challenge = createGrantChallenge(request, registry, {
    challengeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    now: new Date('2026-08-18T04:00:00.000Z'),
    expiresAt: '2026-08-18T04:10:00.000Z',
  });
  const rendered = challenge.choices.map((choice) =>
    registry.renderTrustedChoice(choice),
  );
  assert.ok(rendered.some(({ title }) => title === 'Abort investigation'));
  assert.ok(
    rendered.some(
      ({ title }) => title === 'Quarantine unsafe investigation state',
    ),
  );
  assert.equal(
    rendered.filter(({ title }) => title.startsWith('Supersede investigation'))
      .length,
    4,
  );
});

function resolutionState(): InvestigationResolutionState {
  const availableKinds = [
    'resume-with-capability',
    'close-input',
    'abort',
    'quarantine',
    'supersede',
    'waive-assurance',
  ] as const;
  return {
    envelope: {
      schemaVersion: 2,
      workflowKind: 'investigation',
      repositoryId: 'github:R_fixture',
      changeId: 'demo-change',
      investigationId: 'investigation-demo',
      sessionDigest: '3'.repeat(64),
      sessionRevision: 4,
      currentRefDigest: '4'.repeat(64),
      startReservationDigest: '5'.repeat(64),
      resolutionHeadNodeId: null,
      providerInvocationDigests: [],
      providerRetryReservations: [],
      repositoryProviderLeases: [],
      evidenceRefs: null,
      evidenceRefsDigest: null,
      evidenceRefsClosureDigest: null,
      blockerDigest: '6'.repeat(64),
      ambiguityDigest: null,
    },
    currentStateDigest: '7'.repeat(64),
    currentRefDigest: '4'.repeat(64),
    blocker: {
      schemaVersion: 2,
      state: 'human-action-required',
      reasonCode: 'INVESTIGATION_REVIEWER_REOPEN_LIMIT_REACHED',
      blockedTransition: 'reviewer-term-reopen',
      enteredAt: '2026-08-18T03:00:00.000Z',
      facts: { exhaustedUses: 1 },
      availableResolutions: availableKinds.map((kind) => ({
        kind,
        parameterSchemaDigest: humanResolutionDecisionSchemaDigest(kind),
      })),
    },
    availableResolutions: availableKinds.map((kind) => ({
      kind,
      parameterSchemaDigest: humanResolutionDecisionSchemaDigest(kind),
    })),
    effectiveState: 'human-action-required',
  };
}
