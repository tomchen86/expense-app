import fs from 'node:fs';
import path from 'node:path';

import {
  assertSameMembers,
  assertSafeOutputPath,
  assertUnique,
  identifierArray,
  invalidPayload,
  isCanonicalIsoDate,
  nonNegativeInteger,
  parseArtifactPaths,
  parseIssue,
  parsePlanningHome,
  parseRoot,
  parseSchemaIssue,
  record,
  safeIdentifier,
} from './openspec-payload-primitives.ts';

export type OpenSpecChangeSummary = {
  name: string;
  completedTasks: number;
  totalTasks: number;
  status: 'no-tasks' | 'in-progress' | 'complete';
};

export type OpenSpecChangeList = {
  changes: OpenSpecChangeSummary[];
  root: { path: string; source: 'nearest' };
};

export type OpenSpecSchemaResolution = {
  name: string;
  source: 'package' | 'project';
  path: string;
};

export type OpenSpecSchemaValidation = {
  name: string;
  path: string;
  valid: boolean;
  issues: Array<Record<string, unknown>>;
};

export type OpenSpecStatus = {
  changeName: string;
  schemaName: string;
  changeRoot: string;
  isComplete: boolean;
  artifactIds: string[];
  root: { path: string; source: 'nearest' };
};

export type OpenSpecInstructions = {
  changeName: string;
  artifactId: string;
  schemaName: string;
  changeDir: string;
  outputPath: string;
  resolvedOutputPath: string;
  existingOutputPaths: string[];
  instruction: string;
  template: string;
  root: { path: string; source: 'nearest' };
};

export type OpenSpecValidation = {
  valid: boolean;
  items: Array<{
    id: string;
    type: 'change' | 'spec';
    valid: boolean;
    issues: Array<Record<string, unknown>>;
  }>;
  root: { path: string; source: 'nearest' };
};

type ParsedArtifactStatus = {
  id: string;
  outputPath: string;
  status: 'done' | 'ready' | 'blocked';
  missingDependencies: string[];
};

export function parseChangeList(
  value: unknown,
  repositoryRoot: string,
): OpenSpecChangeList {
  const payload = record(value);
  const root = parseRoot(payload.root, repositoryRoot);
  if (!Array.isArray(payload.changes)) {
    throw invalidPayload();
  }
  const changes = payload.changes.map((entry) => {
    const change = record(entry);
    const name = safeIdentifier(change.name);
    const completedTasks = nonNegativeInteger(change.completedTasks);
    const totalTasks = nonNegativeInteger(change.totalTasks);
    const expectedStatus =
      totalTasks === 0
        ? 'no-tasks'
        : completedTasks === totalTasks
          ? 'complete'
          : 'in-progress';
    if (
      completedTasks > totalTasks ||
      change.status !== expectedStatus ||
      typeof change.lastModified !== 'string' ||
      !isCanonicalIsoDate(change.lastModified)
    ) {
      throw invalidPayload();
    }
    return {
      name,
      completedTasks,
      totalTasks,
      status: change.status as OpenSpecChangeSummary['status'],
    };
  });
  assertUnique(changes.map(({ name }) => name));
  for (let index = 1; index < changes.length; index += 1) {
    if (changes[index - 1]!.name.localeCompare(changes[index]!.name) > 0) {
      throw invalidPayload();
    }
  }
  return { changes, root };
}

export function parseSchemaResolution(
  value: unknown,
  expected: { name: string; source: 'package' | 'project'; path: string },
): OpenSpecSchemaResolution {
  const payload = record(value);
  const expectedPath = fs.realpathSync(expected.path);
  if (
    payload.name !== expected.name ||
    payload.source !== expected.source ||
    payload.path !== expectedPath ||
    !Array.isArray(payload.shadows) ||
    payload.shadows.length !== 0
  ) {
    throw invalidPayload();
  }
  return { ...expected, path: expectedPath };
}

export function parseSchemaValidation(
  value: unknown,
  expected: { name: string; path: string },
): OpenSpecSchemaValidation {
  const payload = record(value);
  const expectedPath = fs.realpathSync(expected.path);
  if (
    payload.name !== expected.name ||
    payload.path !== expectedPath ||
    typeof payload.valid !== 'boolean' ||
    !Array.isArray(payload.issues)
  ) {
    throw invalidPayload();
  }
  return {
    name: expected.name,
    path: expectedPath,
    valid: payload.valid,
    issues: payload.issues.map(parseSchemaIssue),
  };
}

