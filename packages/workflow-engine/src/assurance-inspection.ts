import fs from 'node:fs';
import path from 'node:path';

import {
  assessAssurance,
  type AssuranceAssessmentChain,
  type AssuranceFloors,
  type CoverageTier,
  type InvestigationChangeClass,
} from './modules/assurance/assurance-assessment-chain.ts';
import { loadWorkflowConfig, parseInvestigationArtifact } from './contracts.ts';
import { ExitCode, workflowError } from './foundation/errors/errors.ts';
import { discoverRepository } from './git.ts';
import { parsePathRoleRegistry } from './modules/source/path-role-registry.ts';
import {
  inspectPlanningShadowMetrics,
  type PlanningShadowMetrics,
} from './modules/assurance/planning-shadow-metrics.ts';
import { readLedgerIndex, readLedgerEntry } from './semantic-ledger-store.ts';
import {
  planSemanticReuse,
  type ReusePlan,
} from './modules/why-knowledge/semantic-reuse.ts';
import type { FreshnessObservation } from './modules/why-knowledge/semantic-freshness.ts';
import type { LedgerEntry } from './modules/why-knowledge/semantic-ledger.ts';

export type AssuranceInspection = Readonly<{
  schemaVersion: 1;
  kind: 'assurance-inspection';
  changeId: string;
  declaredChangeClasses: readonly string[];
  hitPathCount: number;
  floors: AssuranceFloors;
  coverageTier: CoverageTier;
  escalated: boolean;
  reasons: readonly string[];
  chain: AssuranceAssessmentChain;
  /**
   * What the ledger already explains and what this change still owes. Present
   * only once a ledger exists; a repository without one owes everything, which
   * is the state every repository starts in.
   */
  semanticReuse: ReusePlan | null;
  /** Metrics replayed from this investigation's durable planning evidence. */
  shadowMetrics: PlanningShadowMetrics;
}>;

/**
 * Answers what a change owes, from what its author declared and where its scan
 * actually landed. Read-only: it reproduces the assessment from durable
 * evidence rather than recording a new decision, so running it twice on an
 * unchanged investigation gives the same answer.
 */
export function inspectChangeAssurance(
  cwd: string,
  changeId: string,
  options: { now?: Date } = {},
): AssuranceInspection {
  const repository = discoverRepository(cwd);
  const config = loadWorkflowConfig(repository.repositoryRoot);
  const registry = parsePathRoleRegistry(
    readJson(
      path.join(repository.repositoryRoot, 'workflow/path-roles.json'),
      'Path role registry is unavailable.',
    ),
  );
  const investigation = parseInvestigationArtifact(
    readJson(
      path.join(
        repository.repositoryRoot,
        config.changeRoot,
        changeId,
        'investigation.json',
      ),
      `Change ${changeId} has no investigation to assess.`,
    ),
    changeId,
    { repositoryRoot: repository.repositoryRoot },
  );

  const declaredChangeClasses = declaredClasses(investigation);
  const hitPaths = scanHitPaths(investigation);
  const at = (options.now ?? new Date()).toISOString();
  const assessment = assessAssurance({
    changeId,
    declaredChangeClasses,
    registry,
    hitPaths,
    at,
  });

  return Object.freeze({
    semanticReuse: inspectSemanticReuse(repository.repositoryRoot, hitPaths),
    shadowMetrics: inspectPlanningShadowMetrics({
      repositoryRoot: repository.repositoryRoot,
      gitCommonDirectory: repository.gitCommonDirectory,
      runtimeDirectory: config.runtimeDirectory,
      changeRoot: config.changeRoot,
      changeId,
      investigation,
    }),
    schemaVersion: 1,
    kind: 'assurance-inspection',
    changeId,
    declaredChangeClasses: assessment.declaredChangeClasses,
    hitPathCount: assessment.hitPathCount,
    floors: assessment.floors,
    coverageTier: assessment.coverageTier,
    escalated: assessment.escalated,
    reasons: assessment.reasons,
    chain: assessment.chain,
  });
}

/**
 * Resolves each touched path against the ledger. A path with no recorded
 * understanding is not skipped — it is charged, which is why a fresh
 * repository sees a reuse rate of zero rather than a reassuring silence.
 */
function inspectSemanticReuse(
  repositoryRoot: string,
  hitPaths: readonly string[],
): ReusePlan | null {
  const index = readLedgerIndex(repositoryRoot);
  const subjectIds = Object.keys(index.subjects);
  if (subjectIds.length === 0) return null;

  const entries = new Map<string, LedgerEntry>();
  for (const subjectId of subjectIds) {
    try {
      entries.set(
        subjectId,
        readLedgerEntry(
          repositoryRoot,
          index.subjects[subjectId].currentEntryId,
        ),
      );
    } catch {
      // A named entry that cannot be read is a missing entry, not a fresh one.
    }
  }
  const touched = new Set(hitPaths);
  const observations = new Map<string, FreshnessObservation>();
  for (const [subjectId, entry] of entries) {
    // A subject the scan never reached is not evidence of anything changing,
    // so its recorded understanding stands.
    if (!touched.has(entry.subject.path)) {
      observations.set(subjectId, {
        present: true,
        sourceDigest: entry.binding.sourceDigest,
        semanticDigest: entry.binding.semanticDigest,
        currentDependencyEntryIds: Object.fromEntries(
          entry.semanticDependencies.map(({ subjectId: id, entryId }) => [
            id,
            entryId,
          ]),
        ),
        currentPolicyDigest: entry.policyDigest,
      });
    }
    // A touched subject is left unobserved on purpose: the engine cannot see
    // its current meaning from here, and unobserved resolves to regenerate.
  }
  return planSemanticReuse([...entries.keys()].sort(), entries, observations);
}

function declaredClasses(investigation: unknown): InvestigationChangeClass[] {
  const applicability = (investigation as { applicability?: unknown })
    .applicability;
  const declared = (applicability as { declaredChangeClasses?: unknown })
    ?.declaredChangeClasses;
  return Array.isArray(declared)
    ? declared.filter(
        (value): value is InvestigationChangeClass => typeof value === 'string',
      )
    : [];
}

/**
 * Every distinct path the scan touched. Deduplicated because a floor is a
 * property of the path, not of how many terms happened to land on it.
 */
function scanHitPaths(investigation: unknown): string[] {
  const nodes = (investigation as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  const paths = new Set<string>();
  for (const node of nodes) {
    if (
      (node as { evaluator?: unknown }).evaluator !== 'investigation-scanner.v1'
    ) {
      continue;
    }
    const hits = (node as { output?: { hits?: unknown } }).output?.hits;
    if (!Array.isArray(hits)) continue;
    for (const hit of hits) {
      const utf8 = (hit as { path?: { utf8?: unknown } }).path?.utf8;
      if (typeof utf8 === 'string' && utf8 !== '') paths.add(utf8);
    }
  }
  return [...paths].sort();
}

function readJson(filePath: string, absentMessage: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw workflowError(
      'ASSURANCE_INSPECTION_UNAVAILABLE',
      absentMessage,
      ExitCode.guard,
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw workflowError(
      'ASSURANCE_INSPECTION_UNAVAILABLE',
      `${filePath} is not readable JSON.`,
      ExitCode.guard,
    );
  }
}
