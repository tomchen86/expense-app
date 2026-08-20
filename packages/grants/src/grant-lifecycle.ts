import crypto from 'node:crypto';

export const GRANT_LIFECYCLE_CONTRACT_VERSION_V1 =
  'jigwright.grant-lifecycle.v1' as const;
export const GRANT_LIFECYCLE_AUDIT_RECEIPT_KIND_V1 =
  'jigwright.grant-lifecycle-audit-receipt.v1' as const;

export type GrantLifecycleState =
  'available' | 'reserved' | 'consumed' | 'failed' | 'expired' | 'revoked';

export type GrantLifecycleEventV1 =
  | Readonly<{
      kind: 'reserve';
      expiresAt: string;
      reason: string;
      expirationReason?: string;
    }>
  | Readonly<{ kind: 'consume' | 'fail' | 'revoke'; reason: string }>;

export type GrantLifecycleAuditReceiptV1 = Readonly<{
  schemaVersion: 1;
  kind: typeof GRANT_LIFECYCLE_AUDIT_RECEIPT_KIND_V1;
  lifecycleContractVersion: typeof GRANT_LIFECYCLE_CONTRACT_VERSION_V1;
  grantId: string;
  transitionDigest: string | null;
  fromState: 'available' | 'reserved';
  toState: 'reserved' | 'consumed' | 'failed' | 'expired' | 'revoked';
  occurredAt: string;
  reason: string;
}>;

export type GrantLifecycleClockPortV1 = Readonly<{
  now(): Date;
}>;

export type GrantLifecycleStoragePortV1<Validation, Persisted> = Readonly<{
  readState(): GrantLifecycleState | null;
  applyTransition(
    input: Readonly<{
      receipt: GrantLifecycleAuditReceiptV1;
      receiptDigest: string;
      validation: Validation | undefined;
    }>,
  ): Persisted;
}>;

export type GrantLifecycleTransitionRequestV1<Validation> = Readonly<{
  contractVersion: string;
  grantId: string;
  transitionDigest: string | null;
  maxUses: number;
  event: GrantLifecycleEventV1;
  validate?(): Validation;
  validationFailureReason?: string;
}>;

export type GrantLifecycleTransitionResultV1<Persisted> = Readonly<{
  value: Persisted;
  receipt: GrantLifecycleAuditReceiptV1;
  receiptDigest: string;
}>;

export type GrantLifecycleTransitionErrorCode =
  | 'GRANT_LIFECYCLE_INPUT_INVALID'
  | 'GRANT_LIFECYCLE_CONTRACT_UNSUPPORTED'
  | 'GRANT_LIFECYCLE_MAX_USES_UNSUPPORTED'
  | 'GRANT_LIFECYCLE_STATE_INVALID'
  | 'GRANT_LIFECYCLE_EXPIRED';

export class GrantLifecycleTransitionError extends Error {
  readonly code: GrantLifecycleTransitionErrorCode;
  readonly receipt?: GrantLifecycleAuditReceiptV1;
  readonly receiptDigest?: string;

  constructor(
    code: GrantLifecycleTransitionErrorCode,
    message: string,
    options?: Readonly<{
      cause?: unknown;
      receipt?: GrantLifecycleAuditReceiptV1;
      receiptDigest?: string;
    }>,
  ) {
    super(
      message,
      options && Object.prototype.hasOwnProperty.call(options, 'cause')
        ? { cause: options.cause }
        : undefined,
    );
    this.name = 'GrantLifecycleTransitionError';
    this.code = code;
    this.receipt = options?.receipt;
    this.receiptDigest = options?.receiptDigest;
  }
}

/**
 * Execute one generic one-use grant transition. Domain adapters retain their
 * exact envelope readers, durable record schemas, byte serialization, locks,
 * and error mapping; this coordinator owns the reusable state ordering and
 * projects the typed audit meaning supplied to the storage port.
 */
export function executeGrantLifecycleTransitionV1<Validation, Persisted>(
  request: GrantLifecycleTransitionRequestV1<Validation>,
  ports: Readonly<{
    clock: GrantLifecycleClockPortV1;
    storage: GrantLifecycleStoragePortV1<Validation, Persisted>;
  }>,
): GrantLifecycleTransitionResultV1<Persisted> {
  assertRequest(request, ports);
  if (request.contractVersion !== GRANT_LIFECYCLE_CONTRACT_VERSION_V1) {
    throw lifecycleError(
      'GRANT_LIFECYCLE_CONTRACT_UNSUPPORTED',
      'Grant lifecycle contract version is unsupported.',
    );
  }
  if (request.maxUses !== 1) {
    throw lifecycleError(
      'GRANT_LIFECYCLE_MAX_USES_UNSUPPORTED',
      'Generic grant lifecycle transitions require maxUses=1.',
    );
  }

  const fromState = ports.storage.readState();
  assertPermittedState(fromState, request.event.kind);

  if (request.event.kind === 'reserve') {
    const occurredAt = readClock(ports.clock);
    const expiresAt = exactTimestamp(request.event.expiresAt);
    if (expiresAt.getTime() < occurredAt.getTime()) {
      const expiration = projectTransition(
        request,
        fromState,
        'expired',
        occurredAt,
        request.event.expirationReason ?? 'Grant expired before reservation',
      );
      ports.storage.applyTransition({
        ...expiration,
        validation: undefined,
      });
      throw lifecycleError(
        'GRANT_LIFECYCLE_EXPIRED',
        'Grant expired before reservation.',
        expiration,
      );
    }
    const validation = request.validate!();
    return applyTransition(
      ports.storage,
      projectTransition(
        request,
        fromState,
        'reserved',
        occurredAt,
        request.event.reason,
      ),
      validation,
    );
  }

  if (request.event.kind === 'consume') {
    let validation: Validation;
    try {
      validation = request.validate!();
    } catch (cause) {
      if (request.validationFailureReason !== undefined) {
        const failed = projectTransition(
          request,
          fromState,
          'failed',
          readClock(ports.clock),
          request.validationFailureReason,
        );
        ports.storage.applyTransition({ ...failed, validation: undefined });
      }
      throw cause;
    }
    return applyTransition(
      ports.storage,
      projectTransition(
        request,
        fromState,
        'consumed',
        readClock(ports.clock),
        request.event.reason,
      ),
      validation,
    );
  }

  return applyTransition(
    ports.storage,
    projectTransition(
      request,
      fromState,
      request.event.kind === 'fail' ? 'failed' : 'revoked',
      readClock(ports.clock),
      request.event.reason,
    ),
    undefined,
  );
}

