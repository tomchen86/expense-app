import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { authorityTagPublishCommand } from './authority-relay-command.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  discoverRepository,
  isPostApprovalAdmissionFailure,
  runGit,
  runGitWithEnvironment,
} from './git.ts';
import {
  isAuthorityPathEligible,
  parseMaintainerPolicy,
  type MaintainerPolicy,
} from './maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from './maintainer-signer.ts';
import {
  assertHumanResolutionConsequences,
  assertHumanResolutionDecision,
  assertLegacySupersedeHumanResolutionDecisionReadOnly,
  assertHumanResolutionLifecycleBarrier,
  humanResolutionDecisionSchemaDigest,
  inspectInvestigationResolutionState,
  inspectInvestigationQuarantineState,
  readActiveHumanResolutionJournal,
  readInvestigationSession,
  rollbackAvailableHumanResolutionGrant,
  storeAvailableHumanResolutionGrant,
  type HumanResolutionConsequences,
  type HumanResolutionDecision,
  type HumanResolutionExpectedState,
  type HumanResolutionTarget,
  type InvestigationResolutionState,
} from './investigation-session-store.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import {
  assertChangeId,
  assertInvestigationId,
  assertPolicyPathInsideRepository,
  normalizeExactRepositoryPath,
} from './paths.ts';
import { withRepositoryLifecycleOperation } from './session-store.ts';

const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const GRANT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PAYLOAD_KEYS = [
  'version',
  'grantId',
  'repositoryId',
  'repositoryOrigin',
  'baseCommit',
  'policyBlob',
  'changeId',
  'allowedPaths',
  'issuedAt',
  'expiresAt',
  'maxUses',
  'reason',
  'signer',
];
export const HUMAN_RESOLUTION_SIGNATURE_NAMESPACE =
  'expense-app.workflow.human-resolution-grant.v1';
const HUMAN_RESOLUTION_PAYLOAD_KEYS = [
  'version',
  'grantId',
  'repositoryId',
  'repositoryOrigin',
  'trustBaseCommit',
  'policyBlob',
  'target',
  'expected',
  'decision',
  'consequences',
  'rationale',
  'issuedAt',
  'expiresAt',
  'maxUses',
  'signer',
];

export type MaintainerGrantPayload = {
  version: 1;
  grantId: string;
  repositoryId: string;
  repositoryOrigin: string;
  baseCommit: string;
  policyBlob: string;
  changeId: string;
  allowedPaths: string[];
  issuedAt: string;
  expiresAt: string;
  maxUses: 1;
  reason: string;
  signer: string;
};

export type MaintainerGrantEnvelope = {
  payload: MaintainerGrantPayload;
  signature: string;
};

export type MaintainerGrantRequest = {
  changeId: string;
  paths: string[];
  reason: string;
  ttlMinutes?: number;
  maxUses?: number;
};

export type MaintainerGrantIssueOptions = {
  now?: Date;
  grantId?: string;
  signer?: MaintainerSignerProvider;
};

export type MaintainerGrantIssueResult = {
  grantId: string;
  tagRef: string;
  publishCommand: string;
  availableTokenPath: string;
  envelope: MaintainerGrantEnvelope;
};

export type HumanResolutionGrantPayload = {
  version: 1;
  grantId: string;
  repositoryId: string;
  repositoryOrigin: string;
  trustBaseCommit: string;
  policyBlob: string;
  target: HumanResolutionTarget;
  expected: HumanResolutionExpectedState;
  decision: HumanResolutionDecision;
  consequences: HumanResolutionConsequences;
  rationale: string;
  issuedAt: string;
  expiresAt: string;
  maxUses: 1;
  signer: string;
};

export type HumanResolutionGrantEnvelope = {
  payload: HumanResolutionGrantPayload;
  signature: string;
};

export type HumanResolutionGrantRequest = {
  investigationId: string;
  decision: HumanResolutionDecision;
  consequences: HumanResolutionConsequences;
  rationale: string;
  ttlMinutes?: number;
};

export type HumanResolutionGrantIssueOptions = {
  now?: Date;
  grantId?: string;
  signer?: MaintainerSignerProvider;
};

export type HumanResolutionGrantIssueResult = {
  grantId: string;
  tagRef: string;
  publishCommand: string;
  availableTokenPath: string;
  envelope: HumanResolutionGrantEnvelope;
  state: InvestigationResolutionState;
};

export type HumanResolutionGrantValidationOptions = {
  now: Date;
  expectedTrustBase: string;
  expectedPolicyBlob: string;
  state: InvestigationResolutionState;
  allowExpired?: boolean;
};

export type GrantValidationOptions = {
  now: Date;
  expectedBase: string;
  expectedPolicyBlob: string;
  allowExpired?: boolean;
};

export function canonicalGrantPayload(payload: MaintainerGrantPayload): string {
  return `${JSON.stringify({
    version: payload.version,
    grantId: payload.grantId,
    repositoryId: payload.repositoryId,
    repositoryOrigin: payload.repositoryOrigin,
    baseCommit: payload.baseCommit,
    policyBlob: payload.policyBlob,
    changeId: payload.changeId,
    allowedPaths: payload.allowedPaths,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    maxUses: payload.maxUses,
    reason: payload.reason,
    signer: payload.signer,
  })}\n`;
}

