import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import type { InvestigationSemanticAuthor } from './investigation-applicability.ts';
import type {
  InvestigationGroupFacts,
  InvestigationHitFact,
} from './investigation-groups.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const MAX_KEY_BYTES = 512;
const MAX_TEXT_BYTES = 4096;
const DISPOSITION_CLASSIFICATIONS = new Set([
  'load-bearing',
  'test-or-mirror',
  'generated',
  'incidental-reference',
  'irrelevant',
]);

export type InvestigationSemanticGroupDecision = {
  decisionId: string;
  key: string;
  title: string;
  sourceMechanicalGroupKeys: string[];
  hitKeys: string[];
  rationale: string;
  semanticAuthor: InvestigationSemanticAuthor;
};

export type InvestigationFinalGroupFact = {
  key: string;
  leafDigest: string;
  title: string | null;
  sourceMechanicalGroupKeys: string[];
  hitKeys: string[];
  sourceObjects: InvestigationHitFact['sourceObject'][];
  semanticDecisionId: string | null;
  rationale: string | null;
  semanticAuthor: InvestigationSemanticAuthor | null;
};

export type InvestigationGroupRef = {
  index: number;
  key: string;
  leafDigest: string;
};

export type InvestigationDispositionDecision = {
  groupKey: string;
  classification: string;
  rationale: string;
  semanticAuthor: InvestigationSemanticAuthor;
};

export type AppliedInvestigationDisposition = {
  groupRef: InvestigationGroupRef;
  classification: string;
  rationale: string;
  semanticAuthor: InvestigationSemanticAuthor;
  coveredHitKeys: string[];
  dispositionDigest: string;
};

/**
 * Apply only the irreducible semantic merge/split decisions to deterministic
 * mechanical groups. Mechanical groups without a decision remain derived and
 * therefore need no synthetic semantic record in the persisted Manifest.
 */
