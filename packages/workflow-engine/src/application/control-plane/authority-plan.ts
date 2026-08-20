import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { loadWorkflowConfig } from '../../adapters/consumer/expense-app/work-registry/contracts.ts';
import { authorityTagPublishCommand } from '../../adapters/remote/github/authority-relay-command.ts';
import {
  ExitCode,
  workflowError,
  type WorkflowError,
} from '../../foundation/errors/errors.ts';
import {
  discoverRepository,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import {
  createPrivateCanonicalJson,
  readPrivateCanonicalJson,
  assertPrivateInvestigationDirectory,
  withPrivateRuntimeLock,
} from '../../runtime/storage-journal/investigation-session-store.ts';
import {
  issueAuthorityAttestation,
  projectAuthorityAttestationRelay,
  type AuthorityAttestationRelayProjection,
  type AuthorityAttestationRequest,
} from './maintainer-attestation.ts';
import {
  approveAndApplyMaintainerGrantV2,
  type ApproveAndApplyMaintainerGrantV2Request,
} from './maintainer-approve.ts';
import type { CandidateExternalEffect } from '../../modules/authority/maintainer-candidate.ts';
import type { MaintainerEvidenceWaiver } from '../../modules/authority/maintainer-grant-v2.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import {
  classifyFileRole,
  loadCapabilityProfileFromTrustBase,
} from '../../modules/authority/maintainer-manifest.ts';
import { parseManagedTrailers } from '../../modules/lifecycle/managed-trailers.ts';
import {
  isManagedAuthorityPlanState,
  type ManagedAuthorityPlanState,
} from '../../modules/lifecycle/managed-workflow-state-contract.ts';
import {
  assertChangeId,
  assertPolicyPathInsideRepository,
  assertTaskId,
  investigationRuntimePaths,
  normalizeExactRepositoryPath,
} from '../../runtime/session-workspace/paths.ts';

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PLAN_ID = /^authority-plan-[0-9a-f]{64}$/;
const REVISION_FILE = /^(\d{6})\.json$/;
const MAX_MUTATIONS = 64;
const MAX_CONTENT_BYTES = 4 * 1024 * 1024;
const MAX_REVISIONS = 32;

export type AuthorityPlanMutation = Readonly<{
  path: string;
  expectedBeforeSha256: string | null;
  content: string | null;
}>;

export type AuthorityPlanIntent = Readonly<{
  schemaVersion: 1;
  kind: 'authority-plan-intent.v1';
  changeId: string;
  taskId: string;
  profileId: string;
  reason: string;
  message: string;
  mutations: readonly AuthorityPlanMutation[];
  externalEffects: readonly CandidateExternalEffect[];
  evidenceWaivers: readonly MaintainerEvidenceWaiver[];
}>;

export type AuthorityPlanPreviewEntry = Readonly<{
  path: string;
  beforeSha256: string | null;
  afterSha256: string | null;
  unifiedDiff: string;
}>;

export type AuthorityPlanLocalApplication = Readonly<{
  grantId: string;
  sessionId: string | null;
  commitHash: string;
  resultTree: string;
  tagRef: string;
  publishCommand: string;
  attestationRelayCommand: string;
  applicationReceiptTagRef: string;
}>;

export type AuthorityPlanAttestation = Readonly<{
  grantId: string;
  originalCommit: string;
  mainCommit: string;
  tagRef: string;
  publishCommand: string;
  envelopeDigest: string;
}>;

export type AuthorityPlanState = ManagedAuthorityPlanState;

export type AuthorityPlanRecord = Readonly<{
  schemaVersion: 1;
  kind: 'authority-plan-record.v1';
  planId: string;
  revision: number;
  previousRecordDigest: string | null;
  recordDigest: string;
  createdAt: string;
  updatedAt: string;
  state: AuthorityPlanState;
  branch: string;
  baseCommit: string;
  baseTree: string;
  intentDigest: string;
  intent: AuthorityPlanIntent;
  preview: readonly AuthorityPlanPreviewEntry[];
  localApplication: AuthorityPlanLocalApplication | null;
  relay: AuthorityAttestationRelayProjection | null;
  attestation: AuthorityPlanAttestation | null;
  friction: Readonly<{
    operatorSigningCeremonies: 0 | 1 | 2;
    publishedTagHandoffs: 0 | 1 | 2;
    remoteMergeObserved: boolean;
  }>;
}>;

type ApprovalResult = Readonly<{
  grantId: string;
  sessionId?: string | null;
  commitHash: string;
  resultTree: string;
  tagRef: string;
  publishCommand: string;
  attestationRelayCommand: string;
  applicationReceiptTagRef: string;
}>;

type AttestationResult = Readonly<{
  grantId: string;
  tagRef: string;
  publishCommand: string;
  envelope?: unknown;
  envelopeDigest?: string;
  originalCommit?: string;
  mainCommit?: string;
}>;

