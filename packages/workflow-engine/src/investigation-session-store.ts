import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  parseAiAdapterPolicyDocument,
  parseLegacyAiAdapterPolicyDocument,
} from './ai-adapter-policy.ts';
import { canonicalJson } from './canonical-json.ts';
import {
  parseClassDisposition,
  type ClassDisposition,
} from './class-disposition.ts';
import type { SampleAudit } from './class-sample-audit.ts';

const SAMPLE_AUDIT_OUTCOMES = new Set([
  'passed',
  'member-misclassified',
  'rationale-wrong',
  'type-wrong',
]);
import { deriveAuthorityAuditRepositoryId } from './authority-audit-ledger.ts';
import {
  exactUnsafePathObservationDigest,
  readEvidenceNode,
  readEvidenceRefs,
  readInvestigationEvidenceRefsClosure,
  observeInvestigationEvidenceRefsAmbiguities,
  resolvePlanReviewInvocationOwner,
  type InvestigationEvidenceRefsClosure,
} from './evidence-object-store.ts';
import { ExitCode, type WorkflowError, workflowError } from './errors.ts';
import { assertReadOnlyProbe } from './execution-core.ts';
import {
  assertHumanRevocationAuthorization,
  authorizeHumanRevocation,
  canonicalHumanRevocationAuthorization,
  digestHumanRevocationSubject,
  type HumanRevocationAuthorization,
  type HumanRevocationOptions,
} from './human-revocation.ts';
import {
  publishPreparedExclusiveLock,
  reclaimDeadPreparedLock,
} from './filesystem-safety.ts';
import type { InvestigationDispositionInput } from './investigation-groups.ts';
import type { InvestigationWhyAnswer } from './investigation-why.ts';
import {
  INVESTIGATION_LIMITS,
  previewInvestigationTermUnion,
  type InvestigationMainTermInput,
  type InvestigationTermKind,
} from './investigation-terms.ts';
import {
  WORKFLOW_SUPERSEDE_REASONS,
  validateWorkflowSupersedeReason,
  type WorkflowSupersedeReason,
} from './intervention-control.ts';
import {
  recreateProviderInvocationRequest,
  type ProviderInvocationRequest,
} from './provider-contracts.ts';
import { inspectProviderInvocationSupersessionRelations } from './provider-invocation-supersession-schema.ts';
import {
  assertDurableProviderExecutionBudgetAuthority,
  validateProviderExecutionBudgetAuthority,
} from './provider-execution-policy-authority.ts';
import {
  providerRetentionArtifact,
  providerRetentionReviewRootArtifact,
  readCompleteProviderRetentionReceipt,
  readProviderRetentionReceipt,
} from './provider-retention-receipt.ts';
import {
  isProposeExemptionInvestigationId,
  readProposeExemptionSession,
  type ProposeExemptionSession,
} from './propose-exemption-store.ts';
import {
  assertChangeId,
  assertInvestigationId,
  assertInvocationId,
  type InvestigationRuntimePaths,
} from './paths.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const PROVIDER_REPAIR_DIGEST = /^sha256:[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CHECKPOINT_ID = /^checkpoint-[0-9a-f]{64}$/;
const ACTIVE_HUMAN_RESOLUTION_JOURNAL = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/;
const ACTIVE_HUMAN_RESOLUTION_JOURNAL_TEMPORARY =
  /^[a-z0-9]+(?:-[a-z0-9]+)*\.json\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const HUMAN_RESOLUTION_GRANT_FILE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const HUMAN_RESOLUTION_GRANT_TEMPORARY =
  /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const MAX_CHECKPOINT_BYTES = 1_048_576;
const MAX_HUMAN_RESOLUTION_BYTES = 1_048_576;
const BLIND_PROVIDER_ROOT_FILES = [
  'execution-policy.json',
  'manifest.json',
  'request.json',
  'state.json',
] as const;
const BLIND_PROVIDER_RUNTIME_FILES = [
  'prompt.json',
  'schema.json',
  'semantic-output.json',
] as const;
const OPTIONAL_PROVIDER_ROOT_FILES = [
  'repair-evidence.json',
  'repair-lineage.json',
] as const;
const HUMAN_RESOLUTION_SCHEMA = 'investigation-human-resolution.v2';
const HUMAN_RESOLUTION_DECISION_SCHEMAS = Object.freeze({
  'resume-with-capability': {
    schemaVersion: 1,
    kind: 'resume-with-capability',
    capability: 'reviewer-term-reopen',
    parameters: { additionalUses: { type: 'integer', minimum: 1, maximum: 1 } },
  },
  'close-input': {
    schemaVersion: 1,
    kind: 'close-input',
    input: 'reviewer-terms',
    parameters: {},
  },
  abort: {
    schemaVersion: 1,
    kind: 'abort',
    parameters: {},
  },
  supersede: {
    schemaVersion: 2,
    kind: 'supersede',
    parameters: {
      successorInvestigationId: {
        type: ['investigation-id', 'null'],
      },
      reason: {
        type: 'enum',
        values: [...WORKFLOW_SUPERSEDE_REASONS],
      },
    },
  },
  quarantine: {
    schemaVersion: 1,
    kind: 'quarantine',
    parameters: {
      reason: { type: 'non-empty-string', maxBytes: 4096 },
    },
  },
  repair: {
    schemaVersion: 1,
    kind: 'repair',
    operation: 'replace-current-investigation-ref',
    parameters: {
      successorInvestigationId: { type: 'investigation-id' },
    },
  },
  'waive-assurance': {
    schemaVersion: 1,
    kind: 'waive-assurance',
    claim: 'reviewer-term-incorporation',
    parameters: {},
  },
});
const NO_FOLLOW_CREATE =
  fs.constants.O_RDWR |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  fs.constants.O_NOFOLLOW;

export type InvestigationSessionState =
  | 'actor-resolution-required'
  | 'human-action-required'
  | 'awaiting-main-terms'
  | 'waiting-for-provider'
  | 'awaiting-group-dispositions'
  | 'awaiting-ledger-answers'
  | 'investigation-sealed';

export type HumanResolutionDecision =
  | {
      kind: 'resume-with-capability';
      capability: 'reviewer-term-reopen';
      parameters: { additionalUses: 1 };
    }
  | {
      kind: 'close-input';
      input: 'reviewer-terms';
      parameters: Record<string, never>;
    }
  | { kind: 'abort'; parameters: Record<string, never> }
  | {
      kind: 'supersede';
      parameters: {
        successorInvestigationId: string | null;
        reason: WorkflowSupersedeReason;
      };
    }
  | {
      kind: 'quarantine';
      parameters: { reason: string };
    }
  | {
      kind: 'repair';
      operation: 'replace-current-investigation-ref';
      parameters: { successorInvestigationId: string };
    }
  | {
      kind: 'waive-assurance';
      claim: 'reviewer-term-incorporation';
      parameters: Record<string, never>;
    };

export type HumanResolutionConsequences = {
  continuity: 'preserved' | 'broken' | 'not-applicable';
  assurance: 'unchanged' | 'human-waived' | 'degraded';
  claimsWaived: string[];
};

export type LegacySupersedeHumanResolutionDecisionReadOnly = {
  kind: 'supersede';
  parameters: { successorInvestigationId: string | null };
};

export type HumanResolutionAvailability = {
  kind: HumanResolutionDecision['kind'];
  parameterSchemaDigest: string;
};

export type InvestigationHumanActionBlocker = {
  schemaVersion: 2;
  state: 'human-action-required';
  reasonCode: string;
  blockedTransition: string;
  enteredAt: string;
  facts: Record<string, unknown>;
  availableResolutions: HumanResolutionAvailability[];
};

export type InvestigationResolutionStateEnvelope = {
  schemaVersion: 2;
  workflowKind: 'investigation';
  repositoryId: string;
  changeId: string;
  investigationId: string;
  sessionDigest: string;
  sessionRevision: number;
  currentRefDigest: string | null;
  startReservationDigest: string | null;
  resolutionHeadNodeId: string | null;
  providerInvocationDigests: Array<{
    invocationId: string;
    files: Array<{ name: string; digest: string }>;
  }>;
  providerRetryReservations: Array<{
    attempt: number;
    previousInvocationId: string;
    invocationId: string;
    reservationDigest: string;
    status: 'committed' | 'pending';
  }>;
  repositoryProviderLeases: Array<{
    invocationId: string;
    investigationId: string;
    changeId: string;
    revision: number;
    leaseGeneration: number;
    leaseDigest: string;
  }>;
  evidenceRefs: Record<string, string> | null;
  evidenceRefsDigest: string | null;
  evidenceRefsClosureDigest: string | null;
  blockerDigest: string | null;
  ambiguityDigest: string | null;
};

export type ProviderInvocationLifecycleProjection = Readonly<{
  invocationId: string;
  investigationId: string;
  ownerInvestigationId: string;
  changeId: string;
  purpose: 'survey' | 'plan-review';
  attempt: number;
  revision: number;
  state: 'prepared' | 'leased' | 'succeeded' | 'failed';
  requestDigest: string;
  manifestDigest: string;
  nonce: string;
  failureKind: 'retryable' | 'repository-reconciliation-required' | null;
  leaseGeneration: number;
  lease: Readonly<{
    generation: number;
    workerId: string;
    tokenDigest: string;
    acquiredAt: string;
    expiresAt: string;
  }> | null;
}>;

export type ProviderInvocationLifecycleScan = Readonly<{
  projections: readonly ProviderInvocationLifecycleProjection[];
  unsafeInvocations: readonly Readonly<{
    invocationId: string;
    ownerInvestigationId: string | null;
    observationDigest: string;
  }>[];
}>;

export type InvestigationResolutionState = {
  envelope: InvestigationResolutionStateEnvelope;
  currentStateDigest: string;
  currentRefDigest: string | null;
  blocker:
    | InvestigationHumanActionBlocker
    | {
        state: 'actor-resolution-required' | 'human-action-required';
        code: string;
      }
    | null;
  availableResolutions: HumanResolutionAvailability[];
  effectiveState:
    | InvestigationSessionState
    | 'aborted-by-human-resolution'
    | 'superseded-by-human-resolution'
    | 'quarantined-by-human-resolution';
};

export type HumanResolutionTarget = {
  workflowKind: 'investigation';
  changeId: string;
  workflowId: string;
};

export type HumanResolutionExpectedState = {
  reasonCode: string;
  blockedTransition: string;
  stateDigest: string;
  currentRefDigest: string | null;
};

export type HumanResolutionNode = {
  schemaVersion: 1;
  kind: 'human-resolution-node';
  nodeId: string;
  target: HumanResolutionTarget;
  expected: HumanResolutionExpectedState;
  decision: HumanResolutionDecision;
  consequences: HumanResolutionConsequences;
  grantId: string;
  grantDigest: string;
  previousResolutionNodeId: string | null;
  createdAt: string;
};

export type HumanResolutionJournal = {
  schemaVersion: 2;
  kind: 'human-resolution-journal';
  journalId: string;
  phase:
    | 'prepared'
    | 'evidence-refs-published'
    | 'start-reservation-published'
    | 'current-ref-published'
    | 'state-published'
    | 'receipt-written'
    | 'grant-consumed';
  grantId: string;
  grantDigest: string;
  target: HumanResolutionTarget;
  beforeStateDigest: string;
  afterStateDigest: string;
  beforeResolutionRef: string | null;
  resolutionRefMode: 'preserve' | 'quarantine-whole';
  plannedResolutionNodeId: string;
  plannedCurrentWorkflowRef: {
    expectedInvestigationId: string | null;
    expectedDigest: string | null;
    nextInvestigationId: string | null;
    nextDigest: string | null;
  };
  plannedStartReservation: {
    mode: 'preserve' | 'retire' | 'quarantine-whole';
    expectedDigest: string | null;
    nextDigest: string | null;
    archiveDigest: string | null;
  };
  plannedEvidenceRefs: {
    mode: 'preserve' | 'partition' | 'quarantine-whole';
    expectedDigest: string | null;
    nextDigest: string | null;
    expectedClosureDigest: string | null;
    nextClosureDigest: string | null;
    retiredRefs: Record<string, string>;
    retainedRefs: Record<string, string>;
    archiveDigest: string | null;
  };
  evidenceArchiveDigest: string;
  receiptDigest: string;
  createdAt: string;
};

export type HumanResolutionGrantStoreEntry = {
  grantId: string;
  state: 'available' | 'reserved' | 'revoked' | 'consumed';
  envelopeBytes: string;
  terminalReason: string | null;
  recordedAt: string | null;
  revocationAuthorization?: HumanRevocationAuthorization;
};

export type HumanResolutionGrantPublicationTemporary = {
  temporaryName: string;
  rawSha256: string;
  unsafeObservationDigest: string;
  byteLength: number;
  parsedEnvelopeGrantId: string | null;
};

export type HumanResolutionGrantPublicationStoreState = {
  grantId: string;
  temporaries: HumanResolutionGrantPublicationTemporary[];
  durable: {
    availableDigest: string | null;
    reservedDigest: string | null;
    terminalDigest: string | null;
  };
  sameGrantJournalDigest: string | null;
  sameGrantActiveJournalDigest: string | null;
  sameGrantReceiptDigest: string | null;
};

export type HumanResolutionGrantPublicationAuditTag = {
  status: 'absent' | 'present';
  tagRef: string | null;
  refObjectOid: string | null;
  objectType: string | null;
};

export type HumanResolutionGrantPublicationStateBinding = {
  auditTag: HumanResolutionGrantPublicationAuditTag;
  publicationStateDigest: string;
};

export type HumanResolutionGrantPublicationStoreInspection = {
  storeState: HumanResolutionGrantPublicationStoreState;
  preparedBinding: HumanResolutionGrantPublicationStateBinding | null;
};

export type QuarantinedHumanResolutionGrantPublication = {
  action: 'quarantined';
  grantId: string;
  publicationStateDigest: string;
};

export type InvestigationCheckpointKind =
  'main-terms' | 'group-dispositions' | 'why-answers';

export type MainTermsPayload = {
  reference: string;
  terms: InvestigationMainTermInput[];
};

export type GroupDispositionsPayload = {
  dispositions: InvestigationDispositionInput[];
  /**
   * Rationales that cover a class of groups at once. The engine expands each
   * into one disposition per member, so what the evidence records is unchanged;
   * what changes is how much an author had to write to say the same thing.
   */
  classes?: ClassDisposition[];
  /**
   * The hand review of the sampled members of each class. Every mechanical
   * guard checks the predicate; this is the part only a person can answer,
   * which is whether the written rationale is true of what those hits do.
   */
  sampleAudits?: SampleAudit[];
};

export type WhyAnswersPayload = {
  answers: InvestigationWhyAnswer[];
};

export type InvestigationCheckpointEnvelope =
  | InvestigationCheckpointEnvelopeBase<'main-terms', MainTermsPayload>
  | InvestigationCheckpointEnvelopeBase<
      'group-dispositions',
      GroupDispositionsPayload
    >
  | InvestigationCheckpointEnvelopeBase<'why-answers', WhyAnswersPayload>;

type InvestigationCheckpointEnvelopeBase<
  Kind extends InvestigationCheckpointKind,
  Payload,
> = {
  schemaVersion: 1;
  kind: Kind;
  checkpointId: string;
  investigationId: string;
  changeId: string;
  expectedRevision: number;
  baseline: {
    head: string;
    tree: string;
  };
  intentDigest: string;
  blindManifestDigest: string;
  payload: Payload;
};

export type StoredInvestigationCheckpoint = {
  envelopeDigest: string;
  contributionDigest: string;
  envelope: InvestigationCheckpointEnvelope;
};

export type BlindResultReference = {
  invocationId: string;
  requestDigest: string;
  outputDigest: string;
};

export type InvestigationSession = {
  schemaVersion: 1;
  investigationId: string;
  revision: number;
  /** Semantic evidence/materialization version; lifecycle-only blockers do not advance it. */
  semanticRevision: number;
  /** Every durable session CAS advances this clock exactly once. */
  lifecycleRevision: number;
  state: InvestigationSessionState;
  changeId: string;
  mandateBinding?: {
    schemaVersion: 1;
    mandateTaskId: string;
    mandateId: string;
    mandateDigest: string;
    changeId: string;
    externalAuditRoot: string;
  };
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string | null;
  baseline: {
    head: string;
    tree: string;
  };
  intentDigest: string;
  blindManifestDigest: string;
  blindRequestDigest: string;
  blindInvocationIds: string[];
  currentBlindInvocationId: string;
  milestones: {
    mainTerms: StoredInvestigationCheckpoint | null;
    blindResult: BlindResultReference | null;
    reviewerTermSourceNodeId: string | null;
    groupDispositions: StoredInvestigationCheckpoint | null;
    whyAnswers: StoredInvestigationCheckpoint | null;
  };
  blocker:
    | {
        state: 'actor-resolution-required' | 'human-action-required';
        code: string;
      }
    | InvestigationHumanActionBlocker
    | null;
  createdAt: string;
  updatedAt: string;
};

type CurrentInvestigationRef = {
  schemaVersion: 1;
  changeId: string;
  investigationId: string;
};

export function createInvestigationId(): string {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '');
  return `investigation-${timestamp}-${crypto.randomUUID()}`;
}

export function investigationCheckpointId(
  session: InvestigationSession,
  kind: InvestigationCheckpointKind,
): string {
  const prerequisites =
    kind === 'main-terms'
      ? {
          blindManifestDigest: session.blindManifestDigest,
          intentDigest: session.intentDigest,
          baseline: session.baseline,
        }
      : kind === 'group-dispositions'
        ? {
            mainTermsDigest:
              session.milestones.mainTerms?.contributionDigest ?? null,
            blindResult: session.milestones.blindResult,
            reviewerTermSourceNodeId:
              session.milestones.reviewerTermSourceNodeId,
          }
        : {
            groupDispositionsDigest:
              session.milestones.groupDispositions?.contributionDigest ?? null,
          };
  return `checkpoint-${sha256(
    canonicalJson({
      schemaVersion: 1,
      investigationId: session.investigationId,
      changeId: session.changeId,
      kind,
      prerequisites,
    }),
  )}`;
}

export function createInvestigationSessionRecord(
  paths: InvestigationRuntimePaths,
  session: InvestigationSession,
): InvestigationSession {
  const validated = assertInvestigationSession(session);
  const sessionPath = investigationSessionPath(
    paths,
    validated.investigationId,
  );
  createPrivateCanonicalJson(
    paths,
    sessionPath,
    validated,
    sessionUnsafe,
    'INVESTIGATION_SESSION_COLLISION',
  );
  return readInvestigationSession(paths, validated.investigationId);
}

export function readInvestigationSession(
  paths: InvestigationRuntimePaths,
  requestedInvestigationId: string,
): InvestigationSession {
  const investigationId = assertInvestigationId(requestedInvestigationId);
  const value = readPrivateCanonicalJson(
    paths,
    investigationSessionPath(paths, investigationId),
    sessionUnsafe,
  );
  const session = assertInvestigationSession(value);
  if (session.investigationId !== investigationId) {
    throw workflowError(
      'INVESTIGATION_SESSION_ID_MISMATCH',
      'Investigation session content does not match its filename.',
      ExitCode.staleState,
    );
  }
  return deepFreeze(structuredClone(session));
}

export function investigationSessionExists(
  paths: InvestigationRuntimePaths,
  requestedInvestigationId: string,
): boolean {
  const investigationId = assertInvestigationId(requestedInvestigationId);
  return privatePathExists(
    paths,
    investigationSessionPath(paths, investigationId),
    sessionUnsafe,
  );
}

export function compareAndSwapInvestigationSession(
  paths: InvestigationRuntimePaths,
  requestedInvestigationId: string,
  expectedRevision: number,
  transition: (current: InvestigationSession) => InvestigationSession,
): InvestigationSession {
  const investigationId = assertInvestigationId(requestedInvestigationId);
  return withPrivateRuntimeLock(
    paths,
    path.join(paths.locks, `${investigationId}.lock`),
    () => {
      const current = readInvestigationSession(paths, investigationId);
      if (current.revision !== expectedRevision) {
        throw investigationCasMismatch(expectedRevision, current.revision);
      }
      const proposed = transition(deepFreeze(structuredClone(current)));
      if (
        proposed.semanticRevision !== current.semanticRevision ||
        proposed.lifecycleRevision !== current.lifecycleRevision
      ) {
        throw sessionTransitionInvalid();
      }
      const next = assertInvestigationSession({
        ...proposed,
        semanticRevision:
          current.semanticRevision +
          (semanticSessionContentChanged(current, proposed) ? 1 : 0),
        lifecycleRevision: current.lifecycleRevision + 1,
      });
      assertMonotonicSessionTransition(current, next);
      writePrivateCanonicalJsonAtomic(
        paths,
        investigationSessionPath(paths, investigationId),
        next,
        sessionUnsafe,
      );
      return readInvestigationSession(paths, investigationId);
    },
    'INVESTIGATION_SESSION_OPERATION_CONFLICT',
    sessionLockInvalid,
  );
}

export function createCurrentInvestigationRef(
  paths: InvestigationRuntimePaths,
  changeId: string,
  investigationId: string,
): void {
  const ref: CurrentInvestigationRef = {
    schemaVersion: 1,
    changeId: assertChangeId(changeId),
    investigationId: assertInvestigationId(investigationId),
  };
  createPrivateCanonicalJson(
    paths,
    currentInvestigationRefPath(paths, ref.changeId),
    ref,
    refUnsafe,
    'CURRENT_INVESTIGATION_CONFLICT',
  );
}

export function readCurrentInvestigationRef(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
): CurrentInvestigationRef | null {
  const changeId = assertChangeId(requestedChangeId);
  const refPath = currentInvestigationRefPath(paths, changeId);
  if (!privatePathExists(paths, refPath, refUnsafe)) {
    return null;
  }
  const value = readPrivateCanonicalJson(paths, refPath, refUnsafe);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'changeId', 'investigationId']) ||
    value.schemaVersion !== 1 ||
    value.changeId !== changeId ||
    typeof value.investigationId !== 'string'
  ) {
    throw refUnsafe();
  }
  assertInvestigationId(value.investigationId);
  return deepFreeze(value as CurrentInvestigationRef);
}

export function compareAndSwapCurrentInvestigationRef(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
  expectedInvestigationId: string | null,
  nextInvestigationId: string | null,
): void {
  const changeId = assertChangeId(requestedChangeId);
  if (expectedInvestigationId !== null) {
    assertInvestigationId(expectedInvestigationId);
  }
  if (nextInvestigationId !== null) {
    assertInvestigationId(nextInvestigationId);
    const next = readInvestigationSession(paths, nextInvestigationId);
    if (next.changeId !== changeId) {
      throw workflowError(
        'CURRENT_INVESTIGATION_REPAIR_INVALID',
        'A replacement current investigation must belong to the same change.',
        ExitCode.guard,
      );
    }
  }
  withPrivateRuntimeLock(
    paths,
    path.join(paths.locks, `${changeId}.current-investigation.lock`),
    () => {
      const observed = readCurrentInvestigationRef(paths, changeId);
      if (
        (observed?.investigationId ?? null) !==
        (expectedInvestigationId ?? null)
      ) {
        throw workflowError(
          'CURRENT_INVESTIGATION_REF_STALE',
          'The current investigation ref no longer matches the authorized state.',
          ExitCode.staleState,
        );
      }
      const refPath = currentInvestigationRefPath(paths, changeId);
      if (nextInvestigationId === null) {
        if (observed !== null) {
          fs.unlinkSync(refPath);
          fsyncDirectory(path.dirname(refPath));
        }
        return;
      }
      writePrivateCanonicalJsonAtomic(
        paths,
        refPath,
        {
          schemaVersion: 1,
          changeId,
          investigationId: nextInvestigationId,
        },
        refUnsafe,
      );
    },
    'CURRENT_INVESTIGATION_OPERATION_CONFLICT',
    refUnsafe,
  );
}

export function quarantineUnsafeCurrentInvestigationRef(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
  expectedObservationDigest: string,
): string {
  const changeId = assertChangeId(requestedChangeId);
  if (!isDigest(expectedObservationDigest)) {
    throw refUnsafe();
  }
  const source = currentInvestigationRefPath(paths, changeId);
  const quarantineDirectory = humanResolutionPaths(paths).quarantine;
  const target = path.join(
    quarantineDirectory,
    `${changeId}.${expectedObservationDigest}.artifact`,
  );
  return withPrivateRuntimeLock(
    paths,
    path.join(paths.locks, `${changeId}.current-investigation.lock`),
    () => {
      if (
        !walkPrivateDirectory(paths, path.dirname(source), refUnsafe, false)
      ) {
        throw workflowError(
          'CURRENT_INVESTIGATION_REF_STALE',
          'The current investigation ref disappeared before quarantine.',
          ExitCode.staleState,
        );
      }
      const sourceStats = fs.lstatSync(source, { throwIfNoEntry: false });
      if (!sourceStats) {
        const targetStats = fs.lstatSync(target, { throwIfNoEntry: false });
        if (
          targetStats &&
          observeUnsafePath(target, 'current-ref', []) ===
            expectedObservationDigest
        ) {
          return target;
        }
        throw workflowError(
          'CURRENT_INVESTIGATION_REF_STALE',
          'The current investigation ref changed before quarantine.',
          ExitCode.staleState,
        );
      }
      if (
        observeUnsafePath(source, 'current-ref', []) !==
        expectedObservationDigest
      ) {
        throw workflowError(
          'CURRENT_INVESTIGATION_REF_STALE',
          'The current investigation ref changed before quarantine.',
          ExitCode.staleState,
        );
      }
      try {
        readCurrentInvestigationRef(paths, changeId);
      } catch {
        // The exact malformed object is the only object this transition moves.
      }
      ensurePrivateInvestigationDirectory(
        paths,
        quarantineDirectory,
        humanResolutionArchiveUnsafe,
      );
      if (fs.lstatSync(target, { throwIfNoEntry: false })) {
        throw workflowError(
          'CURRENT_INVESTIGATION_QUARANTINE_CONFLICT',
          'A different quarantine artifact already occupies the exact target.',
          ExitCode.conflict,
        );
      }
      fs.renameSync(source, target);
      fsyncDirectory(path.dirname(source));
      fsyncDirectory(quarantineDirectory);
      return target;
    },
    'CURRENT_INVESTIGATION_OPERATION_CONFLICT',
    refUnsafe,
  );
}

export function archiveHumanResolutionSingleton(
  paths: InvestigationRuntimePaths,
  kind: 'start-reservation' | 'evidence-refs',
  expectedDigest: string,
  content: string,
  newlineRequired: boolean,
): string {
  if (!isDigest(expectedDigest)) {
    throw humanResolutionRecoveryAmbiguous();
  }
  const targetDirectory = path.join(
    humanResolutionPaths(paths).retiredRefs,
    kind,
  );
  const target = path.join(targetDirectory, `${expectedDigest}.artifact`);
  if (
    sha256(content) !== expectedDigest ||
    !canonicalPrivateContent(content, newlineRequired)
  ) {
    throw humanResolutionRecoveryAmbiguous();
  }
  ensurePrivateInvestigationDirectory(
    paths,
    targetDirectory,
    humanResolutionArchiveUnsafe,
  );
  const targetStats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (targetStats) {
    const targetContent = readPrivateFile(target, humanResolutionArchiveUnsafe);
    if (
      sha256(targetContent) !== expectedDigest ||
      !canonicalPrivateContent(targetContent, newlineRequired) ||
      targetContent !== content
    ) {
      throw humanResolutionRecoveryAmbiguous();
    }
    return expectedDigest;
  }
  createPrivateRawFile(paths, target, content, humanResolutionArchiveUnsafe);
  return expectedDigest;
}

