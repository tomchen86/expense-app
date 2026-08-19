import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readFileAtCommit } from '../../entrypoints/ci/ci-git.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

type ArchiveDeltaSource = { changeId: string; head: string };
type ArchiveDeltaProjection = {
  baseSpecPaths: string[];
  tree: string;
  totals?: Record<Operation, number>;
};

type Operation = 'added' | 'modified' | 'removed' | 'renamed';
type RequirementBlock = { name: string; raw: string };
type DeltaPlan = {
  added: RequirementBlock[];
  modified: RequirementBlock[];
  removed: string[];
  renamed: Array<{ from: string; to: string }>;
};

export type ArchiveDeltaVerification = {
  totals: Record<Operation, number>;
  promotedSpecDigests: Record<string, string>;
};

export function verifyArchiveDeltaOutcomes(
  repositoryRoot: string,
  eligibility: ArchiveDeltaSource,
  transformation: ArchiveDeltaProjection,
): ArchiveDeltaVerification {
  const totals = { added: 0, modified: 0, removed: 0, renamed: 0 };
  const promotedSpecDigests: Record<string, string> = {};
  for (const baseSpecPath of transformation.baseSpecPaths) {
    const capability = baseSpecPath.split('/').at(-2);
    if (!capability) throw invalidOutcome();
    const deltaPath = `openspec/changes/${eligibility.changeId}/specs/${capability}/spec.md`;
    const delta = readFileAtCommit(repositoryRoot, eligibility.head, deltaPath);
    const after = readFileAtCommit(
      repositoryRoot,
      transformation.tree,
      baseSpecPath,
    );
    if (delta === undefined || after === undefined) throw invalidOutcome();
    const before = readFileAtCommit(
      repositoryRoot,
      eligibility.head,
      baseSpecPath,
    );
    const verified = verifyProjectedSpecDeltaOutcome(
      capability,
      before ?? '',
      delta,
      after,
    );
    for (const operation of Object.keys(totals) as Operation[]) {
      totals[operation] += verified.totals[operation];
    }
    promotedSpecDigests[baseSpecPath] = digest(after);
  }
  if (
    !transformation.totals ||
    JSON.stringify(transformation.totals) !== JSON.stringify(totals)
  ) {
    throw invalidOutcome();
  }
  return { totals, promotedSpecDigests };
}

/**
 * Verify one base-spec projection produced by the public OpenSpec archive
 * implementation. Both live archive and planning dry-run replay call this
 * exact function, so operation applicability and scenario preservation cannot
 * drift into two independently maintained interpretations.
 */
export function verifyProjectedSpecDeltaOutcome(
  capability: string,
  before: string,
  delta: string,
  after: string,
): { totals: Record<Operation, number>; projectedSpecDigest: string } {
  const plan = parseDelta(delta);
  const beforeRequirements = parseRequirements(before);
  const afterRequirements = parseRequirements(after);
  assertSpecDeltaPreconditions(capability, before, delta);
  verifyPlan(plan, beforeRequirements, afterRequirements);
  return {
    totals: {
      added: plan.added.length,
      modified: plan.modified.length,
      removed: plan.removed.length,
      renamed: plan.renamed.length,
    },
    projectedSpecDigest: digest(after),
  };
}

export function assertSpecDeltaPreconditions(
  capability: string,
  before: string,
  delta: string,
): void {
  const assessment = assessSpecDeltaAgainstBase(before, delta);
  if (assessment.faults.length > 0) {
    throw deltaNotApplicable(capability, assessment.faults);
  }
  const firstMissing = assessment.missingScenarios[0];
  if (firstMissing !== undefined) {
    throw scenarioPreservationFailed(
      firstMissing.requirement,
      firstMissing.scenarios,
    );
  }
}

function verifyPlan(
  plan: DeltaPlan,
  before: Map<string, string>,
  after: Map<string, string>,
): void {
  for (const { name } of plan.added) {
    if (before.has(name) || !after.has(name)) throw invalidOutcome();
  }
  for (const { name, raw } of plan.modified) {
    if (
      !before.has(name) ||
      normalizedBlock(after.get(name) ?? '') !== normalizedBlock(raw)
    ) {
      throw invalidOutcome();
    }
  }
  for (const name of plan.removed) {
    if (!before.has(name) || after.has(name)) throw invalidOutcome();
  }
  for (const { from, to } of plan.renamed) {
    if (!before.has(from) || after.has(from) || !after.has(to)) {
      throw invalidOutcome();
    }
  }
}

