import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  publishPreparedExclusiveLock,
  reclaimDeadPreparedLock,
} from '../repository-transaction/filesystem-safety.ts';
import {
  assertStoredEvidenceNode,
  canonicalEvidenceNodeEnvelope,
  type EvidenceNode,
} from '../../adapters/compatibility/investigation-v2/evidence-node.ts';
import {
  assertInvestigationApplicability,
  INVESTIGATION_APPLICABILITY_POLICY_DIGEST,
} from '../../modules/investigation/domain/investigation-applicability.ts';
import {
  assertPlanReviewSubject,
  readPlanReviewTargetSnapshotNode,
} from '../../modules/assurance/plan-review.ts';
import {
  assertChangeId,
  assertInvestigationId,
  type InvestigationRuntimePaths,
} from '../session-workspace/paths.ts';
import {
  PROPOSE_EXEMPTION_SESSION_STORE_POLICY_DIGEST,
  PROPOSE_POLICY_DIGEST,
  isProviderRoleAssignment,
  recreateProviderInvocationRequest,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  parseTaskDiffReviewSubject,
  TASK_DIFF_REVIEW_POLICY_DIGEST,
} from '../../modules/assurance/task-diff-review.ts';
import {
  TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
  assertTaskStrategyImplementationSubject,
} from '../../modules/provider-orchestration/task-strategy-provider-contract.ts';
import type { TaskMandateBinding } from '../../modules/authority/task-mandate.ts';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const REF_NAME_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

const NO_FOLLOW_CREATE =
  fs.constants.O_RDWR |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  fs.constants.O_NOFOLLOW;
const EVIDENCE_PUBLICATION_TEMP_SUFFIX =
  /^([1-9][0-9]*)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.publish\.tmp$/;

type UnsafeObservationBytePath = string | Buffer;

type UnsafeObservationStableStats = {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

export type CompareAndSwapEvidenceRefParams = {
  changeId: string;
  refName: string;
  expectedNodeId: string | null;
  nextNodeId: string;
};

export type EvidenceRefsSnapshot = Readonly<{
  rawDocument: string | null;
  digest: string | null;
  refs: Readonly<Record<string, string>> | null;
}>;

export type CompareAndSwapEvidenceRefsDocumentParams = {
  changeId: string;
  expectedDigest: string | null;
  nextRefs: Record<string, string> | null;
};

export type InvestigationEvidenceRefsClosure = Readonly<{
  snapshot: EvidenceRefsSnapshot;
  closureDigest: string | null;
  owners: Readonly<Record<string, string>>;
  entries: readonly InvestigationEvidenceRefClosureEntry[];
}>;

export type InvestigationEvidenceRefClosureEntry = Readonly<{
  refName: string;
  nodeId: string;
  resultDigest: string;
  envelopeDigest: string;
  ownerInvestigationId: string;
  dependencies: readonly InvestigationEvidenceDependencyClosureEntry[];
}>;

export type InvestigationEvidenceDependencyClosureEntry = Readonly<{
  role: string;
  nodeId: string;
  resultDigest: string;
  envelopeDigest: string;
}>;

export function exactUnsafePathObservationDigest(
  filePath: string,
  object: string,
): string {
  return sha256(
    canonicalJson({
      schemaVersion: 2,
      object,
      node: observeUnsafeNode(Buffer.from(filePath)),
    }),
  );
}

export function writeEvidenceNode(
  paths: InvestigationRuntimePaths,
  node: EvidenceNode,
): string {
  assertStoredEvidenceNode(node, objectInvalid);
  const content = canonicalEvidenceNodeEnvelope(node);
  const contentBytes = Buffer.from(content, 'utf8');
  const objectPath = evidenceObjectPath(paths, node.nodeId);
  const objectDirectory = path.dirname(objectPath);
  ensureNoFollowDirectory(
    paths.base,
    paths.root,
    objectDirectory,
    objectUnsafe,
  );

  let existing = inspectEvidenceObjectFinal(objectPath, contentBytes);
  if (existing === 'exact') {
    reclaimEvidencePublicationAliases(objectPath, contentBytes);
    assertExactEvidenceObjectFinal(objectPath, contentBytes);
    return node.nodeId;
  }
  reclaimEvidencePublicationAliases(objectPath, contentBytes);
  existing = inspectEvidenceObjectFinal(objectPath, contentBytes);
  if (existing === 'exact') {
    reclaimEvidencePublicationAliases(objectPath, contentBytes);
    assertExactEvidenceObjectFinal(objectPath, contentBytes);
    return node.nodeId;
  }

  const publishAlias = evidencePublicationAlias(objectPath);
  let descriptor: number | undefined;
  let publishAliasOwnedStats: fs.Stats | undefined;
  try {
    descriptor = fs.openSync(publishAlias, NO_FOLLOW_CREATE, 0o600);
    fs.fchmodSync(descriptor, 0o600);
    publishAliasOwnedStats = fs.fstatSync(descriptor);
    fs.writeFileSync(descriptor, contentBytes);
    fs.fsyncSync(descriptor);
    const publishAliasStats = fs.fstatSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertExactEvidencePublicationAlias(
      publishAlias,
      publishAliasStats,
      contentBytes,
      1,
    );
    fsyncDirectory(objectDirectory);

    existing = inspectEvidenceObjectFinal(objectPath, contentBytes);
    if (existing === 'legacy-prefix') {
      publishLegacyEvidenceRepairClaim(objectPath, publishAlias, contentBytes);
    } else if (existing === 'absent') {
      try {
        fs.linkSync(publishAlias, objectPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') {
          throw error;
        }
      }
    }
    fsyncDirectory(objectDirectory);
    reclaimEvidencePublicationAliases(objectPath, contentBytes);
    assertExactEvidenceObjectFinal(objectPath, contentBytes);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    if (publishAliasOwnedStats !== undefined) {
      unlinkOwnedEvidencePublicationAlias(
        publishAlias,
        publishAliasOwnedStats,
        objectDirectory,
      );
    }
    throw error;
  }
  return node.nodeId;
}

export function readEvidenceNode(
  paths: InvestigationRuntimePaths,
  nodeId: string,
): EvidenceNode {
  assertNodeId(nodeId);
  const objectPath = evidenceObjectPath(paths, nodeId);
  assertNoFollowDirectory(
    paths.base,
    paths.root,
    path.dirname(objectPath),
    objectUnsafe,
  );
  const content = readNoFollow(objectPath, objectUnsafe);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw objectInvalid();
  }
  const node = assertStoredEvidenceNode(parsed, objectInvalid);
  if (
    node.nodeId !== nodeId ||
    content !== canonicalEvidenceNodeEnvelope(node)
  ) {
    throw objectInvalid();
  }
  return node;
}

export function resolvePlanReviewInvocationOwner(
  paths: InvestigationRuntimePaths,
  input: {
    changeId: string;
    subject: unknown;
    assignment: unknown;
    authorizationNodeId: string;
  },
): string {
  const changeId = assertChangeId(input.changeId);
  const subject = assertPlanReviewSubject(input.subject);
  if (!DIGEST_PATTERN.test(input.authorizationNodeId)) {
    throw refInvalid();
  }
  const authorization = readEvidenceNode(paths, input.authorizationNodeId);
  const output = authorization.output;
  const materializationId =
    authorization.provenanceParentNodeIds.materialization;
  if (
    authorization.type !== 'plan-review-authorization' ||
    authorization.nodeSchema !== 'workflow.plan-review-authorization.v1' ||
    authorization.evaluator !== 'workflow-propose.v1' ||
    authorization.policyDigest !== PROPOSE_POLICY_DIGEST ||
    authorization.outputSchema !==
      'workflow.plan-review-authorization-output.v1' ||
    !isPlainRecord(output) ||
    !(
      output.grantAuthorization === null ||
      isPlainRecord(output.grantAuthorization)
    ) ||
    canonicalJson(output.subject) !== canonicalJson(subject) ||
    canonicalJson(output.assignment) !== canonicalJson(input.assignment) ||
    authorization.exactInputDigests.subject !== subject.subjectDigest ||
    authorization.exactInputDigests.assignment !==
      sha256(canonicalJson(input.assignment)) ||
    authorization.exactInputDigests.generation !==
      subject.planningGenerationId ||
    authorization.exactInputDigests.grantAuthorization !==
      sha256(canonicalJson(output.grantAuthorization)) ||
    !DIGEST_PATTERN.test(materializationId ?? '') ||
    !DIGEST_PATTERN.test(
      authorization.semanticParentResultDigests.materialization ?? '',
    )
  ) {
    throw refInvalid();
  }
  const materialization = readEvidenceNode(paths, materializationId);
  const ownership = assertPlanningMaterializationOwnership(
    paths,
    materialization,
    changeId,
  );
  if (
    materialization.resultDigest !==
      authorization.semanticParentResultDigests.materialization ||
    !isPlainRecord(materialization.output) ||
    !isPlainRecord(materialization.output.baseline) ||
    canonicalJson(materialization.output.baseline) !==
      canonicalJson(subject.investigationBaseline)
  ) {
    throw refInvalid();
  }
  return ownership.ownerInvestigationId;
}

