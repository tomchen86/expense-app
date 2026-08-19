import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { authorityTagPublishCommand } from '../../adapters/remote/github/authority-relay-command.ts';
import type { CheckEvidence } from '../../adapters/consumer/expense-app/work-registry/check-runner.ts';
import {
  isRecord,
  isStringArray,
} from '../../foundation/canonical-json/contract-values.ts';
import { assertDisposableDatabase } from '../../adapters/consumer/expense-app/work-registry/database-policy.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  discoverRepository,
  enterActivePostApprovalTerminalCleanup,
  isPostApprovalAdmissionFailure,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import {
  assertMaintainerGrantId,
  createMaintainerAuditTag,
} from './maintainer-grant.ts';
import {
  acceptApplyPrestate,
  assertCandidateV2ChecksFresh,
  assertStoredCandidateSupportingArtifacts,
  canonicalImmutableCandidateBundle,
  parseImmutableCandidateBundle,
  readDurableRefGenerationLedger,
  readStoredImmutableCandidateBundle,
  type AnyImmutableCandidateBundle,
  type ImmutableCandidateBundleV2,
} from './maintainer-candidate.ts';
import { currentCandidateDependencySnapshot } from '../../application/control-plane/maintainer-candidate-dependencies.ts';
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
} from '../../adapters/signing/ssh/maintainer-signer.ts';
import {
  maintainerGrantStorePaths,
  storeCanonicalAvailableMaintainerGrantUnderLifecycleLock,
  terminallyFailSignedMaintainerGrantV2UnderLifecycleLock,
} from '../../runtime/storage-journal/maintainer-store.ts';
import { assertChangeId } from '../../runtime/session-workspace/paths.ts';
import { classifyProtectedCapabilityPaths } from '../../adapters/consumer/expense-app/work-registry/protected-capabilities.ts';
import { withRepositoryLifecycleOperation } from '../../runtime/session-workspace/session-store.ts';
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
const LEGACY_PAYLOAD_KEYS = [
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
const PAYLOAD_KEYS = [...LEGACY_PAYLOAD_KEYS, 'evidenceWaivers'];
const CHECK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type MaintainerEvidenceOverlayEntry = {
  path: string;
  role: 'evidence';
};

export type MaintainerEvidenceWaiver = {
  checkId: string;
  /** Waives max-age admission only; exact binding, outcome, environment, and
   * dependency invalidation remain mandatory. */
  reason: string;
};

export type MaintainerPreapprovalCheck = {
  evidence: CheckEvidence;
  commandDigest: string;
  startedAt: string;
  completedAt: string;
};

type MaintainerChecksAttestationCommon = {
  trustBaseCommit: string;
  policyDigest: string;
  patchDigest: string;
  candidateStateDigest: string;
  environmentDigest: string;
  checks: MaintainerPreapprovalCheck[];
};

export type MaintainerChecksAttestationV1 =
  MaintainerChecksAttestationCommon & {
    schemaVersion: 1;
  };

export type MaintainerChecksAttestationV2 =
  MaintainerChecksAttestationCommon & {
    schemaVersion: 2;
    harnessEngineDigest: string;
  };

export type MaintainerChecksAttestation =
  MaintainerChecksAttestationV1 | MaintainerChecksAttestationV2;

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
  /** Absent only on historical v2 envelopes issued before named waivers. */
  evidenceWaivers?: MaintainerEvidenceWaiver[];
  checkDependencies: CapabilityProfile['checkDependencies'];
  checksAttestation: MaintainerChecksAttestation | null;
  checksAttestationDigest: string | null;
  candidateBundle: AnyImmutableCandidateBundle | null;
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
  candidateBundle?: AnyImmutableCandidateBundle;
  evidenceWaivers?: MaintainerEvidenceWaiver[];
};

