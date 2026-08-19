import path from 'node:path';

import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';
import { runGitBuffer } from '../../../git.ts';
import {
  normalizeInvestigationTerm,
  type InvestigationTermKind,
} from './investigation-terms.ts';

const OBJECT_ID_PATTERN = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The exact machine-readable derivation categories the engine floor checks. The
 * list is reported verbatim (sorted) when nothing is derivable so a caller can
 * see every category that was considered empty.
 */
const CHECKED_CATEGORIES = [
  'changedPaths',
  'configKeys',
  'explicitPaths',
  'reviewedCounterparts',
  'symbols',
  'transformations',
] as const;

export type TransformationFact = {
  kind: InvestigationTermKind;
  before: string;
  after: string;
  reference: string;
};

export type ChangedPathFact =
  | { change: 'removed'; before: string; reference: string }
  | { change: 'renamed'; before: string; after: string; reference: string };

export type ReviewedCounterpartFact = {
  kind: InvestigationTermKind;
  value: string;
  subject: string;
  reference: string;
};

/**
 * The machine-readable facts from which the deterministic engine floor is
 * derived. Every qualifying fact must map to its required term; an incomplete or
 * empty floor over non-empty facts fails validation.
 */
export type EngineFloorFacts = {
  explicitPaths: string[];
  symbols: string[];
  configKeys: string[];
  transformations: TransformationFact[];
  changedPaths: ChangedPathFact[];
  reviewedCounterparts: ReviewedCounterpartFact[];
};

export type EngineFloorTerm = {
  termId: string;
  kind: InvestigationTermKind;
  value: string;
  matching: 'case-sensitive-literal-v1';
  provenance: Array<{ source: 'engine-floor' }>;
};

export type EngineFloorDerivation = {
  termId: string;
  kind: InvestigationTermKind;
  value: string;
  rule: string;
  sourceReference: string;
  subject?: string;
};

export type EngineFloor =
  | {
      outcome: 'derived';
      breadthContribution: true;
      terms: EngineFloorTerm[];
      derivations: EngineFloorDerivation[];
    }
  | {
      outcome: 'no-derivable-floor-facts';
      breadthContribution: false;
      checkedCategories: string[];
    };

type Derivation = {
  kind: InvestigationTermKind;
  value: string;
  rule: string;
  sourceReference: string;
  subject?: string;
};

/**
 * Derive the non-removable engine search floor from machine-readable facts:
 * explicit paths, symbols, and config keys; both transformation identifiers;
 * renamed/removed basenames and POSIX stems; and reviewed generated/mirror
 * counterparts. Every derivation retains its exact `sourceReference`, and a
 * reviewed counterpart additionally retains its `subject` — which must be
 * reachable from a non-counterpart derivation or an order-independent
 * counterpart chain. An orphan or cyclic-only counterpart, and any incomplete
 * floor over non-empty facts, fail closed. If no fact qualifies, a typed
 * `no-derivable-floor-facts` result names every checked category.
 */
export function deriveEngineFloor(facts: EngineFloorFacts): EngineFloor {
  const derivations = collectDerivations(facts);
  if (derivations.length === 0) {
    return {
      outcome: 'no-derivable-floor-facts',
      breadthContribution: false,
      checkedCategories: [...CHECKED_CATEGORIES],
    };
  }
  assertCounterpartsGrounded(derivations);

  const termsById = new Map<string, EngineFloorTerm>();
  const termDerivations: EngineFloorDerivation[] = [];
  for (const derivation of derivations) {
    const normalized = normalizeInvestigationTerm({
      kind: derivation.kind,
      value: derivation.value,
    });
    if (!termsById.has(normalized.termId)) {
      termsById.set(normalized.termId, {
        termId: normalized.termId,
        kind: normalized.kind,
        value: normalized.value,
        matching: normalized.matching,
        provenance: [{ source: 'engine-floor' }],
      });
    }
    termDerivations.push({
      termId: normalized.termId,
      kind: normalized.kind,
      value: normalized.value,
      rule: derivation.rule,
      sourceReference: derivation.sourceReference,
      ...(derivation.subject !== undefined
        ? { subject: derivation.subject }
        : {}),
    });
  }

  return {
    outcome: 'derived',
    breadthContribution: true,
    terms: [...termsById.values()].sort((left, right) =>
      left.termId < right.termId ? -1 : 1,
    ),
    derivations: termDerivations.sort(compareDerivations),
  };
}