export function quarantineUnsafeInvestigationStartReservation(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
  expectedObservationDigest: string,
): string {
  const changeId = assertChangeId(requestedChangeId);
  if (!isDigest(expectedObservationDigest)) {
    throw humanResolutionRecoveryAmbiguous();
  }
  const object = 'start-reservation';
  const source = investigationStartReservationPath(paths, changeId);
  const sourceDirectory = path.dirname(source);
  const quarantineDirectory = humanResolutionPaths(paths).quarantine;
  const target = path.join(
    quarantineDirectory,
    `${changeId}.${expectedObservationDigest}.start-reservation.artifact`,
  );
  const lockPath = path.join(
    paths.locks,
    `${changeId}.investigation-start.lock`,
  );
  const makeError = startReservationUnsafe;
  return withPrivateRuntimeLock(
    paths,
    lockPath,
    () => {
      if (!walkPrivateDirectory(paths, sourceDirectory, makeError, false)) {
        throw humanResolutionRecoveryAmbiguous();
      }
      const sourceStats = fs.lstatSync(source, { throwIfNoEntry: false });
      if (!sourceStats) {
        const targetStats = fs.lstatSync(target, { throwIfNoEntry: false });
        if (
          targetStats &&
          observeUnsafePath(target, object, []) === expectedObservationDigest
        ) {
          return target;
        }
        throw humanResolutionRecoveryAmbiguous();
      }
      if (observeUnsafePath(source, object, []) !== expectedObservationDigest) {
        throw humanResolutionRecoveryAmbiguous();
      }
      ensurePrivateInvestigationDirectory(
        paths,
        quarantineDirectory,
        humanResolutionArchiveUnsafe,
      );
      if (fs.lstatSync(target, { throwIfNoEntry: false })) {
        throw humanResolutionRecoveryAmbiguous();
      }
      fs.renameSync(source, target);
      fsyncDirectory(sourceDirectory);
      fsyncDirectory(quarantineDirectory);
      if (observeUnsafePath(target, object, []) !== expectedObservationDigest) {
        throw humanResolutionRecoveryAmbiguous();
      }
      return target;
    },
    'HUMAN_RESOLUTION_SINGLETON_OPERATION_CONFLICT',
    makeError,
  );
}

function canonicalPrivateContent(
  content: string,
  newlineRequired: boolean,
): boolean {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return false;
  }
  const canonical = canonicalJson(value);
  return content === (newlineRequired ? `${canonical}\n` : canonical);
}

export function humanResolutionDecisionSchemaDigest(
  kind: HumanResolutionDecision['kind'],
): string {
  return sha256(
    canonicalJson(
      HUMAN_RESOLUTION_DECISION_SCHEMAS[
        kind as keyof typeof HUMAN_RESOLUTION_DECISION_SCHEMAS
      ],
    ),
  );
}

export function assertHumanResolutionDecision(
  value: unknown,
): HumanResolutionDecision {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw humanResolutionInvalid('Human resolution decision is malformed.');
  }
  if (
    value.kind === 'resume-with-capability' &&
    hasExactKeys(value, ['kind', 'capability', 'parameters']) &&
    value.capability === 'reviewer-term-reopen' &&
    isRecord(value.parameters) &&
    hasExactKeys(value.parameters, ['additionalUses']) &&
    value.parameters.additionalUses === 1
  ) {
    return deepFreeze(structuredClone(value)) as HumanResolutionDecision;
  }
  if (
    value.kind === 'close-input' &&
    hasExactKeys(value, ['kind', 'input', 'parameters']) &&
    value.input === 'reviewer-terms' &&
    isEmptyRecord(value.parameters)
  ) {
    return deepFreeze(structuredClone(value)) as HumanResolutionDecision;
  }
  if (
    value.kind === 'abort' &&
    hasExactKeys(value, ['kind', 'parameters']) &&
    isEmptyRecord(value.parameters)
  ) {
    return deepFreeze(structuredClone(value)) as HumanResolutionDecision;
  }
  if (
    value.kind === 'supersede' &&
    hasExactKeys(value, ['kind', 'parameters']) &&
    isRecord(value.parameters) &&
    hasExactKeys(value.parameters, ['successorInvestigationId', 'reason']) &&
    (value.parameters.successorInvestigationId === null ||
      typeof value.parameters.successorInvestigationId === 'string') &&
    typeof value.parameters.reason === 'string'
  ) {
    if (typeof value.parameters.successorInvestigationId === 'string') {
      assertInvestigationId(value.parameters.successorInvestigationId);
    }
    validateWorkflowSupersedeReason(value.parameters.reason);
    return deepFreeze(structuredClone(value)) as HumanResolutionDecision;
  }
  if (
    value.kind === 'quarantine' &&
    hasExactKeys(value, ['kind', 'parameters']) &&
    isRecord(value.parameters) &&
    hasExactKeys(value.parameters, ['reason']) &&
    isBoundedResolutionText(value.parameters.reason, 4096)
  ) {
    return deepFreeze(structuredClone(value)) as HumanResolutionDecision;
  }
  if (
    value.kind === 'repair' &&
    hasExactKeys(value, ['kind', 'operation', 'parameters']) &&
    value.operation === 'replace-current-investigation-ref' &&
    isRecord(value.parameters) &&
    hasExactKeys(value.parameters, ['successorInvestigationId']) &&
    typeof value.parameters.successorInvestigationId === 'string'
  ) {
    assertInvestigationId(value.parameters.successorInvestigationId);
    return deepFreeze(structuredClone(value)) as HumanResolutionDecision;
  }
  if (
    value.kind === 'waive-assurance' &&
    hasExactKeys(value, ['kind', 'claim', 'parameters']) &&
    value.claim === 'reviewer-term-incorporation' &&
    isEmptyRecord(value.parameters)
  ) {
    return deepFreeze(structuredClone(value)) as HumanResolutionDecision;
  }
  throw humanResolutionInvalid('Human resolution decision is unsupported.');
}

/**
 * Parses only the supersede shape signed before a canonical reason was
 * required. The returned value is deliberately not a HumanResolutionDecision:
 * callers may inspect or verify historical bytes, but cannot feed it into a
 * current grant, node, or lifecycle transition.
 */
export function assertLegacySupersedeHumanResolutionDecisionReadOnly(
  value: unknown,
): LegacySupersedeHumanResolutionDecisionReadOnly {
  if (
    !isRecord(value) ||
    value.kind !== 'supersede' ||
    !hasExactKeys(value, ['kind', 'parameters']) ||
    !isRecord(value.parameters) ||
    !hasExactKeys(value.parameters, ['successorInvestigationId']) ||
    (value.parameters.successorInvestigationId !== null &&
      typeof value.parameters.successorInvestigationId !== 'string')
  ) {
    throw humanResolutionInvalid(
      'Legacy supersede decision is not a read-only historical record.',
    );
  }
  if (typeof value.parameters.successorInvestigationId === 'string') {
    assertInvestigationId(value.parameters.successorInvestigationId);
  }
  return deepFreeze(
    structuredClone(value),
  ) as LegacySupersedeHumanResolutionDecisionReadOnly;
}

export function assertHumanResolutionConsequences(
  value: unknown,
): HumanResolutionConsequences {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['continuity', 'assurance', 'claimsWaived']) ||
    !['preserved', 'broken', 'not-applicable'].includes(
      String(value.continuity),
    ) ||
    !['unchanged', 'human-waived', 'degraded'].includes(
      String(value.assurance),
    ) ||
    !isStringArray(value.claimsWaived) ||
    !isSortedUniqueStrings(value.claimsWaived) ||
    value.claimsWaived.some((claim) => !isBoundedResolutionText(claim, 256))
  ) {
    throw humanResolutionInvalid(
      'Human resolution consequences are malformed.',
    );
  }
  return deepFreeze(structuredClone(value)) as HumanResolutionConsequences;
}

export function listProviderInvocationLifecycleProjections(
  paths: InvestigationRuntimePaths,
): ProviderInvocationLifecycleProjection[] {
  const scan = scanProviderInvocationLifecycles(paths);
  const unsafeInvocations = scan.unsafeInvocations.filter(
    ({ invocationId }) =>
      !isDurablyReservedProviderExecutionPolicySnapshot(paths, invocationId),
  );
  if (unsafeInvocations.length > 0) {
    throw providerInvocationUnsafe();
  }
  return [...scan.projections];
}

export function scanProviderInvocationLifecycles(
  paths: InvestigationRuntimePaths,
): ProviderInvocationLifecycleScan {
  const stats = fs.lstatSync(paths.invocations, { throwIfNoEntry: false });
  if (!stats) {
    return deepFreeze({ projections: [], unsafeInvocations: [] });
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    !walkPrivateDirectory(
      paths,
      paths.invocations,
      providerInvocationUnsafe,
      false,
    )
  ) {
    throw providerInvocationUnsafe();
  }
  const projections: ProviderInvocationLifecycleProjection[] = [];
  const unsafeInvocations: Array<{
    invocationId: string;
    ownerInvestigationId: string | null;
    observationDigest: string;
  }> = [];
  for (const entry of fs
    .readdirSync(paths.invocations, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw providerInvocationUnsafe();
    }
    const invocationId = assertInvocationId(entry.name);
    try {
      projections.push(
        readProviderInvocationLifecycleProjection(paths, invocationId),
      );
    } catch {
      unsafeInvocations.push({
        invocationId,
        ownerInvestigationId: tryReadPlanReviewInvocationOwnerHint(
          paths,
          invocationId,
        ),
        observationDigest: exactUnsafePathObservationDigest(
          path.join(paths.invocations, invocationId),
          `provider-invocation:${invocationId}`,
        ),
      });
    }
  }
  return deepFreeze({
    projections,
    unsafeInvocations,
  });
}

function tryReadPlanReviewInvocationOwnerHint(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): string | null {
  try {
    const directory = path.join(paths.invocations, invocationId);
    const request = recreateProviderInvocationRequest(
      readPrivateCanonicalJson(
        paths,
        path.join(directory, 'request.json'),
        providerInvocationUnsafe,
      ),
    );
    const manifest = readPrivateCanonicalJson(
      paths,
      path.join(directory, 'manifest.json'),
      providerInvocationUnsafe,
    );
    if (
      request.purpose !== 'plan-review' ||
      !isRecord(manifest) ||
      manifest.kind !== 'plan-review-manifest' ||
      typeof manifest.changeId !== 'string'
    ) {
      return null;
    }
    return resolvePlanReviewInvocationOwner(paths, {
      changeId: String(manifest.changeId),
      subject: manifest.subject,
      assignment: request.roleAssignment,
      authorizationNodeId: request.authorizationNodeId,
    });
  } catch {
    return null;
  }
}

export function readProviderInvocationLifecycleProjection(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
): ProviderInvocationLifecycleProjection {
  const invocationId = assertInvocationId(requestedInvocationId);
  const directory = path.join(paths.invocations, invocationId);
  const value = readPrivateCanonicalJson(
    paths,
    path.join(directory, 'state.json'),
    providerInvocationUnsafe,
  );
  const requestValue = readPrivateCanonicalJson(
    paths,
    path.join(directory, 'request.json'),
    providerInvocationUnsafe,
  );
  const manifest = readPrivateCanonicalJson(
    paths,
    path.join(directory, 'manifest.json'),
    providerInvocationUnsafe,
  );
  let request: ProviderInvocationRequest;
  try {
    request = recreateProviderInvocationRequest(requestValue);
  } catch {
    throw providerInvocationUnsafe();
  }
  assertProviderExecutionPolicySnapshot(
    paths,
    readPrivateCanonicalJson(
      paths,
      path.join(directory, 'execution-policy.json'),
      providerInvocationUnsafe,
    ),
    request,
  );
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'invocationId',
      'investigationId',
      'changeId',
      ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
        ? ['mandateBinding']
        : []),
      'attempt',
      'revision',
      'state',
      'providerId',
      'purpose',
      'requestDigest',
      'manifestDigest',
      'leaseGeneration',
      'lease',
      'result',
      'failure',
      'createdAt',
      'updatedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.invocationId !== invocationId ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    (Object.prototype.hasOwnProperty.call(value, 'mandateBinding') &&
      !isTaskMandateBinding(value.mandateBinding, value.changeId)) ||
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !['prepared', 'leased', 'succeeded', 'failed'].includes(
      String(value.state),
    ) ||
    (value.providerId !== 'codex' && value.providerId !== 'claude') ||
    (value.purpose !== 'survey' && value.purpose !== 'plan-review') ||
    !isDigest(value.requestDigest) ||
    !isDigest(value.manifestDigest) ||
    !isProviderInvocationFailureShape(value.failure) ||
    !Number.isSafeInteger(value.leaseGeneration) ||
    (value.leaseGeneration as number) < 0 ||
    !isProviderInvocationLifecycleLease(value.lease) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !isRecord(manifest) ||
    manifest.schemaVersion !== 1 ||
    !['blind-survey-manifest', 'plan-review-manifest'].includes(
      String(manifest.kind),
    ) ||
    manifest.changeId !== value.changeId ||
    manifest.repositoryId !== request.repositoryId ||
    manifest.baseCommit !== request.baseCommit ||
    manifest.baseTree !== request.baseTree ||
    manifest.capabilityProfile !== request.capabilityProfile ||
    request.invocationId !== invocationId ||
    request.requestDigest !== value.requestDigest ||
    request.providerId !== value.providerId ||
    request.purpose !== value.purpose ||
    sha256(canonicalJson(manifest)) !== value.manifestDigest ||
    (value.purpose === 'survey' && manifest.kind !== 'blind-survey-manifest') ||
    (value.purpose === 'plan-review' &&
      manifest.kind !== 'plan-review-manifest')
  ) {
    throw providerInvocationUnsafe();
  }
  assertInvestigationId(value.investigationId);
  assertChangeId(value.changeId);
  if (
    (value.state === 'prepared' &&
      (value.lease !== null ||
        value.result !== null ||
        value.failure !== null)) ||
    (value.state === 'leased' &&
      (value.lease === null ||
        value.result !== null ||
        value.failure !== null)) ||
    (value.state === 'succeeded' &&
      (value.lease !== null ||
        value.result === null ||
        value.failure !== null)) ||
    (value.state === 'failed' &&
      (value.lease !== null ||
        value.result !== null ||
        value.failure === null)) ||
    (value.lease !== null && value.lease.generation !== value.leaseGeneration)
  ) {
    throw providerInvocationUnsafe();
  }
  const ownerInvestigationId =
    value.purpose === 'plan-review'
      ? resolvePlanReviewInvocationOwner(paths, {
          changeId: value.changeId,
          subject: manifest.subject,
          assignment: request.roleAssignment,
          authorizationNodeId: request.authorizationNodeId,
        })
      : value.investigationId;
  if (ownerInvestigationId !== value.investigationId) {
    throw providerInvocationUnsafe();
  }
  const supersession = inspectProviderInvocationSupersessionRelations(
    paths,
    invocationId,
    {
      exists: (filePath) =>
        privatePathExists(paths, filePath, providerInvocationUnsafe),
      read: (filePath) =>
        readPrivateCanonicalJson(paths, filePath, providerInvocationUnsafe),
    },
  );
  const replacementSnapshot = supersession.replacementOf?.supersededBy;
  const supersededSnapshot = supersession.supersededBy?.replacementOf;
  for (const snapshot of [replacementSnapshot, supersededSnapshot]) {
    if (
      snapshot !== undefined &&
      (snapshot.invocationId !== invocationId ||
        snapshot.attempt !== value.attempt ||
        snapshot.requestDigest !== request.requestDigest ||
        snapshot.manifestDigest !== value.manifestDigest ||
        snapshot.subjectDigest !== request.targetDigest ||
        snapshot.createdAt !== value.createdAt)
    ) {
      throw providerInvocationUnsafe();
    }
  }
  if (
    supersededSnapshot !== undefined &&
    (value.state !== 'failed' ||
      supersededSnapshot.terminalStatus !== 'failed' ||
      supersededSnapshot.terminalAt !== value.updatedAt ||
      supersededSnapshot.failureCode !==
        (isRecord(value.failure) ? value.failure.code : null) ||
      supersededSnapshot.legacyRevision !== value.revision)
  ) {
    throw providerInvocationUnsafe();
  }
  // Validate the exact private invocation closure here as well as when a
  // human-resolution digest is projected. Callers that only enumerate
  // lifecycle projections must not silently accept unknown or malformed
  // authority files.
  digestPrivateDirectoryEntries(paths, directory, providerInvocationUnsafe);
  return deepFreeze({
    invocationId,
    investigationId: value.investigationId,
    ownerInvestigationId,
    changeId: value.changeId,
    purpose: value.purpose,
    attempt: value.attempt,
    revision: value.revision,
    state: value.state,
    requestDigest: value.requestDigest,
    manifestDigest: value.manifestDigest,
    nonce: request.nonce,
    failureKind: value.failure === null ? null : value.failure.kind,
    leaseGeneration: value.leaseGeneration,
    lease:
      value.lease === null
        ? null
        : {
            generation: value.lease.generation,
            workerId: value.lease.workerId,
            tokenDigest: value.lease.tokenDigest,
            acquiredAt: value.lease.acquiredAt,
            expiresAt: value.lease.expiresAt,
          },
  } as ProviderInvocationLifecycleProjection);
}

export function inspectInvestigationResolutionState(
  paths: InvestigationRuntimePaths,
  requestedInvestigationId: string,
  repositoryId: string,
): InvestigationResolutionState {
  if (!isBoundedResolutionText(repositoryId, 1024)) {
    throw humanResolutionStateInvalid();
  }
  const investigationId = assertInvestigationId(requestedInvestigationId);
  const session = readInvestigationSession(paths, investigationId);
  const currentRef = readCurrentInvestigationRef(paths, session.changeId);
  const currentRefDigest =
    currentRef === null ? null : sha256(`${canonicalJson(currentRef)}\n`);
  const startReservationDigest = digestBoundStartReservation(
    paths,
    session,
    startReservationUnsafe,
  );
  const resolutionHeadNodeId = readHumanResolutionHead(paths, investigationId);
  const resolutionNode =
    resolutionHeadNodeId === null
      ? null
      : readHumanResolutionNode(paths, resolutionHeadNodeId);
  if (
    resolutionNode !== null &&
    (resolutionNode.target.workflowId !== investigationId ||
      resolutionNode.target.changeId !== session.changeId)
  ) {
    throw humanResolutionStateInvalid();
  }
  const retryState = bindProviderRetryReservationResolutionState(
    paths,
    session,
    providerInvocationUnsafe,
  );
  const providerState = bindProviderInvocationResolutionState(
    paths,
    session,
    retryState.bindings,
  );
  const evidenceClosure = readInvestigationEvidenceRefsClosure(
    paths,
    session.changeId,
  );
  assertEvidenceClosureTargetBinding(paths, session, evidenceClosure);
  const evidenceRefsDigest = evidenceClosure.snapshot.digest;
  const evidenceRefs =
    evidenceClosure.snapshot.refs === null
      ? null
      : { ...evidenceClosure.snapshot.refs };
  const evidenceRefsClosureDigest = evidenceClosure.closureDigest;
  const blockerDigest =
    session.blocker === null ? null : sha256(canonicalJson(session.blocker));
  const envelope: InvestigationResolutionStateEnvelope = {
    schemaVersion: 2,
    workflowKind: 'investigation',
    repositoryId,
    changeId: session.changeId,
    investigationId,
    sessionDigest: sha256(`${canonicalJson(session)}\n`),
    sessionRevision: session.revision,
    currentRefDigest,
    startReservationDigest,
    resolutionHeadNodeId,
    providerInvocationDigests: providerState.providerInvocationDigests,
    providerRetryReservations: retryState.reservations,
    repositoryProviderLeases: providerState.repositoryProviderLeases,
    evidenceRefs,
    evidenceRefsDigest,
    evidenceRefsClosureDigest,
    blockerDigest,
    ambiguityDigest: null,
  };
  const effectiveState = resolutionNode
    ? effectiveHumanResolutionState(resolutionNode, session.state)
    : session.state;
  const availableResolutions = terminalHumanResolutionState(effectiveState)
    ? []
    : advertisedHumanResolutions(session.blocker);
  return deepFreeze({
    envelope,
    currentStateDigest: investigationResolutionStateDigest(envelope),
    currentRefDigest,
    blocker: session.blocker,
    availableResolutions,
    effectiveState,
  });
}

export function inspectInvestigationQuarantineState(
  paths: InvestigationRuntimePaths,
  requestedInvestigationId: string,
  repositoryId: string,
): InvestigationResolutionState {
  try {
    const strict = inspectInvestigationResolutionState(
      paths,
      requestedInvestigationId,
      repositoryId,
    );
    if (strict.effectiveState !== 'quarantined-by-human-resolution') {
      return strict;
    }
    const nodeId = strict.envelope.resolutionHeadNodeId;
    if (nodeId === null) {
      throw humanResolutionStateInvalid();
    }
    const node = readHumanResolutionNode(paths, nodeId);
    const journal = readHumanResolutionJournal(paths, node.grantId);
    if (
      journal === null ||
      journal.plannedResolutionNodeId !== nodeId ||
      journal.beforeStateDigest !== node.expected.stateDigest
    ) {
      throw humanResolutionStateInvalid();
    }
    const before = readHumanResolutionArchive(
      paths,
      journal.evidenceArchiveDigest,
    );
    const envelope = {
      ...strict.envelope,
      ambiguityDigest: before.envelope.ambiguityDigest,
    };
    return deepFreeze({
      ...strict,
      envelope,
      currentStateDigest: investigationResolutionStateDigest(envelope),
    });
  } catch {
    // Quarantine never treats malformed dependencies as valid. It records
    // bounded no-follow observations so a root human can remove the target
    // from the active namespace without inventing a repaired interpretation.
  }
  if (!isBoundedResolutionText(repositoryId, 1024)) {
    throw humanResolutionStateInvalid();
  }
  const investigationId = assertInvestigationId(requestedInvestigationId);
  const session = readInvestigationSession(paths, investigationId);
  const ambiguities: Array<{
    object: string;
    observationDigest: string;
  }> = [];
  let currentRefDigest: string | null;
  try {
    const currentRef = readCurrentInvestigationRef(paths, session.changeId);
    currentRefDigest =
      currentRef === null ? null : sha256(`${canonicalJson(currentRef)}\n`);
  } catch {
    currentRefDigest = observeUnsafePath(
      currentInvestigationRefPath(paths, session.changeId),
      'current-ref',
      ambiguities,
    );
  }
  let startReservationDigest: string | null;
  try {
    startReservationDigest = digestBoundStartReservation(
      paths,
      session,
      startReservationUnsafe,
    );
  } catch {
    startReservationDigest = observeUnsafePath(
      investigationStartReservationPath(paths, session.changeId),
      'start-reservation',
      ambiguities,
    );
  }
  let resolutionHeadNodeId: string | null;
  let resolutionNode: HumanResolutionNode | null = null;
  try {
    resolutionHeadNodeId = readHumanResolutionHeadReference(
      paths,
      investigationId,
    );
    if (resolutionHeadNodeId !== null) {
      try {
        resolutionNode = readHumanResolutionNode(paths, resolutionHeadNodeId);
      } catch {
        observeUnsafePath(
          humanResolutionNodePath(paths, resolutionHeadNodeId),
          `resolution-node:${resolutionHeadNodeId}`,
          ambiguities,
        );
      }
    }
  } catch {
    observeUnsafePath(
      humanResolutionRefPath(paths, investigationId),
      'resolution-ref',
      ambiguities,
    );
    resolutionHeadNodeId = null;
  }
  let providerRetryReservations: InvestigationResolutionStateEnvelope['providerRetryReservations'];
  let providerRetryBindings: BoundProviderRetryReservation[] = [];
  try {
    const retryState = bindProviderRetryReservationResolutionState(
      paths,
      session,
      providerInvocationUnsafe,
    );
    providerRetryReservations = retryState.reservations;
    providerRetryBindings = retryState.bindings;
  } catch {
    providerRetryReservations = [];
    observeProviderRetryReservationAmbiguities(paths, session, ambiguities);
  }
  let providerInvocationDigests: InvestigationResolutionStateEnvelope['providerInvocationDigests'];
  let repositoryProviderLeases: InvestigationResolutionStateEnvelope['repositoryProviderLeases'];
  try {
    const providerState = bindProviderInvocationResolutionState(
      paths,
      session,
      providerRetryBindings,
    );
    providerInvocationDigests = providerState.providerInvocationDigests;
    repositoryProviderLeases = providerState.repositoryProviderLeases;
  } catch {
    providerInvocationDigests = session.blindInvocationIds.map(
      (invocationId) => {
        try {
          return {
            invocationId,
            files: digestPrivateDirectoryEntries(
              paths,
              path.join(paths.invocations, invocationId),
              providerInvocationUnsafe,
            ),
          };
        } catch {
          const digestValue = observeUnsafePath(
            path.join(paths.invocations, invocationId),
            `provider-invocation:${invocationId}`,
            ambiguities,
          );
          return {
            invocationId,
            files: [{ name: 'unsafe-observation', digest: digestValue }],
          };
        }
      },
    );
    repositoryProviderLeases = [];
    observeUnsafePath(paths.invocations, 'provider-invocations', ambiguities);
  }
  let evidenceRefs: Record<string, string> | null;
  let evidenceRefsDigest: string | null;
  let evidenceRefsClosureDigest: string | null;
  try {
    const evidenceClosure = readInvestigationEvidenceRefsClosure(
      paths,
      session.changeId,
    );
    assertEvidenceClosureTargetBinding(paths, session, evidenceClosure);
    evidenceRefsDigest = evidenceClosure.snapshot.digest;
    evidenceRefs =
      evidenceClosure.snapshot.refs === null
        ? null
        : { ...evidenceClosure.snapshot.refs };
    evidenceRefsClosureDigest = evidenceClosure.closureDigest;
  } catch {
    evidenceRefs = null;
    evidenceRefsClosureDigest = null;
    const observations = observeInvestigationEvidenceRefsAmbiguities(
      paths,
      session.changeId,
    );
    ambiguities.push(...observations);
    evidenceRefsDigest =
      observations.find(({ object }) => object === 'evidence-refs')
        ?.observationDigest ?? null;
  }
  if (ambiguities.length === 0) {
    throw humanResolutionStateInvalid();
  }
  const normalizedAmbiguities = normalizeAmbiguityObservations(ambiguities);
  const ambiguityDigest = sha256(
    canonicalJson({
      schema: 'investigation-quarantine-observation.v1',
      ambiguities: normalizedAmbiguities,
    }),
  );
  const blockerDigest =
    session.blocker === null ? null : sha256(canonicalJson(session.blocker));
  const envelope: InvestigationResolutionStateEnvelope = {
    schemaVersion: 2,
    workflowKind: 'investigation',
    repositoryId,
    changeId: session.changeId,
    investigationId,
    sessionDigest: sha256(`${canonicalJson(session)}\n`),
    sessionRevision: session.revision,
    currentRefDigest,
    startReservationDigest,
    resolutionHeadNodeId,
    providerInvocationDigests,
    providerRetryReservations,
    repositoryProviderLeases,
    evidenceRefs,
    evidenceRefsDigest,
    evidenceRefsClosureDigest,
    blockerDigest,
    ambiguityDigest,
  };
  const effectiveState =
    resolutionNode === null
      ? ('human-action-required' as const)
      : effectiveHumanResolutionState(resolutionNode, 'human-action-required');
  return deepFreeze({
    envelope,
    currentStateDigest: investigationResolutionStateDigest(envelope),
    currentRefDigest,
    blocker: session.blocker,
    availableResolutions: terminalHumanResolutionState(effectiveState)
      ? []
      : [
          {
            kind: 'quarantine',
            parameterSchemaDigest:
              humanResolutionDecisionSchemaDigest('quarantine'),
          },
        ],
    effectiveState,
  });
}

export function investigationResolutionStateDigest(
  envelope: InvestigationResolutionStateEnvelope,
): string {
  return sha256(
    canonicalJson({
      schema: HUMAN_RESOLUTION_SCHEMA,
      envelope,
    }),
  );
}