export type AuthorityPlanCreateOptions = Readonly<{ now?: Date }>;

export type AuthorityPlanApproveOptions = Readonly<{
  now?: Date;
  approveAndApply?: (
    cwd: string,
    request: ApproveAndApplyMaintainerGrantV2Request,
  ) => ApprovalResult;
  testCrashAfter?: 'local-apply-result';
}>;

export type AuthorityPlanResumeOptions = Readonly<{
  now?: Date;
  refreshRemote?: (cwd: string) => void;
  observePublishedRef?: (ref: string) => string | null;
  projectAttestationRelay?: (
    cwd: string,
    originalCommit: string,
  ) => AuthorityAttestationRelayProjection;
}>;

export type AuthorityPlanAttestOptions = Readonly<{
  now?: Date;
  issueAttestation?: (
    cwd: string,
    request: AuthorityAttestationRequest,
  ) => AttestationResult;
}>;

export function createAuthorityPlan(
  cwd: string,
  candidateIntent: AuthorityPlanIntent,
  options: AuthorityPlanCreateOptions = {},
): AuthorityPlanRecord {
  const repository = discoverRepository(cwd);
  if (!repository.branch || repository.statusEntries.length !== 0) {
    throw planError(
      'AUTHORITY_PLAN_WORKTREE_CHANGED',
      'An authority plan requires a clean named worktree.',
      ExitCode.conflict,
    );
  }
  const config = loadWorkflowConfig(repository.repositoryRoot);
  const intent = parseIntent(candidateIntent);
  const expectedBranch = config.branchTemplate.replace(
    '{changeId}',
    intent.changeId,
  );
  if (repository.branch !== expectedBranch) {
    throw planError(
      'AUTHORITY_PLAN_BRANCH_INVALID',
      `Authority plan ${intent.changeId} requires branch ${expectedBranch}.`,
      ExitCode.staleState,
    );
  }
  const profile = loadCapabilityProfileFromTrustBase(
    repository.repositoryRoot,
    repository.head,
    intent.profileId,
  );
  if (intent.mutations.length > profile.constraints.maximumFiles) {
    throw planInvalid('Authority plan exceeds its profile file limit.');
  }
  const preview = intent.mutations.map((mutation) => {
    const role = classifyFileRole(profile, mutation.path);
    if (role === undefined || role === 'forbidden') {
      throw planInvalid(
        `Authority plan path is not allowed by ${intent.profileId}: ${mutation.path}`,
      );
    }
    return previewMutation(repository.repositoryRoot, mutation);
  });
  const intentDigest = digest(intent);
  const planId = `authority-plan-${digest({
    schema: 'authority-plan.v1',
    branch: repository.branch,
    baseCommit: repository.head,
    baseTree: repository.tree,
    intentDigest,
    preview,
  })}`;
  const runtime = authorityPlanRuntime(repository);
  const existing = readLatest(runtime, planId, true);
  if (existing !== null) return existing;
  const createdAt = exactTime(options.now);
  return withPlanLock(runtime, planId, () => {
    const raced = readLatest(runtime, planId, true);
    if (raced !== null) return raced;
    return appendRecord(runtime, {
      schemaVersion: 1,
      kind: 'authority-plan-record.v1',
      planId,
      revision: 1,
      previousRecordDigest: null,
      createdAt,
      updatedAt: createdAt,
      state: 'prepared',
      branch: repository.branch!,
      baseCommit: repository.head,
      baseTree: repository.tree,
      intentDigest,
      intent,
      preview,
      localApplication: null,
      relay: null,
      attestation: null,
      friction: {
        operatorSigningCeremonies: 0,
        publishedTagHandoffs: 0,
        remoteMergeObserved: false,
      },
    });
  });
}

/** Strict read-only inspection. It never creates runtime directories. */
export function inspectAuthorityPlan(
  cwd: string,
  requestedPlanId: string,
): AuthorityPlanRecord {
  const planId = assertPlanId(requestedPlanId);
  const repository = discoverRepository(cwd);
  const record = readLatest(authorityPlanRuntime(repository), planId, false);
  if (record === null) {
    throw planError(
      'AUTHORITY_PLAN_NOT_FOUND',
      `Authority plan ${planId} does not exist.`,
      ExitCode.usage,
    );
  }
  return record;
}