export function canonicalGrantEnvelope(
  envelope: MaintainerGrantEnvelope,
): string {
  const canonicalPayload = JSON.parse(
    canonicalGrantPayload(envelope.payload),
  ) as MaintainerGrantPayload;
  return `${JSON.stringify({
    payload: canonicalPayload,
    signature: envelope.signature,
  })}\n`;
}

export function canonicalHumanResolutionGrantPayload(
  payload: HumanResolutionGrantPayload,
): string {
  return `${canonicalJson({
    version: payload.version,
    grantId: payload.grantId,
    repositoryId: payload.repositoryId,
    repositoryOrigin: payload.repositoryOrigin,
    trustBaseCommit: payload.trustBaseCommit,
    policyBlob: payload.policyBlob,
    target: payload.target,
    expected: payload.expected,
    decision: payload.decision,
    consequences: payload.consequences,
    rationale: payload.rationale,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    maxUses: payload.maxUses,
    signer: payload.signer,
  })}\n`;
}

export function canonicalHumanResolutionGrantEnvelope(
  envelope: HumanResolutionGrantEnvelope,
): string {
  const canonicalPayload = JSON.parse(
    canonicalHumanResolutionGrantPayload(envelope.payload),
  ) as HumanResolutionGrantPayload;
  return `${canonicalJson({
    payload: canonicalPayload,
    signature: envelope.signature,
  })}\n`;
}

export function parseHumanResolutionGrantEnvelope(
  raw: string,
): HumanResolutionGrantEnvelope {
  try {
    if (typeof raw !== 'string' || raw.length > 65_536) {
      throw new Error('invalid envelope size');
    }
    const value = JSON.parse(raw) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !hasExactKeys(value as Record<string, unknown>, ['payload', 'signature'])
    ) {
      throw new Error('invalid envelope');
    }
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.payload !== 'object' ||
      candidate.payload === null ||
      Array.isArray(candidate.payload) ||
      !hasExactKeys(
        candidate.payload as Record<string, unknown>,
        HUMAN_RESOLUTION_PAYLOAD_KEYS,
      ) ||
      typeof candidate.signature !== 'string'
    ) {
      throw new Error('invalid envelope fields');
    }
    const envelope = {
      payload: candidate.payload as HumanResolutionGrantPayload,
      signature: candidate.signature,
    };
    assertArmoredSshSignature(envelope.signature);
    assertMaintainerGrantId(envelope.payload.grantId);
    if (canonicalHumanResolutionGrantEnvelope(envelope) !== raw) {
      throw new Error('non-canonical envelope');
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
    throw humanResolutionGrantInvalid(
      'Human resolution grant envelope is invalid.',
    );
  }
}

export function readHumanResolutionAuditTag(
  repositoryRoot: string,
  policy: MaintainerPolicy,
  observedRef: string,
): HumanResolutionGrantEnvelope | null {
  return readHumanResolutionAuditTagWithMode(
    repositoryRoot,
    policy,
    observedRef,
    false,
  );
}

/**
 * Reads either a current audit tag or the exact supersede shape signed before
 * canonical reasons were required. This compatibility path is verification
 * only: live grant and lifecycle readers remain strict.
 */
export function readHistoricalHumanResolutionAuditTagReadOnly(
  repositoryRoot: string,
  policy: MaintainerPolicy,
  observedRef: string,
): HumanResolutionGrantEnvelope | null {
  return readHumanResolutionAuditTagWithMode(
    repositoryRoot,
    policy,
    observedRef,
    true,
  );
}

function readHumanResolutionAuditTagWithMode(
  repositoryRoot: string,
  policy: MaintainerPolicy,
  observedRef: string,
  allowLegacySupersedeReadOnly: boolean,
): HumanResolutionGrantEnvelope | null {
  const resolutionPrefix = `${policy.auditTagPrefix}resolution-`;
  if (!observedRef.startsWith(resolutionPrefix)) {
    return null;
  }

  try {
    const observedGrantId = observedRef.slice(resolutionPrefix.length);
    assertMaintainerGrantId(observedGrantId);
    const raw = runGit(repositoryRoot, ['cat-file', 'tag', observedRef]);
    const separator = raw.indexOf('\n\n');
    if (separator === -1) {
      throw new Error('missing tag message');
    }
    const headers = raw.slice(0, separator).split('\n');
    const objectHeaders = headers.filter((line) => line.startsWith('object '));
    const typeHeaders = headers.filter((line) => line.startsWith('type '));
    const tagHeaders = headers.filter((line) => line.startsWith('tag '));
    const message = raw.slice(separator + 2);
    const envelope = parseHumanResolutionGrantEnvelope(message);
    const payload = envelope.payload;
    if (
      payload.grantId !== observedGrantId ||
      objectHeaders.length !== 1 ||
      objectHeaders[0] !== `object ${payload.trustBaseCommit}` ||
      typeHeaders.length !== 1 ||
      typeHeaders[0] !== 'type commit' ||
      tagHeaders.length !== 1 ||
      tagHeaders[0] !== `tag ${observedRef.slice('refs/tags/'.length)}` ||
      canonicalHumanResolutionGrantEnvelope(envelope) !== message ||
      runGit(repositoryRoot, [
        'rev-parse',
        `${observedRef}^{commit}`,
      ]).trim() !== payload.trustBaseCommit
    ) {
      throw new Error('tag binding mismatch');
    }

    const trustBase = loadMaintainerPolicyForResolution(
      repositoryRoot,
      payload.trustBaseCommit,
    );
    assertHumanResolutionAuditPayload(
      payload,
      policy,
      trustBase.policy,
      trustBase.policyBlob,
      { allowLegacySupersedeReadOnly },
    );
    return envelope;
  } catch {
    throw workflowError(
      'HUMAN_RESOLUTION_AUDIT_TAG_INVALID',
      `Human-resolution audit tag ${observedRef} is malformed or noncanonical.`,
      ExitCode.guard,
    );
  }
}