/**
 * Revalidate an engine floor by recomputing its canonical bytes from the source
 * facts. A floor that drops, adds, or alters any derived term or derivation no
 * longer matches the recomputation and fails closed.
 */
export function validateEngineFloor(
  facts: EngineFloorFacts,
  floor: EngineFloor,
): EngineFloor {
  const recomputed = deriveEngineFloor(facts);
  if (canonicalJson(recomputed) !== canonicalJson(floor)) {
    throw floorInvalid(
      'Engine floor does not match its recomputed canonical derivation.',
    );
  }
  return floor;
}

/**
 * Derive rename and removal path facts from an exact pinned commit range using a
 * NUL-safe, binary-safe name-status diff. Only full commit object IDs are
 * accepted; a symbolic ref such as `HEAD` is rejected. Malformed or invalid-UTF8
 * path records fail closed rather than silently replacing bytes. The current
 * worktree and any commit beyond the target are never consulted.
 */
export function derivePinnedDiffPathFacts(request: {
  repositoryRoot: string;
  baseCommit: string;
  targetCommit: string;
}): ChangedPathFact[] {
  const { repositoryRoot, baseCommit, targetCommit } = request;
  if (
    !OBJECT_ID_PATTERN.test(baseCommit) ||
    !OBJECT_ID_PATTERN.test(targetCommit)
  ) {
    throw diffInvalid(
      'Pinned diff requires exact full base and target commit object IDs.',
    );
  }

  const output = runGitBuffer(repositoryRoot, [
    'diff',
    '--name-status',
    '--find-renames=50%',
    '-l0',
    '--diff-algorithm=myers',
    '--no-indent-heuristic',
    '--diff-filter=RD',
    '-z',
    baseCommit,
    targetCommit,
    '--',
  ]);
  if (output.length > 0 && output[output.length - 1] !== 0x00) {
    throw diffInvalid('Pinned diff output is not NUL-terminated.');
  }
  const tokens = splitNulStrict(output);

  const facts: ChangedPathFact[] = [];
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index]!;
    if (status.startsWith('R')) {
      const before = tokens[index + 1];
      const after = tokens[index + 2];
      if (before === undefined || after === undefined) {
        throw diffInvalid('Truncated rename record in pinned diff.');
      }
      index += 3;
      facts.push({
        change: 'renamed',
        before,
        after,
        reference: `${baseCommit}..${targetCommit}:R:${before}:${after}`,
      });
    } else if (status.startsWith('D')) {
      const before = tokens[index + 1];
      if (before === undefined) {
        throw diffInvalid('Truncated delete record in pinned diff.');
      }
      index += 2;
      facts.push({
        change: 'removed',
        before,
        reference: `${baseCommit}..${targetCommit}:D:${before}`,
      });
    } else {
      throw diffInvalid(`Unexpected diff status: ${status}`);
    }
  }

  return facts.sort((left, right) =>
    Buffer.compare(Buffer.from(left.before), Buffer.from(right.before)),
  );
}

function collectDerivations(facts: EngineFloorFacts): Derivation[] {
  const derivations: Derivation[] = [];

  for (const explicitPath of facts.explicitPaths) {
    derivations.push({
      kind: 'literal-path',
      value: explicitPath,
      rule: 'explicit-path',
      sourceReference: `intent:explicit-path:${explicitPath}`,
    });
  }
  for (const symbol of facts.symbols) {
    derivations.push({
      kind: 'symbol',
      value: symbol,
      rule: 'symbol',
      sourceReference: `intent:symbol:${symbol}`,
    });
  }
  for (const configKey of facts.configKeys) {
    derivations.push({
      kind: 'config-key',
      value: configKey,
      rule: 'config-key',
      sourceReference: `intent:config-key:${configKey}`,
    });
  }
  for (const transformation of facts.transformations) {
    derivations.push({
      kind: transformation.kind,
      value: transformation.before,
      rule: 'transformation-before',
      sourceReference: transformation.reference,
    });
    derivations.push({
      kind: transformation.kind,
      value: transformation.after,
      rule: 'transformation-after',
      sourceReference: transformation.reference,
    });
  }
  for (const changedPath of facts.changedPaths) {
    if (changedPath.change === 'removed') {
      addPathIdentifierDerivations(
        derivations,
        changedPath.before,
        'removed',
        changedPath.reference,
      );
    } else {
      addPathIdentifierDerivations(
        derivations,
        changedPath.before,
        'renamed-before',
        changedPath.reference,
      );
      addPathIdentifierDerivations(
        derivations,
        changedPath.after,
        'renamed-after',
        changedPath.reference,
      );
    }
  }
  for (const counterpart of facts.reviewedCounterparts) {
    derivations.push({
      kind: counterpart.kind,
      value: counterpart.value,
      rule: 'reviewed-counterpart',
      sourceReference: counterpart.reference,
      subject: counterpart.subject,
    });
  }

  return derivations;
}

