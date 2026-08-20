import crypto from 'node:crypto';

import type { GrantSignatureVerifierPortV1 } from './grant-envelope-verifier.ts';

export const SIGNED_ATTESTATION_ENVELOPE_READER_CONTRACT_VERSION_V1 =
  'jigwright.signed-attestation-envelope-reader.v1' as const;
export const VERIFIED_SIGNED_ATTESTATION_KIND_V1 =
  'jigwright.verified-signed-attestation.v1' as const;

const MAX_ENVELOPE_BYTES = 32_768;

export type VersionedSignedAttestationPayloadV1 = Readonly<{ version: 1 }>;

export type SignedAttestationEnvelopeV1<
  Payload extends VersionedSignedAttestationPayloadV1,
> = Readonly<{
  payload: Payload;
  signature: string;
}>;

export type SignedAttestationPayloadCodecV1<
  Payload extends VersionedSignedAttestationPayloadV1,
> = Readonly<{
  payloadKeys: readonly string[];
  parsePayload(value: unknown): Payload;
  projectPayloadFields(payload: Payload): Readonly<Record<string, unknown>>;
  validateSignature(signature: string): void;
}>;

export type SignedAttestationVerificationReceiptV1<
  SignatureNamespace extends string,
> = Readonly<{
  schemaVersion: 1;
  readerContractVersion: typeof SIGNED_ATTESTATION_ENVELOPE_READER_CONTRACT_VERSION_V1;
  payloadVersion: 1;
  signatureNamespace: SignatureNamespace;
  signer: string;
  signedPayloadDigest: string;
  signatureDigest: string;
}>;

export type VerifiedSignedAttestationV1<
  SignatureNamespace extends string = string,
> = Readonly<{
  kind: typeof VERIFIED_SIGNED_ATTESTATION_KIND_V1;
  receipt: SignedAttestationVerificationReceiptV1<SignatureNamespace>;
  receiptDigest: string;
}>;

export type ReadAndVerifySignedAttestationEnvelopeRequestV1<
  Payload extends VersionedSignedAttestationPayloadV1,
  SignatureNamespace extends string,
> = Readonly<{
  readerContractVersion: string;
  raw: string;
  codec: SignedAttestationPayloadCodecV1<Payload>;
  signatureNamespace: SignatureNamespace;
  allowedSignatureNamespaces: readonly string[];
  validatePayload(payload: Payload): void;
  signer(payload: Payload): string;
  verifier: GrantSignatureVerifierPortV1;
}>;

export type ReadAndVerifySignedAttestationEnvelopeResultV1<
  Payload extends VersionedSignedAttestationPayloadV1,
  SignatureNamespace extends string,
> = Readonly<{
  envelope: SignedAttestationEnvelopeV1<Payload>;
  verification: VerifiedSignedAttestationV1<SignatureNamespace>;
}>;

export type SignedAttestationEnvelopeReaderErrorCode =
  | 'SIGNED_ATTESTATION_READER_INPUT_INVALID'
  | 'SIGNED_ATTESTATION_READER_CONTRACT_UNSUPPORTED'
  | 'SIGNED_ATTESTATION_ENVELOPE_SHAPE_INVALID'
  | 'SIGNED_ATTESTATION_PAYLOAD_VERSION_UNSUPPORTED'
  | 'SIGNED_ATTESTATION_PAYLOAD_INVALID'
  | 'SIGNED_ATTESTATION_SIGNATURE_SHAPE_INVALID'
  | 'SIGNED_ATTESTATION_ENVELOPE_NON_CANONICAL'
  | 'SIGNED_ATTESTATION_SIGNATURE_NAMESPACE_UNSUPPORTED'
  | 'SIGNED_ATTESTATION_SIGNER_INVALID'
  | 'SIGNED_ATTESTATION_SIGNATURE_INVALID';

export class SignedAttestationEnvelopeReaderError extends Error {
  readonly code: SignedAttestationEnvelopeReaderErrorCode;

  constructor(
    code: SignedAttestationEnvelopeReaderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SignedAttestationEnvelopeReaderError';
    this.code = code;
  }
}

/**
 * Construct canonical V1 signed payload bytes while the caller retains every
 * domain field, semantic, and policy decision.
 */
export function canonicalSignedAttestationPayloadBytesV1<
  Payload extends VersionedSignedAttestationPayloadV1,