function parseDelta(content: string): DeltaPlan {
  const plan: DeltaPlan = {
    added: [],
    modified: [],
    removed: [],
    renamed: [],
  };
  const sections = splitSections(content);
  plan.added = requirementBlocks(sections.get('added requirements') ?? '');
  plan.modified = requirementBlocks(
    sections.get('modified requirements') ?? '',
  );
  plan.removed = requirementNames(sections.get('removed requirements') ?? '');
  const renamed = sections.get('renamed requirements') ?? '';
  let from: string | undefined;
  for (const line of renamed.split('\n')) {
    const fromMatch =
      /^\s*-?\s*FROM:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/i.exec(line);
    const toMatch = /^\s*-?\s*TO:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/i.exec(
      line,
    );
    if (fromMatch) from = normalizedName(fromMatch[1]);
    if (toMatch && from) {
      plan.renamed.push({ from, to: normalizedName(toMatch[1]) });
      from = undefined;
    }
  }
  if (
    from ||
    Object.values(plan).every((entries) => entries.length === 0) ||
    Object.values(plan).some(
      (entries) => new Set(entries.map(stableEntry)).size !== entries.length,
    )
  ) {
    throw invalidOutcome();
  }
  return plan;
}

function splitSections(content: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  let title: string | undefined;
  for (const line of lines) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      title = heading[1].trim().toLowerCase();
      result.set(title, '');
    } else if (title) {
      result.set(title, `${result.get(title)}${line}\n`);
    }
  }
  return result;
}

/**
 * Scenario titles are exact identities when a delta is applied: a MODIFIED
 * requirement replaces the base block wholesale, so a scenario missing from the
 * rewritten block is deleted from the specification even though the behaviour
 * it names may still be implemented. Returns the identities present before and
 * absent after, in the order the base spec declares them.
 */
export function findMissingScenarioIdentities(
  beforeBlock: string,
  afterBlock: string,
): string[] {
  const after = new Set(scenarioIdentities(afterBlock));
  return scenarioIdentities(beforeBlock).filter(
    (identity) => !after.has(identity),
  );
}

/**
 * Plan-time half of the same rule archive enforces. A delta whose MODIFIED
 * requirements drop live scenario identities cannot be archived, so refusing it
 * here costs a re-plan instead of an entire execution. Reads only; the delta is
 * taken from the worktree it is about to be committed from, the base from the
 * commit that plan-commit will parent onto.
 */
export function assertSpecDeltaScenarioPreservation(
  repositoryRoot: string,
  head: string,
  changeRoot: string,
  changeId: string,
  deltaSpecPaths: readonly string[],
  now: Date = new Date(),
): SpecDeltaPreflightRecord {
  const validatedBaseSpecDigests: Record<string, string> = {};
  for (const deltaPath of deltaSpecPaths) {
    const capability = deltaPath.split('/').at(-2);
    if (capability === undefined) continue;
    const baseSpecPath = `openspec/specs/${capability}/spec.md`;
    const before = readFileAtCommit(repositoryRoot, head, baseSpecPath);
    const delta = readWorktreeFile(
      repositoryRoot,
      `${changeRoot}/${changeId}/specs/${capability}/spec.md`,
    );
    if (delta === undefined) {
      throw workflowError(
        'SPEC_DELTA_PREFLIGHT_TREE_INVALID',
        `Current delta specification is unavailable during archive-applicability replay: ${deltaPath}.`,
        ExitCode.staleState,
      );
    }
    // Whether each declared operation can land at all, before whether the
    // blocks it lands preserve their scenarios: an inapplicable MODIFIED is
    // not a preservation problem, it is a delta describing a base that is not
    // there.
    const currentBase = before ?? '';
    validatedBaseSpecDigests[baseSpecPath] = digest(currentBase);

    const assessment = assessSpecDeltaAgainstBase(currentBase, delta);
    if (assessment.faults.length > 0) {
      throw deltaNotApplicable(capability, assessment.faults);
    }
    const firstMissing = assessment.missingScenarios[0];
    if (firstMissing !== undefined) {
      throw scenarioPreservationFailed(
        firstMissing.requirement,
        firstMissing.scenarios,
      );
    }
  }
  // Naming the base this passed over lets a later archive failure be read as
  // drift rather than as a plan that was never applicable.
  return {
    status: 'passed',
    validatedAt: now.toISOString(),
    validatedBaseCommit: head,
    validatedBaseSpecDigests,
    validatorVersion: SPEC_DELTA_VALIDATOR_VERSION,
  };
}

