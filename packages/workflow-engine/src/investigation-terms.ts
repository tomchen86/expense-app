import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';

/**
 * V1 typed search-term kinds. Matching is fixed case-sensitive literal; arbitrary
 * regular expressions and case folding are rejected. `literal-content`, `symbol`,
 * and `config-key` match exact literal blob content; `literal-path` additionally
 * matches raw tracked path bytes so a path floor also catches dangling consumers.
 */
export type InvestigationTermKind =
  'literal-content' | 'literal-path' | 'symbol' | 'config-key';

export const INVESTIGATION_TERM_MATCHING = 'case-sensitive-literal-v1' as const;

export type InvestigationTermMatching = typeof INVESTIGATION_TERM_MATCHING;

const TERM_KINDS: ReadonlySet<string> = new Set<InvestigationTermKind>([
  'literal-content',
  'literal-path',
  'symbol',
  'config-key',
]);

const MAX_TERM_BYTES = 256;

/**
 * A normalized term binds its exact kind, byte-preserving value, and fixed
 * matching under one semantic `termId`. Two inputs with the same kind and value
 * always deduplicate to the same identity; a different kind never collides.
 */
export type NormalizedInvestigationTerm = {
  termId: string;
  kind: InvestigationTermKind;
  value: string;
  matching: InvestigationTermMatching;
};

/**
 * The recognized term sources. The engine floor counts separately from the three
 * agent/provider contribution channels.
 */
export type InvestigationTermSource = 'engine' | 'main' | 'survey' | 'reviewer';

export type InvestigationTermProvenance = {
  source: InvestigationTermSource;
  reference: string;
};

/**
 * A raw contribution from one source. Terms are typed but not yet normalized;
 * they are snapshotted on preview so later caller mutation cannot alter results.
 */
export type InvestigationTermContribution = {
  source: InvestigationTermSource;
  reference: string;
  terms: Array<{ kind: InvestigationTermKind; value: string }>;
};

export type PreviewInvestigationTerm = NormalizedInvestigationTerm & {
  provenance: InvestigationTermProvenance[];
};

export type InvestigationTermUnionViolation = {
  code:
    | 'MAIN_TERM_LIMIT_EXCEEDED'
    | 'SURVEY_TERM_LIMIT_EXCEEDED'
    | 'REVIEWER_TERM_LIMIT_EXCEEDED'
    | 'EFFECTIVE_TERM_LIMIT_EXCEEDED';
  limit: number;
  observed: number;
};

export type InvestigationTermRawCounts = {
  engine: number;
  main: number;
  survey: number;
  reviewer: number;
};

export type InvestigationTermUnionPreview =
  | {
      outcome: 'ready';
      rawCounts: InvestigationTermRawCounts;
      terms: PreviewInvestigationTerm[];
    }
  | {
      outcome: 'requires-narrowing';
      rawCounts: InvestigationTermRawCounts;
      terms: PreviewInvestigationTerm[];
      violations: InvestigationTermUnionViolation[];
    };

/**
 * Code-owned V1 resource maxima. Provided limits may lower any field but never
 * exceed the fixed maximum, so scans are formatted, reviewed, and replayed with
 * the engine source rather than an unbounded external policy file.
 */
export const INVESTIGATION_LIMITS = {
  maxMainTerms: 64,
  maxSurveyTerms: 64,
  maxReviewerTerms: 32,
  maxEffectiveTerms: 128,
  maxHitsPerTerm: 512,
  maxTotalHits: 4096,
  maxHitDispositionWorkItems: 4096,
  maxScanCpuMillis: 30000,
  maxScanWorkBytes: 30000 * 512 * 1024,
  maxBlobBytes: 2 * 1024 * 1024,
  maxTotalScannedBlobBytes: 64 * 1024 * 1024,
} as const;

export type InvestigationLimits = {
  -readonly [Key in keyof typeof INVESTIGATION_LIMITS]: number;
};

/**
 * Reject a limit set that is not integer-bounded or that raises any field above
 * its fixed maximum. Lowering is allowed; exceeding a code-owned cap is not.
 */
export function assertInvestigationLimits(
  limits: InvestigationLimits,
): InvestigationLimits {
  for (const key of Object.keys(INVESTIGATION_LIMITS) as Array<
    keyof InvestigationLimits
  >) {
    const value = limits[key];
    if (
      !Number.isInteger(value) ||
      value < 1 ||
      value > INVESTIGATION_LIMITS[key]
    ) {
      throw workflowError(
        'INVESTIGATION_LIMITS_INVALID',
        `Investigation limit ${String(key)} is out of range.`,
        ExitCode.usage,
        { details: { key, value, maximum: INVESTIGATION_LIMITS[key] } },
      );
    }
  }
  return limits;
}

