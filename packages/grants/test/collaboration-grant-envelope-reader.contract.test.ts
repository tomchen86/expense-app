import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1,
  COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE,
  COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  CollaborationGrantEnvelopeReaderError,
  canonicalCollaborationGrantEnvelopeBytesV1,
  canonicalCollaborationGrantPayloadBytesV1,
  parseCollaborationGrantEnvelopeV1,
  readAndVerifyCollaborationGrantEnvelopeV1,
  selectCollaborationGrantSignatureNamespaceV1,
  type CollaborationGrantPayloadCodecV1,
} from '../src/collaboration-grant-envelope-reader.ts';

const SIGNATURE = 'fixture-signature';
const V1_PAYLOAD = {
  version: 1 as const,
  subject: 'fixture-subject',
  authorizedEffect: 'fixture-effect',
  signer: 'fixture-signer',
};
const V2_PAYLOAD = {
  version: 2 as const,
  signatureNamespace: COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  subject: 'fixture-subject',
  authorizedEffect: 'fixture-effect',
  signer: 'fixture-signer',
};
const V1_PAYLOAD_BYTES =
  '{"version":1,"subject":"fixture-subject","authorizedEffect":"fixture-effect","signer":"fixture-signer"}\n';
const V2_PAYLOAD_BYTES =
  '{"version":2,"signatureNamespace":"workflow.collaboration-grant.v2","subject":"fixture-subject","authorizedEffect":"fixture-effect","signer":"fixture-signer"}\n';

type FixturePayload = typeof V1_PAYLOAD | typeof V2_PAYLOAD;

const CODEC: CollaborationGrantPayloadCodecV1<FixturePayload> = {
  v1PayloadKeys: ['version', 'subject', 'authorizedEffect', 'signer'],
  v2PayloadKeys: [
    'version',
    'signatureNamespace',
    'subject',
    'authorizedEffect',
    'signer',
  ],
  parsePayload(value) {
    if (
      !isRecord(value) ||
      (value.version !== 1 && value.version !== 2) ||
      typeof value.subject !== 'string' ||
      value.authorizedEffect !== 'fixture-effect' ||
      value.signer !== 'fixture-signer'
    ) {
      throw new Error('fixture payload invalid');
    }
    return value as FixturePayload;
  },
  projectPayloadFields(payload) {
    return {
      subject: payload.subject,
      authorizedEffect: payload.authorizedEffect,
      signer: payload.signer,
    };
  },
  validateSignature(signature) {
    if (signature !== SIGNATURE) throw new Error('fixture signature invalid');
  },
};

test('preserves historical V1 and current V2 canonical payload and envelope bytes', () => {
  assert.equal(
    canonicalCollaborationGrantPayloadBytesV1(V1_PAYLOAD, CODEC),
    V1_PAYLOAD_BYTES,
  );
  assert.equal(
    canonicalCollaborationGrantPayloadBytesV1(V2_PAYLOAD, CODEC),
    V2_PAYLOAD_BYTES,
  );
  const v1EnvelopeBytes = `${JSON.stringify({
    payload: JSON.parse(V1_PAYLOAD_BYTES),
    signature: SIGNATURE,
  })}\n`;
  const v2EnvelopeBytes = `${JSON.stringify({
    payload: JSON.parse(V2_PAYLOAD_BYTES),
    signature: SIGNATURE,
  })}\n`;
  assert.equal(
    canonicalCollaborationGrantEnvelopeBytesV1(
      { payload: V1_PAYLOAD, signature: SIGNATURE },
      CODEC,
    ),
    v1EnvelopeBytes,
  );
  assert.equal(
    canonicalCollaborationGrantEnvelopeBytesV1(
      { payload: V2_PAYLOAD, signature: SIGNATURE },
      CODEC,
    ),
    v2EnvelopeBytes,
  );
  const parsedV1 = parseCollaborationGrantEnvelopeV1(v1EnvelopeBytes, CODEC);
  const parsedV2 = parseCollaborationGrantEnvelopeV1(v2EnvelopeBytes, CODEC);
  assert.deepEqual(parsedV1, { payload: V1_PAYLOAD, signature: SIGNATURE });
  assert.deepEqual(parsedV2, { payload: V2_PAYLOAD, signature: SIGNATURE });
  assert.equal(Object.isFrozen(parsedV1), true);
  assert.equal(Object.isFrozen(parsedV1.payload), true);
  assert.equal(
    selectCollaborationGrantSignatureNamespaceV1(parsedV1.payload),
    COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE,
  );
  assert.equal(
    selectCollaborationGrantSignatureNamespaceV1(parsedV2.payload),
    COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  );
});

test('unknown versions, wrong namespaces, extra keys, and non-canonical bytes fail closed', () => {
  const invalid = [
    envelopeBytes({ ...V1_PAYLOAD, version: 3 }),
    envelopeBytes({
      ...V2_PAYLOAD,
      signatureNamespace: COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE,
    }),
    envelopeBytes({ ...V1_PAYLOAD, extra: true }),
    `${JSON.stringify({ signature: SIGNATURE, payload: V1_PAYLOAD })}\n`,
  ];
  for (const raw of invalid) {
    assert.throws(
      () => parseCollaborationGrantEnvelopeV1(raw, CODEC),
      (error) => error instanceof CollaborationGrantEnvelopeReaderError,
    );
  }
});

test('selects exactly one historical namespace and performs the injected verifier call without fallback', () => {
  const calls: Array<readonly [string, string, string, string]> = [];
  for (const payload of [V1_PAYLOAD, V2_PAYLOAD]) {
    const envelope = { payload, signature: SIGNATURE };
    const result = readAndVerifyCollaborationGrantEnvelopeV1({
      readerContractVersion:
        COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1,
      raw: canonicalCollaborationGrantEnvelopeBytesV1(envelope, CODEC),
      codec: CODEC,
      validatePayload: () => undefined,
      authorizedEffect: (parsed) => parsed.authorizedEffect,
      signer: (parsed) => parsed.signer,
      allowedAuthorizedEffects: ['fixture-effect'],
      verifier: {
        verify(...input) {
          calls.push(input);
        },
      },
    });
    assert.equal(result.envelope.payload.version, payload.version);
    assert.equal(
      result.verification.receipt.signatureNamespace,
      payload.version === 1
        ? COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE
        : COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
    );
  }
  assert.deepEqual(calls, [
    [
      V1_PAYLOAD_BYTES,
      SIGNATURE,
      'fixture-signer',
      COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE,
    ],
    [
      V2_PAYLOAD_BYTES,
      SIGNATURE,
      'fixture-signer',
      COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
    ],
  ]);
});

test('runs domain semantic validation before invoking the verifier', () => {
  const refusal = new Error('domain binding refused');
  let verifierCalls = 0;
  assert.throws(
    () =>
      readAndVerifyCollaborationGrantEnvelopeV1({
        readerContractVersion:
          COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1,
        raw: canonicalCollaborationGrantEnvelopeBytesV1(
          { payload: V1_PAYLOAD, signature: SIGNATURE },
          CODEC,
        ),
        codec: CODEC,
        validatePayload() {
          throw refusal;
        },
        authorizedEffect: (parsed) => parsed.authorizedEffect,
        signer: (parsed) => parsed.signer,
        allowedAuthorizedEffects: ['fixture-effect'],
        verifier: {
          verify() {
            verifierCalls += 1;
          },
        },
      }),
    (error) => error === refusal,
  );
  assert.equal(verifierCalls, 0);
});

function envelopeBytes(payload: unknown): string {
  return `${JSON.stringify({ payload, signature: SIGNATURE })}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
