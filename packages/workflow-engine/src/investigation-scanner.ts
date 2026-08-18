import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { canonicalJson } from './canonical-json.ts';
import { createEvidenceNode, type EvidenceNode } from './evidence-node.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  assertInvestigationLimits,
  INVESTIGATION_LIMITS,
  normalizeInvestigationTerm,
  type InvestigationLimits,
  type InvestigationTermProvenance,
  type NormalizedInvestigationTerm,
} from './investigation-terms.ts';
import {
  readPinnedTrackedTree,
  type TrackedTreeEntry,
  type TrackedTreeOperationalDeadline,
  type TrackedTreePathIdentity,
  type TrackedTreeSkipReason,
  type TrackedTreeSnapshot,
} from './tracked-tree-reader.ts';

const NODE_TYPE = 'investigation-term-scan';
const NODE_SCHEMA = 'investigation.term-scan.v1';
const NODE_EVALUATOR = 'investigation-scanner.v1';
const OUTPUT_SCHEMA = 'investigation.term-scan-output.v1';
const INVENTORY_NODE_TYPE = 'investigation-tree-inventory';
const INVENTORY_NODE_SCHEMA = 'investigation.tree-inventory.v1';
const INVENTORY_OUTPUT_SCHEMA = 'investigation.tree-inventory-output.v1';
const POLICY_SCHEMA = 'investigation-scan-policy.v1';
const TERM_DIGEST_SCHEMA = 'investigation-term-input-v1';

/**
 * A sealed term as consumed by the scanner: its normalized identity plus the
 * retained union provenance. Provenance never affects node identity; the node is
 * bound to the semantic term, the pinned tree, and the effective scan policy.
 */
export type ScanInvestigationTerm = NormalizedInvestigationTerm & {
  provenance: InvestigationTermProvenance[];
};

/**
 * Stable pinned object identity carried by every scan hit so Task 3.2 grouping
 * and the exact-blob WHY task can bind matches to their exact source object. A
 * skipped object still yields `literal-path` hits: scanned text carries a
 * SHA-256 and a null `skipReason`; a skipped path carries a null SHA-256 and its
 * exact reason.
 */
export type ScanHitSourceObject = {
  objectId: string;
  objectType: string;
  mode: string;
  byteSize: number | null;
  contentSha256: string | null;
  skipReason: TrackedTreeSkipReason | null;
};

/**
 * The bytes surrounding a content hit, so a class predicate can be replayed
 * later as a pure recomputation over stored evidence rather than by reopening
 * the repository. Bounded on purpose: a minified bundle is one enormous line,
 * and storing it whole would put the file back into the evidence this exists
 * to avoid.
 */
export type ScanHitContextWindow = {
  rawBase64: string;
  utf8: string | null;
  byteOffset: number;
  byteLength: number;
  truncated: boolean;
};

export type ScanHit = {
  path: TrackedTreePathIdentity;
  sourceObject: ScanHitSourceObject;
  surface: 'path' | 'content';
  byteOffset: number;
  byteLength: number;
  /**
   * Present for content hits only. A path-surface hit has no content to quote,
   * so it can never satisfy a predicate and can never join a class.
   */
  contextWindow?: ScanHitContextWindow;
};

export const SCAN_HIT_MAX_CONTEXT_BYTES = 512;

export function hitContextWindow(
  haystack: Buffer,
  byteOffset: number,
  byteLength: number,
): ScanHitContextWindow | null {
  if (
    !Number.isSafeInteger(byteOffset) ||
    !Number.isSafeInteger(byteLength) ||
    byteOffset < 0 ||
    byteLength <= 0 ||
    byteOffset + byteLength > haystack.length
  ) {
    return null;
  }
  const lineStart = haystack.lastIndexOf(0x0a, byteOffset) + 1;
  let lineEnd = haystack.indexOf(0x0a, byteOffset + byteLength - 1);
  if (lineEnd === -1) lineEnd = haystack.length;
  if (lineEnd > lineStart && haystack[lineEnd - 1] === 0x0d) lineEnd -= 1;

  let start = lineStart;
  let end = lineEnd;
  let truncated = false;
  if (end - start > SCAN_HIT_MAX_CONTEXT_BYTES) {
    // Keep the hit itself centred; a window that dropped the match would prove
    // nothing about the match.
    truncated = true;
    const slack =
      SCAN_HIT_MAX_CONTEXT_BYTES -
      Math.min(byteLength, SCAN_HIT_MAX_CONTEXT_BYTES);
    const before = Math.floor(slack / 2);
    start = Math.max(lineStart, byteOffset - before);
    end = Math.min(lineEnd, start + SCAN_HIT_MAX_CONTEXT_BYTES);
    start = Math.max(lineStart, end - SCAN_HIT_MAX_CONTEXT_BYTES);
  }
  const bytes = haystack.subarray(start, end);
  const utf8 = bytes.toString('utf8');
  return {
    rawBase64: bytes.toString('base64'),
    utf8: Buffer.compare(Buffer.from(utf8, 'utf8'), bytes) === 0 ? utf8 : null,
    byteOffset: start,
    byteLength: bytes.length,
    truncated,
  };
}

