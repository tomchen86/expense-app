import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import { normalizePolicyPath } from './paths.ts';
import {
  parseTaskDiffReviewSubject,
  TASK_DIFF_REVIEW_COVERAGE,
  type TaskDiffReviewSubject,
} from './task-diff-review.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_FINDINGS = 128;
const MAX_EVIDENCE = 64;

const VERDICTS = new Set(['advisory-approve', 'advisory-reject']);
const SEVERITIES = new Set([
  'critical',
  'high',
  'medium',
  'low',
  'informational',
]);
const CATEGORIES = new Set<string>(TASK_DIFF_REVIEW_COVERAGE);
const DISPOSITIONS = new Set(['accepted', 'rebutted', 'withdrawn']);

export type TaskDiffReviewVerdict = 'advisory-approve' | 'advisory-reject';
export type TaskDiffReviewSeverity =
  'critical' | 'high' | 'medium' | 'low' | 'informational';

export type TaskDiffReviewEvidence =
  | Readonly<{
      kind: 'repository-location';
      path: string;
      line: number;
      blobObjectId: string;
      observation: string;
    }>
  | Readonly<{
      kind: 'check-report';
      reportId: string;
      checkId: string;
      observation: string;
    }>
  | Readonly<{
      kind: 'planning-node';
      nodeId: string;
      resultDigest: string;
      observation: string;
    }>;

export type TaskDiffReviewFinding = Readonly<{
  kind: 'challenge';
  severity: TaskDiffReviewSeverity;
  category: (typeof TASK_DIFF_REVIEW_COVERAGE)[number];
  currentChangeImpact: 'required';
  summary: string;
  evidence: readonly TaskDiffReviewEvidence[];
}>;

export type TaskDiffReviewSuggestion = Readonly<{
  kind: 'suggestion';
  severity: TaskDiffReviewSeverity;
  category: (typeof TASK_DIFF_REVIEW_COVERAGE)[number];
  currentChangeImpact: 'independent-follow-up';
  summary: string;
  evidence: readonly TaskDiffReviewEvidence[];
}>;

export type TaskDiffReviewSubmission = Readonly<{
  schemaVersion: 1;
  verdict: TaskDiffReviewVerdict;
  coverage: readonly string[];
  scopeAssessment:
    | Readonly<{ kind: 'challenges' }>
    | Readonly<{
        kind: 'no-challenge';
        evidence: readonly TaskDiffReviewEvidence[];
      }>;
  findings: readonly TaskDiffReviewFinding[];
  suggestions: readonly TaskDiffReviewSuggestion[];
  residualRisk: string;
  uncertainty: string;
}>;

export type TaskDiffReviewAssignment = Readonly<{
  implementerPrincipalId: string;
  implementerProviderId: string;
  implementationSessionId: string;
  reviewerPrincipalId: string;
  reviewerProviderId: string;
  reviewerSessionId: string;
  achievedIndependence: 'provider-independent';
}>;

export type StoredTaskDiffReviewChallenge = TaskDiffReviewFinding &
  Readonly<{
    challengeId: string;
    raisedBy: string;
  }>;

export type StoredTaskDiffReviewSuggestion = TaskDiffReviewSuggestion &
  Readonly<{
    suggestionId: string;
  }>;

export type TaskDiffReviewRecord = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-record.v1';
  recordDigest: string;
  subject: TaskDiffReviewSubject;
  subjectDigest: string;
  assignment: TaskDiffReviewAssignment;
  verdict: TaskDiffReviewVerdict;
  coverage: typeof TASK_DIFF_REVIEW_COVERAGE;
  scopeAssessment:
    | Readonly<{ kind: 'challenges' }>
    | Readonly<{
        kind: 'no-challenge';
        evidence: readonly TaskDiffReviewEvidence[];
      }>;
  challenges: readonly StoredTaskDiffReviewChallenge[];
  suggestions: readonly StoredTaskDiffReviewSuggestion[];
  residualRisk: string;
  uncertainty: string;
}>;

export type CreateTaskDiffReviewRecordInput = Readonly<{
  subject: TaskDiffReviewSubject;
  assignment: TaskDiffReviewAssignment;
  submission: TaskDiffReviewSubmission;
}>;

export type TaskDiffReviewDisposition = 'accepted' | 'rebutted' | 'withdrawn';