export function approveAndApplyAuthorityPlan(
  cwd: string,
  requestedPlanId: string,
  options: AuthorityPlanApproveOptions = {},
): AuthorityPlanRecord {
  const planId = assertPlanId(requestedPlanId);
  const repository = discoverRepository(cwd);
  const runtime = authorityPlanRuntime(repository);
  return withPlanLock(runtime, planId, () => {
    let record = requireLatest(runtime, planId);
    if (
      record.state === 'local-applied' ||
      record.state === 'awaiting-attestation' ||
      record.state === 'attestation-issued' ||
      record.state === 'completed'
    ) {
      return record;
    }
    if (record.state === 'prepared') {
      assertPreparedWorktree(repository.repositoryRoot, record);
      record = transition(runtime, record, {
        state: 'applying-local',
        updatedAt: exactTime(options.now),
      });
    }
    const current = discoverRepository(repository.repositoryRoot);
    if (current.head !== record.baseCommit) {
      const recovered = recoverLocalApplication(current.repositoryRoot, record);
      return transition(runtime, record, {
        state: 'local-applied',
        updatedAt: exactTime(options.now),
        localApplication: recovered,
        friction: {
          operatorSigningCeremonies: 1,
          publishedTagHandoffs: 0,
          remoteMergeObserved: false,
        },
      });
    }
    assertApplyingWorktree(current.repositoryRoot, record);
    if (discoverRepository(current.repositoryRoot).statusEntries.length === 0) {
      applyMutations(current.repositoryRoot, record.intent.mutations);
    }
    const approve =
      options.approveAndApply ??
      ((root: string, request: ApproveAndApplyMaintainerGrantV2Request) =>
        approveAndApplyMaintainerGrantV2(root, request, { now: options.now }));
    let applied: ApprovalResult;
    try {
      applied = approve(current.repositoryRoot, approvalRequest(record.intent));
    } catch (error) {
      const afterFailure = discoverRepository(current.repositoryRoot);
      if (afterFailure.head === record.baseCommit) {
        restoreMutations(current.repositoryRoot, record);
      }
      throw error;
    }
    const normalized = normalizeApplication(
      current.repositoryRoot,
      record,
      applied,
    );
    if (options.testCrashAfter === 'local-apply-result') {
      throw new Error(
        'Simulated authority-plan interruption after local apply result.',
      );
    }
    return transition(runtime, record, {
      state: 'local-applied',
      updatedAt: exactTime(options.now),
      localApplication: normalized,
      friction: {
        operatorSigningCeremonies: 1,
        publishedTagHandoffs: 0,
        remoteMergeObserved: false,
      },
    });
  });
}

export function resumeAuthorityPlan(
  cwd: string,
  requestedPlanId: string,
  options: AuthorityPlanResumeOptions = {},
): AuthorityPlanRecord {
  const planId = assertPlanId(requestedPlanId);
  const repository = discoverRepository(cwd);
  const runtime = authorityPlanRuntime(repository);
  return withPlanLock(runtime, planId, () => {
    let record = requireLatest(runtime, planId);
    if (record.state === 'completed' || record.state === 'prepared') {
      return record;
    }
    if (record.state === 'applying-local') {
      const current = discoverRepository(repository.repositoryRoot);
      if (current.head === record.baseCommit) return record;
      record = transition(runtime, record, {
        state: 'local-applied',
        updatedAt: exactTime(options.now),
        localApplication: recoverLocalApplication(
          repository.repositoryRoot,
          record,
        ),
        friction: {
          operatorSigningCeremonies: 1,
          publishedTagHandoffs: 0,
          remoteMergeObserved: false,
        },
      });
    }
    const refresh =
      options.refreshRemote ??
      ((root: string) => {
        runGit(root, ['fetch', '--prune', 'origin']);
      });
    const observe =
      options.observePublishedRef ??
      ((ref: string) => observeRemoteRef(repository.repositoryRoot, ref));
    if (record.state === 'local-applied') {
      refresh(repository.repositoryRoot);
      if (observe(record.localApplication!.tagRef) === null) return record;
      const project =
        options.projectAttestationRelay ?? projectAuthorityAttestationRelay;
      const relay = project(
        repository.repositoryRoot,
        record.localApplication!.commitHash,
      );
      assertRelay(record, relay);
      return transition(runtime, record, {
        state: 'awaiting-attestation',
        updatedAt: exactTime(options.now),
        relay,
        friction: {
          operatorSigningCeremonies: 1,
          publishedTagHandoffs: 1,
          remoteMergeObserved: true,
        },
      });
    }
    if (record.state === 'awaiting-attestation') return record;
    if (record.state === 'attestation-issued') {
      refresh(repository.repositoryRoot);
      if (observe(record.attestation!.tagRef) === null) return record;
      return transition(runtime, record, {
        state: 'completed',
        updatedAt: exactTime(options.now),
        friction: {
          operatorSigningCeremonies: 2,
          publishedTagHandoffs: 2,
          remoteMergeObserved: true,
        },
      });
    }
    return record;
  });
}

