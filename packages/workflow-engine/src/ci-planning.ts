import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import {
  assertCollaborationGrantId,
  assertUniqueCollaborationGrantUses,
  type CollaborationGrantUseIdentity,
} from './collaboration-grant.ts';
import { readFileAtCommit } from './ci-git.ts';
import { isRecord } from './contract-values.ts';
import {
  parseManagedTrailers,
  type AmendPlanManagedTrailers,
} from './managed-trailers.ts';
import {
  loadChangeContract,
  parseInvestigationArtifact,
  parsePlanReviewArtifact,
  parseTasks,
  readChangeSchemaName,
  type ManagedSchemaName,
  type ParsedTask,
} from './contracts.ts';
import { createTrustedExecutionEnvironment } from './execution-environment.ts';
import { engineProjectionPathsForTransition } from './engine-projection-registry.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  commitChangedPaths,
  commitFacts,
  planningCommitMessage,
} from './git-transitions.ts';
import { createArchiveApplicabilityProjection } from './archive-transformation.ts';
import { runGit } from './git.ts';
import { validateHandoffForChange } from './handoff.ts';
import {
  assertInvestigationPlanningActivation,
  readActivationMarkerFile,
  protectedActivationBaselines,
} from './openspec-schema-contract.ts';
import {
  validateInvestigationFirstPlanningReadiness,
  type InvestigationFirstPlanningAssuranceSummary,
} from './planning-assurance-validator.ts';
import { committedPlanningGeneration } from './planning-generation-history.ts';
import { readPlanningAmendmentDecision } from './planning-amendment-decision.ts';
import {
  amendmentLeftWorkMarkedDone,
  assertPlanningPaths,
  assertPlanningTaskHistory,
  taskStates,
} from './planning-contract.ts';
import { requiredPlanningArtifactPaths } from './planning-paths.ts';
import type { PlanningTaskState } from './planning-report.ts';
import { normalizeChangedPath } from './paths.ts';

export type CiPlanningCommitValidation = {
  changeId: string;
  kind: 'introduction' | 'revision';
  beforeTasks: PlanningTaskState[] | undefined;
  afterTasks: PlanningTaskState[];
  changedPaths: string[];
  schemaName: ManagedSchemaName;
  planningAssurance: InvestigationFirstPlanningAssuranceSummary | null;
  collaborationGrantUses: readonly CiCollaborationGrantUse[];
};

/**
 * One grant use projected out of an immutable planning commit. CI collects
 * these across the replayed range so aggregate one-use uniqueness is decided
 * over the complete subject rather than one commit at a time.
 */
export type CiCollaborationGrantUse = CollaborationGrantUseIdentity;

export { assertUniqueCollaborationGrantUses };

/**
 * Reconstruct every collaboration-grant claim made by exact planning
 * transitions for one change through the requested immutable Git tip.
 * Non-plan commits are deliberately ignored even when they touch the artifact:
 * maxUses applies to the managed transition that claimed the review, while the
 * ordinary CI path separately rejects unmanaged planning mutations.
 */
export function collectHistoricalCollaborationGrantUses(
  repositoryRoot: string,
  head: string,
  changeId: string,
  changeRoot = 'openspec/changes',
): readonly CiCollaborationGrantUse[] {
  assertChangeId(changeId);
  const normalizedChangeRoot = normalizeChangedPath(changeRoot);
  if (normalizedChangeRoot !== changeRoot || changeRoot.endsWith('/')) {
    throw ciPlanningError(
      'CI_PLANNING_ROOT_INVALID',
      'CI planning validation requires one canonical change root.',
    );
  }
  const artifactPaths = [
    `${normalizedChangeRoot}/${changeId}/investigation.json`,
    `${normalizedChangeRoot}/${changeId}/plan-review.json`,
  ] as const;
  const commits = runGit(repositoryRoot, [
    'rev-list',
    '--full-history',
    '--reverse',
    head,
    '--',
    ...artifactPaths.map((artifactPath) => `:(literal)${artifactPath}`),
  ])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const expectedMessage = `${planningCommitMessage(changeId)}\n`;
  return commits.flatMap((commit) => {
    const facts = commitFacts(repositoryRoot, commit);
    if (facts.parents.length !== 1 || facts.message !== expectedMessage) {
      return [];
    }
    return artifactPaths.flatMap((artifactPath) => {
      const raw = readFileAtCommit(repositoryRoot, commit, artifactPath);
      if (raw === undefined) {
        return [];
      }
      return grantUsesFromPlanningArtifact(
        raw,
        changeId,
        artifactPath.endsWith('/investigation.json')
          ? 'investigation'
          : 'plan-review',
      );
    });
  });
}

