import { ExitCode, workflowError } from './errors.ts';
import {
  ManagedTrailerSyntaxError,
  parseManagedTrailers,
  type AuthorityManagedTrailers,
  type ManagedTrailers,
} from './managed-trailers.ts';

const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GRANT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REPOSITORY_ID = /^github:[A-Za-z0-9_-]+$/;
const REPOSITORY_ORIGIN =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/;
const PROTECTED_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SIGNER_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
const ARMORED_SSH_SIGNATURE =
  /^-----BEGIN SSH SIGNATURE-----\n(?:[A-Za-z0-9+/=]+\n)+-----END SSH SIGNATURE-----\n$/;

const MAX_ENVELOPE_LENGTH = 32_768;
const MAX_SIGNATURE_LENGTH = 16_384;
const MAX_GRANT_BASES = 64;
const MAX_GRANT_IDS_PER_BASE = 64;

const ENVELOPE_KEYS = ['payload', 'signature'];
const PAYLOAD_KEYS = [
  'version',
  'grantId',
  'repositoryId',
  'repositoryOrigin',
  'protectedBranch',
  'originalCommit',
  'mainCommit',
  'grantBases',
  'policyBlob',
  'issuedAt',
  'signer',
];
const GRANT_BASE_KEYS = ['originalBase', 'mainBase', 'grantIds'];

export const AUTHORITY_ATTESTATION_TAG_PREFIX =
  'refs/tags/workflow-attestation/';

export type AttestationGrantBaseMapping = {
  originalBase: string;
  mainBase: string;
  grantIds: string[];
};

export type AuthorityAttestationPayload = {
  version: 1;
  grantId: string;
  repositoryId: string;
  repositoryOrigin: string;
  protectedBranch: string;
  originalCommit: string;
  mainCommit: string;
  grantBases: AttestationGrantBaseMapping[];
  policyBlob: string;
  issuedAt: string;
  signer: string;
};

export type AuthorityAttestationEnvelope = {
  payload: AuthorityAttestationPayload;
  signature: string;
};

export type AttestedCommitFacts = {
  oid: string;
  tree: string;
  parentOids: string[];
  parentTree: string | undefined;
  message: string;
};

export function canonicalAttestationPayload(
  payload: AuthorityAttestationPayload,
): string {
  return `${JSON.stringify({
    version: payload.version,
    grantId: payload.grantId,
    repositoryId: payload.repositoryId,
    repositoryOrigin: payload.repositoryOrigin,
    protectedBranch: payload.protectedBranch,
    originalCommit: payload.originalCommit,
    mainCommit: payload.mainCommit,
    grantBases: payload.grantBases.map((mapping) => ({
      originalBase: mapping.originalBase,
      mainBase: mapping.mainBase,
      grantIds: [...mapping.grantIds],
    })),
    policyBlob: payload.policyBlob,
    issuedAt: payload.issuedAt,
    signer: payload.signer,
  })}\n`;
}

export function canonicalAttestationEnvelope(
  envelope: AuthorityAttestationEnvelope,
): string {
  const canonicalPayload = JSON.parse(
    canonicalAttestationPayload(envelope.payload),
  ) as AuthorityAttestationPayload;
  return `${JSON.stringify({
    payload: canonicalPayload,
    signature: envelope.signature,
  })}\n`;
}

export function authorityAttestationTagRef(grantId: string): string {
  if (typeof grantId !== 'string' || !GRANT_ID.test(grantId)) {
    throw invalidAttestation(
      'Authority attestation tags require a valid primary grant ID.',
    );
  }
  return `${AUTHORITY_ATTESTATION_TAG_PREFIX}${grantId}`;
}

export function assertAuthorityAttestationPayload(
  payload: unknown,
): asserts payload is AuthorityAttestationPayload {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    !hasExactKeys(payload as Record<string, unknown>, PAYLOAD_KEYS)
  ) {
    throw invalidAttestation('Authority attestation payload shape is invalid.');
  }
  const candidate = payload as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.grantId !== 'string' ||
    !GRANT_ID.test(candidate.grantId) ||
    typeof candidate.repositoryId !== 'string' ||
    !REPOSITORY_ID.test(candidate.repositoryId) ||
    typeof candidate.repositoryOrigin !== 'string' ||
    !REPOSITORY_ORIGIN.test(candidate.repositoryOrigin) ||
    !validProtectedBranch(candidate.protectedBranch) ||
    !validCommitOid(candidate.originalCommit) ||
    !validCommitOid(candidate.mainCommit) ||
    candidate.originalCommit === candidate.mainCommit ||
    !validCommitOid(candidate.policyBlob) ||
    !validExactTimestamp(candidate.issuedAt) ||
    typeof candidate.signer !== 'string' ||
    !SIGNER_IDENTITY.test(candidate.signer)
  ) {
    throw invalidAttestation(
      'Authority attestation payload fields are invalid.',
    );
  }
  assertGrantBaseMappings(candidate.grantBases);
}

export function parseAuthorityAttestationEnvelope(
  raw: string,
): AuthorityAttestationEnvelope {
  if (typeof raw !== 'string' || raw.length > MAX_ENVELOPE_LENGTH) {
    throw invalidAttestation('Authority attestation envelope size is invalid.');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidAttestation('Authority attestation envelope is not JSON.');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !hasExactKeys(value as Record<string, unknown>, ENVELOPE_KEYS)
  ) {
    throw invalidAttestation(
      'Authority attestation envelope shape is invalid.',
    );
  }
  const candidate = value as Record<string, unknown>;
  assertArmoredSshSignature(candidate.signature);
  assertAuthorityAttestationPayload(candidate.payload);
  const envelope: AuthorityAttestationEnvelope = {
    payload: candidate.payload,
    signature: candidate.signature as string,
  };
  if (canonicalAttestationEnvelope(envelope) !== raw) {
    throw invalidAttestation(
      'Authority attestation envelope is not canonically serialized.',
    );
  }
  return envelope;
}