export function attestAuthorityPlan(
  cwd: string,
  requestedPlanId: string,
  options: AuthorityPlanAttestOptions = {},
): AuthorityPlanRecord {
  const planId = assertPlanId(requestedPlanId);
  const repository = discoverRepository(cwd);
  const runtime = authorityPlanRuntime(repository);
  return withPlanLock(runtime, planId, () => {
    const record = requireLatest(runtime, planId);
    if (record.state === 'attestation-issued' || record.state === 'completed') {
      return record;
    }
    if (record.state !== 'awaiting-attestation' || record.relay === null) {
      throw planError(
        'AUTHORITY_PLAN_ATTESTATION_NOT_READY',
        'Authority plan attestation requires an observed protected-branch merge.',
        ExitCode.conflict,
      );
    }
    const request: AuthorityAttestationRequest = {
      originalCommit: record.relay.originalCommit,
      mainCommit: record.relay.mainCommit,
      grantBasePairs: record.relay.grantBasePairs,
    };
    const issue =
      options.issueAttestation ??
      ((root: string, value: AuthorityAttestationRequest) =>
        issueAuthorityAttestation(root, value, { now: options.now }));
    const issued = issue(
      repository.repositoryRoot,
      request,
    ) as AttestationResult;
    const envelopeDigest =
      issued.envelopeDigest ?? digest(assertJsonValue(issued.envelope));
    const attestation: AuthorityPlanAttestation = {
      grantId: issued.grantId,
      originalCommit: issued.originalCommit ?? request.originalCommit,
      mainCommit: issued.mainCommit ?? request.mainCommit,
      tagRef: issued.tagRef,
      publishCommand: issued.publishCommand,
      envelopeDigest,
    };
    if (
      attestation.grantId !== record.relay.grantId ||
      attestation.originalCommit !== record.relay.originalCommit ||
      attestation.mainCommit !== record.relay.mainCommit ||
      attestation.tagRef !== record.relay.tagRef ||
      !SHA256.test(attestation.envelopeDigest)
    ) {
      throw planUnsafe('Issued attestation does not match the durable relay.');
    }
    return transition(runtime, record, {
      state: 'attestation-issued',
      updatedAt: exactTime(options.now),
      attestation,
      friction: {
        operatorSigningCeremonies: 2,
        publishedTagHandoffs: 1,
        remoteMergeObserved: true,
      },
    });
  });
}

function approvalRequest(
  intent: AuthorityPlanIntent,
): ApproveAndApplyMaintainerGrantV2Request {
  return {
    changeId: intent.changeId,
    taskId: intent.taskId,
    profileId: intent.profileId,
    reason: intent.reason,
    message: intent.message,
    externalEffects: [...structuredClone(intent.externalEffects)],
    evidenceWaivers: [...structuredClone(intent.evidenceWaivers)],
  };
}

function parseIntent(value: unknown): AuthorityPlanIntent {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'taskId',
      'profileId',
      'reason',
      'message',
      'mutations',
      'externalEffects',
      'evidenceWaivers',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'authority-plan-intent.v1' ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.profileId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.profileId) ||
    typeof value.reason !== 'string' ||
    value.reason.trim() !== value.reason ||
    value.reason.length < 12 ||
    value.reason.length > 500 ||
    typeof value.message !== 'string' ||
    value.message.trim() !== value.message ||
    value.message.length < 1 ||
    value.message.includes('\n') ||
    !Array.isArray(value.mutations) ||
    value.mutations.length < 1 ||
    value.mutations.length > MAX_MUTATIONS ||
    !Array.isArray(value.externalEffects) ||
    !Array.isArray(value.evidenceWaivers)
  ) {
    throw planInvalid('Authority plan intent is malformed.');
  }
  assertChangeId(value.changeId);
  assertTaskId(value.taskId);
  const mutations = value.mutations.map(parseMutation);
  const paths = mutations.map((mutation) => mutation.path);
  if (
    new Set(paths).size !== paths.length ||
    canonicalJson(paths) !== canonicalJson([...paths].sort())
  ) {
    throw planInvalid(
      'Authority plan mutation paths must be sorted and unique.',
    );
  }
  const externalEffects = value.externalEffects.map(parseExternalEffect);
  const evidenceWaivers = value.evidenceWaivers.map(parseEvidenceWaiver);
  return structuredClone({
    schemaVersion: 1,
    kind: 'authority-plan-intent.v1',
    changeId: value.changeId,
    taskId: value.taskId,
    profileId: value.profileId,
    reason: value.reason,
    message: value.message,
    mutations,
    externalEffects,
    evidenceWaivers,
  });
}

/** Validate and normalize an authority-plan intent without preparing a plan. */
export function parseAuthorityPlanIntent(value: unknown): AuthorityPlanIntent {
  return parseIntent(value);
}