function grantUsesFromPlanningArtifact(
  raw: string,
  changeId: string,
  artifactKind: 'investigation' | 'plan-review',
): CiCollaborationGrantUse[] {
  let roleResults: unknown[] | undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (raw !== `${canonicalJson(parsed)}\n`) {
      throw new Error('noncanonical artifact');
    }
    roleResults =
      artifactKind === 'investigation'
        ? parseInvestigationArtifact(parsed, changeId).roleResults
        : parsePlanReviewArtifact(parsed, changeId).roleResults;
  } catch {
    throw ciPlanningError(
      'CI_PLANNING_GRANT_HISTORY_INVALID',
      'Historical planning grant claims are malformed.',
    );
  }
  return grantUsesFromRoleResults(roleResults ?? []);
}

function grantUsesFromRoleResults(
  roleResults: readonly unknown[],
): CiCollaborationGrantUse[] {
  return roleResults.flatMap((roleResult) => {
    if (!isRecord(roleResult)) {
      throw ciPlanningError(
        'CI_PLANNING_GRANT_HISTORY_INVALID',
        'Historical planning grant claims are malformed.',
      );
    }
    if (roleResult.grantUse === null) {
      return [];
    }
    const use = roleResult.grantUse;
    if (
      !isRecord(use) ||
      typeof use.grantId !== 'string' ||
      typeof use.signedEnvelopeDigest !== 'string' ||
      typeof use.transitionDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(use.signedEnvelopeDigest) ||
      !/^[0-9a-f]{64}$/.test(use.transitionDigest)
    ) {
      throw ciPlanningError(
        'CI_PLANNING_GRANT_HISTORY_INVALID',
        'Historical planning grant claims are malformed.',
      );
    }
    return [
      {
        grantId: assertCollaborationGrantId(use.grantId),
        signedEnvelopeDigest: use.signedEnvelopeDigest,
        transitionDigest: use.transitionDigest,
      },
    ];
  });
}

type TreeEntry = {
  mode: string;
  type: string;
  path: string;
};

/**
 * Reconstruct one ordinary planning transition from its immutable Git commit.
 * The caller must dispatch only commits whose canonical trailer parser selected
 * the `plan` transition. The single integration bootstrap is deliberately an
 * outer exception because its dependency diff is not an ordinary plan diff.
 */
/**
 * The amendment block a planning commit carries, if it is one.
 *
 * Reading it here rather than trusting a caller is what keeps replay honest:
 * the permission to reopen completed work lives in the commit that used it, so
 * a later reader reaches the same verdict from the same bytes.
 */
function readCommittedAmendment(
  message: string,
  changeId: string,
): AmendPlanManagedTrailers | null {
  let trailers;
  try {
    trailers = parseManagedTrailers(
      message.endsWith('\n') ? message.slice(0, -1) : message,
    );
  } catch {
    return null;
  }
  if (trailers?.kind !== 'amend-plan') return null;
  if (trailers.changeId !== changeId) {
    throw ciPlanningError(
      'CI_PLANNING_AMENDMENT_CHANGE_MISMATCH',
      'An amendment names the change it amends, and this one names another.',
    );
  }
  return trailers;
}