>(input: Payload, codec: SignedAttestationPayloadCodecV1<Payload>): string {
  const baseKeys = assertCodec(codec);
  const payload = parseDomainPayload(input, codec);
  const projected = codec.projectPayloadFields(payload);
  if (!isPlainRecord(projected) || !hasExactKeys(projected, baseKeys)) {
    throw readerError(
      'SIGNED_ATTESTATION_PAYLOAD_INVALID',
      'Signed attestation canonical payload projection is invalid.',
    );
  }
  const fields = Object.fromEntries(
    baseKeys.map((key) => [key, projected[key]]),
  );
  return `${JSON.stringify({ version: 1, ...fields })}\n`;
}

export function canonicalSignedAttestationEnvelopeBytesV1<
  Payload extends VersionedSignedAttestationPayloadV1,
>(
  envelope: SignedAttestationEnvelopeV1<Payload>,
  codec: SignedAttestationPayloadCodecV1<Payload>,
): string {
  if (
    !isPlainRecord(envelope) ||
    !hasExactKeys(envelope, ['payload', 'signature']) ||
    typeof envelope.signature !== 'string'
  ) {
    throw readerError(
      'SIGNED_ATTESTATION_ENVELOPE_SHAPE_INVALID',
      'Signed attestation envelope shape is invalid.',
    );
  }
  const payload = JSON.parse(
    canonicalSignedAttestationPayloadBytesV1(envelope.payload, codec),
  ) as unknown;
  return `${JSON.stringify({ payload, signature: envelope.signature })}\n`;
}

/** Parse one exact canonical V1 envelope without selecting another version. */
export function parseSignedAttestationEnvelopeV1<
  Payload extends VersionedSignedAttestationPayloadV1,
>(
  raw: string,
  codec: SignedAttestationPayloadCodecV1<Payload>,
): SignedAttestationEnvelopeV1<Payload> {
  const baseKeys = assertCodec(codec);
  if (typeof raw !== 'string' || raw.length > MAX_ENVELOPE_BYTES) {
    throw readerError(
      'SIGNED_ATTESTATION_READER_INPUT_INVALID',
      'Signed attestation envelope input is invalid.',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw readerError(
      'SIGNED_ATTESTATION_ENVELOPE_SHAPE_INVALID',
      'Signed attestation envelope is not valid JSON.',
      cause,
    );
  }
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['payload', 'signature']) ||
    !isPlainRecord(value.payload) ||
    typeof value.signature !== 'string'
  ) {
    throw readerError(
      'SIGNED_ATTESTATION_ENVELOPE_SHAPE_INVALID',
      'Signed attestation envelope shape is invalid.',
    );
  }
  if (value.payload.version !== 1) {
    throw readerError(
      'SIGNED_ATTESTATION_PAYLOAD_VERSION_UNSUPPORTED',
      'Signed attestation payload version is unsupported.',
    );
  }
  if (!hasExactKeys(value.payload, ['version', ...baseKeys])) {
    throw readerError(
      'SIGNED_ATTESTATION_ENVELOPE_SHAPE_INVALID',
      'Signed attestation payload keys are invalid.',
    );
  }
  const payload = parseDomainPayload(value.payload, codec);
  try {
    codec.validateSignature(value.signature);
  } catch (cause) {
    throw readerError(
      'SIGNED_ATTESTATION_SIGNATURE_SHAPE_INVALID',
      'Signed attestation signature shape is invalid.',
      cause,
    );
  }
  const envelope = { payload, signature: value.signature };
  if (canonicalSignedAttestationEnvelopeBytesV1(envelope, codec) !== raw) {
    throw readerError(
      'SIGNED_ATTESTATION_ENVELOPE_NON_CANONICAL',
      'Signed attestation envelope bytes are not canonical.',
    );
  }
  return deepFreeze(envelope);
}

/**
 * Parse, run caller-owned domain/policy validation, then invoke one exact
 * verifier namespace and return a typed receipt. There is no namespace retry.
 */
export function readAndVerifySignedAttestationEnvelopeV1<
  Payload extends VersionedSignedAttestationPayloadV1,
  SignatureNamespace extends string,