export type MaintainerGrantV2IssueOptions = {
  now?: Date;
  grantId?: string;
  signer?: MaintainerSignerProvider;
  environment?: NodeJS.ProcessEnv;
  externalStateDigests?: Readonly<Record<string, string>>;
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
  publishCommand: string;
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
  const evidenceWaivers = validateMaintainerEvidenceWaivers(
    request.evidenceWaivers ?? [],
    profile.requiredChecks,
    profile.checkDependencies,
  );
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
  if (candidateBundle.schemaVersion !== 2) {
    throw workflowError(
      'APPLY_CANDIDATE_LEGACY_READ_ONLY',
      'Immutable candidate v1 is historical read-only evidence and cannot issue a new Apply Grant.',
      ExitCode.guard,
    );
  }
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
  assertCandidateV2ChecksFresh(candidateBundle.checksAttestation, {
    now,
    candidateTree: candidateBundle.resultTree,
    patchDigest: manifest.patchDigest,
    trustBaseCommit: manifest.trustBaseCommit,
    requiredChecks: profile.requiredChecks,
    waivedFreshnessCheckIds: evidenceWaivers.map(({ checkId }) => checkId),
    environmentDigest: currentChecksEnvironmentDigest(
      request.checksAttestation,
      options.environment ?? process.env,
    ),
    currentDependencySnapshot: currentCandidateDependencySnapshot({
      cwd,
      repositoryId: context.policy.repository.id,
      candidateTree: candidateBundle.resultTree,
      baseCommit: manifest.trustBaseCommit,
      policyDigest: context.policyDigest,
      checks: candidateBundle.checksAttestation.checks,
      environment: options.environment,
      externalStateDigests: options.externalStateDigests,
    }),
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
    evidenceWaivers,
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
    let tagObject: string | null = null;
    try {
      assertActiveApplyMandateBinding(cwd, changeId, mandateBinding, {
        now,
        signer,
        assertLifecycleOwned: assertOwned,
      });
      tagObject = createMaintainerAuditTag(
        context.repository.repositoryRoot,
        manifest.trustBaseCommit,
        tagRef,
        canonicalEnvelope,
        signerIdentity,
      );
      storeCanonicalAvailableMaintainerGrantUnderLifecycleLock(
        context.repository.gitCommonDirectory,
        grantId,
        canonicalEnvelope,
        assertOwned,
      );
    } catch (error) {
      if (isPostApprovalAdmissionFailure(error)) {
        enterActivePostApprovalTerminalCleanup();
        terminallyFailSignedMaintainerGrantV2UnderLifecycleLock(
          context.repository.gitCommonDirectory,
          envelope,
          error instanceof Error
            ? error.message
            : 'Post-approval grant publication failed.',
          now,
          assertOwned,
        );
        try {
          const cleanupTagObject =
            tagObject ??
            exactPublishedAuditTagObject(
              context.repository.repositoryRoot,
              tagRef,
              manifest.trustBaseCommit,
              canonicalEnvelope,
              signerIdentity,
            );
          if (cleanupTagObject !== null) {
            runGit(context.repository.repositoryRoot, [
              'update-ref',
              '-d',
              tagRef,
              cleanupTagObject,
            ]);
          }
        } catch {
          // Durable failed authority is denial-first. An unknown or
          // concurrently substituted tag is preserved, and cleanup cannot
          // replace the original admission failure.
        }
      } else if (tagObject) {
        runGit(context.repository.repositoryRoot, [
          'update-ref',
          '-d',
          tagRef,
          tagObject,
        ]);
      }
      throw error;
    }
  });

  return {
    grantId,
    tagRef,
    publishCommand: authorityTagPublishCommand(
      context.policy.repository.origin,
      tagRef,
    ),
    availableTokenPath,
    envelope,
  };
}

