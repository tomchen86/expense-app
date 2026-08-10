import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import type { InvestigationArtifact } from './contracts.ts';
import {
  assertStoredEvidenceNode,
  type EvidenceNode,
} from './evidence-node.ts';
import { ExitCode, workflowError } from './errors.ts';
import { runGit, runGitWithEnvironment } from './git.ts';
import {
  deriveInvestigationGroups,
  readInvestigationGroupNode,
} from './investigation-groups.ts';
import {
  scanInvestigationTree,
  type ScanInvestigationTerm,
} from './investigation-scanner.ts';
import {
  normalizeInvestigationTerm,
  type InvestigationTermKind,
  type NormalizedInvestigationTerm,
} from './investigation-terms.ts';
import { createMutationClassPolicy } from './mutation-class-policy.ts';

const MAX_FINALIZATION_TERMS = 64;
const DISPOSITION_CLASSIFICATIONS = new Set([
  'load-bearing',
  'test-or-mirror',
  'generated',
  'incidental-reference',
  'irrelevant',
]);
const TERM_ORIGINS = new Set<ImplementationTermOrigin>([
  'added-identifier',
  'deleted-identifier',
  'added-literal',
  'deleted-literal',
  'modified-outer-symbol',
  'alias-one-hop',
]);
const LANGUAGE_KEYWORDS = new Set([
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'of',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

export type ImplementationTermOrigin =
  | 'added-identifier'
  | 'deleted-identifier'
  | 'added-literal'
  | 'deleted-literal'
  | 'modified-outer-symbol'
  | 'alias-one-hop';

export type ImplementationDeltaTerm = NormalizedInvestigationTerm &
  Readonly<{ origins: readonly ImplementationTermOrigin[] }>;

export type ImplementationAffectedGroup = Readonly<{
  groupId: string;
  termId: string;
  rootId: string;
  extension: Readonly<{ rawBase64: string; utf8: string | null }>;
  mutationClass: string;
  hitCount: number;
  paths: readonly string[];
}>;

export type ImplementationTermDelta = Readonly<{
  schemaVersion: 1;
  kind: 'implementation-term-delta';
  baselineCommit: string;
  implementationTree: string;
  knownTermIds: readonly string[];
  newTerms: readonly ImplementationDeltaTerm[];
  scanEvidenceDigest: string;
  affectedGroups: readonly ImplementationAffectedGroup[];
}>;

export type ImplementationTermDisposition = Readonly<{
  groupId: string;
  classification: string;
  rationale: string;
  author: string;
}>;

/**
 * Recompute M-A at the second authority boundary. Only terms extracted from
 * exact implementation hunks are candidates; known planning terms are removed,
 * and the remainder receives one deterministic full-tree scan over a temporary
 * Git tree built from the session baseline plus the exact production paths.
 */
export function deriveImplementationTermDelta(input: {
  repositoryRoot: string;
  baselineCommit: string;
  productionPaths: readonly string[];
  investigation: InvestigationArtifact;
}): ImplementationTermDelta {
  const knownTermIds = readKnownPlanningTermIds(input.investigation);
  const extracted = new Map<
    string,
    {
      term: NormalizedInvestigationTerm;
      origins: Set<ImplementationTermOrigin>;
    }
  >();
  for (const candidatePath of [...input.productionPaths].sort()) {
    const diff = runGit(input.repositoryRoot, [
      'diff',
      '--no-color',
      '--no-renames',
      '--unified=3',
      input.baselineCommit,
      '--',
      candidatePath,
    ]);
    collectHunkTerms(diff, extracted);
  }
  const newTerms = [...extracted.values()]
    .filter(({ term }) => !knownTermIds.includes(term.termId))
    .map(({ term, origins }): ImplementationDeltaTerm =>
      Object.freeze({
        ...term,
        origins: Object.freeze([...origins].sort()),
      }),
    )
    .sort((left, right) => left.termId.localeCompare(right.termId));
  if (newTerms.length > MAX_FINALIZATION_TERMS) {
    throw workflowError(
      'IMPLEMENTATION_TERM_ESCALATION_REQUIRED',
      'Implementation hunks introduced more terms than one bounded incremental review can admit.',
      ExitCode.verification,
      { details: { observed: newTerms.length, limit: MAX_FINALIZATION_TERMS } },
    );
  }
  const implementationTree = materializeImplementationTree(input);
  if (newTerms.length === 0) {
    return deepFreeze({
      schemaVersion: 1,
      kind: 'implementation-term-delta',
      baselineCommit: input.baselineCommit,
      implementationTree,
      knownTermIds,
      newTerms: [],
      scanEvidenceDigest: sha256(canonicalJson([])),
      affectedGroups: [],
    });
  }
  const scanTerms: ScanInvestigationTerm[] = newTerms.map((term) => ({
    termId: term.termId,
    kind: term.kind,
    value: term.value,
    matching: term.matching,
    provenance: [
      {
        source: 'engine',
        reference: 'implementation-finalization-hunk-floor.v1',
        rationale: null,
        expectedRelationship: null,
      },
    ],
  }));
  const scan = scanInvestigationTree({
    repositoryRoot: input.repositoryRoot,
    treeOid: implementationTree,
    terms: scanTerms,
  });
  if (scan.outcome !== 'ready') {
    throw workflowError(
      'IMPLEMENTATION_TERM_ESCALATION_REQUIRED',
      'Implementation term scan exceeded the single bounded incremental round.',
      ExitCode.verification,
      { details: { violations: scan.violations } },
    );
  }
  const grouped = deriveInvestigationGroups({
    scanNodes: scan.nodes,
    mutationPolicy: createMutationClassPolicy({ rules: [] }),
    declaredRoots: [{ rootId: 'repository', path: '' }],
    reviewedRelationships: [],
    exceptions: [],
  });
  const affectedGroups = grouped.groupNodes
    .map((node): ImplementationAffectedGroup => {
      const group = readInvestigationGroupNode(node);
      return Object.freeze({
        groupId: group.groupId,
        termId: group.selector.termId,
        rootId: group.selector.rootId,
        extension: Object.freeze({ ...group.selector.extension }),
        mutationClass: group.selector.mutationClass,
        hitCount: group.hits.length,
        paths: Object.freeze(
          [
            ...new Set(
              group.hits.map(
                ({ path: hitPath }) =>
                  hitPath.utf8 ?? `base64:${hitPath.rawBase64}`,
              ),
            ),
          ].sort(),
        ),
      });
    })
    .sort((left, right) => left.groupId.localeCompare(right.groupId));
  const representedTerms = new Set(affectedGroups.map(({ termId }) => termId));
  for (const term of newTerms) {
    if (representedTerms.has(term.termId)) continue;
    affectedGroups.push(
      Object.freeze({
        groupId: sha256(
          canonicalJson({
            schema: 'implementation-zero-hit-group.v1',
            termId: term.termId,
            tree: implementationTree,
          }),
        ),
        termId: term.termId,
        rootId: 'repository',
        extension: Object.freeze({
          rawBase64: Buffer.from('<zero-hit>', 'utf8').toString('base64'),
          utf8: '<zero-hit>',
        }),
        mutationClass: 'live',
        hitCount: 0,
        paths: Object.freeze([]),
      }),
    );
  }
  affectedGroups.sort((left, right) =>
    left.groupId.localeCompare(right.groupId),
  );
  return deepFreeze({
    schemaVersion: 1,
    kind: 'implementation-term-delta',
    baselineCommit: input.baselineCommit,
    implementationTree,
    knownTermIds,
    newTerms,
    scanEvidenceDigest: sha256(
      canonicalJson({
        nodes: scan.nodes,
        inventory: scan.inventory.evidenceNode,
      }),
    ),
    affectedGroups,
  });
}

export function assertImplementationTermDispositions(
  delta: ImplementationTermDelta,
  value: unknown,
): readonly ImplementationTermDisposition[] {
  if (!Array.isArray(value)) {
    throw termInvalid('Implementation term dispositions must be an array.');
  }
  const expected = new Set(delta.affectedGroups.map(({ groupId }) => groupId));
  const seen = new Set<string>();
  const dispositions = value.map((entry): ImplementationTermDisposition => {
    if (
      !isPlainRecord(entry) ||
      !hasExactKeys(entry, [
        'groupId',
        'classification',
        'rationale',
        'author',
      ]) ||
      typeof entry.groupId !== 'string' ||
      !expected.has(entry.groupId) ||
      seen.has(entry.groupId) ||
      typeof entry.classification !== 'string' ||
      !DISPOSITION_CLASSIFICATIONS.has(entry.classification) ||
      typeof entry.rationale !== 'string' ||
      entry.rationale.trim() !== entry.rationale ||
      entry.rationale.length === 0 ||
      typeof entry.author !== 'string' ||
      entry.author.trim() !== entry.author ||
      entry.author.length === 0
    ) {
      throw workflowError(
        'IMPLEMENTATION_TERM_DISPOSITION_REQUIRED',
        'Every affected implementation-term group requires one typed disposition.',
        ExitCode.verification,
      );
    }
    seen.add(entry.groupId);
    return Object.freeze({
      groupId: entry.groupId,
      classification: entry.classification,
      rationale: entry.rationale,
      author: entry.author,
    });
  });
  dispositions.sort((left, right) => left.groupId.localeCompare(right.groupId));
  if (
    seen.size !== expected.size ||
    canonicalJson(dispositions) !== canonicalJson(value)
  ) {
    throw workflowError(
      'IMPLEMENTATION_TERM_DISPOSITION_REQUIRED',
      'Every affected implementation-term group requires one canonical typed disposition.',
      ExitCode.verification,
    );
  }
  return Object.freeze(dispositions);
}

function readKnownPlanningTermIds(
  investigation: InvestigationArtifact,
): string[] {
  const candidates = investigation.nodes.filter(
    ({ type }) => type === 'investigation-term-union',
  );
  if (candidates.length !== 1) {
    throw termInvalid('The sealed investigation does not name one term union.');
  }
  const node = assertStoredEvidenceNode(candidates[0]!, () =>
    termInvalid('The planning term union is malformed.'),
  );
  if (
    node.nodeSchema !== 'investigation.term-union.v2' ||
    node.evaluator !== 'workflow-propose.term-union.v2' ||
    node.outputSchema !== 'investigation.term-union-output.v2' ||
    !isPlainRecord(node.output) ||
    !hasExactKeys(node.output, ['rawCounts', 'terms']) ||
    !Array.isArray(node.output.terms)
  ) {
    throw termInvalid('The planning term union identity is malformed.');
  }
  const terms = node.output.terms.map((candidate) => {
    if (
      !isPlainRecord(candidate) ||
      !hasExactKeys(candidate, [
        'termId',
        'kind',
        'value',
        'matching',
        'provenance',
      ]) ||
      typeof candidate.kind !== 'string' ||
      typeof candidate.value !== 'string' ||
      typeof candidate.termId !== 'string'
    ) {
      throw termInvalid('A planning term is malformed.');
    }
    const normalized = normalizeInvestigationTerm({
      kind: candidate.kind as InvestigationTermKind,
      value: candidate.value,
    });
    if (
      candidate.termId !== normalized.termId ||
      candidate.matching !== normalized.matching
    ) {
      throw termInvalid('A planning term identity is inconsistent.');
    }
    return candidate;
  });
  if (
    node.exactInputDigests.terms !== sha256(canonicalJson(terms)) ||
    canonicalJson(terms) !==
      canonicalJson(
        [...terms].sort((left, right) =>
          String(left.termId).localeCompare(String(right.termId)),
        ),
      )
  ) {
    throw termInvalid('The planning term union is not canonical.');
  }
  const sealId = investigation.currentRefs.sealedInvestigation;
  const seal = investigation.nodes.find(({ nodeId }) => nodeId === sealId);
  if (
    seal === undefined ||
    seal.provenanceParentNodeIds['term-union'] !== node.nodeId ||
    seal.semanticParentResultDigests['term-union'] !== node.resultDigest
  ) {
    throw termInvalid('The sealed investigation does not bind its term union.');
  }
  return terms.map(({ termId }) => String(termId)).sort();
}

function collectHunkTerms(
  diff: string,
  target: Map<
    string,
    {
      term: NormalizedInvestigationTerm;
      origins: Set<ImplementationTermOrigin>;
    }
  >,
): void {
  let outerSymbol: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      outerSymbol = declarationName(line.slice(line.indexOf('@@', 2) + 2));
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const marker = line[0];
    if (marker !== '+' && marker !== '-' && marker !== ' ') continue;
    const source = line.slice(1);
    const declaration = declarationName(source);
    if (declaration !== null) outerSymbol = declaration;
    if (marker === ' ') continue;
    const added = marker === '+';
    for (const identifier of identifiers(source)) {
      addTerm(
        target,
        'symbol',
        identifier,
        added ? 'added-identifier' : 'deleted-identifier',
      );
    }
    for (const literal of literals(source)) {
      addTerm(
        target,
        'literal-content',
        literal,
        added ? 'added-literal' : 'deleted-literal',
      );
    }
    for (const alias of aliases(source)) {
      addTerm(target, 'symbol', alias, 'alias-one-hop');
    }
    if (outerSymbol !== null) {
      addTerm(target, 'symbol', outerSymbol, 'modified-outer-symbol');
    }
  }
}

function addTerm(
  target: Map<
    string,
    {
      term: NormalizedInvestigationTerm;
      origins: Set<ImplementationTermOrigin>;
    }
  >,
  kind: InvestigationTermKind,
  value: string,
  origin: ImplementationTermOrigin,
): void {
  if (!TERM_ORIGINS.has(origin)) throw termInvalid('Unknown hunk-term origin.');
  let term: NormalizedInvestigationTerm;
  try {
    term = normalizeInvestigationTerm({ kind, value });
  } catch {
    return;
  }
  const current = target.get(term.termId) ?? { term, origins: new Set() };
  current.origins.add(origin);
  target.set(term.termId, current);
}

function identifiers(source: string): string[] {
  const withoutQuotedLiterals = source.replace(
    /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g,
    ' ',
  );
  return [...withoutQuotedLiterals.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)]
    .map(([value]) => value)
    .filter((value) => !LANGUAGE_KEYWORDS.has(value));
}