export function validateCiPlanningCommit(
  repositoryRoot: string,
  commitHash: string,
  changeId: string,
  changeRoot = 'openspec/changes',
): CiPlanningCommitValidation {
  assertChangeId(changeId);
  const normalizedChangeRoot = normalizeChangedPath(changeRoot);
  if (normalizedChangeRoot !== changeRoot || changeRoot.endsWith('/')) {
    throw ciPlanningError(
      'CI_PLANNING_ROOT_INVALID',
      'CI planning validation requires one canonical change root.',
    );
  }

  const facts = commitFacts(repositoryRoot, commitHash);
  if (facts.parents.length !== 1) {
    throw ciPlanningError(
      'CI_PLANNING_NON_LINEAR',
      'Planning commits must have exactly one parent.',
    );
  }
  // An amendment carries its own exact block, and the authorization to reopen
  // completed work is read from that block rather than from anything outside
  // the commit — replay sees precisely what the transition claimed.
  const amendment = readCommittedAmendment(facts.message, changeId);
  if (
    amendment === null &&
    facts.message !== `${planningCommitMessage(changeId)}\n`
  ) {
    throw ciPlanningError(
      'CI_PLANNING_MESSAGE_INVALID',
      'Planning commits require the exact managed subject and trailer block.',
    );
  }
  const reopenAuthorized = amendment?.executionImpact === 'required';

  const changedPaths = commitChangedPaths(repositoryRoot, facts.hash);
  if (changedPaths.length === 0) {
    throw ciPlanningError(
      'CI_PLANNING_DIFF_EMPTY',
      'Planning commits require a non-empty planning diff.',
    );
  }
  const knownProjectionPaths = new Set(
    engineProjectionPathsForTransition('plan'),
  );
  const engineProjectionPaths = changedPaths.filter((changedPath) =>
    knownProjectionPaths.has(changedPath),
  );
  const planningPaths = changedPaths.filter(
    (changedPath) => !knownProjectionPaths.has(changedPath),
  );
  const prefix = `${normalizedChangeRoot}/${changeId}`;
  const beforeEntries = listTreeEntries(
    repositoryRoot,
    facts.parents[0],
    prefix,
  );
  const afterEntries = listTreeEntries(repositoryRoot, facts.hash, prefix);
  const afterPaths = new Set(afterEntries.map(({ path }) => path));
  const deletedPaths = beforeEntries
    .map(({ path }) => path)
    .filter(
      (beforePath) =>
        !afterPaths.has(beforePath) && planningPaths.includes(beforePath),
    );
  // The governing schema is a fact of the immutable commit, not of the
  // checkout CI happens to run in, so it is resolved from the replayed tree
  // before any schema-sensitive path or artifact rule is applied.
  const replay = replayPlanningTree(
    repositoryRoot,
    facts.hash,
    changeId,
    engineProjectionPaths,
  );
  if (amendment !== null) {
    assertCommittedAmendmentProvenance(
      repositoryRoot,
      normalizedChangeRoot,
      facts.parents[0],
      facts.hash,
      amendment,
      replay.planningAssurance,
    );
  }
  assertPlanningPaths(
    normalizedChangeRoot,
    changeId,
    planningPaths,
    deletedPaths,
    replay.schemaName,
  );
  assertCompletePlanningTree(
    normalizedChangeRoot,
    changeId,
    afterEntries,
    [],
    [],
    replay.schemaName,
  );

  let beforeTasks: ParsedTask[] | undefined;
  let kind: CiPlanningCommitValidation['kind'];
  if (beforeEntries.length === 0) {
    kind = 'introduction';
    if (
      JSON.stringify(planningPaths) !==
      JSON.stringify(afterEntries.map(({ path }) => path))
    ) {
      throw ciPlanningError(
        'CI_PLANNING_INTRODUCTION_INVALID',
        'A planning introduction must add exactly one complete planning tree.',
      );
    }
  } else {
    kind = 'revision';
    const beforePaths = new Set(beforeEntries.map(({ path }) => path));
    const repairedPaths = requiredArtifactPaths(
      normalizedChangeRoot,
      changeId,
      replay.schemaName,
    ).filter(
      (requiredPath) =>
        !beforePaths.has(requiredPath) &&
        afterPaths.has(requiredPath) &&
        planningPaths.includes(requiredPath),
    );
    assertCompletePlanningTree(
      normalizedChangeRoot,
      changeId,
      beforeEntries,
      deletedPaths,
      repairedPaths,
      // The parent tree carries the schema it was committed under, which is
      // deliberately allowed to precede a legacy-to-v2 migration commit.
      replayPlanningSchema(repositoryRoot, facts.parents[0], changeId),
    );
    beforeTasks = parseTasks(
      readRequiredFile(repositoryRoot, facts.parents[0], `${prefix}/tasks.md`),
    );
  }

  const afterTasks = parseTasks(
    readRequiredFile(repositoryRoot, facts.hash, `${prefix}/tasks.md`),
  );
  const reopenedTasks = assertPlanningTaskHistory(beforeTasks, afterTasks, {
    reopenAuthorized,
  });
  if (
    amendmentLeftWorkMarkedDone({
      reopenAuthorized,
      reopenedTasks,
      beforeTasks,
    })
  ) {
    throw ciPlanningError(
      'CI_PLANNING_AMENDMENT_NOT_REOPENED',
      'An amendment that says the work must be redone has to reopen it; completed tasks are still marked done.',
    );
  }
  if (replay.planningAssurance !== null) {
    createArchiveApplicabilityProjection({
      repositoryRoot,
      changeRoot: normalizedChangeRoot,
      changeId,
      baselineCommit: facts.parents[0],
      sourceCommit: facts.hash,
      activeArtifactPaths: afterEntries.map(
        ({ path: artifactPath }) => artifactPath,
      ),
      source: 'commit',
    });
  }
  return {
    changeId,
    kind,
    beforeTasks: beforeTasks ? taskStates(beforeTasks) : undefined,
    afterTasks: taskStates(afterTasks),
    changedPaths,
    schemaName: replay.schemaName,
    planningAssurance: replay.planningAssurance,
    collaborationGrantUses: replay.collaborationGrantUses,
  };
}

