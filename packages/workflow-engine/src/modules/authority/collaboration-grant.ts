import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1,
  COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE as PACKAGE_COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE,
  COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE as PACKAGE_COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  CollaborationGrantEnvelopeReaderError,
  canonicalCollaborationGrantEnvelopeBytesV1,
  canonicalCollaborationGrantPayloadBytesV1,
  parseCollaborationGrantEnvelopeV1,
  readAndVerifyCollaborationGrantEnvelopeV1,
  selectCollaborationGrantSignatureNamespaceV1,
  type CollaborationGrantPayloadCodecV1,
} from '@jigwright/grants/collaboration-grant-envelope-reader';
import { type VerifiedGrantCapabilityV1 } from '@jigwright/grants/grant-envelope-verifier';
import {
  SIGNED_ATTESTATION_ENVELOPE_READER_CONTRACT_VERSION_V1,
  SignedAttestationEnvelopeReaderError,
  canonicalSignedAttestationEnvelopeBytesV1,
  canonicalSignedAttestationPayloadBytesV1,
  parseSignedAttestationEnvelopeV1,
  readAndVerifySignedAttestationEnvelopeV1,
  type SignedAttestationPayloadCodecV1,
} from '@jigwright/grants/signed-attestation-envelope-reader';

import type { ActorAssurance } from '../provider-orchestration/actor-identity.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import {
  discoverRepository,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import {
  parseMaintainerPolicy,
  type MaintainerPolicy,
} from './maintainer-policy.ts';
import type { GrantVerifierPort } from './grant-verifier-port.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from '../../adapters/signing/ssh/maintainer-signer.ts';
import {
  collaborationGrantStorePaths,
  storeAvailableCollaborationGrant,
} from '../../runtime/storage-journal/collaboration-grant-store.ts';
import {
  isProviderId,
  type ProviderId,
} from '../provider-orchestration/provider-registry.ts';
import {
  assertChangeId,
  assertTaskId,
} from '../../runtime/session-workspace/paths.ts';

export const COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE =
  PACKAGE_COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE;
export const COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE =
  PACKAGE_COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE;
/** Historical compatibility alias. New grants are issued as V2. */
export const COLLABORATION_GRANT_SIGNATURE_NAMESPACE =
  COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE;
export const DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE =
  'expense-app.workflow.direct-human-review.v1' as const;
export const COLLABORATION_GRANT_AUTHORIZED_EFFECT =
  'role-independence-degradation-only' as const;
export const COLLABORATION_GRANT_REPLAY_SCOPE =
  'repository-common-dir-local' as const;
export const COLLABORATION_GRANT_RESIDUALS = Object.freeze([
  'GLOBAL_CROSS_CLONE_ONE_USE_NOT_PROVEN',
  'GIT_COMMON_DIR_STATE_IS_COOPERATIVE_NOT_REMOTE_ATTESTED',
  'TRACKED_HISTORY_ONE_USE_REQUIRES_AGGREGATE_VALIDATION',
  'LOCAL_WALL_CLOCK_NOT_EXTERNALLY_ATTESTED',
] as const);
export const COLLABORATION_GRANT_MAX_TTL_MINUTES = 30;
export const COLLABORATION_GRANT_POLICY = deepFreeze({
  schemaVersion: 1 as const,
  policyId: 'expense-app.workflow.collaboration-policy.v1' as const,
  permittedForms: {
    'blind-survey': ['same-provider-fresh-session', 'caller-supplied'] as const,
    'plan-review': [
      'same-provider-fresh-session',
      'caller-supplied',
      'direct-human-review',
    ] as const,
    'task-implementation': [
      'same-provider-fresh-session',
      'caller-supplied',
    ] as const,
  },
  trustCriticalDirectHumanRequiredPhases: [] as const,
});
export const COLLABORATION_GRANT_POLICY_DIGEST = crypto
  .createHash('sha256')
  .update(JSON.stringify(COLLABORATION_GRANT_POLICY))
  .digest('hex');
export const TASK_DIFF_REVIEW_COLLABORATION_POLICY = deepFreeze({
  schemaVersion: 1 as const,
  policyId:
    'expense-app.workflow.collaboration-policy.task-diff-review.v1' as const,
  permittedForms: {
    'task-diff-review': [
      'same-provider-fresh-session',
      'caller-supplied',
      'direct-human-review',
    ] as const,
  },
  trustCriticalDirectHumanRequiredPhases: [] as const,
});
export const TASK_DIFF_REVIEW_COLLABORATION_POLICY_DIGEST = crypto
  .createHash('sha256')
  .update(JSON.stringify(TASK_DIFF_REVIEW_COLLABORATION_POLICY))
  .digest('hex');

export const COLLABORATION_GRANT_RETAINED_OBLIGATIONS = Object.freeze([
  'engine-search-floor',
  'typed-term-contributions',
  'effective-union-scan',
  'hit-dispositions',
  'why-ledger',
  'structured-role-content',
  'challenge-dispositions',
  'registered-checks',
  'allowed-paths',
  'freshness',
  'managed-transition-authority',
] as const);

const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const GRANT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._@:+/-]{0,127}$/;
const V1_PAYLOAD_KEYS = [
  'version',
  'grantId',
  'repositoryId',
  'repositoryOrigin',
  'policyBlob',
  'collaborationPolicyDigest',
  'changeId',
  'taskId',
  'baselineCommit',
  'baselineTree',
  'targetDigest',
  'lifecyclePhase',
  'rolePair',
  'availableActor',
  'degradedForm',
  'authorizedEffect',
  'reason',
  'issuedAt',
  'expiresAt',
  'maxUses',
  'signer',
] as const;
const V2_PAYLOAD_KEYS = [
  'version',
  'signatureNamespace',
  ...V1_PAYLOAD_KEYS.slice(1),
] as const;
const DIRECT_HUMAN_PAYLOAD_KEYS = [
  'version',
  'grantId',
  'signedEnvelopeDigest',
  'transitionDigest',
  'targetDigest',
  'reviewNodeId',
  'reviewResultDigest',
  'signedAt',
  'signer',
] as const;