export function resolveTaskDiffReviewInvocationOwner(
  paths: InvestigationRuntimePaths,
  input: {
    changeId: string;
    sessionId: string;
    subject: unknown;
    assignment: unknown;
    authorizationNodeId: string;
  },
): Readonly<{
  ownerInvestigationId: string;
  sessionId: string;
  mandateBinding: TaskMandateBinding | null;
}> {
  const changeId = assertChangeId(input.changeId);
  const subject = parseTaskDiffReviewSubject(input.subject);
  if (!DIGEST_PATTERN.test(input.authorizationNodeId)) throw refInvalid();
  const authorization = readEvidenceNode(paths, input.authorizationNodeId);
  const output = authorization.output;
  if (
    authorization.type !== 'task-diff-review-authorization' ||
    authorization.nodeSchema !== 'workflow.task-diff-review-authorization.v1' ||
    authorization.evaluator !== 'workflow-task-diff-review.v1' ||
    authorization.policyDigest !== TASK_DIFF_REVIEW_POLICY_DIGEST ||
    authorization.outputSchema !==
      'workflow.task-diff-review-authorization-output.v1' ||
    !hasExactKeys(authorization.exactInputDigests, [
      'actor',
      'assignment',
      'mandate',
      'session',
      'subject',
    ]) ||
    !hasExactKeys(authorization.semanticParentResultDigests, []) ||
    !hasExactKeys(authorization.provenanceParentNodeIds, []) ||
    !isPlainRecord(output) ||
    !hasExactKeys(output, [
      'ownerInvestigationId',
      'sessionId',
      'changeId',
      'taskId',
      'subject',
      'implementationActor',
      'assignment',
      'mandateBinding',
    ]) ||
    output.changeId !== changeId ||
    output.sessionId !== input.sessionId ||
    output.taskId !== subject.taskId ||
    canonicalJson(output.subject) !== canonicalJson(subject) ||
    canonicalJson(output.assignment) !== canonicalJson(input.assignment) ||
    !isTaskDiffReviewImplementationActor(output.implementationActor) ||
    !isTaskDiffReviewAssignmentForActor(
      output.assignment,
      output.implementationActor,
      subject.subjectDigest,
    ) ||
    !isTaskDiffReviewMandateBinding(output.mandateBinding, changeId) ||
    authorization.exactInputDigests.actor !==
      sha256(canonicalJson(output.implementationActor)) ||
    authorization.exactInputDigests.assignment !==
      sha256(canonicalJson(output.assignment)) ||
    authorization.exactInputDigests.mandate !==
      sha256(canonicalJson(output.mandateBinding)) ||
    authorization.exactInputDigests.session !==
      sha256(
        canonicalJson({
          sessionId: input.sessionId,
          changeId,
          taskId: subject.taskId,
        }),
      ) ||
    authorization.exactInputDigests.subject !== subject.subjectDigest ||
    typeof output.ownerInvestigationId !== 'string'
  ) {
    throw refInvalid();
  }
  let ownerInvestigationId: string;
  try {
    ownerInvestigationId = assertInvestigationId(output.ownerInvestigationId);
  } catch {
    throw refInvalid();
  }
  return Object.freeze({
    ownerInvestigationId,
    sessionId: input.sessionId,
    mandateBinding: structuredClone(
      output.mandateBinding,
    ) as TaskMandateBinding | null,
  });
}

export function resolveTaskStrategyImplementationInvocationOwner(
  paths: InvestigationRuntimePaths,
  input: {
    changeId: string;
    sessionId: string;
    subject: unknown;
    assignment: unknown;
    authorizationNodeId: string;
  },
): Readonly<{
  ownerInvestigationId: string;
  sessionId: string;
  mandateBinding: TaskMandateBinding | null;
}> {
  const changeId = assertChangeId(input.changeId);
  const subject = assertTaskStrategyImplementationSubject(input.subject);
  if (!DIGEST_PATTERN.test(input.authorizationNodeId)) throw refInvalid();
  const authorization = readEvidenceNode(paths, input.authorizationNodeId);
  const output = authorization.output;
  if (
    authorization.type !== 'task-strategy-implementation-authorization' ||
    authorization.nodeSchema !==
      'workflow.task-strategy-implementation-authorization.v1' ||
    authorization.evaluator !== 'workflow-task-strategy.v1' ||
    authorization.policyDigest !== TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST ||
    authorization.outputSchema !==
      'workflow.task-strategy-implementation-authorization-output.v1' ||
    !hasExactKeys(authorization.exactInputDigests, [
      'assignment',
      'author',
      'mandate',
      'session',
      'subject',
      'transaction',
    ]) ||
    !hasExactKeys(authorization.semanticParentResultDigests, ['red']) ||
    !hasExactKeys(authorization.provenanceParentNodeIds, ['red']) ||
    !isPlainRecord(output) ||
    !hasExactKeys(output, [
      'ownerInvestigationId',
      'sessionId',
      'changeId',
      'taskId',
      'subject',
      'redAuthor',
      'assignment',
      'mandateBinding',
    ]) ||
    output.changeId !== changeId ||
    output.sessionId !== input.sessionId ||
    output.taskId !== subject.taskId ||
    canonicalJson(output.subject) !== canonicalJson(subject) ||
    canonicalJson(output.assignment) !== canonicalJson(input.assignment) ||
    !isTaskStrategyRedAuthor(output.redAuthor) ||
    !isTaskStrategyImplementationAssignmentForAuthor(
      output.assignment,
      output.redAuthor,
      subject.subjectDigest,
    ) ||
    !isTaskDiffReviewMandateBinding(output.mandateBinding, changeId) ||
    authorization.exactInputDigests.author !==
      sha256(canonicalJson(output.redAuthor)) ||
    authorization.exactInputDigests.assignment !==
      sha256(canonicalJson(output.assignment)) ||
    authorization.exactInputDigests.mandate !==
      sha256(canonicalJson(output.mandateBinding)) ||
    authorization.exactInputDigests.session !==
      sha256(
        canonicalJson({
          sessionId: input.sessionId,
          changeId,
          taskId: subject.taskId,
        }),
      ) ||
    authorization.exactInputDigests.subject !== subject.subjectDigest ||
    authorization.exactInputDigests.transaction !== subject.transactionDigest ||
    authorization.semanticParentResultDigests.red !==
      subject.redEvidenceResultDigest ||
    authorization.provenanceParentNodeIds.red !== subject.redEvidenceNodeId ||
    typeof output.ownerInvestigationId !== 'string'
  ) {
    throw refInvalid();
  }
  const red = readEvidenceNode(paths, subject.redEvidenceNodeId);
  if (
    red.type !== 'task-strategy-red-evidence' ||
    red.nodeId !== subject.redEvidenceNodeId ||
    red.resultDigest !== subject.redEvidenceResultDigest
  ) {
    throw refInvalid();
  }
  let ownerInvestigationId: string;
  try {
    ownerInvestigationId = assertInvestigationId(output.ownerInvestigationId);
  } catch {
    throw refInvalid();
  }
  return Object.freeze({
    ownerInvestigationId,
    sessionId: input.sessionId,
    mandateBinding: structuredClone(
      output.mandateBinding,
    ) as TaskMandateBinding | null,
  });
}

export function readEvidenceRefs(
  paths: InvestigationRuntimePaths,
  changeId: string,
): Record<string, string> {
  assertChangeId(changeId);
  const refPath = evidenceRefPath(paths, changeId);
  if (!assertNoFollowDirectory(paths.base, paths.root, paths.refs, refUnsafe)) {
    return {};
  }
  const stats = fs.lstatSync(refPath, { throwIfNoEntry: false });
  if (!stats) {
    return {};
  }
  const content = readNoFollow(refPath, refUnsafe);
  return parseRefDocument(content, changeId);
}

export function readEvidenceRefsSnapshot(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
): EvidenceRefsSnapshot {
  const changeId = assertChangeId(requestedChangeId);
  const refPath = evidenceRefPath(paths, changeId);
  if (!assertNoFollowDirectory(paths.base, paths.root, paths.refs, refUnsafe)) {
    return absentEvidenceRefsSnapshot();
  }
  const stats = fs.lstatSync(refPath, { throwIfNoEntry: false });
  if (!stats) {
    return absentEvidenceRefsSnapshot();
  }
  const rawDocument = readNoFollow(refPath, refUnsafe);
  const refs = parseRefDocument(rawDocument, changeId);
  return Object.freeze({
    rawDocument,
    digest: sha256(rawDocument),
    refs: Object.freeze({ ...refs }),
  });
}

export function readInvestigationEvidenceRefsClosure(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
): InvestigationEvidenceRefsClosure {
  const changeId = assertChangeId(requestedChangeId);
  const snapshot = readEvidenceRefsSnapshot(paths, changeId);
  if (snapshot.refs === null) {
    return Object.freeze({
      snapshot,
      closureDigest: null,
      owners: Object.freeze({}),
      entries: Object.freeze([]),
    });
  }
  const closure = computeInvestigationEvidenceRefsClosure(
    paths,
    changeId,
    snapshot.refs,
  );
  return Object.freeze({
    snapshot,
    ...closure,
  });
}

export function observeInvestigationEvidenceRefsAmbiguities(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
): Array<{ object: string; observationDigest: string }> {
  const changeId = assertChangeId(requestedChangeId);
  const observations = new Map<string, string>();
  const observe = (object: string, filePath: string) => {
    observations.set(
      object,
      exactUnsafePathObservationDigest(filePath, object),
    );
  };
  const refPath = evidenceRefPath(paths, changeId);
  observe('evidence-refs', refPath);
  let snapshot: EvidenceRefsSnapshot;
  try {
    snapshot = readEvidenceRefsSnapshot(paths, changeId);
  } catch {
    return sortedAmbiguityObservations(observations);
  }
  if (snapshot.refs === null) {
    return sortedAmbiguityObservations(observations);
  }
  const pending = Object.values(snapshot.refs).sort();
  const visited = new Set<string>();
  while (pending.length > 0) {
    const nodeId = pending.shift();
    if (!nodeId || visited.has(nodeId)) {
      continue;
    }
    if (visited.size >= 4096) {
      throw refUnsafe();
    }
    visited.add(nodeId);
    observe(`evidence-node:${nodeId}`, evidenceObjectPath(paths, nodeId));
    try {
      const node = readEvidenceNode(paths, nodeId);
      pending.push(
        ...Object.values(node.provenanceParentNodeIds)
          .filter((parentId) => !visited.has(parentId))
          .sort(),
      );
    } catch {
      // The exact missing or malformed causal object is already observed.
    }
  }
  return sortedAmbiguityObservations(observations);
}

function sortedAmbiguityObservations(
  observations: ReadonlyMap<string, string>,
): Array<{ object: string; observationDigest: string }> {
  return [...observations]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([object, observationDigest]) => ({ object, observationDigest }));
}

export function computeInvestigationEvidenceRefsClosure(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
  refs: Readonly<Record<string, string>>,
): Pick<
  InvestigationEvidenceRefsClosure,
  'closureDigest' | 'owners' | 'entries'
> {
  const changeId = assertChangeId(requestedChangeId);
  const owners: Record<string, string> = {};
  const entries: InvestigationEvidenceRefClosureEntry[] = Object.entries(refs)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([refName, nodeId]) => {
      const node = readEvidenceNode(paths, nodeId);
      const ownership = assertInvestigationEvidenceRefOwner(
        paths,
        refs,
        refName,
        node,
        changeId,
      );
      owners[refName] = ownership.ownerInvestigationId;
      return Object.freeze({
        refName,
        nodeId,
        resultDigest: node.resultDigest,
        envelopeDigest: sha256(canonicalEvidenceNodeEnvelope(node)),
        ownerInvestigationId: ownership.ownerInvestigationId,
        dependencies: ownership.dependencies,
      });
    });
  return Object.freeze({
    closureDigest: investigationEvidenceRefsClosureDigest(changeId, entries),
    owners: Object.freeze(owners),
    entries: Object.freeze(entries),
  });
}

