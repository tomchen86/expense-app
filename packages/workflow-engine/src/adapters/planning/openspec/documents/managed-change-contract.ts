import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  digestArtifacts,
  loadChangeContract,
  loadWorkflowConfig,
  type ChangeContract,
  type ManagedSchemaName,
  readManagedSchemaName,
} from '../../../consumer/expense-app/work-registry/contracts.ts';
import { workflowContractArtifactPaths } from '../../../consumer/expense-app/work-registry/contract-artifacts.ts';
import {
  ExitCode,
  workflowError,
} from '../../../../foundation/errors/errors.ts';
import {
  createOpenSpecAdapter,
  resolveOpenSpecInstallation,
} from './openspec-adapter.ts';
import {
  inspectOpenSpecSchemaContract,
  type OpenSpecSchemaContract,
} from './openspec-schema-contract.ts';
import { collectInstalledPackageClosure } from '../../../../runtime/repository-transaction/package-closure.ts';
import {
  assertChangeId,
  normalizeChangedPath,
} from '../../../../runtime/session-workspace/paths.ts';
import { assertPlanningPaths } from '../../../../modules/source/planning-paths.ts';
import {
  validateInvestigationFirstPlanningReadiness,
  type InvestigationFirstPlanningAssuranceSummary,
} from '../../../../modules/assurance/planning-assurance-validator.ts';

export type ManagedChangeDiagnostic = {
  level: 'ERROR' | 'WARNING' | 'INFO';
  path: string;
  message: string;
  line?: number;
  column?: number;
};

export type ValidatedChangeContract = ChangeContract & {
  schemaName: ManagedSchemaName;
  openspec: {
    version: '1.6.0';
    schemaName: ManagedSchemaName;
    statusComplete: true;
    validationValid: true;
  };
  diagnostics: ManagedChangeDiagnostic[];
  artifactModes: Record<string, '100644' | '100755'>;
  contractDigest: string;
  planningAssurance: InvestigationFirstPlanningAssuranceSummary | null;
};

type ContractSnapshot = {
  contract: ChangeContract;
  schemaName: ManagedSchemaName;
  schema: OpenSpecSchemaContract;
  artifactPaths: string[];
  artifactDigests: Record<string, string>;
  artifactModes: Record<string, '100644' | '100755'>;
  digest: string;
};

export function loadValidatedChangeContract(
  repositoryRoot: string,
  requestedChangeId: string,
): ValidatedChangeContract {
  const root = canonicalRepositoryRoot(repositoryRoot);
  const before = inspectSnapshot(root, requestedChangeId);
  if (
    before.schemaName === 'expense-app-v2' &&
    !before.contract.investigation?.applicability
  ) {
    throw workflowError(
      'OPENSPEC_CHANGE_NOT_READY',
      'Investigation-first planning requires a structured applicability decision.',
      ExitCode.verification,
      {
        details: { reason: 'investigation-applicability-required' },
      },
    );
  }
  const adapter = createOpenSpecAdapter(root);

  for (const schemaName of ['spec-driven', 'expense-app']) {
    adapter.whichSchema(schemaName);
    adapter.validateSchema(schemaName);
  }
  const status = adapter.status(before.contract.changeId, before.schemaName);
  const validation = adapter.validateChange(before.contract.changeId);
  const after = inspectSnapshot(root, requestedChangeId);

  if (before.digest !== after.digest) {
    throw workflowError(
      'OPENSPEC_CHANGE_STATE_CHANGED',
      'Managed change inputs changed while OpenSpec readiness was evaluated.',
      ExitCode.staleState,
    );
  }
  if (!status.isComplete) {
    const diagnostics = status.artifacts
      .filter(({ status: artifactStatus }) => artifactStatus !== 'done')
      .map(({ id, status: artifactStatus, missingDependencies }) => ({
        artifactId: id,
        missingDependencies,
        status: artifactStatus,
      }))
      .sort((left, right) => compareText(left.artifactId, right.artifactId));
    throw workflowError(
      'OPENSPEC_CHANGE_NOT_READY',
      'OpenSpec does not report the complete managed artifact graph.',
      ExitCode.verification,
      { details: { diagnostics } },
    );
  }

  const diagnostics = stableDiagnostics(
    validation.items.flatMap(({ issues }) => issues),
  );
  if (!validation.valid) {
    throw workflowError(
      'OPENSPEC_CHANGE_INVALID',
      'OpenSpec strict validation rejected the managed change.',
      ExitCode.verification,
      { details: { diagnostics } },
    );
  }

  const planningAssurance =
    after.schemaName === 'expense-app-v2'
      ? validateInvestigationFirstPlanningReadiness(root, after.contract)
          .summary
      : null;

  return {
    ...after.contract,
    artifactPaths: after.artifactPaths,
    artifactDigests: after.artifactDigests,
    schemaName: after.schemaName,
    openspec: {
      version: after.schema.version,
      schemaName: after.schemaName,
      statusComplete: true,
      validationValid: true,
    },
    diagnostics,
    artifactModes: after.artifactModes,
    contractDigest: after.digest,
    planningAssurance,
  };
}

