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
