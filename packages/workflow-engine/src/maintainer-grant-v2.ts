import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import type { CheckEvidence } from './check-runner.ts';
import { isRecord, isStringArray } from './contract-values.ts';
import { assertDisposableDatabase } from './database-policy.ts';
import { ExitCode, workflowError } from './errors.ts';
import { discoverRepository, runGit } from './git.ts';
import {
  assertMaintainerGrantId,
  createMaintainerAuditTag,
} from './maintainer-grant.ts';
import {
  acceptApplyPrestate,
  assertCandidateChecksFresh,
  assertStoredCandidateSupportingArtifacts,
  canonicalImmutableCandidateBundle,
  parseImmutableCandidateBundle,
  readDurableRefGenerationLedger,
  readStoredImmutableCandidateBundle,
  type ImmutableCandidateBundle,
} from './maintainer-candidate.ts';
import {
  buildMaintainerPatchManifest,
  canonicalPatchManifest,
  loadCapabilityProfileFromTrustBase,
  parsePatchManifest,
  validatePatchManifestAgainstProfile,
  type CapabilityProfile,
  type PatchManifest,
} from './maintainer-manifest.ts';
import {
  parseMaintainerPolicy,
  type MaintainerPolicy,
} from './maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from './maintainer-signer.ts';
import {
  maintainerGrantStorePaths,
  storeCanonicalAvailableMaintainerGrantUnderLifecycleLock,
} from './maintainer-store.ts';
import { assertChangeId } from './paths.ts';
import { classifyProtectedCapabilityPaths } from './protected-capabilities.ts';
import { withRepositoryLifecycleOperation } from './session-store.ts';
import {
  assertActiveTaskMandateBindingUnderLifecycleLock,
  inspectActiveTaskMandateBinding,
  type TaskMandateBinding,
} from './task-mandate.ts';

export const MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE =
  'expense-app.workflow.maintainer-grant.v2';

const MAX_V2_TTL_MINUTES = 7 * 24 * 60;
const DIGEST = /^[0-9a-f]{64}$/;
const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PAYLOAD_KEYS = [
  'version',
  'grantId',
  'repositoryId',
  'repositoryOrigin',
  'baseCommit',
  'policyBlob',
  'policyDigest',
  'changeId',
  'taskId',
  'mandateBinding',
  'profile',
  'profileVersion',
  'classification',
  'manifest',
  'manifestDigest',
  'patchDigest',
  'allowedPaths',
  'evidenceOverlay',
  'requiredChecks',
  'checkDependencies',
  'checksAttestation',
  'checksAttestationDigest',
  'candidateBundle',
  'candidateBundleDigest',
  'effectsManifestDigest',
  'issuedAt',
  'expiresAt',
  'maxUses',
  'reason',
  'signer',
];

export type MaintainerEvidenceOverlayEntry = {
  path: string;
  role: 'evidence';
};

export type MaintainerPreapprovalCheck = {
  evidence: CheckEvidence;
  commandDigest: string;
  startedAt: string;
  completedAt: string;
};

export type MaintainerChecksAttestation = {
  schemaVersion: 1;
  trustBaseCommit: string;
  policyDigest: string;
  patchDigest: string;
  candidateStateDigest: string;
  environmentDigest: string;
  checks: MaintainerPreapprovalCheck[];
};

export type MaintainerGrantV2Payload = {
  version: 2;
  grantId: string;
  repositoryId: string;
  repositoryOrigin: string;
  baseCommit: string;
  policyBlob: string;
  policyDigest: string;
  changeId: string;
  taskId: string;
  mandateBinding: TaskMandateBinding;
  profile: string;
  profileVersion: number;
  classification: 'ordinary' | 'root-one-shot';
  manifest: PatchManifest;
  manifestDigest: string;
  patchDigest: string;
  allowedPaths: string[];
  evidenceOverlay: MaintainerEvidenceOverlayEntry[];
  requiredChecks: string[];
  checkDependencies: CapabilityProfile['checkDependencies'];
  checksAttestation: MaintainerChecksAttestation | null;
  checksAttestationDigest: string | null;
  candidateBundle: ImmutableCandidateBundle | null;
  candidateBundleDigest: string | null;
  effectsManifestDigest: string | null;
  issuedAt: string;
  expiresAt: string;
  maxUses: 1;
  reason: string;
  signer: string;
};

export type MaintainerGrantV2Envelope = {
  payload: MaintainerGrantV2Payload;
  signature: string;
};

export type MaintainerGrantV2PreflightRequest = {
  profileId: string;
};

export type MaintainerGrantV2PreflightResult = {
  classification: 'ordinary' | 'root-one-shot' | 'control-plane';
  grantable: boolean;
  trustBaseCommit: string;
  policyDigest: string;
  manifest: PatchManifest;
  manifestDigest: string;
  patchDigest: string;
  evidenceOverlay: MaintainerEvidenceOverlayEntry[];
  requiredChecks: string[];
  checkDependencies: CapabilityProfile['checkDependencies'];
};