export type ScanSkippedObject = {
  path: { rawBase64: string; utf8: string | null };
  objectId: string;
  objectType: string;
  mode: string;
  byteSize: number | null;
  reason: TrackedTreeSkipReason;
};

export type ScanInventoryFacts = {
  treeDigest: string;
  skippedObjects: readonly ScanSkippedObject[];
};

export type InvestigationScanTermFacts = {
  term: ScanInvestigationTerm;
  hits: ScanHit[];
};

/**
 * Deterministic scanner output before any legacy evidence envelope is built.
 * This is the scanner boundary consumed by the manifest-first v3 writer.
 */
export type InvestigationScanFacts = {
  schemaVersion: 1;
  kind: 'investigation-scan-facts';
  treeDigest: string;
  policyDigest: string;
  inventory: ScanInventoryFacts;
  terms: InvestigationScanTermFacts[];
};

export type ScanInventory = {
  treeDigest: string;
  skippedObjects: readonly ScanSkippedObject[];
  evidenceNode: EvidenceNode;
};

export type ScanViolation = {
  code:
    | 'TERM_HIT_LIMIT_EXCEEDED'
    | 'TOTAL_HIT_LIMIT_EXCEEDED'
    | 'HIT_DISPOSITION_WORK_LIMIT_EXCEEDED'
    | 'SCANNED_BYTE_LIMIT_EXCEEDED'
    | 'SCAN_WORK_LIMIT_EXCEEDED';
  termId?: string;
};

export type ReadyScanResult = {
  outcome: 'ready';
  nodes: EvidenceNode[];
  inventory: ScanInventory;
  /**
   * Terms whose hits were truncated at their ceiling. Present only when the
   * caller accepted saturation; their semantic domain may not be compressed
   * into a class disposition, because a truncated term cannot show that the
   * members it did find are all of them.
   */
  saturatedTermIds?: string[];
};

export type NarrowingScanResult = {
  outcome: 'requires-narrowing';
  nodes: [];
  inventory: ScanInventory;
  violations: ScanViolation[];
  terms: ScanInvestigationTerm[];
};

export type InvestigationScanResult = ReadyScanResult | NarrowingScanResult;

export type ReadyScanFactsResult = {
  outcome: 'ready';
  facts: InvestigationScanFacts;
  saturatedTermIds?: string[];
};

export type NarrowingScanFactsResult = {
  outcome: 'requires-narrowing';
  policyDigest: string;
  inventory: ScanInventoryFacts;
  violations: ScanViolation[];
  terms: ScanInvestigationTerm[];
};

export type InvestigationScanFactsResult =
  ReadyScanFactsResult | NarrowingScanFactsResult;

/**
 * Deterministically scan every sealed term against the pinned Git-tracked tree
 * and emit one independent EvidenceNode per term, sorted by term ID so caller
 * order is irrelevant. Each node is bound to the semantic term, the pinned tree
 * digest, and the effective (lower-only) scan policy — not term provenance. The
 * scanner reads only the pinned object graph — never task `allowedPaths`,
 * working-tree files, recognized environment files, a shell, or the caller PATH
 * — and matches exact literal bytes with no regex. Each supplied term is
 * revalidated by recomputation; a forged term field or duplicate term ID fails
 * closed. A per-term, aggregate, work, or scanned-byte overage returns typed
 * `requires-narrowing` with the original terms and no partial nodes.
 */