export type CollaborationLifecyclePhase =
  'blind-survey' | 'plan-review' | 'task-diff-review' | 'task-implementation';
export type CollaborationAuthorRole =
  'investigation-author' | 'plan-author' | 'task-implementer' | 'red-author';
export type CollaborationConflictingRole =
  | 'blind-surveyor'
  | 'plan-reviewer'
  | 'task-diff-reviewer'
  | 'task-implementer';
export type CollaborationRolePair =
  | {
      authorRole: 'investigation-author';
      conflictingRole: 'blind-surveyor';
    }
  | {
      authorRole: 'plan-author';
      conflictingRole: 'plan-reviewer';
    }
  | {
      authorRole: 'task-implementer';
      conflictingRole: 'task-diff-reviewer';
    }
  | {
      authorRole: 'red-author';
      conflictingRole: 'task-implementer';
    };

export type CollaborationAvailableActor =
  | {
      kind: 'provider';
      providerId: ProviderId;
      assurance: ActorAssurance;
    }
  | {
      kind: 'caller';
      callerId: string;
      assurance: ActorAssurance;
    }
  | {
      kind: 'direct-human';
      identity: string;
      assurance: 'maintainer-signed';
    };

export type CollaborationDegradedForm =
  'same-provider-fresh-session' | 'caller-supplied' | 'direct-human-review';

type CollaborationGrantPayloadFields = {
  grantId: string;
  repositoryId: string;
  repositoryOrigin: string;
  policyBlob: string;
  collaborationPolicyDigest: string;
  changeId: string;
  taskId: string | null;
  baselineCommit: string;
  baselineTree: string;
  targetDigest: string;
  lifecyclePhase: CollaborationLifecyclePhase;
  rolePair: CollaborationRolePair;
  availableActor: CollaborationAvailableActor;
  degradedForm: CollaborationDegradedForm;
  authorizedEffect: typeof COLLABORATION_GRANT_AUTHORIZED_EFFECT;
  reason: string;
  issuedAt: string;
  expiresAt: string;
  maxUses: 1;
  signer: string;
};

export type CollaborationGrantPayloadV1 = CollaborationGrantPayloadFields & {
  version: 1;
};

export type CollaborationGrantNamespaceV2Payload =
  CollaborationGrantPayloadFields & {
    version: 2;
    signatureNamespace: typeof COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE;
  };

/**
 * Schema versions for the existing role-independence-degradation-only effect.
 * Future effects use a separate payload family instead of widening this lane.
 */
export type CollaborationGrantPayload =
  CollaborationGrantPayloadV1 | CollaborationGrantNamespaceV2Payload;

export type CollaborationGrantEnvelope = {
  payload: CollaborationGrantPayload;
  signature: string;
};

export type CollaborationGrantRequest = {
  changeId: string;
  taskId: string | null;
  baselineCommit: string;
  baselineTree: string;
  targetDigest: string;
  lifecyclePhase: CollaborationLifecyclePhase;
  rolePair: CollaborationRolePair;
  availableActor: CollaborationAvailableActor;
  degradedForm: CollaborationDegradedForm;
  reason: string;
  ttlMinutes?: number;
  maxUses?: number;
};

export type CollaborationGrantExpectedBinding = Pick<
  CollaborationGrantPayload,
  | 'repositoryId'
  | 'repositoryOrigin'
  | 'policyBlob'
  | 'collaborationPolicyDigest'
  | 'changeId'
  | 'taskId'
  | 'baselineCommit'
  | 'baselineTree'
  | 'targetDigest'
  | 'lifecyclePhase'
  | 'rolePair'
  | 'availableActor'
  | 'degradedForm'
  | 'reason'
>;

export type CollaborationGrantIssueOptions = {
  now?: Date;
  grantId?: string;
  signer?: MaintainerSignerProvider;
};

export type CollaborationGrantIssueResult = {
  grantId: string;
  availableEnvelopePath: string;
  envelope: CollaborationGrantEnvelope;
};

export type CollaborationGrantValidationOptions = {
  now: Date;
  expected: CollaborationGrantExpectedBinding;
  verifier: GrantVerifierPort;
  allowExpired?: boolean;
};

export type VerifiedCollaborationGrantCapability = Readonly<{
  envelope: CollaborationGrantEnvelope;
  verification: VerifiedGrantCapabilityV1<
    typeof COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    | typeof COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE
    | typeof COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE
  >;
}>;

export type DirectHumanReviewAttestationPayload = {
  version: 1;
  grantId: string;
  signedEnvelopeDigest: string;
  transitionDigest: string;
  targetDigest: string;
  reviewNodeId: string;
  reviewResultDigest: string;
  signedAt: string;
  signer: string;
};

export type DirectHumanReviewAttestation = {
  payload: DirectHumanReviewAttestationPayload;
  signature: string;
};

export type DirectHumanReviewAttestationRequest = {
  grantEnvelope: CollaborationGrantEnvelope;
  transitionDigest: string;
  reviewNodeId: string;
  reviewResultDigest: string;
};

export type DirectHumanReviewAttestationOptions = {
  now?: Date;
  signer?: MaintainerSignerProvider;
};

export type DirectHumanReviewValidationOptions = {
  now: Date;
  grantEnvelope: CollaborationGrantEnvelope;
  policy: MaintainerPolicy;
  verifier: GrantVerifierPort;
  transitionDigest: string;
  reviewNodeId: string;
  reviewResultDigest: string;
};

const COLLABORATION_GRANT_PAYLOAD_CODEC: CollaborationGrantPayloadCodecV1<CollaborationGrantPayload> =
  {
    v1PayloadKeys: V1_PAYLOAD_KEYS,
    v2PayloadKeys: V2_PAYLOAD_KEYS,
    parsePayload(value) {
      assertCollaborationPayloadShape(value);
      return value;
    },
    projectPayloadFields: collaborationGrantPayloadFields,
    validateSignature: assertArmoredSignature,
  };

