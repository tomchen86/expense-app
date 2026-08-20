import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  SIGNED_ATTESTATION_ENVELOPE_READER_CONTRACT_VERSION_V1,
  SignedAttestationEnvelopeReaderError,
  canonicalSignedAttestationEnvelopeBytesV1,
  canonicalSignedAttestationPayloadBytesV1,
  parseSignedAttestationEnvelopeV1,
  readAndVerifySignedAttestationEnvelopeV1,
  type SignedAttestationPayloadCodecV1,
} from '../src/signed-attestation-envelope-reader.ts';

const SIGNATURE_NAMESPACE = 'fixture.direct-review.v1';
const SIGNATURE = 'fixture-signature';
const PAYLOAD = {
  version: 1 as const,
  subject: 'fixture-subject',
  resultDigest: 'a'.repeat(64),
  signedAt: '2026-08-20T00:00:00.000Z',
  signer: 'fixture-signer',
};
const PAYLOAD_BYTES = `${JSON.stringify(PAYLOAD)}\n`;
const ENVELOPE = { payload: PAYLOAD, signature: SIGNATURE };
const ENVELOPE_BYTES = `${JSON.stringify(ENVELOPE)}\n`;

type FixturePayload = typeof PAYLOAD;

const CODEC: SignedAttestationPayloadCodecV1<FixturePayload> = {
  payloadKeys: ['version', 'subject', 'resultDigest', 'signedAt', 'signer'],
  parsePayload(value) {
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      value.subject !== PAYLOAD.subject ||
      value.resultDigest !== PAYLOAD.resultDigest ||
      value.signedAt !== PAYLOAD.signedAt ||
      value.signer !== PAYLOAD.signer
    ) {
      throw new Error('fixture attestation payload invalid');
    }
    return value as FixturePayload;
  },
  projectPayloadFields(payload) {
    return {
      subject: payload.subject,
      resultDigest: payload.resultDigest,
      signedAt: payload.signedAt,
      signer: payload.signer,
    };
  },
  validateSignature(signature) {
    if (signature !== SIGNATURE) throw new Error('signature shape invalid');
  },
};

test('preserves exact V1 canonical payload and envelope bytes', () => {
  assert.equal(
    canonicalSignedAttestationPayloadBytesV1(PAYLOAD, CODEC),
    PAYLOAD_BYTES,
  );
  assert.equal(
    canonicalSignedAttestationEnvelopeBytesV1(ENVELOPE, CODEC),
    ENVELOPE_BYTES,
  );
  const parsed = parseSignedAttestationEnvelopeV1(ENVELOPE_BYTES, CODEC);
  assert.deepEqual(parsed, ENVELOPE);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.payload), true);
});

test('unknown versions, extra keys, signature-shape drift, and non-canonical bytes fail closed', () => {
  const invalid: ReadonlyArray<readonly [string, string]> = [
    [
      envelopeBytes({ ...PAYLOAD, version: 2 }),
      'SIGNED_ATTESTATION_PAYLOAD_VERSION_UNSUPPORTED',
    ],
    [
      envelopeBytes({ ...PAYLOAD, extra: true }),
      'SIGNED_ATTESTATION_ENVELOPE_SHAPE_INVALID',
    ],
    [
      `${JSON.stringify({ signature: SIGNATURE, payload: PAYLOAD })}\n`,
      'SIGNED_ATTESTATION_ENVELOPE_NON_CANONICAL',
    ],
    [
      `${JSON.stringify({ payload: PAYLOAD, signature: 'wrong' })}\n`,
      'SIGNED_ATTESTATION_SIGNATURE_SHAPE_INVALID',
    ],
  ];
  for (const [raw, code] of invalid) {
    assert.throws(
      () => parseSignedAttestationEnvelopeV1(raw, CODEC),
      isReaderError(code),
    );
  }
});

test('runs domain validation before one exact namespace verifier call and returns an immutable receipt', () => {
  const order: string[] = [];
  const calls: unknown[][] = [];
  const result = readAndVerifySignedAttestationEnvelopeV1({
    readerContractVersion:
      SIGNED_ATTESTATION_ENVELOPE_READER_CONTRACT_VERSION_V1,
    raw: ENVELOPE_BYTES,
    codec: CODEC,
    signatureNamespace: SIGNATURE_NAMESPACE,
    allowedSignatureNamespaces: [SIGNATURE_NAMESPACE],
    validatePayload(payload) {
      order.push(`domain:${payload.subject}`);
    },
    signer: (payload) => payload.signer,
    verifier: {
      verify(...input) {
        order.push('verify');
        calls.push(input);
      },
    },
  });

  assert.deepEqual(order, ['domain:fixture-subject', 'verify']);
  assert.deepEqual(calls, [
    [PAYLOAD_BYTES, SIGNATURE, PAYLOAD.signer, SIGNATURE_NAMESPACE],
  ]);
  assert.deepEqual(result.verification.receipt, {
    schemaVersion: 1,
    readerContractVersion:
      SIGNED_ATTESTATION_ENVELOPE_READER_CONTRACT_VERSION_V1,
    payloadVersion: 1,
    signatureNamespace: SIGNATURE_NAMESPACE,
    signer: PAYLOAD.signer,
    signedPayloadDigest: sha256(PAYLOAD_BYTES),
    signatureDigest: sha256(SIGNATURE),
  });
  assert.equal(
    result.verification.receiptDigest,
    sha256(`${JSON.stringify(result.verification.receipt)}\n`),
  );
  assert.equal(Object.isFrozen(result.verification), true);
  assert.equal(Object.isFrozen(result.verification.receipt), true);
});

test('refuses unknown contracts and namespaces without invoking the verifier', () => {
  let calls = 0;
  const base = {
    readerContractVersion:
      SIGNED_ATTESTATION_ENVELOPE_READER_CONTRACT_VERSION_V1,
    raw: ENVELOPE_BYTES,
    codec: CODEC,
    signatureNamespace: SIGNATURE_NAMESPACE,
    allowedSignatureNamespaces: [SIGNATURE_NAMESPACE],
    validatePayload() {},
    signer: (payload: FixturePayload) => payload.signer,
    verifier: {
      verify() {
        calls += 1;
      },
    },
  } as const;

  assert.throws(
    () =>
      readAndVerifySignedAttestationEnvelopeV1({
        ...base,
        readerContractVersion:
          'jigwright.signed-attestation-envelope-reader.v9',
      }),
    isReaderError('SIGNED_ATTESTATION_READER_CONTRACT_UNSUPPORTED'),
  );
  assert.throws(
    () =>
      readAndVerifySignedAttestationEnvelopeV1({
        ...base,
        signatureNamespace: 'fixture.direct-review.v2',
      }),
    isReaderError('SIGNED_ATTESTATION_SIGNATURE_NAMESPACE_UNSUPPORTED'),
  );
  assert.equal(calls, 0);
});

function envelopeBytes(payload: unknown): string {
  return `${JSON.stringify({ payload, signature: SIGNATURE })}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReaderError(code: string) {
  return (error: unknown): boolean =>
    error instanceof SignedAttestationEnvelopeReaderError &&
    error.code === code;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
