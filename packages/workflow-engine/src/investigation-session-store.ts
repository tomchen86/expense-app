import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, type WorkflowError, workflowError } from './errors.ts';
import type { InvestigationDispositionInput } from './investigation-groups.ts';
import type { InvestigationWhyAnswer } from './investigation-why.ts';
import {
  INVESTIGATION_LIMITS,
  previewInvestigationTermUnion,
  type InvestigationMainTermInput,
  type InvestigationTermKind,
} from './investigation-terms.ts';
import {
  assertChangeId,
  assertInvestigationId,
  assertInvocationId,
  type InvestigationRuntimePaths,
} from './paths.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CHECKPOINT_ID = /^checkpoint-[0-9a-f]{64}$/;
const MAX_CHECKPOINT_BYTES = 1_048_576;
const MAX_HUMAN_RESOLUTION_BYTES = 1_048_576;
const HUMAN_RESOLUTION_SCHEMA = 'investigation-human-resolution.v1';
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
    schemaVersion: 1,
    kind: 'supersede',
    parameters: {
      successorInvestigationId: {
        type: ['investigation-id', 'null'],
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
      parameters: { successorInvestigationId: string | null };
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
  schemaVersion: 1;
  workflowKind: 'investigation';
  repositoryId: string;
  changeId: string;
  investigationId: string;
  sessionDigest: string;
  sessionRevision: number;
  currentRefDigest: string | null;
  resolutionHeadNodeId: string | null;
  providerInvocationDigests: Array<{
    invocationId: string;
    files: Array<{ name: string; digest: string }>;
  }>;
  evidenceRefsDigest: string | null;
  blockerDigest: string | null;
  ambiguityDigest: string | null;
};

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
  schemaVersion: 1;
  kind: 'human-resolution-journal';
  journalId: string;
  phase: 'prepared' | 'state-published' | 'receipt-written' | 'consumed';
  grantId: string;
  grantDigest: string;
  target: HumanResolutionTarget;
  beforeStateDigest: string;
  afterStateDigest: string;
  beforeResolutionRef: string | null;
  plannedResolutionNodeId: string;
  plannedCurrentWorkflowRef: {
    expectedInvestigationId: string | null;
    nextInvestigationId: string | null;
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
};

export type InvestigationCheckpointKind =
  'main-terms' | 'group-dispositions' | 'why-answers';

export type MainTermsPayload = {
  reference: string;
  terms: InvestigationMainTermInput[];
};

export type GroupDispositionsPayload = {
  dispositions: InvestigationDispositionInput[];
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
  state: InvestigationSessionState;
  changeId: string;
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
      const next = assertInvestigationSession(
        transition(deepFreeze(structuredClone(current))),
      );
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
    hasExactKeys(value.parameters, ['successorInvestigationId']) &&
    (value.parameters.successorInvestigationId === null ||
      typeof value.parameters.successorInvestigationId === 'string')
  ) {
    if (typeof value.parameters.successorInvestigationId === 'string') {
      assertInvestigationId(value.parameters.successorInvestigationId);
    }
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
  const providerInvocationDigests = session.blindInvocationIds.map(
    (invocationId) => ({
      invocationId,
      files: digestPrivateDirectoryEntries(
        paths,
        path.join(paths.invocations, invocationId),
        providerInvocationUnsafe,
      ),
    }),
  );
  const evidenceRefsDigest = digestOptionalCanonicalPrivateFile(
    paths,
    path.join(paths.refs, `${session.changeId}.json`),
    false,
    evidenceRefsUnsafe,
  );
  const blockerDigest =
    session.blocker === null ? null : sha256(canonicalJson(session.blocker));
  const envelope: InvestigationResolutionStateEnvelope = {
    schemaVersion: 1,
    workflowKind: 'investigation',
    repositoryId,
    changeId: session.changeId,
    investigationId,
    sessionDigest: sha256(`${canonicalJson(session)}\n`),
    sessionRevision: session.revision,
    currentRefDigest,
    resolutionHeadNodeId,
    providerInvocationDigests,
    evidenceRefsDigest,
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
  let resolutionHeadNodeId: string | null;
  try {
    resolutionHeadNodeId = readHumanResolutionHead(paths, investigationId);
  } catch {
    observeUnsafePath(
      humanResolutionRefPath(paths, investigationId),
      'resolution-ref',
      ambiguities,
    );
    resolutionHeadNodeId = null;
  }
  const providerInvocationDigests = session.blindInvocationIds.map(
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
  let evidenceRefsDigest: string | null;
  try {
    evidenceRefsDigest = digestOptionalCanonicalPrivateFile(
      paths,
      path.join(paths.refs, `${session.changeId}.json`),
      false,
      evidenceRefsUnsafe,
    );
  } catch {
    evidenceRefsDigest = observeUnsafePath(
      path.join(paths.refs, `${session.changeId}.json`),
      'evidence-refs',
      ambiguities,
    );
  }
  if (ambiguities.length === 0) {
    throw humanResolutionStateInvalid();
  }
  const ambiguityDigest = sha256(
    canonicalJson({
      schema: 'investigation-quarantine-observation.v1',
      ambiguities,
    }),
  );
  const blockerDigest =
    session.blocker === null ? null : sha256(canonicalJson(session.blocker));
  const envelope: InvestigationResolutionStateEnvelope = {
    schemaVersion: 1,
    workflowKind: 'investigation',
    repositoryId,
    changeId: session.changeId,
    investigationId,
    sessionDigest: sha256(`${canonicalJson(session)}\n`),
    sessionRevision: session.revision,
    currentRefDigest,
    resolutionHeadNodeId,
    providerInvocationDigests,
    evidenceRefsDigest,
    blockerDigest,
    ambiguityDigest,
  };
  const resolutionNode =
    resolutionHeadNodeId === null
      ? null
      : readHumanResolutionNode(paths, resolutionHeadNodeId);
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
    'repair',
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
  const marker = `${canonicalJson({
    schemaVersion: 1,
    ownerToken: crypto.randomUUID(),
    pid: process.pid,
    createdAt: new Date().toISOString(),
  })}\n`;
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = fs.openSync(lockPath, NO_FOLLOW_CREATE, 0o600);
      fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, marker, 'utf8');
      fs.fsyncSync(descriptor);
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
    schemaVersion: 1 as const,
    kind: 'human-resolution-journal' as const,
    phase: input.phase,
    grantId: input.grantId,
    grantDigest: input.grantDigest,
    target: input.target,
    beforeStateDigest: input.beforeStateDigest,
    afterStateDigest: input.afterStateDigest,
    beforeResolutionRef: input.beforeResolutionRef,
    plannedResolutionNodeId: input.plannedResolutionNodeId,
    plannedCurrentWorkflowRef: input.plannedCurrentWorkflowRef,
    evidenceArchiveDigest: input.evidenceArchiveDigest,
    receiptDigest: input.receiptDigest,
    createdAt: input.createdAt,
  };
  const candidate = {
    ...semantic,
    journalId: sha256(
      canonicalJson({
        schema: 'human-resolution-journal.v1',
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
  readHumanResolutionNode(paths, value.nodeId);
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
  return withPrivateRuntimeLock(
    paths,
    path.join(stores.locks, 'grant-store.lock'),
    () => {
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
    'HUMAN_RESOLUTION_GRANT_STORE_CONFLICT',
    humanResolutionGrantUnsafe,
  );
}

export function withHumanResolutionGrantExecution<T>(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
  operation: () => T,
): T {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  return withPrivateRuntimeLock(
    paths,
    path.join(humanResolutionPaths(paths).locks, `${grantId}.execution.lock`),
    operation,
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

export function revokeStoredHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
  now: Date = new Date(),
): HumanResolutionGrantStoreEntry {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  const stores = humanResolutionPaths(paths);
  return withPrivateRuntimeLock(
    paths,
    path.join(stores.locks, 'grant-store.lock'),
    () => {
      const terminalEntry = inspectStoredHumanResolutionGrant(paths, grantId);
      if (
        terminalEntry?.state === 'revoked' ||
        terminalEntry?.state === 'consumed'
      ) {
        return terminalEntry;
      }
      if (terminalEntry === null) {
        throw humanResolutionGrantNotFound(grantId);
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
      const terminalPath = path.join(stores.terminal, `${grantId}.json`);
      const envelope = JSON.parse(terminalEntry.envelopeBytes) as unknown;
      const record = {
        schemaVersion: 1,
        state: 'revoked',
        grantId,
        reason: 'Explicit root-human revocation',
        recordedAt: exactResolutionTimestamp(now),
        envelope,
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
    'HUMAN_RESOLUTION_GRANT_STORE_CONFLICT',
    humanResolutionGrantUnsafe,
  );
}

export function reserveHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
): string {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  const stores = humanResolutionPaths(paths);
  return withPrivateRuntimeLock(
    paths,
    path.join(stores.locks, 'grant-store.lock'),
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
    'HUMAN_RESOLUTION_GRANT_STORE_CONFLICT',
    humanResolutionGrantUnsafe,
  );
}

export function readReservedHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
): string {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  const filePath = path.join(
    humanResolutionPaths(paths).reserved,
    `${grantId}.json`,
  );
  const envelope = readPrivateFile(filePath, humanResolutionGrantUnsafe);
  assertCanonicalResolutionEnvelopeBytes(envelope);
  return envelope;
}

export function terminalizeHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
  record: Record<string, unknown>,
): void {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  const stores = humanResolutionPaths(paths);
  withPrivateRuntimeLock(
    paths,
    path.join(stores.locks, 'grant-store.lock'),
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
    'HUMAN_RESOLUTION_GRANT_STORE_CONFLICT',
    humanResolutionGrantUnsafe,
  );
}

export function readTerminalHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
): Record<string, unknown> | null {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  const terminal = path.join(
    humanResolutionPaths(paths).terminal,
    `${grantId}.json`,
  );
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
  return deepFreeze(value);
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
  if (candidates.length !== 1) {
    throw humanResolutionGrantUnsafe();
  }
  const candidate = candidates[0];
  if (!candidate) {
    throw humanResolutionGrantUnsafe();
  }
  const filePath = path.join(candidate.directory, `${grantId}.json`);
  if (candidate.state !== 'terminal') {
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
  const terminal = readPrivateCanonicalJson(
    paths,
    filePath,
    humanResolutionGrantUnsafe,
  );
  if (
    !isRecord(terminal) ||
    terminal.schemaVersion !== 1 ||
    (terminal.state !== 'revoked' && terminal.state !== 'consumed') ||
    terminal.grantId !== grantId ||
    typeof terminal.recordedAt !== 'string' ||
    !isRecord(terminal.envelope) ||
    (terminal.state === 'revoked' && typeof terminal.reason !== 'string') ||
    (terminal.state === 'consumed' &&
      (typeof terminal.resolutionNodeId !== 'string' ||
        typeof terminal.receiptDigest !== 'string'))
  ) {
    throw humanResolutionGrantUnsafe();
  }
  const envelopeBytes = `${JSON.stringify(terminal.envelope)}\n`;
  assertCanonicalResolutionEnvelopeBytes(envelopeBytes);
  return deepFreeze({
    grantId,
    state: terminal.state,
    envelopeBytes,
    terminalReason:
      terminal.state === 'revoked' ? String(terminal.reason) : null,
    recordedAt: terminal.recordedAt,
  });
}

export function writeHumanResolutionJournal(
  paths: InvestigationRuntimePaths,
  journal: HumanResolutionJournal,
): void {
  const validated = assertHumanResolutionJournal(journal);
  writePrivateCanonicalJsonAtomic(
    paths,
    humanResolutionJournalPath(paths, journal.grantId),
    validated,
    humanResolutionJournalUnsafe,
  );
}

export function readHumanResolutionJournal(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
): HumanResolutionJournal | null {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  const journalPath = humanResolutionJournalPath(paths, grantId);
  if (!privatePathExists(paths, journalPath, humanResolutionJournalUnsafe)) {
    return null;
  }
  return assertHumanResolutionJournal(
    readPrivateCanonicalJson(paths, journalPath, humanResolutionJournalUnsafe),
  );
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
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'investigationId',
      'revision',
      'state',
      'changeId',
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
    typeof value.changeId !== 'string' ||
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
  const session = value as InvestigationSession;
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
    'repositoryRoot',
    'gitCommonDirectory',
    'branch',
    'baseline',
    'intentDigest',
    'blindManifestDigest',
    'createdAt',
  ] as const) {
    if (canonicalJson(current[key]) !== canonicalJson(next[key])) {
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
    !hasExactKeys(value, ['dispositions']) ||
    !Array.isArray(value.dispositions) ||
    value.dispositions.length > INVESTIGATION_LIMITS.maxHitDispositionWorkItems
  ) {
    throw checkpointInvalid();
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
    return fs.readFileSync(descriptor, 'utf8');
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
    !observed?.isFile() ||
    observed.isSymbolicLink() ||
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
  const before = fs.lstatSync(lockPath, { throwIfNoEntry: false });
  if (!before) {
    return true;
  }
  assertPrivateFile(before, invalidLock);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      lockPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    throw invalidLock();
  }
  try {
    const opened = fs.fstatSync(descriptor);
    assertPrivateFile(opened, invalidLock);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw invalidLock();
    }
    const content = fs.readFileSync(descriptor, 'utf8');
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw invalidLock();
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
      value.ownerToken.length === 0 ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) < 1 ||
      !isTimestamp(value.createdAt) ||
      `${canonicalJson(value)}\n` !== content
    ) {
      throw invalidLock();
    }
    if (isProcessAlive(value.pid as number)) {
      return false;
    }
    const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (
      !observed ||
      observed.dev !== opened.dev ||
      observed.ino !== opened.ino
    ) {
      return true;
    }
    fs.unlinkSync(lockPath);
    fsyncDirectory(path.dirname(lockPath));
    return true;
  } finally {
    fs.closeSync(descriptor);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === 'ESRCH');
  }
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

function humanResolutionPaths(paths: InvestigationRuntimePaths) {
  const root = path.join(paths.root, 'human-resolutions');
  return {
    root,
    nodes: path.join(root, 'nodes'),
    refs: path.join(root, 'refs'),
    available: path.join(root, 'grants', 'available'),
    reserved: path.join(root, 'grants', 'reserved'),
    terminal: path.join(root, 'grants', 'terminal'),
    journals: path.join(root, 'journals'),
    receipts: path.join(root, 'receipts'),
    archives: path.join(root, 'archives'),
    quarantine: path.join(root, 'quarantine'),
    locks: path.join(root, 'locks'),
  };
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
  return names.map((name) => {
    const match =
      /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/.exec(
        name,
      );
    if (!match?.[1]) {
      throw humanResolutionGrantUnsafe();
    }
    return assertHumanResolutionGrantId(match[1]);
  });
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
      'plannedResolutionNodeId',
      'plannedCurrentWorkflowRef',
      'evidenceArchiveDigest',
      'receiptDigest',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'human-resolution-journal' ||
    !isDigest(value.journalId) ||
    !['prepared', 'state-published', 'receipt-written', 'consumed'].includes(
      String(value.phase),
    ) ||
    typeof value.grantId !== 'string' ||
    !isDigest(value.grantDigest) ||
    !isDigest(value.beforeStateDigest) ||
    !isDigest(value.afterStateDigest) ||
    (value.beforeResolutionRef !== null &&
      !isDigest(value.beforeResolutionRef)) ||
    !isDigest(value.plannedResolutionNodeId) ||
    !isRecord(value.plannedCurrentWorkflowRef) ||
    !hasExactKeys(value.plannedCurrentWorkflowRef, [
      'expectedInvestigationId',
      'nextInvestigationId',
    ]) ||
    (value.plannedCurrentWorkflowRef.expectedInvestigationId !== null &&
      typeof value.plannedCurrentWorkflowRef.expectedInvestigationId !==
        'string') ||
    (value.plannedCurrentWorkflowRef.nextInvestigationId !== null &&
      typeof value.plannedCurrentWorkflowRef.nextInvestigationId !==
        'string') ||
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
  const semantic = {
    schemaVersion: 1 as const,
    kind: 'human-resolution-journal' as const,
    phase: value.phase as HumanResolutionJournal['phase'],
    grantId: value.grantId,
    grantDigest: value.grantDigest,
    target,
    beforeStateDigest: value.beforeStateDigest,
    afterStateDigest: value.afterStateDigest,
    beforeResolutionRef: value.beforeResolutionRef,
    plannedResolutionNodeId: value.plannedResolutionNodeId,
    plannedCurrentWorkflowRef:
      value.plannedCurrentWorkflowRef as HumanResolutionJournal['plannedCurrentWorkflowRef'],
    evidenceArchiveDigest: value.evidenceArchiveDigest,
    receiptDigest: value.receiptDigest,
    createdAt: value.createdAt,
  };
  const journalId = sha256(
    canonicalJson({
      schema: 'human-resolution-journal.v1',
      journal: humanResolutionJournalIdentity(semantic),
    }),
  );
  if (journalId !== value.journalId) {
    throw humanResolutionJournalUnsafe();
  }
  return deepFreeze(structuredClone(value)) as HumanResolutionJournal;
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

function digestPrivateDirectoryEntries(
  paths: InvestigationRuntimePaths,
  directory: string,
  makeError: () => WorkflowError,
): Array<{ name: string; digest: string }> {
  if (!walkPrivateDirectory(paths, directory, makeError, false)) {
    throw makeError();
  }
  const names = fs.readdirSync(directory).sort();
  if (names.length === 0 || names.length > 64) {
    throw makeError();
  }
  return names.map((name) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9-]+)?$/.test(name)) {
      throw makeError();
    }
    const filePath = path.join(directory, name);
    const content = readPrivateFile(filePath, makeError);
    if (Buffer.byteLength(content, 'utf8') > MAX_HUMAN_RESOLUTION_BYTES) {
      throw makeError();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw makeError();
    }
    if (
      content !== canonicalJson(parsed) &&
      content !== `${canonicalJson(parsed)}\n`
    ) {
      throw makeError();
    }
    return { name, digest: sha256(content) };
  });
}