export type TaskDiffReviewDispositionEntry = Readonly<{
  challengeId: string;
  disposition: TaskDiffReviewDisposition;
  rationale: string;
  closedBy: string;
}>;

export type TaskDiffReviewDispositionRecord = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-disposition.v1';
  dispositionDigest: string;
  reviewRecordDigest: string;
  subjectDigest: string;
  entries: readonly TaskDiffReviewDispositionEntry[];
}>;

export function createTaskDiffReviewRecord(
  input: CreateTaskDiffReviewRecordInput,
): TaskDiffReviewRecord {
  const subject = parseTaskDiffReviewSubject(input.subject);
  const assignment = parseAssignment(input.assignment);
  const submission = normalizeSubmission(input.submission, assignment);
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-review-record.v1' as const,
    subject,
    subjectDigest: subject.subjectDigest,
    assignment,
    verdict: submission.verdict,
    coverage: TASK_DIFF_REVIEW_COVERAGE,
    scopeAssessment: submission.scopeAssessment,
    challenges: submission.challenges,
    suggestions: submission.suggestions,
    residualRisk: submission.residualRisk,
    uncertainty: submission.uncertainty,
  };
  return parseTaskDiffReviewRecord({
    ...body,
    recordDigest: sha256(canonicalJson(body)),
  });
}

export function parseTaskDiffReviewRecord(
  value: unknown,
): TaskDiffReviewRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'recordDigest',
      'subject',
      'subjectDigest',
      'assignment',
      'verdict',
      'coverage',
      'scopeAssessment',
      'challenges',
      'suggestions',
      'residualRisk',
      'uncertainty',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-record.v1'
  ) {
    throw recordInvalid();
  }
  const subject = parseSubjectForRecord(value.subject);
  const assignment = parseAssignment(value.assignment);
  const verdict = parseVerdict(value.verdict);
  const coverage = parseCoverage(value.coverage);
  const challenges = parseStoredChallenges(value.challenges, assignment);
  const suggestions = parseStoredSuggestions(value.suggestions);
  const scopeAssessment = parseScopeAssessment(
    value.scopeAssessment,
    challenges.length,
  );
  const record: TaskDiffReviewRecord = {
    schemaVersion: 1,
    kind: 'task-diff-review-record.v1',
    recordDigest: parseDigest(value.recordDigest),
    subject,
    subjectDigest: parseDigest(value.subjectDigest),
    assignment,
    verdict,
    coverage,
    scopeAssessment,
    challenges,
    suggestions,
    residualRisk: boundedText(value.residualRisk),
    uncertainty: boundedText(value.uncertainty),
  };
  if (
    record.subjectDigest !== subject.subjectDigest ||
    record.recordDigest !== sha256(canonicalJson(withoutRecordDigest(record)))
  ) {
    throw recordInvalid();
  }
  return deepFreeze(record);
}

export function createTaskDiffReviewDispositionRecord(input: {
  review: TaskDiffReviewRecord;
  entries: readonly TaskDiffReviewDispositionEntry[];
}): TaskDiffReviewDispositionRecord {
  const review = parseTaskDiffReviewRecord(input.review);
  const entries = normalizeDispositionEntries(input.entries);
  assertDispositionAuthority(review, entries);
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-review-disposition.v1' as const,
    reviewRecordDigest: review.recordDigest,
    subjectDigest: review.subjectDigest,
    entries,
  };
  return parseTaskDiffReviewDispositionRecord({
    ...body,
    dispositionDigest: sha256(canonicalJson(body)),
  });
}

export function parseTaskDiffReviewDispositionRecord(
  value: unknown,
): TaskDiffReviewDispositionRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'dispositionDigest',
      'reviewRecordDigest',
      'subjectDigest',
      'entries',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-disposition.v1'
  ) {
    throw dispositionInvalid();
  }
  const record: TaskDiffReviewDispositionRecord = {
    schemaVersion: 1,
    kind: 'task-diff-review-disposition.v1',
    dispositionDigest: parseDispositionDigest(value.dispositionDigest),
    reviewRecordDigest: parseDispositionDigest(value.reviewRecordDigest),
    subjectDigest: parseDispositionDigest(value.subjectDigest),
    entries: normalizeDispositionEntries(
      value.entries as readonly TaskDiffReviewDispositionEntry[],
    ),
  };
  if (
    record.dispositionDigest !==
    sha256(canonicalJson(withoutDispositionDigest(record)))
  ) {
    throw dispositionInvalid();
  }
  return deepFreeze(record);
}