function addPathIdentifierDerivations(
  derivations: Derivation[],
  changedPath: string,
  role: string,
  sourceReference: string,
): void {
  const basename = path.posix.basename(changedPath);
  const extension = path.posix.extname(basename);
  const stem = extension ? basename.slice(0, -extension.length) : basename;
  derivations.push({
    kind: 'literal-path',
    value: basename,
    rule: `${role}-basename`,
    sourceReference,
  });
  if (stem.length > 0 && stem !== basename) {
    derivations.push({
      kind: 'literal-content',
      value: stem,
      rule: `${role}-stem`,
      sourceReference,
    });
  }
}

/**
 * A reviewed counterpart mirrors a subject; it is admissible only when that
 * subject is itself derived — either directly by a non-counterpart derivation or
 * transitively through another admissible counterpart. Grounding is computed to
 * a fixpoint so input order is irrelevant, and an orphan or cyclic-only subject
 * fails closed.
 */
function assertCounterpartsGrounded(derivations: Derivation[]): void {
  const grounded = new Set<string>();
  for (const derivation of derivations) {
    if (derivation.rule !== 'reviewed-counterpart') {
      grounded.add(derivation.value);
    }
  }
  const counterparts = derivations.filter(
    (derivation) => derivation.rule === 'reviewed-counterpart',
  );
  let progress = true;
  while (progress) {
    progress = false;
    for (const counterpart of counterparts) {
      if (
        !grounded.has(counterpart.value) &&
        counterpart.subject !== undefined &&
        grounded.has(counterpart.subject)
      ) {
        grounded.add(counterpart.value);
        progress = true;
      }
    }
  }
  for (const counterpart of counterparts) {
    if (
      counterpart.subject === undefined ||
      !grounded.has(counterpart.subject)
    ) {
      throw floorInvalid(
        `Reviewed counterpart subject is not reachable: ${String(
          counterpart.subject,
        )}`,
      );
    }
  }
}

function compareDerivations(
  left: EngineFloorDerivation,
  right: EngineFloorDerivation,
): number {
  if (left.termId !== right.termId) {
    return left.termId < right.termId ? -1 : 1;
  }
  if (left.rule !== right.rule) {
    return left.rule < right.rule ? -1 : 1;
  }
  if (left.sourceReference !== right.sourceReference) {
    return left.sourceReference < right.sourceReference ? -1 : 1;
  }
  // Two reviewed-counterpart derivations can share term/rule/sourceReference yet
  // mirror distinct subjects; ordering by subject keeps the canonical floor
  // independent of input order.
  const leftSubject = left.subject ?? '';
  const rightSubject = right.subject ?? '';
  if (leftSubject === rightSubject) {
    return 0;
  }
  return leftSubject < rightSubject ? -1 : 1;
}

function splitNulStrict(buffer: Buffer): string[] {
  const tokens: string[] = [];
  let position = 0;
  while (position < buffer.length) {
    const end = buffer.indexOf(0x00, position);
    if (end === -1) {
      throw diffInvalid('Unterminated pinned diff record.');
    }
    const raw = buffer.subarray(position, end);
    position = end + 1;
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      throw diffInvalid('Invalid UTF-8 path in pinned diff record.');
    }
    tokens.push(decoded);
  }
  return tokens;
}

function floorInvalid(message: string) {
  return workflowError('INVESTIGATION_FLOOR_INVALID', message, ExitCode.usage);
}

function diffInvalid(message: string) {
  return workflowError('PINNED_DIFF_INVALID', message, ExitCode.usage);
}