export function applyInvestigationSemanticGroupDecisions(input: {
  mechanical: InvestigationGroupFacts;
  decisions: InvestigationSemanticGroupDecision[];
}): InvestigationFinalGroupFact[] {
  const mechanicalByKey = new Map(
    input.mechanical.groups.map((group) => [group.key, group]),
  );
  if (mechanicalByKey.size !== input.mechanical.groups.length) {
    throw completenessFailure('Mechanical group keys are not unique.');
  }

  const hitsByKey = new Map(
    input.mechanical.hits.map((hit) => [hit.hitKey, hit]),
  );
  if (hitsByKey.size !== input.mechanical.hits.length) {
    throw completenessFailure('Mechanical hit keys are not unique.');
  }
  const sourceByHit = new Map<string, string>();
  for (const group of input.mechanical.groups) {
    for (const hitKey of group.hitKeys) {
      if (!hitsByKey.has(hitKey) || sourceByHit.has(hitKey)) {
        throw completenessFailure(
          'Mechanical groups do not partition current hits exactly once.',
        );
      }
      sourceByHit.set(hitKey, group.key);
    }
  }
  if (sourceByHit.size !== hitsByKey.size) {
    throw completenessFailure(
      'Mechanical groups do not cover every current hit.',
    );
  }

  const claimedSources = new Set<string>();
  const claimedHits = new Set<string>();
  const decisionIds = new Set<string>();
  const finalKeys = new Set<string>();
  const finals: InvestigationFinalGroupFact[] = [];
  for (const raw of input.decisions) {
    const decision = normalizeSemanticDecision(raw);
    if (decisionIds.has(decision.decisionId)) {
      throw completenessFailure(
        `Duplicate semantic group decision: ${decision.decisionId}`,
      );
    }
    decisionIds.add(decision.decisionId);
    if (finalKeys.has(decision.key) || mechanicalByKey.has(decision.key)) {
      throw completenessFailure(
        `Semantic group key collides with another group: ${decision.key}`,
      );
    }
    finalKeys.add(decision.key);

    for (const sourceKey of decision.sourceMechanicalGroupKeys) {
      if (!mechanicalByKey.has(sourceKey)) {
        throw completenessFailure(
          `Semantic group cites unknown mechanical group: ${sourceKey}`,
        );
      }
      claimedSources.add(sourceKey);
    }
    for (const hitKey of decision.hitKeys) {
      const sourceKey = sourceByHit.get(hitKey);
      if (
        sourceKey === undefined ||
        !decision.sourceMechanicalGroupKeys.includes(sourceKey)
      ) {
        throw completenessFailure(
          `Semantic group cites a hit outside its mechanical sources: ${hitKey}`,
        );
      }
      if (claimedHits.has(hitKey)) {
        throw completenessFailure(
          `Semantic groups overlap on current hit: ${hitKey}`,
        );
      }
      claimedHits.add(hitKey);
    }

    const semantic = {
      key: decision.key,
      title: decision.title,
      sourceMechanicalGroupKeys: decision.sourceMechanicalGroupKeys,
      hitKeys: decision.hitKeys,
      semanticDecisionId: decision.decisionId,
      rationale: decision.rationale,
      semanticAuthor: decision.semanticAuthor,
    };
    finals.push({
      ...semantic,
      leafDigest: groupLeafDigest(semantic),
      sourceObjects: sourceObjectsFor(decision.hitKeys, hitsByKey),
    });
  }

  for (const sourceKey of claimedSources) {
    const source = mechanicalByKey.get(sourceKey)!;
    if (source.hitKeys.some((hitKey) => !claimedHits.has(hitKey))) {
      throw completenessFailure(
        `Semantic decisions leave mechanical group ${sourceKey} partially uncovered.`,
      );
    }
  }

  for (const group of input.mechanical.groups) {
    if (claimedSources.has(group.key)) continue;
    if (finalKeys.has(group.key)) {
      throw completenessFailure(`Duplicate final group key: ${group.key}`);
    }
    finalKeys.add(group.key);
    const semantic = {
      key: group.key,
      title: null,
      sourceMechanicalGroupKeys: [group.key],
      hitKeys: [...group.hitKeys],
      semanticDecisionId: null,
      rationale: null,
      semanticAuthor: null,
    };
    finals.push({
      ...semantic,
      leafDigest: groupLeafDigest(semantic),
      sourceObjects: structuredClone(group.sourceObjects),
    });
  }

  const finalCoverage = new Set<string>();
  for (const group of finals) {
    for (const hitKey of group.hitKeys) {
      if (finalCoverage.has(hitKey)) {
        throw completenessFailure(
          'Final semantic groups overlap on a current hit.',
        );
      }
      finalCoverage.add(hitKey);
    }
  }
  if (finalCoverage.size !== hitsByKey.size) {
    throw completenessFailure(
      'Final semantic groups do not cover every current hit.',
    );
  }
  return finals.sort((left, right) => left.key.localeCompare(right.key));
}

/** Bind one semantic disposition to every final group exactly once. */
export function applyInvestigationDispositionDecisions(input: {
  finalGroups: InvestigationFinalGroupFact[];
  decisions: InvestigationDispositionDecision[];
}): AppliedInvestigationDisposition[] {
  const groups = [...input.finalGroups].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
  const groupsByKey = new Map(groups.map((group) => [group.key, group]));
  if (groupsByKey.size !== groups.length) {
    throw completenessFailure('Final group keys are not unique.');
  }
  const decisionsByKey = new Map<string, InvestigationDispositionDecision>();
  for (const raw of input.decisions) {
    const decision = normalizeDisposition(raw);
    if (!groupsByKey.has(decision.groupKey)) {
      throw completenessFailure(
        `Disposition cites unknown final group: ${decision.groupKey}`,
      );
    }
    if (decisionsByKey.has(decision.groupKey)) {
      throw completenessFailure(
        `Final group has more than one disposition: ${decision.groupKey}`,
      );
    }
    decisionsByKey.set(decision.groupKey, decision);
  }
  if (decisionsByKey.size !== groups.length) {
    throw completenessFailure(
      'Every final group requires exactly one disposition.',
    );
  }

  return groups.map((group, index) => {
    const decision = decisionsByKey.get(group.key)!;
    const groupRef = {
      index,
      key: group.key,
      leafDigest: group.leafDigest,
    };
    const semantic = {
      groupRef,
      classification: decision.classification,
      rationale: decision.rationale,
      semanticAuthor: decision.semanticAuthor,
      coveredHitKeys: [...group.hitKeys],
    };
    return {
      ...semantic,
      dispositionDigest: sha256(
        canonicalJson({
          schema: 'investigation.disposition.v3',
          ...semantic,
        }),
      ),
    };
  });
}