export type MaintainerGrantV2IssueRequest = {
  changeId: string;
  reason: string;
  manifest: PatchManifest;
  ttlMinutes?: number;
  checksAttestation?: MaintainerChecksAttestation;
  candidateBundle?: ImmutableCandidateBundle;
};

export type MaintainerGrantV2IssueOptions = {
  now?: Date;
  grantId?: string;
  signer?: MaintainerSignerProvider;
  environment?: NodeJS.ProcessEnv;
  /** Production approve-and-apply uses this to durably audit the signed grant
   * before any tag or available token makes it executable. */
  beforeGrantPublication?: (envelope: MaintainerGrantV2Envelope) => void;
};

export type MaintainerGrantV2ValidationOptions = {
  now: Date;
  expectedBase: string;
  expectedPolicyBlob: string;
  signer?: MaintainerSignerProvider;
  assertLifecycleOwned?: () => void;
};

export type MaintainerGrantV2IssueResult = {
  grantId: string;
  tagRef: string;
  availableTokenPath: string;
  envelope: MaintainerGrantV2Envelope;
};

export function preflightMaintainerGrantV2(
  cwd: string,
  request: MaintainerGrantV2PreflightRequest,
): MaintainerGrantV2PreflightResult {
  const context = loadV2TrustContext(cwd);
  const profile = loadCapabilityProfileFromTrustBase(
    context.repository.repositoryRoot,
    context.repository.head,
    request.profileId,
  );
  const manifest = buildMaintainerPatchManifest(
    context.repository.repositoryRoot,
    {
      profile,
      trustBaseCommit: context.repository.head,
      policyDigest: context.policyDigest,
    },
  );
  const classification = classifyCandidate(
    context.repository.repositoryRoot,
    profile,
    manifest,
  );
  return {
    classification,
    grantable: classification !== 'control-plane',
    trustBaseCommit: context.repository.head,
    policyDigest: context.policyDigest,
    manifest,
    manifestDigest: digest(canonicalPatchManifest(manifest)),
    patchDigest: manifest.patchDigest,
    evidenceOverlay: evidenceOverlay(manifest),
    requiredChecks: [...profile.requiredChecks],
    checkDependencies: cloneCheckDependencies(profile),
  };
}