export function investigationCurrentRefDigest(
  input: {
    changeId: string;
    investigationId: string;
  } | null,
): string | null {
  return input === null
    ? null
    : sha256(
        `${canonicalJson({
          schemaVersion: 1,
          changeId: assertChangeId(input.changeId),
          investigationId: assertInvestigationId(input.investigationId),
        })}\n`,
      );
}

export function advertisedHumanResolutions(
  blocker: InvestigationSession['blocker'],
): HumanResolutionAvailability[] {
  const kinds: HumanResolutionDecision['kind'][] = [
    'abort',
    'quarantine',
    'supersede',
  ];
  if (
    blocker !== null &&
    'schemaVersion' in blocker &&
    blocker.schemaVersion === 2 &&
    blocker.reasonCode === 'INVESTIGATION_REVIEWER_REOPEN_LIMIT_REACHED'
  ) {
    kinds.unshift('resume-with-capability', 'close-input', 'waive-assurance');
  }
  return kinds.map((kind) => ({
    kind,
    parameterSchemaDigest: humanResolutionDecisionSchemaDigest(kind),
  }));
}

export function assertInvestigationCheckpointEnvelope(
  value: unknown,
): InvestigationCheckpointEnvelope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'checkpointId',
      'investigationId',
      'changeId',
      'expectedRevision',
      'baseline',
      'intentDigest',
      'blindManifestDigest',
      'payload',
    ]) ||
    value.schemaVersion !== 1 ||
    !isCheckpointKind(value.kind) ||
    typeof value.checkpointId !== 'string' ||
    !CHECKPOINT_ID.test(value.checkpointId) ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0 ||
    !isBaseline(value.baseline) ||
    !isDigest(value.intentDigest) ||
    !isDigest(value.blindManifestDigest)
  ) {
    throw checkpointInvalid();
  }
  assertInvestigationId(value.investigationId);
  assertChangeId(value.changeId);
  if (value.kind === 'main-terms') {
    assertMainTermsPayload(value.payload);
  } else if (value.kind === 'group-dispositions') {
    assertGroupDispositionsPayload(value.payload);
  } else {
    assertWhyAnswersPayload(value.payload);
  }
  if (Buffer.byteLength(canonicalJson(value), 'utf8') > MAX_CHECKPOINT_BYTES) {
    throw checkpointInvalid();
  }
  return deepFreeze(structuredClone(value)) as InvestigationCheckpointEnvelope;
}

export function checkpointEnvelopeDigest(
  envelope: InvestigationCheckpointEnvelope,
): string {
  return sha256(canonicalJson(assertInvestigationCheckpointEnvelope(envelope)));
}

export function checkpointContributionDigest(
  envelope: InvestigationCheckpointEnvelope,
): string {
  const validated = assertInvestigationCheckpointEnvelope(envelope);
  return sha256(
    canonicalJson({
      schemaVersion: validated.schemaVersion,
      kind: validated.kind,
      investigationId: validated.investigationId,
      changeId: validated.changeId,
      baseline: validated.baseline,
      intentDigest: validated.intentDigest,
      blindManifestDigest: validated.blindManifestDigest,
      payload: validated.payload,
    }),
  );
}

export function deriveInvestigationSessionState(
  session: Pick<InvestigationSession, 'blocker' | 'milestones'>,
): InvestigationSessionState {
  if (session.blocker !== null) {
    return session.blocker.state;
  }
  if (session.milestones.mainTerms === null) {
    return 'awaiting-main-terms';
  }
  if (session.milestones.blindResult === null) {
    return 'waiting-for-provider';
  }
  if (session.milestones.groupDispositions === null) {
    return 'awaiting-group-dispositions';
  }
  if (session.milestones.whyAnswers === null) {
    return 'awaiting-ledger-answers';
  }
  return 'investigation-sealed';
}

export function ensurePrivateInvestigationDirectory(
  paths: InvestigationRuntimePaths,
  directory: string,
  makeError: () => WorkflowError,
): void {
  walkPrivateDirectory(paths, directory, makeError, true);
}

export function assertPrivateInvestigationDirectory(
  paths: InvestigationRuntimePaths,
  directory: string,
  makeError: () => WorkflowError,
): void {
  walkPrivateDirectory(paths, directory, makeError, false);
}

export function readPrivateCanonicalJson(
  paths: InvestigationRuntimePaths,
  filePath: string,
  makeError: () => WorkflowError,
): unknown {
  walkPrivateDirectory(paths, path.dirname(filePath), makeError, false);
  const content = readPrivateFile(filePath, makeError);
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw makeError();
  }
  if (`${canonicalJson(value)}\n` !== content) {
    throw makeError();
  }
  return value;
}

export function createPrivateCanonicalJson(
  paths: InvestigationRuntimePaths,
  filePath: string,
  value: unknown,
  makeError: () => WorkflowError,
  collisionCode: string,
): void {
  const content = `${canonicalJson(value)}\n`;
  ensurePrivateInvestigationDirectory(paths, path.dirname(filePath), makeError);
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing) {
    if (readPrivateFile(filePath, makeError) === content) {
      return;
    }
    throw workflowError(
      collisionCode,
      'A different durable investigation record already exists.',
      ExitCode.conflict,
    );
  }
  const temporary = writePrivateTemporary(filePath, content);
  try {
    const raced = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (raced) {
      if (readPrivateFile(filePath, makeError) === content) {
        return;
      }
      throw workflowError(
        collisionCode,
        'A different durable investigation record already exists.',
        ExitCode.conflict,
      );
    }
    // Every caller holds the appropriate short store/change lock. Renaming a
    // fully fsynced private temp is atomic and avoids the crash window where a
    // temp-to-final hardlink would leave the durable target with nlink=2.
    fs.renameSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
    assertPrivateFile(fs.lstatSync(filePath), makeError);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function writePrivateCanonicalJsonAtomic(
  paths: InvestigationRuntimePaths,
  filePath: string,
  value: unknown,
  makeError: () => WorkflowError,
): void {
  const content = `${canonicalJson(value)}\n`;
  ensurePrivateInvestigationDirectory(paths, path.dirname(filePath), makeError);
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing) {
    assertPrivateFile(existing, makeError);
  }
  const temporary = writePrivateTemporary(filePath, content);
  try {
    const current = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (current) {
      assertPrivateFile(current, makeError);
    }
    fs.renameSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
    assertPrivateFile(fs.lstatSync(filePath), makeError);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function withPrivateRuntimeLock<T>(
  paths: InvestigationRuntimePaths,
  lockPath: string,
  operation: () => T,
  conflictCode: string,
  invalidLock: () => WorkflowError,
): T {
  ensurePrivateInvestigationDirectory(
    paths,
    path.dirname(lockPath),
    invalidLock,
  );
  const ownerToken = crypto.randomUUID();
  const marker = `${canonicalJson({
    schemaVersion: 1,
    ownerToken,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  })}\n`;
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = publishPreparedExclusiveLock(
        lockPath,
        marker,
        ownerToken,
        invalidLock,
      );
      break;
    } catch (error) {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        descriptor = undefined;
      }
      if (
        isNodeError(error) &&
        error.code === 'EEXIST' &&
        attempt === 0 &&
        reclaimDeadPrivateRuntimeLock(lockPath, invalidLock)
      ) {
        continue;
      }
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw workflowError(
          conflictCode,
          'A durable investigation operation is already in progress.',
          ExitCode.conflict,
        );
      }
      throw error;
    }
  }
  if (descriptor === undefined) {
    throw invalidLock();
  }
  const owned = fs.fstatSync(descriptor);
  let result: T;
  try {
    result = operation();
  } catch (error) {
    releasePrivateRuntimeLock(lockPath, descriptor, owned, marker, invalidLock);
    throw error;
  }
  releasePrivateRuntimeLock(lockPath, descriptor, owned, marker, invalidLock);
  return result;
}

export function privatePathExists(
  paths: InvestigationRuntimePaths,
  filePath: string,
  makeError: () => WorkflowError,
): boolean {
  if (!walkPrivateDirectory(paths, path.dirname(filePath), makeError, false)) {
    return false;
  }
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats) {
    return false;
  }
  assertPrivateFile(stats, makeError);
  return true;
}

export function createInvestigationHumanActionBlocker(input: {
  reasonCode: string;
  blockedTransition: string;
  facts: Record<string, unknown>;
  now?: Date;
}): InvestigationHumanActionBlocker {
  if (
    !isBoundedResolutionText(input.reasonCode, 256) ||
    !isBoundedResolutionText(input.blockedTransition, 256) ||
    !isRecord(input.facts)
  ) {
    throw humanResolutionInvalid(
      'Investigation human-action blocker is malformed.',
    );
  }
  const enteredAt = exactResolutionTimestamp(input.now ?? new Date());
  const blocker: InvestigationHumanActionBlocker = {
    schemaVersion: 2,
    state: 'human-action-required',
    reasonCode: input.reasonCode,
    blockedTransition: input.blockedTransition,
    enteredAt,
    facts: structuredClone(input.facts),
    availableResolutions: advertisedHumanResolutions({
      schemaVersion: 2,
      state: 'human-action-required',
      reasonCode: input.reasonCode,
      blockedTransition: input.blockedTransition,
      enteredAt,
      facts: structuredClone(input.facts),
      availableResolutions: [],
    }),
  };
  if (Buffer.byteLength(canonicalJson(blocker), 'utf8') > 65_536) {
    throw humanResolutionInvalid(
      'Investigation human-action blocker exceeds its fixed bound.',
    );
  }
  return deepFreeze(blocker);
}

export function createHumanResolutionNode(
  input: Omit<HumanResolutionNode, 'schemaVersion' | 'kind' | 'nodeId'>,
): HumanResolutionNode {
  const target = assertHumanResolutionTarget(input.target);
  const expected = assertHumanResolutionExpected(input.expected);
  const decision = assertHumanResolutionDecision(input.decision);
  const consequences = assertHumanResolutionConsequences(input.consequences);
  assertHumanResolutionGrantId(input.grantId);
  if (
    !isDigest(input.grantDigest) ||
    (input.previousResolutionNodeId !== null &&
      !isDigest(input.previousResolutionNodeId)) ||
    exactResolutionTimestamp(new Date(input.createdAt)) !== input.createdAt
  ) {
    throw humanResolutionInvalid('Human resolution node is malformed.');
  }
  assertDecisionConsequences(decision, consequences);
  const semantic = {
    schemaVersion: 1 as const,
    kind: 'human-resolution-node' as const,
    target,
    expected,
    decision,
    consequences,
    grantId: input.grantId,
    grantDigest: input.grantDigest,
    previousResolutionNodeId: input.previousResolutionNodeId,
    createdAt: input.createdAt,
  };
  const node: HumanResolutionNode = {
    ...semantic,
    nodeId: sha256(
      canonicalJson({
        schema: 'human-resolution-node.v1',
        node: semantic,
      }),
    ),
  };
  return deepFreeze(node);
}

export function createHumanResolutionJournal(
  input: Omit<HumanResolutionJournal, 'schemaVersion' | 'kind' | 'journalId'>,
): HumanResolutionJournal {
  const semantic = {
    schemaVersion: 2 as const,
    kind: 'human-resolution-journal' as const,
    phase: input.phase,
    grantId: input.grantId,
    grantDigest: input.grantDigest,
    target: input.target,
    beforeStateDigest: input.beforeStateDigest,
    afterStateDigest: input.afterStateDigest,
    beforeResolutionRef: input.beforeResolutionRef,
    resolutionRefMode: input.resolutionRefMode,
    plannedResolutionNodeId: input.plannedResolutionNodeId,
    plannedCurrentWorkflowRef: input.plannedCurrentWorkflowRef,
    plannedStartReservation: input.plannedStartReservation,
    plannedEvidenceRefs: input.plannedEvidenceRefs,
    evidenceArchiveDigest: input.evidenceArchiveDigest,
    receiptDigest: input.receiptDigest,
    createdAt: input.createdAt,
  };
  const candidate = {
    ...semantic,
    journalId: sha256(
      canonicalJson({
        schema: 'human-resolution-journal.v2',
        journal: humanResolutionJournalIdentity(semantic),
      }),
    ),
  };
  return assertHumanResolutionJournal(candidate);
}

export function writeHumanResolutionNode(
  paths: InvestigationRuntimePaths,
  node: HumanResolutionNode,
): string {
  const validated = assertHumanResolutionNode(node);
  createPrivateCanonicalJson(
    paths,
    humanResolutionNodePath(paths, validated.nodeId),
    validated,
    humanResolutionObjectUnsafe,
    'HUMAN_RESOLUTION_NODE_COLLISION',
  );
  return validated.nodeId;
}

export function readHumanResolutionNode(
  paths: InvestigationRuntimePaths,
  requestedNodeId: string,
): HumanResolutionNode {
  if (!isDigest(requestedNodeId)) {
    throw humanResolutionObjectUnsafe();
  }
  const value = readPrivateCanonicalJson(
    paths,
    humanResolutionNodePath(paths, requestedNodeId),
    humanResolutionObjectUnsafe,
  );
  const node = assertHumanResolutionNode(value);
  if (node.nodeId !== requestedNodeId) {
    throw humanResolutionObjectUnsafe();
  }
  return node;
}

export function readHumanResolutionHead(
  paths: InvestigationRuntimePaths,
  requestedInvestigationId: string,
): string | null {
  const nodeId = readHumanResolutionHeadReference(
    paths,
    requestedInvestigationId,
  );
  if (nodeId !== null) {
    readHumanResolutionNode(paths, nodeId);
  }
  return nodeId;
}

function readHumanResolutionHeadReference(
  paths: InvestigationRuntimePaths,
  requestedInvestigationId: string,
): string | null {
  const investigationId = assertInvestigationId(requestedInvestigationId);
  const refPath = humanResolutionRefPath(paths, investigationId);
  if (!privatePathExists(paths, refPath, humanResolutionRefUnsafe)) {
    return null;
  }
  const value = readPrivateCanonicalJson(
    paths,
    refPath,
    humanResolutionRefUnsafe,
  );
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'investigationId', 'nodeId']) ||
    value.schemaVersion !== 1 ||
    value.investigationId !== investigationId ||
    !isDigest(value.nodeId)
  ) {
    throw humanResolutionRefUnsafe();
  }
  return value.nodeId;
}

export function compareAndSwapHumanResolutionHead(
  paths: InvestigationRuntimePaths,
  requestedInvestigationId: string,
  expectedNodeId: string | null,
  nextNodeId: string,
): void {
  const investigationId = assertInvestigationId(requestedInvestigationId);
  if (expectedNodeId !== null && !isDigest(expectedNodeId)) {
    throw humanResolutionRefUnsafe();
  }
  const next = readHumanResolutionNode(paths, nextNodeId);
  if (next.target.workflowId !== investigationId) {
    throw humanResolutionRefUnsafe();
  }
  withPrivateRuntimeLock(
    paths,
    path.join(
      humanResolutionPaths(paths).locks,
      `${investigationId}.resolution.lock`,
    ),
    () => {
      const observed = readHumanResolutionHead(paths, investigationId);
      if (observed !== expectedNodeId) {
        throw workflowError(
          'HUMAN_RESOLUTION_REF_STALE',
          'The human-resolution overlay changed after grant issuance.',
          ExitCode.staleState,
        );
      }
      writePrivateCanonicalJsonAtomic(
        paths,
        humanResolutionRefPath(paths, investigationId),
        {
          schemaVersion: 1,
          investigationId,
          nodeId: nextNodeId,
        },
        humanResolutionRefUnsafe,
      );
    },
    'HUMAN_RESOLUTION_OPERATION_CONFLICT',
    humanResolutionRefUnsafe,
  );
}

export function quarantineUnsafeHumanResolutionRef(
  paths: InvestigationRuntimePaths,
  requestedInvestigationId: string,
  repositoryId: string,
  expectedStateDigest: string,
): string {
  const investigationId = assertInvestigationId(requestedInvestigationId);
  if (
    !isBoundedResolutionText(repositoryId, 1024) ||
    !isDigest(expectedStateDigest)
  ) {
    throw humanResolutionRefUnsafe();
  }
  const source = humanResolutionRefPath(paths, investigationId);
  const quarantineDirectory = humanResolutionPaths(paths).quarantine;
  const target = path.join(
    quarantineDirectory,
    `${investigationId}.${expectedStateDigest}.resolution-ref-artifact`,
  );
  return withPrivateRuntimeLock(
    paths,
    path.join(
      humanResolutionPaths(paths).locks,
      `${investigationId}.resolution.lock`,
    ),
    () => {
      if (
        !walkPrivateDirectory(
          paths,
          path.dirname(source),
          humanResolutionRefUnsafe,
          false,
        )
      ) {
        throw workflowError(
          'HUMAN_RESOLUTION_REF_STALE',
          'The human-resolution ref disappeared before quarantine.',
          ExitCode.staleState,
        );
      }
      const sourceStats = fs.lstatSync(source, { throwIfNoEntry: false });
      if (!sourceStats) {
        if (fs.lstatSync(target, { throwIfNoEntry: false })) {
          return target;
        }
        throw workflowError(
          'HUMAN_RESOLUTION_REF_STALE',
          'The human-resolution ref changed before quarantine.',
          ExitCode.staleState,
        );
      }
      const observed = inspectInvestigationQuarantineState(
        paths,
        investigationId,
        repositoryId,
      );
      if (
        observed.currentStateDigest !== expectedStateDigest ||
        observed.envelope.ambiguityDigest === null
      ) {
        throw workflowError(
          'HUMAN_RESOLUTION_REF_STALE',
          'The human-resolution ref changed after grant issuance.',
          ExitCode.staleState,
        );
      }
      try {
        readHumanResolutionHead(paths, investigationId);
        throw workflowError(
          'HUMAN_RESOLUTION_REF_STALE',
          'A readable human-resolution ref cannot use the unsafe-ref quarantine transition.',
          ExitCode.staleState,
        );
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'HUMAN_RESOLUTION_REF_STALE'
        ) {
          throw error;
        }
      }
      ensurePrivateInvestigationDirectory(
        paths,
        quarantineDirectory,
        humanResolutionArchiveUnsafe,
      );
      if (fs.lstatSync(target, { throwIfNoEntry: false })) {
        throw workflowError(
          'HUMAN_RESOLUTION_QUARANTINE_CONFLICT',
          'A different quarantine artifact already occupies the exact target.',
          ExitCode.conflict,
        );
      }
      fs.renameSync(source, target);
      fsyncDirectory(path.dirname(source));
      fsyncDirectory(quarantineDirectory);
      return target;
    },
    'HUMAN_RESOLUTION_OPERATION_CONFLICT',
    humanResolutionRefUnsafe,
  );
}

export function storeAvailableHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
  canonicalEnvelope: string,
): string {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  assertCanonicalResolutionEnvelopeBytes(canonicalEnvelope);
  const stores = humanResolutionPaths(paths);
  return withHumanResolutionGrantStoreLock(
    paths,
    stores,
    () => {
      if (
        readHumanResolutionGrantPublicationRecovery(paths, stores, grantId) !==
        null
      ) {
        throw workflowError(
          'HUMAN_RESOLUTION_GRANT_EXISTS',
          `Human resolution grant ${grantId} already has publication recovery history.`,
          ExitCode.conflict,
        );
      }
      for (const directory of [
        stores.available,
        stores.reserved,
        stores.terminal,
      ]) {
        const candidate = path.join(directory, `${grantId}.json`);
        if (privatePathExists(paths, candidate, humanResolutionGrantUnsafe)) {
          throw workflowError(
            'HUMAN_RESOLUTION_GRANT_EXISTS',
            `Human resolution grant ${grantId} already has durable state.`,
            ExitCode.conflict,
          );
        }
      }
      const target = path.join(stores.available, `${grantId}.json`);
      createPrivateRawFile(
        paths,
        target,
        canonicalEnvelope,
        humanResolutionGrantUnsafe,
      );
      return target;
    },
    {
      allowPreparedPublicationRecovery: true,
      targetGrantId: grantId,
    },
  );
}

export function rollbackAvailableHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
  canonicalEnvelope: string,
): 'absent' | 'different' | 'removed' {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  assertCanonicalResolutionEnvelopeBytes(canonicalEnvelope);
  const stores = humanResolutionPaths(paths);
  return withHumanResolutionGrantStoreLock(
    paths,
    stores,
    () => {
      const target = path.join(stores.available, `${grantId}.json`);
      if (!privatePathExists(paths, target, humanResolutionGrantUnsafe)) {
        return 'absent';
      }
      if (
        readPrivateFile(target, humanResolutionGrantUnsafe) !==
        canonicalEnvelope
      ) {
        return 'different';
      }
      fs.unlinkSync(target);
      fsyncDirectory(stores.available);
      return 'removed';
    },
    { targetGrantId: grantId },
  );
}

export function withHumanResolutionGrantExecution<T>(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
  operation: () => T,
  options: { allowPublicationRecovery?: boolean } = {},
): T {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  return withPrivateRuntimeLock(
    paths,
    path.join(humanResolutionPaths(paths).locks, `${grantId}.execution.lock`),
    () => {
      if (!options.allowPublicationRecovery) {
        assertNoPreparedHumanResolutionGrantPublicationRecovery(paths, grantId);
      }
      return operation();
    },
    'HUMAN_RESOLUTION_OPERATION_CONFLICT',
    humanResolutionGrantUnsafe,
  );
}

export function inspectStoredHumanResolutionGrants(
  paths: InvestigationRuntimePaths,
  requestedGrantId?: string,
): HumanResolutionGrantStoreEntry[] {
  const grantId =
    requestedGrantId === undefined
      ? undefined
      : assertHumanResolutionGrantId(requestedGrantId);
  const stores = humanResolutionPaths(paths);
  const ids = grantId
    ? [grantId]
    : [
        ...new Set(
          [stores.available, stores.reserved, stores.terminal].flatMap(
            (directory) => listHumanResolutionGrantIds(paths, directory),
          ),
        ),
      ].sort();
  const entries = ids
    .map((id) => inspectStoredHumanResolutionGrant(paths, id))
    .filter((entry): entry is HumanResolutionGrantStoreEntry => entry !== null);
  if (grantId !== undefined && entries.length === 0) {
    throw humanResolutionGrantNotFound(grantId);
  }
  return entries;
}

export function inspectInterruptedHumanResolutionGrantPublications(
  paths: InvestigationRuntimePaths,
  requestedGrantId?: string,
): HumanResolutionGrantPublicationStoreInspection[] {
  const grantId =
    requestedGrantId === undefined
      ? undefined
      : assertHumanResolutionGrantId(requestedGrantId);
  const stores = humanResolutionPaths(paths);
  return withHumanResolutionGrantStoreLock(
    paths,
    stores,
    () => {
      listHumanResolutionGrantIds(paths, stores.available);
      const temporaryGrantIds = walkPrivateDirectory(
        paths,
        stores.available,
        humanResolutionGrantUnsafe,
        false,
      )
        ? fs.readdirSync(stores.available).flatMap((temporaryName) => {
            const match = HUMAN_RESOLUTION_GRANT_TEMPORARY.exec(temporaryName);
            if (!match?.[1]) {
              return [];
            }
            const observedGrantId = assertHumanResolutionGrantId(match[1]);
            return grantId === undefined || observedGrantId === grantId
              ? [observedGrantId]
              : [];
          })
        : [];
      const recoveryGrantIds =
        grantId === undefined
          ? listHumanResolutionGrantPublicationRecoveryIds(paths, stores)
          : privatePathExists(
                paths,
                humanResolutionGrantPublicationRecoveryPath(stores, grantId),
                humanResolutionGrantUnsafe,
              )
            ? [grantId]
            : [];
      const preparedReceiptGrantIds = recoveryGrantIds.filter(
        (observedGrantId) =>
          readHumanResolutionGrantPublicationRecovery(
            paths,
            stores,
            observedGrantId,
          )?.phase === 'prepared',
      );
      const grantIds = [
        ...new Set([...temporaryGrantIds, ...preparedReceiptGrantIds]),
      ].sort();
      return grantIds.map((observedGrantId) => {
        const receipt = readHumanResolutionGrantPublicationRecovery(
          paths,
          stores,
          observedGrantId,
        );
        if (receipt?.phase === 'prepared') {
          assertHumanResolutionGrantPublicationQuarantineReplayState(
            paths,
            stores,
            receipt,
          );
          return {
            storeState: receipt.publicationStoreState,
            preparedBinding: {
              auditTag: receipt.auditTag,
              publicationStateDigest: receipt.publicationStateDigest,
            },
          };
        }
        return {
          storeState: observeHumanResolutionGrantPublicationStoreState(
            paths,
            stores,
            observedGrantId,
          ),
          preparedBinding: null,
        };
      });
    },
    {
      allowInterruptedAvailablePublication: true,
      allowPreparedPublicationRecovery: true,
      targetGrantId: grantId,
    },
  );
}

export function quarantineInterruptedHumanResolutionGrantPublication(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
  expectedPublicationStateDigest: string,
  reason: string,
  bindPublicationState: (
    storeState: HumanResolutionGrantPublicationStoreState,
  ) => HumanResolutionGrantPublicationStateBinding,
  now: Date = new Date(),
): QuarantinedHumanResolutionGrantPublication {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  if (
    !isDigest(expectedPublicationStateDigest) ||
    !isBoundedResolutionText(reason, 1024) ||
    !Number.isFinite(now.getTime())
  ) {
    throw humanResolutionGrantPublicationRecoveryInvalid();
  }
  const stores = humanResolutionPaths(paths);
  const recoveryId = sha256(
    canonicalJson({
      schema: 'human-resolution-grant-publication-quarantine.v1',
      grantId,
      publicationStateDigest: expectedPublicationStateDigest,
    }),
  );
  const receiptPath = humanResolutionGrantPublicationRecoveryPath(
    stores,
    grantId,
  );
  const result = {
    action: 'quarantined' as const,
    grantId,
    publicationStateDigest: expectedPublicationStateDigest,
  };
  return withHumanResolutionGrantStoreLock(
    paths,
    stores,
    () => {
      const existingReceipt = privatePathExists(
        paths,
        receiptPath,
        humanResolutionGrantUnsafe,
      )
        ? readPrivateCanonicalJson(
            paths,
            receiptPath,
            humanResolutionGrantUnsafe,
          )
        : null;
      if (existingReceipt !== null) {
        const receipt = assertHumanResolutionGrantPublicationQuarantineReceipt(
          existingReceipt,
          grantId,
        );
        if (
          receipt.recoveryId !== recoveryId ||
          receipt.publicationStateDigest !== expectedPublicationStateDigest ||
          receipt.reason !== reason
        ) {
          throw humanResolutionGrantPublicationRecoveryStale();
        }
        assertHumanResolutionGrantPublicationQuarantineReplayState(
          paths,
          stores,
          receipt,
        );
        completeHumanResolutionGrantPublicationQuarantine(
          paths,
          stores,
          receipt,
        );
        finalizeHumanResolutionGrantPublicationQuarantineReceipt(
          paths,
          receiptPath,
          receipt,
        );
        return result;
      }
      const observed = observeHumanResolutionGrantPublicationStoreState(
        paths,
        stores,
        grantId,
      );
      const binding = bindPublicationState(observed);
      const observedStateDigest = binding.publicationStateDigest;
      if (
        !isDigest(observedStateDigest) ||
        observedStateDigest !== expectedPublicationStateDigest
      ) {
        throw humanResolutionGrantPublicationRecoveryStale();
      }
      if (observed.temporaries.length === 0) {
        throw humanResolutionGrantPublicationRecoveryAmbiguous();
      }
      ensurePrivateInvestigationDirectory(
        paths,
        stores.quarantine,
        humanResolutionGrantUnsafe,
      );
      const receipt = {
        schemaVersion: 1 as const,
        kind: 'human-resolution-grant-publication-recovery' as const,
        recoveryId,
        action: 'quarantined' as const,
        phase: 'prepared' as const,
        grantId,
        publicationStateDigest: expectedPublicationStateDigest,
        auditTag: binding.auditTag,
        publicationStoreState: observed,
        artifacts: observed.temporaries.map((temporary, index) => ({
          temporaryName: temporary.temporaryName,
          rawSha256: temporary.rawSha256,
          unsafeObservationDigest: temporary.unsafeObservationDigest,
          byteLength: temporary.byteLength,
          quarantineArtifact: `${recoveryId}.${index + 1}.grant-publication.artifact`,
        })),
        reason,
        recordedAt: now.toISOString(),
      };
      createPrivateRawFile(
        paths,
        receiptPath,
        `${canonicalJson(receipt)}\n`,
        humanResolutionGrantUnsafe,
      );
      const validatedReceipt =
        assertHumanResolutionGrantPublicationQuarantineReceipt(
          readPrivateCanonicalJson(
            paths,
            receiptPath,
            humanResolutionGrantUnsafe,
          ),
          grantId,
        );
      completeHumanResolutionGrantPublicationQuarantine(
        paths,
        stores,
        validatedReceipt,
      );
      finalizeHumanResolutionGrantPublicationQuarantineReceipt(
        paths,
        receiptPath,
        validatedReceipt,
      );
      return result;
    },
    {
      allowInterruptedAvailablePublication: true,
      allowPreparedPublicationRecovery: true,
      targetGrantId: grantId,
    },
  );
}