/**
 * Validate the content-level review gate for one exact subject.
 *
 * Assignment identities in this value object are not authentication. A
 * production caller must first bind the record to a verified provider result
 * or a separately signed human exception before this content assertion can
 * authorize a lifecycle transition.
 */
export function assertTaskDiffReviewContentSatisfied(
  candidate: TaskDiffReviewSubject,
  reviewCandidate: TaskDiffReviewRecord,
  dispositionCandidate: TaskDiffReviewDispositionRecord | null,
): TaskDiffReviewRecord {
  const subject = parseTaskDiffReviewSubject(candidate);
  const review = parseTaskDiffReviewRecord(reviewCandidate);
  if (
    review.subjectDigest !== subject.subjectDigest ||
    canonicalJson(review.subject) !== canonicalJson(subject)
  ) {
    throw workflowError(
      'TASK_DIFF_REVIEW_STALE',
      'TaskDiffReview does not cover the current canonical subject.',
      ExitCode.staleState,
    );
  }
  if (review.challenges.length === 0) {
    if (dispositionCandidate !== null) throw dispositionInvalid();
    return review;
  }
  if (dispositionCandidate === null) {
    throw workflowError(
      'TASK_DIFF_REVIEW_CHALLENGE_OPEN',
      'TaskDiffReview contains challenges without a current disposition.',
      ExitCode.verification,
      {
        details: {
          challengeIds: review.challenges.map(({ challengeId }) => challengeId),
        },
      },
    );
  }
  const disposition =
    parseTaskDiffReviewDispositionRecord(dispositionCandidate);
  if (
    disposition.reviewRecordDigest !== review.recordDigest ||
    disposition.subjectDigest !== subject.subjectDigest
  ) {
    throw dispositionInvalid();
  }
  assertDispositionAuthority(review, disposition.entries);
  const challengeIds = review.challenges
    .map(({ challengeId }) => challengeId)
    .sort();
  if (
    canonicalJson(disposition.entries.map(({ challengeId }) => challengeId)) !==
    canonicalJson(challengeIds)
  ) {
    throw workflowError(
      'TASK_DIFF_REVIEW_CHALLENGE_OPEN',
      'TaskDiffReview challenge dispositions are incomplete.',
      ExitCode.verification,
    );
  }
  if (
    disposition.entries.some(
      ({ disposition: decision }) => decision === 'accepted',
    )
  ) {
    throw workflowError(
      'TASK_DIFF_REVIEW_CHALLENGE_ACCEPTED',
      'An accepted TaskDiffReview challenge requires a new implementation subject and review.',
      ExitCode.verification,
    );
  }
  return review;
}

function normalizeSubmission(
  value: TaskDiffReviewSubmission,
  assignment: TaskDiffReviewAssignment,
) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'verdict',
      'coverage',
      'scopeAssessment',
      'findings',
      'suggestions',
      'residualRisk',
      'uncertainty',
    ]) ||
    value.schemaVersion !== 1
  ) {
    throw recordInvalid();
  }
  const verdict = parseVerdict(value.verdict);
  parseCoverage(value.coverage);
  const challenges = normalizeSubmittedFindings(
    value.findings,
    assignment.reviewerPrincipalId,
  );
  const suggestions = normalizeSubmittedSuggestions(value.suggestions);
  return {
    verdict,
    scopeAssessment: parseScopeAssessment(
      value.scopeAssessment,
      challenges.length,
    ),
    challenges,
    suggestions,
    residualRisk: boundedText(value.residualRisk),
    uncertainty: boundedText(value.uncertainty),
  };
}

function parseAssignment(value: unknown): TaskDiffReviewAssignment {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'implementerPrincipalId',
      'implementerProviderId',
      'implementationSessionId',
      'reviewerPrincipalId',
      'reviewerProviderId',
      'reviewerSessionId',
      'achievedIndependence',
    ]) ||
    value.achievedIndependence !== 'provider-independent'
  ) {
    throw independenceInvalid();
  }
  const assignment: TaskDiffReviewAssignment = {
    implementerPrincipalId: identity(value.implementerPrincipalId),
    implementerProviderId: identity(value.implementerProviderId),
    implementationSessionId: identity(value.implementationSessionId),
    reviewerPrincipalId: identity(value.reviewerPrincipalId),
    reviewerProviderId: identity(value.reviewerProviderId),
    reviewerSessionId: identity(value.reviewerSessionId),
    achievedIndependence: 'provider-independent',
  };
  if (
    assignment.implementerProviderId === assignment.reviewerProviderId ||
    assignment.implementerPrincipalId === assignment.reviewerPrincipalId ||
    assignment.implementationSessionId === assignment.reviewerSessionId
  ) {
    throw independenceInvalid();
  }
  return Object.freeze(assignment);
}