function exactPublishedAuditTagObject(
  repositoryRoot: string,
  tagRef: string,
  baseCommit: string,
  canonicalEnvelope: string,
  signerIdentity: string,
): string | null {
  const tagObject = runGit(
    repositoryRoot,
    ['rev-parse', `${tagRef}^{tag}`],
    true,
  ).trim();
  if (!tagObject) return null;
  const raw = runGit(repositoryRoot, ['cat-file', 'tag', tagObject], true);
  const separator = raw.indexOf('\n\n');
  if (separator === -1) return null;
  const headers = raw.slice(0, separator).split('\n');
  const object = headers.find((line) => line.startsWith('object '))?.slice(7);
  const type = headers.find((line) => line.startsWith('type '))?.slice(5);
  const tag = headers.find((line) => line.startsWith('tag '))?.slice(4);
  const tagger = headers.find((line) => line.startsWith('tagger '));
  const expectedTaggerPrefix = `tagger ${signerIdentity} <workflow-maintainer@users.noreply.github.com> `;
  if (
    headers.length !== 4 ||
    object !== baseCommit ||
    type !== 'commit' ||
    tag !== tagRef.slice('refs/tags/'.length) ||
    !tagger?.startsWith(expectedTaggerPrefix) ||
    raw.slice(separator + 2) !== canonicalEnvelope
  ) {
    return null;
  }
  return tagObject;
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

export function parseMaintainerEvidenceWaivers(
  value: unknown,
): MaintainerEvidenceWaiver[] {
  if (!Array.isArray(value)) throw invalidEvidenceWaiver();
  const waivers = value.map((entry): MaintainerEvidenceWaiver => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['checkId', 'reason']) ||
      typeof entry.checkId !== 'string' ||
      !CHECK_ID.test(entry.checkId) ||
      typeof entry.reason !== 'string' ||
      !validReason(entry.reason)
    ) {
      throw invalidEvidenceWaiver();
    }
    return { checkId: entry.checkId, reason: entry.reason };
  });
  if (!isSortedUnique(waivers.map(({ checkId }) => checkId))) {
    throw invalidEvidenceWaiver();
  }
  return waivers;
}

export function validateMaintainerEvidenceWaivers(
  value: unknown,
  requiredChecks: string[],
  checkDependencies: CapabilityProfile['checkDependencies'],
): MaintainerEvidenceWaiver[] {
  const waivers = parseMaintainerEvidenceWaivers(value);
  const required = new Set(requiredChecks);
  if (waivers.some(({ checkId }) => !required.has(checkId))) {
    throw invalidEvidenceWaiver();
  }
  if (
    waivers.some(({ checkId }) =>
      checkDependencies[checkId]?.includes('external-state'),
    )
  ) {
    throw invalidEvidenceWaiver(
      'Named evidence waivers cannot target external-state checks without a current snapshot comparison.',
    );
  }
  return waivers;
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
      (!hasExactKeys(value.payload, PAYLOAD_KEYS) &&
        !hasExactKeys(value.payload, LEGACY_PAYLOAD_KEYS)) ||
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
      (error.code === 'MAINTAINER_SIGNATURE_INVALID' ||
        error.code === 'MAINTAINER_EVIDENCE_WAIVER_INVALID')
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
  if (candidate.schemaVersion !== 2) {
    throw workflowError(
      'APPLY_CANDIDATE_LEGACY_READ_ONLY',
      'Immutable candidate v1 is historical read-only evidence and cannot authorize repository mutation.',
      ExitCode.guard,
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
  } catch (error) {
    if (isPostApprovalAdmissionFailure(error)) throw error;
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
  const evidenceWaivers =
    raw.evidenceWaivers === undefined
      ? undefined
      : parseMaintainerEvidenceWaivers(raw.evidenceWaivers);
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
    ...(evidenceWaivers === undefined ? {} : { evidenceWaivers }),
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
              raw.candidateBundle as AnyImmutableCandidateBundle,
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
  validateMaintainerEvidenceWaivers(
    payload.evidenceWaivers ?? [],
    payload.requiredChecks,
    payload.checkDependencies,
  );
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
  checksAttestation: MaintainerChecksAttestationV2;
  candidateBundle: ImmutableCandidateBundleV2;
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
  if (
    request.candidateBundle.schemaVersion !== 2 ||
    request.checksAttestation.schemaVersion !== 2
  ) {
    throw workflowError(
      'APPLY_CANDIDATE_LEGACY_READ_ONLY',
      'Immutable candidate v1 and its legacy checks are historical read-only evidence.',
      ExitCode.guard,
    );
  }
}

function candidateChecksAreExact(
  candidate: AnyImmutableCandidateBundle,
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
        // Both bindings are checked here against what ran; that they agree is
        // an invariant the check journal enforces separately, comparing the
        // command that ran against the trust base's own definition digest.
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
    }) &&
    (candidate.schemaVersion === 1 ||
      (attestation.schemaVersion === 2 &&
        candidate.checksAttestation.dependencySnapshot.harnessEngineDigest ===
          attestation.harnessEngineDigest))
  );
}