export function revokeStoredHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  cwd: string,
  requestedGrantId: string,
  options: HumanRevocationOptions,
): HumanResolutionGrantStoreEntry {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  const current = inspectStoredHumanResolutionGrant(paths, grantId);
  if (current === null) throw humanResolutionGrantNotFound(grantId);
  if (current.state === 'consumed') {
    throw workflowError(
      'HUMAN_REVOCATION_STATE_INVALID',
      'Consumed human-resolution authority cannot be revoked.',
      ExitCode.guard,
    );
  }
  if (
    current.state === 'reserved' &&
    readHumanResolutionJournal(paths, grantId) !== null
  ) {
    throw workflowError(
      'HUMAN_RESOLUTION_RECOVERY_REQUIRED',
      'A prepared human-resolution transaction must be recovered instead of revoked.',
      ExitCode.conflict,
    );
  }
  const binding = humanResolutionRevocationBinding(
    paths,
    current.envelopeBytes,
    grantId,
  );
  const authorization = authorizeHumanRevocation(
    cwd,
    binding,
    options,
    humanResolutionRevocationAuthorizationPath(paths, grantId),
    current.revocationAuthorization ?? null,
  );
  const stores = humanResolutionPaths(paths);
  return withHumanResolutionGrantStoreLock(
    paths,
    stores,
    () => {
      const terminalPath = path.join(stores.terminal, `${grantId}.json`);
      if (privatePathExists(paths, terminalPath, humanResolutionGrantUnsafe)) {
        const terminal = readPrivateCanonicalJson(
          paths,
          terminalPath,
          humanResolutionGrantUnsafe,
        );
        reconcileTerminalHumanResolutionGrantResidual(
          paths,
          stores,
          grantId,
          terminal,
        );
        const existing = inspectStoredHumanResolutionGrant(
          paths,
          grantId,
        ) as HumanResolutionGrantStoreEntry;
        if (
          existing.state !== 'revoked' ||
          existing.terminalReason !== authorization.payload.reason ||
          existing.revocationAuthorization === undefined ||
          canonicalHumanRevocationAuthorization(
            existing.revocationAuthorization,
          ) !== canonicalHumanRevocationAuthorization(authorization)
        ) {
          throw workflowError(
            'HUMAN_REVOCATION_CONFLICT',
            'Human-resolution grant already has a different terminal record.',
            ExitCode.conflict,
          );
        }
        return existing;
      }
      const terminalEntry = inspectStoredHumanResolutionGrant(paths, grantId);
      if (terminalEntry === null) {
        throw humanResolutionGrantNotFound(grantId);
      }
      if (
        terminalEntry.state !== 'available' &&
        terminalEntry.state !== 'reserved'
      ) {
        throw workflowError(
          'HUMAN_REVOCATION_STATE_INVALID',
          'Only active human-resolution authority can be revoked.',
          ExitCode.guard,
        );
      }
      if (
        terminalEntry.state === 'reserved' &&
        readHumanResolutionJournal(paths, grantId) !== null
      ) {
        throw workflowError(
          'HUMAN_RESOLUTION_RECOVERY_REQUIRED',
          'A prepared human-resolution transaction must be recovered instead of revoked.',
          ExitCode.conflict,
        );
      }
      const sourceDirectory =
        terminalEntry.state === 'available'
          ? stores.available
          : stores.reserved;
      const sourcePath = path.join(sourceDirectory, `${grantId}.json`);
      const envelope = JSON.parse(terminalEntry.envelopeBytes) as unknown;
      const record = {
        schemaVersion: 1,
        state: 'revoked',
        grantId,
        reason: authorization.payload.reason,
        recordedAt: authorization.payload.revokedAt,
        envelope,
        revocationAuthorization: authorization,
      };
      createPrivateCanonicalJson(
        paths,
        terminalPath,
        record,
        humanResolutionGrantUnsafe,
        'HUMAN_RESOLUTION_GRANT_TERMINAL_CONFLICT',
      );
      fs.unlinkSync(sourcePath);
      fsyncDirectory(sourceDirectory);
      return inspectStoredHumanResolutionGrant(
        paths,
        grantId,
      ) as HumanResolutionGrantStoreEntry;
    },
    { targetGrantId: grantId },
  );
}

export function reserveHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
): string {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  const stores = humanResolutionPaths(paths);
  return withHumanResolutionGrantStoreLock(
    paths,
    stores,
    () => {
      const available = path.join(stores.available, `${grantId}.json`);
      const reserved = path.join(stores.reserved, `${grantId}.json`);
      const terminal = path.join(stores.terminal, `${grantId}.json`);
      if (
        privatePathExists(paths, reserved, humanResolutionGrantUnsafe) ||
        privatePathExists(paths, terminal, humanResolutionGrantUnsafe)
      ) {
        throw humanResolutionGrantUnavailable(grantId);
      }
      if (!privatePathExists(paths, available, humanResolutionGrantUnsafe)) {
        throw humanResolutionGrantUnavailable(grantId);
      }
      const envelope = readPrivateFile(available, humanResolutionGrantUnsafe);
      assertCanonicalResolutionEnvelopeBytes(envelope);
      ensurePrivateInvestigationDirectory(
        paths,
        path.dirname(reserved),
        humanResolutionGrantUnsafe,
      );
      fs.renameSync(available, reserved);
      fsyncDirectory(path.dirname(available));
      fsyncDirectory(path.dirname(reserved));
      return envelope;
    },
    { targetGrantId: grantId },
  );
}

export function readAvailableHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
): string {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  const stores = humanResolutionPaths(paths);
  return withHumanResolutionGrantStoreLock(
    paths,
    stores,
    () => {
      const available = path.join(stores.available, `${grantId}.json`);
      const reserved = path.join(stores.reserved, `${grantId}.json`);
      const terminal = path.join(stores.terminal, `${grantId}.json`);
      if (
        privatePathExists(paths, reserved, humanResolutionGrantUnsafe) ||
        privatePathExists(paths, terminal, humanResolutionGrantUnsafe) ||
        !privatePathExists(paths, available, humanResolutionGrantUnsafe)
      ) {
        throw humanResolutionGrantUnavailable(grantId);
      }
      const envelope = readPrivateFile(available, humanResolutionGrantUnsafe);
      assertCanonicalResolutionEnvelopeBytes(envelope);
      return envelope;
    },
    { targetGrantId: grantId },
  );
}

export function readReservedHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
): string {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  const stores = humanResolutionPaths(paths);
  return withHumanResolutionGrantStoreLock(
    paths,
    stores,
    () => {
      const filePath = path.join(stores.reserved, `${grantId}.json`);
      const envelope = readPrivateFile(filePath, humanResolutionGrantUnsafe);
      assertCanonicalResolutionEnvelopeBytes(envelope);
      return envelope;
    },
    { targetGrantId: grantId },
  );
}

export function terminalizeHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
  record: Record<string, unknown>,
): void {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  const stores = humanResolutionPaths(paths);
  withHumanResolutionGrantStoreLock(
    paths,
    stores,
    () => {
      const reserved = path.join(stores.reserved, `${grantId}.json`);
      const terminal = path.join(stores.terminal, `${grantId}.json`);
      if (privatePathExists(paths, terminal, humanResolutionGrantUnsafe)) {
        const existing = readPrivateCanonicalJson(
          paths,
          terminal,
          humanResolutionGrantUnsafe,
        );
        if (canonicalJson(existing) !== canonicalJson(record)) {
          throw humanResolutionGrantUnavailable(grantId);
        }
        reconcileTerminalHumanResolutionGrantResidual(
          paths,
          stores,
          grantId,
          existing,
        );
        return;
      }
      if (!privatePathExists(paths, reserved, humanResolutionGrantUnsafe)) {
        throw humanResolutionGrantUnavailable(grantId);
      }
      createPrivateCanonicalJson(
        paths,
        terminal,
        record,
        humanResolutionGrantUnsafe,
        'HUMAN_RESOLUTION_GRANT_TERMINAL_CONFLICT',
      );
      fs.unlinkSync(reserved);
      fsyncDirectory(path.dirname(reserved));
    },
    { targetGrantId: grantId },
  );
}

function reconcileTerminalHumanResolutionGrantResidual(
  paths: InvestigationRuntimePaths,
  stores: ReturnType<typeof humanResolutionPaths>,
  grantId: string,
  terminal: unknown,
): void {
  assertTerminalHumanResolutionGrant(terminal, grantId);
  const residuals = [stores.available, stores.reserved]
    .map((directory) => ({
      directory,
      state:
        directory === stores.available
          ? ('available' as const)
          : ('reserved' as const),
      filePath: path.join(directory, `${grantId}.json`),
    }))
    .filter(({ filePath }) =>
      privatePathExists(paths, filePath, humanResolutionGrantUnsafe),
    );
  if (residuals.length > 1) {
    throw humanResolutionGrantUnsafe();
  }
  const residual = residuals[0];
  if (!residual) {
    return;
  }
  assertTerminalHumanResolutionGrantResidual(
    paths,
    grantId,
    terminal,
    residual.state,
    residual.filePath,
  );
  fs.unlinkSync(residual.filePath);
  fsyncDirectory(residual.directory);
}

export function readTerminalHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
): Record<string, unknown> | null {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  const stores = humanResolutionPaths(paths);
  return withHumanResolutionGrantStoreLock(
    paths,
    stores,
    () => {
      const terminal = path.join(stores.terminal, `${grantId}.json`);
      if (!privatePathExists(paths, terminal, humanResolutionGrantUnsafe)) {
        return null;
      }
      const value = readPrivateCanonicalJson(
        paths,
        terminal,
        humanResolutionGrantUnsafe,
      );
      if (!isRecord(value)) {
        throw humanResolutionGrantUnsafe();
      }
      assertTerminalHumanResolutionGrant(value, grantId);
      return deepFreeze(value);
    },
    { targetGrantId: grantId },
  );
}

function inspectStoredHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  grantId: string,
): HumanResolutionGrantStoreEntry | null {
  const stores = humanResolutionPaths(paths);
  const candidates = [
    { state: 'available' as const, directory: stores.available },
    { state: 'reserved' as const, directory: stores.reserved },
    { state: 'terminal' as const, directory: stores.terminal },
  ].filter(({ directory }) =>
    privatePathExists(
      paths,
      path.join(directory, `${grantId}.json`),
      humanResolutionGrantUnsafe,
    ),
  );
  if (candidates.length === 0) {
    return null;
  }
  const terminalCandidate = candidates.find(
    ({ state }) => state === 'terminal',
  );
  if (terminalCandidate) {
    const terminal = readPrivateCanonicalJson(
      paths,
      path.join(terminalCandidate.directory, `${grantId}.json`),
      humanResolutionGrantUnsafe,
    );
    const terminalEntry = assertTerminalHumanResolutionGrant(terminal, grantId);
    const residuals = candidates.filter(({ state }) => state !== 'terminal');
    if (residuals.length > 1) {
      throw humanResolutionGrantUnsafe();
    }
    const residual = residuals[0];
    if (residual) {
      if (residual.state === 'terminal') {
        throw humanResolutionGrantUnsafe();
      }
      assertTerminalHumanResolutionGrantResidual(
        paths,
        grantId,
        terminal,
        residual.state,
        path.join(residual.directory, `${grantId}.json`),
      );
    }
    return terminalEntry;
  }
  if (candidates.length !== 1) {
    throw humanResolutionGrantUnsafe();
  }
  const candidate = candidates[0];
  if (!candidate || candidate.state === 'terminal') {
    throw humanResolutionGrantUnsafe();
  }
  const filePath = path.join(candidate.directory, `${grantId}.json`);
  {
    const envelopeBytes = readPrivateFile(filePath, humanResolutionGrantUnsafe);
    assertCanonicalResolutionEnvelopeBytes(envelopeBytes);
    return deepFreeze({
      grantId,
      state: candidate.state,
      envelopeBytes,
      terminalReason: null,
      recordedAt: null,
    });
  }
}

function assertTerminalHumanResolutionGrant(
  terminal: unknown,
  grantId: string,
): HumanResolutionGrantStoreEntry {
  const hasRevocationAuthorization =
    isRecord(terminal) &&
    Object.prototype.hasOwnProperty.call(terminal, 'revocationAuthorization');
  const terminalState =
    isRecord(terminal) &&
    (terminal.state === 'revoked' || terminal.state === 'consumed')
      ? terminal.state
      : null;
  const expectedKeys =
    terminalState === 'revoked'
      ? [
          'schemaVersion',
          'state',
          'grantId',
          'reason',
          'recordedAt',
          'envelope',
          ...(hasRevocationAuthorization ? ['revocationAuthorization'] : []),
        ]
      : [
          'schemaVersion',
          'state',
          'grantId',
          'resolutionNodeId',
          'receiptDigest',
          'recordedAt',
          'envelope',
        ];
  if (
    !isRecord(terminal) ||
    !hasExactKeys(terminal, expectedKeys) ||
    terminal.schemaVersion !== 1 ||
    terminalState === null ||
    terminal.grantId !== grantId ||
    !isTimestamp(terminal.recordedAt) ||
    !isRecord(terminal.envelope) ||
    (terminalState === 'revoked' &&
      !isBoundedResolutionText(terminal.reason, 1024)) ||
    (terminalState === 'consumed' &&
      (!isDigest(terminal.resolutionNodeId) ||
        !isDigest(terminal.receiptDigest)))
  ) {
    throw humanResolutionGrantUnsafe();
  }
  const envelopeBytes = `${canonicalJson(terminal.envelope)}\n`;
  assertCanonicalResolutionEnvelopeBytes(envelopeBytes);
  let revocationAuthorization: HumanRevocationAuthorization | null = null;
  if (terminalState === 'revoked' && hasRevocationAuthorization) {
    revocationAuthorization = assertHumanRevocationAuthorization(
      terminal.revocationAuthorization,
    );
    if (
      revocationAuthorization.payload.subjectKind !==
        'human-resolution-grant' ||
      revocationAuthorization.payload.grantId !== grantId ||
      revocationAuthorization.payload.reason !== terminal.reason ||
      revocationAuthorization.payload.revokedAt !== terminal.recordedAt
    ) {
      throw humanResolutionGrantUnsafe();
    }
  }
  return deepFreeze({
    grantId,
    state: terminalState,
    envelopeBytes,
    terminalReason:
      terminalState === 'revoked' ? String(terminal.reason) : null,
    recordedAt: terminal.recordedAt as string,
    ...(revocationAuthorization ? { revocationAuthorization } : {}),
  });
}

function assertTerminalHumanResolutionGrantResidual(
  paths: InvestigationRuntimePaths,
  grantId: string,
  terminal: unknown,
  residualState: 'available' | 'reserved',
  residualPath: string,
): void {
  const terminalEntry = assertTerminalHumanResolutionGrant(terminal, grantId);
  if (terminalEntry.state === 'consumed' && residualState !== 'reserved') {
    throw humanResolutionGrantUnsafe();
  }
  if (
    readPrivateFile(residualPath, humanResolutionGrantUnsafe) !==
    terminalEntry.envelopeBytes
  ) {
    throw humanResolutionGrantUnsafe();
  }
}

export function writeHumanResolutionJournal(
  paths: InvestigationRuntimePaths,
  journal: HumanResolutionJournal,
): void {
  const validated = assertHumanResolutionJournal(journal);
  const activePath = activeHumanResolutionJournalPath(
    paths,
    validated.target.changeId,
  );
  const historicalPath = humanResolutionJournalPath(paths, validated.grantId);
  if (validated.phase === 'grant-consumed') {
    const active = readActiveHumanResolutionJournal(
      paths,
      validated.target.changeId,
    );
    if (
      active === null ||
      active.journalId !== validated.journalId ||
      active.grantId !== validated.grantId
    ) {
      const historical = readHistoricalHumanResolutionJournal(
        paths,
        validated.grantId,
      );
      if (
        historical?.phase === 'grant-consumed' &&
        historical.journalId === validated.journalId
      ) {
        return;
      }
      throw humanResolutionRecoveryAmbiguous();
    }
    createPrivateCanonicalJson(
      paths,
      historicalPath,
      validated,
      humanResolutionJournalUnsafe,
      'HUMAN_RESOLUTION_JOURNAL_COLLISION',
    );
    fs.unlinkSync(activePath);
    fsyncDirectory(path.dirname(activePath));
    return;
  }
  const active = readActiveHumanResolutionJournal(
    paths,
    validated.target.changeId,
  );
  if (active === null) {
    if (validated.phase !== 'prepared') {
      throw humanResolutionRecoveryAmbiguous();
    }
    createPrivateCanonicalJson(
      paths,
      activePath,
      validated,
      humanResolutionJournalUnsafe,
      'HUMAN_RESOLUTION_ACTIVE_CONFLICT',
    );
    return;
  }
  if (
    active.journalId !== validated.journalId ||
    active.grantId !== validated.grantId
  ) {
    throw workflowError(
      'HUMAN_RESOLUTION_RECOVERY_REQUIRED',
      'Another human-resolution transaction must be recovered first.',
      ExitCode.conflict,
    );
  }
  if (
    humanResolutionJournalPhaseIndex(validated.phase) <
    humanResolutionJournalPhaseIndex(active.phase)
  ) {
    throw humanResolutionRecoveryAmbiguous();
  }
  writePrivateCanonicalJsonAtomic(
    paths,
    activePath,
    validated,
    humanResolutionJournalUnsafe,
  );
}

function humanResolutionJournalPhaseIndex(
  phase: HumanResolutionJournal['phase'],
): number {
  return [
    'prepared',
    'evidence-refs-published',
    'start-reservation-published',
    'current-ref-published',
    'state-published',
    'receipt-written',
    'grant-consumed',
  ].indexOf(phase);
}

export function readHumanResolutionJournal(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
): HumanResolutionJournal | null {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  const historical = readHistoricalHumanResolutionJournal(paths, grantId);
  if (historical !== null) {
    return historical;
  }
  const active = scanActiveHumanResolutionJournalDirectory(paths);
  if (active === null) {
    return null;
  }
  let match: HumanResolutionJournal | null = null;
  for (const name of active.journalNames) {
    const changeId = ACTIVE_HUMAN_RESOLUTION_JOURNAL.exec(name)?.[1];
    if (!changeId) throw humanResolutionJournalUnsafe();
    const candidate = readActiveHumanResolutionJournal(paths, changeId);
    if (candidate?.grantId !== grantId) {
      continue;
    }
    if (match !== null) {
      throw humanResolutionJournalUnsafe();
    }
    match = candidate;
  }
  return match;
}

export function readActiveHumanResolutionJournal(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
): HumanResolutionJournal | null {
  const changeId = assertChangeId(requestedChangeId);
  const journalPath = activeHumanResolutionJournalPath(paths, changeId);
  if (!privatePathExists(paths, journalPath, humanResolutionJournalUnsafe)) {
    return null;
  }
  const journal = assertHumanResolutionJournal(
    readPrivateCanonicalJson(paths, journalPath, humanResolutionJournalUnsafe),
  );
  if (journal.target.changeId !== changeId) {
    throw humanResolutionJournalUnsafe();
  }
  return journal;
}

function readHistoricalHumanResolutionJournal(
  paths: InvestigationRuntimePaths,
  grantId: string,
): HumanResolutionJournal | null {
  const journalPath = humanResolutionJournalPath(paths, grantId);
  if (!privatePathExists(paths, journalPath, humanResolutionJournalUnsafe)) {
    return null;
  }
  const journal = assertHumanResolutionJournal(
    readPrivateCanonicalJson(paths, journalPath, humanResolutionJournalUnsafe),
  );
  if (journal.grantId !== grantId || journal.phase !== 'grant-consumed') {
    throw humanResolutionJournalUnsafe();
  }
  return journal;
}

export function assertHumanResolutionLifecycleBarrier(
  runtimeRoot: string,
  allowedGrantId: string | null = null,
  allowedChangeId: string | null = null,
): void {
  if ((allowedGrantId === null) !== (allowedChangeId === null)) {
    throw humanResolutionJournalUnsafe();
  }
  const paths = investigationPathsFromLifecycleRoot(runtimeRoot);
  if (paths === null) {
    return;
  }
  const scanned = scanActiveHumanResolutionJournalDirectory(paths);
  if (scanned === null) {
    return;
  }
  const active = scanned.journalNames.map((name) => {
    const match = ACTIVE_HUMAN_RESOLUTION_JOURNAL.exec(name);
    if (!match?.[1]) {
      throw humanResolutionJournalUnsafe();
    }
    const changeId = assertChangeId(match[1]);
    const journal = readActiveHumanResolutionJournal(paths, changeId);
    if (journal === null || journal.target.changeId !== changeId) {
      throw humanResolutionJournalUnsafe();
    }
    return journal;
  });
  if (
    active.length === 0 ||
    (allowedGrantId !== null &&
      allowedChangeId !== null &&
      active.length === 1 &&
      active[0]?.grantId === allowedGrantId &&
      active[0]?.target.changeId === allowedChangeId)
  ) {
    return;
  }
  throw workflowError(
    'HUMAN_RESOLUTION_RECOVERY_REQUIRED',
    'An active human-resolution transaction blocks repository lifecycle changes.',
    ExitCode.conflict,
  );
}

export function reclaimHumanResolutionJournalTemporaries(
  runtimeRoot: string,
  assertRepositoryLifecycleOwned: () => void,
): void {
  assertRepositoryLifecycleOwned();
  const paths = investigationPathsFromLifecycleRoot(runtimeRoot);
  if (paths === null) {
    return;
  }
  const scanned = scanActiveHumanResolutionJournalDirectory(paths);
  if (scanned === null || scanned.temporaryPaths.length === 0) {
    return;
  }
  let removed = false;
  for (const temporaryPath of scanned.temporaryPaths) {
    assertRepositoryLifecycleOwned();
    const stats = fs.lstatSync(temporaryPath, { throwIfNoEntry: false });
    if (!stats) {
      continue;
    }
    assertPrivateFile(stats, humanResolutionJournalUnsafe);
    fs.unlinkSync(temporaryPath);
    removed = true;
  }
  if (removed) {
    fsyncDirectory(scanned.activeDirectory);
  }
  assertRepositoryLifecycleOwned();
}

function investigationPathsFromLifecycleRoot(
  runtimeRoot: string,
): InvestigationRuntimePaths | null {
  const resolvedRoot = path.resolve(runtimeRoot);
  const runtimeStats = fs.lstatSync(resolvedRoot, { throwIfNoEntry: false });
  if (!runtimeStats) {
    return null;
  }
  if (!runtimeStats.isDirectory() || runtimeStats.isSymbolicLink()) {
    throw humanResolutionJournalUnsafe();
  }
  const base = fs.realpathSync(resolvedRoot);
  const root = path.join(base, 'investigations');
  return {
    base,
    root,
    objects: path.join(root, 'objects', 'sha256'),
    refs: path.join(root, 'refs'),
    sessions: path.join(root, 'sessions'),
    invocations: path.join(root, 'invocations'),
    locks: path.join(root, 'locks'),
  };
}

function scanActiveHumanResolutionJournalDirectory(
  paths: InvestigationRuntimePaths,
): {
  activeDirectory: string;
  journalNames: string[];
  temporaryPaths: string[];
} | null {
  const activeDirectory = humanResolutionPaths(paths).active;
  if (
    !walkPrivateDirectory(
      paths,
      activeDirectory,
      humanResolutionJournalUnsafe,
      false,
    )
  ) {
    return null;
  }
  const journalNames: string[] = [];
  const temporaryPaths: string[] = [];
  for (const name of fs.readdirSync(activeDirectory).sort()) {
    if (ACTIVE_HUMAN_RESOLUTION_JOURNAL.test(name)) {
      journalNames.push(name);
      continue;
    }
    if (!ACTIVE_HUMAN_RESOLUTION_JOURNAL_TEMPORARY.test(name)) {
      throw humanResolutionJournalUnsafe();
    }
    const temporaryPath = path.join(activeDirectory, name);
    const stats = fs.lstatSync(temporaryPath, { throwIfNoEntry: false });
    if (!stats) {
      continue;
    }
    assertPrivateFile(stats, humanResolutionJournalUnsafe);
    temporaryPaths.push(temporaryPath);
  }
  if (journalNames.length > 4096) {
    throw humanResolutionJournalUnsafe();
  }
  return { activeDirectory, journalNames, temporaryPaths };
}

export function writeHumanResolutionArchive(
  paths: InvestigationRuntimePaths,
  currentStateDigest: string,
  state: InvestigationResolutionState,
): string {
  if (
    !isDigest(currentStateDigest) ||
    state.currentStateDigest !== currentStateDigest
  ) {
    throw humanResolutionStateInvalid();
  }
  const archive = {
    schemaVersion: 1,
    kind: 'human-resolution-evidence-archive',
    currentStateDigest,
    state,
  };
  const archiveDigest = sha256(canonicalJson(archive));
  createPrivateCanonicalJson(
    paths,
    path.join(humanResolutionPaths(paths).archives, `${archiveDigest}.json`),
    archive,
    humanResolutionArchiveUnsafe,
    'HUMAN_RESOLUTION_ARCHIVE_COLLISION',
  );
  return archiveDigest;
}

export function readHumanResolutionArchive(
  paths: InvestigationRuntimePaths,
  requestedArchiveDigest: string,
): InvestigationResolutionState {
  if (!isDigest(requestedArchiveDigest)) {
    throw humanResolutionArchiveUnsafe();
  }
  const value = readPrivateCanonicalJson(
    paths,
    path.join(
      humanResolutionPaths(paths).archives,
      `${requestedArchiveDigest}.json`,
    ),
    humanResolutionArchiveUnsafe,
  );
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'currentStateDigest',
      'state',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'human-resolution-evidence-archive' ||
    !isDigest(value.currentStateDigest) ||
    !isRecord(value.state)
  ) {
    throw humanResolutionArchiveUnsafe();
  }
  const archiveDigest = sha256(canonicalJson(value));
  const state = value.state as unknown as InvestigationResolutionState;
  if (
    archiveDigest !== requestedArchiveDigest ||
    state.currentStateDigest !== value.currentStateDigest ||
    investigationResolutionStateDigest(state.envelope) !==
      state.currentStateDigest
  ) {
    throw humanResolutionArchiveUnsafe();
  }
  return deepFreeze(structuredClone(state));
}

export function writeHumanResolutionReceipt(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
  receipt: Record<string, unknown>,
): string {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  const digest = sha256(canonicalJson(receipt));
  createPrivateCanonicalJson(
    paths,
    path.join(humanResolutionPaths(paths).receipts, `${grantId}.json`),
    receipt,
    humanResolutionReceiptUnsafe,
    'HUMAN_RESOLUTION_RECEIPT_COLLISION',
  );
  return digest;
}

