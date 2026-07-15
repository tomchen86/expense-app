import crypto from 'node:crypto';

import { readFileAtCommit } from './ci-git.ts';
import { ExitCode, workflowError } from './errors.ts';

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
    const plan = parseDelta(delta);
    const beforeRequirements = parseRequirements(before ?? '');
    const afterRequirements = parseRequirements(after);
    verifyPlan(plan, beforeRequirements, afterRequirements);
    for (const operation of Object.keys(totals) as Operation[]) {
      totals[operation] += plan[operation].length;
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