const DIRECT_HUMAN_REVIEW_ATTESTATION_CODEC: SignedAttestationPayloadCodecV1<DirectHumanReviewAttestationPayload> =
  {
    payloadKeys: DIRECT_HUMAN_PAYLOAD_KEYS,
    parsePayload(value) {
      assertDirectHumanReviewPayload(
        value as DirectHumanReviewAttestationPayload,
      );
      return value as DirectHumanReviewAttestationPayload;
    },
    projectPayloadFields(payload) {
      return {
        grantId: payload.grantId,
        signedEnvelopeDigest: payload.signedEnvelopeDigest,
        transitionDigest: payload.transitionDigest,
        targetDigest: payload.targetDigest,
        reviewNodeId: payload.reviewNodeId,
        reviewResultDigest: payload.reviewResultDigest,
        signedAt: payload.signedAt,
        signer: payload.signer,
      };
    },
    validateSignature: assertArmoredSignature,
  };

export function canonicalCollaborationGrantPayload(
  payload: CollaborationGrantPayload,
): string {
  try {
    return canonicalCollaborationGrantPayloadBytesV1(
      payload,
      COLLABORATION_GRANT_PAYLOAD_CODEC,
    );
  } catch (error) {
    throw collaborationReaderInvalid(
      error,
      'Collaboration grant payload version or signature namespace is invalid.',
    );
  }
}

export function collaborationGrantSignatureNamespace(
  payload: CollaborationGrantPayload,
):
  | typeof COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE
  | typeof COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE {
  try {
    return selectCollaborationGrantSignatureNamespaceV1(payload);
  } catch (error) {
    throw collaborationReaderInvalid(
      error,
      'Collaboration grant payload version or signature namespace is invalid.',
    );
  }
}

export function canonicalCollaborationGrantEnvelope(
  envelope: CollaborationGrantEnvelope,
): string {
  try {
    return canonicalCollaborationGrantEnvelopeBytesV1(
      envelope,
      COLLABORATION_GRANT_PAYLOAD_CODEC,
    );
  } catch (error) {
    throw collaborationReaderInvalid(
      error,
      'Collaboration grant envelope is invalid.',
    );
  }
}

export function collaborationGrantEnvelopeDigest(
  envelope: CollaborationGrantEnvelope,
): string {
  return crypto
    .createHash('sha256')
    .update(canonicalCollaborationGrantEnvelope(envelope))
    .digest('hex');
}

export function canonicalDirectHumanReviewPayload(
  payload: DirectHumanReviewAttestationPayload,
): string {
  try {
    return canonicalSignedAttestationPayloadBytesV1(
      payload,
      DIRECT_HUMAN_REVIEW_ATTESTATION_CODEC,
    );
  } catch (error) {
    const signatureError = collaborationReaderSignatureCause(error);
    if (signatureError) throw signatureError;
    throw directHumanReviewInvalid();
  }
}

export function canonicalDirectHumanReviewAttestation(
  attestation: DirectHumanReviewAttestation,
): string {
  try {
    return canonicalSignedAttestationEnvelopeBytesV1(
      attestation,
      DIRECT_HUMAN_REVIEW_ATTESTATION_CODEC,
    );
  } catch (error) {
    const signatureError = collaborationReaderSignatureCause(error);
    if (signatureError) throw signatureError;
    throw directHumanReviewInvalid();
  }
}

export function directHumanReviewAttestationDigest(
  attestation: DirectHumanReviewAttestation,
): string {
  return crypto
    .createHash('sha256')
    .update(canonicalDirectHumanReviewAttestation(attestation))
    .digest('hex');
}

export function parseDirectHumanReviewAttestation(
  raw: string,
): DirectHumanReviewAttestation {
  try {
    return parseSignedAttestationEnvelopeV1(
      raw,
      DIRECT_HUMAN_REVIEW_ATTESTATION_CODEC,
    );
  } catch (error) {
    const signatureError = collaborationReaderSignatureCause(error);
    if (signatureError) throw signatureError;
    throw directHumanReviewInvalid();
  }
}

export function assertCollaborationGrantId(value: string): string {
  if (typeof value !== 'string' || !GRANT_ID.test(value)) {
    throw collaborationInvalid('Collaboration grant ID is invalid.');
  }
  return value;
}

export function parseCollaborationGrantEnvelope(
  raw: string,
): CollaborationGrantEnvelope {
  try {
    const envelope = parseCollaborationGrantEnvelopeV1(
      raw,
      COLLABORATION_GRANT_PAYLOAD_CODEC,
    );
    assertCollaborationGrantId(envelope.payload.grantId);
    return envelope;
  } catch (error) {
    const signatureError = collaborationReaderSignatureCause(error);
    if (signatureError) {
      throw signatureError;
    }
    throw collaborationInvalid('Collaboration grant envelope is invalid.');
  }
}