export function assertMaintainerGrantId(requestedGrantId: string): string {
  if (
    typeof requestedGrantId !== 'string' ||
    !GRANT_ID.test(requestedGrantId)
  ) {
    throw invalidGrant('Maintainer grant ID is invalid.');
  }
  return requestedGrantId;
}

export function parseMaintainerGrantEnvelope(
  raw: string,
): MaintainerGrantEnvelope {
  try {
    if (typeof raw !== 'string' || raw.length > 32_768) {
      throw new Error('invalid envelope size');
    }
    const value = JSON.parse(raw) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !hasExactKeys(value as Record<string, unknown>, ['payload', 'signature'])
    ) {
      throw new Error('invalid envelope');
    }
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.payload !== 'object' ||
      candidate.payload === null ||
      Array.isArray(candidate.payload) ||
      !hasExactKeys(
        candidate.payload as Record<string, unknown>,
        PAYLOAD_KEYS,
      ) ||
      typeof candidate.signature !== 'string'
    ) {
      throw new Error('invalid envelope fields');
    }
    const envelope = {
      payload: candidate.payload as MaintainerGrantPayload,
      signature: candidate.signature,
    };
    assertArmoredSshSignature(envelope.signature);
    assertMaintainerGrantId(envelope.payload.grantId);
    if (canonicalGrantEnvelope(envelope) !== raw) {
      throw new Error('non-canonical envelope');
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
    throw invalidGrant('Maintainer grant envelope is invalid.');
  }
}

export function issueMaintainerGrant(
  _cwd: string,
  _request: MaintainerGrantRequest,
  _options: MaintainerGrantIssueOptions = {},
): MaintainerGrantIssueResult {
  throw workflowError(
    'LEGACY_GRANT_V1_NEW_SIGNING_DISABLED',
    'New V1 grant signing is disabled; V1 records are historical read-only evidence.',
    ExitCode.guard,
  );
}