export function issueMaintainerGrantV2(
  cwd: string,
  request: MaintainerGrantV2IssueRequest,
  options: MaintainerGrantV2IssueOptions = {},
): MaintainerGrantV2IssueResult {
  assertApplyCandidateRequest(request);
  const changeId = assertChangeId(request.changeId);
  if (!validReason(request.reason)) {
    throw invalidGrant('Maintainer grant reason is invalid.');
  }
  const manifest = parsePatchManifest(canonicalPatchManifest(request.manifest));
  const context = loadV2TrustContext(cwd, manifest.trustBaseCommit);
  const profile = loadCapabilityProfileFromTrustBase(
    context.repository.repositoryRoot,
    manifest.trustBaseCommit,
    manifest.profile,
  );
  if (
    profile.version !== manifest.profileVersion ||
    manifest.policyDigest !== context.policyDigest
  ) {
    throw invalidGrant(
      'Maintainer grant manifest does not match its trust-base profile or policy.',
    );
  }
  const observed = buildMaintainerPatchManifest(
    context.repository.repositoryRoot,
    {
      profile,
      trustBaseCommit: manifest.trustBaseCommit,
      policyDigest: context.policyDigest,
    },
  );
  if (canonicalPatchManifest(observed) !== canonicalPatchManifest(manifest)) {
    throw workflowError(
      'MAINTAINER_PATCH_DRIFT',
      'The candidate no longer matches the preflighted exact patch.',
      ExitCode.staleState,
    );
  }
  const classification = classifyCandidate(
    context.repository.repositoryRoot,
    profile,
    manifest,
  );
  if (classification === 'control-plane') {
    throw workflowError(
      'MAINTAINER_CONTROL_PLANE_GRANT_REQUIRED',
      'Policy and verification-infrastructure changes require control-plane authority.',
      ExitCode.guard,
    );
  }

  const ttlMinutes = request.ttlMinutes ?? MAX_V2_TTL_MINUTES;
  if (
    !Number.isInteger(ttlMinutes) ||
    ttlMinutes < 1 ||
    ttlMinutes > MAX_V2_TTL_MINUTES
  ) {
    throw invalidGrant('Maintainer grant v2 TTL exceeds the seven-day bound.');
  }
  const now = exactDate(options.now ?? new Date());
  const grantId = assertMaintainerGrantId(
    options.grantId ?? crypto.randomUUID(),
  );
  const tagRef = `${context.policy.auditTagPrefix}${grantId}`;
  const paths = maintainerGrantStorePaths(
    context.repository.gitCommonDirectory,
  );
  const availableTokenPath = path.join(paths.available, `${grantId}.json`);
  if (
    fs.existsSync(availableTokenPath) ||
    fs.existsSync(path.join(paths.reserved, `${grantId}.json`)) ||
    fs.existsSync(path.join(paths.terminal, `${grantId}.json`)) ||
    runGit(
      context.repository.repositoryRoot,
      ['rev-parse', '--verify', tagRef],
      true,
    ).trim()
  ) {
    throw workflowError(
      'MAINTAINER_GRANT_EXISTS',
      `Maintainer grant ${grantId} already has local state or an audit tag.`,
      ExitCode.conflict,
    );
  }

  const candidateBundle = parseImmutableCandidateBundle(
    canonicalImmutableCandidateBundle(request.candidateBundle),
  );
  if (candidateBundle.classification !== classification) {
    throw invalidGrant(
      'Apply Grant v2 requires the exact matching immutable candidate classification.',
    );
  }
  assertCandidateDependencies(candidateBundle, profile);
  if (!candidateChecksAreExact(candidateBundle, request.checksAttestation)) {
    throw invalidGrant(
      'The grant checks attestation differs from the immutable candidate checks.',
    );
  }
  assertCandidateChecksFresh(candidateBundle.checksAttestation, {
    now,
    candidateTree: candidateBundle.resultTree,
    patchDigest: manifest.patchDigest,
    trustBaseCommit: manifest.trustBaseCommit,
    requiredChecks: profile.requiredChecks,
    environmentDigest: currentChecksEnvironmentDigest(
      request.checksAttestation,
      options.environment ?? process.env,
    ),
    changedDependencies: [],
  });
  const storedCandidate = readStoredImmutableCandidateBundle(
    context.repository.gitCommonDirectory,
    candidateBundle.candidateBundleDigest,
  );
  if (
    canonicalImmutableCandidateBundle(storedCandidate) !==
    canonicalImmutableCandidateBundle(candidateBundle)
  ) {
    throw workflowError(
      'APPLY_CANDIDATE_STORE_INVALID',
      'The grant candidate differs from its frozen durable artifact.',
      ExitCode.guard,
    );
  }
  assertStoredCandidateSupportingArtifacts(
    context.repository.gitCommonDirectory,
    changeId,
    candidateBundle,
  );
  const mandateBinding = assertActiveApplyMandateBinding(
    cwd,
    changeId,
    candidateBundle.mandateBinding,
    {
      now,
      signer: options.signer,
    },
  );
  acceptApplyPrestate(
    readDurableRefGenerationLedger(
      context.repository.gitCommonDirectory,
      candidateBundle.targetRef,
      true,
    ),
    candidateBundle.expectedOldCommit,
    candidateBundle.expectedRefGeneration,
  );
  const observedRef = runGit(
    context.repository.repositoryRoot,
    ['rev-parse', '--verify', candidateBundle.targetRef],
    true,
  ).trim();
  if (observedRef !== candidateBundle.expectedOldCommit) {
    throw workflowError(
      'APPLY_REF_OID_MISMATCH',
      'The candidate target ref differs from its approved prestate.',
      ExitCode.staleState,
    );
  }
  const signer =
    options.signer ??
    createInteractiveSshSigner(
      context.repository.repositoryRoot,
      context.policy,
    );
  const signerIdentity = signer.identity();
  const payload: MaintainerGrantV2Payload = {
    version: 2,
    grantId,
    repositoryId: context.policy.repository.id,
    repositoryOrigin: context.policy.repository.origin,
    baseCommit: manifest.trustBaseCommit,
    policyBlob: context.policyBlob,
    policyDigest: context.policyDigest,
    changeId,
    taskId: mandateBinding.mandateTaskId,
    mandateBinding,
    profile: profile.id,
    profileVersion: profile.version,
    classification,
    manifest,
    manifestDigest: digest(canonicalPatchManifest(manifest)),
    patchDigest: manifest.patchDigest,
    allowedPaths: manifest.files.map(({ path: filePath }) => filePath),
    evidenceOverlay: evidenceOverlay(manifest),
    requiredChecks: [...profile.requiredChecks],
    checkDependencies: cloneCheckDependencies(profile),
    checksAttestation: request.checksAttestation,
    checksAttestationDigest: digest(
      canonicalMaintainerChecksAttestation(request.checksAttestation),
    ),
    candidateBundle,
    candidateBundleDigest: candidateBundle.candidateBundleDigest,
    effectsManifestDigest: candidateBundle.effectsManifestDigest,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
    maxUses: 1,
    reason: request.reason,
    signer: signerIdentity,
  };
  validateMaintainerGrantV2Payload(payload);
  if (
    !context.policy.trustedSigners.some(
      ({ identity }) => identity === signerIdentity,
    )
  ) {
    throw invalidGrant('Maintainer grant signer is not trusted by the base.');
  }
  // Every deterministic admission check precedes the human-presence check and
  // signature, so an ungrantable or stale candidate never burns attention.
  signer.assertHumanPresent();
  const canonicalPayload = canonicalMaintainerGrantV2Payload(payload);
  const signature = signer.sign(
    canonicalPayload,
    MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
  );
  assertArmoredSignature(signature);
  signer.verify(
    canonicalPayload,
    signature,
    signerIdentity,
    MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
  );
  const envelope = { payload, signature };
  const canonicalEnvelope = canonicalMaintainerGrantV2Envelope(envelope);
  options.beforeGrantPublication?.(envelope);
  if (canonicalMaintainerGrantV2Envelope(envelope) !== canonicalEnvelope) {
    throw workflowError(
      'MAINTAINER_GRANT_PUBLICATION_MUTATED',
      'The signed grant changed before durable publication.',
      ExitCode.guard,
    );
  }

  withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
    assertOwned();
    assertActiveApplyMandateBinding(cwd, changeId, mandateBinding, {
      now,
      signer,
      assertLifecycleOwned: assertOwned,
    });
    const tagObject = createMaintainerAuditTag(
      context.repository.repositoryRoot,
      manifest.trustBaseCommit,
      tagRef,
      canonicalEnvelope,
      signerIdentity,
    );
    try {
      storeCanonicalAvailableMaintainerGrantUnderLifecycleLock(
        context.repository.gitCommonDirectory,
        grantId,
        canonicalEnvelope,
        assertOwned,
      );
    } catch (error) {
      runGit(context.repository.repositoryRoot, [
        'update-ref',
        '-d',
        tagRef,
        tagObject,
      ]);
      throw error;
    }
  });

  return {
    grantId,
    tagRef,
    availableTokenPath,
    envelope,
  };
}