function normalizeSubmittedFindings(
  value: unknown,
  reviewerPrincipalId: string,
): readonly StoredTaskDiffReviewChallenge[] {
  if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
    throw recordInvalid();
  }
  const challenges = value.map((entry) => {
    const finding = parseFinding(entry, 'challenge');
    const body = { ...finding, raisedBy: reviewerPrincipalId };
    return Object.freeze({
      ...body,
      challengeId: sha256(canonicalJson(body)),
    });
  });
  return canonicalObjects(challenges, 'challengeId');
}

function normalizeSubmittedSuggestions(
  value: unknown,
): readonly StoredTaskDiffReviewSuggestion[] {
  if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
    throw recordInvalid();
  }
  const suggestions = value.map((entry) => {
    const suggestion = parseFinding(entry, 'suggestion');
    return Object.freeze({
      ...suggestion,
      suggestionId: sha256(canonicalJson(suggestion)),
    });
  });
  return canonicalObjects(suggestions, 'suggestionId');
}

function parseStoredChallenges(
  value: unknown,
  assignment: TaskDiffReviewAssignment,
): readonly StoredTaskDiffReviewChallenge[] {
  if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
    throw recordInvalid();
  }
  const challenges = value.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        'kind',
        'severity',
        'category',
        'currentChangeImpact',
        'summary',
        'evidence',
        'raisedBy',
        'challengeId',
      ]) ||
      entry.raisedBy !== assignment.reviewerPrincipalId
    ) {
      throw recordInvalid();
    }
    const finding = parseFinding(findingProjection(entry), 'challenge');
    const body = { ...finding, raisedBy: assignment.reviewerPrincipalId };
    const challengeId = parseDigest(entry.challengeId);
    if (challengeId !== sha256(canonicalJson(body))) throw recordInvalid();
    return Object.freeze({ ...body, challengeId });
  });
  return canonicalObjects(challenges, 'challengeId');
}

function parseStoredSuggestions(
  value: unknown,
): readonly StoredTaskDiffReviewSuggestion[] {
  if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
    throw recordInvalid();
  }
  const suggestions = value.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        'kind',
        'severity',
        'category',
        'currentChangeImpact',
        'summary',
        'evidence',
        'suggestionId',
      ])
    ) {
      throw recordInvalid();
    }
    const suggestion = parseFinding(findingProjection(entry), 'suggestion');
    const suggestionId = parseDigest(entry.suggestionId);
    if (suggestionId !== sha256(canonicalJson(suggestion))) {
      throw recordInvalid();
    }
    return Object.freeze({ ...suggestion, suggestionId });
  });
  return canonicalObjects(suggestions, 'suggestionId');
}

function parseFinding(
  value: unknown,
  expectedKind: 'challenge',
): TaskDiffReviewFinding;
function parseFinding(
  value: unknown,
  expectedKind: 'suggestion',
): TaskDiffReviewSuggestion;
function parseFinding(
  value: unknown,
  expectedKind: 'challenge' | 'suggestion',
): TaskDiffReviewFinding | TaskDiffReviewSuggestion {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'kind',
      'severity',
      'category',
      'currentChangeImpact',
      'summary',
      'evidence',
    ]) ||
    value.kind !== expectedKind ||
    !SEVERITIES.has(String(value.severity)) ||
    !CATEGORIES.has(String(value.category)) ||
    (expectedKind === 'challenge'
      ? value.currentChangeImpact !== 'required'
      : value.currentChangeImpact !== 'independent-follow-up')
  ) {
    throw recordInvalid();
  }
  const common = {
    severity: value.severity as TaskDiffReviewSeverity,
    category: value.category as (typeof TASK_DIFF_REVIEW_COVERAGE)[number],
    summary: boundedText(value.summary),
    evidence: normalizeEvidence(value.evidence, true),
  };
  return expectedKind === 'challenge'
    ? Object.freeze({
        ...common,
        kind: 'challenge' as const,
        currentChangeImpact: 'required' as const,
      })
    : Object.freeze({
        ...common,
        kind: 'suggestion' as const,
        currentChangeImpact: 'independent-follow-up' as const,
      });
}