export function issueCollaborationGrant(
  cwd: string,
  request: CollaborationGrantRequest,
  options: CollaborationGrantIssueOptions = {},
): CollaborationGrantIssueResult {
  const repository = discoverRepository(cwd);
  const baselineCommit = exactRepositoryCommit(
    repository.repositoryRoot,
    request.baselineCommit,
  );
  const baselineTree = runGit(repository.repositoryRoot, [
    'rev-parse',
    `${baselineCommit}^{tree}`,
  ]).trim();
  if (request.baselineTree !== baselineTree) {
    throw collaborationBindingMismatch(
      'Requested baseline tree does not match the exact baseline commit.',
    );
  }
  const mergeBase = runGit(repository.repositoryRoot, [
    'merge-base',
    baselineCommit,
    repository.head,
  ]).trim();
  if (mergeBase !== baselineCommit) {
    throw collaborationBindingMismatch(
      'Requested baseline is not an ancestor of the current repository head.',
    );
  }

  const policy = loadPolicyAtCommit(repository.repositoryRoot, baselineCommit);
  const origin = runGit(repository.repositoryRoot, [
    'remote',
    'get-url',
    'origin',
  ]).trim();
  if (origin !== policy.repository.origin) {
    throw collaborationBindingMismatch(
      'Repository origin does not match the trusted maintainer policy.',
    );
  }
  const policyBlob = runGit(repository.repositoryRoot, [
    'rev-parse',
    `${baselineCommit}:workflow/maintainer-policy.json`,
  ]).trim();
  const now = exactDate(options.now ?? new Date());
  const ttlMinutes = request.ttlMinutes ?? COLLABORATION_GRANT_MAX_TTL_MINUTES;
  const maxUses = request.maxUses ?? 1;
  if (
    !Number.isInteger(ttlMinutes) ||
    ttlMinutes < 1 ||
    ttlMinutes >
      Math.min(policy.maxTtlMinutes, COLLABORATION_GRANT_MAX_TTL_MINUTES) ||
    maxUses !== 1
  ) {
    throw collaborationInvalid(
      'Collaboration grant bounds exceed trusted policy.',
    );
  }
  const grantId = assertCollaborationGrantId(
    options.grantId ?? crypto.randomUUID(),
  );
  const store = collaborationGrantStorePaths(repository.gitCommonDirectory);
  if (
    [store.available, store.reserved, store.terminal].some((directory) =>
      fsExistsGrant(directory, grantId),
    )
  ) {
    throw workflowError(
      'COLLABORATION_GRANT_EXISTS',
      `Collaboration grant ${grantId} already has local state.`,
      ExitCode.conflict,
    );
  }

  const signer =
    options.signer ??
    createInteractiveSshSigner(repository.repositoryRoot, policy);
  signer.assertHumanPresent();
  const signerIdentity = signer.identity();
  const payload: CollaborationGrantNamespaceV2Payload = {
    version: 2,
    signatureNamespace: COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
    grantId,
    repositoryId: policy.repository.id,
    repositoryOrigin: policy.repository.origin,
    policyBlob,
    collaborationPolicyDigest: collaborationPolicyDigestForPhase(
      request.lifecyclePhase,
    ),
    changeId: request.changeId,
    taskId: request.taskId,
    baselineCommit,
    baselineTree,
    targetDigest: request.targetDigest,
    lifecyclePhase: request.lifecyclePhase,
    rolePair: request.rolePair,
    availableActor:
      request.degradedForm === 'direct-human-review'
        ? {
            kind: 'direct-human',
            identity: signerIdentity,
            assurance: 'maintainer-signed',
          }
        : request.availableActor,
    degradedForm: request.degradedForm,
    authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    reason: request.reason,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
    maxUses: 1,
    signer: signerIdentity,
  };
  validateCollaborationGrantPayload(payload, policy, {
    now,
    expectedPolicyBlob: policyBlob,
  });

  const canonicalPayload = canonicalCollaborationGrantPayload(payload);
  let signature: string;
  try {
    signature = signer.sign(
      canonicalPayload,
      COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
    );
    assertArmoredSignature(signature);
    signer.verify(
      canonicalPayload,
      signature,
      signerIdentity,
      COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
    );
  } catch (error) {
    throw collaborationSignatureInvalid(error);
  }
  const envelope = deepFreeze({ payload, signature });
  const availableEnvelopePath = storeAvailableCollaborationGrant(
    repository.gitCommonDirectory,
    envelope,
  );
  return { grantId, availableEnvelopePath, envelope };
}

/**
 * Sign exact direct-human review content separately from the grant that permits
 * degraded PlanReview or TaskDiffReview continuation. This second signature
 * proves who supplied the review bytes; the continuation grant alone never
 * creates that claim.
 */
export function createDirectHumanReviewAttestation(
  cwd: string,
  request: DirectHumanReviewAttestationRequest,
  options: DirectHumanReviewAttestationOptions = {},
): DirectHumanReviewAttestation {
  const repository = discoverRepository(cwd);
  const grant = parseCollaborationGrantEnvelope(
    canonicalCollaborationGrantEnvelope(request.grantEnvelope),
  );
  const payload = grant.payload;
  if (
    payload.degradedForm !== 'direct-human-review' ||
    (payload.lifecyclePhase !== 'plan-review' &&
      payload.lifecyclePhase !== 'task-diff-review') ||
    payload.availableActor.kind !== 'direct-human'
  ) {
    throw workflowError(
      'DIRECT_HUMAN_REVIEW_INVALID',
      'This collaboration grant does not authorize direct-human review.',
      ExitCode.guard,
    );
  }
  const baselineCommit = exactRepositoryCommit(
    repository.repositoryRoot,
    payload.baselineCommit,
  );
  const policy = loadPolicyAtCommit(repository.repositoryRoot, baselineCommit);
  const verifier =
    options.signer ??
    createInteractiveSshSigner(repository.repositoryRoot, policy);
  const now = exactDate(options.now ?? new Date());
  validateCollaborationGrantEnvelope(grant, policy, {
    now,
    expected: bindingFromPayload(payload),
    verifier,
  });
  verifier.assertHumanPresent();
  const identity = verifier.identity();
  if (
    identity !== payload.signer ||
    identity !== payload.availableActor.identity
  ) {
    throw workflowError(
      'DIRECT_HUMAN_REVIEW_INVALID',
      'Direct-human review signer does not match the exact collaboration grant.',
      ExitCode.guard,
    );
  }
  const attestationPayload: DirectHumanReviewAttestationPayload = {
    version: 1,
    grantId: payload.grantId,
    signedEnvelopeDigest: collaborationGrantEnvelopeDigest(grant),
    transitionDigest: exactDigestValue(
      request.transitionDigest,
      'transition digest',
    ),
    targetDigest: payload.targetDigest,
    reviewNodeId: exactDigestValue(request.reviewNodeId, 'review node ID'),
    reviewResultDigest: exactDigestValue(
      request.reviewResultDigest,
      'review result digest',
    ),
    signedAt: now.toISOString(),
    signer: identity,
  };
  const canonical = canonicalDirectHumanReviewPayload(attestationPayload);
  let signature: string;
  try {
    signature = verifier.sign(
      canonical,
      DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE,
    );
    assertArmoredSignature(signature);
    verifier.verify(
      canonical,
      signature,
      identity,
      DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE,
    );
  } catch (error) {
    throw collaborationSignatureInvalid(error);
  }
  return deepFreeze({ payload: attestationPayload, signature });
}

