import crypto from 'node:crypto';

import { authorityTagPublishCommand } from '../src/authority-relay-command.ts';
import { discoverRepository, runGit } from '../src/git.ts';
import {
  assertHumanResolutionConsequences,
  assertHumanResolutionDecision,
  assertHumanResolutionLifecycleBarrier,
  inspectInvestigationQuarantineState,
  inspectInvestigationResolutionState,
  readActiveHumanResolutionJournal,
  readInvestigationSession,
  storeAvailableHumanResolutionGrant,
} from '../src/investigation-session-store.ts';
import { loadInvestigationRuntimeContext } from '../src/lifecycle-context.ts';
import {
  HUMAN_RESOLUTION_SIGNATURE_NAMESPACE,
  assertResolutionDecisionAvailable,
  assertResolutionDecisionTarget,
  canonicalHumanResolutionGrantEnvelope,
  canonicalHumanResolutionGrantPayload,
  createMaintainerAuditTag,
  humanResolutionBlockerBinding,
  loadMaintainerPolicyForResolution,
  validateHumanResolutionGrantPayload,
  type HumanResolutionGrantEnvelope,
  type HumanResolutionGrantIssueOptions,
  type HumanResolutionGrantIssueResult,
  type HumanResolutionGrantPayload,
  type HumanResolutionGrantRequest,
} from '../src/modules/authority/maintainer-grant.ts';

/**
 * Historical-fixture constructor only. Production V1 issuance is deliberately
 * disabled; legacy verification and recovery tests still need exact old bytes.
 */
export function issueLegacyHumanResolutionGrantFixture(
  cwd: string,
  request: HumanResolutionGrantRequest,
  options: HumanResolutionGrantIssueOptions = {},
): HumanResolutionGrantIssueResult {
  const repository = discoverRepository(cwd);
  const { policy, policyBlob } = loadMaintainerPolicyForResolution(
    repository.repositoryRoot,
    repository.head,
  );
  const origin = runGit(repository.repositoryRoot, [
    'remote',
    'get-url',
    'origin',
  ]).trim();
  if (origin !== policy.repository.origin) {
    throw new Error('legacy fixture repository origin mismatch');
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
    throw new Error('legacy fixture has an active human-resolution journal');
  }

  const decision = assertHumanResolutionDecision(request.decision);
  const consequences = assertHumanResolutionConsequences(request.consequences);
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
  assertResolutionDecisionAvailable(state, decision);
  assertResolutionDecisionTarget(context.runtime, state, decision);

  const ttlMinutes = request.ttlMinutes ?? policy.maxTtlMinutes;
  const now = options.now ? new Date(options.now) : new Date();
  const grantId = options.grantId ?? crypto.randomUUID();
  const signer = options.signer;
  if (signer === undefined) {
    throw new Error('legacy fixture requires an explicit signer');
  }
  signer.assertHumanPresent();
  const signerIdentity = signer.identity();
  const blocker = humanResolutionBlockerBinding(state);
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
      ...blocker,
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
  signer.verify(
    canonicalPayload,
    signature,
    signerIdentity,
    HUMAN_RESOLUTION_SIGNATURE_NAMESPACE,
  );
  const envelope: HumanResolutionGrantEnvelope = { payload, signature };
  const canonicalEnvelope = canonicalHumanResolutionGrantEnvelope(envelope);
  const availableTokenPath = storeAvailableHumanResolutionGrant(
    context.runtime,
    grantId,
    canonicalEnvelope,
  );
  const tagRef = `${policy.auditTagPrefix}resolution-${grantId}`;
  createMaintainerAuditTag(
    repository.repositoryRoot,
    repository.head,
    tagRef,
    canonicalEnvelope,
    signerIdentity,
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
