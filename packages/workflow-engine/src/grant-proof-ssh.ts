import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import type { VerifiedApprovalProof } from './grant-approval.ts';
import { approvalSubjectDigest, assertApprovalSubject } from './grant-core.ts';
import type { GrantAuthenticationRequest } from './grant-coordinator.ts';
import type { GrantPolicyV2 } from './grant-policy.ts';
import { copyGrantDate, grantSha256 } from './grant-primitives.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from './maintainer-signer.ts';

export type SshApprovalSigner = MaintainerSignerProvider;

export function collectSshApprovalProof(
  policy: GrantPolicyV2,
  request: GrantAuthenticationRequest,
  options: Readonly<{
    repositoryRoot?: string;
    signer?: SshApprovalSigner;
    now?: Date;
  }> = {},
): VerifiedApprovalProof {
  const ssh = policy.optionalSsh;
  if (
    ssh === undefined ||
    !policy.approvalModules.some(
      ({ moduleId, version }) =>
        moduleId === 'grant-proof-ssh' && version === '1',
    )
  ) {
    throw sshProofInvalid(
      'Optional SSH approval proof is not enabled by GrantPolicyV2.',
    );
  }
  const subject = assertApprovalSubject(request.approvalSubject);
  if (
    subject.approvalMethod !== 'ssh' ||
    approvalSubjectDigest(subject) !== request.approvalSubjectDigest ||
    new Date(subject.expiresAt).getTime() <
      (options.now ?? new Date()).getTime()
  ) {
    throw sshProofInvalid(
      'SSH approval proof does not match a live approval subject.',
    );
  }
  const signer =
    options.signer ??
    (options.repositoryRoot === undefined
      ? undefined
      : createInteractiveSshSigner(options.repositoryRoot, {
          signatureNamespace: ssh.signatureNamespace,
          trustedSigners: [...ssh.trustedSigners],
        }));
  if (signer === undefined) {
    throw sshProofInvalid('SSH approval signer is unavailable.');
  }
  signer.assertHumanPresent();
  const identity = signer.identity();
  if (
    !ssh.trustedSigners.some((candidate) => candidate.identity === identity)
  ) {
    throw sshProofInvalid('SSH approval signer is not policy-trusted.');
  }
  const payload = canonicalJson({
    schemaVersion: 1,
    kind: 'grant-proof-ssh-subject.v1',
    approvalSubject: subject,
    approvalSubjectDigest: request.approvalSubjectDigest,
    signerIdentity: identity,
  });
  const signature = signer.sign(payload, ssh.signatureNamespace);
  if (
    typeof signature !== 'string' ||
    signature.length < 1 ||
    signature.length > 16_384 ||
    signature.includes('\0') ||
    signature.includes('\r')
  ) {
    throw sshProofInvalid('SSH approval signature is malformed.');
  }
  signer.verify(payload, signature, identity, ssh.signatureNamespace);
  const verifiedAt = exactDate(options.now ?? new Date()).toISOString();
  return Object.freeze({
    moduleId: 'grant-proof-ssh',
    version: '1',
    claims: Object.freeze(['ssh-signature'] as const),
    approvalSubjectDigest: request.approvalSubjectDigest,
    proofDigest: grantSha256(
      canonicalJson({
        schemaVersion: 1,
        kind: 'grant-proof-ssh-evidence.v1',
        payload,
        signature,
      }),
    ),
    verifiedAt,
    identity,
  });
}

function exactDate(value: Date): Date {
  const copy = copyGrantDate(value);
  if (copy === null) {
    throw sshProofInvalid('SSH approval verification time is invalid.');
  }
  return copy;
}

function sshProofInvalid(message: string) {
  return workflowError('GRANT_SSH_PROOF_INVALID', message, ExitCode.guard);
}
