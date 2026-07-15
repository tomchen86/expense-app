import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  digestArtifacts,
  loadChangeContract,
  loadWorkflowConfig,
  type ChangeContract,
} from './contracts.ts';
import { workflowContractArtifactPaths } from './contract-artifacts.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  createOpenSpecAdapter,
  resolveOpenSpecInstallation,
} from './openspec-adapter.ts';
import {
  inspectOpenSpecSchemaContract,
  type OpenSpecSchemaContract,
} from './openspec-schema-contract.ts';
import { collectInstalledPackageClosure } from './package-closure.ts';
import { assertChangeId } from './paths.ts';
import { assertPlanningPaths } from './planning-paths.ts';

export type ManagedChangeDiagnostic = {
  level: 'ERROR' | 'WARNING' | 'INFO';
  path: string;
  message: string;
  line?: number;
  column?: number;
};

export type ValidatedChangeContract = ChangeContract & {
  schemaName: 'expense-app';
  openspec: {
    version: '1.6.0';
    schemaName: 'expense-app';
    statusComplete: true;
    validationValid: true;
  };
  diagnostics: ManagedChangeDiagnostic[];
  artifactModes: Record<string, '100644' | '100755'>;
  contractDigest: string;
};

type ContractSnapshot = {
  contract: ChangeContract;
  schemaName: 'expense-app';
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
  };
}

function inspectSnapshot(
  repositoryRoot: string,
  requestedChangeId: string,
): ContractSnapshot {
  const config = loadWorkflowConfig(repositoryRoot);
  const changeId = assertChangeId(requestedChangeId);
  const changePaths = inspectChangeTree(
    repositoryRoot,
    config.changeRoot,
    changeId,
  );
  const schemaName = readManagedMetadata(
    path.join(repositoryRoot, config.changeRoot, changeId, '.openspec.yaml'),
  );
  const preliminary = loadChangeContract(repositoryRoot, changeId);
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
): string[] {
  const changeDirectory = path.join(repositoryRoot, changeRoot, changeId);
  const files: string[] = [];
  walk(changeDirectory);
  const relativePaths = files.map((filePath) =>
    relative(repositoryRoot, filePath),
  );
  assertPlanningPaths(changeRoot, changeId, relativePaths);
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

function readManagedMetadata(metadataPath: string): 'expense-app' {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      fs.readFileSync(metadataPath),
    );
  } catch {
    throw invalidMetadata();
  }
  if (text.startsWith('\uFEFF') || text.includes('\0') || text.includes('\r')) {
    throw invalidMetadata();
  }
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : [];
  const fields = new Map<string, string>();
  for (const line of lines) {
    const match = /^([a-z][a-z0-9-]*): ([^\s].*)$/.exec(line);
    if (!match || fields.has(match[1])) {
      throw invalidMetadata();
    }
    fields.set(match[1], match[2]);
  }
  if (
    fields.size !== 2 ||
    !fields.has('schema') ||
    !fields.has('created') ||
    !isCanonicalDate(fields.get('created') ?? '')
  ) {
    throw invalidMetadata();
  }
  if (fields.get('schema') !== 'expense-app') {
    throw workflowError(
      'OPENSPEC_MANAGED_SCHEMA_REQUIRED',
      'Managed changes must declare the reviewed expense-app schema.',
      ExitCode.verification,
    );
  }
  return 'expense-app';
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

function isCanonicalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(milliseconds) &&
    new Date(milliseconds).toISOString().slice(0, 10) === value
  );
}

function invalidMetadata() {
  return workflowError(
    'OPENSPEC_CHANGE_METADATA_INVALID',
    'Managed change metadata must contain one schema and canonical created date.',
    ExitCode.guard,
  );
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