export function validateDirectHumanReviewAttestation(
  attestation: DirectHumanReviewAttestation,
  options: DirectHumanReviewValidationOptions,
): DirectHumanReviewAttestation {
  if (
    !isPlainRecord(attestation) ||
    !hasExactDataKeys(attestation, ['payload', 'signature']) ||
    !isPlainRecord(attestation.payload) ||
    !hasExactDataKeys(attestation.payload, DIRECT_HUMAN_PAYLOAD_KEYS) ||
    typeof attestation.signature !== 'string'
  ) {
    throw directHumanReviewInvalid();
  }
  try {
    const verified = readAndVerifySignedAttestationEnvelopeV1({
      readerContractVersion:
        SIGNED_ATTESTATION_ENVELOPE_READER_CONTRACT_VERSION_V1,
      raw: canonicalDirectHumanReviewAttestation(attestation),
      codec: DIRECT_HUMAN_REVIEW_ATTESTATION_CODEC,
      signatureNamespace: DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE,
      allowedSignatureNamespaces: [DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE],
      validatePayload(parsedPayload) {
        const grant = validateCollaborationGrantEnvelope(
          options.grantEnvelope,
          options.policy,
          {
            now: options.now,
            expected: bindingFromPayload(options.grantEnvelope.payload),
            verifier: options.verifier,
            allowExpired: true,
          },
        );
        const grantPayload = grant.payload;
        const signedAt = exactTimestamp(parsedPayload.signedAt);
        if (
          grantPayload.degradedForm !== 'direct-human-review' ||
          grantPayload.availableActor.kind !== 'direct-human' ||
          parsedPayload.grantId !== grantPayload.grantId ||
          parsedPayload.signedEnvelopeDigest !==
            collaborationGrantEnvelopeDigest(grant) ||
          parsedPayload.transitionDigest !== options.transitionDigest ||
          parsedPayload.targetDigest !== grantPayload.targetDigest ||
          parsedPayload.reviewNodeId !== options.reviewNodeId ||
          parsedPayload.reviewResultDigest !== options.reviewResultDigest ||
          parsedPayload.signer !== grantPayload.signer ||
          parsedPayload.signer !== grantPayload.availableActor.identity ||
          signedAt === undefined ||
          signedAt < Date.parse(grantPayload.issuedAt) ||
          signedAt > Date.parse(grantPayload.expiresAt) ||
          signedAt > exactDate(options.now).getTime() + 30_000
        ) {
          throw directHumanReviewInvalid();
        }
      },
      signer: (parsedPayload) => parsedPayload.signer,
      verifier: options.verifier,
    });
    return verified.envelope;
  } catch (error) {
    if (error instanceof SignedAttestationEnvelopeReaderError) {
      const signatureError = collaborationReaderSignatureCause(error);
      if (signatureError) throw signatureError;
      if (error.code === 'SIGNED_ATTESTATION_SIGNATURE_INVALID') {
        throw collaborationSignatureInvalid(error);
      }
      throw directHumanReviewInvalid();
    }
    throw error;
  }
}

export function validateCollaborationGrantEnvelope(
  envelope: CollaborationGrantEnvelope,
  policy: MaintainerPolicy,
  options: CollaborationGrantValidationOptions,
): CollaborationGrantEnvelope {
  return verifyCollaborationGrantCapability(envelope, policy, options).envelope;
}

export function verifyCollaborationGrantCapability(
  envelope: CollaborationGrantEnvelope,
  policy: MaintainerPolicy,
  options: CollaborationGrantValidationOptions,
): VerifiedCollaborationGrantCapability {
  if (
    !isPlainRecord(envelope) ||
    !hasExactDataKeys(envelope, ['payload', 'signature']) ||
    !isPlainRecord(envelope.payload) ||
    !hasExactCollaborationPayloadKeys(envelope.payload) ||
    typeof envelope.signature !== 'string'
  ) {
    throw collaborationInvalid(
      'Collaboration grant envelope shape is invalid.',
    );
  }
  try {
    const verified = readAndVerifyCollaborationGrantEnvelopeV1({
      readerContractVersion:
        COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1,
      raw: canonicalCollaborationGrantEnvelope(envelope),
      codec: COLLABORATION_GRANT_PAYLOAD_CODEC,
      validatePayload(payload) {
        validateCollaborationGrantPayload(payload, policy, {
          now: options.now,
          expectedPolicyBlob: options.expected.policyBlob,
          allowExpired: options.allowExpired,
        });
        if (
          canonicalExpectedBinding(bindingFromPayload(payload)) !==
          canonicalExpectedBinding(options.expected)
        ) {
          throw collaborationBindingMismatch(
            'Collaboration grant does not match the exact requested transition.',
          );
        }
      },
      authorizedEffect: (payload) => payload.authorizedEffect,
      signer: (payload) => payload.signer,
      allowedAuthorizedEffects: [COLLABORATION_GRANT_AUTHORIZED_EFFECT],
      verifier: options.verifier,
    });
    return deepFreeze(verified);
  } catch (error) {
    if (error instanceof WorkflowError) {
      throw error;
    }
    const signatureError = collaborationReaderSignatureCause(error);
    if (signatureError) {
      throw signatureError;
    }
    if (error instanceof CollaborationGrantEnvelopeReaderError) {
      throw collaborationInvalid('Collaboration grant envelope is invalid.');
    }
    throw collaborationSignatureInvalid(error);
  }
}