function assertCommittedAmendmentProvenance(
  repositoryRoot: string,
  changeRoot: string,
  parentCommit: string,
  amendmentCommit: string,
  amendment: AmendPlanManagedTrailers,
  planningAssurance: InvestigationFirstPlanningAssuranceSummary | null,
): void {
  let priorGeneration: string | null;
  try {
    priorGeneration = committedPlanningGeneration(
      repositoryRoot,
      parentCommit,
      changeRoot,
      amendment.changeId,
    );
  } catch {
    throw ciPlanningError(
      'CI_PLANNING_AMENDMENT_PROVENANCE_INVALID',
      'An amendment parent does not name exactly one planning generation.',
    );
  }
  let reviewedDecision: ReturnType<typeof readPlanningAmendmentDecision> = null;
  try {
    const proposal = readFileAtCommit(
      repositoryRoot,
      amendmentCommit,
      `${changeRoot}/${amendment.changeId}/proposal.md`,
    );
    reviewedDecision =
      proposal === undefined ? null : readPlanningAmendmentDecision(proposal);
  } catch {
    reviewedDecision = null;
  }
  if (
    planningAssurance === null ||
    priorGeneration === null ||
    reviewedDecision === null ||
    reviewedDecision.executionImpact !== amendment.executionImpact ||
    reviewedDecision.amendsPlanningGeneration !== priorGeneration ||
    amendment.planningGeneration !== planningAssurance.planningGenerationId ||
    amendment.planReview !== planningAssurance.reviewNodeId ||
    amendment.amendsPlanningGeneration !== priorGeneration
  ) {
    throw ciPlanningError(
      'CI_PLANNING_AMENDMENT_PROVENANCE_INVALID',
      'Amendment trailers and the reviewed decision must bind the exact impact, generation, review node, and generation replaced by the parent tree.',
    );
  }
}

type PlanningTreeReplay = {
  schemaName: ManagedSchemaName;
  planningAssurance: InvestigationFirstPlanningAssuranceSummary | null;
  collaborationGrantUses: readonly CiCollaborationGrantUse[];
};

/**
 * Materialize one immutable planning tree and replay its semantic assurance
 * with the exact validator the live transition used. CI owns a different
 * loader, never a second set of rules, and it consults no mutable local
 * reservation state: every fact comes from the detached tree.
 */
