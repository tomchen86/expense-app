import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import { verifySshDataSignature } from './ci-signature.ts';
import { isRecord } from './contract-values.ts';
import { ExitCode, workflowError } from './errors.ts';
import { runGit } from './git.ts';
import { createMaintainerAuditTag } from './maintainer-grant.ts';
import type { MaintainerPolicy } from './maintainer-policy.ts';
import type { MaintainerSignerProvider } from './maintainer-signer.ts';

export const AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE =
  'expense-app.workflow.authority-application-receipt.v1';

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const PREFIXED_DIGEST = /^sha256:[0-9a-f]{64}$/;
const GRANT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGET_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const TAG_REF = /^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const RECEIPT_KEYS = [
  'schemaVersion',
  'kind',
  'grantId',
  'repositoryId',
  'repositoryOrigin',
  'changeId',
  'signer',
  'grantTagRef',
  'grantEnvelopeDigest',
  'candidateBundleDigest',
  'effectsManifestDigest',
  'candidatePatchDigest',
  'candidateCommit',
  'candidateTree',
  'targetRef',
  'oldRefOid',
  'oldRefGeneration',
  'newRefOid',
  'newRefGeneration',
  'casAt',
  'casAuditReceiptDigest',
  'auditRepositoryId',
  'poststateVerifiedAt',
  'poststateAuditReceiptDigest',
  'terminalGrantState',
  'terminalReservationId',
  'terminalCommit',
  'terminalConsumedAt',
  'grantConsumeAuditReceiptDigest',
  'issuedAt',
] as const;

export type AuthorityApplicationReceiptPayload = {
  schemaVersion: 1;
  kind: 'authority-application-receipt.v1';
  grantId: string;
  repositoryId: string;
  repositoryOrigin: string;
  changeId: string;
  signer: string;
  grantTagRef: string;
  grantEnvelopeDigest: `sha256:${string}`;
  candidateBundleDigest: string;
  effectsManifestDigest: string;
  candidatePatchDigest: string;
  candidateCommit: string;
  candidateTree: string;
  targetRef: string;
  oldRefOid: string;
  oldRefGeneration: number;
  newRefOid: string;
  newRefGeneration: number;
  casAt: string;
  casAuditReceiptDigest: `sha256:${string}`;
  auditRepositoryId: `sha256:${string}`;
  poststateVerifiedAt: string;
  poststateAuditReceiptDigest: `sha256:${string}`;
  terminalGrantState: 'consumed';
  terminalReservationId: string;
  terminalCommit: string;
  terminalConsumedAt: string;
  grantConsumeAuditReceiptDigest: `sha256:${string}`;
  issuedAt: string;
};

export type AuthorityApplicationReceiptEnvelope = {
  payload: AuthorityApplicationReceiptPayload;
  signature: string;
};

export type AuthorityApplicationReceiptTag = {
  ref: string;
  target: string;
  tagObject: string;
  envelope: AuthorityApplicationReceiptEnvelope;
};

export function authorityApplicationReceiptTagPrefix(
  policy: MaintainerPolicy,
): string {
  return `${policy.auditTagPrefix}application-`;
}

export function authorityApplicationReceiptTagRef(
  policy: MaintainerPolicy,
  grantId: string,
): string {
  if (!GRANT_ID.test(grantId)) throw receiptInvalid();
  return `${authorityApplicationReceiptTagPrefix(policy)}${grantId}`;
}

export function canonicalAuthorityApplicationReceiptPayload(
  payload: AuthorityApplicationReceiptPayload,
): string {
  validateAuthorityApplicationReceiptPayload(payload);
  return `${canonicalJson(payload)}\n`;
}

export function canonicalAuthorityApplicationReceiptEnvelope(
  envelope: AuthorityApplicationReceiptEnvelope,
): string {
  const payload = JSON.parse(
    canonicalAuthorityApplicationReceiptPayload(envelope.payload),
  ) as AuthorityApplicationReceiptPayload;
  assertArmoredSignature(envelope.signature);
  return `${canonicalJson({ payload, signature: envelope.signature })}\n`;
}

export function createAuthorityApplicationReceiptPayload(
  input: Omit<AuthorityApplicationReceiptPayload, 'schemaVersion' | 'kind'>,
): AuthorityApplicationReceiptPayload {
  const payload: AuthorityApplicationReceiptPayload = {
    schemaVersion: 1,
    kind: 'authority-application-receipt.v1',
    ...input,
  };
  validateAuthorityApplicationReceiptPayload(payload);
  return payload;
}