function parseMutation(value: unknown): AuthorityPlanMutation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['path', 'expectedBeforeSha256', 'content']) ||
    typeof value.path !== 'string' ||
    (value.expectedBeforeSha256 !== null &&
      (typeof value.expectedBeforeSha256 !== 'string' ||
        !SHA256.test(value.expectedBeforeSha256))) ||
    (value.content !== null && typeof value.content !== 'string') ||
    (typeof value.content === 'string' &&
      Buffer.byteLength(value.content, 'utf8') > MAX_CONTENT_BYTES)
  ) {
    throw planInvalid('Authority plan mutation is malformed.');
  }
  return {
    path: normalizeExactRepositoryPath(value.path),
    expectedBeforeSha256: value.expectedBeforeSha256,
    content: value.content,
  };
}

function parseExternalEffect(value: unknown): CandidateExternalEffect {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'effectType',
      'targetDigest',
      'authorizationDigest',
      'resultDigest',
    ]) ||
    typeof value.effectType !== 'string' ||
    typeof value.targetDigest !== 'string' ||
    (value.authorizationDigest !== null &&
      typeof value.authorizationDigest !== 'string') ||
    (value.resultDigest !== null && typeof value.resultDigest !== 'string')
  ) {
    throw planInvalid('Authority plan external effect is malformed.');
  }
  return {
    effectType: value.effectType,
    targetDigest: value.targetDigest,
    authorizationDigest: value.authorizationDigest,
    resultDigest: value.resultDigest,
  };
}

function parseEvidenceWaiver(value: unknown): MaintainerEvidenceWaiver {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['checkId', 'reason']) ||
    typeof value.checkId !== 'string' ||
    typeof value.reason !== 'string'
  ) {
    throw planInvalid('Authority plan evidence waiver is malformed.');
  }
  return { checkId: value.checkId, reason: value.reason };
}

function previewMutation(
  repositoryRoot: string,
  mutation: AuthorityPlanMutation,
): AuthorityPlanPreviewEntry {
  assertPolicyPathInsideRepository(repositoryRoot, mutation.path);
  const target = path.join(repositoryRoot, mutation.path);
  const stats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stats !== undefined && !stats.isFile()) {
    throw planInvalid(
      `Authority plan target is not a regular file: ${mutation.path}`,
    );
  }
  const before = stats === undefined ? null : fs.readFileSync(target, 'utf8');
  const beforeSha256 = before === null ? null : digestBytes(before);
  if (beforeSha256 !== mutation.expectedBeforeSha256) {
    throw planError(
      'AUTHORITY_PLAN_WORKTREE_CHANGED',
      `Authority plan precondition changed for ${mutation.path}.`,
      ExitCode.staleState,
    );
  }
  const afterSha256 =
    mutation.content === null ? null : digestBytes(mutation.content);
  if (beforeSha256 === afterSha256) {
    throw planInvalid(`Authority plan mutation is a no-op: ${mutation.path}`);
  }
  return {
    path: mutation.path,
    beforeSha256,
    afterSha256,
    unifiedDiff: unifiedDiff(mutation.path, before, mutation.content),
  };
}

