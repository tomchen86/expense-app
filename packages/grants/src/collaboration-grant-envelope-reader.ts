import {
  GRANT_ENVELOPE_VERIFIER_CONTRACT_VERSION_V1,
  verifyGrantEnvelopeV1,
  type GrantSignatureVerifierPortV1,
  type VerifiedGrantCapabilityV1,
} from './grant-envelope-verifier.ts';

export const COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1 =
  'jigwright.collaboration-grant-envelope-reader.v1' as const;
export const COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE =
  'expense-app.workflow.collaboration-grant.v1' as const;
export const COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE =
  'workflow.collaboration-grant.v2' as const;

const MAX_ENVELOPE_BYTES = 32_768;

export type VersionedCollaborationGrantPayload =
  | Readonly<{ version: 1 }>
  | Readonly<{
      version: 2;
      signatureNamespace: typeof COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE;
    }>;

export type CollaborationGrantEnvelopeV1<
  Payload extends VersionedCollaborationGrantPayload,
> = Readonly<{
  payload: Payload;
  signature: string;
}>;

export type CollaborationGrantPayloadCodecV1<
  Payload extends VersionedCollaborationGrantPayload,
> = Readonly<{
  v1PayloadKeys: readonly string[];
  v2PayloadKeys: readonly string[];
  parsePayload(value: unknown): Payload;
  projectPayloadFields(payload: Payload): Readonly<Record<string, unknown>>;
  validateSignature(signature: string): void;
}>;

export type CollaborationGrantEnvelopeReaderErrorCode =
  | 'GRANT_ENVELOPE_READER_INPUT_INVALID'
  | 'GRANT_ENVELOPE_READER_CONTRACT_UNSUPPORTED'
  | 'GRANT_ENVELOPE_SHAPE_INVALID'
  | 'GRANT_PAYLOAD_VERSION_UNSUPPORTED'
  | 'GRANT_SIGNATURE_NAMESPACE_INVALID'
  | 'GRANT_PAYLOAD_INVALID'
  | 'GRANT_SIGNATURE_SHAPE_INVALID'
  | 'GRANT_ENVELOPE_NON_CANONICAL';

export class CollaborationGrantEnvelopeReaderError extends Error {
  readonly code: CollaborationGrantEnvelopeReaderErrorCode;

  constructor(
    code: CollaborationGrantEnvelopeReaderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CollaborationGrantEnvelopeReaderError';
    this.code = code;
  }
}

export type ReadAndVerifyCollaborationGrantEnvelopeRequestV1<
  Payload extends VersionedCollaborationGrantPayload,
  AuthorizedEffect extends string,
> = Readonly<{
  readerContractVersion: string;
  raw: string;
  codec: CollaborationGrantPayloadCodecV1<Payload>;
  validatePayload(payload: Payload): void;
  authorizedEffect(payload: Payload): AuthorizedEffect;
  signer(payload: Payload): string;
  allowedAuthorizedEffects: readonly string[];
  verifier: GrantSignatureVerifierPortV1;
}>;

export type ReadAndVerifyCollaborationGrantEnvelopeResultV1<
  Payload extends VersionedCollaborationGrantPayload,
  AuthorizedEffect extends string,
> = Readonly<{
  envelope: CollaborationGrantEnvelopeV1<Payload>;
  verification: VerifiedGrantCapabilityV1<
    AuthorizedEffect,
    | typeof COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE
    | typeof COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE
  >;
}>;

/**
 * Construct the exact historical Collaboration Grant signed bytes while the
 * domain codec retains ownership of payload semantics and nested projections.
 */
export function canonicalCollaborationGrantPayloadBytesV1<
  Payload extends VersionedCollaborationGrantPayload,
>(input: Payload, codec: CollaborationGrantPayloadCodecV1<Payload>): string {
  const keys = assertCodec(codec);
  const payload = parseDomainPayload(input, codec);
  selectCollaborationGrantSignatureNamespaceV1(payload);
  const projected = codec.projectPayloadFields(payload);
  if (!isPlainRecord(projected) || !hasExactKeys(projected, keys.baseKeys)) {
    throw readerError(
      'GRANT_PAYLOAD_INVALID',
      'Collaboration Grant canonical payload projection is invalid.',
    );
  }
  const fields = Object.fromEntries(
    keys.baseKeys.map((key) => [key, projected[key]]),
  );
  return payload.version === 1
    ? `${JSON.stringify({ version: 1, ...fields })}\n`
    : `${JSON.stringify({
        version: 2,
        signatureNamespace: COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
        ...fields,
      })}\n`;
}