export function issueHumanResolutionGrant(
  cwd: string,
  request: HumanResolutionGrantRequest,
  options: HumanResolutionGrantIssueOptions = {},
): HumanResolutionGrantIssueResult {
  const repository = discoverRepository(cwd);
  const policy = loadBasePolicy(repository.repositoryRoot, repository.head);
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
  const context = loadInvestigationRuntimeContext(repository.repositoryRoot);
  assertHumanResolutionLifecycleBarrier(context.lifecycleRuntime.root);
  const session = readInvestigationSession(
    context.runtime,
    request.investigationId,
  );
  if (
    readActiveHumanResolutionJournal(context.runtime, session.changeId) !== null
  ) {
    throw workflowError(
      'HUMAN_RESOLUTION_RECOVERY_REQUIRED',
      'An active human-resolution transaction must be recovered before another grant is issued.',
      ExitCode.conflict,
    );
  }
  const decision = assertHumanResolutionDecision(request.decision);
  const state =
    decision.kind === 'quarantine'
      ? inspectInvestigationQuarantineState(
          context.runtime,
          request.investigationId,
          policy.repository.id,
        )
      : inspectInvestigationResolutionState(
          context.runtime,
          request.investigationId,
          policy.repository.id,
        );
  const consequences = assertHumanResolutionConsequences(request.consequences);
  assertResolutionDecisionAvailable(state, decision);
  assertResolutionDecisionTarget(context.runtime, state, decision);
  const ttlMinutes = request.ttlMinutes ?? policy.maxTtlMinutes;
  if (
    !Number.isInteger(ttlMinutes) ||
    ttlMinutes < 1 ||
    ttlMinutes > policy.maxTtlMinutes
  ) {
    throw humanResolutionGrantInvalid(
      'Human resolution grant bounds exceed trusted policy.',
    );
  }
  if (!validReason(request.rationale)) {
    throw humanResolutionGrantInvalid(
      'Human resolution rationale is malformed.',
    );
  }
  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) {
    throw humanResolutionGrantInvalid(
      'Human resolution grant issue time is invalid.',
    );
  }
  const grantId = options.grantId ?? crypto.randomUUID();
  if (!GRANT_ID.test(grantId)) {
    throw humanResolutionGrantInvalid('Human resolution grant ID is invalid.');
  }
  const tagRef = `${policy.auditTagPrefix}resolution-${grantId}`;
  if (
    runGit(
      repository.repositoryRoot,
      ['rev-parse', '--verify', tagRef],
      true,
    ).trim()
  ) {
    throw grantExists(grantId);
  }
  const signer =
    options.signer ??
    createInteractiveSshSigner(repository.repositoryRoot, policy);
  signer.assertHumanPresent();
  const signerIdentity = signer.identity();
  const policyBlob = runGit(repository.repositoryRoot, [
    'rev-parse',
    `${repository.head}:workflow/maintainer-policy.json`,
  ]).trim();
  const blockerBinding = humanResolutionBlockerBinding(state);
  const payload: HumanResolutionGrantPayload = {
    version: 1,
    grantId,
    repositoryId: policy.repository.id,
    repositoryOrigin: policy.repository.origin,
    trustBaseCommit: repository.head,
    policyBlob,
    target: {
      workflowKind: 'investigation',
      changeId: state.envelope.changeId,
      workflowId: state.envelope.investigationId,
    },
    expected: {
      ...blockerBinding,
      stateDigest: state.currentStateDigest,
      currentRefDigest: state.currentRefDigest,
    },
    decision,
    consequences,
    rationale: request.rationale,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
    maxUses: 1,
    signer: signerIdentity,
  };
  validateHumanResolutionGrantPayload(payload, policy, {
    now,
    expectedTrustBase: repository.head,
    expectedPolicyBlob: policyBlob,
    state,
  });
  const canonicalPayload = canonicalHumanResolutionGrantPayload(payload);
  const signature = signer.sign(
    canonicalPayload,
    HUMAN_RESOLUTION_SIGNATURE_NAMESPACE,
  );
  assertArmoredSshSignature(signature);
  signer.verify(
    canonicalPayload,
    signature,
    signerIdentity,
    HUMAN_RESOLUTION_SIGNATURE_NAMESPACE,
  );
  const envelope = { payload, signature };
  const canonicalEnvelope = canonicalHumanResolutionGrantEnvelope(envelope);
  const { availableTokenPath } = withRepositoryLifecycleOperation(
    context.lifecycleRuntime,
    (assertOwned) => {
      const currentRepository = discoverRepository(repository.repositoryRoot);
      if (
        currentRepository.head !== repository.head ||
        currentRepository.tree !== repository.tree
      ) {
        throw humanResolutionGrantInvalid(
          'Repository baseline changed before human resolution grant publication.',
        );
      }
      const currentState =
        decision.kind === 'quarantine'
          ? inspectInvestigationQuarantineState(
              context.runtime,
              request.investigationId,
              policy.repository.id,
            )
          : inspectInvestigationResolutionState(
              context.runtime,
              request.investigationId,
              policy.repository.id,
            );
      if (currentState.currentStateDigest !== state.currentStateDigest) {
        throw humanResolutionGrantInvalid(
          'Investigation state changed before human resolution grant publication.',
        );
      }
      assertOwned();
      const stored = storeAvailableHumanResolutionGrant(
        context.runtime,
        grantId,
        canonicalEnvelope,
      );
      let tagObject: string | undefined;
      try {
        assertOwned();
        tagObject = createMaintainerAuditTag(
          repository.repositoryRoot,
          repository.head,
          tagRef,
          canonicalEnvelope,
          signerIdentity,
        );
        assertOwned();
        return { availableTokenPath: stored };
      } catch (error) {
        if (tagObject !== undefined) {
          try {
            runGit(repository.repositoryRoot, [
              'update-ref',
              '-d',
              tagRef,
              tagObject,
            ]);
          } catch {
            throw humanResolutionGrantPublicationRecoveryRequired();
          }
        } else if (
          runGit(
            repository.repositoryRoot,
            ['rev-parse', '--verify', tagRef],
            true,
          ).trim()
        ) {
          throw humanResolutionGrantPublicationRecoveryRequired();
        }
        let rollback: ReturnType<typeof rollbackAvailableHumanResolutionGrant>;
        try {
          rollback = rollbackAvailableHumanResolutionGrant(
            context.runtime,
            grantId,
            canonicalEnvelope,
          );
        } catch {
          throw humanResolutionGrantPublicationRecoveryRequired();
        }
        if (rollback !== 'removed') {
          throw humanResolutionGrantPublicationRecoveryRequired();
        }
        throw error;
      }
    },
  );
  return {
    grantId,
    tagRef,
    publishCommand: authorityTagPublishCommand(
      policy.repository.origin,
      tagRef,
    ),
    availableTokenPath,
    envelope,
    state,
  };
}

function humanResolutionGrantPublicationRecoveryRequired() {
  return workflowError(
    'HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_REQUIRED',
    'Human resolution grant publication could not safely reconcile its audit tag and local token.',
    ExitCode.unsafeEnvironment,
  );
}