export function validateCollaborationGrantPayload(
  payload: CollaborationGrantPayload,
  policy: MaintainerPolicy,
  options: {
    now: Date;
    expectedPolicyBlob: string;
    allowExpired?: boolean;
  },
): void {
  assertCollaborationPayloadShape(payload);
  if (
    payload.repositoryId !== policy.repository.id ||
    payload.repositoryOrigin !== policy.repository.origin ||
    payload.policyBlob !== options.expectedPolicyBlob ||
    payload.collaborationPolicyDigest !==
      collaborationPolicyDigestForPhase(payload.lifecyclePhase) ||
    !policy.trustedSigners.some(
      ({ identity }) => identity === payload.signer,
    ) ||
    payload.maxUses !== 1 ||
    policy.maxUses !== 1
  ) {
    throw collaborationBindingMismatch(
      'Collaboration grant does not match trusted repository policy.',
    );
  }

  const issuedAt = exactTimestamp(payload.issuedAt);
  const expiresAt = exactTimestamp(payload.expiresAt);
  const now = exactDate(options.now).getTime();
  if (
    issuedAt === undefined ||
    expiresAt === undefined ||
    issuedAt > expiresAt ||
    expiresAt - issuedAt >
      Math.min(policy.maxTtlMinutes, COLLABORATION_GRANT_MAX_TTL_MINUTES) *
        60_000 ||
    issuedAt > now + 30_000
  ) {
    throw collaborationInvalid('Collaboration grant has invalid time bounds.');
  }
  if (!options.allowExpired && expiresAt < now) {
    throw workflowError(
      'COLLABORATION_GRANT_EXPIRED',
      'Collaboration grant has expired.',
      ExitCode.staleState,
    );
  }
}

/**
 * The identity of one claimed grant use, reduced to the facts that are
 * reconstructable from immutable evidence alone. Local reservation state is
 * deliberately excluded so a replaying caller and a live caller decide
 * uniqueness from the same inputs.
 */
export type CollaborationGrantUseIdentity = {
  grantId: string;
  signedEnvelopeDigest: string;
  transitionDigest: string;
};

/**
 * Reject a grant or signed envelope claimed more than once across a complete
 * subject. Every collaboration grant is issued with `maxUses: 1`, so a repeated
 * identity is a duplicate claim even when each use validated in isolation.
 * Live transitions and CI replay share this rule; neither consults the mutable
 * common-directory reservation store to apply it.
 */
export function assertUniqueCollaborationGrantUses(
  uses: readonly CollaborationGrantUseIdentity[],
): void {
  const grantIds = new Set<string>();
  const envelopeDigests = new Set<string>();
  for (const use of uses) {
    if (
      grantIds.has(use.grantId) ||
      envelopeDigests.has(use.signedEnvelopeDigest)
    ) {
      throw workflowError(
        'COLLABORATION_GRANT_USE_DUPLICATE',
        'A collaboration grant use is claimed more than once in this subject.',
        ExitCode.staleState,
      );
    }
    grantIds.add(use.grantId);
    envelopeDigests.add(use.signedEnvelopeDigest);
  }
}

export function bindingFromPayload(
  payload: CollaborationGrantPayload,
): CollaborationGrantExpectedBinding {
  return {
    repositoryId: payload.repositoryId,
    repositoryOrigin: payload.repositoryOrigin,
    policyBlob: payload.policyBlob,
    collaborationPolicyDigest: payload.collaborationPolicyDigest,
    changeId: payload.changeId,
    taskId: payload.taskId,
    baselineCommit: payload.baselineCommit,
    baselineTree: payload.baselineTree,
    targetDigest: payload.targetDigest,
    lifecyclePhase: payload.lifecyclePhase,
    rolePair: canonicalRolePair(payload.rolePair),
    availableActor: canonicalAvailableActor(payload.availableActor),
    degradedForm: payload.degradedForm,
    reason: payload.reason,
  };
}

function assertCollaborationPayloadShape(
  candidate: unknown,
): asserts candidate is CollaborationGrantPayload {
  if (!isPlainRecord(candidate)) {
    throw collaborationInvalid('Collaboration grant payload shape is invalid.');
  }
  const payload = candidate;
  if (
    !hasExactCollaborationPayloadKeys(payload) ||
    (payload.version !== 1 && payload.version !== 2) ||
    (payload.version === 2 &&
      payload.signatureNamespace !==
        COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE) ||
    typeof payload.grantId !== 'string' ||
    !GRANT_ID.test(payload.grantId) ||
    typeof payload.repositoryId !== 'string' ||
    payload.repositoryId.length === 0 ||
    typeof payload.repositoryOrigin !== 'string' ||
    payload.repositoryOrigin.length === 0 ||
    typeof payload.policyBlob !== 'string' ||
    !FULL_OID.test(payload.policyBlob) ||
    typeof payload.collaborationPolicyDigest !== 'string' ||
    !DIGEST.test(payload.collaborationPolicyDigest) ||
    typeof payload.changeId !== 'string' ||
    (payload.taskId !== null && typeof payload.taskId !== 'string') ||
    typeof payload.baselineCommit !== 'string' ||
    !FULL_OID.test(payload.baselineCommit) ||
    typeof payload.baselineTree !== 'string' ||
    !FULL_OID.test(payload.baselineTree) ||
    payload.baselineCommit.length !== payload.baselineTree.length ||
    typeof payload.targetDigest !== 'string' ||
    !DIGEST.test(payload.targetDigest) ||
    !isCollaborationLifecyclePhase(payload.lifecyclePhase) ||
    !isCollaborationDegradedForm(payload.degradedForm) ||
    payload.authorizedEffect !== COLLABORATION_GRANT_AUTHORIZED_EFFECT ||
    typeof payload.reason !== 'string' ||
    typeof payload.issuedAt !== 'string' ||
    typeof payload.expiresAt !== 'string' ||
    payload.maxUses !== 1 ||
    !validReason(payload.reason) ||
    typeof payload.signer !== 'string' ||
    !IDENTITY.test(payload.signer)
  ) {
    throw collaborationInvalid('Collaboration grant payload shape is invalid.');
  }
  try {
    assertChangeId(payload.changeId);
    if (payload.taskId !== null) {
      assertTaskId(payload.taskId);
    }
  } catch {
    throw collaborationInvalid(
      'Collaboration grant change or task binding is invalid.',
    );
  }
  assertRolePhase(payload.lifecyclePhase, payload.rolePair);
  if (
    !collaborationPermittedForms(payload.lifecyclePhase).includes(
      payload.degradedForm as never,
    )
  ) {
    throw collaborationInvalid(
      'Collaboration policy does not permit this degraded form.',
    );
  }
  assertAvailableActor(payload.availableActor, payload.degradedForm, {
    lifecyclePhase: payload.lifecyclePhase,
    signer: payload.signer,
  });
}