function digestOptionalCanonicalPrivateFile(
  paths: InvestigationRuntimePaths,
  filePath: string,
  newlineRequired: boolean,
  makeError: () => WorkflowError,
): string | null {
  if (!privatePathExists(paths, filePath, makeError)) {
    return null;
  }
  const content = readPrivateFile(filePath, makeError);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw makeError();
  }
  const canonical = canonicalJson(parsed);
  if (content !== (newlineRequired ? `${canonical}\n` : canonical)) {
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
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  const observation: Record<string, unknown> = {
    schemaVersion: 1,
    object,
    exists: stats !== undefined,
  };
  if (stats) {
    observation.kind = stats.isSymbolicLink()
      ? 'symlink'
      : stats.isDirectory()
        ? 'directory'
        : stats.isFile()
          ? 'file'
          : 'other';
    observation.mode = stats.mode & 0o777;
    observation.nlink = stats.nlink;
    observation.size = stats.size;
    if (stats.isSymbolicLink()) {
      observation.linkTarget = fs.readlinkSync(filePath);
    } else if (stats.isDirectory()) {
      observation.entries = fs.readdirSync(filePath).sort().slice(0, 256);
    } else if (stats.isFile() && stats.size <= MAX_HUMAN_RESOLUTION_BYTES) {
      let descriptor: number | undefined;
      try {
        descriptor = fs.openSync(
          filePath,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        const opened = fs.fstatSync(descriptor);
        if (opened.dev === stats.dev && opened.ino === stats.ino) {
          observation.contentDigest = sha256(
            fs.readFileSync(descriptor, 'utf8'),
          );
        }
      } catch {
        observation.contentDigest = null;
      } finally {
        if (descriptor !== undefined) {
          fs.closeSync(descriptor);
        }
      }
    }
  }
  const observationDigest = sha256(canonicalJson(observation));
  observations.push({ object, observationDigest });
  return observationDigest;
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

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
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

function sha256(value: string): string {
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

function providerInvocationUnsafe() {
  return workflowError(
    'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE',
    'Referenced provider state is missing, unsafe, or non-canonical.',
    ExitCode.unsafeEnvironment,
  );
}

function evidenceRefsUnsafe() {
  return workflowError(
    'HUMAN_RESOLUTION_EVIDENCE_REFS_UNSAFE',
    'Referenced evidence refs are unsafe or non-canonical.',
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