function assertInvestigationSession(value: unknown): InvestigationSession {
  const hasSemanticRevision =
    isRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, 'semanticRevision');
  const hasLifecycleRevision =
    isRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, 'lifecycleRevision');
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'investigationId',
      'revision',
      ...(hasSemanticRevision && hasLifecycleRevision
        ? ['semanticRevision', 'lifecycleRevision']
        : []),
      'state',
      'changeId',
      ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
        ? ['mandateBinding']
        : []),
      'repositoryRoot',
      'gitCommonDirectory',
      'branch',
      'baseline',
      'intentDigest',
      'blindManifestDigest',
      'blindRequestDigest',
      'blindInvocationIds',
      'currentBlindInvocationId',
      'milestones',
      'blocker',
      'createdAt',
      'updatedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.investigationId !== 'string' ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    hasSemanticRevision !== hasLifecycleRevision ||
    (hasSemanticRevision &&
      (!Number.isSafeInteger(value.semanticRevision) ||
        (value.semanticRevision as number) < 0 ||
        !Number.isSafeInteger(value.lifecycleRevision) ||
        (value.lifecycleRevision as number) < 0 ||
        (value.semanticRevision as number) >
          (value.lifecycleRevision as number) ||
        value.lifecycleRevision !== value.revision)) ||
    typeof value.changeId !== 'string' ||
    (Object.prototype.hasOwnProperty.call(value, 'mandateBinding') &&
      !isTaskMandateBinding(value.mandateBinding, value.changeId)) ||
    typeof value.repositoryRoot !== 'string' ||
    typeof value.gitCommonDirectory !== 'string' ||
    (value.branch !== null && typeof value.branch !== 'string') ||
    !isBaseline(value.baseline) ||
    !isDigest(value.intentDigest) ||
    !isDigest(value.blindManifestDigest) ||
    !isDigest(value.blindRequestDigest) ||
    !isStringArray(value.blindInvocationIds) ||
    value.blindInvocationIds.length < 1 ||
    typeof value.currentBlindInvocationId !== 'string' ||
    !isMilestones(value.milestones) ||
    !isBlocker(value.blocker) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) {
    throw sessionInvalid();
  }
  assertInvestigationId(value.investigationId);
  assertChangeId(value.changeId);
  for (const invocationId of value.blindInvocationIds) {
    assertInvocationId(invocationId);
  }
  assertInvocationId(value.currentBlindInvocationId);
  if (
    new Set(value.blindInvocationIds).size !==
      value.blindInvocationIds.length ||
    !value.blindInvocationIds.includes(value.currentBlindInvocationId)
  ) {
    throw sessionInvalid();
  }
  const session = (
    hasSemanticRevision
      ? value
      : {
          ...value,
          semanticRevision: value.revision,
          lifecycleRevision: value.revision,
        }
  ) as InvestigationSession;
  if (
    session.state !== deriveInvestigationSessionState(session) ||
    !milestonesBelongToSession(session)
  ) {
    throw sessionInvalid();
  }
  return session;
}

function milestonesBelongToSession(session: InvestigationSession): boolean {
  for (const [kind, stored] of [
    ['main-terms', session.milestones.mainTerms],
    ['group-dispositions', session.milestones.groupDispositions],
    ['why-answers', session.milestones.whyAnswers],
  ] as const) {
    if (stored === null) {
      continue;
    }
    const envelope = stored.envelope;
    if (
      envelope.kind !== kind ||
      envelope.investigationId !== session.investigationId ||
      envelope.changeId !== session.changeId ||
      envelope.expectedRevision > session.revision ||
      canonicalJson(envelope.baseline) !== canonicalJson(session.baseline) ||
      envelope.intentDigest !== session.intentDigest ||
      envelope.blindManifestDigest !== session.blindManifestDigest ||
      envelope.checkpointId !== investigationCheckpointId(session, kind)
    ) {
      return false;
    }
  }
  const blindResult = session.milestones.blindResult;
  return (
    blindResult === null ||
    (blindResult.invocationId === session.currentBlindInvocationId &&
      blindResult.requestDigest === session.blindRequestDigest)
  );
}

function assertMonotonicSessionTransition(
  current: InvestigationSession,
  next: InvestigationSession,
): void {
  for (const key of [
    'schemaVersion',
    'investigationId',
    'changeId',
    'mandateBinding',
    'repositoryRoot',
    'gitCommonDirectory',
    'branch',
    'baseline',
    'intentDigest',
    'blindManifestDigest',
    'createdAt',
  ] as const) {
    if (
      canonicalJson(current[key] ?? null) !== canonicalJson(next[key] ?? null)
    ) {
      throw sessionTransitionInvalid();
    }
  }
  const blockerEntered =
    current.blocker === null &&
    next.blocker !== null &&
    !('code' in next.blocker) &&
    next.blocker.state === 'human-action-required';
  const blockerCleared =
    current.blocker !== null &&
    !('code' in current.blocker) &&
    next.blocker === null;
  if (
    next.revision !== current.revision + 1 ||
    next.lifecycleRevision !== current.lifecycleRevision + 1 ||
    next.semanticRevision !==
      current.semanticRevision +
        (semanticSessionContentChanged(current, next) ? 1 : 0) ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt) ||
    (canonicalJson(next.blocker) !== canonicalJson(current.blocker) &&
      !blockerEntered &&
      !blockerCleared) ||
    next.blindInvocationIds.length < current.blindInvocationIds.length ||
    current.blindInvocationIds.some(
      (invocationId, index) => next.blindInvocationIds[index] !== invocationId,
    )
  ) {
    throw sessionTransitionInvalid();
  }
  if (
    next.currentBlindInvocationId === current.currentBlindInvocationId &&
    (next.blindRequestDigest !== current.blindRequestDigest ||
      next.blindInvocationIds.length !== current.blindInvocationIds.length)
  ) {
    throw sessionTransitionInvalid();
  }
  if (
    next.currentBlindInvocationId !== current.currentBlindInvocationId &&
    (next.blindInvocationIds.length !== current.blindInvocationIds.length + 1 ||
      next.currentBlindInvocationId !== next.blindInvocationIds.at(-1) ||
      next.blindRequestDigest === current.blindRequestDigest)
  ) {
    throw sessionTransitionInvalid();
  }
  const reviewerReopen =
    current.milestones.reviewerTermSourceNodeId !==
      next.milestones.reviewerTermSourceNodeId &&
    next.milestones.reviewerTermSourceNodeId !== null;
  if (
    (!reviewerReopen &&
      next.milestones.reviewerTermSourceNodeId !==
        current.milestones.reviewerTermSourceNodeId) ||
    (reviewerReopen &&
      (!isDigest(next.milestones.reviewerTermSourceNodeId) ||
        next.milestones.groupDispositions !== null ||
        next.milestones.whyAnswers !== null))
  ) {
    throw sessionTransitionInvalid();
  }
  if (
    blockerEntered &&
    canonicalJson(next.milestones) !== canonicalJson(current.milestones)
  ) {
    throw sessionTransitionInvalid();
  }
  for (const key of ['mainTerms', 'blindResult'] as const) {
    const before = current.milestones[key];
    const after = next.milestones[key];
    if (before !== null && canonicalJson(before) !== canonicalJson(after)) {
      throw sessionTransitionInvalid();
    }
  }
  for (const key of ['groupDispositions', 'whyAnswers'] as const) {
    const before = current.milestones[key];
    const after = next.milestones[key];
    if (
      before !== null &&
      canonicalJson(before) !== canonicalJson(after) &&
      !(reviewerReopen && after === null)
    ) {
      throw sessionTransitionInvalid();
    }
  }
}

function semanticSessionContentChanged(
  current: InvestigationSession,
  next: InvestigationSession,
): boolean {
  return canonicalJson(current.milestones) !== canonicalJson(next.milestones);
}

function isMilestones(
  value: unknown,
): value is InvestigationSession['milestones'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'mainTerms',
      'blindResult',
      'reviewerTermSourceNodeId',
      'groupDispositions',
      'whyAnswers',
    ]) ||
    !isStoredCheckpoint(value.mainTerms, 'main-terms') ||
    !isBlindResult(value.blindResult) ||
    (value.reviewerTermSourceNodeId !== null &&
      !isDigest(value.reviewerTermSourceNodeId)) ||
    !isStoredCheckpoint(value.groupDispositions, 'group-dispositions') ||
    !isStoredCheckpoint(value.whyAnswers, 'why-answers')
  ) {
    return false;
  }
  if (
    value.groupDispositions !== null &&
    (value.mainTerms === null || value.blindResult === null)
  ) {
    return false;
  }
  if (value.whyAnswers !== null && value.groupDispositions === null) {
    return false;
  }
  return true;
}

function isStoredCheckpoint(
  value: unknown,
  kind: InvestigationCheckpointKind,
): value is StoredInvestigationCheckpoint | null {
  if (value === null) {
    return true;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'envelopeDigest',
      'contributionDigest',
      'envelope',
    ]) ||
    !isDigest(value.envelopeDigest) ||
    !isDigest(value.contributionDigest)
  ) {
    return false;
  }
  try {
    const envelope = assertInvestigationCheckpointEnvelope(value.envelope);
    return (
      envelope.kind === kind &&
      checkpointEnvelopeDigest(envelope) === value.envelopeDigest &&
      checkpointContributionDigest(envelope) === value.contributionDigest
    );
  } catch {
    return false;
  }
}

function isBlindResult(value: unknown): value is BlindResultReference | null {
  if (value === null) {
    return true;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['invocationId', 'requestDigest', 'outputDigest']) ||
    typeof value.invocationId !== 'string' ||
    !isDigest(value.requestDigest) ||
    !isDigest(value.outputDigest)
  ) {
    return false;
  }
  try {
    assertInvocationId(value.invocationId);
    return true;
  } catch {
    return false;
  }
}

function isBlocker(value: unknown): value is InvestigationSession['blocker'] {
  if (value === null) {
    return true;
  }
  if (
    isRecord(value) &&
    hasExactKeys(value, ['state', 'code']) &&
    (value.state === 'actor-resolution-required' ||
      value.state === 'human-action-required') &&
    typeof value.code === 'string' &&
    value.code.length > 0
  ) {
    return true;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'state',
      'reasonCode',
      'blockedTransition',
      'enteredAt',
      'facts',
      'availableResolutions',
    ]) ||
    value.schemaVersion !== 2 ||
    value.state !== 'human-action-required' ||
    !isBoundedResolutionText(value.reasonCode, 256) ||
    !isBoundedResolutionText(value.blockedTransition, 256) ||
    !isTimestamp(value.enteredAt) ||
    !isRecord(value.facts) ||
    !Array.isArray(value.availableResolutions)
  ) {
    return false;
  }
  const expected = advertisedHumanResolutions(
    value as InvestigationHumanActionBlocker,
  );
  return (
    canonicalJson(value.availableResolutions) === canonicalJson(expected) &&
    Buffer.byteLength(canonicalJson(value), 'utf8') <= 65_536
  );
}

function assertMainTermsPayload(
  value: unknown,
): asserts value is MainTermsPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['reference', 'terms']) ||
    typeof value.reference !== 'string' ||
    value.reference.trim().length === 0 ||
    !Array.isArray(value.terms) ||
    value.terms.length < 1 ||
    value.terms.length > INVESTIGATION_LIMITS.maxMainTerms
  ) {
    throw checkpointInvalid();
  }
  for (const term of value.terms) {
    if (
      !isRecord(term) ||
      !hasExactKeys(term, [
        'kind',
        'value',
        'rationale',
        'expectedRelationship',
      ]) ||
      typeof term.kind !== 'string' ||
      typeof term.value !== 'string' ||
      typeof term.rationale !== 'string' ||
      typeof term.expectedRelationship !== 'string'
    ) {
      throw checkpointInvalid();
    }
    try {
      previewInvestigationTermUnion([
        {
          source: 'main',
          reference: value.reference,
          terms: [
            {
              kind: term.kind as InvestigationTermKind,
              value: term.value,
              rationale: term.rationale,
              expectedRelationship: term.expectedRelationship,
            },
          ],
        },
      ]);
    } catch {
      throw checkpointInvalid();
    }
  }
}

function assertGroupDispositionsPayload(
  value: unknown,
): asserts value is GroupDispositionsPayload {
  if (
    !isRecord(value) ||
    !(
      hasExactKeys(value, ['dispositions']) ||
      hasExactKeys(value, ['classes', 'dispositions']) ||
      hasExactKeys(value, ['classes', 'dispositions', 'sampleAudits'])
    ) ||
    !Array.isArray(value.dispositions) ||
    value.dispositions.length > INVESTIGATION_LIMITS.maxHitDispositionWorkItems
  ) {
    throw checkpointInvalid();
  }
  if (value.classes !== undefined) {
    if (
      !Array.isArray(value.classes) ||
      value.classes.length > INVESTIGATION_LIMITS.maxHitDispositionWorkItems
    ) {
      throw checkpointInvalid();
    }
    if (value.sampleAudits !== undefined) {
      if (
        !Array.isArray(value.sampleAudits) ||
        value.sampleAudits.length >
          INVESTIGATION_LIMITS.maxHitDispositionWorkItems
      ) {
        throw checkpointInvalid();
      }
      for (const audit of value.sampleAudits) {
        if (
          !isRecord(audit) ||
          !hasExactKeys(audit, ['classId', 'groupId', 'outcome']) ||
          typeof audit.classId !== 'string' ||
          typeof audit.groupId !== 'string' ||
          !SAMPLE_AUDIT_OUTCOMES.has(audit.outcome as string)
        ) {
          throw checkpointInvalid();
        }
      }
    }
    const classIds = new Set<string>();
    for (const declared of value.classes) {
      // Parsed by the class contract itself rather than re-validated here, so
      // there is one definition of what a class is.
      const parsed = parseClassDisposition(declared);
      if (classIds.has(parsed.classId)) throw checkpointInvalid();
      classIds.add(parsed.classId);
    }
  }
  const seen = new Set<string>();
  const classifications = new Set([
    'load-bearing',
    'test-or-mirror',
    'generated',
    'incidental-reference',
    'irrelevant',
  ]);
  for (const item of value.dispositions) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, [
        'groupId',
        'classification',
        'rationale',
        'author',
      ]) ||
      typeof item.groupId !== 'string' ||
      !DIGEST.test(item.groupId) ||
      typeof item.classification !== 'string' ||
      !classifications.has(item.classification) ||
      typeof item.rationale !== 'string' ||
      item.rationale.trim().length === 0 ||
      typeof item.author !== 'string' ||
      item.author.trim().length === 0 ||
      seen.has(item.groupId)
    ) {
      throw checkpointInvalid();
    }
    seen.add(item.groupId);
  }
}

function assertWhyAnswersPayload(
  value: unknown,
): asserts value is WhyAnswersPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['answers']) ||
    !Array.isArray(value.answers) ||
    value.answers.length > INVESTIGATION_LIMITS.maxHitDispositionWorkItems
  ) {
    throw checkpointInvalid();
  }
  const seen = new Set<string>();
  for (const answer of value.answers) {
    if (
      !isRecord(answer) ||
      !hasExactKeys(answer, [
        'manifestEntryId',
        'why',
        'protectedInvariant',
        'reviewerQuestion',
        'answer',
        'semanticAuthor',
        'readComplete',
      ]) ||
      typeof answer.manifestEntryId !== 'string' ||
      !DIGEST.test(answer.manifestEntryId) ||
      !isSemanticText(answer.why) ||
      !isSemanticText(answer.protectedInvariant) ||
      !isSemanticText(answer.reviewerQuestion) ||
      !isSemanticText(answer.answer) ||
      typeof answer.semanticAuthor !== 'string' ||
      answer.semanticAuthor.trim().length === 0 ||
      answer.readComplete !== true ||
      seen.has(answer.manifestEntryId)
    ) {
      throw checkpointInvalid();
    }
    seen.add(answer.manifestEntryId);
  }
}

function isSemanticText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !/\b(?:TODO|FIXME|TBD|XXX|WIP)\b/i.test(value) &&
    !/\{\{[\s\S]*?\}\}/.test(value) &&
    !/<(?!!)[^>]*>/.test(value)
  );
}

function writePrivateTemporary(filePath: string, content: string): string {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, NO_FOLLOW_CREATE, 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    return temporary;
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function readPrivateFile(
  filePath: string,
  makeError: () => WorkflowError,
): string {
  return readPrivateBuffer(filePath, makeError).toString('utf8');
}

function readPrivateBuffer(
  filePath: string,
  makeError: () => WorkflowError,
): Buffer {
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!before) {
    throw makeError();
  }
  assertPrivateFile(before, makeError);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    throw makeError();
  }
  try {
    const opened = fs.fstatSync(descriptor);
    assertPrivateFile(opened, makeError);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw makeError();
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function walkPrivateDirectory(
  paths: InvestigationRuntimePaths,
  directory: string,
  makeError: () => WorkflowError,
  create: boolean,
): boolean {
  const relative = path.relative(paths.base, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw makeError();
  }
  let current = paths.base;
  for (const segment of relative.split(path.sep)) {
    if (!segment) {
      continue;
    }
    current = path.join(current, segment);
    let stats = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stats) {
      if (!create) {
        return false;
      }
      fs.mkdirSync(current, { mode: 0o700 });
      fs.chmodSync(current, 0o700);
      stats = fs.lstatSync(current);
      fsyncDirectory(path.dirname(current));
    }
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(current) !== path.resolve(current) ||
      (isInsideOrEqual(paths.root, current) && (stats.mode & 0o777) !== 0o700)
    ) {
      throw makeError();
    }
  }
  return true;
}

function releasePrivateRuntimeLock(
  lockPath: string,
  descriptor: number,
  owned: fs.Stats,
  marker: string,
  invalidLock: () => WorkflowError,
): void {
  const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
  let content: string | undefined;
  try {
    const bytes = Buffer.alloc(Buffer.byteLength(marker));
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    content = bytes.subarray(0, count).toString('utf8');
  } catch {
    content = undefined;
  }
  fs.closeSync(descriptor);
  if (
    !owned.isFile() ||
    owned.nlink !== 1 ||
    (owned.mode & 0o777) !== 0o600 ||
    !observed?.isFile() ||
    observed.isSymbolicLink() ||
    observed.nlink !== 1 ||
    (observed.mode & 0o777) !== 0o600 ||
    observed.dev !== owned.dev ||
    observed.ino !== owned.ino ||
    content !== marker
  ) {
    throw invalidLock();
  }
  fs.unlinkSync(lockPath);
  fsyncDirectory(path.dirname(lockPath));
}

function reclaimDeadPrivateRuntimeLock(
  lockPath: string,
  invalidLock: () => WorkflowError,
): boolean {
  const result = reclaimDeadPreparedLock(lockPath, (content) => {
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      return null;
    }
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'ownerToken',
        'pid',
        'createdAt',
      ]) ||
      value.schemaVersion !== 1 ||
      typeof value.ownerToken !== 'string' ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) < 1 ||
      !isTimestamp(value.createdAt) ||
      `${canonicalJson(value)}\n` !== content
    ) {
      return null;
    }
    return {
      pid: value.pid as number,
      ownerToken: value.ownerToken,
    };
  });
  if (result === 'unsafe') {
    throw invalidLock();
  }
  return result === 'absent' || result === 'reclaimed';
}

function assertPrivateFile(
  stats: fs.Stats,
  makeError: () => WorkflowError,
): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw makeError();
  }
}

function investigationSessionPath(
  paths: InvestigationRuntimePaths,
  investigationId: string,
): string {
  return path.join(paths.sessions, `${investigationId}.json`);
}

function currentInvestigationRefPath(
  paths: InvestigationRuntimePaths,
  changeId: string,
): string {
  return path.join(paths.refs, `${changeId}.investigation-session.json`);
}

function investigationStartReservationPath(
  paths: InvestigationRuntimePaths,
  changeId: string,
): string {
  return path.join(paths.refs, `${changeId}.investigation-start.json`);
}

function humanResolutionPaths(paths: InvestigationRuntimePaths) {
  const root = path.join(paths.root, 'human-resolutions');
  return {
    root,
    nodes: path.join(root, 'nodes'),
    refs: path.join(root, 'refs'),
    available: path.join(root, 'grants', 'available'),
    reserved: path.join(root, 'grants', 'reserved'),
    terminal: path.join(root, 'grants', 'terminal'),
    publicationRecoveries: path.join(root, 'grants', 'publication-recoveries'),
    active: path.join(root, 'active'),
    journals: path.join(root, 'journals'),
    receipts: path.join(root, 'receipts'),
    archives: path.join(root, 'archives'),
    retiredRefs: path.join(root, 'retired-refs'),
    quarantine: path.join(root, 'quarantine'),
    locks: path.join(root, 'locks'),
  };
}

function humanResolutionRevocationAuthorizationPath(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
): string {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  return path.join(
    humanResolutionPaths(paths).root,
    'grants',
    'revocation-authorizations',
    `${grantId}.json`,
  );
}

function humanResolutionRevocationBinding(
  paths: InvestigationRuntimePaths,
  envelopeBytes: string,
  grantId: string,
) {
  let envelope: unknown;
  try {
    envelope = JSON.parse(envelopeBytes);
  } catch {
    throw humanResolutionGrantUnsafe();
  }
  if (!isRecord(envelope) || !isRecord(envelope.payload)) {
    throw humanResolutionGrantUnsafe();
  }
  const payload = envelope.payload;
  if (
    payload.grantId !== grantId ||
    typeof payload.repositoryId !== 'string' ||
    typeof payload.repositoryOrigin !== 'string' ||
    !isRecord(payload.target) ||
    typeof payload.target.changeId !== 'string' ||
    typeof payload.target.workflowId !== 'string'
  ) {
    throw humanResolutionGrantUnsafe();
  }
  const session = readInvestigationSession(paths, payload.target.workflowId);
  if (
    session.changeId !== payload.target.changeId ||
    (session.mandateBinding !== undefined &&
      session.mandateBinding.changeId !== payload.target.changeId)
  ) {
    throw workflowError(
      'HUMAN_REVOCATION_BINDING_INVALID',
      'Human-resolution revocation session binding is unavailable or different.',
      ExitCode.guard,
    );
  }
  return {
    subjectKind: 'human-resolution-grant' as const,
    grantId,
    grantDigest: digestHumanRevocationSubject(envelopeBytes),
    repositoryId: payload.repositoryId,
    repositoryOrigin: payload.repositoryOrigin,
    changeId: payload.target.changeId,
    taskId: session.mandateBinding?.mandateTaskId ?? null,
    workflowId: payload.target.workflowId,
    audit: session.mandateBinding
      ? {
          externalAuditRoot: session.mandateBinding.externalAuditRoot,
          repositoryId: deriveAuthorityAuditRepositoryId(payload.repositoryId),
        }
      : null,
  };
}

function humanResolutionGrantPublicationRecoveryPath(
  stores: ReturnType<typeof humanResolutionPaths>,
  grantId: string,
): string {
  return path.join(stores.publicationRecoveries, `${grantId}.json`);
}

function readHumanResolutionGrantPublicationRecovery(
  paths: InvestigationRuntimePaths,
  stores: ReturnType<typeof humanResolutionPaths>,
  grantId: string,
): HumanResolutionGrantPublicationQuarantineReceipt | null {
  const receiptPath = humanResolutionGrantPublicationRecoveryPath(
    stores,
    grantId,
  );
  if (!privatePathExists(paths, receiptPath, humanResolutionGrantUnsafe)) {
    return null;
  }
  return assertHumanResolutionGrantPublicationQuarantineReceipt(
    readPrivateCanonicalJson(paths, receiptPath, humanResolutionGrantUnsafe),
    grantId,
  );
}

function assertNoPreparedHumanResolutionGrantPublicationRecovery(
  paths: InvestigationRuntimePaths,
  grantId: string,
): void {
  const stores = humanResolutionPaths(paths);
  withHumanResolutionGrantStoreLock(
    paths,
    stores,
    () => {
      const receipt = readHumanResolutionGrantPublicationRecovery(
        paths,
        stores,
        grantId,
      );
      if (receipt?.phase === 'prepared') {
        throw humanResolutionGrantPublicationRecoveryRequired();
      }
    },
    {
      allowInterruptedAvailablePublication: true,
      targetGrantId: grantId,
    },
  );
}

function withHumanResolutionGrantStoreLock<T>(
  paths: InvestigationRuntimePaths,
  stores: ReturnType<typeof humanResolutionPaths>,
  operation: () => T,
  options: {
    allowInterruptedAvailablePublication?: boolean;
    allowPreparedPublicationRecovery?: boolean;
    targetGrantId?: string;
  } = {},
): T {
  return withPrivateRuntimeLock(
    paths,
    path.join(stores.locks, 'grant-store.lock'),
    () => {
      reclaimHumanResolutionGrantTemporaries(
        paths,
        stores,
        options.allowInterruptedAvailablePublication ?? false,
        options.targetGrantId,
      );
      if (
        options.targetGrantId !== undefined &&
        !options.allowPreparedPublicationRecovery &&
        readHumanResolutionGrantPublicationRecovery(
          paths,
          stores,
          options.targetGrantId,
        )?.phase === 'prepared'
      ) {
        throw humanResolutionGrantPublicationRecoveryRequired();
      }
      return operation();
    },
    'HUMAN_RESOLUTION_GRANT_STORE_CONFLICT',
    humanResolutionGrantUnsafe,
  );
}

function reclaimHumanResolutionGrantTemporaries(
  paths: InvestigationRuntimePaths,
  stores: ReturnType<typeof humanResolutionPaths>,
  allowInterruptedAvailablePublication: boolean,
  targetGrantId: string | undefined,
): void {
  for (const directory of [
    stores.available,
    stores.terminal,
    stores.publicationRecoveries,
  ]) {
    if (
      !walkPrivateDirectory(paths, directory, humanResolutionGrantUnsafe, false)
    ) {
      continue;
    }
    let removed = false;
    for (const name of fs.readdirSync(directory)) {
      const temporaryMatch = HUMAN_RESOLUTION_GRANT_TEMPORARY.exec(name);
      if (!temporaryMatch?.[1]) {
        continue;
      }
      const temporaryGrantId = assertHumanResolutionGrantId(temporaryMatch[1]);
      const temporaryPath = path.join(directory, name);
      const stats = fs.lstatSync(temporaryPath, { throwIfNoEntry: false });
      if (!stats) {
        continue;
      }
      assertPrivateFile(stats, humanResolutionGrantUnsafe);
      if (directory === stores.available) {
        if (
          allowInterruptedAvailablePublication ||
          (targetGrantId !== undefined && temporaryGrantId !== targetGrantId)
        ) {
          continue;
        }
        throw humanResolutionGrantPublicationRecoveryRequired();
      }
      fs.unlinkSync(temporaryPath);
      removed = true;
    }
    if (removed) {
      fsyncDirectory(directory);
    }
  }
}

function listHumanResolutionGrantIds(
  paths: InvestigationRuntimePaths,
  directory: string,
): string[] {
  if (
    !walkPrivateDirectory(paths, directory, humanResolutionGrantUnsafe, false)
  ) {
    return [];
  }
  const names = fs.readdirSync(directory);
  if (names.length > 4096) {
    throw humanResolutionGrantUnsafe();
  }
  const grantIds: string[] = [];
  for (const name of names) {
    const match = HUMAN_RESOLUTION_GRANT_FILE.exec(name);
    if (match?.[1]) {
      grantIds.push(assertHumanResolutionGrantId(match[1]));
      continue;
    }
    if (HUMAN_RESOLUTION_GRANT_TEMPORARY.test(name)) {
      const stats = fs.lstatSync(path.join(directory, name), {
        throwIfNoEntry: false,
      });
      if (!stats) {
        continue;
      }
      assertPrivateFile(stats, humanResolutionGrantUnsafe);
      continue;
    }
    {
      throw humanResolutionGrantUnsafe();
    }
  }
  return grantIds;
}