function findingProjection(value: Record<string, unknown>) {
  return {
    kind: value.kind,
    severity: value.severity,
    category: value.category,
    currentChangeImpact: value.currentChangeImpact,
    summary: value.summary,
    evidence: value.evidence,
  };
}

function parseScopeAssessment(value: unknown, challengeCount: number) {
  if (!isRecord(value) || value.kind === 'challenges') {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['kind']) ||
      value.kind !== 'challenges' ||
      challengeCount === 0
    ) {
      throw recordInvalid();
    }
    return Object.freeze({ kind: 'challenges' as const });
  }
  if (
    !hasExactKeys(value, ['kind', 'evidence']) ||
    value.kind !== 'no-challenge' ||
    challengeCount !== 0
  ) {
    throw recordInvalid();
  }
  return Object.freeze({
    kind: 'no-challenge' as const,
    evidence: normalizeEvidence(value.evidence, true),
  });
}

function normalizeEvidence(
  value: unknown,
  requireNonEmpty: boolean,
): readonly TaskDiffReviewEvidence[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_EVIDENCE ||
    (requireNonEmpty && value.length === 0)
  ) {
    throw recordInvalid();
  }
  const evidence = value.map((entry): TaskDiffReviewEvidence => {
    if (!isRecord(entry) || typeof entry.kind !== 'string') {
      throw recordInvalid();
    }
    if (entry.kind === 'repository-location') {
      if (
        !hasExactKeys(entry, [
          'kind',
          'path',
          'line',
          'blobObjectId',
          'observation',
        ]) ||
        !Number.isSafeInteger(entry.line) ||
        Number(entry.line) < 1 ||
        Number(entry.line) > 10_000_000 ||
        typeof entry.blobObjectId !== 'string' ||
        !OBJECT_ID.test(entry.blobObjectId)
      ) {
        throw recordInvalid();
      }
      return Object.freeze({
        kind: 'repository-location',
        path: exactPath(entry.path),
        line: Number(entry.line),
        blobObjectId: entry.blobObjectId,
        observation: boundedText(entry.observation),
      });
    }
    if (entry.kind === 'check-report') {
      if (
        !hasExactKeys(entry, ['kind', 'reportId', 'checkId', 'observation'])
      ) {
        throw recordInvalid();
      }
      return Object.freeze({
        kind: 'check-report',
        reportId: parseDigest(entry.reportId),
        checkId: identity(entry.checkId),
        observation: boundedText(entry.observation),
      });
    }
    if (entry.kind === 'planning-node') {
      if (
        !hasExactKeys(entry, ['kind', 'nodeId', 'resultDigest', 'observation'])
      ) {
        throw recordInvalid();
      }
      return Object.freeze({
        kind: 'planning-node',
        nodeId: parseDigest(entry.nodeId),
        resultDigest: parseDigest(entry.resultDigest),
        observation: boundedText(entry.observation),
      });
    }
    throw recordInvalid();
  });
  const canonical = evidence.sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
  if (
    canonical.some(
      (entry, index) =>
        index > 0 &&
        canonicalJson(entry) === canonicalJson(canonical[index - 1]),
    )
  ) {
    throw recordInvalid();
  }
  return Object.freeze(canonical);
}

function normalizeDispositionEntries(
  value: readonly TaskDiffReviewDispositionEntry[],
): readonly TaskDiffReviewDispositionEntry[] {
  if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
    throw dispositionInvalid();
  }
  const entries = value.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        'challengeId',
        'disposition',
        'rationale',
        'closedBy',
      ]) ||
      !DISPOSITIONS.has(String(entry.disposition))
    ) {
      throw dispositionInvalid();
    }
    return Object.freeze({
      challengeId: parseDispositionDigest(entry.challengeId),
      disposition: entry.disposition as TaskDiffReviewDisposition,
      rationale: boundedDispositionText(entry.rationale),
      closedBy: dispositionIdentity(entry.closedBy),
    });
  });
  entries.sort((left, right) =>
    left.challengeId.localeCompare(right.challengeId),
  );
  if (
    entries.some(
      (entry, index) =>
        index > 0 && entry.challengeId === entries[index - 1]!.challengeId,
    )
  ) {
    throw dispositionInvalid();
  }
  return Object.freeze(entries);
}