function assertActiveApplyMandateBinding(
  cwd: string,
  changeId: string,
  expected: TaskMandateBinding,
  options: {
    now: Date;
    signer?: MaintainerSignerProvider;
    assertLifecycleOwned?: () => void;
  },
): TaskMandateBinding {
  const active = options.assertLifecycleOwned
    ? assertActiveTaskMandateBindingUnderLifecycleLock(
        cwd,
        expected,
        options.assertLifecycleOwned,
        options,
      )
    : inspectActiveTaskMandateBinding(cwd, expected.mandateTaskId, options);
  if (
    active.changeId !== changeId ||
    canonicalJson(active) !== canonicalJson(expected)
  ) {
    throw workflowError(
      'APPLY_TASK_MANDATE_BINDING_MISMATCH',
      'Apply Grant v2 does not match the exact active Task Mandate binding.',
      ExitCode.staleState,
    );
  }
  return active;
}

function currentChecksEnvironmentDigest(
  attestation: MaintainerChecksAttestation,
  environment: NodeJS.ProcessEnv,
): string {
  const destructive = attestation.checks.some(
    ({ evidence }) => evidence.destructiveDatabase,
  );
  return maintainerChecksEnvironmentDigest(
    destructive ? assertDisposableDatabase(environment).identity : null,
  );
}

export function canonicalMaintainerGrantV2Payload(
  payload: MaintainerGrantV2Payload,
): string {
  return `${canonicalJson(payload)}\n`;
}

export function canonicalMaintainerGrantV2Envelope(
  envelope: MaintainerGrantV2Envelope,
): string {
  const payload = JSON.parse(
    canonicalMaintainerGrantV2Payload(envelope.payload),
  ) as MaintainerGrantV2Payload;
  return `${canonicalJson({ payload, signature: envelope.signature })}\n`;
}

export function canonicalMaintainerChecksAttestation(
  attestation: MaintainerChecksAttestation,
): string {
  return `${canonicalJson(attestation)}\n`;
}

export function maintainerChecksEnvironmentDigest(
  databaseIdentity: string | null,
): string {
  return digest(
    canonicalJson({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      databaseIdentity,
    }),
  );
}

export function parseMaintainerGrantV2Envelope(
  raw: string,
): MaintainerGrantV2Envelope {
  try {
    if (typeof raw !== 'string' || raw.length > 1_048_576) {
      throw new Error('invalid envelope size');
    }
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['payload', 'signature']) ||
      !isRecord(value.payload) ||
      !hasExactKeys(value.payload, PAYLOAD_KEYS) ||
      typeof value.signature !== 'string'
    ) {
      throw new Error('invalid envelope shape');
    }
    const payload = parseMaintainerGrantV2Payload(value.payload);
    const envelope = { payload, signature: value.signature };
    assertArmoredSignature(envelope.signature);
    if (canonicalMaintainerGrantV2Envelope(envelope) !== raw) {
      throw new Error('noncanonical envelope');
    }
    return envelope;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'MAINTAINER_SIGNATURE_INVALID'
    ) {
      throw error;
    }
    throw invalidGrant('Maintainer grant v2 envelope is invalid.');
  }
}

export function isMaintainerGrantV2Envelope(envelope: {
  payload: { version: number };
}): envelope is MaintainerGrantV2Envelope {
  return envelope.payload.version === 2;
}