export const SPEC_DELTA_VALIDATOR_VERSION = 'spec-delta-preflight-v2';

export type SpecDeltaPreflightRecord = Readonly<{
  status: 'passed';
  validatedAt: string;
  validatedBaseCommit: string;
  validatedBaseSpecDigests: Record<string, string>;
  validatorVersion: string;
}>;

function deltaNotApplicable(
  capability: string,
  faults: readonly DeltaApplicabilityFault[],
) {
  return workflowError(
    'SPEC_DELTA_NOT_APPLICABLE',
    `Delta for ${capability} declares operations the current base cannot accept: ${faults
      .map(
        ({ operation, requirement, reason }) =>
          `${operation} "${requirement}" — ${reason}`,
      )
      .join(' ')}`,
    ExitCode.verification,
    { details: { capability, faults } },
  );
}

function readWorktreeFile(
  repositoryRoot: string,
  relativePath: string,
): string | undefined {
  try {
    return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
  } catch {
    return undefined;
  }
}

export type DeltaApplicabilityFault = {
  operation: Operation;
  requirement: string;
  reason: string;
};

export type SpecDeltaAssessment = Readonly<{
  faults: readonly DeltaApplicabilityFault[];
  missingScenarios: readonly Readonly<{
    requirement: string;
    scenarios: readonly string[];
  }>[];
}>;

/**
 * Content-pure applicability and scenario-preservation core shared by plan,
 * amendment, and archive validation. Archive still verifies the projected
 * output tree, but it may not reinterpret whether the declared operations are
 * legal or which exact scenario identities a MODIFIED block preserves.
 */
export function assessSpecDeltaAgainstBase(
  baseSpec: string,
  deltaSpec: string,
): SpecDeltaAssessment {
  const faults = findDeltaApplicabilityFaults(baseSpec, deltaSpec);
  const baseRequirements = parseRequirements(baseSpec);
  const modified = requirementBlocks(
    splitSections(deltaSpec).get('modified requirements') ?? '',
  );
  const missingScenarios = modified.flatMap(({ name, raw }) => {
    const baseBlock = baseRequirements.get(name);
    if (baseBlock === undefined) return [];
    const scenarios = findMissingScenarioIdentities(baseBlock, raw);
    return scenarios.length === 0 ? [] : [{ requirement: name, scenarios }];
  });
  return Object.freeze({
    faults: Object.freeze(faults.map((fault) => Object.freeze({ ...fault }))),
    missingScenarios: Object.freeze(
      missingScenarios.map(({ requirement, scenarios }) =>
        Object.freeze({
          requirement,
          scenarios: Object.freeze([...scenarios]),
        }),
      ),
    ),
  });
}

/**
 * Whether the operations a delta declares can be applied to the base as it
 * stands right now. Archive answers this by applying and inspecting the
 * result; plan-commit cannot, but it can check the half that depends only on
 * the delta and the current base — modifying something absent, adding
 * something present, removing something absent, or renaming onto an occupied
 * name are all decidable before an execution is spent.
 *
 * Reports every fault rather than the first, because a delta with three
 * inapplicable operations should cost one repair round, not three.
 */