function parseMaintainerChecksAttestation(
  raw: Record<string, unknown>,
): MaintainerChecksAttestation {
  const schemaVersion = raw.schemaVersion;
  const attestationKeys = [
    'schemaVersion',
    'trustBaseCommit',
    'policyDigest',
    'patchDigest',
    'candidateStateDigest',
    'environmentDigest',
    'checks',
    ...(schemaVersion === 2 ? ['harnessEngineDigest'] : []),
  ];
  if (
    !hasExactKeys(raw, attestationKeys) ||
    (schemaVersion !== 1 && schemaVersion !== 2) ||
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
    (schemaVersion === 2 &&
      (typeof raw.harnessEngineDigest !== 'string' ||
        !DIGEST.test(raw.harnessEngineDigest))) ||
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
    const evidenceKeys = [
      'checkId',
      'outcome',
      'exitCode',
      'runner',
      'runnerDigest',
      'destructiveDatabase',
      ...(evidence.databaseIdentity ? ['databaseIdentity'] : []),
      ...(evidence.externalSnapshotDigest ? ['externalSnapshotDigest'] : []),
    ];
    if (
      !hasExactKeys(evidence, evidenceKeys) ||
      typeof evidence.checkId !== 'string' ||
      evidence.outcome !== 'passed' ||
      evidence.exitCode !== 0 ||
      typeof evidence.runner !== 'string' ||
      typeof evidence.runnerDigest !== 'string' ||
      !DIGEST.test(evidence.runnerDigest) ||
      (evidence.externalSnapshotDigest !== undefined &&
        (typeof evidence.externalSnapshotDigest !== 'string' ||
          !DIGEST.test(evidence.externalSnapshotDigest))) ||
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
  const common = {
    trustBaseCommit: raw.trustBaseCommit,
    policyDigest: raw.policyDigest,
    patchDigest: raw.patchDigest,
    candidateStateDigest: raw.candidateStateDigest,
    environmentDigest: raw.environmentDigest,
    checks,
  };
  return schemaVersion === 1
    ? { schemaVersion: 1, ...common }
    : {
        schemaVersion: 2,
        ...common,
        harnessEngineDigest: raw.harnessEngineDigest as string,
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
  candidate: AnyImmutableCandidateBundle | null,
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
    canonicalJson(observed) !==
      canonicalJson(cloneCheckDependencies(profile)) ||
    (candidate.schemaVersion === 2 &&
      candidate.checksAttestation.checks.some((check) =>
        check.dependsOn.includes('external-state')
          ? check.reuseClass !== 'external-state' ||
            check.maxAgeMs !==
              profile.externalStateFreshness?.[check.checkId]?.maxAgeMs
          : check.externalSnapshotDigest !== null,
      ))
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

function invalidEvidenceWaiver(
  message = 'Named evidence waivers must be sorted, unique trust-base check IDs with explicit reasons.',
) {
  return workflowError(
    'MAINTAINER_EVIDENCE_WAIVER_INVALID',
    message,
    ExitCode.guard,
  );
}