export function validateMaintainerGrantV2AuthorityBinding(
  repositoryRoot: string,
  envelope: MaintainerGrantV2Envelope,
  policy: MaintainerPolicy,
  options: MaintainerGrantV2ValidationOptions,
) {
  validateMaintainerGrantV2Payload(envelope.payload);
  const candidate = envelope.payload.candidateBundle;
  if (candidate === null) {
    throw invalidGrant(
      'Maintainer grant v2 requires an immutable candidate at authority admission.',
    );
  }
  assertStoredCandidateSupportingArtifacts(
    discoverRepository(repositoryRoot).gitCommonDirectory,
    envelope.payload.changeId,
    candidate,
  );
  const signer =
    options.signer ?? createInteractiveSshSigner(repositoryRoot, policy);
  try {
    signer.verify(
      canonicalMaintainerGrantV2Payload(envelope.payload),
      envelope.signature,
      envelope.payload.signer,
      MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
    );
  } catch {
    throw workflowError(
      'AUTHORITY_SIGNATURE_INVALID',
      'The maintainer grant v2 signature is invalid.',
      ExitCode.verification,
    );
  }
  const now = exactDate(options.now).getTime();
  const expiresAt = exactTimestamp(envelope.payload.expiresAt);
  const policyContent = runGit(repositoryRoot, [
    'show',
    `${options.expectedBase}:workflow/maintainer-policy.json`,
  ]);
  if (
    envelope.payload.baseCommit !== options.expectedBase ||
    envelope.payload.policyBlob !== options.expectedPolicyBlob ||
    envelope.payload.policyDigest !== digest(policyContent) ||
    expiresAt === undefined ||
    expiresAt < now ||
    !policy.trustedSigners.some(
      ({ identity }) => identity === envelope.payload.signer,
    )
  ) {
    throw invalidGrant(
      'Maintainer grant v2 does not match its live trust-base admission.',
    );
  }
  assertActiveApplyMandateBinding(
    repositoryRoot,
    envelope.payload.changeId,
    envelope.payload.mandateBinding,
    {
      now: options.now,
      signer,
      assertLifecycleOwned: options.assertLifecycleOwned,
    },
  );
  const profile = loadCapabilityProfileFromTrustBase(
    repositoryRoot,
    options.expectedBase,
    envelope.payload.profile,
  );
  const expectedClassification = classifyCandidate(
    repositoryRoot,
    profile,
    envelope.payload.manifest,
  );
  validatePatchManifestAgainstProfile(
    repositoryRoot,
    envelope.payload.manifest,
    profile,
  );
  if (
    !equalStringArrays(
      envelope.payload.requiredChecks,
      profile.requiredChecks,
    ) ||
    canonicalJson(envelope.payload.checkDependencies) !==
      canonicalJson(cloneCheckDependencies(profile)) ||
    envelope.payload.classification !== expectedClassification
  ) {
    throw invalidGrant(
      'Maintainer grant v2 required checks differ from its trust-base profile.',
    );
  }
  assertCandidateDependencies(envelope.payload.candidateBundle, profile);
  return profile;
}

function parseMaintainerGrantV2Payload(
  raw: Record<string, unknown>,
): MaintainerGrantV2Payload {
  const manifest = parsePatchManifest(raw.manifest);
  const evidence = raw.evidenceOverlay;
  if (
    raw.version !== 2 ||
    typeof raw.grantId !== 'string' ||
    typeof raw.repositoryId !== 'string' ||
    typeof raw.repositoryOrigin !== 'string' ||
    typeof raw.baseCommit !== 'string' ||
    typeof raw.policyBlob !== 'string' ||
    typeof raw.policyDigest !== 'string' ||
    typeof raw.changeId !== 'string' ||
    typeof raw.taskId !== 'string' ||
    !isRecord(raw.mandateBinding) ||
    typeof raw.profile !== 'string' ||
    typeof raw.profileVersion !== 'number' ||
    (raw.classification !== 'ordinary' &&
      raw.classification !== 'root-one-shot') ||
    typeof raw.manifestDigest !== 'string' ||
    typeof raw.patchDigest !== 'string' ||
    !isStringArray(raw.allowedPaths) ||
    !Array.isArray(evidence) ||
    !isStringArray(raw.requiredChecks) ||
    !isRecord(raw.checkDependencies) ||
    (raw.checksAttestation !== null && !isRecord(raw.checksAttestation)) ||
    (raw.checksAttestationDigest !== null &&
      typeof raw.checksAttestationDigest !== 'string') ||
    (raw.candidateBundle !== null && !isRecord(raw.candidateBundle)) ||
    (raw.candidateBundleDigest !== null &&
      typeof raw.candidateBundleDigest !== 'string') ||
    (raw.effectsManifestDigest !== null &&
      typeof raw.effectsManifestDigest !== 'string') ||
    typeof raw.issuedAt !== 'string' ||
    typeof raw.expiresAt !== 'string' ||
    raw.maxUses !== 1 ||
    typeof raw.reason !== 'string' ||
    typeof raw.signer !== 'string'
  ) {
    throw new Error('invalid payload fields');
  }
  const payload: MaintainerGrantV2Payload = {
    version: 2,
    grantId: raw.grantId,
    repositoryId: raw.repositoryId,
    repositoryOrigin: raw.repositoryOrigin,
    baseCommit: raw.baseCommit,
    policyBlob: raw.policyBlob,
    policyDigest: raw.policyDigest,
    changeId: raw.changeId,
    taskId: raw.taskId,
    mandateBinding: structuredClone(raw.mandateBinding) as TaskMandateBinding,
    profile: raw.profile,
    profileVersion: raw.profileVersion,
    classification: raw.classification,
    manifest,
    manifestDigest: raw.manifestDigest,
    patchDigest: raw.patchDigest,
    allowedPaths: [...raw.allowedPaths],
    evidenceOverlay: evidence.map((entry) => {
      if (
        !isRecord(entry) ||
        !hasExactKeys(entry, ['path', 'role']) ||
        typeof entry.path !== 'string' ||
        entry.role !== 'evidence'
      ) {
        throw new Error('invalid evidence overlay');
      }
      return { path: entry.path, role: 'evidence' as const };
    }),
    requiredChecks: [...raw.requiredChecks],
    checkDependencies: Object.fromEntries(
      Object.entries(raw.checkDependencies).map(([checkId, dependencies]) => {
        if (!isStringArray(dependencies)) {
          throw new Error('invalid check dependencies');
        }
        return [checkId, [...dependencies]];
      }),
    ) as CapabilityProfile['checkDependencies'],
    checksAttestation:
      raw.checksAttestation === null
        ? null
        : parseMaintainerChecksAttestation(raw.checksAttestation),
    checksAttestationDigest: raw.checksAttestationDigest,
    candidateBundle:
      raw.candidateBundle === null
        ? null
        : parseImmutableCandidateBundle(
            canonicalImmutableCandidateBundle(
              raw.candidateBundle as ImmutableCandidateBundle,
            ),
          ),
    candidateBundleDigest: raw.candidateBundleDigest,
    effectsManifestDigest: raw.effectsManifestDigest,
    issuedAt: raw.issuedAt,
    expiresAt: raw.expiresAt,
    maxUses: 1,
    reason: raw.reason,
    signer: raw.signer,
  };
  validateMaintainerGrantV2Payload(payload);
  return payload;
}