export function collaborationPolicyDigestForPhase(
  phase: CollaborationLifecyclePhase,
): string {
  return phase === 'task-diff-review'
    ? TASK_DIFF_REVIEW_COLLABORATION_POLICY_DIGEST
    : COLLABORATION_GRANT_POLICY_DIGEST;
}

function collaborationPermittedForms(
  phase: CollaborationLifecyclePhase,
): readonly CollaborationDegradedForm[] {
  return phase === 'task-diff-review'
    ? TASK_DIFF_REVIEW_COLLABORATION_POLICY.permittedForms['task-diff-review']
    : COLLABORATION_GRANT_POLICY.permittedForms[phase];
}

function assertRolePhase(
  phase: unknown,
  rolePair: unknown,
): asserts rolePair is CollaborationRolePair {
  if (
    !isPlainRecord(rolePair) ||
    !hasExactDataKeys(rolePair, ['authorRole', 'conflictingRole'])
  ) {
    throw collaborationInvalid('Collaboration grant role pair is invalid.');
  }
  const valid =
    (phase === 'blind-survey' &&
      rolePair.authorRole === 'investigation-author' &&
      rolePair.conflictingRole === 'blind-surveyor') ||
    (phase === 'plan-review' &&
      rolePair.authorRole === 'plan-author' &&
      rolePair.conflictingRole === 'plan-reviewer') ||
    (phase === 'task-diff-review' &&
      rolePair.authorRole === 'task-implementer' &&
      rolePair.conflictingRole === 'task-diff-reviewer') ||
    (phase === 'task-implementation' &&
      rolePair.authorRole === 'red-author' &&
      rolePair.conflictingRole === 'task-implementer');
  if (!valid) {
    throw collaborationInvalid(
      'Collaboration grant lifecycle phase and roles do not match.',
    );
  }
}

function assertAvailableActor(
  actor: unknown,
  form: unknown,
  payload: Readonly<{ lifecyclePhase: unknown; signer: unknown }>,
): asserts actor is CollaborationAvailableActor {
  if (!isPlainRecord(actor)) {
    throw collaborationInvalid(
      'Collaboration grant available actor is invalid.',
    );
  }
  if (
    form === 'same-provider-fresh-session' &&
    hasExactDataKeys(actor, ['kind', 'providerId', 'assurance']) &&
    actor.kind === 'provider' &&
    isProviderId(actor.providerId) &&
    isActorAssurance(actor.assurance)
  ) {
    return;
  }
  if (
    form === 'caller-supplied' &&
    hasExactDataKeys(actor, ['kind', 'callerId', 'assurance']) &&
    actor.kind === 'caller' &&
    typeof actor.callerId === 'string' &&
    IDENTITY.test(actor.callerId) &&
    isActorAssurance(actor.assurance)
  ) {
    return;
  }
  if (
    form === 'direct-human-review' &&
    (payload.lifecyclePhase === 'plan-review' ||
      payload.lifecyclePhase === 'task-diff-review') &&
    hasExactDataKeys(actor, ['kind', 'identity', 'assurance']) &&
    actor.kind === 'direct-human' &&
    actor.identity === payload.signer &&
    actor.assurance === 'maintainer-signed'
  ) {
    return;
  }
  throw collaborationInvalid(
    'Collaboration grant degraded form and available actor do not match.',
  );
}

function canonicalRolePair(pair: CollaborationRolePair): CollaborationRolePair {
  return {
    authorRole: pair.authorRole,
    conflictingRole: pair.conflictingRole,
  } as CollaborationRolePair;
}

function canonicalAvailableActor(
  actor: CollaborationAvailableActor,
): CollaborationAvailableActor {
  if (actor.kind === 'provider') {
    return {
      kind: 'provider',
      providerId: actor.providerId,
      assurance: actor.assurance,
    };
  }
  if (actor.kind === 'caller') {
    return {
      kind: 'caller',
      callerId: actor.callerId,
      assurance: actor.assurance,
    };
  }
  return {
    kind: 'direct-human',
    identity: actor.identity,
    assurance: 'maintainer-signed',
  };
}

function collaborationGrantPayloadFields(
  payload: CollaborationGrantPayload,
): Readonly<Record<string, unknown>> {
  return {
    grantId: payload.grantId,
    repositoryId: payload.repositoryId,
    repositoryOrigin: payload.repositoryOrigin,
    policyBlob: payload.policyBlob,
    collaborationPolicyDigest: payload.collaborationPolicyDigest,
    changeId: payload.changeId,
    taskId: payload.taskId,
    baselineCommit: payload.baselineCommit,
    baselineTree: payload.baselineTree,
    targetDigest: payload.targetDigest,
    lifecyclePhase: payload.lifecyclePhase,
    rolePair: canonicalRolePair(payload.rolePair),
    availableActor: canonicalAvailableActor(payload.availableActor),
    degradedForm: payload.degradedForm,
    authorizedEffect: payload.authorizedEffect,
    reason: payload.reason,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    maxUses: payload.maxUses,
    signer: payload.signer,
  };
}

