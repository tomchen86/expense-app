import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  GRANT_ENVELOPE_VERIFIER_CONTRACT_VERSION_V1,
  GrantEnvelopeVerificationError,
  verifyGrantEnvelopeV1,
} from '../src/grant-envelope-verifier.ts';

const PAYLOAD = '{"version":1,"effect":"fixture-effect"}\n';
const SIGNATURE = 'fixture-signature';
const SIGNER = 'fixture-signer';

test('returns one immutable typed capability and deterministic receipt after exact verification', () => {
  const calls: unknown[][] = [];
  const capability = verifyGrantEnvelopeV1({
    contractVersion: GRANT_ENVELOPE_VERIFIER_CONTRACT_VERSION_V1,
    canonicalPayload: PAYLOAD,
    signature: SIGNATURE,
    signer: SIGNER,
    signatureNamespace: 'fixture.grant.v2',
    authorizedEffect: 'fixture-effect',
    allowedSignatureNamespaces: ['fixture.grant.v1', 'fixture.grant.v2'],
    allowedAuthorizedEffects: ['fixture-effect'],
    verifier: {
      verify(...input) {
        calls.push(input);
      },
    },
  });

  assert.deepEqual(calls, [[PAYLOAD, SIGNATURE, SIGNER, 'fixture.grant.v2']]);
  assert.equal(capability.kind, 'jigwright.verified-grant-capability.v1');
  assert.deepEqual(capability.receipt, {
    schemaVersion: 1,
    verifierContractVersion: GRANT_ENVELOPE_VERIFIER_CONTRACT_VERSION_V1,
    signatureNamespace: 'fixture.grant.v2',
    authorizedEffect: 'fixture-effect',
    signer: SIGNER,
    signedPayloadDigest: sha256(PAYLOAD),
    signatureDigest: sha256(SIGNATURE),
  });
  assert.equal(
    capability.receiptDigest,
    sha256(`${JSON.stringify(capability.receipt)}\n`),
  );
  assert.equal(Object.isFrozen(capability), true);
  assert.equal(Object.isFrozen(capability.receipt), true);
});

test('rejects unknown namespace, effect, and contract before invoking the verifier', () => {
  let calls = 0;
  const base = {
    contractVersion: GRANT_ENVELOPE_VERIFIER_CONTRACT_VERSION_V1,
    canonicalPayload: PAYLOAD,
    signature: SIGNATURE,
    signer: SIGNER,
    signatureNamespace: 'fixture.grant.v2',
    authorizedEffect: 'fixture-effect',
    allowedSignatureNamespaces: ['fixture.grant.v1', 'fixture.grant.v2'],
    allowedAuthorizedEffects: ['fixture-effect'],
    verifier: {
      verify() {
        calls += 1;
      },
    },
  } as const;

  assert.throws(
    () =>
      verifyGrantEnvelopeV1({
        ...base,
        signatureNamespace: 'fixture.grant.v3',
      }),
    isGrantVerificationError('GRANT_SIGNATURE_NAMESPACE_UNSUPPORTED'),
  );
  assert.throws(
    () =>
      verifyGrantEnvelopeV1({
        ...base,
        authorizedEffect: 'arbitrary-authority',
      }),
    isGrantVerificationError('GRANT_AUTHORIZED_EFFECT_UNSUPPORTED'),
  );
  assert.throws(
    () =>
      verifyGrantEnvelopeV1({
        ...base,
        contractVersion: 'jigwright.grant-envelope-verifier.v9',
      }),
    isGrantVerificationError('GRANT_VERIFIER_CONTRACT_UNSUPPORTED'),
  );
  assert.equal(calls, 0);
});

test('normalizes verifier refusal without minting a capability', () => {
  assert.throws(
    () =>
      verifyGrantEnvelopeV1({
        contractVersion: GRANT_ENVELOPE_VERIFIER_CONTRACT_VERSION_V1,
        canonicalPayload: PAYLOAD,
        signature: SIGNATURE,
        signer: SIGNER,
        signatureNamespace: 'fixture.grant.v2',
        authorizedEffect: 'fixture-effect',
        allowedSignatureNamespaces: ['fixture.grant.v2'],
        allowedAuthorizedEffects: ['fixture-effect'],
        verifier: {
          verify() {
            throw new Error('signature refused');
          },
        },
      }),
    isGrantVerificationError('GRANT_SIGNATURE_INVALID'),
  );
});

function isGrantVerificationError(code: string) {
  return (error: unknown): boolean =>
    error instanceof GrantEnvelopeVerificationError && error.code === code;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