function assertRequest<Validation, Persisted>(
  request: GrantLifecycleTransitionRequestV1<Validation>,
  ports: Readonly<{
    clock: GrantLifecycleClockPortV1;
    storage: GrantLifecycleStoragePortV1<Validation, Persisted>;
  }>,
): void {
  if (
    !isNonEmptyString(request?.contractVersion) ||
    !isNonEmptyString(request.grantId) ||
    (request.transitionDigest !== null &&
      !isNonEmptyString(request.transitionDigest)) ||
    !Number.isSafeInteger(request.maxUses) ||
    !isEvent(request.event) ||
    ((request.event?.kind === 'reserve' || request.event?.kind === 'consume') &&
      typeof request.validate !== 'function') ||
    (request.validationFailureReason !== undefined &&
      !isNonEmptyString(request.validationFailureReason)) ||
    typeof ports?.clock?.now !== 'function' ||
    typeof ports?.storage?.readState !== 'function' ||
    typeof ports.storage.applyTransition !== 'function'
  ) {
    throw lifecycleError(
      'GRANT_LIFECYCLE_INPUT_INVALID',
      'Grant lifecycle transition input is invalid.',
    );
  }
  if (request.event.kind !== 'revoke' && request.transitionDigest === null) {
    throw lifecycleError(
      'GRANT_LIFECYCLE_INPUT_INVALID',
      'This grant lifecycle transition requires an exact transition digest.',
    );
  }
}

function assertPermittedState(
  state: GrantLifecycleState | null,
  event: GrantLifecycleEventV1['kind'],
): asserts state is 'available' | 'reserved' {
  const permitted =
    event === 'reserve'
      ? state === 'available'
      : event === 'revoke'
        ? state === 'available' || state === 'reserved'
        : state === 'reserved';
  if (!permitted) {
    throw lifecycleError(
      'GRANT_LIFECYCLE_STATE_INVALID',
      'Grant lifecycle transition is unavailable from the current state.',
    );
  }
}

function projectTransition<Validation>(
  request: GrantLifecycleTransitionRequestV1<Validation>,
  fromState: 'available' | 'reserved',
  toState: GrantLifecycleAuditReceiptV1['toState'],
  occurredAt: Date,
  reason: string,
): Readonly<{
  receipt: GrantLifecycleAuditReceiptV1;
  receiptDigest: string;
}> {
  const receipt = Object.freeze({
    schemaVersion: 1 as const,
    kind: GRANT_LIFECYCLE_AUDIT_RECEIPT_KIND_V1,
    lifecycleContractVersion: GRANT_LIFECYCLE_CONTRACT_VERSION_V1,
    grantId: request.grantId,
    transitionDigest: request.transitionDigest,
    fromState,
    toState,
    occurredAt: occurredAt.toISOString(),
    reason,
  });
  return Object.freeze({
    receipt,
    receiptDigest: sha256(`${JSON.stringify(receipt)}\n`),
  });
}

function applyTransition<Validation, Persisted>(
  storage: GrantLifecycleStoragePortV1<Validation, Persisted>,
  transition: Readonly<{
    receipt: GrantLifecycleAuditReceiptV1;
    receiptDigest: string;
  }>,
  validation: Validation | undefined,
): GrantLifecycleTransitionResultV1<Persisted> {
  const value = storage.applyTransition({ ...transition, validation });
  return Object.freeze({ value, ...transition });
}

function readClock(clock: GrantLifecycleClockPortV1): Date {
  const value = clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw lifecycleError(
      'GRANT_LIFECYCLE_INPUT_INVALID',
      'Grant lifecycle clock returned an invalid timestamp.',
    );
  }
  return new Date(value.getTime());
}

function exactTimestamp(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw lifecycleError(
      'GRANT_LIFECYCLE_INPUT_INVALID',
      'Grant lifecycle expiration timestamp is invalid.',
    );
  }
  return parsed;
}

function isEvent(value: unknown): value is GrantLifecycleEventV1 {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (!isNonEmptyString(candidate.reason)) return false;
  if (candidate.kind === 'reserve') {
    return (
      isNonEmptyString(candidate.expiresAt) &&
      (candidate.expirationReason === undefined ||
        isNonEmptyString(candidate.expirationReason))
    );
  }
  return ['consume', 'fail', 'revoke'].includes(String(candidate.kind));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function lifecycleError(
  code: GrantLifecycleTransitionErrorCode,
  message: string,
  transition?: Readonly<{
    receipt: GrantLifecycleAuditReceiptV1;
    receiptDigest: string;
  }>,
): GrantLifecycleTransitionError {
  return new GrantLifecycleTransitionError(code, message, transition);
}