function validateMaintainerGrantV2Payload(
  payload: MaintainerGrantV2Payload,
): void {
  assertMaintainerGrantId(payload.grantId);
  try {
    assertChangeId(payload.changeId);
  } catch {
    throw invalidGrant('Maintainer grant v2 change binding is invalid.');
  }
  const issuedAt = exactTimestamp(payload.issuedAt);
  const expiresAt = exactTimestamp(payload.expiresAt);
  const expectedPaths = payload.manifest.files.map(
    ({ path: filePath }) => filePath,
  );
  const expectedOverlay = evidenceOverlay(payload.manifest);
  if (
    payload.checksAttestation === null ||
    payload.checksAttestationDigest === null ||
    payload.candidateBundle === null ||
    payload.candidateBundleDigest === null ||
    payload.effectsManifestDigest === null
  ) {
    throw invalidGrant(
      'Maintainer grant v2 requires an immutable candidate and its exact checks attestation.',
    );
  }
  if (
    payload.version !== 2 ||
    !payload.repositoryId.startsWith('github:') ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(
      payload.repositoryOrigin,
    ) ||
    !COMMIT_OID.test(payload.baseCommit) ||
    !COMMIT_OID.test(payload.policyBlob) ||
    !DIGEST.test(payload.policyDigest) ||
    payload.profile !== payload.manifest.profile ||
    payload.profileVersion !== payload.manifest.profileVersion ||
    (payload.classification !== 'ordinary' &&
      payload.classification !== 'root-one-shot') ||
    payload.policyDigest !== payload.manifest.policyDigest ||
    payload.manifestDigest !==
      digest(canonicalPatchManifest(payload.manifest)) ||
    payload.patchDigest !== payload.manifest.patchDigest ||
    !equalStringArrays(payload.allowedPaths, expectedPaths) ||
    canonicalJson(payload.evidenceOverlay) !== canonicalJson(expectedOverlay) ||
    payload.requiredChecks.length === 0 ||
    !isSortedUnique(payload.requiredChecks) ||
    canonicalJson(Object.keys(payload.checkDependencies).sort()) !==
      canonicalJson(payload.requiredChecks) ||
    payload.checksAttestationDigest !==
      digest(canonicalMaintainerChecksAttestation(payload.checksAttestation)) ||
    payload.checksAttestation.trustBaseCommit !== payload.baseCommit ||
    payload.checksAttestation.policyDigest !== payload.policyDigest ||
    payload.checksAttestation.patchDigest !== payload.patchDigest ||
    !equalStringArrays(
      payload.checksAttestation.checks.map(({ evidence }) => evidence.checkId),
      payload.requiredChecks,
    ) ||
    payload.candidateBundleDigest !==
      payload.candidateBundle.candidateBundleDigest ||
    payload.effectsManifestDigest !==
      payload.candidateBundle.effectsManifestDigest ||
    payload.taskId !== payload.mandateBinding.mandateTaskId ||
    payload.changeId !== payload.mandateBinding.changeId ||
    canonicalJson(payload.mandateBinding) !==
      canonicalJson(payload.candidateBundle.mandateBinding) ||
    payload.candidateBundle.repositoryId !== payload.repositoryId ||
    payload.candidateBundle.expectedOldCommit !== payload.baseCommit ||
    payload.candidateBundle.manifestDigest !== payload.manifestDigest ||
    payload.candidateBundle.manifest.patchDigest !== payload.patchDigest ||
    payload.candidateBundle.classification !== payload.classification ||
    canonicalPatchManifest(payload.candidateBundle.manifest) !==
      canonicalPatchManifest(payload.manifest) ||
    !equalStringArrays(
      payload.candidateBundle.checksAttestation.checks.map(
        ({ checkId }) => checkId,
      ),
      payload.requiredChecks,
    ) ||
    !candidateChecksAreExact(
      payload.candidateBundle,
      payload.checksAttestation,
    ) ||
    issuedAt === undefined ||
    expiresAt === undefined ||
    issuedAt > expiresAt ||
    expiresAt - issuedAt > MAX_V2_TTL_MINUTES * 60_000 ||
    payload.maxUses !== 1 ||
    !validReason(payload.reason) ||
    payload.signer.length === 0 ||
    payload.signer.length > 128
  ) {
    throw invalidGrant(
      'Maintainer grant v2 does not match its exact-patch binding.',
    );
  }
}

