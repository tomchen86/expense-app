import crypto from 'node:crypto';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { normalizePolicyPath } from "../../runtime/session-workspace/paths.js";
import { assertAuthorizedReviewChallengeClosure, } from "./review-challenge.js";
import { deriveTaskDiffReviewCandidatePlan, parseTaskDiffReviewScope, parseTaskDiffReviewSubject, taskDiffReviewCandidateIdentityDigest, TASK_DIFF_REVIEW_COVERAGE, } from "./task-diff-review.js";
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
const CATEGORIES = new Set(TASK_DIFF_REVIEW_COVERAGE);
const DISPOSITIONS = new Set(['accepted', 'rebutted', 'withdrawn']);
const RISK_PATH_ROLES = Object.freeze([
    'control-plane',
    'grant',
    'lifecycle',
    'policy',
    'verification-infrastructure',
    'contract-surface',
    'unregistered',
]);
const RISK_PATH_OUTCOMES = Object.freeze([
    'no-challenge',
    'challenge-raised',
]);
const RISK_PATH_ROLE_SET = new Set(RISK_PATH_ROLES);
const RISK_PATH_OUTCOME_SET = new Set(RISK_PATH_OUTCOMES);
const CONTINUATION_DECISIONS = new Set([
    'accepted',
    'rebutted',
    'superseded',
    'withdrawn',
    'waived',
]);
const TASK_DIFF_REVIEW_OUTPUT_SCHEMA_ID = 'expense-app.workflow.task-diff-review-output';
const TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA_ID = 'expense-app.workflow.task-diff-review-continuation-output';
export const TASK_DIFF_REVIEW_LIMITS = Object.freeze({
    maxTextBytes: MAX_TEXT_BYTES,
    maxFindings: MAX_FINDINGS,
    maxEvidence: MAX_EVIDENCE,
});
/**
 * Code-owned provider-facing grammar for one exact-diff review submission.
 * The JSON schema gives provider CLIs the structural contract; the bound
 * validator below additionally enforces canonical coverage, exact evidence
 * forms, duplicate rejection, byte ceilings, and challenge/scope agreement.
 */
export const TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: [
        'schemaVersion',
        'verdict',
        'coverage',
        'scopeAssessment',
        'findings',
        'suggestions',
        'riskPathDispositions',
        'residualRisk',
        'uncertainty',
    ],
    properties: {
        schemaVersion: { type: 'integer', const: 1 },
        verdict: { enum: [...VERDICTS] },
        coverage: {
            type: 'array',
            minItems: TASK_DIFF_REVIEW_COVERAGE.length,
            maxItems: TASK_DIFF_REVIEW_COVERAGE.length,
            items: { enum: [...TASK_DIFF_REVIEW_COVERAGE] },
        },
        scopeAssessment: {
            anyOf: [
                {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind'],
                    properties: { kind: { type: 'string', const: 'challenges' } },
                },
                {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'evidence'],
                    properties: {
                        kind: { type: 'string', const: 'no-challenge' },
                        evidence: {
                            type: 'array',
                            minItems: 1,
                            maxItems: MAX_EVIDENCE,
                            items: { $ref: '#/$defs/evidence' },
                        },
                    },
                },
            ],
        },
        findings: {
            type: 'array',
            maxItems: MAX_FINDINGS,
            items: { $ref: '#/$defs/challenge' },
        },
        suggestions: {
            type: 'array',
            maxItems: MAX_FINDINGS,
            items: { $ref: '#/$defs/suggestion' },
        },
        riskPathDispositions: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['path', 'role', 'outcome'],
                properties: {
                    path: { type: 'string', minLength: 1 },
                    role: { enum: [...RISK_PATH_ROLES] },
                    outcome: { enum: [...RISK_PATH_OUTCOMES] },
                },
            },
        },
        residualRisk: { type: 'string', minLength: 1 },
        uncertainty: { type: 'string', minLength: 1 },
        documentationAssessment: {
            anyOf: [
                {
                    type: 'object',
                    additionalProperties: false,
                    required: ['decision', 'paths', 'notes'],
                    properties: {
                        decision: { type: 'string', const: 'updated' },
                        paths: {
                            type: 'array',
                            minItems: 1,
                            items: { type: 'string', minLength: 1 },
                        },
                        notes: { type: 'string', minLength: 1 },
                    },
                },
                {
                    type: 'object',
                    additionalProperties: false,
                    required: ['decision', 'notes'],
                    properties: {
                        decision: { type: 'string', const: 'no-impact' },
                        notes: { type: 'string', minLength: 1 },
                    },
                },
                {
                    type: 'object',
                    additionalProperties: false,
                    required: ['decision', 'sources', 'generated', 'evidence', 'notes'],
                    properties: {
                        decision: { type: 'string', const: 'generated-verified' },
                        sources: {
                            type: 'array',
                            minItems: 1,
                            items: { type: 'string', minLength: 1 },
                        },
                        generated: {
                            type: 'array',
                            minItems: 1,
                            items: { type: 'string', minLength: 1 },
                        },
                        evidence: {
                            type: 'array',
                            minItems: 1,
                            items: { type: 'string', minLength: 1 },
                        },
                        notes: { type: 'string', minLength: 1 },
                    },
                },
                {
                    type: 'object',
                    additionalProperties: false,
                    required: ['decision', 'requiredPaths', 'notes'],
                    properties: {
                        decision: { type: 'string', const: 'needs-changes' },
                        requiredPaths: {
                            type: 'array',
                            minItems: 1,
                            items: { type: 'string', minLength: 1 },
                        },
                        notes: { type: 'string', minLength: 1 },
                    },
                },
            ],
        },
    },
    $defs: {
        evidence: {
            anyOf: [
                {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'path', 'line', 'blobObjectId', 'observation'],
                    properties: {
                        kind: { type: 'string', const: 'repository-location' },
                        path: { type: 'string', minLength: 1 },
                        line: { type: 'integer', minimum: 1 },
                        blobObjectId: {
                            type: 'string',
                            pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$',
                        },
                        observation: { type: 'string', minLength: 1 },
                    },
                },
                {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'reportId', 'checkId', 'observation'],
                    properties: {
                        kind: { type: 'string', const: 'check-report' },
                        reportId: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                        checkId: { type: 'string', minLength: 1 },
                        observation: { type: 'string', minLength: 1 },
                    },
                },
                {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'nodeId', 'resultDigest', 'observation'],
                    properties: {
                        kind: { type: 'string', const: 'planning-node' },
                        nodeId: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                        resultDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                        observation: { type: 'string', minLength: 1 },
                    },
                },
            ],
        },
        challenge: {
            type: 'object',
            additionalProperties: false,
            required: [
                'kind',
                'severity',
                'category',
                'currentChangeImpact',
                'summary',
                'evidence',
            ],
            properties: {
                kind: { type: 'string', const: 'challenge' },
                severity: { enum: [...SEVERITIES] },
                category: { enum: [...TASK_DIFF_REVIEW_COVERAGE] },
                currentChangeImpact: { type: 'string', const: 'required' },
                summary: { type: 'string', minLength: 1 },
                evidence: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_EVIDENCE,
                    items: { $ref: '#/$defs/evidence' },
                },
            },
        },
        suggestion: {
            type: 'object',
            additionalProperties: false,
            required: [
                'kind',
                'severity',
                'category',
                'currentChangeImpact',
                'summary',
                'evidence',
            ],
            properties: {
                kind: { type: 'string', const: 'suggestion' },
                severity: { enum: [...SEVERITIES] },
                category: { enum: [...TASK_DIFF_REVIEW_COVERAGE] },
                currentChangeImpact: {
                    type: 'string',
                    const: 'independent-follow-up',
                },
                summary: { type: 'string', minLength: 1 },
                evidence: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_EVIDENCE,
                    items: { $ref: '#/$defs/evidence' },
                },
            },
        },
    },
});
const TASK_DIFF_REVIEW_OUTPUT_SCHEMA_DIGEST = sha256(canonicalJson(TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA));
export const TASK_DIFF_REVIEW_OUTPUT_SCHEMA = Object.freeze({
    id: TASK_DIFF_REVIEW_OUTPUT_SCHEMA_ID,
    version: 1,
    digest: TASK_DIFF_REVIEW_OUTPUT_SCHEMA_DIGEST,
});
export const TASK_DIFF_REVIEW_OUTPUT_VALIDATOR = Object.freeze({
    id: TASK_DIFF_REVIEW_OUTPUT_SCHEMA_ID,
    version: 1,
    digest: TASK_DIFF_REVIEW_OUTPUT_SCHEMA_DIGEST,
    validate(value) {
        try {
            parseTaskDiffReviewSubmission(value);
            return true;
        }
        catch {
            return false;
        }
    },
});
/**
 * Provider-facing continuation evidence. These are recommendations only: the
 * engine must authenticate the fixed-runner reviewer and pass the proposal
 * through the shared challenge-closure verifier before it can mint authority.
 */