function replayPlanningTree(
  repositoryRoot: string,
  commit: string,
  changeId: string,
  engineProjectionPaths: readonly string[],
): PlanningTreeReplay {
  return withPlanningWorktree(repositoryRoot, commit, (worktree) => {
    const schemaName = resolveReplayedSchemaName(worktree, changeId);
    assertInvestigationPlanningActivation({
      repositoryRoot,
      baselines: planningActivationBaselines(repositoryRoot, commit),
      readMarker: () => readActivationMarkerFile(worktree),
      declaredSchemaName: schemaName,
    });
    if (engineProjectionPaths.includes('docs/CURRENT_AND_NEXT_STEPS.md')) {
      validateHandoffForChange(worktree, changeId);
    }
    if (schemaName !== 'expense-app-v2') {
      return {
        schemaName,
        planningAssurance: null,
        collaborationGrantUses: [],
      };
    }
    const contract = loadChangeContract(worktree, changeId, schemaName);
    const readiness = validateInvestigationFirstPlanningReadiness(
      worktree,
      contract,
    );
    return {
      schemaName,
      planningAssurance: readiness.summary,
      collaborationGrantUses: collectGrantUses(contract),
    };
  });
}

function replayPlanningSchema(
  repositoryRoot: string,
  commit: string,
  changeId: string,
): ManagedSchemaName {
  return withPlanningWorktree(repositoryRoot, commit, (worktree) =>
    resolveReplayedSchemaName(worktree, changeId),
  );
}

/**
 * The baselines that decide activation for one immutable planning commit. Its
 * own parent is always applicable, which is what keeps a governing generation
 * created before the anchor replayable forever. The configured protected base
 * is added only while the commit is not yet contained in it: an unmerged
 * candidate cannot escape activation by branching from stale history, and a
 * commit that is already part of the protected lineage is replayed as the
 * history it is rather than re-judged against a base that grew past it.
 */
function planningActivationBaselines(
  repositoryRoot: string,
  commit: string,
): string[] {
  const facts = commitFacts(repositoryRoot, commit);
  const baselines = facts.parents.slice(0, 1);
  for (const base of protectedActivationBaselines(repositoryRoot)) {
    const mergeBase = runGit(
      repositoryRoot,
      ['merge-base', facts.hash, base],
      true,
    ).trim();
    if (mergeBase !== facts.hash) {
      baselines.push(base);
    }
  }
  return baselines;
}

/**
 * Select the artifact grammar a replayed tree declared. Only an explicit
 * `expense-app-v2` marker opts into the investigation-first gates; every other
 * declaration, including a pre-managed or unreadable one, reads as the legacy
 * grammar. That default is only ever reached for a generation whose lineage
 * carries no activation anchor, because the caller decides activation first
 * and rejects a legacy declaration made after one.
 */
function resolveReplayedSchemaName(
  worktree: string,
  changeId: string,
): ManagedSchemaName {
  const metadataPath = path.join(
    worktree,
    'openspec/changes',
    changeId,
    '.openspec.yaml',
  );
  try {
    return readChangeSchemaName(worktree, metadataPath) === 'expense-app-v2'
      ? 'expense-app-v2'
      : 'expense-app';
  } catch {
    return 'expense-app';
  }
}

/**
 * Project every grant identity carried by the parsed planning artifacts. The
 * shared readiness validator has already admitted the current semantic plan;
 * collection deliberately reads each artifact once so investigation and
 * PlanReview claims enter aggregate uniqueness without duplicating the current
 * PlanReview result through a second projection path.
 */
function collectGrantUses(
  contract: ReturnType<typeof loadChangeContract>,
): readonly CiCollaborationGrantUse[] {
  return Object.freeze([
    ...grantUsesFromRoleResults(contract.investigation?.roleResults ?? []),
    ...grantUsesFromRoleResults(contract.planReview?.roleResults ?? []),
  ]);
}