function normalizeSemanticDecision(
  value: InvestigationSemanticGroupDecision,
): InvestigationSemanticGroupDecision {
  assertExactKeys(value, [
    'decisionId',
    'key',
    'title',
    'sourceMechanicalGroupKeys',
    'hitKeys',
    'rationale',
    'semanticAuthor',
  ]);
  const sourceMechanicalGroupKeys = sortedUniqueDigests(
    value.sourceMechanicalGroupKeys,
    'semantic source groups',
  );
  const hitKeys = sortedUniqueDigests(value.hitKeys, 'semantic group hits');
  return {
    decisionId: boundedText(value.decisionId, MAX_KEY_BYTES, 'decision ID'),
    key: boundedText(value.key, MAX_KEY_BYTES, 'group key'),
    title: boundedText(value.title, MAX_TEXT_BYTES, 'group title'),
    sourceMechanicalGroupKeys,
    hitKeys,
    rationale: boundedText(value.rationale, MAX_TEXT_BYTES, 'group rationale'),
    semanticAuthor: normalizeSemanticAuthor(value.semanticAuthor),
  };
}

function normalizeDisposition(
  value: InvestigationDispositionDecision,
): InvestigationDispositionDecision {
  assertExactKeys(value, [
    'groupKey',
    'classification',
    'rationale',
    'semanticAuthor',
  ]);
  const groupKey = boundedText(value.groupKey, MAX_KEY_BYTES, 'group key');
  if (!DISPOSITION_CLASSIFICATIONS.has(value.classification)) {
    throw completenessFailure(
      `Unknown disposition classification: ${String(value.classification)}`,
    );
  }
  return {
    groupKey,
    classification: value.classification,
    rationale: boundedText(
      value.rationale,
      MAX_TEXT_BYTES,
      'disposition rationale',
    ),
    semanticAuthor: normalizeSemanticAuthor(value.semanticAuthor),
  };
}

function normalizeSemanticAuthor(
  value: InvestigationSemanticAuthor,
): InvestigationSemanticAuthor {
  assertExactKeys(value, ['id', 'provenance']);
  return {
    id: boundedText(value.id, MAX_KEY_BYTES, 'semantic author ID'),
    provenance: boundedText(
      value.provenance,
      MAX_TEXT_BYTES,
      'semantic author provenance',
    ),
  };
}

function sortedUniqueDigests(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== 'string' || !DIGEST.test(entry))
  ) {
    throw completenessFailure(`${label} must be non-empty digest references.`);
  }
  const sorted = [...value].sort();
  if (new Set(sorted).size !== sorted.length) {
    throw completenessFailure(`${label} contain duplicate references.`);
  }
  return sorted;
}

function sourceObjectsFor(
  hitKeys: string[],
  hitsByKey: Map<string, InvestigationHitFact>,
): InvestigationHitFact['sourceObject'][] {
  const byId = new Map<string, InvestigationHitFact['sourceObject']>();
  for (const hitKey of hitKeys) {
    const source = hitsByKey.get(hitKey)!.sourceObject;
    const previous = byId.get(source.objectId);
    if (
      previous !== undefined &&
      canonicalJson(previous) !== canonicalJson(source)
    ) {
      throw completenessFailure(
        'One Git object carries conflicting source metadata.',
      );
    }
    byId.set(source.objectId, structuredClone(source));
  }
  return [...byId.values()].sort((left, right) =>
    left.objectId.localeCompare(right.objectId),
  );
}

function groupLeafDigest(value: {
  key: string;
  title: string | null;
  sourceMechanicalGroupKeys: string[];
  hitKeys: string[];
  semanticDecisionId: string | null;
  rationale: string | null;
  semanticAuthor: InvestigationSemanticAuthor | null;
}): string {
  return sha256(
    canonicalJson({ schema: 'investigation.final-group.v3', ...value }),
  );
}

function boundedText(value: unknown, limit: number, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, 'utf8') > limit
  ) {
    throw completenessFailure(`${label} is malformed.`);
  }
  return value;
}

function assertExactKeys(value: unknown, keys: readonly string[]): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !Object.keys(value).every((key) => keys.includes(key))
  ) {
    throw completenessFailure('Semantic decision shape is malformed.');
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function completenessFailure(message: string) {
  return workflowError(
    'SEMANTIC_COMPLETENESS_FAILURE',
    message,
    ExitCode.guard,
  );
}