function canonicalExpectedBinding(
  binding: CollaborationGrantExpectedBinding,
): string {
  return JSON.stringify({
    repositoryId: binding.repositoryId,
    repositoryOrigin: binding.repositoryOrigin,
    policyBlob: binding.policyBlob,
    collaborationPolicyDigest: binding.collaborationPolicyDigest,
    changeId: binding.changeId,
    taskId: binding.taskId,
    baselineCommit: binding.baselineCommit,
    baselineTree: binding.baselineTree,
    targetDigest: binding.targetDigest,
    lifecyclePhase: binding.lifecyclePhase,
    rolePair: canonicalRolePair(binding.rolePair),
    availableActor: canonicalAvailableActor(binding.availableActor),
    degradedForm: binding.degradedForm,
    reason: binding.reason,
  });
}

function loadPolicyAtCommit(
  repositoryRoot: string,
  commit: string,
): MaintainerPolicy {
  try {
    return parseMaintainerPolicy(
      JSON.parse(
        runGit(repositoryRoot, [
          'show',
          `${commit}:workflow/maintainer-policy.json`,
        ]),
      ),
    );
  } catch (error) {
    if (error instanceof WorkflowError) {
      throw error;
    }
    throw collaborationInvalid(
      'The exact baseline does not contain a valid maintainer policy.',
    );
  }
}

function exactRepositoryCommit(
  repositoryRoot: string,
  requested: string,
): string {
  if (typeof requested !== 'string' || !FULL_OID.test(requested)) {
    throw collaborationInvalid(
      'Collaboration grant baseline must be a full commit object ID.',
    );
  }
  const resolved = runGit(repositoryRoot, [
    'rev-parse',
    `${requested}^{commit}`,
  ]).trim();
  if (resolved !== requested) {
    throw collaborationBindingMismatch(
      'Collaboration grant baseline is not the exact requested commit.',
    );
  }
  return resolved;
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
    throw workflowError(
      'COLLABORATION_SIGNATURE_INVALID',
      'Collaboration grant SSH signature is invalid.',
      ExitCode.verification,
    );
  }
}

function assertDirectHumanReviewPayload(
  payload: DirectHumanReviewAttestationPayload,
): void {
  if (
    !isPlainRecord(payload) ||
    !hasExactDataKeys(payload, DIRECT_HUMAN_PAYLOAD_KEYS) ||
    payload.version !== 1 ||
    !GRANT_ID.test(payload.grantId) ||
    !DIGEST.test(payload.signedEnvelopeDigest) ||
    !DIGEST.test(payload.transitionDigest) ||
    !DIGEST.test(payload.targetDigest) ||
    !DIGEST.test(payload.reviewNodeId) ||
    !DIGEST.test(payload.reviewResultDigest) ||
    exactTimestamp(payload.signedAt) === undefined ||
    !IDENTITY.test(payload.signer)
  ) {
    throw directHumanReviewInvalid();
  }
}

function exactDigestValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw workflowError(
      'DIRECT_HUMAN_REVIEW_INVALID',
      `Direct-human review ${label} is invalid.`,
      ExitCode.guard,
    );
  }
  return value;
}

function isActorAssurance(value: unknown): value is ActorAssurance {
  return (
    value === 'self-declared' ||
    value === 'runtime-hint' ||
    value === 'adapter-assigned'
  );
}

function isCollaborationLifecyclePhase(
  value: unknown,
): value is CollaborationLifecyclePhase {
  return (
    value === 'blind-survey' ||
    value === 'plan-review' ||
    value === 'task-diff-review' ||
    value === 'task-implementation'
  );
}

function isCollaborationDegradedForm(
  value: unknown,
): value is CollaborationDegradedForm {
  return (
    value === 'same-provider-fresh-session' ||
    value === 'caller-supplied' ||
    value === 'direct-human-review'
  );
}

function validReason(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 12 &&
    value.length <= 500 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159);
    })
  );
}

function exactTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value
    ? time
    : undefined;
}

function exactDate(value: Date): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw collaborationInvalid('Collaboration grant time is invalid.');
  }
  return date;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => 'value' in descriptor && descriptor.enumerable === true,
  );
}

function hasExactDataKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return (
    actual.length === keys.length &&
    actual.every((entry, index) => entry === keys[index])
  );
}

function hasExactCollaborationPayloadKeys(
  value: Record<string, unknown>,
): boolean {
  if (value.version === 1) {
    return hasExactDataKeys(value, V1_PAYLOAD_KEYS);
  }
  if (value.version === 2) {
    return hasExactDataKeys(value, V2_PAYLOAD_KEYS);
  }
  return false;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function fsExistsGrant(directory: string, grantId: string): boolean {
  return fs.existsSync(path.join(directory, `${grantId}.json`));
}

function collaborationInvalid(message: string): WorkflowError {
  return workflowError('COLLABORATION_GRANT_INVALID', message, ExitCode.guard);
}

function collaborationBindingMismatch(message: string): WorkflowError {
  return workflowError(
    'COLLABORATION_GRANT_BINDING_MISMATCH',
    message,
    ExitCode.guard,
  );
}

function collaborationSignatureInvalid(cause: unknown): WorkflowError {
  return workflowError(
    'COLLABORATION_SIGNATURE_INVALID',
    'Collaboration grant SSH signature is invalid.',
    ExitCode.verification,
    {
      details: {
        cause: cause instanceof Error ? cause.message : String(cause),
      },
    },
  );
}

function collaborationReaderInvalid(
  error: unknown,
  message: string,
): WorkflowError {
  return (
    collaborationReaderSignatureCause(error) ?? collaborationInvalid(message)
  );
}

function collaborationReaderSignatureCause(
  error: unknown,
): WorkflowError | null {
  if (
    error instanceof WorkflowError &&
    error.code === 'COLLABORATION_SIGNATURE_INVALID'
  ) {
    return error;
  }
  return error instanceof Error && error.cause !== undefined
    ? collaborationReaderSignatureCause(error.cause)
    : null;
}

function directHumanReviewInvalid(): WorkflowError {
  return workflowError(
    'DIRECT_HUMAN_REVIEW_INVALID',
    'Direct-human review attestation is invalid.',
    ExitCode.guard,
  );
}