export function scanInvestigationTreeFacts(request: {
  repositoryRoot: string;
  treeOid: string;
  terms: ScanInvestigationTerm[];
  limits?: InvestigationLimits;
  /**
   * Accept a term that hit its own ceiling instead of refusing the scan.
   *
   * Off by default, because a truncated term is a search that cannot claim to
   * be complete and silently proceeding would let that claim be made anyway.
   * A caller that opts in is told which terms saturated, and the class
   * compression that would have relied on their completeness is refused for
   * exactly those terms — which is what makes carrying on honest rather than
   * merely convenient.
   */
  allowSaturatedTerms?: boolean;
}): InvestigationScanFactsResult {
  const { repositoryRoot, treeOid, terms } = request;
  const allowSaturatedTerms = request.allowSaturatedTerms === true;
  const limits = assertInvestigationLimits(
    request.limits ?? { ...INVESTIGATION_LIMITS },
  );
  assertScanTerms(terms);
  if (terms.length > limits.maxEffectiveTerms) {
    throw scanInvalid(
      'Supplied terms exceed the effective-term limit and are not a sealed union.',
    );
  }

  const operationalDeadline: TrackedTreeOperationalDeadline = {
    expiresAtMonotonicMillis: performance.now() + limits.maxScanCpuMillis,
  };
  const scanCpuStart = process.cpuUsage();
  const snapshot = readPinnedTrackedTree({
    repositoryRoot,
    treeOid,
    limits: {
      maxBlobBytes: limits.maxBlobBytes,
      maxTotalScannedBytes: limits.maxTotalScannedBlobBytes,
    },
    operationalDeadline,
  });
  assertOperationalScanBudget(
    operationalDeadline,
    scanCpuStart,
    limits.maxScanCpuMillis,
  );

  const policyDigest = computePolicyDigest(limits);
  const inventory = buildInventoryFacts(snapshot);
  const violations: ScanViolation[] = [];
  if (snapshot.budgetExceeded) {
    violations.push({ code: 'SCANNED_BYTE_LIMIT_EXCEEDED' });
  }

  // Semantic narrowing uses a deterministic byte-work ceiling. The separate
  // operational wall/CPU watchdog throws without returning evidence, so
  // runtime/JIT speed can never change canonical scan output.
  let remainingScanWork = limits.maxScanWorkBytes;
  const perTermHits: ScanHit[][] = [];
  let totalHits = 0;
  for (const term of terms) {
    const collected = collectTermHits(
      term,
      snapshot.entries,
      limits.maxHitsPerTerm,
      remainingScanWork,
      operationalDeadline,
      scanCpuStart,
      limits.maxScanCpuMillis,
    );
    if (collected.workLimitExceeded) {
      violations.push({ code: 'SCAN_WORK_LIMIT_EXCEEDED' });
      break;
    }
    remainingScanWork -= collected.workBytes;
    const { hits } = collected;
    if (hits.length > limits.maxHitsPerTerm) {
      violations.push({ code: 'TERM_HIT_LIMIT_EXCEEDED', termId: term.termId });
    }
    totalHits += hits.length;
    perTermHits.push(hits);
  }
  if (totalHits > limits.maxTotalHits) {
    violations.push({ code: 'TOTAL_HIT_LIMIT_EXCEEDED' });
  }
  if (totalHits > limits.maxHitDispositionWorkItems) {
    violations.push({ code: 'HIT_DISPOSITION_WORK_LIMIT_EXCEEDED' });
  }

  assertOperationalScanBudget(
    operationalDeadline,
    scanCpuStart,
    limits.maxScanCpuMillis,
  );
  // A term that hit its own ceiling is the one violation a caller can carry,
  // because the hits it did collect remain true — only their completeness is
  // lost. Every other violation means the scan itself is not sound, so none of
  // them are eligible for this exit.
  const saturatedTermIds = violations
    .filter(({ code }) => code === 'TERM_HIT_LIMIT_EXCEEDED')
    .map(({ termId }) => termId)
    .filter((termId): termId is string => termId !== undefined)
    .sort();
  const onlySaturation =
    saturatedTermIds.length > 0 &&
    violations.every(({ code }) => code === 'TERM_HIT_LIMIT_EXCEEDED');

  if (violations.length > 0 && !(allowSaturatedTerms && onlySaturation)) {
    violations.sort(compareViolations);
    return {
      outcome: 'requires-narrowing',
      policyDigest,
      inventory,
      violations,
      terms,
    };
  }

  const saturated = allowSaturatedTerms ? saturatedTermIds : [];
  const termFacts = terms
    .map((term, index) => ({
      term: structuredClone(term),
      hits: structuredClone(perTermHits[index]!),
    }))
    .sort((left, right) => (left.term.termId < right.term.termId ? -1 : 1));

  return {
    outcome: 'ready',
    facts: {
      schemaVersion: 1,
      kind: 'investigation-scan-facts',
      treeDigest: snapshot.treeDigest,
      policyDigest,
      inventory,
      terms: termFacts,
    },
    ...(saturated.length === 0 ? {} : { saturatedTermIds: saturated }),
  };
}