export function validateHumanResolutionGrantPayload(
  payload: HumanResolutionGrantPayload,
  policy: MaintainerPolicy,
  options: HumanResolutionGrantValidationOptions,
): void {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    !hasExactKeys(
      payload as unknown as Record<string, unknown>,
      HUMAN_RESOLUTION_PAYLOAD_KEYS,
    ) ||
    payload.version !== 1 ||
    !GRANT_ID.test(payload.grantId) ||
    payload.repositoryId !== policy.repository.id ||
    payload.repositoryOrigin !== policy.repository.origin ||
    !COMMIT_OID.test(payload.trustBaseCommit) ||
    payload.trustBaseCommit !== options.expectedTrustBase ||
    !COMMIT_OID.test(payload.policyBlob) ||
    payload.policyBlob !== options.expectedPolicyBlob ||
    payload.maxUses !== 1 ||
    !validReason(payload.rationale) ||
    !policy.trustedSigners.some(({ identity }) => identity === payload.signer)
  ) {
    throw humanResolutionGrantInvalid(
      'Human resolution grant does not match its trusted binding.',
    );
  }
  let decision: HumanResolutionDecision;
  let consequences: HumanResolutionConsequences;
  try {
    decision = assertHumanResolutionDecision(payload.decision);
    consequences = assertHumanResolutionConsequences(payload.consequences);
  } catch {
    throw humanResolutionGrantInvalid(
      'Human resolution grant carries an invalid decision.',
    );
  }
  if (
    payload.target.workflowKind !== 'investigation' ||
    payload.target.changeId !== options.state.envelope.changeId ||
    payload.target.workflowId !== options.state.envelope.investigationId ||
    payload.expected.stateDigest !== options.state.currentStateDigest ||
    payload.expected.currentRefDigest !== options.state.currentRefDigest
  ) {
    throw workflowError(
      'HUMAN_RESOLUTION_GRANT_STALE',
      'Human resolution grant is not bound to the exact current state.',
      ExitCode.staleState,
    );
  }
  const blockerBinding = humanResolutionBlockerBinding(options.state);
  if (
    payload.expected.reasonCode !== blockerBinding.reasonCode ||
    payload.expected.blockedTransition !== blockerBinding.blockedTransition
  ) {
    throw workflowError(
      'HUMAN_RESOLUTION_GRANT_BLOCKER_MISMATCH',
      'Human resolution grant names another blocker or transition.',
      ExitCode.staleState,
    );
  }
  assertResolutionDecisionAvailable(options.state, decision);
  assertResolutionConsequences(decision, consequences);
  const issuedAt = exactTimestamp(payload.issuedAt);
  const expiresAt = exactTimestamp(payload.expiresAt);
  const now = options.now.getTime();
  if (
    issuedAt === undefined ||
    expiresAt === undefined ||
    issuedAt > expiresAt ||
    expiresAt - issuedAt > policy.maxTtlMinutes * 60_000 ||
    issuedAt > now + 30_000
  ) {
    throw humanResolutionGrantInvalid(
      'Human resolution grant has invalid time bounds.',
    );
  }
  if (!options.allowExpired && expiresAt < now) {
    throw workflowError(
      'HUMAN_RESOLUTION_GRANT_EXPIRED',
      'Human resolution grant has expired.',
      ExitCode.staleState,
    );
  }
}

function assertHumanResolutionAuditPayload(
  payload: HumanResolutionGrantPayload,
  policy: MaintainerPolicy,
  trustBasePolicy: MaintainerPolicy,
  expectedPolicyBlob: string,
  options: { allowLegacySupersedeReadOnly?: boolean } = {},
): void {
  const target = payload.target as unknown as Record<string, unknown>;
  const expected = payload.expected as unknown as Record<string, unknown>;
  const pinnedSigner = policy.trustedSigners.find(
    ({ identity }) => identity === payload.signer,
  );
  const trustBaseSigner = trustBasePolicy.trustedSigners.find(
    ({ identity }) => identity === payload.signer,
  );
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    !hasExactKeys(
      payload as unknown as Record<string, unknown>,
      HUMAN_RESOLUTION_PAYLOAD_KEYS,
    ) ||
    payload.version !== 1 ||
    !GRANT_ID.test(payload.grantId) ||
    payload.repositoryId !== policy.repository.id ||
    payload.repositoryOrigin !== policy.repository.origin ||
    trustBasePolicy.repository.id !== policy.repository.id ||
    trustBasePolicy.repository.origin !== policy.repository.origin ||
    trustBasePolicy.auditTagPrefix !== policy.auditTagPrefix ||
    !COMMIT_OID.test(payload.trustBaseCommit) ||
    !COMMIT_OID.test(payload.policyBlob) ||
    payload.policyBlob !== expectedPolicyBlob ||
    payload.maxUses !== 1 ||
    !validReason(payload.rationale) ||
    !pinnedSigner ||
    !trustBaseSigner ||
    pinnedSigner.publicKey !== trustBaseSigner.publicKey ||
    pinnedSigner.fingerprint !== trustBaseSigner.fingerprint ||
    typeof target !== 'object' ||
    target === null ||
    Array.isArray(target) ||
    !hasExactKeys(target, ['workflowKind', 'changeId', 'workflowId']) ||
    target.workflowKind !== 'investigation' ||
    typeof target.changeId !== 'string' ||
    typeof target.workflowId !== 'string' ||
    typeof expected !== 'object' ||
    expected === null ||
    Array.isArray(expected) ||
    !hasExactKeys(expected, [
      'reasonCode',
      'blockedTransition',
      'stateDigest',
      'currentRefDigest',
    ]) ||
    !validBoundedText(expected.reasonCode, 256) ||
    !validBoundedText(expected.blockedTransition, 256) ||
    typeof expected.stateDigest !== 'string' ||
    !DIGEST.test(expected.stateDigest) ||
    (expected.currentRefDigest !== null &&
      (typeof expected.currentRefDigest !== 'string' ||
        !DIGEST.test(expected.currentRefDigest)))
  ) {
    throw humanResolutionGrantInvalid(
      'Human resolution audit grant does not match its trusted binding.',
    );
  }

  try {
    assertChangeId(target.changeId);
    assertInvestigationId(target.workflowId);
    const consequences = assertHumanResolutionConsequences(
      payload.consequences,
    );
    try {
      const decision = assertHumanResolutionDecision(payload.decision);
      assertResolutionConsequences(decision, consequences);
    } catch (error) {
      if (!options.allowLegacySupersedeReadOnly) {
        throw error;
      }
      assertLegacySupersedeHumanResolutionDecisionReadOnly(payload.decision);
      if (
        consequences.continuity !== 'broken' ||
        consequences.assurance !== 'degraded'
      ) {
        throw error;
      }
    }
  } catch {
    throw humanResolutionGrantInvalid(
      'Human resolution audit grant carries an invalid decision.',
    );
  }

  const issuedAt = exactTimestamp(payload.issuedAt);
  const expiresAt = exactTimestamp(payload.expiresAt);
  const maximumTtl =
    Math.min(policy.maxTtlMinutes, trustBasePolicy.maxTtlMinutes) * 60_000;
  if (
    issuedAt === undefined ||
    expiresAt === undefined ||
    issuedAt > expiresAt ||
    expiresAt - issuedAt > maximumTtl
  ) {
    throw humanResolutionGrantInvalid(
      'Human resolution audit grant has invalid time bounds.',
    );
  }
}