function inspectSnapshot(
  repositoryRoot: string,
  requestedChangeId: string,
): ContractSnapshot {
  const config = loadWorkflowConfig(repositoryRoot);
  const changeId = assertChangeId(requestedChangeId);
  if (changeId === 'archive') {
    throw workflowError(
      'PLANNING_CHANGE_ID_RESERVED',
      'The OpenSpec archive container cannot be used as an active change ID.',
      ExitCode.guard,
    );
  }
  const schemaName = readManagedSchemaName(
    repositoryRoot,
    path.join(repositoryRoot, config.changeRoot, changeId, '.openspec.yaml'),
  );
  const changePaths = inspectChangeTree(
    repositoryRoot,
    config.changeRoot,
    changeId,
    schemaName,
  );
  const preliminary = loadChangeContract(repositoryRoot, changeId, schemaName);
  const schema = inspectOpenSpecSchemaContract(repositoryRoot);
  const installation = resolveOpenSpecInstallation(repositoryRoot);
  let runtimeClosure: ReturnType<typeof collectInstalledPackageClosure>;
  try {
    runtimeClosure = collectInstalledPackageClosure(
      repositoryRoot,
      path.join(installation.packageDirectory, 'package.json'),
    );
  } catch {
    throw workflowError(
      'OPENSPEC_RUNTIME_CLOSURE_UNSAFE',
      'The pinned OpenSpec runtime closure could not be resolved safely.',
      ExitCode.unsafeEnvironment,
    );
  }
  if (runtimeClosure.some(({ kind }) => kind !== 'file')) {
    throw workflowError(
      'OPENSPEC_RUNTIME_CLOSURE_UNSAFE',
      'The pinned OpenSpec runtime closure must contain regular files only.',
      ExitCode.unsafeEnvironment,
    );
  }
  const runtimeFiles = runtimeClosure.map((entry) => {
    if (entry.kind !== 'file') {
      throw workflowError(
        'OPENSPEC_RUNTIME_CLOSURE_UNSAFE',
        'The pinned OpenSpec runtime closure must contain regular files only.',
        ExitCode.unsafeEnvironment,
      );
    }
    return entry.filePath;
  });
  const artifactPaths = uniqueSortedPaths(repositoryRoot, [
    ...changePaths,
    ...workflowPolicyPaths(repositoryRoot),
    ...schema.trackedPaths,
    ...Object.values(schema.packageSchema.files).map(({ path }) => path),
    path.join(repositoryRoot, 'package.json'),
    path.join(repositoryRoot, 'pnpm-lock.yaml'),
    path.join(repositoryRoot, 'pnpm-workspace.yaml'),
    ...runtimeFiles,
  ]);
  const artifactDigests = digestArtifacts(repositoryRoot, artifactPaths);
  const artifactModes = Object.fromEntries(
    artifactPaths
      .map(
        (artifactPath) =>
          [
            relative(repositoryRoot, artifactPath),
            logicalGitMode(fs.lstatSync(artifactPath).mode),
          ] as const,
      )
      .sort(([left], [right]) => compareText(left, right)),
  );
  const digest = crypto
    .createHash('sha256')
    .update('managed-change-contract-v1\0')
    .update(JSON.stringify({ schemaName, artifactDigests, artifactModes }))
    .digest('hex');

  return {
    contract: preliminary,
    schemaName,
    schema,
    artifactPaths,
    artifactDigests,
    artifactModes,
    digest,
  };
}

function inspectChangeTree(
  repositoryRoot: string,
  changeRoot: string,
  changeId: string,
  schemaName: ManagedSchemaName,
): string[] {
  const changeDirectory = path.join(repositoryRoot, changeRoot, changeId);
  const files: string[] = [];
  walk(changeDirectory);
  const relativePaths = files.map((filePath) =>
    relative(repositoryRoot, filePath),
  );
  if (schemaName === 'expense-app-v2') {
    assertV2PlanningPaths(changeRoot, changeId, relativePaths);
  } else {
    assertPlanningPaths(changeRoot, changeId, relativePaths);
  }
  return files.sort((left, right) =>
    compareText(
      relative(repositoryRoot, left),
      relative(repositoryRoot, right),
    ),
  );

  function walk(directory: string): void {
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (
      !stats?.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(directory) !== directory
    ) {
      throw unsafeChangeTree();
    }
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name))) {
      const entryPath = path.join(directory, entry.name);
      const entryStats = fs.lstatSync(entryPath);
      if (entryStats.isDirectory() && !entryStats.isSymbolicLink()) {
        walk(entryPath);
        continue;
      }
      if (
        !entryStats.isFile() ||
        entryStats.isSymbolicLink() ||
        fs.realpathSync(entryPath) !== entryPath ||
        logicalGitMode(entryStats.mode) !== '100644'
      ) {
        throw unsafeChangeTree();
      }
      const content = fs.readFileSync(entryPath);
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(content);
      } catch {
        throw unsafeChangeTree();
      }
      if (!text.trim()) {
        throw workflowError(
          'OPENSPEC_CHANGE_ARTIFACT_EMPTY',
          'Managed OpenSpec artifacts must contain non-whitespace text.',
          ExitCode.guard,
          { details: { path: relative(repositoryRoot, entryPath) } },
        );
      }
      files.push(entryPath);
    }
  }
}