/**
 * Compatibility adapter for the schema-v2 shadow authority. New manifest
 * construction consumes `scanInvestigationTreeFacts` directly and never needs
 * these generic evidence envelopes.
 */
export function scanInvestigationTree(request: {
  repositoryRoot: string;
  treeOid: string;
  terms: ScanInvestigationTerm[];
  limits?: InvestigationLimits;
  allowSaturatedTerms?: boolean;
}): InvestigationScanResult {
  return adaptInvestigationScanFactsResult(scanInvestigationTreeFacts(request));
}

/**
 * Build the temporary schema-v2 evidence view from one already-computed domain
 * scan. Shadow mode calls this adapter so v2 and v3 observe the same scanner
 * execution instead of independently reopening Git and merely hoping that two
 * executions had equivalent inputs.
 */
export function adaptInvestigationScanFactsResult(
  result: InvestigationScanFactsResult,
): InvestigationScanResult {
  if (result.outcome !== 'ready') {
    return {
      outcome: 'requires-narrowing',
      nodes: [],
      inventory: adaptInventoryFacts(result.inventory, result.policyDigest),
      violations: result.violations,
      terms: result.terms,
    };
  }
  const { facts } = result;
  const nodes = facts.terms
    .map(({ term, hits }) =>
      buildScanNode(term, hits, facts.treeDigest, facts.policyDigest),
    )
    .sort((left, right) =>
      scanNodeTermId(left) < scanNodeTermId(right) ? -1 : 1,
    );
  return {
    outcome: 'ready',
    nodes,
    inventory: adaptInventoryFacts(facts.inventory, facts.policyDigest),
    ...(result.saturatedTermIds === undefined
      ? {}
      : { saturatedTermIds: [...result.saturatedTermIds] }),
  };
}

function assertScanTerms(terms: ScanInvestigationTerm[]): void {
  const seen = new Set<string>();
  for (const term of terms) {
    let recomputed: NormalizedInvestigationTerm;
    try {
      recomputed = normalizeInvestigationTerm({
        kind: term.kind,
        value: term.value,
      });
    } catch {
      throw scanInvalid('Supplied term is not a valid normalized term.');
    }
    if (
      recomputed.termId !== term.termId ||
      recomputed.matching !== term.matching
    ) {
      throw scanInvalid('Supplied term identity does not match its fields.');
    }
    if (seen.has(term.termId)) {
      throw scanInvalid('Duplicate term ID supplied to scan.');
    }
    seen.add(term.termId);
  }
}