export function verifyHumanResolutionGrantEnvelope(
  repositoryRoot: string,
  envelope: HumanResolutionGrantEnvelope,
  policy: MaintainerPolicy,
  verifier?: MaintainerSignerProvider,
): void {
  assertHumanResolutionDecision(envelope.payload.decision);
  const signer = verifier ?? createInteractiveSshSigner(repositoryRoot, policy);
  signer.verify(
    canonicalHumanResolutionGrantPayload(envelope.payload),
    envelope.signature,
    envelope.payload.signer,
    HUMAN_RESOLUTION_SIGNATURE_NAMESPACE,
  );
}

export function verifyHumanResolutionGrantForRevocation(
  repositoryRoot: string,
  envelope: HumanResolutionGrantEnvelope,
  verifier?: MaintainerSignerProvider,
): void {
  const trustBase = loadMaintainerPolicyForResolution(
    repositoryRoot,
    envelope.payload.trustBaseCommit,
  );
  assertHumanResolutionAuditPayload(
    envelope.payload,
    trustBase.policy,
    trustBase.policy,
    trustBase.policyBlob,
  );
  const signer =
    verifier ?? createInteractiveSshSigner(repositoryRoot, trustBase.policy);
  signer.verify(
    canonicalHumanResolutionGrantPayload(envelope.payload),
    envelope.signature,
    envelope.payload.signer,
    HUMAN_RESOLUTION_SIGNATURE_NAMESPACE,
  );
}

export function verifyLegacyHumanResolutionGrantEnvelopeReadOnly(
  repositoryRoot: string,
  envelope: HumanResolutionGrantEnvelope,
  policy: MaintainerPolicy,
  verifier?: MaintainerSignerProvider,
): {
  grantId: string;
  mode: 'historical-read-only';
  signatureValid: true;
} {
  assertMaintainerGrantId(envelope.payload.grantId);
  assertLegacySupersedeHumanResolutionDecisionReadOnly(
    envelope.payload.decision,
  );
  const signer = verifier ?? createInteractiveSshSigner(repositoryRoot, policy);
  signer.verify(
    canonicalHumanResolutionGrantPayload(envelope.payload),
    envelope.signature,
    envelope.payload.signer,
    HUMAN_RESOLUTION_SIGNATURE_NAMESPACE,
  );
  return {
    grantId: envelope.payload.grantId,
    mode: 'historical-read-only',
    signatureValid: true,
  };
}

export function assertHumanResolutionAuditTag(
  repositoryRoot: string,
  envelope: HumanResolutionGrantEnvelope,
  policy: MaintainerPolicy,
): void {
  const tagRef = `${policy.auditTagPrefix}resolution-${envelope.payload.grantId}`;
  try {
    const observed = readHumanResolutionAuditTag(
      repositoryRoot,
      policy,
      tagRef,
    );
    if (
      observed === null ||
      canonicalHumanResolutionGrantEnvelope(observed) !==
        canonicalHumanResolutionGrantEnvelope(envelope)
    ) {
      throw new Error('audit mismatch');
    }
  } catch {
    throw workflowError(
      'HUMAN_RESOLUTION_AUDIT_TAG_INVALID',
      'The exact human-resolution audit tag is missing or different.',
      ExitCode.guard,
    );
  }
}

export function loadMaintainerPolicyForResolution(
  repositoryRoot: string,
  trustBaseCommit: string,
): { policy: MaintainerPolicy; policyBlob: string } {
  return {
    policy: loadBasePolicy(repositoryRoot, trustBaseCommit),
    policyBlob: runGit(repositoryRoot, [
      'rev-parse',
      `${trustBaseCommit}:workflow/maintainer-policy.json`,
    ]).trim(),
  };
}