export function canonicalCollaborationGrantEnvelopeBytesV1<
  Payload extends VersionedCollaborationGrantPayload,
>(
  envelope: CollaborationGrantEnvelopeV1<Payload>,
  codec: CollaborationGrantPayloadCodecV1<Payload>,
): string {
  if (!isPlainRecord(envelope) || typeof envelope.signature !== 'string') {
    throw readerError(
      'GRANT_ENVELOPE_SHAPE_INVALID',
      'Collaboration Grant envelope shape is invalid.',
    );
  }
  const payload = JSON.parse(
    canonicalCollaborationGrantPayloadBytesV1(envelope.payload, codec),
  ) as unknown;
  return `${JSON.stringify({ payload, signature: envelope.signature })}\n`;
}

/**
 * Parse exact canonical envelope bytes. Version dispatch and namespace
 * selection happen before the domain parser, so unknown schemas cannot fall
 * through to a historical signature namespace.
 */
export function parseCollaborationGrantEnvelopeV1<
  Payload extends VersionedCollaborationGrantPayload,
>(
  raw: string,
  codec: CollaborationGrantPayloadCodecV1<Payload>,
): CollaborationGrantEnvelopeV1<Payload> {
  const keys = assertCodec(codec);
  if (typeof raw !== 'string' || raw.length > MAX_ENVELOPE_BYTES) {
    throw readerError(
      'GRANT_ENVELOPE_READER_INPUT_INVALID',
      'Collaboration Grant envelope input is invalid.',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw readerError(
      'GRANT_ENVELOPE_SHAPE_INVALID',
      'Collaboration Grant envelope is not valid JSON.',
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
      'GRANT_ENVELOPE_SHAPE_INVALID',
      'Collaboration Grant envelope shape is invalid.',
    );
  }
  assertVersionedPayloadShape(value.payload, keys);
  const payload = parseDomainPayload(value.payload, codec);
  try {
    codec.validateSignature(value.signature);
  } catch (cause) {
    throw readerError(
      'GRANT_SIGNATURE_SHAPE_INVALID',
      'Collaboration Grant signature shape is invalid.',
      cause,
    );
  }
  const envelope = { payload, signature: value.signature };
  if (canonicalCollaborationGrantEnvelopeBytesV1(envelope, codec) !== raw) {
    throw readerError(
      'GRANT_ENVELOPE_NON_CANONICAL',
      'Collaboration Grant envelope bytes are not canonical.',
    );
  }
  return deepFreeze(envelope);
}

export function selectCollaborationGrantSignatureNamespaceV1(
  payload: VersionedCollaborationGrantPayload,
):
  | typeof COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE
  | typeof COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE {
  if (
    payload?.version === 1 &&
    !Object.prototype.hasOwnProperty.call(payload, 'signatureNamespace')
  ) {
    return COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE;
  }
  if (
    payload?.version === 2 &&
    payload.signatureNamespace === COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE
  ) {
    return COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE;
  }
  if (payload?.version !== 1 && payload?.version !== 2) {
    throw readerError(
      'GRANT_PAYLOAD_VERSION_UNSUPPORTED',
      'Collaboration Grant payload version is unsupported.',
    );
  }
  throw readerError(
    'GRANT_SIGNATURE_NAMESPACE_INVALID',
    'Collaboration Grant signature namespace is invalid.',
  );
}

/**
 * Parse, run domain-owned semantic validation, and invoke exactly the verifier
 * selected by the signed payload version. No namespace retry or fallback is
 * attempted.
 */
export function readAndVerifyCollaborationGrantEnvelopeV1<
  Payload extends VersionedCollaborationGrantPayload,
  AuthorizedEffect extends string,
>(
  request: ReadAndVerifyCollaborationGrantEnvelopeRequestV1<
    Payload,
    AuthorizedEffect
  >,
): ReadAndVerifyCollaborationGrantEnvelopeResultV1<Payload, AuthorizedEffect> {
  if (
    !isPlainRecord(request) ||
    typeof request.validatePayload !== 'function' ||
    typeof request.authorizedEffect !== 'function' ||
    typeof request.signer !== 'function' ||
    !Array.isArray(request.allowedAuthorizedEffects) ||
    typeof request.verifier?.verify !== 'function'
  ) {
    throw readerError(
      'GRANT_ENVELOPE_READER_INPUT_INVALID',
      'Collaboration Grant reader request is invalid.',
    );
  }
  if (
    request.readerContractVersion !==
    COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1
  ) {
    throw readerError(
      'GRANT_ENVELOPE_READER_CONTRACT_UNSUPPORTED',
      'Collaboration Grant reader contract version is unsupported.',
    );
  }
  const envelope = parseCollaborationGrantEnvelopeV1(
    request.raw,
    request.codec,
  );
  request.validatePayload(envelope.payload);
  const signatureNamespace = selectCollaborationGrantSignatureNamespaceV1(
    envelope.payload,
  );
  const verification = verifyGrantEnvelopeV1({
    contractVersion: GRANT_ENVELOPE_VERIFIER_CONTRACT_VERSION_V1,
    canonicalPayload: canonicalCollaborationGrantPayloadBytesV1(
      envelope.payload,
      request.codec,
    ),
    signature: envelope.signature,
    signer: request.signer(envelope.payload),
    signatureNamespace,
    authorizedEffect: request.authorizedEffect(envelope.payload),
    allowedSignatureNamespaces: [
      COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE,
      COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
    ],
    allowedAuthorizedEffects: request.allowedAuthorizedEffects,
    verifier: request.verifier,
  });
  return Object.freeze({ envelope, verification });
}

function assertCodec<Payload extends VersionedCollaborationGrantPayload>(
  codec: CollaborationGrantPayloadCodecV1<Payload>,
): Readonly<{ baseKeys: readonly string[] }> {
  if (
    !isPlainRecord(codec) ||
    !isUniqueStringArray(codec.v1PayloadKeys) ||
    !isUniqueStringArray(codec.v2PayloadKeys) ||
    typeof codec.parsePayload !== 'function' ||
    typeof codec.projectPayloadFields !== 'function' ||
    typeof codec.validateSignature !== 'function' ||
    codec.v1PayloadKeys[0] !== 'version' ||
    codec.v1PayloadKeys.includes('signatureNamespace') ||
    codec.v2PayloadKeys[0] !== 'version' ||
    codec.v2PayloadKeys[1] !== 'signatureNamespace'
  ) {
    throw readerError(
      'GRANT_ENVELOPE_READER_INPUT_INVALID',
      'Collaboration Grant payload codec is invalid.',
    );
  }
  const v1Base = codec.v1PayloadKeys.slice(1);
  const v2Base = codec.v2PayloadKeys.slice(2);
  if (
    v1Base.length === 0 ||
    v1Base.length !== v2Base.length ||
    v1Base.some((key, index) => key !== v2Base[index])
  ) {
    throw readerError(
      'GRANT_ENVELOPE_READER_INPUT_INVALID',
      'Collaboration Grant payload codec versions do not share one exact field order.',
    );
  }
  return Object.freeze({ baseKeys: Object.freeze(v1Base) });
}

function assertVersionedPayloadShape(
  value: Readonly<Record<string, unknown>>,
  keys: Readonly<{ baseKeys: readonly string[] }>,
): void {
  if (value.version === 1) {
    if (!hasExactKeys(value, ['version', ...keys.baseKeys])) {
      throw readerError(
        'GRANT_ENVELOPE_SHAPE_INVALID',
        'Historical Collaboration Grant payload keys are invalid.',
      );
    }
    return;
  }
  if (value.version === 2) {
    if (
      value.signatureNamespace !== COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE
    ) {
      throw readerError(
        'GRANT_SIGNATURE_NAMESPACE_INVALID',
        'Current Collaboration Grant signature namespace is invalid.',
      );
    }
    if (
      !hasExactKeys(value, ['version', 'signatureNamespace', ...keys.baseKeys])
    ) {
      throw readerError(
        'GRANT_ENVELOPE_SHAPE_INVALID',
        'Current Collaboration Grant payload keys are invalid.',
      );
    }
    return;
  }
  throw readerError(
    'GRANT_PAYLOAD_VERSION_UNSUPPORTED',
    'Collaboration Grant payload version is unsupported.',
  );
}

function parseDomainPayload<Payload extends VersionedCollaborationGrantPayload>(
  value: unknown,
  codec: CollaborationGrantPayloadCodecV1<Payload>,
): Payload {
  let payload: Payload;
  try {
    payload = codec.parsePayload(value);
  } catch (cause) {
    throw readerError(
      'GRANT_PAYLOAD_INVALID',
      'Collaboration Grant domain payload is invalid.',
      cause,
    );
  }
  selectCollaborationGrantSignatureNamespaceV1(payload);
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
    value.every((entry) => typeof entry === 'string' && entry.length > 0) &&
    new Set(value).size === value.length
  );
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

function readerError(
  code: CollaborationGrantEnvelopeReaderErrorCode,
  message: string,
  cause?: unknown,
): CollaborationGrantEnvelopeReaderError {
  return new CollaborationGrantEnvelopeReaderError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}
