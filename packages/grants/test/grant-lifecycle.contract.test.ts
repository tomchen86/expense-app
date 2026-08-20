import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  GRANT_LIFECYCLE_CONTRACT_VERSION_V1,
  GrantLifecycleTransitionError,
  executeGrantLifecycleTransitionV1,
  type GrantLifecycleState,
} from '../src/grant-lifecycle.ts';

const GRANT_ID = 'fixture-grant';
const TRANSITION_DIGEST = 'a'.repeat(64);
const NOW = new Date('2026-08-20T00:01:00.000Z');

test('reserves one available grant through the storage and clock ports and projects a typed receipt', () => {
  let state: GrantLifecycleState = 'available';
  const applied: unknown[] = [];
  let validations = 0;

  const result = executeGrantLifecycleTransitionV1(
    {
      contractVersion: GRANT_LIFECYCLE_CONTRACT_VERSION_V1,
      grantId: GRANT_ID,
      transitionDigest: TRANSITION_DIGEST,
      maxUses: 1,
      event: {
        kind: 'reserve',
        expiresAt: '2026-08-20T00:30:00.000Z',
        reason: 'Exact grant reserved',
      },
      validate() {
        validations += 1;
        return Object.freeze({ capability: 'verified' as const });
      },
    },
    {
      clock: { now: () => NOW },
      storage: {
        readState: () => state,
        applyTransition(input) {
          applied.push(input);
          state = input.receipt.toState;
          return Object.freeze({ durable: input.receipt.toState });
        },
      },
    },
  );

  assert.equal(validations, 1);
  assert.equal(state, 'reserved');
  assert.deepEqual(result.value, { durable: 'reserved' });
  assert.deepEqual(result.receipt, {
    schemaVersion: 1,
    kind: 'jigwright.grant-lifecycle-audit-receipt.v1',
    lifecycleContractVersion: GRANT_LIFECYCLE_CONTRACT_VERSION_V1,
    grantId: GRANT_ID,
    transitionDigest: TRANSITION_DIGEST,
    fromState: 'available',
    toState: 'reserved',
    occurredAt: NOW.toISOString(),
    reason: 'Exact grant reserved',
  });
  assert.equal(
    result.receiptDigest,
    sha256(`${JSON.stringify(result.receipt)}\n`),
  );
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.receipt), true);
  assert.deepEqual(applied, [
    {
      receipt: result.receipt,
      receiptDigest: result.receiptDigest,
      validation: { capability: 'verified' },
    },
  ]);
});

test('expires before validation and records the terminal transition before refusing reservation', () => {
  let validations = 0;
  const applied: unknown[] = [];

  assert.throws(
    () =>
      executeGrantLifecycleTransitionV1(
        {
          contractVersion: GRANT_LIFECYCLE_CONTRACT_VERSION_V1,
          grantId: GRANT_ID,
          transitionDigest: TRANSITION_DIGEST,
          maxUses: 1,
          event: {
            kind: 'reserve',
            expiresAt: '2026-08-20T00:00:59.999Z',
            reason: 'Exact grant reserved',
            expirationReason: 'Grant expired before reservation',
          },
          validate() {
            validations += 1;
            return 'verified';
          },
        },
        {
          clock: { now: () => NOW },
          storage: {
            readState: () => 'available',
            applyTransition(input) {
              applied.push(input);
              return input.receipt.toState;
            },
          },
        },
      ),
    (error) => {
      assert.ok(error instanceof GrantLifecycleTransitionError);
      assert.equal(error.code, 'GRANT_LIFECYCLE_EXPIRED');
      assert.equal(error.receipt?.fromState, 'available');
      assert.equal(error.receipt?.toState, 'expired');
      return true;
    },
  );
  assert.equal(validations, 0);
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0], {
    receipt: {
      schemaVersion: 1,
      kind: 'jigwright.grant-lifecycle-audit-receipt.v1',
      lifecycleContractVersion: GRANT_LIFECYCLE_CONTRACT_VERSION_V1,
      grantId: GRANT_ID,
      transitionDigest: TRANSITION_DIGEST,
      fromState: 'available',
      toState: 'expired',
      occurredAt: NOW.toISOString(),
      reason: 'Grant expired before reservation',
    },
    receiptDigest: sha256(
      `${JSON.stringify({
        schemaVersion: 1,
        kind: 'jigwright.grant-lifecycle-audit-receipt.v1',
        lifecycleContractVersion: GRANT_LIFECYCLE_CONTRACT_VERSION_V1,
        grantId: GRANT_ID,
        transitionDigest: TRANSITION_DIGEST,
        fromState: 'available',
        toState: 'expired',
        occurredAt: NOW.toISOString(),
        reason: 'Grant expired before reservation',
      })}\n`,
    ),
    validation: undefined,
  });
});