function unifiedDiff(
  filePath: string,
  before: string | null,
  after: string | null,
): string {
  const beforeLines =
    before === null ? [] : before.replace(/\n$/, '').split('\n');
  const afterLines = after === null ? [] : after.replace(/\n$/, '').split('\n');
  return [
    `--- ${before === null ? '/dev/null' : `a/${filePath}`}`,
    `+++ ${after === null ? '/dev/null' : `b/${filePath}`}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

function assertPreparedWorktree(
  repositoryRoot: string,
  record: AuthorityPlanRecord,
): void {
  const current = discoverRepository(repositoryRoot);
  if (
    current.branch !== record.branch ||
    current.head !== record.baseCommit ||
    current.tree !== record.baseTree ||
    current.statusEntries.length !== 0
  ) {
    throw planError(
      'AUTHORITY_PLAN_WORKTREE_CHANGED',
      'The authority-plan worktree changed after dry-run preparation.',
      ExitCode.staleState,
    );
  }
  for (const mutation of record.intent.mutations) {
    const preview = previewMutation(repositoryRoot, mutation);
    const expected = record.preview.find(
      (entry) => entry.path === mutation.path,
    );
    if (
      expected === undefined ||
      canonicalJson(preview) !== canonicalJson(expected)
    ) {
      throw planUnsafe(
        'Authority plan preview no longer matches its exact input.',
      );
    }
  }
}

function assertApplyingWorktree(
  repositoryRoot: string,
  record: AuthorityPlanRecord,
): void {
  const current = discoverRepository(repositoryRoot);
  if (current.branch !== record.branch || current.head !== record.baseCommit) {
    throw planError(
      'AUTHORITY_PLAN_WORKTREE_CHANGED',
      'Authority plan local application moved to a different branch or base.',
      ExitCode.staleState,
    );
  }
  if (current.statusEntries.length === 0) return;
  const changed = listWorkingTreePaths(repositoryRoot);
  const expected = record.intent.mutations.map((mutation) => mutation.path);
  if (canonicalJson(changed) !== canonicalJson(expected)) {
    throw planError(
      'AUTHORITY_PLAN_WORKTREE_CHANGED',
      'Authority plan local application contains unrelated worktree changes.',
      ExitCode.staleState,
    );
  }
  for (const mutation of record.intent.mutations) {
    assertResultBytes(repositoryRoot, mutation);
  }
}

function applyMutations(
  repositoryRoot: string,
  mutations: readonly AuthorityPlanMutation[],
): void {
  for (const mutation of mutations) {
    const target = path.join(repositoryRoot, mutation.path);
    assertPolicyPathInsideRepository(repositoryRoot, mutation.path);
    if (mutation.content === null) {
      fs.rmSync(target);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, mutation.content, 'utf8');
    }
  }
}

function restoreMutations(
  repositoryRoot: string,
  record: AuthorityPlanRecord,
): void {
  for (const mutation of record.intent.mutations) {
    const target = path.join(repositoryRoot, mutation.path);
    if (mutation.expectedBeforeSha256 === null) {
      fs.rmSync(target, { force: true });
    } else {
      const before = runGit(repositoryRoot, [
        'show',
        `${record.baseCommit}:${mutation.path}`,
      ]);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, before, 'utf8');
    }
  }
  runGit(repositoryRoot, [
    'reset',
    '--quiet',
    record.baseCommit,
    '--',
    ...record.intent.mutations.map((mutation) => mutation.path),
  ]);
}

function normalizeApplication(
  repositoryRoot: string,
  record: AuthorityPlanRecord,
  result: ApprovalResult,
): AuthorityPlanLocalApplication {
  const current = discoverRepository(repositoryRoot);
  if (
    result.commitHash !== current.head ||
    result.resultTree !== current.tree ||
    !COMMIT_OID.test(result.commitHash) ||
    !COMMIT_OID.test(result.resultTree)
  ) {
    throw planUnsafe(
      'Local authority result does not match the current commit.',
    );
  }
  const recovered = recoverLocalApplication(repositoryRoot, record);
  if (recovered.grantId !== result.grantId) {
    throw planUnsafe('Local authority result grant does not match its commit.');
  }
  return {
    grantId: result.grantId,
    sessionId: result.sessionId ?? null,
    commitHash: result.commitHash,
    resultTree: result.resultTree,
    tagRef: result.tagRef,
    publishCommand: result.publishCommand,
    attestationRelayCommand: result.attestationRelayCommand,
    applicationReceiptTagRef: result.applicationReceiptTagRef,
  };
}

function recoverLocalApplication(
  repositoryRoot: string,
  record: AuthorityPlanRecord,
): AuthorityPlanLocalApplication {
  const current = discoverRepository(repositoryRoot);
  const parent = runGit(
    repositoryRoot,
    ['rev-parse', `${current.head}^`],
    true,
  ).trim();
  const changed = runGit(repositoryRoot, [
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    current.head,
  ])
    .split('\n')
    .filter(Boolean)
    .sort();
  const expected = record.intent.mutations.map((mutation) => mutation.path);
  const message = runGit(repositoryRoot, [
    'show',
    '-s',
    '--format=%B',
    current.head,
  ]).trimEnd();
  let trailers;
  try {
    trailers = parseManagedTrailers(message);
  } catch {
    trailers = undefined;
  }
  if (
    current.branch !== record.branch ||
    parent !== record.baseCommit ||
    canonicalJson(changed) !== canonicalJson(expected) ||
    trailers?.kind !== 'authority' ||
    trailers.changeId !== record.intent.changeId
  ) {
    throw planError(
      'AUTHORITY_PLAN_RECOVERY_INVALID',
      'Current HEAD is not the exact authority commit planned by this round.',
      ExitCode.guard,
    );
  }
  for (const mutation of record.intent.mutations) {
    assertResultBytes(repositoryRoot, mutation);
  }
  const grantId = trailers.grantId;
  const tagCandidates = runGit(repositoryRoot, [
    'for-each-ref',
    '--format=%(refname)',
    'refs/tags',
  ])
    .split('\n')
    .filter((ref) => ref.endsWith(grantId))
    .filter(
      (ref) => !ref.includes('application') && !ref.includes('attestation'),
    )
    .sort();
  const tagRef = tagCandidates[0] ?? `refs/tags/workflow-authority/${grantId}`;
  const basePolicy = parseMaintainerPolicy(
    JSON.parse(
      runGit(repositoryRoot, [
        'show',
        `${record.baseCommit}:workflow/maintainer-policy.json`,
      ]),
    ),
  );
  return {
    grantId,
    sessionId: null,
    commitHash: current.head,
    resultTree: current.tree,
    tagRef,
    publishCommand: authorityTagPublishCommand(
      basePolicy.repository.origin,
      tagRef,
    ),
    attestationRelayCommand: `pnpm workflow maintainer attestation-relay --original ${current.head} --json`,
    applicationReceiptTagRef: `refs/tags/workflow-authority-application/${grantId}`,
  };
}

function assertResultBytes(
  repositoryRoot: string,
  mutation: AuthorityPlanMutation,
): void {
  const target = path.join(repositoryRoot, mutation.path);
  const stats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (mutation.content === null) {
    if (stats !== undefined)
      throw planUnsafe('Deleted authority-plan path reappeared.');
    return;
  }
  if (
    !stats?.isFile() ||
    fs.readFileSync(target, 'utf8') !== mutation.content
  ) {
    throw planUnsafe(`Authority-plan result differs at ${mutation.path}.`);
  }
}

function listWorkingTreePaths(repositoryRoot: string): string[] {
  const tracked = runGit(repositoryRoot, [
    'diff',
    '--name-only',
    '--no-renames',
    'HEAD',
    '--',
  ])
    .split('\n')
    .filter(Boolean);
  const untracked = runGit(repositoryRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
  ])
    .split('\n')
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}

function assertRelay(
  record: AuthorityPlanRecord,
  relay: AuthorityAttestationRelayProjection,
): void {
  if (
    relay.grantId !== record.localApplication?.grantId ||
    relay.originalCommit !== record.localApplication.commitHash ||
    relay.originalCommit === relay.mainCommit ||
    !COMMIT_OID.test(relay.originalCommit) ||
    !COMMIT_OID.test(relay.mainCommit)
  ) {
    throw planUnsafe(
      'Attestation relay does not match the local authority result.',
    );
  }
}

function observeRemoteRef(repositoryRoot: string, ref: string): string | null {
  const line = runGit(
    repositoryRoot,
    ['ls-remote', '--refs', 'origin', ref],
    true,
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  if (line.length === 0) return null;
  if (line.length !== 1) throw planUnsafe('Remote authority ref is ambiguous.');
  const [oid, observedRef] = line[0]!.split('\t');
  if (!oid || !COMMIT_OID.test(oid) || observedRef !== ref) {
    throw planUnsafe('Remote authority ref is malformed.');
  }
  return oid;
}

function authorityPlanRuntime(
  repository: ReturnType<typeof discoverRepository>,
) {
  const config = loadWorkflowConfig(repository.repositoryRoot);
  return investigationRuntimePaths(
    repository.gitCommonDirectory,
    config.runtimeDirectory,
  );
}

function withPlanLock<T>(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  planId: string,
  operation: () => T,
): T {
  return withPrivateRuntimeLock(
    runtime,
    path.join(runtime.root, 'authority-plans', 'locks', `${planId}.lock`),
    operation,
    'AUTHORITY_PLAN_OPERATION_CONFLICT',
    planUnsafe,
  );
}

function appendRecord(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  value: Omit<AuthorityPlanRecord, 'recordDigest'>,
): AuthorityPlanRecord {
  const record: AuthorityPlanRecord = {
    ...structuredClone(value),
    recordDigest: digest({ schema: 'authority-plan-record.v1', record: value }),
  };
  createPrivateCanonicalJson(
    runtime,
    recordPath(runtime, record.planId, record.revision),
    record,
    planUnsafe,
    'AUTHORITY_PLAN_REVISION_CONFLICT',
  );
  return parseRecord(
    readPrivateCanonicalJson(
      runtime,
      recordPath(runtime, record.planId, record.revision),
      planUnsafe,
    ),
  );
}

function transition(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  current: AuthorityPlanRecord,
  patch: Partial<
    Pick<
      AuthorityPlanRecord,
      | 'state'
      | 'updatedAt'
      | 'localApplication'
      | 'relay'
      | 'attestation'
      | 'friction'
    >
  >,
): AuthorityPlanRecord {
  const { recordDigest: _currentRecordDigest, ...base } = current;
  return appendRecord(runtime, {
    ...base,
    ...structuredClone(patch),
    revision: current.revision + 1,
    previousRecordDigest: current.recordDigest,
  });
}

function readLatest(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  planId: string,
  allowMissing: boolean,
): AuthorityPlanRecord | null {
  const directory = path.join(
    runtime.root,
    'authority-plans',
    'records',
    planId,
  );
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (stats === undefined) return null;
  assertPrivateInvestigationDirectory(runtime, directory, planUnsafe);
  const names = fs.readdirSync(directory).sort();
  if (
    names.length < 1 ||
    names.length > MAX_REVISIONS ||
    names.some((name) => !REVISION_FILE.test(name))
  ) {
    throw planUnsafe('Authority plan revision inventory is malformed.');
  }
  let previous: AuthorityPlanRecord | null = null;
  for (const [index, name] of names.entries()) {
    const match = REVISION_FILE.exec(name)!;
    if (Number(match[1]) !== index + 1) {
      throw planUnsafe('Authority plan revision sequence is incomplete.');
    }
    const record = parseRecord(
      readPrivateCanonicalJson(runtime, path.join(directory, name), planUnsafe),
    );
    if (
      record.planId !== planId ||
      record.revision !== index + 1 ||
      record.previousRecordDigest !== (previous?.recordDigest ?? null) ||
      (previous !== null &&
        (record.createdAt !== previous.createdAt ||
          record.baseCommit !== previous.baseCommit ||
          record.baseTree !== previous.baseTree ||
          record.branch !== previous.branch ||
          record.intentDigest !== previous.intentDigest ||
          canonicalJson(record.intent) !== canonicalJson(previous.intent) ||
          canonicalJson(record.preview) !== canonicalJson(previous.preview)))
    ) {
      throw planUnsafe('Authority plan revision lineage is inconsistent.');
    }
    previous = record;
  }
  if (previous === null && !allowMissing) throw planUnsafe();
  return previous;
}

function requireLatest(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  planId: string,
): AuthorityPlanRecord {
  const record = readLatest(runtime, planId, false);
  if (record === null) {
    throw planError(
      'AUTHORITY_PLAN_NOT_FOUND',
      `Authority plan ${planId} does not exist.`,
      ExitCode.usage,
    );
  }
  return record;
}

function parseRecord(value: unknown): AuthorityPlanRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'planId',
      'revision',
      'previousRecordDigest',
      'recordDigest',
      'createdAt',
      'updatedAt',
      'state',
      'branch',
      'baseCommit',
      'baseTree',
      'intentDigest',
      'intent',
      'preview',
      'localApplication',
      'relay',
      'attestation',
      'friction',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'authority-plan-record.v1' ||
    typeof value.planId !== 'string' ||
    !PLAN_ID.test(value.planId) ||
    typeof value.revision !== 'number' ||
    !Number.isInteger(value.revision) ||
    value.revision < 1 ||
    (value.previousRecordDigest !== null &&
      (typeof value.previousRecordDigest !== 'string' ||
        !SHA256.test(value.previousRecordDigest))) ||
    typeof value.recordDigest !== 'string' ||
    !SHA256.test(value.recordDigest) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !isExactTime(value.createdAt) ||
    !isExactTime(value.updatedAt) ||
    !isManagedAuthorityPlanState(value.state) ||
    typeof value.branch !== 'string' ||
    typeof value.baseCommit !== 'string' ||
    !COMMIT_OID.test(value.baseCommit) ||
    typeof value.baseTree !== 'string' ||
    !COMMIT_OID.test(value.baseTree) ||
    typeof value.intentDigest !== 'string' ||
    !SHA256.test(value.intentDigest) ||
    !Array.isArray(value.preview) ||
    !isRecord(value.friction)
  ) {
    throw planUnsafe('Authority plan record is malformed.');
  }
  const intent = parseIntent(value.intent);
  const candidate = value as unknown as AuthorityPlanRecord;
  const { recordDigest, ...semantic } = candidate;
  if (
    digest(intent) !== value.intentDigest ||
    digest({ schema: 'authority-plan-record.v1', record: semantic }) !==
      recordDigest
  ) {
    throw planUnsafe('Authority plan record digest is invalid.');
  }
  return structuredClone(candidate);
}

function recordPath(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  planId: string,
  revision: number,
): string {
  return path.join(
    runtime.root,
    'authority-plans',
    'records',
    planId,
    `${revision.toString().padStart(6, '0')}.json`,
  );
}

function assertPlanId(value: string): string {
  if (!PLAN_ID.test(value)) {
    throw planError(
      'AUTHORITY_PLAN_ID_INVALID',
      'Authority plan ID is invalid.',
      ExitCode.usage,
    );
  }
  return value;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function assertJsonValue(value: unknown): unknown {
  canonicalJson(value);
  return value;
}

function digest(value: unknown): string {
  return digestBytes(canonicalJson(value));
}

function digestBytes(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function exactTime(now: Date | undefined): string {
  const value = now === undefined ? new Date() : new Date(now);
  if (!Number.isFinite(value.getTime()))
    throw planInvalid('Authority plan time is invalid.');
  return value.toISOString();
}

function isExactTime(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function planInvalid(message: string): WorkflowError {
  return planError('AUTHORITY_PLAN_INVALID', message, ExitCode.guard);
}

function planUnsafe(
  message = 'Authority plan durable state is unsafe.',
): WorkflowError {
  return planError(
    'AUTHORITY_PLAN_STORE_UNSAFE',
    message,
    ExitCode.unsafeEnvironment,
  );
}

function planError(
  code: string,
  message: string,
  exitCode: (typeof ExitCode)[keyof typeof ExitCode],
): WorkflowError {
  return workflowError(code, message, exitCode);
}