export function validateAttestedTransitionPair(
  original: AttestedCommitFacts,
  main: AttestedCommitFacts,
): ManagedTrailers {
  assertCommitFacts(original, 'original');
  assertCommitFacts(main, 'protected-main');
  if (original.oid === main.oid) {
    throw transitionMismatch(
      'An attested mapping must relate two distinct commit objects.',
    );
  }
  if (original.tree !== main.tree) {
    throw transitionMismatch(
      'The original and protected-main result trees differ.',
    );
  }
  if (original.parentOids.length !== 1 || main.parentOids.length !== 1) {
    throw transitionMismatch(
      'Attested authority transitions must have exactly one parent.',
    );
  }
  if (
    original.parentTree === undefined ||
    main.parentTree === undefined ||
    original.parentTree !== main.parentTree
  ) {
    throw transitionMismatch(
      'The original and protected-main parent trees differ.',
    );
  }
  if (original.message !== main.message) {
    throw transitionMismatch(
      'The original and protected-main commit messages are not byte-identical.',
    );
  }
  let trailers: ManagedTrailers | undefined;
  try {
    trailers = parseManagedTrailers(original.message);
  } catch (error) {
    if (error instanceof ManagedTrailerSyntaxError) {
      throw transitionMismatch(
        'The attested commit message is not a canonical managed message.',
      );
    }
    throw error;
  }
  if (trailers === undefined) {
    throw transitionMismatch(
      'The attested commit message is not a managed transition message.',
    );
  }
  return trailers;
}

export function validateAuthorityTransitionIdentity(
  original: AttestedCommitFacts,
  main: AttestedCommitFacts,
): AuthorityManagedTrailers {
  const trailers = validateAttestedTransitionPair(original, main);
  if (trailers.kind !== 'authority') {
    throw transitionMismatch(
      'The attested transition is not an authority-maintenance transition.',
    );
  }
  return trailers;
}

function assertGrantBaseMappings(
  value: unknown,
): asserts value is AttestationGrantBaseMapping[] {
  if (!Array.isArray(value) || value.length > MAX_GRANT_BASES) {
    throw invalidAttestation(
      'Authority attestation grant-base mappings are invalid.',
    );
  }
  const originalBases: string[] = [];
  const mainBases: string[] = [];
  for (const entry of value) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Array.isArray(entry) ||
      !hasExactKeys(entry as Record<string, unknown>, GRANT_BASE_KEYS)
    ) {
      throw invalidAttestation(
        'Authority attestation grant-base entries are invalid.',
      );
    }
    const mapping = entry as Record<string, unknown>;
    if (
      !validCommitOid(mapping.originalBase) ||
      !validCommitOid(mapping.mainBase) ||
      mapping.originalBase === mapping.mainBase ||
      !Array.isArray(mapping.grantIds) ||
      mapping.grantIds.length === 0 ||
      mapping.grantIds.length > MAX_GRANT_IDS_PER_BASE ||
      mapping.grantIds.some(
        (grantId) => typeof grantId !== 'string' || !GRANT_ID.test(grantId),
      ) ||
      !isSortedUnique(mapping.grantIds as string[])
    ) {
      throw invalidAttestation(
        'Authority attestation grant-base entries are invalid.',
      );
    }
    originalBases.push(mapping.originalBase as string);
    mainBases.push(mapping.mainBase as string);
  }
  if (!isSortedUnique(originalBases) || hasDuplicates(mainBases)) {
    throw invalidAttestation(
      'Authority attestation grant-base mappings must be sorted and unique.',
    );
  }
}

function assertCommitFacts(facts: AttestedCommitFacts, role: string): void {
  if (
    typeof facts !== 'object' ||
    facts === null ||
    !validCommitOid(facts.oid) ||
    !validCommitOid(facts.tree) ||
    !Array.isArray(facts.parentOids) ||
    facts.parentOids.some((parentOid) => !validCommitOid(parentOid)) ||
    (facts.parentTree !== undefined && !validCommitOid(facts.parentTree)) ||
    typeof facts.message !== 'string' ||
    facts.message.length === 0
  ) {
    throw transitionMismatch(
      `The ${role} commit facts are incomplete or invalid.`,
    );
  }
}

function assertArmoredSshSignature(signature: unknown): void {
  if (
    typeof signature !== 'string' ||
    signature.length > MAX_SIGNATURE_LENGTH ||
    signature.includes('\r') ||
    !ARMORED_SSH_SIGNATURE.test(signature)
  ) {
    throw invalidAttestation(
      'The authority attestation SSH signature is invalid.',
    );
  }
}

function validProtectedBranch(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    PROTECTED_BRANCH.test(value) &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.endsWith('/') &&
    !value.endsWith('.lock')
  );
}

function validCommitOid(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_OID.test(value);
}

function validExactTimestamp(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isSortedUnique(values: string[]): boolean {
  return values.every(
    (value, index) => index === 0 || values[index - 1] < value,
  );
}

function hasDuplicates(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function invalidAttestation(message: string) {
  return workflowError(
    'AUTHORITY_ATTESTATION_INVALID',
    message,
    ExitCode.guard,
  );
}

function transitionMismatch(message: string) {
  return workflowError(
    'AUTHORITY_TRANSITION_MISMATCH',
    message,
    ExitCode.verification,
  );
}
