import fs from 'node:fs';
import path from 'node:path';

import {
  appendAssuranceAssessment,
  coverageTier,
  effectiveFloors,
  floorsForChangeClass,
  floorsForHitPaths,
  reconcileDeclaredClass,
  startAssuranceChain,
  type AssuranceAssessmentChain,
  type AssuranceFloors,
  type CoverageTier,
  type InvestigationChangeClass,
} from './assurance-assessment-chain.ts';
import { loadWorkflowConfig } from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { discoverRepository } from './git.ts';
import { parsePathRoleRegistry } from './path-role-registry.ts';
import { readLedgerIndex, readLedgerEntry } from './semantic-ledger-store.ts';
import { planSemanticReuse, type ReusePlan } from './semantic-reuse.ts';
import type { FreshnessObservation } from './semantic-freshness.ts';
import type { LedgerEntry } from './semantic-ledger.ts';

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
  const investigation = readJson(
    path.join(
      repository.repositoryRoot,
      config.changeRoot,
      changeId,
      'investigation.json',
    ),
    `Change ${changeId} has no investigation to assess.`,
  );

  const declaredChangeClasses = declaredClasses(investigation);
  const hitPaths = scanHitPaths(investigation);
  const at = (options.now ?? new Date()).toISOString();

  // The declared class is the request; the hits are the evidence. Where a
  // change declares nothing, an unclassified declaration is not a light one —
  // it is simply absent, and the hits carry the whole assessment.
  const declared =
    declaredChangeClasses.length === 0
      ? null
      : declaredChangeClasses
          .map((changeClass) =>
            reconcileDeclaredClass(changeClass, registry, hitPaths),
          )
          .reduce((strictest, candidate) =>
            candidate.escalated && !strictest.escalated ? candidate : strictest,
          );
  const observed = floorsForHitPaths(registry, hitPaths);

  let chain = startAssuranceChain({
    changeId,
    floors:
      declaredChangeClasses.length === 0
        ? floorsForChangeClass('behavioral').floors
        : floorsForChangeClass(declaredChangeClasses[0]).floors,
    reasons:
      declaredChangeClasses.length === 0
        ? ['no-declared-change-class']
        : declaredChangeClasses.map((value) => `declared-class:${value}`),
    at,
  });
  chain = appendAssuranceAssessment(chain, {
    stage: 'scan-discovered',
    floors: declared?.floors ?? observed.floors,
    reasons:
      observed.reasons.length === 0
        ? [`scan-hit-paths-all-ordinary:${hitPaths.length}`]
        : observed.reasons,
    at,
  });

  return Object.freeze({
    semanticReuse: inspectSemanticReuse(repository.repositoryRoot, hitPaths),
    schemaVersion: 1,
    kind: 'assurance-inspection',
    changeId,
    declaredChangeClasses: Object.freeze(declaredChangeClasses),
    hitPathCount: hitPaths.length,
    floors: effectiveFloors(chain),
    coverageTier: coverageTier(chain),
    escalated: declared?.escalated ?? observed.reasons.length > 0,
    reasons: Object.freeze(
      chain.assessments.flatMap((assessment) => [...assessment.reasons]),
    ),
    chain,
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