function listHumanResolutionGrantPublicationRecoveryIds(
  paths: InvestigationRuntimePaths,
  stores: ReturnType<typeof humanResolutionPaths>,
): string[] {
  if (
    !walkPrivateDirectory(
      paths,
      stores.publicationRecoveries,
      humanResolutionGrantUnsafe,
      false,
    )
  ) {
    return [];
  }
  const names = fs.readdirSync(stores.publicationRecoveries).sort();
  if (names.length > 4096) {
    throw humanResolutionGrantUnsafe();
  }
  return names.map((name) => {
    const grantId = HUMAN_RESOLUTION_GRANT_FILE.exec(name)?.[1];
    if (!grantId) {
      throw humanResolutionGrantUnsafe();
    }
    const validatedGrantId = assertHumanResolutionGrantId(grantId);
    readHumanResolutionGrantPublicationRecovery(
      paths,
      stores,
      validatedGrantId,
    );
    return validatedGrantId;
  });
}

function humanResolutionGrantPublicationRecoveryRequired() {
  return workflowError(
    'HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_REQUIRED',
    'An interrupted human resolution grant publication requires explicit reconciliation through maintainer resolution-inspect and resolution-publication-discard.',
    ExitCode.unsafeEnvironment,
  );
}

type HumanResolutionGrantPublicationQuarantineArtifact = {
  temporaryName: string;
  rawSha256: string;
  unsafeObservationDigest: string;
  byteLength: number;
  quarantineArtifact: string;
};

type HumanResolutionGrantPublicationQuarantineReceipt = {
  schemaVersion: 1;
  kind: 'human-resolution-grant-publication-recovery';
  recoveryId: string;
  action: 'quarantined';
  phase: 'prepared' | 'quarantined';
  grantId: string;
  publicationStateDigest: string;
  auditTag: HumanResolutionGrantPublicationAuditTag;
  publicationStoreState: HumanResolutionGrantPublicationStoreState;
  artifacts: HumanResolutionGrantPublicationQuarantineArtifact[];
  reason: string;
  recordedAt: string;
};

function observeHumanResolutionGrantPublicationStoreState(
  paths: InvestigationRuntimePaths,
  stores: ReturnType<typeof humanResolutionPaths>,
  grantId: string,
): HumanResolutionGrantPublicationStoreState {
  for (const directory of [
    stores.available,
    stores.reserved,
    stores.terminal,
  ]) {
    listHumanResolutionGrantIds(paths, directory);
  }
  const temporaries = walkPrivateDirectory(
    paths,
    stores.available,
    humanResolutionGrantUnsafe,
    false,
  )
    ? fs
        .readdirSync(stores.available)
        .flatMap((temporaryName) => {
          const match = HUMAN_RESOLUTION_GRANT_TEMPORARY.exec(temporaryName);
          if (
            !match?.[1] ||
            assertHumanResolutionGrantId(match[1]) !== grantId
          ) {
            return [];
          }
          const { content, ...observed } = observePrivateGrantPublicationFile(
            path.join(stores.available, temporaryName),
          );
          return [
            {
              temporaryName,
              ...observed,
              parsedEnvelopeGrantId:
                parseInterruptedHumanResolutionGrantEnvelopeId(content),
            },
          ];
        })
        .sort((left, right) =>
          left.temporaryName.localeCompare(right.temporaryName),
        )
    : [];
  const digestIfPresent = (filePath: string): string | null =>
    privatePathExists(paths, filePath, humanResolutionGrantUnsafe)
      ? observePrivateGrantPublicationFile(filePath).rawSha256
      : null;
  return {
    grantId,
    temporaries,
    durable: {
      availableDigest: digestIfPresent(
        path.join(stores.available, `${grantId}.json`),
      ),
      reservedDigest: digestIfPresent(
        path.join(stores.reserved, `${grantId}.json`),
      ),
      terminalDigest: digestIfPresent(
        path.join(stores.terminal, `${grantId}.json`),
      ),
    },
    sameGrantJournalDigest: digestIfPresent(
      humanResolutionJournalPath(paths, grantId),
    ),
    sameGrantActiveJournalDigest: observeSameGrantActiveJournalDigest(
      paths,
      grantId,
    ),
    sameGrantReceiptDigest: digestIfPresent(
      path.join(stores.receipts, `${grantId}.json`),
    ),
  };
}

function observeSameGrantActiveJournalDigest(
  paths: InvestigationRuntimePaths,
  grantId: string,
): string | null {
  const scanned = scanActiveHumanResolutionJournalDirectory(paths);
  if (scanned === null) {
    return null;
  }
  let match: string | null = null;
  for (const name of scanned.journalNames) {
    const changeId = ACTIVE_HUMAN_RESOLUTION_JOURNAL.exec(name)?.[1];
    if (!changeId) {
      throw humanResolutionJournalUnsafe();
    }
    const journal = readActiveHumanResolutionJournal(paths, changeId);
    if (journal?.grantId !== grantId) {
      continue;
    }
    if (match !== null) {
      throw humanResolutionJournalUnsafe();
    }
    match = observePrivateGrantPublicationFile(
      path.join(scanned.activeDirectory, name),
    ).rawSha256;
  }
  return match;
}

function observePrivateGrantPublicationFile(filePath: string): {
  rawSha256: string;
  unsafeObservationDigest: string;
  byteLength: number;
  content: Buffer;
} {
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!before) {
    throw humanResolutionGrantUnsafe();
  }
  assertPrivateFile(before, humanResolutionGrantUnsafe);
  const content = readPrivateBuffer(filePath, humanResolutionGrantUnsafe);
  const after = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !after ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mode !== before.mode ||
    after.nlink !== before.nlink
  ) {
    throw humanResolutionGrantUnsafe();
  }
  const rawSha256 = sha256(content);
  return {
    rawSha256,
    unsafeObservationDigest: sha256(
      canonicalJson({
        schema: 'human-resolution-grant-publication-file.v1',
        device: before.dev,
        inode: before.ino,
        mode: before.mode & 0o777,
        nlink: before.nlink,
        byteLength: content.byteLength,
        rawSha256,
      }),
    ),
    byteLength: content.byteLength,
    content,
  };
}

function parseInterruptedHumanResolutionGrantEnvelopeId(
  content: Buffer,
): string | null {
  try {
    const value = JSON.parse(content.toString('utf8')) as unknown;
    if (
      isRecord(value) &&
      isRecord(value.payload) &&
      typeof value.payload.grantId === 'string' &&
      HUMAN_RESOLUTION_GRANT_FILE.test(`${value.payload.grantId}.json`)
    ) {
      return value.payload.grantId;
    }
  } catch {
    return null;
  }
  return null;
}

function completeHumanResolutionGrantPublicationQuarantine(
  paths: InvestigationRuntimePaths,
  stores: ReturnType<typeof humanResolutionPaths>,
  receipt: HumanResolutionGrantPublicationQuarantineReceipt,
): void {
  assertHumanResolutionGrantPublicationQuarantineReplayState(
    paths,
    stores,
    receipt,
  );
  for (const artifact of receipt.artifacts) {
    const temporaryPath = path.join(stores.available, artifact.temporaryName);
    const quarantinePath = path.join(
      stores.quarantine,
      artifact.quarantineArtifact,
    );
    if (!privatePathExists(paths, temporaryPath, humanResolutionGrantUnsafe)) {
      continue;
    }
    if (receipt.phase === 'quarantined') {
      throw humanResolutionGrantPublicationRecoveryStale();
    }
    fs.renameSync(temporaryPath, quarantinePath);
    fsyncDirectory(stores.available);
    fsyncDirectory(stores.quarantine);
  }
  assertHumanResolutionGrantPublicationQuarantineReplayState(
    paths,
    stores,
    receipt,
  );
}

function finalizeHumanResolutionGrantPublicationQuarantineReceipt(
  paths: InvestigationRuntimePaths,
  receiptPath: string,
  receipt: HumanResolutionGrantPublicationQuarantineReceipt,
): void {
  if (receipt.phase === 'quarantined') {
    return;
  }
  writePrivateCanonicalJsonAtomic(
    paths,
    receiptPath,
    {
      ...receipt,
      phase: 'quarantined',
    },
    humanResolutionGrantUnsafe,
  );
}

function assertHumanResolutionGrantPublicationQuarantineReceipt(
  value: unknown,
  grantId: string,
): HumanResolutionGrantPublicationQuarantineReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'recoveryId',
      'action',
      'phase',
      'grantId',
      'publicationStateDigest',
      'auditTag',
      'publicationStoreState',
      'artifacts',
      'reason',
      'recordedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'human-resolution-grant-publication-recovery' ||
    !isDigest(value.recoveryId) ||
    value.action !== 'quarantined' ||
    !['prepared', 'quarantined'].includes(String(value.phase)) ||
    value.grantId !== grantId ||
    !isDigest(value.publicationStateDigest) ||
    !isBoundedResolutionText(value.reason, 1024) ||
    !isTimestamp(value.recordedAt)
  ) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
  const recoveryId = value.recoveryId as string;
  const publicationStateDigest = value.publicationStateDigest as string;
  if (
    recoveryId !==
    sha256(
      canonicalJson({
        schema: 'human-resolution-grant-publication-quarantine.v1',
        grantId,
        publicationStateDigest,
      }),
    )
  ) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
  const publicationStoreState = assertHumanResolutionGrantPublicationStoreState(
    value.publicationStoreState,
    grantId,
  );
  const auditTag = assertHumanResolutionGrantPublicationAuditTag(
    value.auditTag,
    grantId,
  );
  if (
    sha256(
      canonicalJson({
        schemaVersion: 1,
        kind: 'human-resolution-grant-publication-state',
        ...publicationStoreState,
        auditTag,
      }),
    ) !== publicationStateDigest
  ) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
  if (
    !Array.isArray(value.artifacts) ||
    value.artifacts.length === 0 ||
    value.artifacts.length !== publicationStoreState.temporaries.length
  ) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
  const artifacts = value.artifacts.map((artifact, index) =>
    assertHumanResolutionGrantPublicationQuarantineArtifact(
      artifact,
      grantId,
      recoveryId,
      index,
      publicationStoreState.temporaries[index],
    ),
  );
  if (
    artifacts.some(
      (artifact, index) =>
        index > 0 &&
        artifact.temporaryName <= artifacts[index - 1]!.temporaryName,
    )
  ) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
  return value as HumanResolutionGrantPublicationQuarantineReceipt;
}

function assertHumanResolutionGrantPublicationAuditTag(
  value: unknown,
  grantId: string,
): HumanResolutionGrantPublicationAuditTag {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['status', 'tagRef', 'refObjectOid', 'objectType']) ||
    !['absent', 'present'].includes(String(value.status)) ||
    (value.tagRef !== null && typeof value.tagRef !== 'string') ||
    (value.refObjectOid !== null &&
      (typeof value.refObjectOid !== 'string' ||
        !GIT_OBJECT_ID.test(value.refObjectOid))) ||
    (value.objectType !== null && typeof value.objectType !== 'string') ||
    (value.status === 'absent' &&
      (value.tagRef !== null ||
        value.refObjectOid !== null ||
        value.objectType !== null)) ||
    (value.status === 'present' &&
      (value.tagRef === null ||
        value.refObjectOid === null ||
        value.objectType !== 'tag' ||
        !value.tagRef.endsWith(`/resolution-${grantId}`)))
  ) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
  return value as HumanResolutionGrantPublicationAuditTag;
}

function assertHumanResolutionGrantPublicationQuarantineArtifact(
  value: unknown,
  grantId: string,
  recoveryId: string,
  index: number,
  temporary: HumanResolutionGrantPublicationTemporary | undefined,
): HumanResolutionGrantPublicationQuarantineArtifact {
  if (
    !temporary ||
    !isRecord(value) ||
    !hasExactKeys(value, [
      'temporaryName',
      'rawSha256',
      'unsafeObservationDigest',
      'byteLength',
      'quarantineArtifact',
    ]) ||
    typeof value.temporaryName !== 'string' ||
    HUMAN_RESOLUTION_GRANT_TEMPORARY.exec(value.temporaryName)?.[1] !==
      grantId ||
    value.temporaryName !== temporary.temporaryName ||
    value.rawSha256 !== temporary.rawSha256 ||
    value.unsafeObservationDigest !== temporary.unsafeObservationDigest ||
    value.byteLength !== temporary.byteLength ||
    value.quarantineArtifact !==
      `${recoveryId}.${index + 1}.grant-publication.artifact`
  ) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
  return value as HumanResolutionGrantPublicationQuarantineArtifact;
}

function assertHumanResolutionGrantPublicationStoreState(
  value: unknown,
  grantId: string,
): HumanResolutionGrantPublicationStoreState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'grantId',
      'temporaries',
      'durable',
      'sameGrantJournalDigest',
      'sameGrantActiveJournalDigest',
      'sameGrantReceiptDigest',
    ]) ||
    value.grantId !== grantId ||
    !Array.isArray(value.temporaries) ||
    !isRecord(value.durable) ||
    !hasExactKeys(value.durable, [
      'availableDigest',
      'reservedDigest',
      'terminalDigest',
    ]) ||
    ![
      value.durable.availableDigest,
      value.durable.reservedDigest,
      value.durable.terminalDigest,
      value.sameGrantJournalDigest,
      value.sameGrantActiveJournalDigest,
      value.sameGrantReceiptDigest,
    ].every((candidate) => candidate === null || isDigest(candidate))
  ) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
  const temporaries = value.temporaries.map((temporary) =>
    assertHumanResolutionGrantPublicationTemporary(temporary, grantId),
  );
  if (
    temporaries.length === 0 ||
    temporaries.some(
      (temporary, index) =>
        index > 0 &&
        temporary.temporaryName <= temporaries[index - 1]!.temporaryName,
    )
  ) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
  return value as HumanResolutionGrantPublicationStoreState;
}

function assertHumanResolutionGrantPublicationTemporary(
  value: unknown,
  grantId: string,
): HumanResolutionGrantPublicationTemporary {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'temporaryName',
      'rawSha256',
      'unsafeObservationDigest',
      'byteLength',
      'parsedEnvelopeGrantId',
    ]) ||
    typeof value.temporaryName !== 'string' ||
    HUMAN_RESOLUTION_GRANT_TEMPORARY.exec(value.temporaryName)?.[1] !==
      grantId ||
    !isDigest(value.rawSha256) ||
    !isDigest(value.unsafeObservationDigest) ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) < 0 ||
    (value.parsedEnvelopeGrantId !== null &&
      (typeof value.parsedEnvelopeGrantId !== 'string' ||
        HUMAN_RESOLUTION_GRANT_FILE.exec(
          `${value.parsedEnvelopeGrantId}.json`,
        )?.[1] !== value.parsedEnvelopeGrantId))
  ) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
  return value as HumanResolutionGrantPublicationTemporary;
}

function assertHumanResolutionGrantPublicationQuarantineReplayState(
  paths: InvestigationRuntimePaths,
  stores: ReturnType<typeof humanResolutionPaths>,
  receipt: HumanResolutionGrantPublicationQuarantineReceipt,
): void {
  const observed = observeHumanResolutionGrantPublicationStoreState(
    paths,
    stores,
    receipt.grantId,
  );
  if (
    canonicalJson({
      durable: observed.durable,
      sameGrantJournalDigest: observed.sameGrantJournalDigest,
      sameGrantActiveJournalDigest: observed.sameGrantActiveJournalDigest,
      sameGrantReceiptDigest: observed.sameGrantReceiptDigest,
    }) !==
    canonicalJson({
      durable: receipt.publicationStoreState.durable,
      sameGrantJournalDigest:
        receipt.publicationStoreState.sameGrantJournalDigest,
      sameGrantActiveJournalDigest:
        receipt.publicationStoreState.sameGrantActiveJournalDigest,
      sameGrantReceiptDigest:
        receipt.publicationStoreState.sameGrantReceiptDigest,
    })
  ) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
  const remainingTemporaries = new Map(
    observed.temporaries.map((temporary) => [
      temporary.temporaryName,
      temporary,
    ]),
  );
  for (const artifact of receipt.artifacts) {
    const temporaryPath = path.join(stores.available, artifact.temporaryName);
    const quarantinePath = path.join(
      stores.quarantine,
      artifact.quarantineArtifact,
    );
    const temporaryExists = privatePathExists(
      paths,
      temporaryPath,
      humanResolutionGrantUnsafe,
    );
    const quarantineExists = privatePathExists(
      paths,
      quarantinePath,
      humanResolutionGrantUnsafe,
    );
    if (temporaryExists === quarantineExists) {
      throw humanResolutionGrantPublicationRecoveryStale();
    }
    const observedArtifact = observePrivateGrantPublicationFile(
      temporaryExists ? temporaryPath : quarantinePath,
    );
    if (
      observedArtifact.rawSha256 !== artifact.rawSha256 ||
      observedArtifact.unsafeObservationDigest !==
        artifact.unsafeObservationDigest ||
      observedArtifact.byteLength !== artifact.byteLength
    ) {
      throw humanResolutionGrantPublicationRecoveryStale();
    }
    if (temporaryExists) {
      const remaining = remainingTemporaries.get(artifact.temporaryName);
      if (
        !remaining ||
        remaining.rawSha256 !== artifact.rawSha256 ||
        remaining.unsafeObservationDigest !==
          artifact.unsafeObservationDigest ||
        remaining.byteLength !== artifact.byteLength
      ) {
        throw humanResolutionGrantPublicationRecoveryStale();
      }
      remainingTemporaries.delete(artifact.temporaryName);
    }
  }
  if (remainingTemporaries.size !== 0) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
}

function humanResolutionGrantPublicationRecoveryInvalid() {
  return workflowError(
    'HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_INVALID',
    'Interrupted human resolution grant publication recovery input is malformed.',
    ExitCode.guard,
  );
}

function humanResolutionGrantPublicationRecoveryStale() {
  return workflowError(
    'HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_STALE',
    'Interrupted human resolution grant publication no longer matches the inspected bytes.',
    ExitCode.staleState,
  );
}

function humanResolutionGrantPublicationRecoveryAmbiguous() {
  return workflowError(
    'HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_AMBIGUOUS',
    'Interrupted human resolution grant publication state is not a unique temp-only prefix.',
    ExitCode.unsafeEnvironment,
  );
}

function humanResolutionNodePath(
  paths: InvestigationRuntimePaths,
  nodeId: string,
): string {
  return path.join(humanResolutionPaths(paths).nodes, `${nodeId}.json`);
}

function humanResolutionRefPath(
  paths: InvestigationRuntimePaths,
  investigationId: string,
): string {
  return path.join(humanResolutionPaths(paths).refs, `${investigationId}.json`);
}

function humanResolutionJournalPath(
  paths: InvestigationRuntimePaths,
  grantId: string,
): string {
  return path.join(humanResolutionPaths(paths).journals, `${grantId}.json`);
}

function activeHumanResolutionJournalPath(
  paths: InvestigationRuntimePaths,
  changeId: string,
): string {
  return path.join(humanResolutionPaths(paths).active, `${changeId}.json`);
}

function assertHumanResolutionTarget(value: unknown): HumanResolutionTarget {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['workflowKind', 'changeId', 'workflowId']) ||
    value.workflowKind !== 'investigation' ||
    typeof value.changeId !== 'string' ||
    typeof value.workflowId !== 'string'
  ) {
    throw humanResolutionInvalid('Human resolution target is malformed.');
  }
  assertChangeId(value.changeId);
  assertInvestigationId(value.workflowId);
  return deepFreeze(structuredClone(value)) as HumanResolutionTarget;
}

function assertHumanResolutionExpected(
  value: unknown,
): HumanResolutionExpectedState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'reasonCode',
      'blockedTransition',
      'stateDigest',
      'currentRefDigest',
    ]) ||
    !isBoundedResolutionText(value.reasonCode, 256) ||
    !isBoundedResolutionText(value.blockedTransition, 256) ||
    !isDigest(value.stateDigest) ||
    (value.currentRefDigest !== null && !isDigest(value.currentRefDigest))
  ) {
    throw humanResolutionInvalid(
      'Human resolution expected-state binding is malformed.',
    );
  }
  return deepFreeze(structuredClone(value)) as HumanResolutionExpectedState;
}

function assertHumanResolutionNode(value: unknown): HumanResolutionNode {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'nodeId',
      'target',
      'expected',
      'decision',
      'consequences',
      'grantId',
      'grantDigest',
      'previousResolutionNodeId',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'human-resolution-node' ||
    !isDigest(value.nodeId) ||
    typeof value.grantId !== 'string' ||
    !isDigest(value.grantDigest) ||
    (value.previousResolutionNodeId !== null &&
      !isDigest(value.previousResolutionNodeId)) ||
    !isTimestamp(value.createdAt)
  ) {
    throw humanResolutionObjectUnsafe();
  }
  const candidate = createHumanResolutionNode({
    target: assertHumanResolutionTarget(value.target),
    expected: assertHumanResolutionExpected(value.expected),
    decision: assertHumanResolutionDecision(value.decision),
    consequences: assertHumanResolutionConsequences(value.consequences),
    grantId: assertHumanResolutionGrantId(value.grantId),
    grantDigest: value.grantDigest,
    previousResolutionNodeId: value.previousResolutionNodeId,
    createdAt: value.createdAt,
  });
  if (
    candidate.nodeId !== value.nodeId ||
    canonicalJson(candidate) !== canonicalJson(value)
  ) {
    throw humanResolutionObjectUnsafe();
  }
  return candidate;
}

function assertHumanResolutionJournal(value: unknown): HumanResolutionJournal {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'journalId',
      'phase',
      'grantId',
      'grantDigest',
      'target',
      'beforeStateDigest',
      'afterStateDigest',
      'beforeResolutionRef',
      'resolutionRefMode',
      'plannedResolutionNodeId',
      'plannedCurrentWorkflowRef',
      'plannedStartReservation',
      'plannedEvidenceRefs',
      'evidenceArchiveDigest',
      'receiptDigest',
      'createdAt',
    ]) ||
    value.schemaVersion !== 2 ||
    value.kind !== 'human-resolution-journal' ||
    !isDigest(value.journalId) ||
    ![
      'prepared',
      'evidence-refs-published',
      'start-reservation-published',
      'current-ref-published',
      'state-published',
      'receipt-written',
      'grant-consumed',
    ].includes(String(value.phase)) ||
    typeof value.grantId !== 'string' ||
    !isDigest(value.grantDigest) ||
    !isDigest(value.beforeStateDigest) ||
    !isDigest(value.afterStateDigest) ||
    (value.beforeResolutionRef !== null &&
      !isDigest(value.beforeResolutionRef)) ||
    !['preserve', 'quarantine-whole'].includes(
      String(value.resolutionRefMode),
    ) ||
    !isDigest(value.plannedResolutionNodeId) ||
    !isRecord(value.plannedCurrentWorkflowRef) ||
    !hasExactKeys(value.plannedCurrentWorkflowRef, [
      'expectedInvestigationId',
      'expectedDigest',
      'nextInvestigationId',
      'nextDigest',
    ]) ||
    (value.plannedCurrentWorkflowRef.expectedInvestigationId !== null &&
      typeof value.plannedCurrentWorkflowRef.expectedInvestigationId !==
        'string') ||
    (value.plannedCurrentWorkflowRef.nextInvestigationId !== null &&
      typeof value.plannedCurrentWorkflowRef.nextInvestigationId !==
        'string') ||
    !isNullableDigest(value.plannedCurrentWorkflowRef.expectedDigest) ||
    !isNullableDigest(value.plannedCurrentWorkflowRef.nextDigest) ||
    !isPlannedStartReservation(value.plannedStartReservation) ||
    !isPlannedEvidenceRefs(value.plannedEvidenceRefs) ||
    !isDigest(value.evidenceArchiveDigest) ||
    !isDigest(value.receiptDigest) ||
    !isTimestamp(value.createdAt)
  ) {
    throw humanResolutionJournalUnsafe();
  }
  assertHumanResolutionGrantId(value.grantId);
  const target = assertHumanResolutionTarget(value.target);
  for (const candidate of [
    value.plannedCurrentWorkflowRef.expectedInvestigationId,
    value.plannedCurrentWorkflowRef.nextInvestigationId,
  ]) {
    if (typeof candidate === 'string') {
      assertInvestigationId(candidate);
    }
  }
  if (
    value.plannedCurrentWorkflowRef.expectedDigest !==
      investigationCurrentRefDigest(
        value.plannedCurrentWorkflowRef.expectedInvestigationId === null
          ? null
          : {
              changeId: target.changeId,
              investigationId:
                value.plannedCurrentWorkflowRef.expectedInvestigationId,
            },
      ) ||
    value.plannedCurrentWorkflowRef.nextDigest !==
      investigationCurrentRefDigest(
        value.plannedCurrentWorkflowRef.nextInvestigationId === null
          ? null
          : {
              changeId: target.changeId,
              investigationId:
                value.plannedCurrentWorkflowRef.nextInvestigationId,
            },
      ) ||
    !validPlannedStartReservation(value.plannedStartReservation) ||
    !validPlannedEvidenceRefs(target.changeId, value.plannedEvidenceRefs)
  ) {
    throw humanResolutionJournalUnsafe();
  }
  const semantic = {
    schemaVersion: 2 as const,
    kind: 'human-resolution-journal' as const,
    phase: value.phase as HumanResolutionJournal['phase'],
    grantId: value.grantId,
    grantDigest: value.grantDigest,
    target,
    beforeStateDigest: value.beforeStateDigest,
    afterStateDigest: value.afterStateDigest,
    beforeResolutionRef: value.beforeResolutionRef,
    resolutionRefMode:
      value.resolutionRefMode as HumanResolutionJournal['resolutionRefMode'],
    plannedResolutionNodeId: value.plannedResolutionNodeId,
    plannedCurrentWorkflowRef:
      value.plannedCurrentWorkflowRef as HumanResolutionJournal['plannedCurrentWorkflowRef'],
    plannedStartReservation:
      value.plannedStartReservation as HumanResolutionJournal['plannedStartReservation'],
    plannedEvidenceRefs:
      value.plannedEvidenceRefs as HumanResolutionJournal['plannedEvidenceRefs'],
    evidenceArchiveDigest: value.evidenceArchiveDigest,
    receiptDigest: value.receiptDigest,
    createdAt: value.createdAt,
  };
  const journalId = sha256(
    canonicalJson({
      schema: 'human-resolution-journal.v2',
      journal: humanResolutionJournalIdentity(semantic),
    }),
  );
  if (journalId !== value.journalId) {
    throw humanResolutionJournalUnsafe();
  }
  return deepFreeze(structuredClone(value)) as HumanResolutionJournal;
}

function isNullableDigest(value: unknown): value is string | null {
  return value === null || isDigest(value);
}

function isEvidenceRefMap(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([name, nodeId]) =>
        /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(
          name,
        ) && isDigest(nodeId),
    )
  );
}

function isPlannedStartReservation(
  value: unknown,
): value is HumanResolutionJournal['plannedStartReservation'] {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'mode',
      'expectedDigest',
      'nextDigest',
      'archiveDigest',
    ]) &&
    (value.mode === 'preserve' ||
      value.mode === 'retire' ||
      value.mode === 'quarantine-whole') &&
    isNullableDigest(value.expectedDigest) &&
    isNullableDigest(value.nextDigest) &&
    isNullableDigest(value.archiveDigest)
  );
}

function validPlannedStartReservation(
  value: HumanResolutionJournal['plannedStartReservation'],
): boolean {
  return value.mode === 'preserve'
    ? value.nextDigest === value.expectedDigest && value.archiveDigest === null
    : value.expectedDigest !== null &&
        value.nextDigest === null &&
        value.archiveDigest === value.expectedDigest;
}