function collectTermHits(
  term: ScanInvestigationTerm,
  entries: TrackedTreeEntry[],
  maxHitsPerTerm: number,
  workBudget: number,
  operationalDeadline: TrackedTreeOperationalDeadline,
  scanCpuStart: NodeJS.CpuUsage,
  maxScanCpuMillis: number,
): {
  hits: ScanHit[];
  workBytes: number;
  workLimitExceeded: boolean;
} {
  const needle = Buffer.from(term.value, 'utf8');
  const hits: ScanHit[] = [];
  const cap = maxHitsPerTerm + 1;
  let workBytes = 0;

  for (const entry of entries) {
    assertOperationalScanBudget(
      operationalDeadline,
      scanCpuStart,
      maxScanCpuMillis,
    );
    const sourceObject = entrySourceObject(entry);
    // A skipped blob suppresses content scanning but never path scanning:
    // `literal-path` still matches the raw tracked path bytes of every entry.
    if (term.kind === 'literal-path') {
      const pathBytes = Buffer.from(entry.path.rawBase64, 'base64');
      if (workBytes + pathBytes.byteLength > workBudget) {
        return { hits: [], workBytes, workLimitExceeded: true };
      }
      workBytes += pathBytes.byteLength;
      for (const offset of findOccurrences(
        pathBytes,
        needle,
        operationalDeadline,
        scanCpuStart,
        maxScanCpuMillis,
      )) {
        hits.push(makeHit(entry.path, sourceObject, 'path', offset, needle));
        if (hits.length >= cap) {
          return {
            hits: sortHits(hits),
            workBytes,
            workLimitExceeded: false,
          };
        }
      }
    }
    if (entry.content !== undefined) {
      if (workBytes + entry.content.byteLength > workBudget) {
        return { hits: [], workBytes, workLimitExceeded: true };
      }
      workBytes += entry.content.byteLength;
      for (const offset of findOccurrences(
        entry.content,
        needle,
        operationalDeadline,
        scanCpuStart,
        maxScanCpuMillis,
      )) {
        hits.push(
          makeHit(
            entry.path,
            sourceObject,
            'content',
            offset,
            needle,
            entry.content,
          ),
        );
        if (hits.length >= cap) {
          return {
            hits: sortHits(hits),
            workBytes,
            workLimitExceeded: false,
          };
        }
      }
    }
  }

  return {
    hits: sortHits(hits),
    workBytes,
    workLimitExceeded: false,
  };
}

function entrySourceObject(entry: TrackedTreeEntry): ScanHitSourceObject {
  return {
    objectId: entry.objectId,
    objectType: entry.objectType,
    mode: entry.mode,
    byteSize: entry.byteSize,
    contentSha256: entry.contentSha256 ?? null,
    skipReason: entry.skipReason ?? null,
  };
}

function makeHit(
  path: TrackedTreePathIdentity,
  sourceObject: ScanHitSourceObject,
  surface: 'path' | 'content',
  byteOffset: number,
  needle: Buffer,
  haystack?: Buffer,
): ScanHit {
  const contextWindow =
    surface === 'content' && haystack !== undefined
      ? hitContextWindow(haystack, byteOffset, needle.length)
      : null;
  return {
    path: { rawBase64: path.rawBase64, utf8: path.utf8 },
    sourceObject,
    surface,
    byteOffset,
    byteLength: needle.length,
    ...(contextWindow === null ? {} : { contextWindow }),
  };
}

function* findOccurrences(
  haystack: Buffer,
  needle: Buffer,
  operationalDeadline: TrackedTreeOperationalDeadline,
  scanCpuStart: NodeJS.CpuUsage,
  maxScanCpuMillis: number,
): Generator<number> {
  let from = 0;
  for (;;) {
    assertOperationalScanBudget(
      operationalDeadline,
      scanCpuStart,
      maxScanCpuMillis,
    );
    const index = haystack.indexOf(needle, from);
    assertOperationalScanBudget(
      operationalDeadline,
      scanCpuStart,
      maxScanCpuMillis,
    );
    if (index === -1) {
      break;
    }
    yield index;
    // Advance by one byte so overlapping occurrences are all reported
    // (for example `ZXZ` occurs at offsets 0 and 2 within `ZXZXZ`).
    from = index + 1;
  }
}

function sortHits(hits: ScanHit[]): ScanHit[] {
  return hits.sort((left, right) => {
    const pathOrder = Buffer.compare(
      Buffer.from(left.path.rawBase64, 'base64'),
      Buffer.from(right.path.rawBase64, 'base64'),
    );
    if (pathOrder !== 0) {
      return pathOrder;
    }
    if (left.surface !== right.surface) {
      return left.surface < right.surface ? -1 : 1;
    }
    return left.byteOffset - right.byteOffset;
  });
}

