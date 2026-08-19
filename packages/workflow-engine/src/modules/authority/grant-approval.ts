import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { ApprovalClaim, GrantPolicyV2 } from './grant-policy.ts';
import {
  freezeGrantCanonical as freezeCanonical,
  GRANT_SHA256_DIGEST as SHA256_DIGEST,
  GRANT_STABLE_ID as STABLE_ID,
  grantHasExactKeys as hasExactKeys,
  grantSameStrings as sameStrings,
} from './grant-primitives.ts';
import type { GrantProofModuleSummary } from '../../runtime/storage-journal/grant-store.ts';

const MODULE_VERSION = /^[1-9][0-9]*$/;

export type VerifiedApprovalProof = Readonly<{
  moduleId: string;
  version: string;
  claims: readonly ApprovalClaim[];
  approvalSubjectDigest: `sha256:${string}`;
  proofDigest: `sha256:${string}`;
  verifiedAt: string;
  identity: string | null;
}>;

export type EvaluatedApprovalProfile = Readonly<{
  profileId: string;
  approvalSubjectDigest: `sha256:${string}`;
  claims: readonly ApprovalClaim[];
  proofModules: readonly GrantProofModuleSummary[];
}>;

export function evaluateApprovalProfile(
  policy: GrantPolicyV2,
  profileId: string,
  expectedSubjectDigest: `sha256:${string}`,
  suppliedProofs: readonly VerifiedApprovalProof[],
): EvaluatedApprovalProfile {
  if (
    !STABLE_ID.test(profileId) ||
    !SHA256_DIGEST.test(expectedSubjectDigest) ||
    !Array.isArray(suppliedProofs) ||
    suppliedProofs.length < 1
  ) {
    throw approvalInvalid();
  }
  const profile = policy.profiles[profileId];
  if (profile === undefined) {
    throw workflowError(
      'GRANT_APPROVAL_PROFILE_UNKNOWN',
      `Grant approval profile ${profileId} is unavailable.`,
      ExitCode.guard,
    );
  }
  const moduleIdentities = new Set<string>();
  const claimed = new Set<ApprovalClaim>();
  const proofModules: GrantProofModuleSummary[] = [];
  for (const supplied of suppliedProofs) {
    const proof = assertVerifiedApprovalProof(supplied);
    const identity = `${proof.moduleId}@${proof.version}`;
    if (
      moduleIdentities.has(identity) ||
      proof.approvalSubjectDigest !== expectedSubjectDigest
    ) {
      throw approvalInvalid();
    }
    moduleIdentities.add(identity);
    const registration = policy.approvalModules.find(
      ({ moduleId, version }) =>
        moduleId === proof.moduleId && version === proof.version,
    );
    if (
      registration === undefined ||
      !sameStrings(proof.claims, registration.allowedClaims)
    ) {
      throw approvalInvalid();
    }
    for (const claim of proof.claims) {
      if (claimed.has(claim)) throw approvalInvalid();
      claimed.add(claim);
      proofModules.push({
        moduleId: proof.moduleId,
        version: proof.version,
        claim,
        proofDigest: proof.proofDigest,
        identity: proof.identity,
      });
    }
  }

  if (!sameStrings([...claimed], profile.requiredClaims)) {
    throw workflowError(
      'GRANT_APPROVAL_PROFILE_UNSATISFIED',
      'Verified approval proofs do not satisfy the selected grant profile.',
      ExitCode.guard,
    );
  }
  const claims = [...claimed].sort() as ApprovalClaim[];
  return freezeCanonical({
    profileId,
    approvalSubjectDigest: expectedSubjectDigest,
    claims,
    proofModules,
  });
}

function assertVerifiedApprovalProof(value: unknown): VerifiedApprovalProof {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'moduleId',
      'version',
      'claims',
      'approvalSubjectDigest',
      'proofDigest',
      'verifiedAt',
      'identity',
    ]) ||
    typeof value.moduleId !== 'string' ||
    !STABLE_ID.test(value.moduleId) ||
    typeof value.version !== 'string' ||
    !MODULE_VERSION.test(value.version) ||
    !Array.isArray(value.claims) ||
    value.claims.length < 1 ||
    !value.claims.every(
      (claim): claim is ApprovalClaim =>
        claim === 'fresh-local-device-owner' || claim === 'ssh-signature',
    ) ||
    new Set(value.claims).size !== value.claims.length ||
    typeof value.approvalSubjectDigest !== 'string' ||
    !SHA256_DIGEST.test(value.approvalSubjectDigest) ||
    typeof value.proofDigest !== 'string' ||
    !SHA256_DIGEST.test(value.proofDigest) ||
    typeof value.verifiedAt !== 'string' ||
    !(
      value.identity === null ||
      (typeof value.identity === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/.test(value.identity))
    )
  ) {
    throw approvalInvalid();
  }
  const verifiedAt = new Date(value.verifiedAt);
  if (
    !Number.isFinite(verifiedAt.getTime()) ||
    verifiedAt.toISOString() !== value.verifiedAt
  ) {
    throw approvalInvalid();
  }
  return freezeCanonical(value) as unknown as VerifiedApprovalProof;
}

function approvalInvalid() {
  return workflowError(
    'GRANT_APPROVAL_PROOF_INVALID',
    'A grant approval proof is malformed, untrusted, or subject-mismatched.',
    ExitCode.guard,
  );
}