function withPlanningWorktree<T>(
  repositoryRoot: string,
  commit: string,
  operation: (worktree: string) => T,
): T {
  const temporaryBase = createTrustedExecutionEnvironment().TMPDIR;
  if (!temporaryBase) {
    throw ciPlanningError(
      'CI_PLANNING_TEMPORARY_DIRECTORY_UNAVAILABLE',
      'Planning replay requires a trusted temporary directory.',
    );
  }
  const temporaryRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(temporaryBase), 'workflow-ci-planning-'),
  );
  const worktree = path.join(temporaryRoot, 'worktree');
  let worktreeAdded = false;
  try {
    runGit(repositoryRoot, ['worktree', 'add', '--detach', worktree, commit]);
    worktreeAdded = true;
    return operation(worktree);
  } finally {
    if (worktreeAdded) {
      runGit(repositoryRoot, ['worktree', 'remove', '--force', worktree]);
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function requiredArtifactPaths(
  changeRoot: string,
  changeId: string,
  schemaName: ManagedSchemaName = 'expense-app',
): string[] {
  return [...requiredPlanningArtifactPaths(changeRoot, changeId, schemaName)];
}

/**
 * A required artifact may be absent only from a revision's before tree, and
 * only when that same revision adds it (bootstrap-era tree repair).
 */
function assertCompletePlanningTree(
  changeRoot: string,
  changeId: string,
  entries: TreeEntry[],
  toleratedDeletedPaths: readonly string[] = [],
  toleratedMissingPaths: readonly string[] = [],
  schemaName: ManagedSchemaName = 'expense-app',
): void {
  const paths = entries.map(({ path }) => path);
  assertPlanningPaths(
    changeRoot,
    changeId,
    paths,
    toleratedDeletedPaths,
    schemaName,
  );
  const prefix = `${changeRoot}/${changeId}`;
  const required = requiredArtifactPaths(changeRoot, changeId, schemaName);
  if (
    required.some(
      (requiredPath) =>
        !paths.includes(requiredPath) &&
        !toleratedMissingPaths.includes(requiredPath),
    ) ||
    !paths.some(
      (filePath) =>
        filePath.startsWith(`${prefix}/specs/`) &&
        filePath.endsWith('/spec.md'),
    )
  ) {
    throw ciPlanningError(
      'CI_PLANNING_TREE_INVALID',
      'Planning commit tree is missing a required artifact.',
    );
  }
  if (entries.some(({ mode, type }) => mode !== '100644' || type !== 'blob')) {
    throw ciPlanningError(
      'CI_PLANNING_TREE_UNSAFE',
      'Planning artifacts must be non-executable regular Git blobs.',
    );
  }
}

function listTreeEntries(
  repositoryRoot: string,
  commit: string,
  prefix: string,
): TreeEntry[] {
  const entries = runGit(repositoryRoot, [
    'ls-tree',
    '-r',
    '-z',
    commit,
    '--',
    `:(literal)${prefix}`,
  ])
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d+) (\S+) [0-9a-f]+\t(.+)$/.exec(entry);
      if (!match) {
        throw ciPlanningError(
          'CI_PLANNING_TREE_INVALID',
          'CI could not parse the planning tree.',
        );
      }
      return {
        mode: match[1],
        type: match[2],
        path: normalizeChangedPath(match[3]),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  // Git accepts trees whose entries repeat a name; downstream membership
  // checks would collapse the duplicates and read an ambiguous tree as valid.
  const seenPaths = new Set<string>();
  for (const { path: entryPath } of entries) {
    if (seenPaths.has(entryPath)) {
      throw ciPlanningError(
        'CI_PLANNING_TREE_INVALID',
        'Planning trees must not contain duplicate entries.',
      );
    }
    seenPaths.add(entryPath);
  }
  return entries;
}

function readRequiredFile(
  repositoryRoot: string,
  commit: string,
  filePath: string,
): string {
  try {
    return runGit(repositoryRoot, ['show', `${commit}:${filePath}`]);
  } catch (error) {
    throw ciPlanningError(
      'CI_PLANNING_TREE_INVALID',
      'CI could not read a required planning artifact.',
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

function assertChangeId(changeId: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(changeId)) {
    throw ciPlanningError(
      'CI_PLANNING_CHANGE_ID_INVALID',
      'CI planning validation requires a canonical change ID.',
    );
  }
}

function ciPlanningError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return workflowError(code, message, ExitCode.verification, {
    ...(details ? { details } : {}),
  });
}