test('consumes a reservation, and terminally fails it when exact admission validation fails', () => {
  const consumed = executeGrantLifecycleTransitionV1(
    lifecycleRequest('consume', 'Exact reference consumed'),
    fixturePorts('reserved'),
  );
  assert.equal(consumed.receipt.fromState, 'reserved');
  assert.equal(consumed.receipt.toState, 'consumed');

  const admissionError = new Error('content admission refused');
  const transitions: string[] = [];
  assert.throws(
    () =>
      executeGrantLifecycleTransitionV1(
        {
          ...lifecycleRequest('consume', 'Exact reference consumed'),
          validationFailureReason: 'Exact role-result content admission failed',
          validate() {
            throw admissionError;
          },
        },
        fixturePorts('reserved', transitions),
      ),
    (error) => error === admissionError,
  );
  assert.deepEqual(transitions, ['failed']);
});

test('revokes either active state, supports explicit failure, and rejects reuse or maxUses other than one', () => {
  for (const state of ['available', 'reserved'] as const) {
    const { validate: _unused, ...request } = lifecycleRequest(
      'revoke',
      'Maintainer revoked exact authority',
    );
    const revoked = executeGrantLifecycleTransitionV1(
      request,
      fixturePorts(state),
    );
    assert.equal(revoked.receipt.toState, 'revoked');
  }
  const { validate: _unused, ...failure } = lifecycleRequest(
    'fail',
    'Provider failed before content admission',
  );
  const failed = executeGrantLifecycleTransitionV1(
    failure,
    fixturePorts('reserved'),
  );
  assert.equal(failed.receipt.toState, 'failed');

  let writes = 0;
  assert.throws(
    () =>
      executeGrantLifecycleTransitionV1(
        lifecycleRequest('consume', 'Exact reference consumed'),
        fixturePorts('consumed', undefined, () => {
          writes += 1;
        }),
      ),
    isLifecycleError('GRANT_LIFECYCLE_STATE_INVALID'),
  );
  assert.throws(
    () =>
      executeGrantLifecycleTransitionV1(
        {
          ...lifecycleRequest('reserve', 'Exact grant reserved'),
          maxUses: 2,
        },
        fixturePorts('available', undefined, () => {
          writes += 1;
        }),
      ),
    isLifecycleError('GRANT_LIFECYCLE_MAX_USES_UNSUPPORTED'),
  );
  assert.equal(writes, 0);
});

function lifecycleRequest(
  kind: 'reserve' | 'consume' | 'fail' | 'revoke',
  reason: string,
) {
  return {
    contractVersion: GRANT_LIFECYCLE_CONTRACT_VERSION_V1,
    grantId: GRANT_ID,
    transitionDigest: TRANSITION_DIGEST,
    maxUses: 1,
    event:
      kind === 'reserve'
        ? ({
            kind,
            expiresAt: '2026-08-20T00:30:00.000Z',
            reason,
          } as const)
        : ({ kind, reason } as const),
    validate: () => 'validated',
  };
}

function fixturePorts(
  state: GrantLifecycleState,
  transitions: string[] = [],
  onApply?: () => void,
) {
  return {
    clock: { now: () => NOW },
    storage: {
      readState: () => state,
      applyTransition(input: {
        receipt: { toState: GrantLifecycleState };
        validation: unknown;
      }) {
        onApply?.();
        transitions.push(input.receipt.toState);
        return input.receipt.toState;
      },
    },
  };
}

function isLifecycleError(code: string) {
  return (error: unknown): boolean =>
    error instanceof GrantLifecycleTransitionError && error.code === code;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