function isPlannedEvidenceRefs(
  value: unknown,
): value is HumanResolutionJournal['plannedEvidenceRefs'] {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'mode',
      'expectedDigest',
      'nextDigest',
      'expectedClosureDigest',
      'nextClosureDigest',
      'retiredRefs',
      'retainedRefs',
      'archiveDigest',
    ]) &&
    (value.mode === 'preserve' ||
      value.mode === 'partition' ||
      value.mode === 'quarantine-whole') &&
    isNullableDigest(value.expectedDigest) &&
    isNullableDigest(value.nextDigest) &&
    isNullableDigest(value.expectedClosureDigest) &&
    isNullableDigest(value.nextClosureDigest) &&
    isEvidenceRefMap(value.retiredRefs) &&
    isEvidenceRefMap(value.retainedRefs) &&
    isNullableDigest(value.archiveDigest)
  );
}

function validPlannedEvidenceRefs(
  changeId: string,
  value: HumanResolutionJournal['plannedEvidenceRefs'],
): boolean {
  if (
    Object.keys(value.retiredRefs).some((name) =>
      Object.hasOwn(value.retainedRefs, name),
    )
  ) {
    return false;
  }
  if (value.mode === 'preserve') {
    return (
      value.nextDigest === value.expectedDigest &&
      value.nextClosureDigest === value.expectedClosureDigest &&
      Object.keys(value.retiredRefs).length === 0 &&
      value.archiveDigest === null
    );
  }
  if (value.mode === 'quarantine-whole') {
    return (
      value.expectedDigest !== null &&
      value.nextDigest === null &&
      value.nextClosureDigest === null &&
      Object.keys(value.retiredRefs).length === 0 &&
      Object.keys(value.retainedRefs).length === 0 &&
      value.archiveDigest === value.expectedDigest
    );
  }
  const nextDigest =
    Object.keys(value.retainedRefs).length === 0
      ? null
      : sha256(
          canonicalJson({
            schemaVersion: 1,
            changeId,
            refs: value.retainedRefs,
          }),
        );
  return (
    value.expectedDigest !== null &&
    Object.keys(value.retiredRefs).length > 0 &&
    value.nextDigest === nextDigest &&
    isDigest(value.expectedClosureDigest) &&
    (value.nextDigest === null
      ? value.nextClosureDigest === null
      : isDigest(value.nextClosureDigest)) &&
    value.archiveDigest === value.expectedDigest
  );
}

function humanResolutionJournalIdentity(
  journal: Omit<HumanResolutionJournal, 'journalId'>,
): Omit<Omit<HumanResolutionJournal, 'journalId'>, 'phase'> {
  const { phase: _phase, ...identity } = journal;
  return identity;
}

function assertDecisionConsequences(
  decision: HumanResolutionDecision,
  consequences: HumanResolutionConsequences,
): void {
  if (
    ['supersede', 'repair'].includes(decision.kind) &&
    consequences.continuity !== 'broken'
  ) {
    throw humanResolutionInvalid(
      'Supersede and repair decisions must declare broken continuity.',
    );
  }
  if (decision.kind === 'abort' && consequences.continuity === 'preserved') {
    throw humanResolutionInvalid(
      'Abort cannot claim preserved workflow continuity.',
    );
  }
  if (
    decision.kind === 'waive-assurance' &&
    (consequences.assurance !== 'human-waived' ||
      !consequences.claimsWaived.includes(decision.claim))
  ) {
    throw humanResolutionInvalid(
      'An assurance waiver must name and downgrade the waived claim.',
    );
  }
  if (
    decision.kind === 'close-input' &&
    consequences.assurance === 'unchanged'
  ) {
    throw humanResolutionInvalid(
      'Closing reviewer input must declare degraded or waived assurance.',
    );
  }
}

function effectiveHumanResolutionState(
  node: HumanResolutionNode,
  fallback: InvestigationSessionState,
): InvestigationResolutionState['effectiveState'] {
  if (node.decision.kind === 'abort') {
    return 'aborted-by-human-resolution';
  }
  if (node.decision.kind === 'supersede' || node.decision.kind === 'repair') {
    return 'superseded-by-human-resolution';
  }
  if (node.decision.kind === 'quarantine') {
    return 'quarantined-by-human-resolution';
  }
  return fallback;
}

function terminalHumanResolutionState(
  value: InvestigationResolutionState['effectiveState'],
): boolean {
  return (
    value === 'aborted-by-human-resolution' ||
    value === 'superseded-by-human-resolution' ||
    value === 'quarantined-by-human-resolution'
  );
}

type BoundProviderRetryReservation = {
  attempt: number;
  previousInvocationId: string;
  invocationId: string;
  requestDigest: string;
  manifestDigest: string;
  nonce: string;
  request: ProviderInvocationRequest;
  executionPolicySnapshot: Record<string, unknown> | null;
  reservationDigest: string;
  status: 'committed' | 'pending';
};

function bindProviderRetryReservationResolutionState(
  paths: InvestigationRuntimePaths,
  session: InvestigationSession,
  makeError: () => WorkflowError,
): {
  reservations: InvestigationResolutionStateEnvelope['providerRetryReservations'];
  bindings: BoundProviderRetryReservation[];
} {
  assertPrivateInvestigationDirectory(paths, paths.refs, makeError);
  const prefix = `${session.investigationId}.provider-retry-`;
  const byAttempt = new Map<number, BoundProviderRetryReservation>();
  for (const name of fs.readdirSync(paths.refs).sort()) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const suffix = name.slice(prefix.length);
    const match = /^([0-9]+)\.json$/.exec(suffix);
    if (!match) {
      throw makeError();
    }
    const attempt = Number(match[1]);
    if (
      !Number.isSafeInteger(attempt) ||
      attempt < 2 ||
      String(attempt) !== match[1] ||
      byAttempt.has(attempt)
    ) {
      throw makeError();
    }
    const status =
      attempt <= session.blindInvocationIds.length
        ? ('committed' as const)
        : ('pending' as const);
    if (attempt > session.blindInvocationIds.length + 1) {
      throw makeError();
    }
    byAttempt.set(
      attempt,
      readBoundProviderRetryReservation(
        paths,
        path.join(paths.refs, name),
        session,
        attempt,
        status,
        makeError,
      ),
    );
  }
  for (
    let attempt = 2;
    attempt <= session.blindInvocationIds.length;
    attempt += 1
  ) {
    if (!byAttempt.has(attempt)) {
      throw makeError();
    }
  }
  const bindings = [...byAttempt.values()].sort(
    (left, right) => left.attempt - right.attempt,
  );
  return {
    reservations: bindings.map(
      ({
        attempt,
        previousInvocationId,
        invocationId,
        reservationDigest,
        status,
      }) => ({
        attempt,
        previousInvocationId,
        invocationId,
        reservationDigest,
        status,
      }),
    ),
    bindings,
  };
}

function readBoundProviderRetryReservation(
  paths: InvestigationRuntimePaths,
  filePath: string,
  session: InvestigationSession,
  expectedAttempt: number,
  status: BoundProviderRetryReservation['status'],
  makeError: () => WorkflowError,
): BoundProviderRetryReservation {
  walkPrivateDirectory(paths, path.dirname(filePath), makeError, false);
  const content = readPrivateFile(filePath, makeError);
  if (Buffer.byteLength(content, 'utf8') > MAX_HUMAN_RESOLUTION_BYTES) {
    throw makeError();
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw makeError();
  }
  const retryV2 = isRecord(value) && value.schemaVersion === 2;
  if (
    content !== `${canonicalJson(value)}\n` ||
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'investigationId',
      'changeId',
      'attempt',
      'previousInvocationId',
      'invocationId',
      'manifestDigest',
      'requestDigest',
      'request',
      'createdAt',
      ...(retryV2
        ? [
            'executionPolicySnapshot',
            ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
              ? ['mandateBinding']
              : []),
            'retryDecision',
          ]
        : []),
    ]) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    value.kind !== 'provider-retry-reservation' ||
    value.investigationId !== session.investigationId ||
    value.changeId !== session.changeId ||
    canonicalJson(value.mandateBinding ?? null) !==
      canonicalJson(session.mandateBinding ?? null) ||
    value.attempt !== expectedAttempt ||
    typeof value.previousInvocationId !== 'string' ||
    typeof value.invocationId !== 'string' ||
    !isDigest(value.manifestDigest) ||
    !isDigest(value.requestDigest) ||
    !isTimestamp(value.createdAt)
  ) {
    throw makeError();
  }
  let previousInvocationId: string;
  let invocationId: string;
  try {
    previousInvocationId = assertInvocationId(value.previousInvocationId);
    invocationId = assertInvocationId(value.invocationId);
  } catch {
    throw makeError();
  }
  const expectedPrevious =
    session.blindInvocationIds[expectedAttempt - 2] ?? null;
  const expectedCommitted =
    status === 'committed'
      ? (session.blindInvocationIds[expectedAttempt - 1] ?? null)
      : null;
  if (
    expectedPrevious === null ||
    previousInvocationId !== expectedPrevious ||
    (status === 'committed' && invocationId !== expectedCommitted) ||
    (status === 'pending' &&
      session.blindInvocationIds.includes(invocationId)) ||
    invocationId === previousInvocationId ||
    value.manifestDigest !== session.blindManifestDigest
  ) {
    throw makeError();
  }
  let request: ProviderInvocationRequest;
  try {
    request = recreateProviderInvocationRequest(value.request);
  } catch {
    throw makeError();
  }
  if (
    request.invocationId !== invocationId ||
    request.requestDigest !== value.requestDigest ||
    request.purpose !== 'survey' ||
    request.inputManifestDigest !== value.manifestDigest ||
    request.baseCommit !== session.baseline.head ||
    request.baseTree !== session.baseline.tree
  ) {
    throw makeError();
  }
  let executionPolicySnapshot: Record<string, unknown> | null = null;
  if (retryV2) {
    if (
      !isRecord(value.executionPolicySnapshot) ||
      !isRecord(value.retryDecision)
    ) {
      throw makeError();
    }
    try {
      assertProviderExecutionPolicySnapshot(
        paths,
        value.executionPolicySnapshot,
        request,
      );
    } catch {
      throw makeError();
    }
    executionPolicySnapshot = value.executionPolicySnapshot;
  }
  return {
    attempt: expectedAttempt,
    previousInvocationId,
    invocationId,
    requestDigest: request.requestDigest,
    manifestDigest: value.manifestDigest,
    nonce: request.nonce,
    request,
    executionPolicySnapshot,
    reservationDigest: sha256(content),
    status,
  };
}

function observeProviderRetryReservationAmbiguities(
  paths: InvestigationRuntimePaths,
  session: InvestigationSession,
  observations: Array<{
    object: string;
    observationDigest: string;
  }>,
): void {
  const prefix = `${session.investigationId}.provider-retry-`;
  let names: string[];
  try {
    assertPrivateInvestigationDirectory(
      paths,
      paths.refs,
      providerInvocationUnsafe,
    );
    names = fs
      .readdirSync(paths.refs)
      .filter((name) => name.startsWith(prefix));
  } catch {
    observeUnsafePath(
      paths.refs,
      `provider-retry-reservations:${session.investigationId}`,
      observations,
    );
    return;
  }
  const targets = new Set<string>(
    names.map((name) => path.join(paths.refs, name)),
  );
  for (
    let attempt = 2;
    attempt <= session.blindInvocationIds.length;
    attempt += 1
  ) {
    targets.add(path.join(paths.refs, `${prefix}${attempt}.json`));
  }
  for (const target of [...targets].sort()) {
    observeUnsafePath(
      target,
      `provider-retry-reservation:${path.basename(target)}`,
      observations,
    );
  }
}

function bindProviderInvocationResolutionState(
  paths: InvestigationRuntimePaths,
  session: InvestigationSession,
  retryBindings: BoundProviderRetryReservation[],
): Pick<
  InvestigationResolutionStateEnvelope,
  'providerInvocationDigests' | 'repositoryProviderLeases'
> {
  const scan = scanProviderInvocationLifecycles(paths);
  const projections = [...scan.projections];
  const pendingRetry =
    retryBindings.find(({ status }) => status === 'pending') ?? null;
  const allowedReservedSnapshotIds = new Set<string>();
  for (const { invocationId } of scan.unsafeInvocations) {
    if (pendingRetry?.invocationId === invocationId) {
      assertPendingProviderExecutionPolicySnapshot(paths, pendingRetry);
      allowedReservedSnapshotIds.add(invocationId);
    } else if (
      isDurablyReservedProviderExecutionPolicySnapshot(paths, invocationId)
    ) {
      allowedReservedSnapshotIds.add(invocationId);
    }
  }
  const unsafeInvocations = scan.unsafeInvocations.filter(
    ({ invocationId }) => !allowedReservedSnapshotIds.has(invocationId),
  );
  const target = projections.filter(
    (projection) =>
      projection.ownerInvestigationId === session.investigationId &&
      projection.changeId === session.changeId,
  );
  if (
    unsafeInvocations.some(
      ({ invocationId, ownerInvestigationId }) =>
        ownerInvestigationId === session.investigationId ||
        invocationId === pendingRetry?.invocationId,
    )
  ) {
    throw providerInvocationUnsafe();
  }
  const globalPendingProjection =
    pendingRetry === null
      ? undefined
      : projections.find(
          ({ invocationId }) => invocationId === pendingRetry.invocationId,
        );
  if (
    globalPendingProjection !== undefined &&
    (globalPendingProjection.ownerInvestigationId !== session.investigationId ||
      globalPendingProjection.changeId !== session.changeId ||
      globalPendingProjection.purpose !== 'survey')
  ) {
    throw providerInvocationUnsafe();
  }
  const targetSurveys = target.filter(
    (projection) => projection.purpose === 'survey',
  );
  const targetSurveyIds = targetSurveys
    .map((projection) => projection.invocationId)
    .sort();
  const expectedSurveyIds = [...session.blindInvocationIds];
  if (
    pendingRetry !== null &&
    targetSurveyIds.includes(pendingRetry.invocationId)
  ) {
    expectedSurveyIds.push(pendingRetry.invocationId);
  }
  if (
    canonicalJson(targetSurveyIds) !== canonicalJson(expectedSurveyIds.sort())
  ) {
    throw providerInvocationUnsafe();
  }
  const boundNonces = session.blindInvocationIds.map((invocationId) => {
    const projection = targetSurveys.find(
      (candidate) => candidate.invocationId === invocationId,
    );
    if (projection === undefined) {
      throw providerInvocationUnsafe();
    }
    return projection.nonce;
  });
  if (pendingRetry !== null) {
    boundNonces.push(pendingRetry.nonce);
  }
  if (new Set(boundNonces).size !== boundNonces.length) {
    throw providerInvocationUnsafe();
  }
  const retryByAttempt = new Map(
    retryBindings.map((binding) => [binding.attempt, binding]),
  );
  for (const [index, invocationId] of session.blindInvocationIds.entries()) {
    const attempt = index + 1;
    const projection = targetSurveys.find(
      (candidate) => candidate.invocationId === invocationId,
    );
    if (
      projection === undefined ||
      projection.attempt !== attempt ||
      projection.manifestDigest !== session.blindManifestDigest
    ) {
      throw providerInvocationUnsafe();
    }
    if (attempt === 1) {
      continue;
    }
    const retry = retryByAttempt.get(attempt);
    const previous = targetSurveys.find(
      (candidate) =>
        candidate.invocationId === session.blindInvocationIds[index - 1],
    );
    if (
      retry === undefined ||
      retry.status !== 'committed' ||
      retry.invocationId !== projection.invocationId ||
      retry.requestDigest !== projection.requestDigest ||
      retry.manifestDigest !== projection.manifestDigest ||
      previous?.state !== 'failed' ||
      previous.failureKind !== 'retryable'
    ) {
      throw providerInvocationUnsafe();
    }
  }
  if (pendingRetry !== null) {
    const previous = targetSurveys.find(
      (candidate) =>
        candidate.invocationId === pendingRetry.previousInvocationId,
    );
    const pendingProjection = targetSurveys.find(
      (candidate) => candidate.invocationId === pendingRetry.invocationId,
    );
    if (
      previous?.state !== 'failed' ||
      previous.failureKind !== 'retryable' ||
      (pendingProjection !== undefined &&
        (pendingProjection.attempt !== pendingRetry.attempt ||
          pendingProjection.requestDigest !== pendingRetry.requestDigest ||
          pendingProjection.manifestDigest !== pendingRetry.manifestDigest))
    ) {
      throw providerInvocationUnsafe();
    }
  }
  return {
    providerInvocationDigests: [
      ...target.map(({ invocationId }) => ({
        invocationId,
        files: digestPrivateDirectoryEntries(
          paths,
          path.join(paths.invocations, invocationId),
          providerInvocationUnsafe,
        ),
      })),
      ...unsafeInvocations.map(({ invocationId, observationDigest }) => ({
        invocationId,
        files: [{ name: 'unsafe-observation', digest: observationDigest }],
      })),
    ].sort((left, right) =>
      left.invocationId.localeCompare(right.invocationId),
    ),
    repositoryProviderLeases: projections
      .filter(
        (
          projection,
        ): projection is ProviderInvocationLifecycleProjection & {
          lease: NonNullable<ProviderInvocationLifecycleProjection['lease']>;
        } => projection.state === 'leased' && projection.lease !== null,
      )
      .map((projection) => ({
        invocationId: projection.invocationId,
        investigationId: projection.ownerInvestigationId,
        changeId: projection.changeId,
        revision: projection.revision,
        leaseGeneration: projection.leaseGeneration,
        leaseDigest: sha256(canonicalJson(projection.lease)),
      })),
  };
}

function assertPendingProviderExecutionPolicySnapshot(
  paths: InvestigationRuntimePaths,
  pending: BoundProviderRetryReservation,
): string | null {
  const directory = path.join(paths.invocations, pending.invocationId);
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stats) {
    return null;
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    !walkPrivateDirectory(paths, directory, providerInvocationUnsafe, false) ||
    canonicalJson(fs.readdirSync(directory).sort()) !==
      canonicalJson(['execution-policy.json'])
  ) {
    throw providerInvocationUnsafe();
  }
  const snapshot = readPrivateCanonicalJson(
    paths,
    path.join(directory, 'execution-policy.json'),
    providerInvocationUnsafe,
  );
  assertProviderExecutionPolicySnapshot(paths, snapshot, pending.request);
  if (
    pending.executionPolicySnapshot !== null &&
    canonicalJson(snapshot) !== canonicalJson(pending.executionPolicySnapshot)
  ) {
    throw providerInvocationUnsafe();
  }
  return pending.invocationId;
}

function isDurablyReservedProviderExecutionPolicySnapshot(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): boolean {
  const directory = path.join(paths.invocations, invocationId);
  try {
    if (
      canonicalJson(fs.readdirSync(directory).sort()) !==
      canonicalJson(['execution-policy.json'])
    ) {
      return false;
    }
    for (const name of fs.readdirSync(paths.refs).sort()) {
      if (
        !name.endsWith('.investigation-start.json') &&
        !/\.provider-retry-[1-9][0-9]*\.json$/.test(name)
      ) {
        continue;
      }
      const value = readPrivateCanonicalJson(
        paths,
        path.join(paths.refs, name),
        providerInvocationUnsafe,
      );
      if (!isRecord(value) || !isRecord(value.request)) {
        continue;
      }
      const retryV2 =
        value.kind === 'provider-retry-reservation' &&
        value.schemaVersion === 2;
      const expectedKeys =
        value.kind === 'investigation-start-reservation'
          ? [
              'baseline',
              'branch',
              'changeId',
              'createdAt',
              'gitCommonDirectory',
              'investigationId',
              'invocationId',
              'kind',
              ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
                ? ['mandateBinding']
                : []),
              'manifest',
              'manifestDigest',
              'repositoryRoot',
              'request',
              'requestDigest',
              'schemaVersion',
            ]
          : value.kind === 'provider-retry-reservation'
            ? [
                'attempt',
                'changeId',
                'createdAt',
                'investigationId',
                'invocationId',
                'kind',
                'manifestDigest',
                ...(Object.prototype.hasOwnProperty.call(
                  value,
                  'mandateBinding',
                )
                  ? ['mandateBinding']
                  : []),
                'previousInvocationId',
                'request',
                'requestDigest',
                'schemaVersion',
                ...(retryV2
                  ? ['executionPolicySnapshot', 'retryDecision']
                  : []),
              ]
            : null;
      if (
        expectedKeys === null ||
        !hasExactKeys(value, expectedKeys) ||
        (value.schemaVersion !== 1 && !retryV2) ||
        value.invocationId !== invocationId
      ) {
        continue;
      }
      const request = recreateProviderInvocationRequest(value.request);
      if (
        request.invocationId !== invocationId ||
        request.requestDigest !== value.requestDigest
      ) {
        continue;
      }
      const storedSnapshot = readPrivateCanonicalJson(
        paths,
        path.join(directory, 'execution-policy.json'),
        providerInvocationUnsafe,
      );
      assertProviderExecutionPolicySnapshot(paths, storedSnapshot, request);
      if (retryV2) {
        assertProviderExecutionPolicySnapshot(
          paths,
          value.executionPolicySnapshot,
          request,
        );
        if (
          canonicalJson(storedSnapshot) !==
          canonicalJson(value.executionPolicySnapshot)
        ) {
          continue;
        }
      }
      return true;
    }
    for (const name of fs.readdirSync(paths.refs).sort()) {
      if (!name.endsWith('.json')) continue;
      const changeId = name.slice(0, -'.json'.length);
      let refs: Record<string, string>;
      try {
        assertChangeId(changeId);
        refs = readEvidenceRefs(paths, changeId);
      } catch {
        continue;
      }
      const nodeId = refs['propose/plan-review-request'];
      if (nodeId === undefined) continue;
      const node = readEvidenceNode(paths, nodeId);
      if (
        node.type !== 'plan-review-request-reservation' ||
        node.nodeSchema !== 'workflow.plan-review-request-reservation.v3' ||
        node.outputSchema !==
          'workflow.plan-review-request-reservation-output.v3' ||
        !isRecord(node.output) ||
        !isRecord(node.output.retry) ||
        !isRecord(node.output.retry.executionPolicySnapshot) ||
        !isRecord(node.output.request)
      ) {
        continue;
      }
      const request = recreateProviderInvocationRequest(node.output.request);
      if (request.invocationId !== invocationId) continue;
      const storedSnapshot = readPrivateCanonicalJson(
        paths,
        path.join(directory, 'execution-policy.json'),
        providerInvocationUnsafe,
      );
      assertProviderExecutionPolicySnapshot(paths, storedSnapshot, request);
      assertProviderExecutionPolicySnapshot(
        paths,
        node.output.retry.executionPolicySnapshot,
        request,
      );
      if (
        canonicalJson(storedSnapshot) !==
        canonicalJson(node.output.retry.executionPolicySnapshot)
      ) {
        continue;
      }
      // The ref parser plus node identity bind the recovery journal; the full
      // closure is evaluated by status before the reservation is consumed.
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function digestPrivateDirectoryEntries(
  paths: InvestigationRuntimePaths,
  directory: string,
  makeError: () => WorkflowError,
): Array<{ name: string; digest: string }> {
  if (!walkPrivateDirectory(paths, directory, makeError, false)) {
    throw makeError();
  }
  const manifestContent = readPrivateFile(
    path.join(directory, 'manifest.json'),
    makeError,
  );
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestContent);
  } catch {
    throw makeError();
  }
  const snapshotArtifacts =
    isRecord(manifest) &&
    manifest.kind === 'plan-review-manifest' &&
    manifest.planningTarget !== undefined
      ? planReviewSnapshotArtifacts(manifest.planningTarget, makeError)
      : null;
  const rootNames = fs.readdirSync(directory).sort();
  const runtimePath = path.join(directory, 'runtime');
  const runtimeStats = fs.lstatSync(runtimePath, { throwIfNoEntry: false });
  const reviewRootPath = path.join(directory, 'review-root');
  const optionalRootFiles = OPTIONAL_PROVIDER_ROOT_FILES.filter((name) =>
    rootNames.includes(name),
  );
  const expectedRootNames = [
    ...BLIND_PROVIDER_ROOT_FILES,
    ...optionalRootFiles,
    ...(runtimeStats ? ['runtime'] : []),
    ...(snapshotArtifacts === null ? [] : ['review-root']),
  ].sort();
  if (canonicalJson(rootNames) !== canonicalJson(expectedRootNames)) {
    throw makeError();
  }

  const files: Array<{ name: string; digest: string }> =
    BLIND_PROVIDER_ROOT_FILES.map((name) => {
      const content = readPrivateFile(path.join(directory, name), makeError);
      if (Buffer.byteLength(content, 'utf8') > MAX_HUMAN_RESOLUTION_BYTES) {
        throw makeError();
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw makeError();
      }
      if (`${canonicalJson(parsed)}\n` !== content) {
        throw makeError();
      }
      return { name, digest: sha256(content) };
    });

  let request: ProviderInvocationRequest;
  try {
    request = recreateProviderInvocationRequest(
      JSON.parse(
        readPrivateFile(path.join(directory, 'request.json'), makeError),
      ),
    );
  } catch {
    throw makeError();
  }
  for (const name of optionalRootFiles) {
    const content = readPrivateFile(path.join(directory, name), makeError);
    if (Buffer.byteLength(content, 'utf8') > MAX_HUMAN_RESOLUTION_BYTES) {
      throw makeError();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw makeError();
    }
    if (`${canonicalJson(parsed)}\n` !== content) {
      throw makeError();
    }
    assertProviderRepairAuthorityArtifact(name, parsed, request, makeError);
    files.push({ name, digest: sha256(content) });
  }

  const stateContent = readPrivateFile(
    path.join(directory, 'state.json'),
    makeError,
  );
  const state = JSON.parse(stateContent) as unknown;
  let retentionReceipt: ReturnType<
    typeof readCompleteProviderRetentionReceipt
  > = null;
  try {
    if (
      isRecord(state) &&
      Number.isSafeInteger(state.revision) &&
      (state.revision as number) >= 0 &&
      (state.state === 'succeeded' || state.state === 'failed') &&
      typeof state.updatedAt === 'string' &&
      isTimestamp(state.updatedAt) &&
      isDigest(state.requestDigest) &&
      isDigest(state.manifestDigest)
    ) {
      retentionReceipt = readCompleteProviderRetentionReceipt(
        paths,
        path.basename(directory),
        {
          requestDigest: state.requestDigest,
          manifestDigest: state.manifestDigest,
          legacyRevision: state.revision as number,
          terminalState: state.state,
          terminalAt: state.updatedAt,
        },
      );
    } else if (
      readProviderRetentionReceipt(paths, path.basename(directory)) !== null
    ) {
      throw makeError();
    }
  } catch {
    throw makeError();
  }
  const runtimeRequired =
    isRecord(state) &&
    isRecord(state.result) &&
    state.result.runtimeObservation !== null;
  const retainedRuntimeArtifacts = BLIND_PROVIDER_RUNTIME_FILES.map((name) =>
    retentionReceipt === null
      ? null
      : providerRetentionArtifact(retentionReceipt, `runtime/${name}`),
  );
  const receiptCarriesRuntime = retainedRuntimeArtifacts.every(
    (artifact) => artifact !== null,
  );
  if (
    retainedRuntimeArtifacts.some((artifact) => artifact !== null) &&
    !receiptCarriesRuntime
  ) {
    throw makeError();
  }
  if (!runtimeStats) {
    if (runtimeRequired && !receiptCarriesRuntime) {
      throw makeError();
    }
    if (receiptCarriesRuntime) {
      for (
        let index = 0;
        index < BLIND_PROVIDER_RUNTIME_FILES.length;
        index += 1
      ) {
        files.push({
          name: `runtime/${BLIND_PROVIDER_RUNTIME_FILES[index]!}`,
          digest: retainedRuntimeArtifacts[index]!.digest,
        });
      }
    }
  } else {
    if (
      runtimeStats.isSymbolicLink() ||
      !runtimeStats.isDirectory() ||
      !walkPrivateDirectory(paths, runtimePath, makeError, false)
    ) {
      throw makeError();
    }
    const runtimeNames = fs.readdirSync(runtimePath).sort();
    const expectedRuntimeNames = [...BLIND_PROVIDER_RUNTIME_FILES].sort();
    if (
      receiptCarriesRuntime
        ? runtimeNames.some(
            (name) =>
              !expectedRuntimeNames.includes(
                name as (typeof BLIND_PROVIDER_RUNTIME_FILES)[number],
              ),
          )
        : canonicalJson(runtimeNames) !== canonicalJson(expectedRuntimeNames)
    ) {
      throw makeError();
    }
    for (
      let index = 0;
      index < BLIND_PROVIDER_RUNTIME_FILES.length;
      index += 1
    ) {
      const name = BLIND_PROVIDER_RUNTIME_FILES[index]!;
      const retained = retainedRuntimeArtifacts[index];
      if (!runtimeNames.includes(name)) {
        if (retained === null) throw makeError();
        files.push({ name: `runtime/${name}`, digest: retained.digest });
        continue;
      }
      const content = readPrivateBuffer(
        path.join(runtimePath, name),
        makeError,
      );
      if (content.byteLength > MAX_HUMAN_RESOLUTION_BYTES) {
        throw makeError();
      }
      const contentDigest = sha256(content);
      if (
        retained !== null &&
        (retained.digest !== contentDigest ||
          retained.bytes !== content.byteLength)
      ) {
        throw makeError();
      }
      files.push({
        name: `runtime/${name}`,
        digest: retained?.digest ?? contentDigest,
      });
    }
  }
  if (snapshotArtifacts !== null) {
    const retainedReviewRoot =
      retentionReceipt === null
        ? null
        : providerRetentionArtifact(retentionReceipt, 'review-root');
    const expectedRetainedReviewRoot = providerRetentionReviewRootArtifact(
      snapshotArtifacts.map((artifact) => ({
        name: `review-root/${artifact.snapshotFile}`,
        digest: artifact.sha256,
        bytes: artifact.byteLength,
      })),
    );
    if (
      retainedReviewRoot !== null &&
      canonicalJson(retainedReviewRoot) !==
        canonicalJson(expectedRetainedReviewRoot)
    ) {
      throw makeError();
    }
    const reviewRootStats = fs.lstatSync(reviewRootPath, {
      throwIfNoEntry: false,
    });
    if (
      !reviewRootStats?.isDirectory() ||
      reviewRootStats.isSymbolicLink() ||
      !walkPrivateDirectory(paths, reviewRootPath, makeError, false)
    ) {
      throw makeError();
    }
    const expectedFiles = snapshotArtifacts
      .map(({ snapshotFile }) => snapshotFile)
      .sort();
    const observedFiles = fs.readdirSync(reviewRootPath).sort();
    if (
      retainedReviewRoot === null
        ? canonicalJson(observedFiles) !== canonicalJson(expectedFiles)
        : observedFiles.some((name) => !expectedFiles.includes(name))
    ) {
      throw makeError();
    }
    for (const artifact of snapshotArtifacts) {
      if (!observedFiles.includes(artifact.snapshotFile)) {
        if (retainedReviewRoot === null) throw makeError();
        files.push({
          name: `review-root/${artifact.snapshotFile}`,
          digest: artifact.sha256,
        });
        continue;
      }
      const content = readPrivateBuffer(
        path.join(reviewRootPath, artifact.snapshotFile),
        makeError,
      );
      if (
        content.byteLength !== artifact.byteLength ||
        sha256(content) !== artifact.sha256 ||
        snapshotLineCount(content) !== artifact.lineCount
      ) {
        throw makeError();
      }
      files.push({
        name: `review-root/${artifact.snapshotFile}`,
        digest: artifact.sha256,
      });
    }
  }
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

function planReviewSnapshotArtifacts(
  value: unknown,
  makeError: () => WorkflowError,
): Array<{
  snapshotFile: string;
  sha256: string;
  byteLength: number;
  lineCount: number;
}> {
  if (!isRecord(value) || !Array.isArray(value.artifacts)) {
    throw makeError();
  }
  const artifacts = value.artifacts.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.snapshotFile !== 'string' ||
      !/^\d{4}\.artifact$/.test(entry.snapshotFile) ||
      !isDigest(entry.sha256) ||
      !Number.isSafeInteger(entry.byteLength) ||
      (entry.byteLength as number) < 0 ||
      !Number.isSafeInteger(entry.lineCount) ||
      (entry.lineCount as number) < 0
    ) {
      throw makeError();
    }
    return {
      snapshotFile: entry.snapshotFile,
      sha256: entry.sha256,
      byteLength: entry.byteLength as number,
      lineCount: entry.lineCount as number,
    };
  });
  if (
    new Set(artifacts.map(({ snapshotFile }) => snapshotFile)).size !==
    artifacts.length
  ) {
    throw makeError();
  }
  return artifacts;
}