function assertApplyCandidateRequest(
  request: MaintainerGrantV2IssueRequest,
): asserts request is MaintainerGrantV2IssueRequest & {
  checksAttestation: MaintainerChecksAttestation;
  candidateBundle: ImmutableCandidateBundle;
} {
  if (
    request.candidateBundle === undefined ||
    request.candidateBundle === null ||
    request.checksAttestation === undefined ||
    request.checksAttestation === null
  ) {
    throw workflowError(
      'APPLY_CANDIDATE_REQUIRED',
      'Apply Grant v2 requires an immutable candidate and its exact checks attestation.',
      ExitCode.guard,
    );
  }
}

function candidateChecksAreExact(
  candidate: ImmutableCandidateBundle,
  attestation: MaintainerChecksAttestation,
): boolean {
  const candidateChecks = candidate.checksAttestation.checks;
  return (
    candidateChecks.length === attestation.checks.length &&
    candidateChecks.every((candidateCheck, index) => {
      const grantCheck = attestation.checks[index];
      return (
        grantCheck !== undefined &&
        candidateCheck.checkId === grantCheck.evidence.checkId &&
        candidateCheck.definitionDigest === grantCheck.commandDigest &&
        candidateCheck.commandDigest === grantCheck.commandDigest &&
        candidateCheck.runnerDigest === grantCheck.evidence.runnerDigest &&
        candidateCheck.environmentDigest === attestation.environmentDigest &&
        candidateCheck.resultDigest ===
          digest(canonicalJson(grantCheck.evidence)) &&
        candidateCheck.outcome === 'passed' &&
        candidateCheck.startedAt === grantCheck.startedAt &&
        candidateCheck.completedAt === grantCheck.completedAt
      );
    })
  );
}

function parseMaintainerChecksAttestation(
  raw: Record<string, unknown>,
): MaintainerChecksAttestation {
  if (
    !hasExactKeys(raw, [
      'schemaVersion',
      'trustBaseCommit',
      'policyDigest',
      'patchDigest',
      'candidateStateDigest',
      'environmentDigest',
      'checks',
    ]) ||
    raw.schemaVersion !== 1 ||
    typeof raw.trustBaseCommit !== 'string' ||
    !COMMIT_OID.test(raw.trustBaseCommit) ||
    typeof raw.policyDigest !== 'string' ||
    !DIGEST.test(raw.policyDigest) ||
    typeof raw.patchDigest !== 'string' ||
    !DIGEST.test(raw.patchDigest) ||
    typeof raw.candidateStateDigest !== 'string' ||
    !DIGEST.test(raw.candidateStateDigest) ||
    typeof raw.environmentDigest !== 'string' ||
    !DIGEST.test(raw.environmentDigest) ||
    !Array.isArray(raw.checks) ||
    raw.checks.length === 0
  ) {
    throw new Error('invalid checks attestation');
  }
  const checks = raw.checks.map((entry): MaintainerPreapprovalCheck => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        'evidence',
        'commandDigest',
        'startedAt',
        'completedAt',
      ]) ||
      !isRecord(entry.evidence) ||
      typeof entry.commandDigest !== 'string' ||
      !DIGEST.test(entry.commandDigest) ||
      typeof entry.startedAt !== 'string' ||
      typeof entry.completedAt !== 'string' ||
      exactTimestamp(entry.startedAt) === undefined ||
      exactTimestamp(entry.completedAt) === undefined ||
      exactTimestamp(entry.startedAt)! > exactTimestamp(entry.completedAt)!
    ) {
      throw new Error('invalid preapproval check');
    }
    const evidence = entry.evidence;
    const evidenceKeys = evidence.databaseIdentity
      ? [
          'checkId',
          'outcome',
          'exitCode',
          'runner',
          'runnerDigest',
          'destructiveDatabase',
          'databaseIdentity',
        ]
      : [
          'checkId',
          'outcome',
          'exitCode',
          'runner',
          'runnerDigest',
          'destructiveDatabase',
        ];
    if (
      !hasExactKeys(evidence, evidenceKeys) ||
      typeof evidence.checkId !== 'string' ||
      evidence.outcome !== 'passed' ||
      evidence.exitCode !== 0 ||
      typeof evidence.runner !== 'string' ||
      typeof evidence.runnerDigest !== 'string' ||
      !DIGEST.test(evidence.runnerDigest) ||
      typeof evidence.destructiveDatabase !== 'boolean' ||
      (evidence.databaseIdentity !== undefined &&
        typeof evidence.databaseIdentity !== 'string')
    ) {
      throw new Error('invalid check evidence');
    }
    return {
      evidence: evidence as CheckEvidence,
      commandDigest: entry.commandDigest,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
    };
  });
  return {
    schemaVersion: 1,
    trustBaseCommit: raw.trustBaseCommit,
    policyDigest: raw.policyDigest,
    patchDigest: raw.patchDigest,
    candidateStateDigest: raw.candidateStateDigest,
    environmentDigest: raw.environmentDigest,
    checks,
  };
}

