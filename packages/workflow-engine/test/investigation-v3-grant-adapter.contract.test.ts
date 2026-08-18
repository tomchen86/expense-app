import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import {
  createApprovalSubject,
  createGrantChallenge,
  approvalSubjectDigest,
} from '../src/grant-core.ts';
import { createTransitionRegistry } from '../src/grant-transition-registry.ts';
import {
  INVESTIGATION_V3_ATTEMPTED_TRANSITIONS,
  INVESTIGATION_V3_KNOWN_FAILURE_CODES,
  createInvestigationV3Blocker,
} from '../src/investigation-manifest.ts';
import {
  createInvestigationV3GrantRequest,
  investigationV3CentralFailureCode,
  investigationV3GrantTransitionDefinitions,
} from '../src/investigation-v3-grant.ts';

const PROPOSED_REASON =
  'The v3 transition failed and a human must choose the bounded continuation.';

test('central adapter covers every v3 transition and non-exhaustive failure code', () => {
  const codes = [
    ...INVESTIGATION_V3_KNOWN_FAILURE_CODES,
    'FUTURE_ENGINE_FAILURE',
  ];
  for (const attemptedTransition of INVESTIGATION_V3_ATTEMPTED_TRANSITIONS) {
    for (const failureCode of codes) {
      const blocker = createInvestigationV3Blocker({
        attemptedTransition,
        candidate: { attemptedTransition, failureCode },
        failureCode,
        message: `Failure ${failureCode}`,
      });
      const request = createInvestigationV3GrantRequest({
        blocker,
        proposedReason: PROPOSED_REASON,
      });
      assert.equal(request.sourceModuleId, 'investigation.v3');
      assert.equal(
        request.failureCode,
        investigationV3CentralFailureCode(failureCode),
      );
      assert.equal(request.stateBinding.kind, 'investigation.v3.failure');
      assert.deepEqual(request.facts, {
        schemaVersion: 1,
        workflowKind: 'investigation-v3',
        blocker,
      });
      assert.equal(request.candidates.length, 1);
      assert.equal(
        request.candidates[0]!.transitionId,
        'investigation.v3.stop-transition.v1',
      );
      assert.equal(request.candidates[0]!.proposedReason, PROPOSED_REASON);
      assert.equal('title' in request.candidates[0]!, false);
      assert.equal('consequences' in request.candidates[0]!, false);
      assert.equal('execute' in request.candidates[0]!, false);
    }
  }
  assert.equal(
    investigationV3CentralFailureCode('FUTURE_ENGINE_FAILURE'),
    'investigation.v3.future-engine-failure',
  );
});

test('central registry owns the safe stop transition without relabelling assurance', async () => {
  const blocker = createInvestigationV3Blocker({
    attemptedTransition: 'publication',
    candidate: { manifestDigest: 'a'.repeat(64) },
    failureCode: 'REVIEW_TARGET_STALE',
    message: 'The publication target changed.',
  });
  const request = createInvestigationV3GrantRequest({
    blocker,
    proposedReason: PROPOSED_REASON,
  });
  const registry = createTransitionRegistry(
    investigationV3GrantTransitionDefinitions(),
  );
  const challenge = createGrantChallenge(request, registry, {
    challengeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    now: new Date('2026-08-18T05:00:00.000Z'),
    expiresAt: '2026-08-18T05:10:00.000Z',
  });
  const choice = challenge.choices[0]!;
  assert.deepEqual(registry.renderTrustedChoice(choice), {
    title: 'Stop this Investigation v3 transition',
    consequences: [
      'Preserves the failed assurance and keeps the current authority unchanged.',
    ],
  });
  const approvalSubject = createApprovalSubject(
    challenge,
    {
      choiceId: choice.choiceId,
      approvalMethod: 'human-presence',
      reasonCode: 'preserve-current-authority',
      reason: 'Keep the current authority and stop this failed transition.',
      sessionNonce: 'nonce-55555555555555555555555555555555',
    },
    { now: new Date('2026-08-18T05:01:00.000Z') },
  );
  const definition = registry.resolve(choice.transitionId);
  assert.deepEqual(
    await definition.observeState(choice.parameters),
    request.stateBinding,
  );
  const outcome = await definition.execute({
    parameters: choice.parameters,
    approvalSubject,
    approvalSubjectDigest: approvalSubjectDigest(approvalSubject),
    challengeId: challenge.challengeId,
    operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    recovered: false,
    assertLifecycleOwned() {},
  });
  assert.deepEqual(outcome, {
    outcome: 'completed',
    details: {
      continuation: 'stop-transition',
      failureIdentity: blocker.failureIdentity,
      failurePreserved: true,
      authorityAdvanced: false,
    },
  });
  assert.equal(canonicalJson(outcome).includes('verified'), false);
});

test('v3 adapter remains central and introduces no local grant substrate', () => {
  const source = fs.readFileSync(
    new URL('../src/investigation-v3-grant.ts', import.meta.url),
    'utf8',
  );
  for (const forbidden of [
    'grant-store',
    'human-gate-macos',
    'grant-proof-ssh',
    'writeFile',
    'journal',
    'callback',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