function snapshotLineCount(content: Buffer): number {
  if (content.byteLength === 0) return 0;
  let count = 1;
  for (const byte of content) {
    if (byte === 0x0a) count += 1;
  }
  return content.at(-1) === 0x0a ? count - 1 : count;
}

function assertEvidenceClosureTargetBinding(
  paths: InvestigationRuntimePaths,
  targetSession: InvestigationSession,
  closure: InvestigationEvidenceRefsClosure,
): void {
  for (const entry of closure.entries) {
    const owner = isProposeExemptionInvestigationId(entry.ownerInvestigationId)
      ? readProposeExemptionSession(paths, entry.ownerInvestigationId)
      : readInvestigationSession(paths, entry.ownerInvestigationId);
    if (owner.changeId !== targetSession.changeId) {
      throw humanResolutionStateInvalid();
    }
    if (entry.refName === 'propose/exemption-session') {
      if (
        !('kind' in owner) ||
        owner.kind !== 'propose-exemption-session' ||
        owner.investigationId !== entry.ownerInvestigationId
      ) {
        throw humanResolutionStateInvalid();
      }
      continue;
    }
    if (entry.refName === 'propose/planning-materialization') {
      assertMaterializationMatchesOwnerSession(
        readEvidenceNode(paths, entry.nodeId),
        owner,
      );
      continue;
    }
    if (entry.refName === 'propose/plan-review-request') {
      const materialization = entry.dependencies.find(
        (dependency) => dependency.role === 'materialization',
      );
      if (!materialization) {
        throw humanResolutionStateInvalid();
      }
      assertMaterializationMatchesOwnerSession(
        readEvidenceNode(paths, materialization.nodeId),
        owner,
      );
      continue;
    }
    if (entry.refName === 'propose/plan-review-grant-requirement') {
      const node = readEvidenceNode(paths, entry.nodeId);
      const output = node.output;
      if (
        !isRecord(output) ||
        !isRecord(output.subject) ||
        !isRecord(output.subject.investigationBaseline) ||
        canonicalJson(output.subject.investigationBaseline) !==
          canonicalJson(owner.baseline)
      ) {
        throw humanResolutionStateInvalid();
      }
      continue;
    }
    throw humanResolutionStateInvalid();
  }
}

function assertMaterializationMatchesOwnerSession(
  node: ReturnType<typeof readEvidenceNode>,
  session: InvestigationSession | ProposeExemptionSession,
): void {
  const output = node.output;
  const exemption =
    'kind' in session && session.kind === 'propose-exemption-session';
  const expectedType = exemption
    ? 'propose-exemption-planning-materialization'
    : 'propose-planning-materialization';
  const semanticReceipt =
    !exemption &&
    node.nodeSchema === 'workflow.propose-planning-materialization.v2' &&
    node.outputSchema === 'workflow.propose-planning-materialization-output.v2';
  const legacyReceipt =
    !exemption &&
    node.nodeSchema === 'workflow.propose-planning-materialization.v1' &&
    node.outputSchema === 'workflow.propose-planning-materialization-output.v1';
  const revisionMatches =
    isRecord(output) &&
    (exemption
      ? output.revision === session.revision
      : semanticReceipt
        ? 'semanticRevision' in session &&
          output.semanticRevision === session.semanticRevision
        : legacyReceipt && output.revision === session.revision);
  if (
    node.type !== expectedType ||
    (!exemption && !semanticReceipt && !legacyReceipt) ||
    !isRecord(output) ||
    output.investigationId !== session.investigationId ||
    output.changeId !== session.changeId ||
    !revisionMatches ||
    !isRecord(output.baseline) ||
    canonicalJson(output.baseline) !== canonicalJson(session.baseline) ||
    (exemption &&
      (output.applicabilityNodeId !== session.applicabilityNode.nodeId ||
        output.applicabilityResultDigest !==
          session.applicabilityNode.resultDigest))
  ) {
    throw humanResolutionStateInvalid();
  }
}

function digestBoundStartReservation(
  paths: InvestigationRuntimePaths,
  session: InvestigationSession,
  makeError: () => WorkflowError,
): string | null {
  const filePath = investigationStartReservationPath(paths, session.changeId);
  if (!privatePathExists(paths, filePath, makeError)) {
    return null;
  }
  const content = readPrivateFile(filePath, makeError);
  if (Buffer.byteLength(content, 'utf8') > MAX_HUMAN_RESOLUTION_BYTES) {
    throw makeError();
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw makeError();
  }
  if (
    content !== `${canonicalJson(value)}\n` ||
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
        ? ['mandateBinding']
        : []),
      'investigationId',
      'invocationId',
      'repositoryRoot',
      'gitCommonDirectory',
      'branch',
      'baseline',
      'manifestDigest',
      'requestDigest',
      'manifest',
      'request',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'investigation-start-reservation' ||
    value.changeId !== session.changeId ||
    canonicalJson(value.mandateBinding ?? null) !==
      canonicalJson(session.mandateBinding ?? null) ||
    value.investigationId !== session.investigationId ||
    value.invocationId !== session.blindInvocationIds[0] ||
    value.repositoryRoot !== session.repositoryRoot ||
    value.gitCommonDirectory !== session.gitCommonDirectory ||
    value.branch !== session.branch ||
    !isRecord(value.baseline) ||
    canonicalJson(value.baseline) !== canonicalJson(session.baseline) ||
    value.manifestDigest !== session.blindManifestDigest ||
    !isTimestamp(value.createdAt)
  ) {
    throw makeError();
  }
  if (
    !isRecord(value.manifest) ||
    sha256(canonicalJson(value.manifest)) !== value.manifestDigest
  ) {
    throw makeError();
  }
  let request: ProviderInvocationRequest;
  let firstInvocationRequest: ProviderInvocationRequest;
  try {
    request = recreateProviderInvocationRequest(value.request);
    firstInvocationRequest = recreateProviderInvocationRequest(
      readPrivateCanonicalJson(
        paths,
        path.join(
          paths.invocations,
          session.blindInvocationIds[0] as string,
          'request.json',
        ),
        makeError,
      ),
    );
  } catch {
    throw makeError();
  }
  if (
    request.requestDigest !== value.requestDigest ||
    firstInvocationRequest.requestDigest !== request.requestDigest ||
    firstInvocationRequest.invocationId !== request.invocationId ||
    request.invocationId !== value.invocationId ||
    request.purpose !== 'survey' ||
    request.inputManifestDigest !== value.manifestDigest ||
    request.baseCommit !== value.baseline.head ||
    request.baseTree !== value.baseline.tree ||
    value.manifest.changeId !== value.changeId ||
    value.manifest.baseCommit !== value.baseline.head ||
    value.manifest.baseTree !== value.baseline.tree
  ) {
    throw makeError();
  }
  return sha256(content);
}

function observeUnsafePath(
  filePath: string,
  object: string,
  observations: Array<{
    object: string;
    observationDigest: string;
  }>,
): string {
  let observationDigest: string;
  try {
    observationDigest = exactUnsafePathObservationDigest(filePath, object);
  } catch {
    throw humanResolutionStateInvalid();
  }
  observations.push({ object, observationDigest });
  return observationDigest;
}

function normalizeAmbiguityObservations(
  observations: Array<{
    object: string;
    observationDigest: string;
  }>,
): Array<{ object: string; observationDigest: string }> {
  const normalized = new Map<string, string>();
  for (const { object, observationDigest } of observations) {
    const existing = normalized.get(object);
    if (existing !== undefined && existing !== observationDigest) {
      throw humanResolutionStateInvalid();
    }
    normalized.set(object, observationDigest);
  }
  return [...normalized]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([object, observationDigest]) => ({ object, observationDigest }));
}

function createPrivateRawFile(
  paths: InvestigationRuntimePaths,
  filePath: string,
  content: string,
  makeError: () => WorkflowError,
): void {
  ensurePrivateInvestigationDirectory(paths, path.dirname(filePath), makeError);
  if (fs.lstatSync(filePath, { throwIfNoEntry: false })) {
    throw makeError();
  }
  const temporary = writePrivateTemporary(filePath, content);
  try {
    if (fs.lstatSync(filePath, { throwIfNoEntry: false })) {
      throw makeError();
    }
    fs.renameSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
    assertPrivateFile(fs.lstatSync(filePath), makeError);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function assertCanonicalResolutionEnvelopeBytes(content: string): void {
  if (
    typeof content !== 'string' ||
    Buffer.byteLength(content, 'utf8') > 65_536
  ) {
    throw humanResolutionGrantUnsafe();
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw humanResolutionGrantUnsafe();
  }
  if (`${JSON.stringify(value)}\n` !== content) {
    throw humanResolutionGrantUnsafe();
  }
}

function assertHumanResolutionGrantId(value: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  ) {
    throw humanResolutionGrantUnsafe();
  }
  return value;
}

function exactResolutionTimestamp(value: Date): string {
  const time = value.getTime();
  if (!Number.isFinite(time)) {
    throw humanResolutionInvalid('Human resolution timestamp is invalid.');
  }
  return new Date(time).toISOString();
}

function isBoundedResolutionText(value: unknown, maxBytes: number): boolean {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maxBytes &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159);
    })
  );
}

function isEmptyRecord(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0;
}

function isSortedUniqueStrings(values: string[]): boolean {
  const sorted = [...new Set(values)].sort();
  return (
    values.length === sorted.length &&
    values.every((value, index) => value === sorted[index])
  );
}

function isInsideOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function isCheckpointKind(
  value: unknown,
): value is InvestigationCheckpointKind {
  return (
    value === 'main-terms' ||
    value === 'group-dispositions' ||
    value === 'why-answers'
  );
}

function isBaseline(value: unknown): value is InvestigationSession['baseline'] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['head', 'tree']) &&
    typeof value.head === 'string' &&
    GIT_OBJECT_ID.test(value.head) &&
    typeof value.tree === 'string' &&
    GIT_OBJECT_ID.test(value.tree)
  );
}

function isTaskMandateBinding(value: unknown, changeId: string): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'schemaVersion',
      'mandateTaskId',
      'mandateId',
      'mandateDigest',
      'changeId',
      'externalAuditRoot',
    ]) &&
    value.schemaVersion === 1 &&
    value.changeId === changeId &&
    typeof value.externalAuditRoot === 'string' &&
    path.isAbsolute(value.externalAuditRoot) &&
    path.normalize(value.externalAuditRoot) === value.externalAuditRoot &&
    typeof value.mandateTaskId === 'string' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.mandateTaskId) &&
    typeof value.mandateId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.mandateId,
    ) &&
    isDigest(value.mandateDigest)
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isProviderInvocationFailureShape(value: unknown): value is {
  kind: 'retryable' | 'repository-reconciliation-required';
  code: string;
  message: string;
  executionKind?: string;
  retryAfterMs?: number;
  probe?: unknown;
} | null {
  const hasExecutionKind =
    isRecord(value) && Object.hasOwn(value, 'executionKind');
  const hasRetryAfter = isRecord(value) && Object.hasOwn(value, 'retryAfterMs');
  const hasProbe = isRecord(value) && Object.hasOwn(value, 'probe');
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, [
        'kind',
        'code',
        'message',
        ...(hasExecutionKind ? ['executionKind'] : []),
        ...(hasRetryAfter ? ['retryAfterMs'] : []),
        ...(hasProbe ? ['probe'] : []),
      ]) &&
      (value.kind === 'retryable' ||
        value.kind === 'repository-reconciliation-required') &&
      typeof value.code === 'string' &&
      value.code.length > 0 &&
      typeof value.message === 'string' &&
      value.message.length > 0 &&
      (!hasExecutionKind ||
        PROVIDER_EXECUTION_FAILURE_KINDS.has(String(value.executionKind))) &&
      (!hasRetryAfter ||
        (Number.isSafeInteger(value.retryAfterMs) &&
          (value.retryAfterMs as number) >= 0 &&
          (value.retryAfterMs as number) <= 86_400_000)) &&
      (!hasProbe || isReadOnlyProbeShape(value.probe)) &&
      hasProbe === (value.executionKind === 'probe-transient') &&
      Buffer.byteLength(canonicalJson(value), 'utf8') <= 16_384)
  );
}

function isReadOnlyProbeShape(value: unknown): boolean {
  try {
    assertReadOnlyProbe(value);
    return true;
  } catch {
    return false;
  }
}

const PROVIDER_EXECUTION_FAILURE_KINDS = new Set([
  'provider-timeout',
  'network',
  'rate-limit',
  'provider-process-crash',
  'worker-crash',
  'lease-expiry',
  'temporary-file-lock',
  'provider-capacity',
  'stdout-truncated',
  'process-nonzero',
  'json-parse',
  'schema-mismatch',
  'missing-required-field',
  'citation-out-of-range',
  'probe-transient',
  'needs-user-decision',
  'state-corruption',
  'unknown-side-effect',
]);

function assertProviderExecutionPolicySnapshot(
  paths: InvestigationRuntimePaths,
  value: unknown,
  request: ProviderInvocationRequest,
): void {
  if (
    !isRecord(value) ||
    value.kind !== 'provider-execution-policy-snapshot' ||
    value.invocationId !== request.invocationId ||
    value.requestDigest !== request.requestDigest ||
    value.policyDigest !== request.policyDigest ||
    typeof value.policyDocument !== 'string' ||
    (value.schemaVersion === 1
      ? !hasExactKeys(value, [
          'invocationId',
          'kind',
          'policyDigest',
          'policyDocument',
          'requestDigest',
          'schemaVersion',
        ])
      : ![2, 3].includes(value.schemaVersion as number) ||
        !hasExactKeys(value, [
          'accountingDigest',
          'attemptReservation',
          ...(value.schemaVersion === 3 ? ['authority'] : []),
          'invocationId',
          'kind',
          'policyDigest',
          'policyDocument',
          'requestDigest',
          'retryAccounting',
          'schemaVersion',
        ]))
  ) {
    throw providerInvocationUnsafe();
  }
  try {
    let loaded;
    try {
      loaded = parseAiAdapterPolicyDocument(value.policyDocument);
    } catch {
      if (value.schemaVersion !== 1) throw providerInvocationUnsafe();
      loaded = parseLegacyAiAdapterPolicyDocument(value.policyDocument);
    }
    if (
      loaded.digest !== value.policyDigest ||
      request.limits.aggregateOutputBytes >
        loaded.policy.limits.aggregateOutputBytes
    ) {
      throw providerInvocationUnsafe();
    }
    if (value.schemaVersion === 3) {
      if (loaded.policy.schemaVersion !== 4) {
        throw providerInvocationUnsafe();
      }
      const authority = validateProviderExecutionBudgetAuthority(
        request,
        loaded as ReturnType<typeof parseAiAdapterPolicyDocument>,
        value.authority,
      );
      assertDurableProviderExecutionBudgetAuthority(paths.root, authority);
    } else if (request.limits.timeoutMs > loaded.policy.limits.timeoutMs) {
      throw providerInvocationUnsafe();
    }
    if (value.schemaVersion === 2 || value.schemaVersion === 3) {
      if (
        loaded.policy.schemaVersion !== 4 ||
        !isRecord(value.attemptReservation)
      ) {
        throw providerInvocationUnsafe();
      }
      const attemptReservation = {
        runtimeMs: request.limits.timeoutMs,
        providerCostMicros:
          loaded.policy.retryAccounting.reservations[request.providerId]
            .providerCostMicros,
        providerTokens:
          loaded.policy.retryAccounting.reservations[request.providerId]
            .providerTokens,
      };
      if (
        canonicalJson(value.retryAccounting) !==
          canonicalJson(loaded.policy.retryAccounting) ||
        canonicalJson(value.attemptReservation) !==
          canonicalJson(attemptReservation) ||
        value.accountingDigest !==
          sha256(
            canonicalJson({
              schemaVersion: 1,
              kind: 'provider-retry-accounting-snapshot',
              invocationId: request.invocationId,
              requestDigest: request.requestDigest,
              policyDigest: request.policyDigest,
              retryAccounting: loaded.policy.retryAccounting,
              attemptReservation,
            }),
          )
      ) {
        throw providerInvocationUnsafe();
      }
    }
  } catch {
    throw providerInvocationUnsafe();
  }
}

function assertProviderRepairAuthorityArtifact(
  name: (typeof OPTIONAL_PROVIDER_ROOT_FILES)[number],
  value: unknown,
  request: ProviderInvocationRequest,
  makeError: () => WorkflowError,
): void {
  if (!isRecord(value)) {
    throw makeError();
  }
  if (name === 'repair-evidence.json') {
    if (
      !hasExactKeys(value, [
        'contextDigest',
        'epoch',
        'evidenceDigest',
        'failedAttemptId',
        'failedInvocationId',
        'failureCode',
        'failureFingerprint',
        'jobId',
        'kind',
        'recordedAt',
        'repairContext',
        'schemaVersion',
        'workflowId',
      ]) ||
      value.schemaVersion !== 1 ||
      value.kind !== 'provider-repair-evidence' ||
      value.failedInvocationId !== request.invocationId ||
      !isTimestamp(value.recordedAt) ||
      typeof value.evidenceDigest !== 'string' ||
      !PROVIDER_REPAIR_DIGEST.test(value.evidenceDigest)
    ) {
      throw makeError();
    }
    const payload = { ...value };
    delete payload.evidenceDigest;
    if (`sha256:${sha256(canonicalJson(payload))}` !== value.evidenceDigest) {
      throw makeError();
    }
    return;
  }
  if (
    !hasExactKeys(value, [
      'contextDigest',
      'createdAt',
      'epoch',
      'failedAttemptId',
      'failedInvocationId',
      'failureFingerprint',
      'jobId',
      'kind',
      'lineageDigest',
      'repairBudget',
      'repairContext',
      'repairEvidenceDigest',
      'repairKind',
      'replacementAttemptId',
      'replacementInvocationId',
      'replacementRequestDigest',
      'retryMode',
      'schemaVersion',
      'workflowId',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-repair-lineage' ||
    value.retryMode !== 'repair' ||
    (value.repairKind !== 'schema' && value.repairKind !== 'semantic') ||
    value.replacementInvocationId !== request.invocationId ||
    value.replacementRequestDigest !== request.requestDigest ||
    !isTimestamp(value.createdAt) ||
    typeof value.lineageDigest !== 'string' ||
    !PROVIDER_REPAIR_DIGEST.test(value.lineageDigest) ||
    typeof value.repairEvidenceDigest !== 'string' ||
    !PROVIDER_REPAIR_DIGEST.test(value.repairEvidenceDigest)
  ) {
    throw makeError();
  }
  const payload = { ...value };
  delete payload.lineageDigest;
  if (`sha256:${sha256(canonicalJson(payload))}` !== value.lineageDigest) {
    throw makeError();
  }
}

function isProviderInvocationLifecycleLease(
  value: unknown,
): value is NonNullable<ProviderInvocationLifecycleProjection['lease']> | null {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, [
        'generation',
        'workerId',
        'tokenDigest',
        'acquiredAt',
        'expiresAt',
      ]) &&
      Number.isSafeInteger(value.generation) &&
      (value.generation as number) > 0 &&
      typeof value.workerId === 'string' &&
      value.workerId.length > 0 &&
      isDigest(value.tokenDigest) &&
      isTimestamp(value.acquiredAt) &&
      isTimestamp(value.expiresAt) &&
      Date.parse(value.expiresAt) > Date.parse(value.acquiredAt))
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return (
    own.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function sessionUnsafe() {
  return workflowError(
    'INVESTIGATION_SESSION_UNSAFE',
    'Investigation session storage is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}

function sessionInvalid() {
  return workflowError(
    'INVESTIGATION_SESSION_INVALID',
    'Investigation session is malformed or internally inconsistent.',
    ExitCode.staleState,
  );
}

function sessionTransitionInvalid() {
  return workflowError(
    'INVESTIGATION_SESSION_TRANSITION_INVALID',
    'Investigation session transition is not monotonic.',
    ExitCode.staleState,
  );
}

function investigationCasMismatch(expected: number, observed: number) {
  return workflowError(
    'INVESTIGATION_CAS_MISMATCH',
    'Investigation session changed during compare-and-swap.',
    ExitCode.conflict,
    { details: { expectedRevision: expected, observedRevision: observed } },
  );
}

function checkpointInvalid() {
  return workflowError(
    'INVESTIGATION_CHECKPOINT_INVALID',
    'Investigation caller checkpoint is malformed, unbounded, or unbound.',
    ExitCode.usage,
  );
}

function refUnsafe() {
  return workflowError(
    'CURRENT_INVESTIGATION_REF_UNSAFE',
    'Current investigation reference is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}

function humanResolutionInvalid(message: string) {
  return workflowError('HUMAN_RESOLUTION_INVALID', message, ExitCode.guard);
}

function humanResolutionStateInvalid() {
  return workflowError(
    'HUMAN_RESOLUTION_STATE_UNSAFE',
    'The workflow state cannot be uniquely bound for human resolution.',
    ExitCode.unsafeEnvironment,
  );
}

function humanResolutionRecoveryAmbiguous() {
  return workflowError(
    'HUMAN_RESOLUTION_RECOVERY_AMBIGUOUS',
    'Human resolution recovery observed state outside the exact journal.',
    ExitCode.staleState,
  );
}

function providerInvocationUnsafe() {
  return workflowError(
    'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE',
    'Referenced provider state is missing, unsafe, or non-canonical.',
    ExitCode.unsafeEnvironment,
  );
}

function startReservationUnsafe() {
  return workflowError(
    'HUMAN_RESOLUTION_START_RESERVATION_UNSAFE',
    'Referenced investigation start reservation is unsafe or non-canonical.',
    ExitCode.unsafeEnvironment,
  );
}

function humanResolutionObjectUnsafe() {
  return workflowError(
    'HUMAN_RESOLUTION_NODE_UNSAFE',
    'Human resolution overlay storage is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}

function humanResolutionRefUnsafe() {
  return workflowError(
    'HUMAN_RESOLUTION_REF_UNSAFE',
    'Human resolution ref storage is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}

function humanResolutionGrantUnsafe() {
  return workflowError(
    'HUMAN_RESOLUTION_GRANT_UNSAFE',
    'Human resolution grant storage is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}

function humanResolutionGrantUnavailable(grantId: string) {
  return workflowError(
    'HUMAN_RESOLUTION_GRANT_UNAVAILABLE',
    `Human resolution grant ${grantId} is unavailable or already terminal.`,
    ExitCode.conflict,
  );
}

function humanResolutionGrantNotFound(grantId: string) {
  return workflowError(
    'HUMAN_RESOLUTION_GRANT_NOT_FOUND',
    `Human resolution grant ${grantId} does not exist.`,
    ExitCode.conflict,
  );
}

function humanResolutionJournalUnsafe() {
  return workflowError(
    'HUMAN_RESOLUTION_JOURNAL_UNSAFE',
    'Human resolution journal is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}

function humanResolutionArchiveUnsafe() {
  return workflowError(
    'HUMAN_RESOLUTION_ARCHIVE_UNSAFE',
    'Human resolution evidence archive is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}

function humanResolutionReceiptUnsafe() {
  return workflowError(
    'HUMAN_RESOLUTION_RECEIPT_UNSAFE',
    'Human resolution receipt is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}

function sessionLockInvalid() {
  return workflowError(
    'INVESTIGATION_SESSION_LOCK_INVALID',
    'Investigation session lock ownership changed during the transition.',
    ExitCode.staleState,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