function literals(source: string): string[] {
  const values: string[] = [];
  for (const expression of [
    /'((?:\\.|[^'\\])*)'/g,
    /"((?:\\.|[^"\\])*)"/g,
    /`((?:\\.|[^`\\])*)`/g,
  ]) {
    for (const match of source.matchAll(expression)) {
      if (match[1] !== undefined && match[1].length >= 3) values.push(match[1]);
    }
  }
  for (const match of source.matchAll(
    /\b(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?)\b/g,
  )) {
    if (match[0].length >= 3) values.push(match[0]);
  }
  return values;
}

function aliases(source: string): string[] {
  return [
    ...source.matchAll(
      /\b([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g,
    ),
  ].flatMap((match) => [match[1]!, match[2]!]);
}

function declarationName(source: string): string | null {
  return (
    /\b(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(
      source,
    )?.[1] ?? null
  );
}

function materializeImplementationTree(input: {
  repositoryRoot: string;
  baselineCommit: string;
  productionPaths: readonly string[];
}): string {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-implementation-tree-'),
  );
  const indexPath = path.join(temporary, 'index');
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: indexPath,
    GIT_WORK_TREE: input.repositoryRoot,
  };
  try {
    runGitWithEnvironment(
      input.repositoryRoot,
      ['read-tree', input.baselineCommit],
      environment,
    );
    if (input.productionPaths.length > 0) {
      runGitWithEnvironment(
        input.repositoryRoot,
        ['add', '--all', '--', ...input.productionPaths],
        environment,
      );
    }
    return runGitWithEnvironment(
      input.repositoryRoot,
      ['write-tree'],
      environment,
    ).trim();
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function termInvalid(message: string) {
  return workflowError(
    'IMPLEMENTATION_TERM_FLOOR_INVALID',
    message,
    ExitCode.verification,
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