export const TASK_DIFF_REVIEW_CONTINUATION_PROVIDER_OUTPUT_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: [
        'schemaVersion',
        'reviewRecordDigest',
        'responseDigest',
        'proposedDispositions',
    ],
    properties: {
        schemaVersion: { type: 'integer', const: 1 },
        reviewRecordDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        responseDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        proposedDispositions: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_FINDINGS,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['challengeId', 'decision', 'rationale', 'supersededBy'],
                properties: {
                    challengeId: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                    decision: { enum: [...CONTINUATION_DECISIONS] },
                    rationale: { type: 'string', minLength: 1 },
                    supersededBy: {
                        anyOf: [
                            { type: 'null' },
                            { type: 'string', pattern: '^[0-9a-f]{64}$' },
                        ],
                    },
                },
            },
        },
    },
});
const TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA_DIGEST = sha256(canonicalJson(TASK_DIFF_REVIEW_CONTINUATION_PROVIDER_OUTPUT_SCHEMA));
export const TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA = Object.freeze({
    id: TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA_ID,
    version: 1,
    digest: TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA_DIGEST,
});
export const TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR = Object.freeze({
    ...TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
    validate(value) {
        try {
            parseTaskDiffReviewContinuationSubmission(value);
            return true;
        }
        catch {
            return false;
        }
    },
});
export function createTaskDiffReviewRecord(input) {
    const subject = parseTaskDiffReviewSubject(input.subject);
    const defaultPlan = deriveTaskDiffReviewCandidatePlan({ current: subject });
    if (defaultPlan.action !== 'review')
        throw recordInvalid();
    const reviewScope = assertReviewScopeCurrent(subject, input.reviewScope ?? defaultPlan.scope);
    const assignment = parseAssignment(input.assignment);
    const submission = normalizeSubmission(input.submission, assignment, subject, reviewScope);
    const body = {
        schemaVersion: 1,
        kind: 'task-diff-review-record.v1',
        subject,
        subjectDigest: subject.subjectDigest,
        reviewScope,
        assignment,
        verdict: submission.verdict,
        coverage: TASK_DIFF_REVIEW_COVERAGE,
        scopeAssessment: submission.scopeAssessment,
        challenges: submission.challenges,
        suggestions: submission.suggestions,
        riskPathDispositions: submission.riskPathDispositions,
        residualRisk: submission.residualRisk,
        uncertainty: submission.uncertainty,
        ...(submission.documentationAssessment === undefined
            ? {}
            : { documentationAssessment: submission.documentationAssessment }),
    };
    return parseTaskDiffReviewRecord({
        ...body,
        recordDigest: sha256(canonicalJson(body)),
    });
}
export function parseTaskDiffReviewRecord(value) {
    const legacyKeys = [
        'schemaVersion',
        'kind',
        'recordDigest',
        'subject',
        'subjectDigest',
        'reviewScope',
        'assignment',
        'verdict',
        'coverage',
        'scopeAssessment',
        'challenges',
        'suggestions',
        'riskPathDispositions',
        'residualRisk',
        'uncertainty',
    ];
    if (!isRecord(value) ||
        (!hasExactKeys(value, legacyKeys) &&
            !hasExactKeys(value, [...legacyKeys, 'documentationAssessment'])) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'task-diff-review-record.v1') {
        throw recordInvalid();
    }
    const subject = parseSubjectForRecord(value.subject);
    const reviewScope = assertReviewScopeCurrent(subject, parseTaskDiffReviewScope(value.reviewScope));
    const assignment = parseAssignment(value.assignment);
    const verdict = parseVerdict(value.verdict);
    const coverage = parseCoverage(value.coverage);
    const challenges = parseStoredChallenges(value.challenges, assignment);
    const suggestions = parseStoredSuggestions(value.suggestions);
    const riskPathDispositions = assertRiskPathDispositionsCurrent(subject, reviewScope, value.riskPathDispositions);
    assertRiskPathChallengeConsistency(riskPathDispositions, challenges);
    const scopeAssessment = parseScopeAssessment(value.scopeAssessment, challenges.length);
    const documentationAssessment = Object.hasOwn(value, 'documentationAssessment')
        ? assertDocumentationAssessmentCurrent(subject, parseDocumentationAssessment(value.documentationAssessment), verdict, challenges.length)
        : assertDocumentationAssessmentCurrent(subject, undefined, verdict, challenges.length);
    const record = {
        schemaVersion: 1,
        kind: 'task-diff-review-record.v1',
        recordDigest: parseDigest(value.recordDigest),
        subject,
        subjectDigest: parseDigest(value.subjectDigest),
        reviewScope,
        assignment,
        verdict,
        coverage,
        scopeAssessment,
        challenges,
        suggestions,
        riskPathDispositions,
        residualRisk: boundedText(value.residualRisk),
        uncertainty: boundedText(value.uncertainty),
        ...(documentationAssessment === undefined
            ? {}
            : { documentationAssessment }),
    };
    if (record.subjectDigest !== subject.subjectDigest ||
        record.recordDigest !== sha256(canonicalJson(withoutRecordDigest(record)))) {
        throw recordInvalid();
    }
    return deepFreeze(record);
}
export function createTaskDiffReviewDispositionRecord(input) {
    const review = parseTaskDiffReviewRecord(input.review);
    const entries = normalizeDispositionEntries(input.entries);
    assertDispositionAuthority(review, entries);
    const body = {
        schemaVersion: 1,
        kind: 'task-diff-review-disposition.v1',
        reviewRecordDigest: review.recordDigest,
        subjectDigest: review.subjectDigest,
        entries,
    };
    return parseTaskDiffReviewDispositionRecord({
        ...body,
        dispositionDigest: sha256(canonicalJson(body)),
    });
}
export function createTaskDiffReviewChallengeResponse(input) {
    const review = parseTaskDiffReviewRecord(input.review);
    const responses = normalizeChallengeResponses(input.responses);
    assertExactChallengeSet(review.challenges.map(({ challengeId }) => challengeId), responses.map(({ challengeId }) => challengeId));
    const body = {
        schemaVersion: 1,
        kind: 'task-diff-review-challenge-response.v1',
        reviewRecordDigest: review.recordDigest,
        subjectDigest: review.subjectDigest,
        responses,
    };
    return parseTaskDiffReviewChallengeResponseRecord({
        ...body,
        responseDigest: sha256(canonicalJson(body)),
    });
}
export function parseTaskDiffReviewChallengeResponseRecord(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'responseDigest',
            'reviewRecordDigest',
            'subjectDigest',
            'responses',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'task-diff-review-challenge-response.v1') {
        throw dispositionInvalid();
    }
    const record = {
        schemaVersion: 1,
        kind: 'task-diff-review-challenge-response.v1',
        responseDigest: parseDispositionDigest(value.responseDigest),
        reviewRecordDigest: parseDispositionDigest(value.reviewRecordDigest),
        subjectDigest: parseDispositionDigest(value.subjectDigest),
        responses: normalizeChallengeResponses(value.responses),
    };
    if (record.responseDigest !==
        sha256(canonicalJson(withoutResponseDigest(record)))) {
        throw dispositionInvalid();
    }
    return deepFreeze(record);
}
export function assertTaskDiffReviewChallengeResponseCurrent(reviewCandidate, responseCandidate) {
    const review = parseTaskDiffReviewRecord(reviewCandidate);
    const response = parseTaskDiffReviewChallengeResponseRecord(responseCandidate);
    if (response.reviewRecordDigest !== review.recordDigest ||
        response.subjectDigest !== review.subjectDigest) {
        throw dispositionInvalid();
    }
    assertExactChallengeSet(review.challenges.map(({ challengeId }) => challengeId), response.responses.map(({ challengeId }) => challengeId));
    return response;
}
export function createTaskDiffFinalAssuranceRecord(input) {
    const subject = parseTaskDiffReviewSubject(input.subject);
    const review = parseTaskDiffReviewRecord(input.review);
    const response = assertTaskDiffReviewChallengeResponseCurrent(review, input.response);
    const submission = assertTaskDiffReviewContinuationSubmissionCurrent(review, response, input.submission);
    const reviewerAuthority = parseFinalAssuranceReviewerAuthority(input.reviewerAuthority);
    const exceptions = parseFinalAssuranceExceptions(input.exceptions ?? []);
    const expectedExceptions = expectedFinalAssuranceExceptions(review, reviewerAuthority);
    if (review.subjectDigest !== subject.subjectDigest ||
        canonicalJson(review.subject) !== canonicalJson(subject) ||
        reviewerAuthority.policyDigest !== subject.reviewPolicyDigest ||
        canonicalJson(exceptions) !== canonicalJson(expectedExceptions)) {
        throw finalAssuranceInvalid();
    }
    assertFinalAssuranceAuthorityBindings({
        subject,
        review,
        response,
        reviewerAuthority,
        authenticatedReviewAuthority: input.authenticatedReviewAuthority,
        authenticatedChallengeClosureAuthority: input.authenticatedChallengeClosureAuthority,
    });
    const dispositions = submission.proposedDispositions.map((entry) => Object.freeze({
        ...entry,
        closedBy: reviewerAuthority.principalId,
    }));
    assertTaskDiffChallengeClosure(subject, review, reviewerAuthority, dispositions);
    const body = {
        schemaVersion: 1,
        kind: 'task-diff-final-assurance.v1',
        subject,
        subjectDigest: subject.subjectDigest,
        reviewRecordDigest: review.recordDigest,
        responseDigest: response.responseDigest,
        verdict: dispositions.some(({ decision }) => decision === 'accepted')
            ? 'changes-required'
            : 'satisfied',
        reviewerAuthority,
        dispositions,
        exceptions,
    };
    return parseTaskDiffFinalAssuranceRecord({
        ...body,
        commitmentDigest: sha256(canonicalJson(body)),
    });
}
export function parseTaskDiffFinalAssuranceRecord(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'commitmentDigest',
            'subject',
            'subjectDigest',
            'reviewRecordDigest',
            'responseDigest',
            'verdict',
            'reviewerAuthority',
            'dispositions',
            'exceptions',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'task-diff-final-assurance.v1' ||
        (value.verdict !== 'satisfied' && value.verdict !== 'changes-required') ||
        !Array.isArray(value.dispositions) ||
        value.dispositions.length === 0 ||
        value.dispositions.length > MAX_FINDINGS) {
        throw finalAssuranceInvalid();
    }
    const subject = parseTaskDiffReviewSubject(value.subject);
    const reviewerAuthority = parseFinalAssuranceReviewerAuthority(value.reviewerAuthority);
    const dispositions = value.dispositions.map((candidate) => {
        if (!isRecord(candidate) ||
            !hasExactKeys(candidate, [
                'challengeId',
                'decision',
                'rationale',
                'closedBy',
                'supersededBy',
            ]) ||
            !CONTINUATION_DECISIONS.has(String(candidate.decision)) ||
            (candidate.supersededBy !== null &&
                (typeof candidate.supersededBy !== 'string' ||
                    !DIGEST.test(candidate.supersededBy))) ||
            (candidate.decision === 'superseded') !==
                (typeof candidate.supersededBy === 'string')) {
            throw finalAssuranceInvalid();
        }
        return Object.freeze({
            challengeId: finalAssuranceDigest(candidate.challengeId),
            decision: candidate.decision,
            rationale: boundedFinalAssuranceText(candidate.rationale),
            closedBy: finalAssuranceIdentity(candidate.closedBy),
            supersededBy: candidate.supersededBy,
        });
    });
    const exceptions = parseFinalAssuranceExceptions(value.exceptions);
    const record = {
        schemaVersion: 1,
        kind: 'task-diff-final-assurance.v1',
        commitmentDigest: finalAssuranceDigest(value.commitmentDigest),
        subject,
        subjectDigest: finalAssuranceDigest(value.subjectDigest),
        reviewRecordDigest: finalAssuranceDigest(value.reviewRecordDigest),
        responseDigest: finalAssuranceDigest(value.responseDigest),
        verdict: value.verdict,
        reviewerAuthority,
        dispositions,
        exceptions,
    };
    if (record.subjectDigest !== subject.subjectDigest ||
        record.reviewerAuthority.policyDigest !== subject.reviewPolicyDigest ||
        record.verdict !==
            (record.dispositions.some(({ decision }) => decision === 'accepted')
                ? 'changes-required'
                : 'satisfied') ||
        record.dispositions.some(({ closedBy }) => closedBy !== record.reviewerAuthority.principalId) ||
        !finalAssuranceAuthorityMatchesStoredExceptions(record.reviewerAuthority, record.exceptions) ||
        record.commitmentDigest !==
            sha256(canonicalJson(withoutFinalAssuranceCommitment(record)))) {
        throw finalAssuranceInvalid();
    }
    return deepFreeze(record);
}
export function assertTaskDiffFinalAssuranceCurrent(input) {
    const subject = parseTaskDiffReviewSubject(input.subject);
    const review = parseTaskDiffReviewRecord(input.review);
    const response = assertTaskDiffReviewChallengeResponseCurrent(review, input.response);
    const assurance = parseTaskDiffFinalAssuranceRecord(input.assurance);
    if (assurance.subjectDigest !== subject.subjectDigest ||
        canonicalJson(assurance.subject) !== canonicalJson(subject) ||
        assurance.reviewRecordDigest !== review.recordDigest ||
        assurance.responseDigest !== response.responseDigest ||
        canonicalJson(assurance.exceptions) !==
            canonicalJson(expectedFinalAssuranceExceptions(review, assurance.reviewerAuthority))) {
        throw finalAssuranceInvalid();
    }
    assertFinalAssuranceAuthorityBindings({
        subject,
        review,
        response,
        reviewerAuthority: assurance.reviewerAuthority,
        authenticatedReviewAuthority: input.authenticatedReviewAuthority,
        authenticatedChallengeClosureAuthority: input.authenticatedChallengeClosureAuthority,
    });
    assertTaskDiffChallengeClosure(subject, review, assurance.reviewerAuthority, assurance.dispositions);
    return assurance;
}
export function parseTaskDiffReviewDispositionRecord(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'dispositionDigest',
            'reviewRecordDigest',
            'subjectDigest',
            'entries',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'task-diff-review-disposition.v1') {
        throw dispositionInvalid();
    }
    const record = {
        schemaVersion: 1,
        kind: 'task-diff-review-disposition.v1',
        dispositionDigest: parseDispositionDigest(value.dispositionDigest),
        reviewRecordDigest: parseDispositionDigest(value.reviewRecordDigest),
        subjectDigest: parseDispositionDigest(value.subjectDigest),
        entries: normalizeDispositionEntries(value.entries),
    };
    if (record.dispositionDigest !==
        sha256(canonicalJson(withoutDispositionDigest(record)))) {
        throw dispositionInvalid();
    }
    return deepFreeze(record);
}
/**
 * Validate the content-level review gate for one exact subject.
 *
 * Assignment identities in this value object are not authentication. A
 * production caller must first bind the record to a verified provider result.
 * Challenge-bearing reviews require a separately verified Final Assurance
 * node; a legacy/advisory disposition value can never authorize this helper.
 */