function assertDispositionAuthority(
  review: TaskDiffReviewRecord,
  entries: readonly TaskDiffReviewDispositionEntry[],
): void {
  const challengeIds = new Set(
    review.challenges.map(({ challengeId }) => challengeId),
  );
  for (const entry of entries) {
    if (
      !challengeIds.has(entry.challengeId) ||
      entry.closedBy === review.assignment.implementerPrincipalId ||
      entry.closedBy !== review.assignment.reviewerPrincipalId
    ) {
      throw dispositionInvalid();
    }
  }
}

function parseCoverage(value: unknown): typeof TASK_DIFF_REVIEW_COVERAGE {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string') ||
    new Set(value).size !== TASK_DIFF_REVIEW_COVERAGE.length ||
    [...value].sort().join('\0') !==
      [...TASK_DIFF_REVIEW_COVERAGE].sort().join('\0')
  ) {
    throw recordInvalid();
  }
  return TASK_DIFF_REVIEW_COVERAGE;
}

function parseVerdict(value: unknown): TaskDiffReviewVerdict {
  if (!VERDICTS.has(String(value))) throw recordInvalid();
  return value as TaskDiffReviewVerdict;
}

function parseSubjectForRecord(value: unknown): TaskDiffReviewSubject {
  try {
    return parseTaskDiffReviewSubject(value);
  } catch {
    throw recordInvalid();
  }
}

function canonicalObjects<T extends Record<K, string>, K extends keyof T>(
  value: T[],
  key: K,
): readonly T[] {
  value.sort((left, right) => left[key].localeCompare(right[key]));
  if (
    value.some(
      (entry, index) => index > 0 && entry[key] === value[index - 1]![key],
    )
  ) {
    throw recordInvalid();
  }
  return Object.freeze(value);
}

function withoutRecordDigest(
  record: TaskDiffReviewRecord,
): Omit<TaskDiffReviewRecord, 'recordDigest'> {
  const { recordDigest: _recordDigest, ...body } = record;
  return body;
}

function withoutDispositionDigest(
  record: TaskDiffReviewDispositionRecord,
): Omit<TaskDiffReviewDispositionRecord, 'dispositionDigest'> {
  const { dispositionDigest: _dispositionDigest, ...body } = record;
  return body;
}

function exactPath(value: unknown): string {
  if (typeof value !== 'string') throw recordInvalid();
  let normalized: string;
  try {
    normalized = normalizePolicyPath(value);
  } catch {
    throw recordInvalid();
  }
  if (normalized !== value || normalized.endsWith('/**')) {
    throw recordInvalid();
  }
  return normalized;
}

function boundedText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    Buffer.byteLength(value) > MAX_TEXT_BYTES
  ) {
    throw recordInvalid();
  }
  return value;
}

function boundedDispositionText(value: unknown): string {
  try {
    return boundedText(value);
  } catch {
    throw dispositionInvalid();
  }
}

function identity(value: unknown): string {
  if (typeof value !== 'string' || !IDENTITY.test(value)) {
    throw recordInvalid();
  }
  return value;
}

function dispositionIdentity(value: unknown): string {
  if (typeof value !== 'string' || !IDENTITY.test(value)) {
    throw dispositionInvalid();
  }
  return value;
}

function parseDigest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw recordInvalid();
  }
  return value;
}

function parseDispositionDigest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw dispositionInvalid();
  }
  return value;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordInvalid() {
  return workflowError(
    'TASK_DIFF_REVIEW_RECORD_INVALID',
    'TaskDiffReview record is malformed or not canonically bound.',
    ExitCode.staleState,
  );
}

function dispositionInvalid() {
  return workflowError(
    'TASK_DIFF_REVIEW_DISPOSITION_INVALID',
    'TaskDiffReview disposition is malformed or lacks independent authority.',
    ExitCode.guard,
  );
}

function independenceInvalid() {
  return workflowError(
    'TASK_DIFF_REVIEW_INDEPENDENCE_INVALID',
    'TaskDiffReview requires a fresh provider-independent reviewer assignment.',
    ExitCode.guard,
  );
}