function buildScanNode(
  term: ScanInvestigationTerm,
  hits: ScanHit[],
  treeDigest: string,
  policyDigest: string,
): EvidenceNode {
  const output = {
    termId: term.termId,
    // The window travels with the hit it describes. A class predicate is a
    // claim about what the search found, and it can only be rechecked later if
    // the evidence carries the text the claim was made against; keeping the
    // window in memory alone left every such claim unverifiable.
    hits: hits.map((hit) => ({
      path: { rawBase64: hit.path.rawBase64, utf8: hit.path.utf8 },
      sourceObject: hit.sourceObject,
      surface: hit.surface,
      byteOffset: hit.byteOffset,
      byteLength: hit.byteLength,
      ...(hit.contextWindow === undefined
        ? {}
        : { contextWindow: hit.contextWindow }),
    })),
  };
  return createEvidenceNode({
    type: NODE_TYPE,
    nodeSchema: NODE_SCHEMA,
    evaluator: NODE_EVALUATOR,
    policyDigest,
    exactInputDigests: {
      term: sha256(
        canonicalJson({
          schema: TERM_DIGEST_SCHEMA,
          termId: term.termId,
          kind: term.kind,
          value: term.value,
          matching: term.matching,
        }),
      ),
      tree: treeDigest,
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: OUTPUT_SCHEMA,
    output,
    runtimeMetadata: {},
  });
}

function buildInventoryFacts(
  snapshot: TrackedTreeSnapshot,
): ScanInventoryFacts {
  const skippedObjects = snapshot.entries
    .filter((entry) => entry.skipReason !== undefined)
    .map((entry) => ({
      path: { rawBase64: entry.path.rawBase64, utf8: entry.path.utf8 },
      objectId: entry.objectId,
      objectType: entry.objectType,
      mode: entry.mode,
      byteSize: entry.byteSize,
      reason: entry.skipReason!,
    }));
  return {
    treeDigest: snapshot.treeDigest,
    skippedObjects,
  };
}

function adaptInventoryFacts(
  facts: ScanInventoryFacts,
  policyDigest: string,
): ScanInventory {
  return {
    treeDigest: facts.treeDigest,
    skippedObjects: structuredClone(facts.skippedObjects),
    evidenceNode: createEvidenceNode({
      type: INVENTORY_NODE_TYPE,
      nodeSchema: INVENTORY_NODE_SCHEMA,
      evaluator: NODE_EVALUATOR,
      policyDigest,
      exactInputDigests: { tree: facts.treeDigest },
      semanticParentResultDigests: {},
      provenanceParentNodeIds: {},
      outputSchema: INVENTORY_OUTPUT_SCHEMA,
      output: { skippedObjects: facts.skippedObjects },
      runtimeMetadata: {},
    }),
  };
}

function computePolicyDigest(limits: InvestigationLimits): string {
  return sha256(
    canonicalJson({
      schema: POLICY_SCHEMA,
      limits: {
        maxHitsPerTerm: limits.maxHitsPerTerm,
        maxTotalHits: limits.maxTotalHits,
        maxHitDispositionWorkItems: limits.maxHitDispositionWorkItems,
        maxScanWorkBytes: limits.maxScanWorkBytes,
        maxBlobBytes: limits.maxBlobBytes,
        maxTotalScannedBlobBytes: limits.maxTotalScannedBlobBytes,
      },
    }),
  );
}

function scanNodeTermId(node: EvidenceNode): string {
  return (node.output as { termId: string }).termId;
}

function compareViolations(left: ScanViolation, right: ScanViolation): number {
  if (left.code !== right.code) {
    return left.code < right.code ? -1 : 1;
  }
  return (left.termId ?? '') < (right.termId ?? '') ? -1 : 1;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function scanInvalid(message: string) {
  return workflowError('INVESTIGATION_SCAN_INVALID', message, ExitCode.usage);
}

function assertOperationalScanBudget(
  deadline: TrackedTreeOperationalDeadline,
  cpuStart: NodeJS.CpuUsage,
  maxCpuMillis: number,
): void {
  const cpu = process.cpuUsage(cpuStart);
  if (
    performance.now() >= deadline.expiresAtMonotonicMillis ||
    cpu.user + cpu.system >= maxCpuMillis * 1000
  ) {
    throw workflowError(
      'INVESTIGATION_SCAN_TIMEOUT',
      'Investigation scan exceeded its operational wall/CPU deadline.',
      ExitCode.unsafeEnvironment,
      { details: { limitMillis: maxCpuMillis } },
    );
  }
}