export function parseStatus(
  value: unknown,
  context: { repositoryRoot: string; changeId: string; schemaName: string },
): OpenSpecStatus {
  const payload = record(value);
  const root = parseRoot(payload.root, context.repositoryRoot);
  const changeRoot = path.join(
    context.repositoryRoot,
    'openspec/changes',
    context.changeId,
  );
  if (
    payload.changeName !== context.changeId ||
    payload.schemaName !== context.schemaName ||
    payload.changeRoot !== changeRoot ||
    typeof payload.isComplete !== 'boolean'
  ) {
    throw invalidPayload();
  }
  parsePlanningHome(payload.planningHome, context.repositoryRoot);
  const artifactPaths = new Map(
    Object.entries(record(payload.artifactPaths)).map(([id, artifact]) => [
      safeIdentifier(id),
      parseArtifactPaths(artifact, changeRoot),
    ]),
  );
  if (
    !Array.isArray(payload.artifacts) ||
    !Array.isArray(payload.applyRequires)
  ) {
    throw invalidPayload();
  }
  const artifacts: ParsedArtifactStatus[] = payload.artifacts.map((entry) => {
    const artifact = record(entry);
    const id = safeIdentifier(artifact.id);
    const outputPath = assertSafeOutputPath(artifact.outputPath);
    if (!['ready', 'blocked', 'done'].includes(String(artifact.status))) {
      throw invalidPayload();
    }
    const status = artifact.status as ParsedArtifactStatus['status'];
    const hasMissingDependencies = Object.hasOwn(artifact, 'missingDeps');
    const missingDependencies = hasMissingDependencies
      ? identifierArray(artifact.missingDeps)
      : [];
    if (
      (status === 'blocked' && missingDependencies.length === 0) ||
      (status !== 'blocked' && hasMissingDependencies)
    ) {
      throw invalidPayload();
    }
    return { id, outputPath, status, missingDependencies };
  });
  const artifactIds = artifacts.map(({ id }) => id);
  if (artifactIds.length === 0) {
    throw invalidPayload();
  }
  assertUnique(artifactIds);
  assertSameMembers([...artifactPaths.keys()], artifactIds);
  const artifactIdSet = new Set(artifactIds);
  for (const artifact of artifacts) {
    const paths = artifactPaths.get(artifact.id);
    if (
      !paths ||
      paths.outputPath !== artifact.outputPath ||
      (artifact.status === 'done') !== paths.existingOutputPaths.length > 0 ||
      artifact.missingDependencies.some((id) => !artifactIdSet.has(id))
    ) {
      throw invalidPayload();
    }
  }
  const applyRequires = identifierArray(payload.applyRequires);
  if (
    applyRequires.length === 0 ||
    applyRequires.some((id) => !artifactIdSet.has(id)) ||
    payload.isComplete !== artifacts.every(({ status }) => status === 'done')
  ) {
    throw invalidPayload();
  }
  return {
    changeName: context.changeId,
    schemaName: context.schemaName,
    changeRoot,
    isComplete: payload.isComplete,
    artifactIds,
    root,
  };
}

export function parseInstructions(
  value: unknown,
  context: {
    repositoryRoot: string;
    changeId: string;
    schemaName: string;
    artifactId: string;
  },
): OpenSpecInstructions {
  const payload = record(value);
  const root = parseRoot(payload.root, context.repositoryRoot);
  const changeDir = path.join(
    context.repositoryRoot,
    'openspec/changes',
    context.changeId,
  );
  if (
    payload.changeName !== context.changeId ||
    payload.artifactId !== context.artifactId ||
    payload.schemaName !== context.schemaName ||
    payload.changeDir !== changeDir ||
    typeof payload.instruction !== 'string' ||
    typeof payload.template !== 'string'
  ) {
    throw invalidPayload();
  }
  parsePlanningHome(payload.planningHome, context.repositoryRoot);
  const paths = parseArtifactPaths(payload, changeDir);
  if (!Array.isArray(payload.dependencies) || !Array.isArray(payload.unlocks)) {
    throw invalidPayload();
  }
  return {
    changeName: context.changeId,
    artifactId: context.artifactId,
    schemaName: context.schemaName,
    changeDir,
    ...paths,
    instruction: payload.instruction,
    template: payload.template,
    root,
  };
}

export function parseValidation(
  value: unknown,
  context: {
    repositoryRoot: string;
    expectedType: 'change' | 'spec';
    expectedId?: string;
  },
): OpenSpecValidation {
  const payload = record(value);
  const root = parseRoot(payload.root, context.repositoryRoot);
  if (!Array.isArray(payload.items)) {
    throw invalidPayload();
  }
  const items = payload.items.map((entry) => {
    const item = record(entry);
    const id = safeIdentifier(item.id);
    if (
      item.type !== context.expectedType ||
      typeof item.valid !== 'boolean' ||
      !Array.isArray(item.issues) ||
      typeof item.durationMs !== 'number' ||
      !Number.isSafeInteger(item.durationMs) ||
      item.durationMs < 0
    ) {
      throw invalidPayload();
    }
    return {
      id,
      type: context.expectedType,
      valid: item.valid,
      issues: item.issues.map(parseIssue),
    };
  });
  assertUnique(items.map(({ id }) => id));
  if (
    (context.expectedId !== undefined &&
      (items.length !== 1 || items[0]?.id !== context.expectedId)) ||
    items.length === 0
  ) {
    throw invalidPayload();
  }
  const summary = record(payload.summary);
  const totals = record(summary.totals);
  const byType = record(summary.byType);
  const typeTotals = record(byType[context.expectedType]);
  const passed = items.filter(({ valid }) => valid).length;
  if (
    totals.items !== items.length ||
    totals.passed !== passed ||
    totals.failed !== items.length - passed ||
    Object.keys(byType).length !== 1 ||
    typeTotals.items !== items.length ||
    typeTotals.passed !== passed ||
    typeTotals.failed !== items.length - passed ||
    payload.version !== '1.0'
  ) {
    throw invalidPayload();
  }
  return { valid: passed === items.length, items, root };
}