export function validateGrantPayload(
  payload: MaintainerGrantPayload,
  policy: MaintainerPolicy,
  options: GrantValidationOptions,
): void {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    !hasExactKeys(
      payload as unknown as Record<string, unknown>,
      PAYLOAD_KEYS,
    ) ||
    payload.version !== 1 ||
    !GRANT_ID.test(payload.grantId) ||
    payload.repositoryId !== policy.repository.id ||
    payload.repositoryOrigin !== policy.repository.origin ||
    !COMMIT_OID.test(payload.baseCommit) ||
    payload.baseCommit !== options.expectedBase ||
    !COMMIT_OID.test(payload.policyBlob) ||
    payload.policyBlob !== options.expectedPolicyBlob ||
    payload.maxUses !== policy.maxUses ||
    !Array.isArray(payload.allowedPaths) ||
    payload.allowedPaths.length === 0 ||
    !validReason(payload.reason) ||
    !policy.trustedSigners.some(({ identity }) => identity === payload.signer)
  ) {
    throw invalidGrant('Maintainer grant does not match its trusted binding.');
  }

  try {
    assertChangeId(payload.changeId);
    const normalized = payload.allowedPaths.map(normalizeExactRepositoryPath);
    if (
      normalized.some(
        (value, index) => value !== payload.allowedPaths[index],
      ) ||
      !isSortedUnique(normalized) ||
      normalized.some((filePath) => !isAuthorityPathEligible(policy, filePath))
    ) {
      throw new Error('invalid paths');
    }
  } catch {
    throw invalidGrant('Maintainer grant contains invalid exact paths.');
  }

  const issuedAt = exactTimestamp(payload.issuedAt);
  const expiresAt = exactTimestamp(payload.expiresAt);
  const now = options.now.getTime();
  if (
    issuedAt === undefined ||
    expiresAt === undefined ||
    issuedAt > expiresAt ||
    expiresAt - issuedAt > policy.maxTtlMinutes * 60_000 ||
    issuedAt > now + 30_000
  ) {
    throw invalidGrant('Maintainer grant has invalid time bounds.');
  }
  if (!options.allowExpired && expiresAt < now) {
    throw workflowError(
      'MAINTAINER_GRANT_EXPIRED',
      'Maintainer grant has expired.',
      ExitCode.staleState,
    );
  }
}

export function assertGrantPathsEligible(
  repositoryRoot: string,
  requestedPaths: string[],
  policy: MaintainerPolicy,
): string[] {
  let paths: string[];
  try {
    paths = requestedPaths.map(normalizeExactRepositoryPath);
  } catch {
    throw invalidGrantPath();
  }
  if (paths.length === 0 || !isSortedUnique(paths)) {
    throw invalidGrantPath();
  }

  const tracked = runGit(repositoryRoot, ['ls-files', '--cached', '-z', '--'])
    .split('\0')
    .filter(Boolean);
  const caseFolded = new Map<string, string[]>();
  for (const trackedPath of tracked) {
    const key = trackedPath.toLocaleLowerCase('en-US');
    caseFolded.set(key, [...(caseFolded.get(key) ?? []), trackedPath]);
  }

  for (const filePath of paths) {
    const candidates =
      caseFolded.get(filePath.toLocaleLowerCase('en-US')) ?? [];
    const absolute = path.join(repositoryRoot, filePath);
    const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
    try {
      assertPolicyPathInsideRepository(repositoryRoot, filePath);
    } catch {
      throw invalidGrantPath(filePath);
    }
    if (
      candidates.length !== 1 ||
      candidates[0] !== filePath ||
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(absolute) !==
        path.join(fs.realpathSync(repositoryRoot), filePath) ||
      !isAuthorityPathEligible(policy, filePath)
    ) {
      throw invalidGrantPath(filePath);
    }
  }
  return paths;
}

function exactTimestamp(value: string): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value
    ? time
    : undefined;
}

function loadBasePolicy(
  repositoryRoot: string,
  baseCommit: string,
): MaintainerPolicy {
  try {
    return parseMaintainerPolicy(
      JSON.parse(
        runGit(repositoryRoot, [
          'show',
          `${baseCommit}:workflow/maintainer-policy.json`,
        ]),
      ),
    );
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      throw error;
    }
    throw workflowError(
      'MAINTAINER_POLICY_INVALID',
      'The base commit does not contain a valid maintainer policy.',
      ExitCode.guard,
    );
  }
}

function assertArmoredSshSignature(signature: string): void {
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

export function createMaintainerAuditTag(
  repositoryRoot: string,
  baseCommit: string,
  tagRef: string,
  message: string,
  signerIdentity: string,
): string {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-grant-tag-'),
  );
  fs.chmodSync(temporaryDirectory, 0o700);
  const messagePath = path.join(temporaryDirectory, 'message');
  try {
    fs.writeFileSync(messagePath, message, { encoding: 'utf8', mode: 0o600 });
    const shortName = tagRef.slice('refs/tags/'.length);
    runGitWithEnvironment(
      repositoryRoot,
      [
        'tag',
        '--annotate',
        '--cleanup=verbatim',
        '--file',
        messagePath,
        shortName,
        baseCommit,
      ],
      {
        GIT_COMMITTER_NAME: signerIdentity,
        GIT_COMMITTER_EMAIL: 'workflow-maintainer@users.noreply.github.com',
      },
    );
    return runGit(repositoryRoot, ['rev-parse', `${tagRef}^{tag}`]).trim();
  } catch (error) {
    if (isPostApprovalAdmissionFailure(error)) throw error;
    if (
      runGit(repositoryRoot, ['rev-parse', '--verify', tagRef], true).trim()
    ) {
      throw grantExists(tagRef.slice(policyTagPrefixLength(tagRef)));
    }
    throw error;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function policyTagPrefixLength(tagRef: string): number {
  return tagRef.lastIndexOf('/') + 1;
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

function validBoundedText(value: unknown, maxBytes: number): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    Buffer.byteLength(value, 'utf8') <= maxBytes &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159);
    })
  );
}