/**
 * Normalize a typed term: validate the kind and byte-bounded control-free value,
 * preserve exact bytes and spaces, and derive the semantic `termId`. Any invalid
 * shape raises `INVESTIGATION_TERM_INVALID`.
 */
export function normalizeInvestigationTerm(input: {
  kind: InvestigationTermKind;
  value: string;
}): NormalizedInvestigationTerm {
  if (
    typeof input !== 'object' ||
    input === null ||
    !TERM_KINDS.has((input as { kind: unknown }).kind as string) ||
    typeof input.value !== 'string'
  ) {
    throw termInvalid();
  }

  const value = input.value;
  const byteLength = Buffer.byteLength(value, 'utf8');
  if (byteLength < 1 || byteLength > MAX_TERM_BYTES) {
    throw termInvalid();
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl =
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      (codePoint >= 0x80 && codePoint <= 0x9f);
    const isLoneSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
    if (isControl || isLoneSurrogate) {
      throw termInvalid();
    }
  }

  const kind = input.kind;
  return {
    termId: sha256(
      canonicalJson({
        schema: 'investigation-term-v1',
        kind,
        value,
        matching: INVESTIGATION_TERM_MATCHING,
      }),
    ),
    kind,
    value,
    matching: INVESTIGATION_TERM_MATCHING,
  };
}

/**
 * Deduplicate a term union by semantic identity, retaining every unique sorted
 * provenance entry, and preview per-source and effective resource cost. Input
 * order is irrelevant; the result is deeply frozen and snapshotted so mutating a
 * source contribution afterwards cannot alter it.
 */
export function previewInvestigationTermUnion(
  contributions: InvestigationTermContribution[],
  limits: InvestigationLimits = { ...INVESTIGATION_LIMITS },
): InvestigationTermUnionPreview {
  assertInvestigationLimits(limits);

  const rawCounts: InvestigationTermRawCounts = {
    engine: 0,
    main: 0,
    survey: 0,
    reviewer: 0,
  };
  const union = new Map<
    string,
    {
      term: NormalizedInvestigationTerm;
      provenance: Map<string, InvestigationTermProvenance>;
    }
  >();

  for (const contribution of contributions) {
    rawCounts[contribution.source] += contribution.terms.length;
    for (const rawTerm of contribution.terms) {
      const term = normalizeInvestigationTerm(rawTerm);
      const entry = union.get(term.termId) ?? {
        term,
        provenance: new Map<string, InvestigationTermProvenance>(),
      };
      const provenance: InvestigationTermProvenance = {
        source: contribution.source,
        reference: contribution.reference,
      };
      entry.provenance.set(
        `${provenance.source}\u0000${provenance.reference}`,
        provenance,
      );
      union.set(term.termId, entry);
    }
  }

  const terms: PreviewInvestigationTerm[] = [...union.values()]
    .map(({ term, provenance }) => ({
      termId: term.termId,
      kind: term.kind,
      value: term.value,
      matching: term.matching,
      provenance: [...provenance.values()].sort(compareProvenance),
    }))
    .sort((left, right) => (left.termId < right.termId ? -1 : 1));

  const violations: InvestigationTermUnionViolation[] = [];
  addLimitViolation(
    violations,
    'MAIN_TERM_LIMIT_EXCEEDED',
    limits.maxMainTerms,
    rawCounts.main,
  );
  addLimitViolation(
    violations,
    'SURVEY_TERM_LIMIT_EXCEEDED',
    limits.maxSurveyTerms,
    rawCounts.survey,
  );
  addLimitViolation(
    violations,
    'REVIEWER_TERM_LIMIT_EXCEEDED',
    limits.maxReviewerTerms,
    rawCounts.reviewer,
  );
  addLimitViolation(
    violations,
    'EFFECTIVE_TERM_LIMIT_EXCEEDED',
    limits.maxEffectiveTerms,
    terms.length,
  );
  violations.sort((left, right) => (left.code < right.code ? -1 : 1));

  const preview: InvestigationTermUnionPreview =
    violations.length > 0
      ? { outcome: 'requires-narrowing', rawCounts, terms, violations }
      : { outcome: 'ready', rawCounts, terms };
  return deepFreeze(preview);
}

function addLimitViolation(
  violations: InvestigationTermUnionViolation[],
  code: InvestigationTermUnionViolation['code'],
  limit: number,
  observed: number,
): void {
  if (observed > limit) {
    violations.push({ code, limit, observed });
  }
}

function compareProvenance(
  left: InvestigationTermProvenance,
  right: InvestigationTermProvenance,
): number {
  if (left.source !== right.source) {
    return left.source < right.source ? -1 : 1;
  }
  if (left.reference === right.reference) {
    return 0;
  }
  return left.reference < right.reference ? -1 : 1;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function termInvalid() {
  return workflowError(
    'INVESTIGATION_TERM_INVALID',
    'Investigation term kind or value is invalid.',
    ExitCode.usage,
  );
}