export function parseAuthorityApplicationReceiptEnvelope(
  raw: string,
): AuthorityApplicationReceiptEnvelope {
  try {
    if (
      typeof raw !== 'string' ||
      raw.length < 3 ||
      raw.length > 1_048_576 ||
      !raw.endsWith('\n')
    ) {
      throw new Error('invalid receipt bytes');
    }
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['payload', 'signature']) ||
      !isRecord(value.payload) ||
      !hasExactKeys(value.payload, RECEIPT_KEYS) ||
      typeof value.signature !== 'string'
    ) {
      throw new Error('invalid receipt envelope');
    }
    const payload = value.payload as AuthorityApplicationReceiptPayload;
    validateAuthorityApplicationReceiptPayload(payload);
    const envelope = { payload, signature: value.signature };
    if (canonicalAuthorityApplicationReceiptEnvelope(envelope) !== raw) {
      throw new Error('noncanonical receipt');
    }
    return envelope;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'AUTHORITY_APPLICATION_RECEIPT_INVALID'
    ) {
      throw error;
    }
    throw receiptInvalid();
  }
}

export function authorityApplicationReceiptEnvelopeDigest(
  envelope: AuthorityApplicationReceiptEnvelope,
): `sha256:${string}` {
  return sha256(canonicalAuthorityApplicationReceiptEnvelope(envelope));
}

export function signedGrantEnvelopeDigest(
  canonicalEnvelope: string,
): `sha256:${string}` {
  if (
    typeof canonicalEnvelope !== 'string' ||
    canonicalEnvelope.length === 0 ||
    canonicalEnvelope.length > 1_048_576 ||
    !canonicalEnvelope.endsWith('\n')
  ) {
    throw receiptInvalid();
  }
  return sha256(canonicalEnvelope);
}

export function verifyAuthorityApplicationReceiptSignature(
  envelope: AuthorityApplicationReceiptEnvelope,
  policy: MaintainerPolicy,
  errorCode = 'AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_INVALID',
): void {
  const signer = policy.trustedSigners.find(
    ({ identity }) => identity === envelope.payload.signer,
  );
  if (signer === undefined) {
    throw workflowError(
      errorCode,
      'Authority application receipt signer is not trusted by its pinned policy.',
      ExitCode.verification,
    );
  }
  verifySshDataSignature(
    canonicalAuthorityApplicationReceiptPayload(envelope.payload),
    envelope.signature,
    signer,
    AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
    errorCode,
  );
}

export function listAuthorityApplicationReceiptTagRefs(
  repositoryRoot: string,
  policy: MaintainerPolicy,
): string[] {
  return runGit(repositoryRoot, [
    'for-each-ref',
    '--format=%(refname)',
    `${authorityApplicationReceiptTagPrefix(policy)}*`,
  ])
    .split('\n')
    .filter(Boolean)
    .sort();
}

export function readAuthorityApplicationReceiptTag(
  repositoryRoot: string,
  ref: string,
): AuthorityApplicationReceiptTag {
  if (!TAG_REF.test(ref)) throw receiptInvalid();
  try {
    const raw = runGit(repositoryRoot, ['cat-file', 'tag', ref]);
    const separator = raw.indexOf('\n\n');
    if (separator === -1) throw new Error('tag body missing');
    const headers = raw.slice(0, separator).split('\n');
    const objectHeaders = headers.filter((line) => line.startsWith('object '));
    const typeHeaders = headers.filter((line) => line.startsWith('type '));
    const tagHeaders = headers.filter((line) => line.startsWith('tag '));
    const target = objectHeaders[0]?.slice('object '.length) ?? '';
    if (
      objectHeaders.length !== 1 ||
      !OBJECT_ID.test(target) ||
      typeHeaders.length !== 1 ||
      typeHeaders[0] !== 'type commit' ||
      tagHeaders.length !== 1 ||
      tagHeaders[0] !== `tag ${ref.slice('refs/tags/'.length)}`
    ) {
      throw new Error('tag headers differ');
    }
    return {
      ref,
      target,
      tagObject: runGit(repositoryRoot, [
        'rev-parse',
        '--verify',
        `${ref}^{tag}`,
      ]).trim(),
      envelope: parseAuthorityApplicationReceiptEnvelope(
        raw.slice(separator + 2),
      ),
    };
  } catch {
    throw receiptInvalid();
  }
}