function loadV2TrustContext(cwd: string, expectedBase?: string) {
  const repository = discoverRepository(cwd);
  if (expectedBase && repository.head !== expectedBase) {
    throw workflowError(
      'MAINTAINER_PATCH_STALE_BASE',
      'The repository HEAD moved after maintainer grant preflight.',
      ExitCode.staleState,
    );
  }
  let policyContent: string;
  let policy: MaintainerPolicy;
  try {
    policyContent = runGit(repository.repositoryRoot, [
      'show',
      `${repository.head}:workflow/maintainer-policy.json`,
    ]);
    policy = parseMaintainerPolicy(JSON.parse(policyContent));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      throw error;
    }
    throw workflowError(
      'MAINTAINER_POLICY_INVALID',
      'The trust base does not contain a valid maintainer policy.',
      ExitCode.guard,
    );
  }
  const origin = runGit(repository.repositoryRoot, [
    'remote',
    'get-url',
    'origin',
  ]).trim();
  if (origin !== policy.repository.origin) {
    throw workflowError(
      'MAINTAINER_REPOSITORY_MISMATCH',
      'The repository origin does not match the trusted maintainer policy.',
      ExitCode.guard,
    );
  }
  const policyBlob = runGit(repository.repositoryRoot, [
    'rev-parse',
    `${repository.head}:workflow/maintainer-policy.json`,
  ]).trim();
  return {
    repository,
    policy,
    policyBlob,
    policyDigest: digest(policyContent),
  };
}

function evidenceOverlay(
  manifest: PatchManifest,
): MaintainerEvidenceOverlayEntry[] {
  return manifest.files
    .filter(({ role }) => role === 'evidence')
    .map(({ path: filePath }) => ({ path: filePath, role: 'evidence' }));
}

function classifyCandidate(
  repositoryRoot: string,
  profile: CapabilityProfile,
  manifest: PatchManifest,
): 'ordinary' | 'root-one-shot' | 'control-plane' {
  const protectedPaths = classifyProtectedCapabilityPaths(
    repositoryRoot,
    manifest.trustBaseCommit,
    manifest.files.map(({ path: filePath }) => filePath),
  ).protectedPaths;
  return manifest.files.some(
    ({ role }) => role === 'policy' || role === 'verification-infrastructure',
  ) || protectedPaths.length > 0
    ? 'control-plane'
    : profile.authorityClass;
}

function cloneCheckDependencies(
  profile: CapabilityProfile,
): CapabilityProfile['checkDependencies'] {
  return Object.fromEntries(
    profile.requiredChecks.map((checkId) => [
      checkId,
      [...profile.checkDependencies[checkId]!],
    ]),
  );
}

function assertCandidateDependencies(
  candidate: ImmutableCandidateBundle | null,
  profile: CapabilityProfile,
): void {
  if (candidate === null) return;
  const observed = Object.fromEntries(
    candidate.checksAttestation.checks.map(({ checkId, dependsOn }) => [
      checkId,
      dependsOn,
    ]),
  );
  if (
    canonicalJson(observed) !== canonicalJson(cloneCheckDependencies(profile))
  ) {
    throw invalidGrant(
      'Candidate check dependencies differ from the trust-base profile.',
    );
  }
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function exactDate(value: Date): Date {
  const copy = new Date(value);
  if (!Number.isFinite(copy.getTime())) {
    throw invalidGrant('Maintainer grant issue time is invalid.');
  }
  return copy;
}

function exactTimestamp(value: string): number | undefined {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value
    ? time
    : undefined;
}

function validReason(value: string): boolean {
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
      'MAINTAINER_SIGNATURE_INVALID',
      'The maintainer grant SSH signature is invalid.',
      ExitCode.verification,
    );
  }
}

function isSortedUnique(values: string[]): boolean {
  const sorted = [...new Set(values)].sort();
  return (
    values.length === sorted.length &&
    values.every((value, index) => value === sorted[index])
  );
}

function equalStringArrays(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function invalidGrant(message: string) {
  return workflowError('MAINTAINER_GRANT_INVALID', message, ExitCode.guard);
}