function assertV2PlanningPaths(
  changeRoot: string,
  changeId: string,
  paths: string[],
): void {
  if (changeId === 'archive') {
    throw workflowError(
      'PLANNING_CHANGE_ID_RESERVED',
      'The OpenSpec archive container cannot be used as an active change ID.',
      ExitCode.guard,
    );
  }
  const prefix = `${changeRoot}/${changeId}/`;
  const exact = new Set([
    `${prefix}.openspec.yaml`,
    `${prefix}proposal.md`,
    `${prefix}design.md`,
    `${prefix}tasks.md`,
    `${prefix}guard.json`,
    `${prefix}investigation.json`,
    `${prefix}execution.json`,
    `${prefix}plan-review.json`,
  ]);
  const invalid = paths.filter((candidate) => {
    const normalized = normalizeChangedPath(candidate);
    if (exact.has(normalized)) {
      return false;
    }
    if (!normalized.startsWith(`${prefix}specs/`)) {
      return true;
    }
    const relativePath = normalized.slice(`${prefix}specs/`.length);
    const segments = relativePath.split('/');
    return (
      segments.length < 2 ||
      segments.at(-1) !== 'spec.md' ||
      segments
        .slice(0, -1)
        .some((segment) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment))
    );
  });
  if (invalid.length > 0) {
    throw workflowError(
      'PLANNING_PATHS_INVALID',
      'Planning transition contains paths outside the named v2 planning tree.',
      ExitCode.guard,
      { details: { invalidPaths: invalid.sort() } },
    );
  }
}

function workflowPolicyPaths(repositoryRoot: string): string[] {
  const workflowRoot = path.join(repositoryRoot, 'workflow');
  const rootJson = fs
    .readdirSync(workflowRoot, { withFileTypes: true })
    .filter(({ name }) => name.endsWith('.json'))
    .map(({ name }) => path.join(workflowRoot, name));
  return [...workflowContractArtifactPaths(repositoryRoot), ...rootJson];
}

function uniqueSortedPaths(repositoryRoot: string, paths: string[]): string[] {
  return [...new Set(paths.map((filePath) => path.resolve(filePath)))].sort(
    (left, right) =>
      compareText(
        relative(repositoryRoot, left),
        relative(repositoryRoot, right),
      ),
  );
}

function stableDiagnostics(
  issues: Array<Record<string, unknown>>,
): ManagedChangeDiagnostic[] {
  return issues
    .map((issue) => ({
      level: issue.level as ManagedChangeDiagnostic['level'],
      path: String(issue.path),
      message: String(issue.message),
      ...(typeof issue.line === 'number' ? { line: issue.line } : {}),
      ...(typeof issue.column === 'number' ? { column: issue.column } : {}),
    }))
    .sort(
      (left, right) =>
        compareText(left.path, right.path) ||
        (left.line ?? 0) - (right.line ?? 0) ||
        (left.column ?? 0) - (right.column ?? 0) ||
        compareText(left.level, right.level) ||
        compareText(left.message, right.message),
    );
}

function canonicalRepositoryRoot(repositoryRoot: string): string {
  try {
    const root = path.resolve(repositoryRoot);
    const stats = fs.lstatSync(root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('unsafe repository root');
    }
    return fs.realpathSync(root);
  } catch {
    throw workflowError(
      'OPENSPEC_CHANGE_ROOT_UNSAFE',
      'Managed change validation requires a canonical repository root.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function logicalGitMode(mode: number): '100644' | '100755' {
  return (mode & 0o111) === 0 ? '100644' : '100755';
}

function unsafeChangeTree() {
  return workflowError(
    'OPENSPEC_CHANGE_TREE_UNSAFE',
    'Managed OpenSpec artifacts must be canonical non-executable regular files.',
    ExitCode.unsafeEnvironment,
  );
}

function relative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