export function investigationEvidenceRefsClosureDigest(
  requestedChangeId: string,
  entries: readonly InvestigationEvidenceRefClosureEntry[],
): string {
  const changeId = assertChangeId(requestedChangeId);
  const sorted = [...entries].sort((left, right) =>
    left.refName.localeCompare(right.refName),
  );
  if (
    sorted.some(
      (entry, index) =>
        entry.refName !== entries[index]?.refName ||
        !REF_NAME_PATTERN.test(entry.refName) ||
        !DIGEST_PATTERN.test(entry.nodeId) ||
        !DIGEST_PATTERN.test(entry.resultDigest) ||
        !DIGEST_PATTERN.test(entry.envelopeDigest) ||
        assertInvestigationId(entry.ownerInvestigationId) !==
          entry.ownerInvestigationId ||
        !Array.isArray(entry.dependencies) ||
        entry.dependencies.some(
          (dependency, dependencyIndex) =>
            dependency.role.length === 0 ||
            dependency.role !==
              [...entry.dependencies].sort((left, right) =>
                left.role.localeCompare(right.role),
              )[dependencyIndex]?.role ||
            !DIGEST_PATTERN.test(dependency.nodeId) ||
            !DIGEST_PATTERN.test(dependency.resultDigest) ||
            !DIGEST_PATTERN.test(dependency.envelopeDigest),
        ),
    )
  ) {
    throw refInvalid();
  }
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      changeId,
      entries,
    }),
  );
}

export function quarantineUnsafeEvidenceRefsDocument(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
  expectedObservationDigest: string,
): string {
  const changeId = assertChangeId(requestedChangeId);
  if (!DIGEST_PATTERN.test(expectedObservationDigest)) {
    throw refInvalid();
  }
  const source = evidenceRefPath(paths, changeId);
  const quarantineDirectory = path.join(
    paths.root,
    'human-resolutions',
    'quarantine',
  );
  const target = path.join(
    quarantineDirectory,
    `${changeId}.${expectedObservationDigest}.evidence-refs.artifact`,
  );
  return withRefLock(paths, changeId, () => {
    ensureNoFollowDirectory(
      paths.base,
      paths.root,
      quarantineDirectory,
      refUnsafe,
    );
    const sourceStats = fs.lstatSync(source, { throwIfNoEntry: false });
    if (!sourceStats) {
      if (
        fs.lstatSync(target, { throwIfNoEntry: false }) &&
        exactUnsafePathObservationDigest(target, 'evidence-refs') ===
          expectedObservationDigest
      ) {
        return target;
      }
      throw refsDocumentCasMismatch(expectedObservationDigest, null, null);
    }
    if (
      exactUnsafePathObservationDigest(source, 'evidence-refs') !==
      expectedObservationDigest
    ) {
      throw refsDocumentCasMismatch(
        expectedObservationDigest,
        exactUnsafePathObservationDigest(source, 'evidence-refs'),
        null,
      );
    }
    if (fs.lstatSync(target, { throwIfNoEntry: false })) {
      throw refInvalid();
    }
    fs.renameSync(source, target);
    fsyncDirectory(paths.refs);
    fsyncDirectory(quarantineDirectory);
    if (
      exactUnsafePathObservationDigest(target, 'evidence-refs') !==
      expectedObservationDigest
    ) {
      throw refInvalid();
    }
    return target;
  });
}

export function compareAndSwapEvidenceRefsDocument(
  paths: InvestigationRuntimePaths,
  params: CompareAndSwapEvidenceRefsDocumentParams,
): EvidenceRefsSnapshot {
  const changeId = assertChangeId(params.changeId);
  if (
    params.expectedDigest !== null &&
    !DIGEST_PATTERN.test(params.expectedDigest)
  ) {
    throw refInvalid();
  }
  const nextRefs =
    params.nextRefs === null
      ? null
      : validateEvidenceRefsForPublication(paths, params.nextRefs);
  const nextDigest =
    nextRefs === null ? null : sha256(canonicalRefDocument(changeId, nextRefs));

  return withRefLock(paths, changeId, () => {
    const current = readEvidenceRefsSnapshot(paths, changeId);
    if (current.digest === nextDigest) {
      return current;
    }
    if (current.digest !== params.expectedDigest) {
      throw refsDocumentCasMismatch(
        params.expectedDigest,
        current.digest,
        nextDigest,
      );
    }
    if (nextRefs === null) {
      fs.unlinkSync(evidenceRefPath(paths, changeId));
      fsyncDirectory(paths.refs);
    } else {
      writeRefDocument(paths, changeId, nextRefs);
    }
    const published = readEvidenceRefsSnapshot(paths, changeId);
    if (published.digest !== nextDigest) {
      throw refInvalid();
    }
    return published;
  });
}

export function compareAndSwapEvidenceRef(
  paths: InvestigationRuntimePaths,
  params: CompareAndSwapEvidenceRefParams,
): void {
  assertChangeId(params.changeId);
  assertRefName(params.refName);
  assertNodeId(params.nextNodeId);
  if (
    params.expectedNodeId !== null &&
    !DIGEST_PATTERN.test(params.expectedNodeId)
  ) {
    throw refInvalid();
  }
  const nextObjectPath = evidenceObjectPath(paths, params.nextNodeId);
  const nextDirectoryExists = assertNoFollowDirectory(
    paths.base,
    paths.root,
    path.dirname(nextObjectPath),
    objectUnsafe,
  );
  if (
    !nextDirectoryExists ||
    !fs.lstatSync(nextObjectPath, { throwIfNoEntry: false })
  ) {
    throw objectUnavailable(params.nextNodeId);
  }
  readEvidenceNode(paths, params.nextNodeId);

  withRefLock(paths, params.changeId, () => {
    const current = readEvidenceRefs(paths, params.changeId);
    const observed = current[params.refName] ?? null;
    if (observed !== (params.expectedNodeId ?? null)) {
      throw refCasMismatch(params.refName, params.expectedNodeId, observed);
    }
    const next = { ...current, [params.refName]: params.nextNodeId };
    writeRefDocument(paths, params.changeId, next);
  });
}

function parseRefDocument(
  content: string,
  changeId: string,
): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw refInvalid();
  }
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'changeId', 'refs']) ||
    value.schemaVersion !== 1 ||
    value.changeId !== changeId ||
    !isPlainRecord(value.refs)
  ) {
    throw refInvalid();
  }
  const refs = value.refs as Record<string, unknown>;
  for (const [name, digest] of Object.entries(refs)) {
    if (!REF_NAME_PATTERN.test(name) || !isDigest(digest)) {
      throw refInvalid();
    }
  }
  if (content !== canonicalJson(value)) {
    throw refInvalid();
  }
  return refs as Record<string, string>;
}