function humanResolutionBlockerBinding(
  state: InvestigationResolutionState,
): Pick<HumanResolutionExpectedState, 'reasonCode' | 'blockedTransition'> {
  const blocker = state.blocker;
  if (blocker === null) {
    return {
      reasonCode: 'HUMAN_ROOT_DECISION_REQUESTED',
      blockedTransition: 'workflow-state',
    };
  }
  if (!('code' in blocker)) {
    return {
      reasonCode: blocker.reasonCode,
      blockedTransition: blocker.blockedTransition,
    };
  }
  return {
    reasonCode: blocker.code,
    blockedTransition: 'workflow-state',
  };
}

function assertResolutionDecisionAvailable(
  state: InvestigationResolutionState,
  decision: HumanResolutionDecision,
): void {
  const advertised = state.availableResolutions.find(
    ({ kind }) => kind === decision.kind,
  );
  if (
    !advertised ||
    advertised.parameterSchemaDigest !==
      humanResolutionDecisionSchemaDigest(decision.kind)
  ) {
    throw humanResolutionGrantInvalid(
      'The selected decision is not executable from the bound state.',
    );
  }
}

function assertResolutionDecisionTarget(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  state: InvestigationResolutionState,
  decision: HumanResolutionDecision,
): void {
  const successor =
    decision.kind === 'repair'
      ? decision.parameters.successorInvestigationId
      : decision.kind === 'supersede'
        ? decision.parameters.successorInvestigationId
        : null;
  if (successor === null) {
    return;
  }
  const session = readInvestigationSession(paths, successor);
  if (
    session.changeId !== state.envelope.changeId ||
    successor === state.envelope.investigationId
  ) {
    throw humanResolutionGrantInvalid(
      'A resolution successor must be a different readable investigation for the same change.',
    );
  }
}

function assertResolutionConsequences(
  decision: HumanResolutionDecision,
  consequences: HumanResolutionConsequences,
): void {
  switch (decision.kind) {
    case 'resume-with-capability':
      if (
        consequences.continuity !== 'preserved' ||
        consequences.assurance !== 'unchanged' ||
        consequences.claimsWaived.length !== 0
      ) {
        throw humanResolutionGrantInvalid(
          'An additional bounded capability must preserve continuity without changing assurance.',
        );
      }
      return;
    case 'close-input':
      if (
        consequences.continuity !== 'preserved' ||
        consequences.assurance === 'unchanged' ||
        !consequences.claimsWaived.includes('reviewer-term-incorporation')
      ) {
        throw humanResolutionGrantInvalid(
          'Closing reviewer input must preserve continuity and explicitly downgrade reviewer-term incorporation assurance.',
        );
      }
      return;
    case 'abort':
      if (
        consequences.continuity === 'preserved' ||
        consequences.assurance !== 'degraded'
      ) {
        throw humanResolutionGrantInvalid(
          'Abort must declare non-preserved continuity and degraded assurance.',
        );
      }
      return;
    case 'supersede':
    case 'repair':
      if (
        consequences.continuity !== 'broken' ||
        consequences.assurance !== 'degraded'
      ) {
        throw humanResolutionGrantInvalid(
          'Supersede and repair must declare broken continuity and degraded assurance.',
        );
      }
      return;
    case 'quarantine':
      if (
        consequences.continuity !== 'not-applicable' ||
        consequences.assurance !== 'degraded'
      ) {
        throw humanResolutionGrantInvalid(
          'Quarantine must avoid a continuity claim and declare degraded assurance.',
        );
      }
      return;
    case 'waive-assurance':
      if (
        consequences.continuity !== 'preserved' ||
        consequences.assurance !== 'human-waived' ||
        !consequences.claimsWaived.includes(decision.claim)
      ) {
        throw humanResolutionGrantInvalid(
          'An assurance waiver must preserve continuity while naming and downgrading the waived claim.',
        );
      }
      return;
  }
}

function isSortedUnique(values: string[]): boolean {
  const sorted = [...new Set(values)].sort();
  return (
    values.length === sorted.length && values.every((v, i) => v === sorted[i])
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((v, i) => v === expected[i])
  );
}

function invalidGrant(message: string) {
  return workflowError('MAINTAINER_GRANT_INVALID', message, ExitCode.guard);
}

function humanResolutionGrantInvalid(message: string) {
  return workflowError(
    'HUMAN_RESOLUTION_GRANT_INVALID',
    message,
    ExitCode.guard,
  );
}

function grantExists(grantId: string) {
  return workflowError(
    'MAINTAINER_GRANT_EXISTS',
    `Maintainer grant ${grantId} already has local state or an audit tag.`,
    ExitCode.conflict,
  );
}

function invalidGrantPath(filePath?: string) {
  return workflowError(
    'MAINTAINER_GRANT_PATH_INVALID',
    'Maintainer grant paths must be exact tracked eligible regular files.',
    ExitCode.guard,
    filePath ? { details: { path: filePath } } : {},
  );
}