export function assertTaskDiffReviewContentSatisfied(candidate, reviewCandidate, dispositionCandidate) {
    const subject = parseTaskDiffReviewSubject(candidate);
    const review = parseTaskDiffReviewRecord(reviewCandidate);
    if (taskDiffReviewCandidateIdentityDigest(review.subject) !==
        taskDiffReviewCandidateIdentityDigest(subject)) {
        throw workflowError('TASK_DIFF_REVIEW_STALE', 'TaskDiffReview does not cover the current canonical subject.', ExitCode.staleState);
    }
    if (review.challenges.length === 0) {
        if (dispositionCandidate !== null)
            throw dispositionInvalid();
        return review;
    }
    throw workflowError('TASK_DIFF_REVIEW_CHALLENGE_OPEN', dispositionCandidate === null
        ? 'TaskDiffReview contains challenges without an authenticated Final Assurance record.'
        : 'Advisory TaskDiffReview dispositions cannot substitute for an authenticated Final Assurance record.', ExitCode.verification, {
        details: {
            challengeIds: review.challenges.map(({ challengeId }) => challengeId),
        },
    });
}
function normalizeSubmission(value, assignment, subject, reviewScope) {
    const submission = parseTaskDiffReviewSubmission(value);
    const challenges = normalizeSubmittedFindings(submission.findings, assignment.reviewerPrincipalId);
    const suggestions = normalizeSubmittedSuggestions(submission.suggestions);
    const riskPathDispositions = assertRiskPathDispositionsCurrent(subject, reviewScope, submission.riskPathDispositions);
    assertRiskPathChallengeConsistency(riskPathDispositions, challenges);
    return {
        verdict: submission.verdict,
        scopeAssessment: submission.scopeAssessment,
        challenges,
        suggestions,
        riskPathDispositions,
        residualRisk: submission.residualRisk,
        uncertainty: submission.uncertainty,
        ...(submission.documentationAssessment === undefined
            ? {}
            : {
                documentationAssessment: assertDocumentationAssessmentCurrent(subject, submission.documentationAssessment, submission.verdict, challenges.length),
            }),
    };
}
/** Strictly parse and canonically normalize provider semantic output. */
export function parseTaskDiffReviewSubmission(value) {
    const legacyKeys = [
        'schemaVersion',
        'verdict',
        'coverage',
        'scopeAssessment',
        'findings',
        'suggestions',
        'riskPathDispositions',
        'residualRisk',
        'uncertainty',
    ];
    if (!isRecord(value) ||
        (!hasExactKeys(value, legacyKeys) &&
            !hasExactKeys(value, [...legacyKeys, 'documentationAssessment'])) ||
        value.schemaVersion !== 1) {
        throw recordInvalid();
    }
    const verdict = parseVerdict(value.verdict);
    const coverage = parseCoverage(value.coverage);
    if (!Array.isArray(value.findings) || value.findings.length > MAX_FINDINGS) {
        throw recordInvalid();
    }
    if (!Array.isArray(value.suggestions) ||
        value.suggestions.length > MAX_FINDINGS) {
        throw recordInvalid();
    }
    const findings = value.findings.map((entry) => parseFinding(entry, 'challenge'));
    const suggestions = value.suggestions.map((entry) => parseFinding(entry, 'suggestion'));
    canonicalValues(findings);
    canonicalValues(suggestions);
    return deepFreeze({
        schemaVersion: 1,
        verdict,
        coverage,
        scopeAssessment: parseScopeAssessment(value.scopeAssessment, findings.length),
        findings,
        suggestions,
        riskPathDispositions: parseRiskPathDispositions(value.riskPathDispositions),
        residualRisk: boundedText(value.residualRisk),
        uncertainty: boundedText(value.uncertainty),
        ...(Object.hasOwn(value, 'documentationAssessment')
            ? {
                documentationAssessment: parseDocumentationAssessment(value.documentationAssessment),
            }
            : {}),
    });
}
export function parseTaskDiffReviewContinuationSubmission(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'reviewRecordDigest',
            'responseDigest',
            'proposedDispositions',
        ]) ||
        value.schemaVersion !== 1 ||
        !Array.isArray(value.proposedDispositions) ||
        value.proposedDispositions.length === 0 ||
        value.proposedDispositions.length > MAX_FINDINGS) {
        throw continuationInvalid();
    }
    const proposedDispositions = value.proposedDispositions
        .map((candidate) => {
        if (!isRecord(candidate) ||
            !hasExactKeys(candidate, [
                'challengeId',
                'decision',
                'rationale',
                'supersededBy',
            ]) ||
            !CONTINUATION_DECISIONS.has(String(candidate.decision)) ||
            (candidate.supersededBy !== null &&
                (typeof candidate.supersededBy !== 'string' ||
                    !DIGEST.test(candidate.supersededBy))) ||
            (candidate.decision === 'superseded') !==
                (typeof candidate.supersededBy === 'string')) {
            throw continuationInvalid();
        }
        return Object.freeze({
            challengeId: continuationDigest(candidate.challengeId),
            decision: candidate.decision,
            rationale: boundedContinuationText(candidate.rationale),
            supersededBy: candidate.supersededBy,
        });
    })
        .sort((left, right) => left.challengeId.localeCompare(right.challengeId));
    if (proposedDispositions.some((entry, index) => index > 0 &&
        entry.challengeId === proposedDispositions[index - 1].challengeId)) {
        throw continuationInvalid();
    }
    return deepFreeze({
        schemaVersion: 1,
        reviewRecordDigest: continuationDigest(value.reviewRecordDigest),
        responseDigest: continuationDigest(value.responseDigest),
        proposedDispositions,
    });
}
export function assertTaskDiffReviewContinuationSubmissionCurrent(reviewCandidate, responseCandidate, submissionCandidate) {
    const review = parseTaskDiffReviewRecord(reviewCandidate);
    const response = assertTaskDiffReviewChallengeResponseCurrent(review, responseCandidate);
    const submission = parseTaskDiffReviewContinuationSubmission(submissionCandidate);
    const challenges = review.challenges
        .map(({ challengeId }) => challengeId)
        .sort();
    if (submission.reviewRecordDigest !== review.recordDigest ||
        submission.responseDigest !== response.responseDigest ||
        canonicalJson(submission.proposedDispositions.map(({ challengeId }) => challengeId)) !== canonicalJson(challenges) ||
        submission.proposedDispositions.some(({ supersededBy }) => supersededBy !== null && !challenges.includes(supersededBy))) {
        throw continuationInvalid();
    }
    return submission;
}
function parseAssignment(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'implementerPrincipalId',
            'implementerProviderId',
            'implementationSessionId',
            'reviewerPrincipalId',
            'reviewerProviderId',
            'reviewerSessionId',
            'achievedIndependence',
            'degradedForm',
            'grantUseDigest',
        ]) ||
        (value.grantUseDigest !== null &&
            (typeof value.grantUseDigest !== 'string' ||
                !DIGEST.test(value.grantUseDigest)))) {
        throw independenceInvalid();
    }
    const implementerPrincipalId = identity(value.implementerPrincipalId);
    const implementerProviderId = nullableIdentity(value.implementerProviderId);
    const implementationSessionId = identity(value.implementationSessionId);
    const reviewerPrincipalId = identity(value.reviewerPrincipalId);
    if (implementerPrincipalId === reviewerPrincipalId) {
        throw independenceInvalid();
    }
    if (value.achievedIndependence === 'none') {
        if (value.reviewerProviderId !== null ||
            value.reviewerSessionId !== null ||
            (value.degradedForm !== 'caller-supplied' &&
                value.degradedForm !== 'direct-human-review') ||
            typeof value.grantUseDigest !== 'string') {
            throw independenceInvalid();
        }
        return Object.freeze({
            implementerPrincipalId,
            implementerProviderId,
            implementationSessionId,
            reviewerPrincipalId,
            reviewerProviderId: null,
            reviewerSessionId: null,
            achievedIndependence: 'none',
            degradedForm: value.degradedForm,
            grantUseDigest: value.grantUseDigest,
        });
    }
    if ((value.achievedIndependence !== 'provider-independent' &&
        value.achievedIndependence !== 'session-independent') ||
        ![null, 'same-provider-fresh-session'].includes(value.degradedForm)) {
        throw independenceInvalid();
    }
    const assignment = {
        implementerPrincipalId,
        implementerProviderId,
        implementationSessionId,
        reviewerPrincipalId,
        reviewerProviderId: identity(value.reviewerProviderId),
        reviewerSessionId: identity(value.reviewerSessionId),
        achievedIndependence: value.achievedIndependence,
        degradedForm: value.degradedForm,
        grantUseDigest: value.grantUseDigest,
    };
    const commonInvalid = assignment.implementationSessionId === assignment.reviewerSessionId;
    const ordinaryInvalid = assignment.achievedIndependence === 'provider-independent' &&
        (assignment.implementerProviderId === null ||
            assignment.implementerProviderId === assignment.reviewerProviderId ||
            assignment.degradedForm !== null ||
            assignment.grantUseDigest !== null);
    const grantedInvalid = assignment.achievedIndependence === 'session-independent' &&
        (assignment.implementerProviderId === null ||
            assignment.implementerProviderId !== assignment.reviewerProviderId ||
            assignment.degradedForm !== 'same-provider-fresh-session' ||
            assignment.grantUseDigest === null);
    if (commonInvalid || ordinaryInvalid || grantedInvalid) {
        throw independenceInvalid();
    }
    return Object.freeze(assignment);
}
function normalizeSubmittedFindings(value, reviewerPrincipalId) {
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
function normalizeSubmittedSuggestions(value) {
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
function parseStoredChallenges(value, assignment) {
    if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
        throw recordInvalid();
    }
    const challenges = value.map((entry) => {
        if (!isRecord(entry) ||
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
            entry.raisedBy !== assignment.reviewerPrincipalId) {
            throw recordInvalid();
        }
        const finding = parseFinding(findingProjection(entry), 'challenge');
        const body = { ...finding, raisedBy: assignment.reviewerPrincipalId };
        const challengeId = parseDigest(entry.challengeId);
        if (challengeId !== sha256(canonicalJson(body)))
            throw recordInvalid();
        return Object.freeze({ ...body, challengeId });
    });
    return canonicalObjects(challenges, 'challengeId');
}
function parseStoredSuggestions(value) {
    if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
        throw recordInvalid();
    }
    const suggestions = value.map((entry) => {
        if (!isRecord(entry) ||
            !hasExactKeys(entry, [
                'kind',
                'severity',
                'category',
                'currentChangeImpact',
                'summary',
                'evidence',
                'suggestionId',
            ])) {
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
function parseRiskPathDispositions(value) {
    if (!Array.isArray(value))
        throw recordInvalid();
    const dispositions = value.map((entry) => {
        if (!isRecord(entry) ||
            !hasExactKeys(entry, ['path', 'role', 'outcome']) ||
            !RISK_PATH_ROLE_SET.has(String(entry.role)) ||
            !RISK_PATH_OUTCOME_SET.has(String(entry.outcome))) {
            throw recordInvalid();
        }
        return Object.freeze({
            path: exactPath(entry.path),
            role: entry.role,
            outcome: entry.outcome,
        });
    });
    return canonicalObjects(dispositions, 'path');
}
function assertRiskPathDispositionsCurrent(subject, reviewScope, value) {
    const dispositions = parseRiskPathDispositions(value);
    const reviewedPaths = new Set(reviewScope.reviewedPaths);
    const expected = subject.reviewRequirement.riskPaths.filter(({ path }) => reviewScope.mode === 'full' || reviewedPaths.has(path));
    if (expected.length !== dispositions.length ||
        expected.some(({ path, role }, index) => dispositions[index]?.path !== path ||
            dispositions[index]?.role !== role)) {
        throw recordInvalid();
    }
    return dispositions;
}
function assertRiskPathChallengeConsistency(dispositions, challenges) {
    const challengedPaths = new Set(challenges.flatMap(({ evidence }) => evidence.flatMap((entry) => entry.kind === 'repository-location' ? [entry.path] : [])));
    if (dispositions.some(({ path, outcome }) => (outcome === 'challenge-raised') !== challengedPaths.has(path))) {
        throw recordInvalid();
    }
}
function parseFinding(value, expectedKind) {
    if (!isRecord(value) ||
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
            : value.currentChangeImpact !== 'independent-follow-up')) {
        throw recordInvalid();
    }
    const common = {
        severity: value.severity,
        category: value.category,
        summary: boundedText(value.summary),
        evidence: normalizeEvidence(value.evidence, true),
    };
    return expectedKind === 'challenge'
        ? Object.freeze({
            ...common,
            kind: 'challenge',
            currentChangeImpact: 'required',
        })
        : Object.freeze({
            ...common,
            kind: 'suggestion',
            currentChangeImpact: 'independent-follow-up',
        });
}
function findingProjection(value) {
    return {
        kind: value.kind,
        severity: value.severity,
        category: value.category,
        currentChangeImpact: value.currentChangeImpact,
        summary: value.summary,
        evidence: value.evidence,
    };
}
function parseScopeAssessment(value, challengeCount) {
    if (!isRecord(value) || value.kind === 'challenges') {
        if (!isRecord(value) ||
            !hasExactKeys(value, ['kind']) ||
            value.kind !== 'challenges' ||
            challengeCount === 0) {
            throw recordInvalid();
        }
        return Object.freeze({ kind: 'challenges' });
    }
    if (!hasExactKeys(value, ['kind', 'evidence']) ||
        value.kind !== 'no-challenge' ||
        challengeCount !== 0) {
        throw recordInvalid();
    }
    return Object.freeze({
        kind: 'no-challenge',
        evidence: normalizeEvidence(value.evidence, true),
    });
}
function normalizeEvidence(value, requireNonEmpty) {
    if (!Array.isArray(value) ||
        value.length > MAX_EVIDENCE ||
        (requireNonEmpty && value.length === 0)) {
        throw recordInvalid();
    }
    const evidence = value.map((entry) => {
        if (!isRecord(entry) || typeof entry.kind !== 'string') {
            throw recordInvalid();
        }
        if (entry.kind === 'repository-location') {
            if (!hasExactKeys(entry, [
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
                !OBJECT_ID.test(entry.blobObjectId)) {
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
            if (!hasExactKeys(entry, ['kind', 'reportId', 'checkId', 'observation'])) {
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
            if (!hasExactKeys(entry, ['kind', 'nodeId', 'resultDigest', 'observation'])) {
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
    const canonical = evidence.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    if (canonical.some((entry, index) => index > 0 &&
        canonicalJson(entry) === canonicalJson(canonical[index - 1]))) {
        throw recordInvalid();
    }
    return Object.freeze(canonical);
}
function normalizeDispositionEntries(value) {
    if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
        throw dispositionInvalid();
    }
    const entries = value.map((entry) => {
        if (!isRecord(entry) ||
            !hasExactKeys(entry, [
                'challengeId',
                'disposition',
                'rationale',
                'closedBy',
            ]) ||
            !DISPOSITIONS.has(String(entry.disposition))) {
            throw dispositionInvalid();
        }
        return Object.freeze({
            challengeId: parseDispositionDigest(entry.challengeId),
            disposition: entry.disposition,
            rationale: boundedDispositionText(entry.rationale),
            closedBy: dispositionIdentity(entry.closedBy),
        });
    });
    entries.sort((left, right) => left.challengeId.localeCompare(right.challengeId));
    if (entries.some((entry, index) => index > 0 && entry.challengeId === entries[index - 1].challengeId)) {
        throw dispositionInvalid();
    }
    return Object.freeze(entries);
}
function normalizeChallengeResponses(value) {
    if (!Array.isArray(value) ||
        value.length === 0 ||
        value.length > MAX_FINDINGS) {
        throw dispositionInvalid();
    }
    const responses = value
        .map((entry) => {
        if (!isRecord(entry) ||
            !hasExactKeys(entry, ['challengeId', 'rationale', 'evidence'])) {
            throw dispositionInvalid();
        }
        let evidence;
        try {
            evidence = normalizeEvidence(entry.evidence, false);
        }
        catch {
            throw dispositionInvalid();
        }
        return Object.freeze({
            challengeId: parseDispositionDigest(entry.challengeId),
            rationale: boundedDispositionText(entry.rationale),
            evidence,
        });
    })
        .sort((left, right) => left.challengeId.localeCompare(right.challengeId));
    if (responses.some((entry, index) => index > 0 && entry.challengeId === responses[index - 1].challengeId)) {
        throw dispositionInvalid();
    }
    return Object.freeze(responses);
}
function assertExactChallengeSet(expected, actual) {
    if (expected.length === 0 ||
        canonicalJson([...expected].sort()) !== canonicalJson([...actual].sort())) {
        throw dispositionInvalid();
    }
}
function assertDispositionAuthority(review, entries) {
    const challengeIds = new Set(review.challenges.map(({ challengeId }) => challengeId));
    for (const entry of entries) {
        if (!challengeIds.has(entry.challengeId) ||
            entry.closedBy === review.assignment.implementerPrincipalId ||
            entry.closedBy !== review.assignment.reviewerPrincipalId) {
            throw dispositionInvalid();
        }
    }
}
function assertReviewScopeCurrent(subject, candidate) {
    const scope = parseTaskDiffReviewScope(candidate);
    if (scope.currentSubjectDigest !== subject.subjectDigest ||
        scope.candidateIdentityDigest !==
            taskDiffReviewCandidateIdentityDigest(subject) ||
        (scope.predecessor === null &&
            (scope.mode !== 'full' ||
                canonicalJson(scope.reviewedPaths) !==
                    canonicalJson(subject.changedPaths))) ||
        (scope.mode === 'delta' && scope.predecessor === null)) {
        throw recordInvalid();
    }
    return scope;
}
function parseCoverage(value) {
    if (!Array.isArray(value) ||
        value.some((entry) => typeof entry !== 'string') ||
        new Set(value).size !== TASK_DIFF_REVIEW_COVERAGE.length ||
        [...value].sort().join('\0') !==
            [...TASK_DIFF_REVIEW_COVERAGE].sort().join('\0')) {
        throw recordInvalid();
    }
    return TASK_DIFF_REVIEW_COVERAGE;
}
function parseDocumentationAssessment(value) {
    if (!isRecord(value) || typeof value.decision !== 'string') {
        throw recordInvalid();
    }
    if (value.decision === 'updated' &&
        hasExactKeys(value, ['decision', 'paths', 'notes'])) {
        return Object.freeze({
            decision: 'updated',
            paths: documentationPaths(value.paths),
            notes: boundedText(value.notes),
        });
    }
    if (value.decision === 'no-impact' &&
        hasExactKeys(value, ['decision', 'notes'])) {
        return Object.freeze({
            decision: 'no-impact',
            notes: boundedText(value.notes),
        });
    }
    if (value.decision === 'generated-verified' &&
        hasExactKeys(value, [
            'decision',
            'sources',
            'generated',
            'evidence',
            'notes',
        ])) {
        return Object.freeze({
            decision: 'generated-verified',
            sources: exactPaths(value.sources, false),
            generated: documentationPaths(value.generated),
            evidence: boundedIdentities(value.evidence),
            notes: boundedText(value.notes),
        });
    }
    if (value.decision === 'needs-changes' &&
        hasExactKeys(value, ['decision', 'requiredPaths', 'notes'])) {
        return Object.freeze({
            decision: 'needs-changes',
            requiredPaths: documentationPaths(value.requiredPaths),
            notes: boundedText(value.notes),
        });
    }
    throw recordInvalid();
}
function assertDocumentationAssessmentCurrent(subject, assessment, verdict, challengeCount) {
    const requirement = subject.documentationRequirement;
    if (requirement?.required !== true) {
        if (assessment !== undefined)
            throw recordInvalid();
        return undefined;
    }
    if (assessment === undefined)
        throw recordInvalid();
    const changed = new Set(requirement.changedPaths);
    const changedDocumentation = requirement.changedPaths.filter(isDocumentationPath);
    if (assessment.decision === 'updated') {
        if (assessment.paths.some((candidate) => !changed.has(candidate))) {
            throw recordInvalid();
        }
    }
    else if (assessment.decision === 'no-impact') {
        if (changedDocumentation.length > 0)
            throw recordInvalid();
    }
    else if (assessment.decision === 'generated-verified') {
        if ([...assessment.sources, ...assessment.generated].some((candidate) => !changed.has(candidate))) {
            throw recordInvalid();
        }
    }
    else if (verdict !== 'advisory-reject' || challengeCount === 0) {
        throw recordInvalid();
    }
    return assessment;
}
function documentationPaths(value) {
    const paths = exactPaths(value, true);
    if (paths.some((candidate) => !isDocumentationPath(candidate))) {
        throw recordInvalid();
    }
    return paths;
}
function exactPaths(value, requireNonEmpty) {
    if (!Array.isArray(value) ||
        value.length > MAX_FINDINGS ||
        (requireNonEmpty && value.length === 0)) {
        throw recordInvalid();
    }
    const paths = value.map(exactPath).sort();
    if (paths.some((candidate, index) => index > 0 && candidate === paths[index - 1])) {
        throw recordInvalid();
    }
    return Object.freeze(paths);
}
function boundedIdentities(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
        throw recordInvalid();
    }
    const identities = value.map(identity).sort();
    if (identities.some((candidate, index) => index > 0 && candidate === identities[index - 1])) {
        throw recordInvalid();
    }
    return Object.freeze(identities);
}
function isDocumentationPath(candidate) {
    return candidate.startsWith('docs/') || /(?:^|\/)README\.md$/.test(candidate);
}
function parseVerdict(value) {
    if (!VERDICTS.has(String(value)))
        throw recordInvalid();
    return value;
}
function parseSubjectForRecord(value) {
    try {
        return parseTaskDiffReviewSubject(value);
    }
    catch {
        throw recordInvalid();
    }
}
function canonicalObjects(value, key) {
    value.sort((left, right) => left[key].localeCompare(right[key]));
    if (value.some((entry, index) => index > 0 && entry[key] === value[index - 1][key])) {
        throw recordInvalid();
    }
    return Object.freeze(value);
}
function canonicalValues(value) {
    value.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    if (value.some((entry, index) => index > 0 && canonicalJson(entry) === canonicalJson(value[index - 1]))) {
        throw recordInvalid();
    }
}
function withoutRecordDigest(record) {
    const { recordDigest: _recordDigest, ...body } = record;
    return body;
}
function withoutResponseDigest(record) {
    const { responseDigest: _responseDigest, ...body } = record;
    return body;
}
function withoutDispositionDigest(record) {
    const { dispositionDigest: _dispositionDigest, ...body } = record;
    return body;
}
function withoutFinalAssuranceCommitment(record) {
    const { commitmentDigest: _commitmentDigest, ...body } = record;
    return body;
}
function parseFinalAssuranceReviewerAuthority(value) {
    if (!isRecord(value)) {
        throw finalAssuranceInvalid();
    }
    if (value.kind === 'engine-attributed-provider-reviewer') {
        if (!hasExactKeys(value, [
            'kind',
            'principalId',
            'providerId',
            'policyDigest',
        ])) {
            throw finalAssuranceInvalid();
        }
        return Object.freeze({
            kind: 'engine-attributed-provider-reviewer',
            principalId: finalAssuranceIdentity(value.principalId),
            providerId: finalAssuranceIdentity(value.providerId),
            policyDigest: finalAssuranceDigest(value.policyDigest),
        });
    }
    if (value.kind !== 'grant-attributed-external-reviewer' ||
        !hasExactKeys(value, [
            'kind',
            'principalId',
            'degradedForm',
            'grantUseDigest',
            'policyDigest',
        ]) ||
        (value.degradedForm !== 'caller-supplied' &&
            value.degradedForm !== 'direct-human-review')) {
        throw finalAssuranceInvalid();
    }
    return Object.freeze({
        kind: 'grant-attributed-external-reviewer',
        principalId: finalAssuranceIdentity(value.principalId),
        degradedForm: value.degradedForm,
        grantUseDigest: finalAssuranceDigest(value.grantUseDigest),
        policyDigest: finalAssuranceDigest(value.policyDigest),
    });
}
function parseFinalAssuranceExceptions(value) {
    if (!Array.isArray(value) || value.length > 2) {
        throw finalAssuranceInvalid();
    }
    const exceptions = value
        .map((candidate) => {
        if (!isRecord(candidate) ||
            !hasExactKeys(candidate, [
                'kind',
                'stage',
                'grantUseDigest',
                'degradedForm',
            ]) ||
            candidate.kind !== 'collaboration-grant-degradation' ||
            (candidate.stage !== 'review' &&
                candidate.stage !== 'challenge-closure') ||
            ![
                'same-provider-fresh-session',
                'caller-supplied',
                'direct-human-review',
            ].includes(String(candidate.degradedForm))) {
            throw finalAssuranceInvalid();
        }
        return Object.freeze({
            kind: 'collaboration-grant-degradation',
            stage: candidate.stage,
            grantUseDigest: finalAssuranceDigest(candidate.grantUseDigest),
            degradedForm: candidate.degradedForm,
        });
    })
        .sort((left, right) => finalAssuranceStageOrder(left.stage) -
        finalAssuranceStageOrder(right.stage));
    if (exceptions.some((entry, index) => index > 0 && entry.stage === exceptions[index - 1].stage) ||
        new Set(exceptions.map(({ grantUseDigest }) => grantUseDigest)).size !==
            exceptions.length) {
        throw finalAssuranceInvalid();
    }
    return Object.freeze(exceptions);
}
function expectedFinalAssuranceExceptions(review, authority) {
    const expected = [];
    if (review.assignment.degradedForm !== null &&
        review.assignment.grantUseDigest !== null) {
        expected.push({
            kind: 'collaboration-grant-degradation',
            stage: 'review',
            grantUseDigest: review.assignment.grantUseDigest,
            degradedForm: review.assignment.degradedForm,
        });
    }
    if (authority.kind === 'grant-attributed-external-reviewer') {
        expected.push({
            kind: 'collaboration-grant-degradation',
            stage: 'challenge-closure',
            grantUseDigest: authority.grantUseDigest,
            degradedForm: authority.degradedForm,
        });
    }
    return parseFinalAssuranceExceptions(expected);
}
function finalAssuranceAuthorityMatchesStoredExceptions(authority, exceptions) {
    const closureException = exceptions.find(({ stage }) => stage === 'challenge-closure');
    return authority.kind === 'grant-attributed-external-reviewer'
        ? closureException?.grantUseDigest === authority.grantUseDigest &&
            closureException.degradedForm === authority.degradedForm
        : closureException === undefined;
}
function finalAssuranceStageOrder(stage) {
    return stage === 'review' ? 0 : 1;
}
function parseAuthenticatedReviewerAuthority(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'stage',
            'subjectDigest',
            'reviewRecordDigest',
            'responseDigest',
            'authorityNodeId',
            'authorityResultDigest',
            'authority',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'task-diff-authenticated-reviewer-authority.v1' ||
        (value.stage !== 'review' && value.stage !== 'challenge-closure') ||
        (value.responseDigest !== null &&
            (typeof value.responseDigest !== 'string' ||
                !DIGEST.test(value.responseDigest)))) {
        throw finalAssuranceInvalid();
    }
    return Object.freeze({
        schemaVersion: 1,
        kind: 'task-diff-authenticated-reviewer-authority.v1',
        stage: value.stage,
        subjectDigest: finalAssuranceDigest(value.subjectDigest),
        reviewRecordDigest: finalAssuranceDigest(value.reviewRecordDigest),
        responseDigest: value.responseDigest,
        authorityNodeId: finalAssuranceDigest(value.authorityNodeId),
        authorityResultDigest: finalAssuranceDigest(value.authorityResultDigest),
        authority: parseFinalAssuranceReviewerAuthority(value.authority),
    });
}
function expectedInitialReviewAuthority(review) {
    const assignment = review.assignment;
    return assignment.reviewerProviderId === null
        ? Object.freeze({
            kind: 'grant-attributed-external-reviewer',
            principalId: assignment.reviewerPrincipalId,
            degradedForm: assignment.degradedForm,
            grantUseDigest: assignment.grantUseDigest,
            policyDigest: review.subject.reviewPolicyDigest,
        })
        : Object.freeze({
            kind: 'engine-attributed-provider-reviewer',
            principalId: assignment.reviewerPrincipalId,
            providerId: assignment.reviewerProviderId,
            policyDigest: review.subject.reviewPolicyDigest,
        });
}
function assertFinalAssuranceAuthorityBindings(input) {
    const expectedReviewAuthority = expectedInitialReviewAuthority(input.review);
    const legacyExactProviderContinuation = expectedReviewAuthority.kind === 'engine-attributed-provider-reviewer' &&
        input.reviewerAuthority.kind === 'engine-attributed-provider-reviewer' &&
        canonicalJson(input.reviewerAuthority) ===
            canonicalJson(expectedReviewAuthority);
    const reviewFact = input.authenticatedReviewAuthority;
    const closureFact = input.authenticatedChallengeClosureAuthority;
    if (reviewFact === undefined && closureFact === undefined) {
        if (!legacyExactProviderContinuation)
            throw finalAssuranceInvalid();
        return;
    }
    if (reviewFact === undefined || closureFact === undefined) {
        throw finalAssuranceInvalid();
    }
    const authenticatedReview = parseAuthenticatedReviewerAuthority(reviewFact);
    const authenticatedClosure = parseAuthenticatedReviewerAuthority(closureFact);
    if (authenticatedReview.stage !== 'review' ||
        authenticatedReview.subjectDigest !== input.subject.subjectDigest ||
        authenticatedReview.reviewRecordDigest !== input.review.recordDigest ||
        authenticatedReview.responseDigest !== null ||
        canonicalJson(authenticatedReview.authority) !==
            canonicalJson(expectedReviewAuthority) ||
        authenticatedClosure.stage !== 'challenge-closure' ||
        authenticatedClosure.subjectDigest !== input.subject.subjectDigest ||
        authenticatedClosure.reviewRecordDigest !== input.review.recordDigest ||
        authenticatedClosure.responseDigest !== input.response.responseDigest ||
        canonicalJson(authenticatedClosure.authority) !==
            canonicalJson(input.reviewerAuthority) ||
        authenticatedReview.authorityNodeId === authenticatedClosure.authorityNodeId) {
        throw finalAssuranceInvalid();
    }
}
function assertTaskDiffChallengeClosure(subject, review, authority, dispositions) {
    const challenges = review.challenges.map((challenge) => ({
        challengeId: challenge.challengeId,
        raisedBy: challenge.raisedBy,
        severity: challenge.severity === 'critical' ? 'forbidden-floor' : 'ordinary',
        targetId: challenge.challengeId,
    }));
    const closures = dispositions.map((entry) => ({
        challengeId: entry.challengeId,
        disposition: entry.decision,
        closedBy: entry.closedBy,
        ...(entry.supersededBy === null
            ? {}
            : { supersededBy: entry.supersededBy }),
    }));
    assertAuthorizedReviewChallengeClosure({
        expectedSubjectDigest: subject.subjectDigest,
        authoritySubjectDigest: review.subjectDigest,
        authenticatedCloserId: authority.principalId,
        challenges,
        closures,
        context: {
            authorId: review.assignment.implementerPrincipalId,
            reviewerIds: [authority.principalId],
            domainOwnerIds: [],
        },
    });
}
function exactPath(value) {
    if (typeof value !== 'string')
        throw recordInvalid();
    let normalized;
    try {
        normalized = normalizePolicyPath(value);
    }
    catch {
        throw recordInvalid();
    }
    if (normalized !== value || normalized.endsWith('/**')) {
        throw recordInvalid();
    }
    return normalized;
}
function boundedText(value) {
    if (typeof value !== 'string' ||
        value.trim() !== value ||
        value.length === 0 ||
        Buffer.byteLength(value) > MAX_TEXT_BYTES) {
        throw recordInvalid();
    }
    return value;
}
function boundedDispositionText(value) {
    try {
        return boundedText(value);
    }
    catch {
        throw dispositionInvalid();
    }
}
function boundedContinuationText(value) {
    try {
        return boundedText(value);
    }
    catch {
        throw continuationInvalid();
    }
}
function identity(value) {
    if (typeof value !== 'string' || !IDENTITY.test(value)) {
        throw recordInvalid();
    }
    return value;
}
function nullableIdentity(value) {
    return value === null ? null : identity(value);
}
function dispositionIdentity(value) {
    if (typeof value !== 'string' || !IDENTITY.test(value)) {
        throw dispositionInvalid();
    }
    return value;
}
function parseDigest(value) {
    if (typeof value !== 'string' || !DIGEST.test(value)) {
        throw recordInvalid();
    }
    return value;
}
function parseDispositionDigest(value) {
    if (typeof value !== 'string' || !DIGEST.test(value)) {
        throw dispositionInvalid();
    }
    return value;
}
function continuationDigest(value) {
    if (typeof value !== 'string' || !DIGEST.test(value)) {
        throw continuationInvalid();
    }
    return value;
}
function finalAssuranceDigest(value) {
    if (typeof value !== 'string' || !DIGEST.test(value)) {
        throw finalAssuranceInvalid();
    }
    return value;
}
function finalAssuranceIdentity(value) {
    if (typeof value !== 'string' || !IDENTITY.test(value)) {
        throw finalAssuranceInvalid();
    }
    return value;
}
function boundedFinalAssuranceText(value) {
    try {
        return boundedText(value);
    }
    catch {
        throw finalAssuranceInvalid();
    }
}
function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function deepFreeze(value) {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
        return value;
    }
    Object.freeze(value);
    for (const child of Object.values(value)) {
        deepFreeze(child);
    }
    return value;
}
function hasExactKeys(value, keys) {
    return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function recordInvalid() {
    return workflowError('TASK_DIFF_REVIEW_RECORD_INVALID', 'TaskDiffReview record is malformed or not canonically bound.', ExitCode.staleState);
}
function dispositionInvalid() {
    return workflowError('TASK_DIFF_REVIEW_DISPOSITION_INVALID', 'TaskDiffReview disposition is malformed or lacks independent authority.', ExitCode.guard);
}
function continuationInvalid() {
    return workflowError('TASK_DIFF_REVIEW_CONTINUATION_INVALID', 'TaskDiffReview continuation evidence is malformed or does not cover the exact current challenge set.', ExitCode.guard);
}
function finalAssuranceInvalid() {
    return workflowError('TASK_DIFF_FINAL_ASSURANCE_INVALID', 'TaskDiff Final Assurance is malformed, stale, or lacks authenticated challenge-closure authority.', ExitCode.guard);
}
function independenceInvalid() {
    return workflowError('TASK_DIFF_REVIEW_INDEPENDENCE_INVALID', 'TaskDiffReview requires a fresh provider-independent reviewer assignment.', ExitCode.guard);
}