function writeRefDocument(
  paths: InvestigationRuntimePaths,
  changeId: string,
  refs: Record<string, string>,
): void {
  const refPath = evidenceRefPath(paths, changeId);
  const content = canonicalRefDocument(changeId, refs);
  ensureNoFollowDirectory(paths.base, paths.root, paths.refs, refUnsafe);
  const existing = fs.lstatSync(refPath, { throwIfNoEntry: false });
  if (existing) {
    assertPrivateFileStats(existing, refUnsafe);
  }
  const temporary = `${refPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, NO_FOLLOW_CREATE, 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    ensureNoFollowDirectory(paths.base, paths.root, paths.refs, refUnsafe);
    const current = fs.lstatSync(refPath, { throwIfNoEntry: false });
    if (current) {
      assertPrivateFileStats(current, refUnsafe);
    }
    fs.renameSync(temporary, refPath);
    fsyncDirectory(paths.refs);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function validateEvidenceRefsForPublication(
  paths: InvestigationRuntimePaths,
  refs: Record<string, string>,
): Record<string, string> {
  if (!isPlainRecord(refs)) {
    throw refInvalid();
  }
  const validated: Record<string, string> = {};
  for (const [name, nodeId] of Object.entries(refs)) {
    assertRefName(name);
    assertNodeId(nodeId);
    readEvidenceNode(paths, nodeId);
    validated[name] = nodeId;
  }
  return validated;
}

function canonicalRefDocument(
  changeId: string,
  refs: Record<string, string>,
): string {
  return canonicalJson({ schemaVersion: 1, changeId, refs });
}

function absentEvidenceRefsSnapshot(): EvidenceRefsSnapshot {
  return Object.freeze({
    rawDocument: null,
    digest: null,
    refs: null,
  });
}

function withRefLock<T>(
  paths: InvestigationRuntimePaths,
  changeId: string,
  operation: () => T,
): T {
  ensureNoFollowDirectory(paths.base, paths.root, paths.refs, refUnsafe);
  const lockPath = path.join(paths.refs, `${changeId}.lock`);
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
        refLockInvalid,
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
        reclaimDeadRefLock(lockPath)
      ) {
        continue;
      }
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw refLocked(changeId);
      }
      throw error;
    }
  }
  if (descriptor === undefined) {
    throw refInvalid();
  }
  const owned = fs.fstatSync(descriptor);
  try {
    return operation();
  } finally {
    releaseRefLock(lockPath, descriptor, owned, marker);
  }
}

function reclaimDeadRefLock(lockPath: string): boolean {
  try {
    const result = reclaimDeadPreparedLock(lockPath, (content) => {
      let value: unknown;
      try {
        value = JSON.parse(content);
      } catch {
        return null;
      }
      if (
        !isPlainRecord(value) ||
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
        typeof value.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(value.createdAt)) ||
        `${canonicalJson(value)}\n` !== content
      ) {
        return null;
      }
      return {
        pid: value.pid as number,
        ownerToken: value.ownerToken,
      };
    });
    return result === 'absent' || result === 'reclaimed';
  } catch {
    return false;
  }
}

type InvestigationEvidenceOwnership = Readonly<{
  ownerInvestigationId: string;
  dependencies: readonly InvestigationEvidenceDependencyClosureEntry[];
}>;

function assertInvestigationEvidenceRefOwner(
  paths: InvestigationRuntimePaths,
  refs: Readonly<Record<string, string>>,
  refName: string,
  node: EvidenceNode,
  expectedChangeId: string,
): InvestigationEvidenceOwnership {
  try {
    switch (refName) {
      case 'propose/planning-materialization':
        return assertPlanningMaterializationOwnership(
          paths,
          node,
          expectedChangeId,
        );
      case 'propose/plan-review-request':
        return assertPlanReviewRequestOwnership(
          paths,
          refs,
          node,
          expectedChangeId,
        );
      case 'propose/plan-review-grant-requirement':
        return assertPlanReviewGrantRequirementOwnership(
          node,
          expectedChangeId,
        );
      case 'propose/exemption-session':
        return assertExemptionSessionOwnership(paths, node, expectedChangeId);
      default:
        throw refInvalid();
    }
  } catch {
    throw refInvalid();
  }
}

function assertPlanningMaterializationOwnership(
  paths: InvestigationRuntimePaths,
  node: EvidenceNode,
  expectedChangeId: string,
): InvestigationEvidenceOwnership {
  const output = node.output;
  if (!isPlainRecord(output)) {
    throw refInvalid();
  }
  if (node.type === 'propose-planning-materialization') {
    const semanticReceipt =
      node.nodeSchema === 'workflow.propose-planning-materialization.v2' &&
      node.outputSchema ===
        'workflow.propose-planning-materialization-output.v2';
    const legacyReceipt =
      node.nodeSchema === 'workflow.propose-planning-materialization.v1' &&
      node.outputSchema ===
        'workflow.propose-planning-materialization-output.v1';
    if (!semanticReceipt && !legacyReceipt) {
      throw refInvalid();
    }
    assertProposeEvidenceNode(node, {
      type: 'propose-planning-materialization',
      nodeSchema: node.nodeSchema,
      outputSchema: node.outputSchema,
      exactInputKeys: ['artifacts', 'baseline', 'seal'],
      provenanceKeys: ['seal'],
      semanticKeys: ['seal'],
    });
    if (
      !hasExactKeys(output, [
        'investigationId',
        'changeId',
        semanticReceipt ? 'semanticRevision' : 'revision',
        'baseline',
        'artifacts',
        'sealNodeId',
        'sealResultDigest',
      ]) ||
      output.changeId !== expectedChangeId ||
      !isInvestigationOwner(output.investigationId) ||
      !Number.isSafeInteger(
        semanticReceipt ? output.semanticRevision : output.revision,
      ) ||
      Number(semanticReceipt ? output.semanticRevision : output.revision) < 0 ||
      !isBaseline(output.baseline) ||
      !isDigestRecord(output.artifacts) ||
      !isDigest(output.sealNodeId) ||
      !isDigest(output.sealResultDigest) ||
      node.exactInputDigests.artifacts !==
        sha256(canonicalJson(output.artifacts)) ||
      node.exactInputDigests.baseline !==
        sha256(canonicalJson(output.baseline)) ||
      node.exactInputDigests.seal !== output.sealNodeId ||
      node.provenanceParentNodeIds.seal !== output.sealNodeId ||
      node.semanticParentResultDigests.seal !== output.sealResultDigest
    ) {
      throw refInvalid();
    }
    return Object.freeze({
      ownerInvestigationId: output.investigationId,
      // The seal is deterministically reconstructed from the investigation
      // session graph and is intentionally not stored in the evidence CAS.
      dependencies: Object.freeze([]),
    });
  }

  assertProposeEvidenceNode(node, {
    type: 'propose-exemption-planning-materialization',
    nodeSchema: 'workflow.propose-exemption-planning-materialization.v1',
    outputSchema:
      'workflow.propose-exemption-planning-materialization-output.v1',
    exactInputKeys: ['applicability', 'artifacts', 'baseline'],
    provenanceKeys: ['applicability'],
    semanticKeys: ['applicability'],
  });
  if (
    !hasExactKeys(output, [
      'investigationId',
      'changeId',
      'revision',
      'baseline',
      'artifacts',
      'applicabilityNodeId',
      'applicabilityResultDigest',
    ]) ||
    output.changeId !== expectedChangeId ||
    !isInvestigationOwner(output.investigationId) ||
    !Number.isSafeInteger(output.revision) ||
    (output.revision as number) < 0 ||
    !isBaseline(output.baseline) ||
    !isDigestRecord(output.artifacts) ||
    !isDigest(output.applicabilityNodeId) ||
    !isDigest(output.applicabilityResultDigest) ||
    node.exactInputDigests.artifacts !==
      sha256(canonicalJson(output.artifacts)) ||
    node.exactInputDigests.baseline !==
      sha256(canonicalJson(output.baseline)) ||
    node.exactInputDigests.applicability !== output.applicabilityNodeId ||
    node.provenanceParentNodeIds.applicability !== output.applicabilityNodeId ||
    node.semanticParentResultDigests.applicability !==
      output.applicabilityResultDigest
  ) {
    throw refInvalid();
  }
  const applicability = readApplicabilityDependency(
    paths,
    output.applicabilityNodeId,
    output.applicabilityResultDigest,
  );
  return Object.freeze({
    ownerInvestigationId: output.investigationId,
    dependencies: Object.freeze([applicability]),
  });
}

function assertPlanReviewRequestOwnership(
  paths: InvestigationRuntimePaths,
  refs: Readonly<Record<string, string>>,
  node: EvidenceNode,
  expectedChangeId: string,
): InvestigationEvidenceOwnership {
  const output = node.output;
  const retryDecisionShape =
    node.nodeSchema === 'workflow.plan-review-request-reservation.v3' &&
    node.outputSchema === 'workflow.plan-review-request-reservation-output.v3';
  const retryShape =
    retryDecisionShape ||
    (node.nodeSchema === 'workflow.plan-review-request-reservation.v2' &&
      node.outputSchema ===
        'workflow.plan-review-request-reservation-output.v2');
  const initialShape =
    node.nodeSchema === 'workflow.plan-review-request-reservation.v1' &&
    node.outputSchema === 'workflow.plan-review-request-reservation-output.v1';
  if (
    !isPlainRecord(output) ||
    node.type !== 'plan-review-request-reservation' ||
    (!initialShape && !retryShape) ||
    node.evaluator !== 'workflow-propose.v1' ||
    node.policyDigest !== PROPOSE_POLICY_DIGEST ||
    output.changeId !== expectedChangeId ||
    !isInvestigationOwner(output.investigationId)
  ) {
    throw refInvalid();
  }
  const currentShape = Object.hasOwn(output, 'materializationNode');
  if (retryShape && !currentShape) {
    throw refInvalid();
  }
  const outputKeys = currentShape
    ? [
        'investigationId',
        'changeId',
        'planning',
        'subject',
        'assignment',
        'author',
        'materializationNode',
        'targetSnapshotNode',
        'manifest',
        'request',
        'grantAuthorization',
        ...(retryShape ? ['retry'] : []),
      ]
    : [
        'investigationId',
        'changeId',
        'planning',
        'subject',
        'assignment',
        'author',
        'manifest',
        'request',
        'grantAuthorization',
      ];
  if (
    !hasExactKeys(output, outputKeys) ||
    !hasExactKeys(node.exactInputDigests, [
      'manifest',
      'request',
      'subject',
      ...(currentShape ? ['targetSnapshot'] : []),
      ...(retryShape ? ['previousRequest', 'failure'] : []),
      ...(retryDecisionShape
        ? ['executionPolicySnapshot', 'retryDecision']
        : []),
    ]) ||
    !hasExactKeys(node.provenanceParentNodeIds, [
      'authorization',
      ...(retryShape ? ['previousRequest'] : []),
    ]) ||
    !hasExactKeys(node.semanticParentResultDigests, [
      'authorization',
      ...(retryShape ? ['previousRequest'] : []),
    ]) ||
    !isPlainRecord(output.planning) ||
    !isPlainRecord(output.manifest)
  ) {
    throw refInvalid();
  }
  const subject = assertPlanReviewSubject(output.subject);
  if (
    !isPlainRecord(output.planning.subject) ||
    canonicalJson(output.planning.subject) !== canonicalJson(subject)
  ) {
    throw refInvalid();
  }
  const request = recreateProviderInvocationRequest(output.request);
  const manifest = output.manifest;
  if (
    request.purpose !== 'plan-review' ||
    request.authorizationNodeId !==
      node.provenanceParentNodeIds.authorization ||
    request.requestDigest !== node.exactInputDigests.request ||
    request.inputManifestDigest !== node.exactInputDigests.manifest ||
    request.inputManifestDigest !== sha256(canonicalJson(manifest)) ||
    request.targetDigest !== subject.subjectDigest ||
    subject.subjectDigest !== node.exactInputDigests.subject ||
    canonicalJson(request.roleAssignment) !==
      canonicalJson(output.assignment) ||
    manifest.schemaVersion !== 1 ||
    manifest.kind !== 'plan-review-manifest' ||
    manifest.changeId !== expectedChangeId ||
    manifest.baseCommit !== request.baseCommit ||
    manifest.baseTree !== request.baseTree ||
    canonicalJson(manifest.subject) !== canonicalJson(subject) ||
    manifest.capabilityProfile !== 'repository-read-only'
  ) {
    throw refInvalid();
  }
  const authorization = readEvidenceNode(
    paths,
    node.provenanceParentNodeIds.authorization,
  );
  const authorizationOutput = authorization.output;
  const authorizationCurrentShape = Object.hasOwn(
    authorization.exactInputDigests,
    'targetSnapshot',
  );
  if (
    authorization.type !== 'plan-review-authorization' ||
    authorization.nodeSchema !== 'workflow.plan-review-authorization.v1' ||
    authorization.evaluator !== 'workflow-propose.v1' ||
    authorization.policyDigest !== PROPOSE_POLICY_DIGEST ||
    authorization.outputSchema !==
      'workflow.plan-review-authorization-output.v1' ||
    !isPlainRecord(authorizationOutput) ||
    !hasExactKeys(authorizationOutput, [
      'subject',
      'assignment',
      'author',
      'grantAuthorization',
    ]) ||
    !hasExactKeys(authorization.exactInputDigests, [
      'assignment',
      'generation',
      'grantAuthorization',
      'subject',
      ...(authorizationCurrentShape ? ['targetSnapshot'] : []),
    ]) ||
    !hasExactKeys(authorization.provenanceParentNodeIds, [
      'materialization',
      ...(authorizationCurrentShape ? ['targetSnapshot'] : []),
    ]) ||
    !hasExactKeys(authorization.semanticParentResultDigests, [
      'materialization',
      ...(authorizationCurrentShape ? ['targetSnapshot'] : []),
    ]) ||
    authorization.resultDigest !==
      node.semanticParentResultDigests.authorization ||
    canonicalJson(authorizationOutput.subject) !== canonicalJson(subject) ||
    canonicalJson(authorizationOutput.assignment) !==
      canonicalJson(output.assignment) ||
    canonicalJson(authorizationOutput.author) !==
      canonicalJson(output.author) ||
    canonicalJson(authorizationOutput.grantAuthorization) !==
      canonicalJson(output.grantAuthorization) ||
    authorization.exactInputDigests.subject !== subject.subjectDigest ||
    authorization.exactInputDigests.assignment !==
      sha256(canonicalJson(output.assignment)) ||
    authorization.exactInputDigests.grantAuthorization !==
      sha256(canonicalJson(output.grantAuthorization)) ||
    !isPlainRecord(output.planning.generation) ||
    authorization.exactInputDigests.generation !==
      output.planning.generation.planningGenerationId
  ) {
    throw refInvalid();
  }

  const materializationId =
    authorization.provenanceParentNodeIds.materialization;
  const materialization = readEvidenceNode(paths, materializationId);
  const materializationOwnership = assertPlanningMaterializationOwnership(
    paths,
    materialization,
    expectedChangeId,
  );
  if (
    materialization.resultDigest !==
      authorization.semanticParentResultDigests.materialization ||
    (refs['propose/planning-materialization'] !== undefined &&
      refs['propose/planning-materialization'] !== materialization.nodeId) ||
    output.investigationId !== materializationOwnership.ownerInvestigationId
  ) {
    throw refInvalid();
  }

  const dependencies: InvestigationEvidenceDependencyClosureEntry[] = [
    dependencyClosureEntry('authorization', authorization),
    dependencyClosureEntry('materialization', materialization),
    ...materializationOwnership.dependencies.map((dependency) =>
      Object.freeze({
        ...dependency,
        role: `materialization/${dependency.role}`,
      }),
    ),
  ];
  if (currentShape !== authorizationCurrentShape) {
    throw refInvalid();
  }
  if (currentShape) {
    if (
      !isPlainRecord(output.materializationNode) ||
      !isPlainRecord(output.targetSnapshotNode)
    ) {
      throw refInvalid();
    }
    const embeddedMaterialization = assertStoredEvidenceNode(
      output.materializationNode,
      refInvalid,
    );
    const embeddedTargetSnapshot = assertStoredEvidenceNode(
      output.targetSnapshotNode,
      refInvalid,
    );
    const storedTargetSnapshot = readEvidenceNode(
      paths,
      embeddedTargetSnapshot.nodeId,
    );
    const target = readPlanReviewTargetSnapshotNode(storedTargetSnapshot);
    if (
      canonicalJson(embeddedMaterialization) !==
        canonicalJson(materialization) ||
      canonicalJson(embeddedTargetSnapshot) !==
        canonicalJson(storedTargetSnapshot) ||
      authorization.provenanceParentNodeIds.targetSnapshot !==
        storedTargetSnapshot.nodeId ||
      authorization.semanticParentResultDigests.targetSnapshot !==
        storedTargetSnapshot.resultDigest ||
      authorization.exactInputDigests.targetSnapshot !==
        storedTargetSnapshot.nodeId ||
      node.exactInputDigests.targetSnapshot !== storedTargetSnapshot.nodeId ||
      target.changeId !== expectedChangeId ||
      target.subjectDigest !== subject.subjectDigest ||
      target.materializationNodeId !== materialization.nodeId ||
      target.materializationResultDigest !== materialization.resultDigest ||
      canonicalJson(manifest.planningTarget) !== canonicalJson(target)
    ) {
      throw refInvalid();
    }
    dependencies.push(
      dependencyClosureEntry('target-snapshot', storedTargetSnapshot),
    );
  } else if (Object.hasOwn(manifest, 'planningTarget')) {
    throw refInvalid();
  }
  if (retryShape) {
    const retry = assertPlanReviewRetryOwnership(
      paths,
      refs,
      node,
      output,
      request,
      expectedChangeId,
    );
    if (
      retry.previousOwnership.ownerInvestigationId !==
      materializationOwnership.ownerInvestigationId
    ) {
      throw refInvalid();
    }
    dependencies.push(
      dependencyClosureEntry('previous-request', retry.previousNode),
      ...retry.previousOwnership.dependencies.map((dependency) =>
        Object.freeze({
          ...dependency,
          role: `previous-request/${dependency.role}`,
        }),
      ),
    );
  }
  return Object.freeze({
    ownerInvestigationId: materializationOwnership.ownerInvestigationId,
    dependencies: Object.freeze(
      dependencies.sort((left, right) => left.role.localeCompare(right.role)),
    ),
  });
}

function assertPlanReviewRetryOwnership(
  paths: InvestigationRuntimePaths,
  refs: Readonly<Record<string, string>>,
  node: EvidenceNode,
  output: Record<string, unknown>,
  request: ReturnType<typeof recreateProviderInvocationRequest>,
  expectedChangeId: string,
): {
  previousNode: EvidenceNode;
  previousOwnership: InvestigationEvidenceOwnership;
} {
  const retry = output.retry;
  const retryDecisionShape =
    node.nodeSchema === 'workflow.plan-review-request-reservation.v3';
  if (
    !isPlainRecord(retry) ||
    !hasExactKeys(retry, [
      'attempt',
      'previousReservationNodeId',
      'failedInvocation',
      ...(retryDecisionShape
        ? ['executionPolicySnapshot', 'retryDecision']
        : []),
    ]) ||
    !Number.isSafeInteger(retry.attempt) ||
    (retry.attempt as number) < 2 ||
    !isDigest(retry.previousReservationNodeId) ||
    !isPlainRecord(retry.failedInvocation) ||
    !hasExactKeys(retry.failedInvocation, [
      'invocationId',
      'attempt',
      'revision',
      'requestDigest',
      'failureDigest',
    ]) ||
    typeof retry.failedInvocation.invocationId !== 'string' ||
    retry.failedInvocation.invocationId.length === 0 ||
    !Number.isSafeInteger(retry.failedInvocation.attempt) ||
    (retry.failedInvocation.attempt as number) < 1 ||
    !Number.isSafeInteger(retry.failedInvocation.revision) ||
    (retry.failedInvocation.revision as number) < 0 ||
    !isDigest(retry.failedInvocation.requestDigest) ||
    !isDigest(retry.failedInvocation.failureDigest) ||
    (retryDecisionShape &&
      (!isPlainRecord(retry.retryDecision) ||
        !hasExactKeys(retry.retryDecision, [
          'evaluatedAt',
          'evidenceDigest',
          'executionJobId',
          'executionRevision',
          'failedAttemptId',
          'kind',
          'schemaVersion',
        ]) ||
        retry.retryDecision.schemaVersion !== 1 ||
        retry.retryDecision.kind !== 'provider-retry-decision-binding' ||
        typeof retry.retryDecision.executionJobId !== 'string' ||
        !/^[a-z0-9][a-z0-9._:-]{0,255}$/.test(
          retry.retryDecision.executionJobId,
        ) ||
        !Number.isSafeInteger(retry.retryDecision.executionRevision) ||
        (retry.retryDecision.executionRevision as number) < 0 ||
        retry.retryDecision.failedAttemptId !==
          `attempt-legacy-${retry.failedInvocation.invocationId}` ||
        !isDigest(retry.retryDecision.evidenceDigest) ||
        typeof retry.retryDecision.evaluatedAt !== 'string' ||
        Number.isNaN(Date.parse(retry.retryDecision.evaluatedAt)) ||
        node.exactInputDigests.retryDecision !==
          retry.retryDecision.evidenceDigest)) ||
    (retryDecisionShape &&
      (!isPlainRecord(retry.executionPolicySnapshot) ||
        !hasExactKeys(retry.executionPolicySnapshot, [
          'accountingDigest',
          'attemptReservation',
          ...(retry.executionPolicySnapshot.schemaVersion === 3
            ? ['authority']
            : []),
          'invocationId',
          'kind',
          'policyDigest',
          'policyDocument',
          'requestDigest',
          'retryAccounting',
          'schemaVersion',
        ]) ||
        ![2, 3].includes(
          retry.executionPolicySnapshot.schemaVersion as number,
        ) ||
        (retry.executionPolicySnapshot.schemaVersion === 3 &&
          !isPlainRecord(retry.executionPolicySnapshot.authority)) ||
        retry.executionPolicySnapshot.kind !==
          'provider-execution-policy-snapshot' ||
        retry.executionPolicySnapshot.invocationId !== request.invocationId ||
        retry.executionPolicySnapshot.requestDigest !== request.requestDigest ||
        retry.executionPolicySnapshot.policyDigest !== request.policyDigest ||
        typeof retry.executionPolicySnapshot.policyDocument !== 'string' ||
        !isPlainRecord(retry.executionPolicySnapshot.retryAccounting) ||
        !isPlainRecord(retry.executionPolicySnapshot.attemptReservation) ||
        !isDigest(retry.executionPolicySnapshot.accountingDigest) ||
        node.exactInputDigests.executionPolicySnapshot !==
          sha256(canonicalJson(retry.executionPolicySnapshot)))) ||
    node.exactInputDigests.failure !== retry.failedInvocation.failureDigest ||
    node.exactInputDigests.previousRequest !==
      retry.previousReservationNodeId ||
    node.provenanceParentNodeIds.previousRequest !==
      retry.previousReservationNodeId
  ) {
    throw refInvalid();
  }
  const previousNode = readEvidenceNode(paths, retry.previousReservationNodeId);
  if (
    previousNode.resultDigest !==
    node.semanticParentResultDigests.previousRequest
  ) {
    throw refInvalid();
  }
  const previousOwnership = assertPlanReviewRequestOwnership(
    paths,
    refs,
    previousNode,
    expectedChangeId,
  );
  if (!isPlainRecord(previousNode.output)) {
    throw refInvalid();
  }
  const previousOutput = previousNode.output;
  const previousRequest = recreateProviderInvocationRequest(
    previousOutput.request,
  );
  const previousRetry = previousOutput.retry;
  const previousAttempt =
    previousNode.nodeSchema === 'workflow.plan-review-request-reservation.v1'
      ? 1
      : isPlainRecord(previousRetry) &&
          Number.isSafeInteger(previousRetry.attempt) &&
          (previousRetry.attempt as number) >= 2
        ? (previousRetry.attempt as number)
        : 0;
  const {
    invocationId: _previousInvocationId,
    nonce: _previousNonce,
    requestDigest: _previousRequestDigest,
    policyDigest: _previousPolicyDigest,
    limits: _previousLimits,
    ...previousRequestBinding
  } = previousRequest;
  const {
    invocationId: _replacementInvocationId,
    nonce: _replacementNonce,
    requestDigest: _replacementRequestDigest,
    policyDigest: _replacementPolicyDigest,
    limits: _replacementLimits,
    ...replacementRequestBinding
  } = request;
  if (
    previousAttempt === 0 ||
    retry.attempt !== previousAttempt + 1 ||
    retry.failedInvocation.attempt !== previousAttempt ||
    retry.failedInvocation.invocationId !== previousRequest.invocationId ||
    retry.failedInvocation.requestDigest !== previousRequest.requestDigest ||
    request.invocationId === previousRequest.invocationId ||
    request.nonce === previousRequest.nonce ||
    request.requestDigest === previousRequest.requestDigest ||
    canonicalJson(replacementRequestBinding) !==
      canonicalJson(previousRequestBinding)
  ) {
    throw refInvalid();
  }
  for (const field of [
    'planning',
    'subject',
    'assignment',
    'author',
    'materializationNode',
    'targetSnapshotNode',
    'manifest',
    'grantAuthorization',
  ]) {
    if (canonicalJson(previousOutput[field]) !== canonicalJson(output[field])) {
      throw refInvalid();
    }
  }
  return { previousNode, previousOwnership };
}

function assertPlanReviewGrantRequirementOwnership(
  node: EvidenceNode,
  expectedChangeId: string,
): InvestigationEvidenceOwnership {
  const output = node.output;
  assertProposeEvidenceNode(node, {
    type: 'plan-review-grant-requirement',
    nodeSchema: 'workflow.plan-review-grant-requirement.v1',
    outputSchema: 'workflow.plan-review-grant-requirement-output.v1',
    exactInputKeys: ['author', 'grantRequest', 'subject'],
    provenanceKeys: [],
    semanticKeys: [],
  });
  if (
    !isPlainRecord(output) ||
    !hasExactKeys(output, [
      'investigationId',
      'changeId',
      'subject',
      'author',
      'grantRequest',
    ]) ||
    output.changeId !== expectedChangeId ||
    !isInvestigationOwner(output.investigationId) ||
    !isPlainRecord(output.author)
  ) {
    throw refInvalid();
  }
  const subject = assertPlanReviewSubject(output.subject);
  if (
    node.exactInputDigests.subject !== subject.subjectDigest ||
    node.exactInputDigests.author !== sha256(canonicalJson(output.author)) ||
    node.exactInputDigests.grantRequest !==
      sha256(canonicalJson(output.grantRequest))
  ) {
    throw refInvalid();
  }
  return Object.freeze({
    ownerInvestigationId: output.investigationId,
    dependencies: Object.freeze([]),
  });
}

function assertExemptionSessionOwnership(
  paths: InvestigationRuntimePaths,
  node: EvidenceNode,
  expectedChangeId: string,
): InvestigationEvidenceOwnership {
  const output = node.output;
  if (
    node.type !== 'propose-exemption-session-reservation' ||
    node.nodeSchema !== 'workflow.propose-exemption-session-reservation.v1' ||
    node.evaluator !== 'workflow-propose.v1' ||
    node.policyDigest !== PROPOSE_EXEMPTION_SESSION_STORE_POLICY_DIGEST ||
    node.outputSchema !==
      'workflow.propose-exemption-session-reservation-output.v1' ||
    !hasExactKeys(node.exactInputDigests, ['record', 'request']) ||
    !hasExactKeys(node.provenanceParentNodeIds, ['applicability']) ||
    !hasExactKeys(node.semanticParentResultDigests, ['applicability']) ||
    !isPlainRecord(output) ||
    !hasExactKeys(output, [
      'changeId',
      'investigationId',
      'recordId',
      'requestDigest',
    ]) ||
    output.changeId !== expectedChangeId ||
    !isDigest(output.recordId) ||
    !isDigest(output.requestDigest) ||
    output.investigationId !== `investigation-exemption-${output.recordId}` ||
    node.exactInputDigests.record !== output.recordId ||
    node.exactInputDigests.request !== output.requestDigest
  ) {
    throw refInvalid();
  }
  const applicability = readApplicabilityDependency(
    paths,
    node.provenanceParentNodeIds.applicability,
    node.semanticParentResultDigests.applicability,
  );
  return Object.freeze({
    ownerInvestigationId: output.investigationId,
    dependencies: Object.freeze([applicability]),
  });
}

function assertProposeEvidenceNode(
  node: EvidenceNode,
  expected: {
    type: string;
    nodeSchema: string;
    outputSchema: string;
    exactInputKeys: string[];
    provenanceKeys: string[];
    semanticKeys: string[];
  },
): void {
  if (
    node.type !== expected.type ||
    node.nodeSchema !== expected.nodeSchema ||
    node.evaluator !== 'workflow-propose.v1' ||
    node.policyDigest !== PROPOSE_POLICY_DIGEST ||
    node.outputSchema !== expected.outputSchema ||
    !hasExactKeys(node.exactInputDigests, expected.exactInputKeys) ||
    !hasExactKeys(node.provenanceParentNodeIds, expected.provenanceKeys) ||
    !hasExactKeys(node.semanticParentResultDigests, expected.semanticKeys)
  ) {
    throw refInvalid();
  }
}

function readApplicabilityDependency(
  paths: InvestigationRuntimePaths,
  nodeId: string,
  resultDigest: string,
): InvestigationEvidenceDependencyClosureEntry {
  const node = readEvidenceNode(paths, nodeId);
  const applicability = assertInvestigationApplicability(node.output);
  if (
    applicability.kind !== 'investigation-exemption' ||
    node.type !== 'investigation-applicability' ||
    node.nodeSchema !== 'investigation.applicability.v1' ||
    node.evaluator !== 'investigation-applicability.v1' ||
    node.policyDigest !== INVESTIGATION_APPLICABILITY_POLICY_DIGEST ||
    node.outputSchema !== 'investigation.applicability-output.v1' ||
    node.resultDigest !== resultDigest
  ) {
    throw refInvalid();
  }
  return dependencyClosureEntry('applicability', node);
}

function dependencyClosureEntry(
  role: string,
  node: EvidenceNode,
): InvestigationEvidenceDependencyClosureEntry {
  return Object.freeze({
    role,
    nodeId: node.nodeId,
    resultDigest: node.resultDigest,
    envelopeDigest: sha256(canonicalEvidenceNodeEnvelope(node)),
  });
}

function isBaseline(value: unknown): value is { head: string; tree: string } {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['head', 'tree']) &&
    typeof value.head === 'string' &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.head) &&
    typeof value.tree === 'string' &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.tree)
  );
}

function isDigestRecord(value: unknown): value is Record<string, string> {
  return (
    isPlainRecord(value) &&
    Object.entries(value).every(
      ([name, digest]) =>
        name.length > 0 && typeof digest === 'string' && isDigest(digest),
    )
  );
}

function isInvestigationOwner(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    return assertInvestigationId(value) === value;
  } catch {
    return false;
  }
}

function isTaskDiffReviewImplementationActor(
  value: unknown,
): value is Record<string, unknown> {
  if (!(
    isPlainRecord(value) &&
    hasExactKeys(value, [
      'providerId',
      'sessionId',
      'principalId',
      'identityAssurance',
      'engineSpawned',
    ]) &&
    (value.providerId === 'codex' || value.providerId === 'claude') &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0
  )) {
    return false;
  }
  const callerAttributed =
    typeof value.principalId === 'string' &&
    value.principalId === `provider:${value.providerId}` &&
    (value.identityAssurance === 'self-declared' ||
      value.identityAssurance === 'runtime-hint') &&
    value.engineSpawned === false;
  const engineAttributed =
    value.principalId === null &&
    value.identityAssurance === 'adapter-assigned' &&
    value.engineSpawned === true;
  return callerAttributed || engineAttributed;
}

function isTaskDiffReviewAssignmentForActor(
  value: unknown,
  actor: Record<string, unknown>,
  subjectDigest: string,
): value is Record<string, unknown> {
  if (
    !isProviderRoleAssignment(value) ||
    value.role !== 'task-diff-reviewer' ||
    value.targetDigest !== subjectDigest
  ) {
    return false;
  }
  if (!('grantId' in value)) {
    return (
      value.providerId !== actor.providerId &&
      value.achievedIndependence === 'provider-independent'
    );
  }
  return (
    value.degradedForm === 'same-provider-fresh-session' &&
    value.providerId === actor.providerId &&
    value.achievedIndependence === 'session-independent' &&
    value.author.providerId === actor.providerId &&
    value.author.sessionId === actor.sessionId &&
    value.participant.providerId === value.providerId &&
    value.participant.sessionId === value.sessionId &&
    value.participant.engineSpawned === true &&
    value.participant.principalId ===
      `collaboration-grant:${value.grantId}:task-diff-reviewer`
  );
}

function isTaskStrategyImplementationAssignmentForAuthor(
  value: unknown,
  author: Record<string, unknown>,
  subjectDigest: string,
): value is Record<string, unknown> {
  if (
    !isProviderRoleAssignment(value) ||
    value.role !== 'task-implementer' ||
    value.targetDigest !== subjectDigest
  ) {
    return false;
  }
  if (!('grantId' in value)) {
    return (
      value.providerId !== author.providerId &&
      value.achievedIndependence === 'provider-independent'
    );
  }
  return (
    value.degradedForm === 'same-provider-fresh-session' &&
    value.providerId === author.providerId &&
    value.achievedIndependence === 'session-independent' &&
    value.author.providerId === author.providerId &&
    value.author.sessionId === author.sessionId &&
    value.participant.providerId === value.providerId &&
    value.participant.sessionId === value.sessionId &&
    value.participant.engineSpawned === true &&
    value.participant.principalId ===
      `collaboration-grant:${value.grantId}:task-implementer`
  );
}

function isTaskStrategyRedAuthor(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, [
      'providerId',
      'sessionId',
      'principalId',
      'identityAssurance',
      'engineSpawned',
    ]) &&
    (value.providerId === 'codex' || value.providerId === 'claude') &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 &&
    value.principalId === `provider:${value.providerId}` &&
    (value.identityAssurance === 'self-declared' ||
      value.identityAssurance === 'runtime-hint' ||
      value.identityAssurance === 'adapter-assigned') &&
    value.engineSpawned === false
  );
}

function isTaskDiffReviewMandateBinding(
  value: unknown,
  changeId: string,
): value is TaskMandateBinding | null {
  return (
    value === null ||
    (isPlainRecord(value) &&
      hasExactKeys(value, [
        'schemaVersion',
        'mandateTaskId',
        'mandateId',
        'mandateDigest',
        'changeId',
        'externalAuditRoot',
      ]) &&
      value.schemaVersion === 1 &&
      typeof value.mandateTaskId === 'string' &&
      value.mandateTaskId.length > 0 &&
      typeof value.mandateId === 'string' &&
      value.mandateId.length > 0 &&
      isDigest(value.mandateDigest) &&
      value.changeId === changeId &&
      typeof value.externalAuditRoot === 'string' &&
      value.externalAuditRoot.length > 0)
  );
}

function releaseRefLock(
  lockPath: string,
  descriptor: number,
  owned: fs.Stats,
  marker: string,
): void {
  const stats = fs.lstatSync(lockPath, { throwIfNoEntry: false });
  let observed: string | undefined;
  try {
    const bytes = Buffer.alloc(Buffer.byteLength(marker));
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    observed = bytes.subarray(0, count).toString('utf8');
  } catch {
    observed = undefined;
  }
  fs.closeSync(descriptor);
  // Only remove a lock that is still the exact file we created; ownership that
  // changed under us must not be unlinked.
  if (
    owned.isFile() &&
    owned.nlink === 1 &&
    (owned.mode & 0o777) === 0o600 &&
    stats?.isFile() &&
    !stats.isSymbolicLink() &&
    stats.nlink === 1 &&
    (stats.mode & 0o777) === 0o600 &&
    stats.dev === owned.dev &&
    stats.ino === owned.ino &&
    observed === marker
  ) {
    fs.unlinkSync(lockPath);
    fsyncDirectory(path.dirname(lockPath));
    return;
  }
  throw refLockInvalid();
}

function ensureNoFollowDirectory(
  base: string,
  privateRoot: string,
  directory: string,
  makeError: () => ReturnType<typeof workflowError>,
): void {
  walkNoFollowDirectory(base, privateRoot, directory, makeError, true);
}

function assertNoFollowDirectory(
  base: string,
  privateRoot: string,
  directory: string,
  makeError: () => ReturnType<typeof workflowError>,
): boolean {
  return walkNoFollowDirectory(base, privateRoot, directory, makeError, false);
}

function walkNoFollowDirectory(
  base: string,
  privateRoot: string,
  directory: string,
  makeError: () => ReturnType<typeof workflowError>,
  create: boolean,
): boolean {
  const relative = path.relative(base, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw makeError();
  }
  let current = base;
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
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      fs.realpathSync(current) !== path.resolve(current)
    ) {
      throw makeError();
    }
    if (
      isInsideOrEqual(privateRoot, current) &&
      (stats.mode & 0o777) !== 0o700
    ) {
      throw makeError();
    }
  }
  return true;
}

function isInsideOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function evidenceObjectPath(
  paths: InvestigationRuntimePaths,
  nodeId: string,
): string {
  return path.join(paths.objects, nodeId.slice(0, 2), `${nodeId}.json`);
}

type EvidenceObjectFinalState = 'absent' | 'exact' | 'legacy-prefix';

type EvidencePublicationAlias = {
  aliasPath: string;
  kind: 'publish';
  pid: number;
};

function evidencePublicationAlias(objectPath: string): string {
  return `${objectPath}.${process.pid}.${crypto.randomUUID()}.publish.tmp`;
}

function inspectEvidenceObjectFinal(
  objectPath: string,
  exactContent: Buffer,
): EvidenceObjectFinalState {
  recoverLegacyEvidenceRepairClaim(objectPath, exactContent);
  const stats = fs.lstatSync(objectPath, { throwIfNoEntry: false });
  if (!stats) {
    return 'absent';
  }
  if (stats.nlink === 2) {
    resolveLinkedEvidenceObjectFinal(objectPath, exactContent);
    return inspectEvidenceObjectFinal(objectPath, exactContent);
  }
  if (stats.nlink !== 1) {
    throw objectUnsafe();
  }
  const observed = readStablePrivateFile(objectPath, [1], objectUnsafe);
  if (observed.bytes.equals(exactContent)) {
    return 'exact';
  }
  if (isStrictBufferPrefix(observed.bytes, exactContent)) {
    return 'legacy-prefix';
  }
  throw objectCollision(path.basename(objectPath, '.json'));
}

function publishLegacyEvidenceRepairClaim(
  objectPath: string,
  publishAlias: string,
  exactContent: Buffer,
): void {
  const claimPath = `${objectPath}.legacy-prefix-repair`;
  try {
    fs.linkSync(publishAlias, claimPath);
    fsyncDirectory(path.dirname(objectPath));
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') {
      throw error;
    }
  }
  const claimStats = fs.lstatSync(claimPath, { throwIfNoEntry: false });
  if (!claimStats) {
    throw objectUnsafe();
  }
  const claim = readStablePrivateFile(
    claimPath,
    [claimStats.nlink],
    objectUnsafe,
  );
  if (!claim.bytes.equals(exactContent)) {
    throw objectCollision(path.basename(objectPath, '.json'));
  }
  recoverLegacyEvidenceRepairClaim(objectPath, exactContent);
}

function recoverLegacyEvidenceRepairClaim(
  objectPath: string,
  exactContent: Buffer,
): void {
  const claimPath = `${objectPath}.legacy-prefix-repair`;
  let claimStats = fs.lstatSync(claimPath, { throwIfNoEntry: false });
  if (!claimStats) {
    return;
  }
  let claim = readStablePrivateFile(
    claimPath,
    [claimStats.nlink],
    objectUnsafe,
  );
  if (!claim.bytes.equals(exactContent)) {
    throw objectCollision(path.basename(objectPath, '.json'));
  }
  if (claim.stats.nlink === 2) {
    const finalStats = fs.lstatSync(objectPath, {
      throwIfNoEntry: false,
    });
    if (
      finalStats?.dev === claim.stats.dev &&
      finalStats.ino === claim.stats.ino
    ) {
      const final = readStablePrivateFile(objectPath, [2], objectUnsafe);
      if (!final.bytes.equals(exactContent)) {
        throw objectUnsafe();
      }
      fs.unlinkSync(claimPath);
      fsyncDirectory(path.dirname(objectPath));
      return;
    }
    const linkedAliases = listEvidencePublicationAliases(objectPath).filter(
      (alias) => {
        const stats = fs.lstatSync(alias.aliasPath, {
          throwIfNoEntry: false,
        });
        return stats?.dev === claim.stats.dev && stats.ino === claim.stats.ino;
      },
    );
    if (linkedAliases.length !== 1) {
      throw objectUnsafe();
    }
    const linkedAlias = readStablePrivateFile(
      linkedAliases[0]!.aliasPath,
      [2],
      objectUnsafe,
    );
    if (!linkedAlias.bytes.equals(exactContent)) {
      throw objectUnsafe();
    }
    fs.unlinkSync(linkedAliases[0]!.aliasPath);
    fsyncDirectory(path.dirname(objectPath));
    claimStats = fs.lstatSync(claimPath);
    claim = readStablePrivateFile(claimPath, [1], objectUnsafe);
  }
  if (claim.stats.nlink !== 1 || claimStats.nlink !== 1) {
    throw objectUnsafe();
  }

  const finalStats = fs.lstatSync(objectPath, { throwIfNoEntry: false });
  if (finalStats) {
    const final = readStablePrivateFile(
      objectPath,
      [finalStats.nlink],
      objectUnsafe,
    );
    if (final.bytes.equals(exactContent)) {
      fs.unlinkSync(claimPath);
      fsyncDirectory(path.dirname(objectPath));
      return;
    }
    if (
      final.stats.nlink !== 1 ||
      !isStrictBufferPrefix(final.bytes, exactContent)
    ) {
      throw objectCollision(path.basename(objectPath, '.json'));
    }
    try {
      fs.unlinkSync(objectPath);
      fsyncDirectory(path.dirname(objectPath));
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  try {
    fs.linkSync(claimPath, objectPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') {
      throw error;
    }
  }
  fsyncDirectory(path.dirname(objectPath));
  const currentClaimStats = fs.lstatSync(claimPath, {
    throwIfNoEntry: false,
  });
  if (!currentClaimStats) {
    assertExactEvidenceObjectFinal(objectPath, exactContent);
    return;
  }
  const published = readStablePrivateFile(objectPath, [2], objectUnsafe);
  const currentClaim = readStablePrivateFile(claimPath, [2], objectUnsafe);
  if (
    !published.bytes.equals(exactContent) ||
    !currentClaim.bytes.equals(exactContent) ||
    published.stats.dev !== currentClaim.stats.dev ||
    published.stats.ino !== currentClaim.stats.ino
  ) {
    throw objectUnsafe();
  }
  try {
    fs.unlinkSync(claimPath);
    fsyncDirectory(path.dirname(objectPath));
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
    assertExactEvidenceObjectFinal(objectPath, exactContent);
  }
}

function resolveLinkedEvidenceObjectFinal(
  objectPath: string,
  exactContent: Buffer,
): void {
  const initial = fs.lstatSync(objectPath, { throwIfNoEntry: false });
  if (!initial || initial.nlink === 1) {
    return;
  }
  const final = readStablePrivateFile(
    objectPath,
    [initial.nlink],
    objectUnsafe,
  );
  const linkedAliases: Array<{
    alias: EvidencePublicationAlias;
    stats: fs.Stats;
    bytes: Buffer;
  }> = [];
  for (const alias of listEvidencePublicationAliases(objectPath)) {
    const stats = fs.lstatSync(alias.aliasPath, {
      throwIfNoEntry: false,
    });
    if (
      !stats ||
      stats.dev !== final.stats.dev ||
      stats.ino !== final.stats.ino
    ) {
      continue;
    }
    const observed = readStablePrivateFile(
      alias.aliasPath,
      [initial.nlink],
      objectUnsafe,
    );
    linkedAliases.push({
      alias,
      stats: observed.stats,
      bytes: observed.bytes,
    });
  }
  if (
    initial.nlink !== 2 ||
    linkedAliases.length !== 1 ||
    !final.bytes.equals(exactContent)
  ) {
    throw objectUnsafe();
  }
  if (
    linkedAliases[0]!.alias.kind !== 'publish' ||
    !linkedAliases[0]!.bytes.equals(exactContent)
  ) {
    throw objectUnsafe();
  }
  unlinkValidatedEvidenceAliases(
    linkedAliases.map(({ alias, stats }) => ({ alias, stats })),
    path.dirname(objectPath),
  );
}

function reclaimEvidencePublicationAliases(
  objectPath: string,
  exactContent: Buffer,
): void {
  const objectDirectory = path.dirname(objectPath);
  const finalStats = fs.lstatSync(objectPath, { throwIfNoEntry: false });
  const finalIsExact =
    finalStats !== undefined &&
    readStablePrivateFile(
      objectPath,
      [finalStats.nlink],
      objectUnsafe,
    ).bytes.equals(exactContent);
  const aliases = listEvidencePublicationAliases(objectPath);
  const observedAliases: Array<{
    alias: EvidencePublicationAlias;
    stats: fs.Stats;
    bytes: Buffer;
    liveOtherOwner: boolean;
  }> = [];
  for (const alias of aliases) {
    const aliasStats = fs.lstatSync(alias.aliasPath, {
      throwIfNoEntry: false,
    });
    if (!aliasStats) {
      continue;
    }
    const observed = readStablePrivateFile(
      alias.aliasPath,
      [aliasStats.nlink],
      objectUnsafe,
    );
    if (
      !observed.bytes.equals(exactContent) &&
      !(
        observed.stats.nlink === 1 &&
        isStrictBufferPrefix(observed.bytes, exactContent)
      )
    ) {
      throw objectUnsafe();
    }
    if (
      observed.stats.nlink > 1 &&
      (!finalStats ||
        !finalIsExact ||
        finalStats.dev !== observed.stats.dev ||
        finalStats.ino !== observed.stats.ino ||
        finalStats.nlink !== observed.stats.nlink)
    ) {
      throw objectUnsafe();
    }
    observedAliases.push({
      alias,
      stats: observed.stats,
      bytes: observed.bytes,
      liveOtherOwner: alias.pid !== process.pid && isProcessAlive(alias.pid),
    });
  }

  const reclaimable: Array<{
    alias: EvidencePublicationAlias;
    stats: fs.Stats;
  }> = [];
  for (const observed of observedAliases) {
    if (observed.stats.nlink > 1 || !observed.liveOtherOwner) {
      reclaimable.push(observed);
    }
  }
  unlinkValidatedEvidenceAliases(reclaimable, objectDirectory);
}

function unlinkValidatedEvidenceAliases(
  reclaimable: Array<{
    alias: EvidencePublicationAlias;
    stats: fs.Stats;
  }>,
  objectDirectory: string,
): void {
  let removed = false;
  for (const { alias, stats } of reclaimable) {
    const current = fs.lstatSync(alias.aliasPath, {
      throwIfNoEntry: false,
    });
    if (!current) {
      continue;
    }
    if (
      current.dev !== stats.dev ||
      current.ino !== stats.ino ||
      current.nlink !== stats.nlink ||
      (current.mode & 0o777) !== 0o600 ||
      !current.isFile() ||
      current.isSymbolicLink()
    ) {
      throw objectUnsafe();
    }
    fs.unlinkSync(alias.aliasPath);
    removed = true;
  }
  if (removed) {
    fsyncDirectory(objectDirectory);
  }
}

function listEvidencePublicationAliases(
  objectPath: string,
): EvidencePublicationAlias[] {
  const objectDirectory = path.dirname(objectPath);
  const prefix = `${path.basename(objectPath)}.`;
  return fs
    .readdirSync(objectDirectory)
    .sort()
    .flatMap((name): EvidencePublicationAlias[] => {
      if (!name.startsWith(prefix)) {
        return [];
      }
      const match = EVIDENCE_PUBLICATION_TEMP_SUFFIX.exec(
        name.slice(prefix.length),
      );
      if (!match) {
        return [];
      }
      return [
        {
          aliasPath: path.join(objectDirectory, name),
          pid: Number(match[1]),
          kind: 'publish',
        },
      ];
    });
}

function assertExactEvidenceObjectFinal(
  objectPath: string,
  exactContent: Buffer,
): void {
  const observed = readStablePrivateFile(objectPath, [1], objectUnsafe);
  if (!observed.bytes.equals(exactContent)) {
    throw objectCollision(path.basename(objectPath, '.json'));
  }
}

function assertExactEvidencePublicationAlias(
  aliasPath: string,
  expected: fs.Stats,
  exactContent: Buffer,
  expectedLinkCount: number,
): void {
  const observed = readStablePrivateFile(
    aliasPath,
    [expectedLinkCount],
    objectUnsafe,
  );
  if (
    observed.stats.dev !== expected.dev ||
    observed.stats.ino !== expected.ino ||
    !observed.bytes.equals(exactContent)
  ) {
    throw objectUnsafe();
  }
}

function unlinkOwnedEvidencePublicationAlias(
  aliasPath: string,
  expected: fs.Stats,
  objectDirectory: string,
): void {
  const current = fs.lstatSync(aliasPath, { throwIfNoEntry: false });
  if (!current) {
    return;
  }
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    (current.mode & 0o777) !== 0o600 ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    throw objectUnsafe();
  }
  fs.unlinkSync(aliasPath);
  fsyncDirectory(objectDirectory);
}

function readStablePrivateFile(
  filePath: string,
  allowedLinkCounts: number[],
  makeError: () => ReturnType<typeof workflowError>,
): { bytes: Buffer; stats: fs.Stats } {
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !before ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    !allowedLinkCounts.includes(before.nlink) ||
    (before.mode & 0o777) !== 0o600
  ) {
    throw makeError();
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      !after ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      !allowedLinkCounts.includes(opened.nlink) ||
      !allowedLinkCounts.includes(after.nlink) ||
      (opened.mode & 0o777) !== 0o600 ||
      (after.mode & 0o777) !== 0o600 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      opened.size !== before.size ||
      after.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs ||
      after.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      bytes.byteLength !== before.size
    ) {
      throw makeError();
    }
    return { bytes, stats: after };
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'EVIDENCE_OBJECT_UNSAFE'
    ) {
      throw error;
    }
    throw makeError();
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function isStrictBufferPrefix(prefix: Buffer, exact: Buffer): boolean {
  return (
    prefix.byteLength < exact.byteLength &&
    exact.subarray(0, prefix.byteLength).equals(prefix)
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === 'ESRCH');
  }
}

function evidenceRefPath(
  paths: InvestigationRuntimePaths,
  changeId: string,
): string {
  return path.join(paths.refs, `${changeId}.json`);
}

function readNoFollow(
  filePath: string,
  makeError: () => ReturnType<typeof workflowError>,
): string {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats) {
    throw makeError();
  }
  assertPrivateFileStats(stats, makeError);
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
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino
    ) {
      throw makeError();
    }
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertPrivateFileStats(
  stats: fs.Stats,
  makeError: () => ReturnType<typeof workflowError>,
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

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertNodeId(nodeId: string): void {
  if (!DIGEST_PATTERN.test(nodeId)) {
    throw workflowError(
      'EVIDENCE_OBJECT_ID_INVALID',
      `Invalid evidence node identifier: ${nodeId}`,
      ExitCode.usage,
    );
  }
}

function assertRefName(refName: string): void {
  if (typeof refName !== 'string' || !REF_NAME_PATTERN.test(refName)) {
    throw workflowError(
      'EVIDENCE_REF_NAME_INVALID',
      `Invalid evidence ref name: ${refName}`,
      ExitCode.usage,
    );
  }
}

function objectUnsafe() {
  return workflowError(
    'EVIDENCE_OBJECT_UNSAFE',
    'Evidence object path is not a canonical no-follow location.',
    ExitCode.unsafeEnvironment,
  );
}

function objectInvalid() {
  return workflowError(
    'EVIDENCE_OBJECT_INVALID',
    'Evidence object envelope is forged, tampered, or noncanonical.',
    ExitCode.staleState,
  );
}

function objectCollision(nodeId: string) {
  return workflowError(
    'EVIDENCE_OBJECT_COLLISION',
    'A different evidence envelope already exists for this node identifier.',
    ExitCode.conflict,
    { details: { nodeId } },
  );
}

function objectUnavailable(nodeId: string) {
  return workflowError(
    'EVIDENCE_OBJECT_UNAVAILABLE',
    'The next evidence node must already exist as a stored object.',
    ExitCode.staleState,
    { details: { nodeId } },
  );
}

function refUnsafe() {
  return workflowError(
    'EVIDENCE_REF_UNSAFE',
    'Evidence ref path is not a canonical no-follow location.',
    ExitCode.unsafeEnvironment,
  );
}

function refInvalid() {
  return workflowError(
    'EVIDENCE_REF_INVALID',
    'Evidence ref document is malformed or noncanonical.',
    ExitCode.staleState,
  );
}

function refCasMismatch(
  refName: string,
  expectedNodeId: string | null,
  observedNodeId: string | null,
) {
  return workflowError(
    'EVIDENCE_REF_CAS_MISMATCH',
    'Evidence ref changed during compare-and-swap.',
    ExitCode.conflict,
    { details: { refName, expectedNodeId, observedNodeId } },
  );
}

function refsDocumentCasMismatch(
  expectedDigest: string | null,
  observedDigest: string | null,
  nextDigest: string | null,
) {
  return workflowError(
    'EVIDENCE_REFS_CAS_MISMATCH',
    'Evidence ref document changed during compare-and-swap.',
    ExitCode.conflict,
    { details: { expectedDigest, observedDigest, nextDigest } },
  );
}

function refLocked(changeId: string) {
  return workflowError(
    'EVIDENCE_REF_LOCKED',
    'Evidence ref for this change is locked by another operation.',
    ExitCode.conflict,
    { details: { changeId } },
  );
}

function refLockInvalid() {
  return workflowError(
    'EVIDENCE_REF_LOCK_INVALID',
    'Evidence ref lock ownership changed during the operation.',
    ExitCode.staleState,
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function observeUnsafeNode(
  filePath: UnsafeObservationBytePath,
): Record<string, unknown> {
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!before) {
    return { exists: false };
  }
  const stableBefore = unsafeObservationStableStats(before);
  const common = {
    exists: true,
    mode: before.mode & 0o777,
    nlink: before.nlink,
    size: before.size,
  };
  let observation: Record<string, unknown>;
  if (before.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(filePath, {
      encoding: 'buffer',
    }) as Buffer;
    observation = {
      ...common,
      kind: 'symlink',
      linkTargetBase64: linkTarget.toString('base64'),
    };
  } else if (before.isDirectory()) {
    const names = (
      fs.readdirSync(filePath, { encoding: 'buffer' }) as Buffer[]
    ).sort(Buffer.compare);
    observation = {
      ...common,
      kind: 'directory',
      entries: names.map((name) => ({
        nameBase64: name.toString('base64'),
        node: observeUnsafeNode(unsafeObservationChildPath(filePath, name)),
      })),
    };
  } else if (before.isFile()) {
    observation = {
      ...common,
      kind: 'file',
      contentDigest: digestUnsafeRegularFile(filePath, stableBefore),
    };
  } else {
    observation = {
      ...common,
      kind: 'other',
      rdev: before.rdev,
    };
  }
  const after = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !after ||
    !sameUnsafeObservationStableStats(
      stableBefore,
      unsafeObservationStableStats(after),
    )
  ) {
    throw new Error('Unsafe path changed while it was being observed.');
  }
  return observation;
}

function digestUnsafeRegularFile(
  filePath: UnsafeObservationBytePath,
  expected: UnsafeObservationStableStats,
): string {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !sameUnsafeObservationStableStats(
        expected,
        unsafeObservationStableStats(opened),
      )
    ) {
      throw new Error('Unsafe file changed before it was read.');
    }
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        buffer.byteLength,
        position,
      );
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const closedOver = fs.fstatSync(descriptor);
    if (
      !sameUnsafeObservationStableStats(
        expected,
        unsafeObservationStableStats(closedOver),
      )
    ) {
      throw new Error('Unsafe file changed while it was being read.');
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

function unsafeObservationChildPath(
  parent: UnsafeObservationBytePath,
  name: Buffer,
): Buffer {
  const parentBytes = Buffer.isBuffer(parent) ? parent : Buffer.from(parent);
  return Buffer.concat([parentBytes, Buffer.from(path.sep), name]);
}

function unsafeObservationStableStats(
  stats: fs.Stats,
): UnsafeObservationStableStats {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    nlink: stats.nlink,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

function sameUnsafeObservationStableStats(
  left: UnsafeObservationStableStats,
  right: UnsafeObservationStableStats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