export function publishAuthorityApplicationReceipt(
  repositoryRoot: string,
  policy: MaintainerPolicy,
  payload: AuthorityApplicationReceiptPayload,
  signer?: MaintainerSignerProvider,
): AuthorityApplicationReceiptTag {
  validateAuthorityApplicationReceiptPayload(payload);
  const ref = authorityApplicationReceiptTagRef(policy, payload.grantId);
  const existing = runGit(
    repositoryRoot,
    ['rev-parse', '--verify', ref],
    true,
  ).trim();
  if (existing) {
    const tag = readAuthorityApplicationReceiptTag(repositoryRoot, ref);
    if (
      tag.target !== payload.candidateCommit ||
      canonicalAuthorityApplicationReceiptPayload(tag.envelope.payload) !==
        canonicalAuthorityApplicationReceiptPayload(payload)
    ) {
      throw receiptConflict();
    }
    if (signer === undefined) {
      verifyAuthorityApplicationReceiptSignature(tag.envelope, policy);
    } else {
      signer.verify(
        canonicalAuthorityApplicationReceiptPayload(payload),
        tag.envelope.signature,
        payload.signer,
        AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
      );
    }
    return tag;
  }
  if (signer === undefined || signer.identity() !== payload.signer) {
    throw workflowError(
      'AUTHORITY_APPLICATION_RECEIPT_SIGNER_REQUIRED',
      'Publishing a new authority application receipt requires the exact grant signer.',
      ExitCode.unsafeEnvironment,
    );
  }
  const canonicalPayload = canonicalAuthorityApplicationReceiptPayload(payload);
  const signature = signer.sign(
    canonicalPayload,
    AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
  );
  signer.verify(
    canonicalPayload,
    signature,
    payload.signer,
    AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
  );
  const envelope = { payload, signature };
  createMaintainerAuditTag(
    repositoryRoot,
    payload.candidateCommit,
    ref,
    canonicalAuthorityApplicationReceiptEnvelope(envelope),
    payload.signer,
  );
  const published = readAuthorityApplicationReceiptTag(repositoryRoot, ref);
  if (
    published.target !== payload.candidateCommit ||
    canonicalAuthorityApplicationReceiptEnvelope(published.envelope) !==
      canonicalAuthorityApplicationReceiptEnvelope(envelope)
  ) {
    throw receiptConflict();
  }
  return published;
}

function validateAuthorityApplicationReceiptPayload(
  value: AuthorityApplicationReceiptPayload,
): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, RECEIPT_KEYS) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'authority-application-receipt.v1' ||
    !GRANT_ID.test(value.grantId) ||
    !validBoundedText(value.repositoryId, 512) ||
    !validBoundedText(value.repositoryOrigin, 2_048) ||
    !validBoundedText(value.changeId, 192) ||
    !validBoundedText(value.signer, 128) ||
    !TAG_REF.test(value.grantTagRef) ||
    !PREFIXED_DIGEST.test(value.grantEnvelopeDigest) ||
    !DIGEST.test(value.candidateBundleDigest) ||
    !DIGEST.test(value.effectsManifestDigest) ||
    !DIGEST.test(value.candidatePatchDigest) ||
    !OBJECT_ID.test(value.candidateCommit) ||
    !OBJECT_ID.test(value.candidateTree) ||
    !TARGET_REF.test(value.targetRef) ||
    !OBJECT_ID.test(value.oldRefOid) ||
    !Number.isSafeInteger(value.oldRefGeneration) ||
    value.oldRefGeneration < 0 ||
    !OBJECT_ID.test(value.newRefOid) ||
    !Number.isSafeInteger(value.newRefGeneration) ||
    value.newRefGeneration !== value.oldRefGeneration + 1 ||
    value.oldRefOid === value.newRefOid ||
    value.newRefOid !== value.candidateCommit ||
    !isTimestamp(value.casAt) ||
    !PREFIXED_DIGEST.test(value.casAuditReceiptDigest) ||
    !PREFIXED_DIGEST.test(value.auditRepositoryId) ||
    !isTimestamp(value.poststateVerifiedAt) ||
    !PREFIXED_DIGEST.test(value.poststateAuditReceiptDigest) ||
    value.terminalGrantState !== 'consumed' ||
    !validBoundedText(value.terminalReservationId, 256) ||
    value.terminalCommit !== value.candidateCommit ||
    !isTimestamp(value.terminalConsumedAt) ||
    !PREFIXED_DIGEST.test(value.grantConsumeAuditReceiptDigest) ||
    !isTimestamp(value.issuedAt) ||
    Date.parse(value.casAt) > Date.parse(value.poststateVerifiedAt) ||
    Date.parse(value.poststateVerifiedAt) >
      Date.parse(value.terminalConsumedAt) ||
    Date.parse(value.terminalConsumedAt) > Date.parse(value.issuedAt)
  ) {
    throw receiptInvalid();
  }
}

function assertArmoredSignature(signature: string): void {
  if (
    typeof signature !== 'string' ||
    signature.length > 16_384 ||
    signature.includes('\r') ||
    !/^-----BEGIN SSH SIGNATURE-----\n(?:[A-Za-z0-9+/=]+\n)+-----END SSH SIGNATURE-----\n$/.test(
      signature,
    )
  ) {
    throw receiptInvalid();
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function validBoundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    Buffer.byteLength(value, 'utf8') <= maxBytes &&
    ![...value].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 31 || (point >= 127 && point <= 159);
    })
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function receiptInvalid() {
  return workflowError(
    'AUTHORITY_APPLICATION_RECEIPT_INVALID',
    'Authority application receipt is malformed or noncanonical.',
    ExitCode.verification,
  );
}

function receiptConflict() {
  return workflowError(
    'AUTHORITY_APPLICATION_RECEIPT_CONFLICT',
    'The deterministic authority application receipt tag already has different content.',
    ExitCode.conflict,
  );
}