export function findDeltaApplicabilityFaults(
  baseSpec: string,
  deltaSpec: string,
): DeltaApplicabilityFault[] {
  const sections = splitSections(deltaSpec);
  const base = parseRequirements(baseSpec);
  const faults: DeltaApplicabilityFault[] = [];

  for (const { name } of requirementBlocks(
    sections.get('modified requirements') ?? '',
  )) {
    if (!base.has(name)) {
      faults.push({
        operation: 'modified',
        requirement: name,
        reason: 'Requirement is not present in the base specification.',
      });
    }
  }
  for (const { name } of requirementBlocks(
    sections.get('added requirements') ?? '',
  )) {
    if (base.has(name)) {
      faults.push({
        operation: 'added',
        requirement: name,
        reason: 'Requirement is already present in the base specification.',
      });
    }
  }
  for (const name of requirementNames(
    sections.get('removed requirements') ?? '',
  )) {
    if (!base.has(name)) {
      faults.push({
        operation: 'removed',
        requirement: name,
        reason: 'Requirement is not present in the base specification.',
      });
    }
  }
  for (const { from, to } of parseRenames(
    sections.get('renamed requirements') ?? '',
  )) {
    if (!base.has(from)) {
      faults.push({
        operation: 'renamed',
        requirement: from,
        reason: 'Rename source is not present in the base specification.',
      });
    }
    if (base.has(to)) {
      faults.push({
        operation: 'renamed',
        requirement: to,
        reason:
          'Rename destination is already present in the base specification.',
      });
    }
  }
  return faults;
}

function parseRenames(content: string): Array<{ from: string; to: string }> {
  const renames: Array<{ from: string; to: string }> = [];
  let from: string | undefined;
  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    const fromMatch =
      /^\s*-?\s*FROM:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/i.exec(line);
    const toMatch = /^\s*-?\s*TO:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/i.exec(
      line,
    );
    if (fromMatch) from = fromMatch[1].trim();
    if (toMatch && from !== undefined) {
      renames.push({ from, to: toMatch[1].trim() });
      from = undefined;
    }
  }
  return renames;
}

function scenarioIdentities(block: string): string[] {
  const seen = new Set<string>();
  return block
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .flatMap((line) => {
      const match = /^####\s*Scenario:\s*(.+?)\s*$/i.exec(line);
      if (!match) return [];
      const identity = match[1].trim();
      if (!identity || seen.has(identity)) return [];
      seen.add(identity);
      return [identity];
    });
}

function requirementNames(content: string): string[] {
  return content.split('\n').flatMap((line) => {
    const match = /^###\s*Requirement:\s*(.+?)\s*$/i.exec(line);
    return match ? [normalizedName(match[1])] : [];
  });
}

function parseRequirements(content: string): Map<string, string> {
  return new Map(
    requirementBlocks(content).map(({ name, raw }) => [name, raw]),
  );
}

function requirementBlocks(content: string): RequirementBlock[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const blocks: RequirementBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^###\s*Requirement:\s*(.+?)\s*$/i.exec(lines[index]);
    if (!match) continue;
    const body = [lines[index]];
    while (
      index + 1 < lines.length &&
      !/^###\s*Requirement:/i.test(lines[index + 1]) &&
      !/^##\s+/.test(lines[index + 1])
    ) {
      body.push(lines[(index += 1)]);
    }
    blocks.push({
      name: normalizedName(match[1]),
      raw: body.join('\n').trimEnd(),
    });
  }
  return blocks;
}

function normalizedName(value: string): string {
  const result = value.trim();
  if (!result) throw invalidOutcome();
  return result;
}

function stableEntry(
  value: string | RequirementBlock | { from: string; to: string },
): string {
  if (typeof value === 'string') return value;
  return 'name' in value ? value.name : `${value.from}\0${value.to}`;
}

function normalizedBlock(value: string): string {
  return value.replace(/\r\n?/g, '\n').trimEnd();
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function invalidOutcome() {
  return workflowError(
    'ARCHIVE_DELTA_OUTCOME_INVALID',
    'Archive base-spec output does not realize every declared delta operation.',
    ExitCode.verification,
  );
}

function scenarioPreservationFailed(
  requirement: string,
  missing: readonly string[],
) {
  return workflowError(
    'SPEC_SCENARIO_PRESERVATION_FAILED',
    `Requirement "${requirement}" drops existing scenario identities: ${missing
      .map((identity) => `"${identity}"`)
      .join(
        ', ',
      )}. A MODIFIED requirement must keep every current scenario title; titles are exact identities during apply, so a reworded title reads as a deletion.`,
    ExitCode.verification,
    { details: { requirement, missingScenarios: missing } },
  );
}