>(
  request: ReadAndVerifySignedAttestationEnvelopeRequestV1<
    Payload,
    SignatureNamespace
  >,
): ReadAndVerifySignedAttestationEnvelopeResultV1<Payload, SignatureNamespace> {
  if (
    !isPlainRecord(request) ||
    typeof request.validatePayload !== 'function' ||
    typeof request.signer !== 'function' ||
    !isNonEmptyString(request.signatureNamespace) ||
    !isStringSet(request.allowedSignatureNamespaces) ||
    typeof request.verifier?.verify !== 'function'
  ) {
    throw readerError(
      'SIGNED_ATTESTATION_READER_INPUT_INVALID',
      'Signed attestation reader request is invalid.',
    );
  }
  if (
    request.readerContractVersion !==
    SIGNED_ATTESTATION_ENVELOPE_READER_CONTRACT_VERSION_V1
  ) {
    throw readerError(
      'SIGNED_ATTESTATION_READER_CONTRACT_UNSUPPORTED',
      'Signed attestation reader contract version is unsupported.',
    );
  }
  if (
    !request.allowedSignatureNamespaces.includes(request.signatureNamespace)
  ) {
    throw readerError(
      'SIGNED_ATTESTATION_SIGNATURE_NAMESPACE_UNSUPPORTED',
      'Signed attestation signature namespace is unsupported.',
    );
  }

  const envelope = parseSignedAttestationEnvelopeV1(request.raw, request.codec);
  request.validatePayload(envelope.payload);
  const signer = request.signer(envelope.payload);
  if (!isNonEmptyString(signer)) {
    throw readerError(
      'SIGNED_ATTESTATION_SIGNER_INVALID',
      'Signed attestation signer is invalid.',
    );
  }
  const canonicalPayload = canonicalSignedAttestationPayloadBytesV1(
    envelope.payload,
    request.codec,
  );
  try {
    request.verifier.verify(
      canonicalPayload,
      envelope.signature,
      signer,
      request.signatureNamespace,
    );
  } catch (cause) {
    throw readerError(
      'SIGNED_ATTESTATION_SIGNATURE_INVALID',
      'Signed attestation signature is invalid.',
      cause,
    );
  }

  const receipt = Object.freeze({
    schemaVersion: 1 as const,
    readerContractVersion:
      SIGNED_ATTESTATION_ENVELOPE_READER_CONTRACT_VERSION_V1,
    payloadVersion: 1 as const,
    signatureNamespace: request.signatureNamespace,
    signer,
    signedPayloadDigest: sha256(canonicalPayload),
    signatureDigest: sha256(envelope.signature),
  });
  const verification = Object.freeze({
    kind: VERIFIED_SIGNED_ATTESTATION_KIND_V1,
    receipt,
    receiptDigest: sha256(`${JSON.stringify(receipt)}\n`),
  });
  return Object.freeze({ envelope, verification });
}

function assertCodec<Payload extends VersionedSignedAttestationPayloadV1>(
  codec: SignedAttestationPayloadCodecV1<Payload>,
): readonly string[] {
  if (
    !isPlainRecord(codec) ||
    !isUniqueStringArray(codec.payloadKeys) ||
    codec.payloadKeys[0] !== 'version' ||
    codec.payloadKeys.length < 2 ||
    typeof codec.parsePayload !== 'function' ||
    typeof codec.projectPayloadFields !== 'function' ||
    typeof codec.validateSignature !== 'function'
  ) {
    throw readerError(
      'SIGNED_ATTESTATION_READER_INPUT_INVALID',
      'Signed attestation payload codec is invalid.',
    );
  }
  return Object.freeze(codec.payloadKeys.slice(1));
}

function parseDomainPayload<
  Payload extends VersionedSignedAttestationPayloadV1,
>(value: unknown, codec: SignedAttestationPayloadCodecV1<Payload>): Payload {
  let payload: Payload;
  try {
    payload = codec.parsePayload(value);
  } catch (cause) {
    throw readerError(
      'SIGNED_ATTESTATION_PAYLOAD_INVALID',
      'Signed attestation domain payload is invalid.',
      cause,
    );
  }
  if (payload?.version !== 1) {
    throw readerError(
      'SIGNED_ATTESTATION_PAYLOAD_VERSION_UNSUPPORTED',
      'Signed attestation payload version is unsupported.',
    );
  }
  return payload;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
}

function isUniqueStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isNonEmptyString) &&
    new Set(value).size === value.length
  );
}

function isStringSet(value: unknown): value is readonly string[] {
  return isUniqueStringArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readerError(
  code: SignedAttestationEnvelopeReaderErrorCode,
  message: string,
  cause?: unknown,
): SignedAttestationEnvelopeReaderError {
  return new SignedAttestationEnvelopeReaderError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}
