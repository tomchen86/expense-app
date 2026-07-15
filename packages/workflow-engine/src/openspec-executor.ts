import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import { createTrustedExecutionEnvironment } from './execution-environment.ts';
import { resolveDeclaredPackage } from './package-closure.ts';
import {
  OPENSPEC_PACKAGE_NAME,
  OPENSPEC_PACKAGE_VERSION,
  verifyOpenSpecSupplyChain,
  type OpenSpecSupplyChainProvenance,
} from './openspec-provenance.ts';

const PACKAGE_NAME = OPENSPEC_PACKAGE_NAME;
export const PINNED_OPENSPEC_VERSION = OPENSPEC_PACKAGE_VERSION;
const OPENSPEC_SCHEMA_DIAGNOSTIC =
  'Note: Schema commands are experimental and may change.\n';

export type OpenSpecInstallation = OpenSpecSupplyChainProvenance & {
  repositoryRoot: string;
  packageDirectory: string;
  binPath: string;
  version: '1.6.0';
};

type OpenSpecOperation =
  | 'version'
  | 'doctor'
  | 'list-changes'
  | 'schema-which'
  | 'schema-validate'
  | 'status'
  | 'instructions'
  | 'validate-change'
  | 'validate-specs'
  | 'archive';

export type OpenSpecProcessOptions = {
  timeoutMs?: number;
  maxOutputBytes?: number;
  executionRoot?: string;
};

export type OpenSpecProcess = {
  version(): '1.6.0';
  doctor(): ProcessDocument;
  listChanges(): ProcessDocument;
  whichSchema(name: string): ProcessDocument;
  validateSchema(name: string): ProcessDocument;
  status(changeId: string, schemaName: string): ProcessDocument;
  instructions(
    changeId: string,
    schemaName: string,
    artifactId: string,
  ): ProcessDocument;
  validateChange(changeId: string): ProcessDocument;
  validateAllSpecs(): ProcessDocument;
  archive(changeId: string): ProcessDocument;
};

type ProcessDocument = { value: unknown; status: number };

export function resolveOpenSpecInstallation(
  repositoryRoot: string,
): OpenSpecInstallation {
  try {
    const root = fs.realpathSync(repositoryRoot);
    const rootManifestPath = path.join(root, 'package.json');
    const rootManifestStats = fs.lstatSync(rootManifestPath);
    if (!rootManifestStats.isFile() || rootManifestStats.isSymbolicLink()) {
      throw new Error('root manifest is unsafe');
    }
    const rootManifest = readRecord(rootManifestPath);
    const developmentDependencies = stringRecord(rootManifest.devDependencies);
    if (developmentDependencies[PACKAGE_NAME] !== PINNED_OPENSPEC_VERSION) {
      throw new Error('OpenSpec dependency is not pinned exactly');
    }
    const provenance = verifyOpenSpecSupplyChain(root);
    const resolved = resolveDeclaredPackage(
      root,
      rootManifestPath,
      PACKAGE_NAME,
      PINNED_OPENSPEC_VERSION,
    );
    if (
      !resolved ||
      resolved.installedName !== PACKAGE_NAME ||
      resolved.manifest.name !== PACKAGE_NAME ||
      resolved.manifest.version !== PINNED_OPENSPEC_VERSION
    ) {
      throw new Error('installed OpenSpec identity or version differs');
    }
    const packageDirectory = fs.realpathSync(
      path.dirname(resolved.manifestPath),
    );
    assertInside(root, packageDirectory);
    const bin = readBin(resolved.manifest.bin);
    const unresolvedBinPath = path.resolve(packageDirectory, bin);
    const binStats = fs.lstatSync(unresolvedBinPath);
    if (!binStats.isFile() || binStats.isSymbolicLink()) {
      throw new Error('OpenSpec bin is not a plain file');
    }
    const binPath = fs.realpathSync(unresolvedBinPath);
    assertInside(packageDirectory, binPath);
    return {
      ...provenance,
      repositoryRoot: root,
      packageDirectory,
      binPath,
      version: PINNED_OPENSPEC_VERSION,
    };
  } catch (error) {
    if (
      error instanceof WorkflowError &&
      error.code === 'OPENSPEC_INSTALLATION_INVALID'
    ) {
      throw error;
    }
    throw workflowError(
      'OPENSPEC_INSTALLATION_INVALID',
      'The exact project-local OpenSpec 1.6.0 installation is unavailable or unsafe.',
      ExitCode.unsafeEnvironment,
    );
  }
}

export function createOpenSpecProcess(
  installation: OpenSpecInstallation,
  options: OpenSpecProcessOptions = {},
): OpenSpecProcess {
  const executor = new OpenSpecExecutor(installation, options);
  return {
    version: () => executor.version(),
    doctor: () => executor.json('doctor', ['doctor', '--json'], '', [0, 1]),
    listChanges: () =>
      executor.json(
        'list-changes',
        ['list', '--changes', '--sort', 'name', '--json'],
        '',
      ),
    whichSchema: (name) =>
      executor.json(
        'schema-which',
        ['schema', 'which', name, '--json'],
        OPENSPEC_SCHEMA_DIAGNOSTIC,
      ),
    validateSchema: (name) =>
      executor.json(
        'schema-validate',
        ['schema', 'validate', name, '--json'],
        OPENSPEC_SCHEMA_DIAGNOSTIC,
      ),
    status: (changeId, schemaName) =>
      executor.json(
        'status',
        ['status', '--change', changeId, '--schema', schemaName, '--json'],
        '',
      ),
    instructions: (changeId, schemaName, artifactId) =>
      executor.json(
        'instructions',
        [
          'instructions',
          artifactId,
          '--change',
          changeId,
          '--schema',
          schemaName,
          '--json',
        ],
        '',
      ),
    validateChange: (changeId) =>
      executor.json(
        'validate-change',
        [
          'validate',
          changeId,
          '--type',
          'change',
          '--strict',
          '--json',
          '--no-interactive',
        ],
        '',
        [0, 1],
      ),
    validateAllSpecs: () =>
      executor.json(
        'validate-specs',
        [
          'validate',
          '--specs',
          '--strict',
          '--json',
          '--no-interactive',
          '--concurrency',
          '1',
        ],
        '',
        [0, 1],
      ),
    archive: (changeId) =>
      executor.json('archive', ['archive', changeId, '--yes', '--json'], ''),
  };
}

class OpenSpecExecutor {
  private readonly installation: OpenSpecInstallation;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly executionRoot: string;

  constructor(
    installation: OpenSpecInstallation,
    options: OpenSpecProcessOptions = {},
  ) {
    this.installation = installation;
    this.timeoutMs = positiveLimit(options.timeoutMs ?? 15_000);
    this.maxOutputBytes = positiveLimit(
      options.maxOutputBytes ?? 8 * 1024 * 1024,
    );
    this.executionRoot = canonicalExecutionRoot(
      options.executionRoot ?? installation.repositoryRoot,
    );
  }

  version(): '1.6.0' {
    const result = this.execute('version', ['--version'], '', [0]);
    const match = /^(\d+\.\d+\.\d+)(?:\r?\n)?$/.exec(result.stdout);
    if (!match) {
      throw outputInvalid('version');
    }
    if (match[1] !== PINNED_OPENSPEC_VERSION) {
      throw workflowError(
        'OPENSPEC_VERSION_MISMATCH',
        'The project-local OpenSpec runtime version differs from the exact repository pin.',
        ExitCode.unsafeEnvironment,
        {
          details: {
            expectedVersion: PINNED_OPENSPEC_VERSION,
            observedVersion: match[1],
          },
        },
      );
    }
    return PINNED_OPENSPEC_VERSION;
  }

  json(
    operation: OpenSpecOperation,
    args: string[],
    expectedStderr: string,
    allowedStatuses: number[] = [0],
  ): { value: unknown; status: number } {
    const result = this.execute(
      operation,
      args,
      expectedStderr,
      allowedStatuses,
    );
    if (!result.stdout || result.stdout.charCodeAt(0) === 0xfeff) {
      throw outputInvalid(operation);
    }
    let value: unknown;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      throw outputInvalid(operation);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw outputInvalid(operation);
    }
    return { value, status: result.status };
  }

  private execute(
    operation: OpenSpecOperation,
    args: string[],
    expectedStderr: string,
    allowedStatuses: number[],
  ): { stdout: string; status: number } {
    const trustedEnvironment = createTrustedExecutionEnvironment();
    const trustedTemporaryDirectory = trustedEnvironment.TMPDIR;
    if (!trustedTemporaryDirectory) {
      throw workflowError(
        'OPENSPEC_ENVIRONMENT_INVALID',
        'The trusted OpenSpec temporary directory is unavailable.',
        ExitCode.unsafeEnvironment,
      );
    }
    const temporaryRoot = fs.mkdtempSync(
      path.join(
        fs.realpathSync(trustedTemporaryDirectory),
        'workflow-openspec-',
      ),
    );
    const home = path.join(temporaryRoot, 'home');
    const config = path.join(temporaryRoot, 'config');
    const data = path.join(temporaryRoot, 'data');
    const codex = path.join(temporaryRoot, 'codex');
    const temporary = path.join(temporaryRoot, 'temp');
    for (const directory of [home, config, data, codex, temporary]) {
      fs.mkdirSync(directory);
    }
    try {
      const result = spawnSync(
        fs.realpathSync(process.execPath),
        [this.installation.binPath, ...args],
        {
          cwd: this.executionRoot,
          shell: false,
          env: {
            ...trustedEnvironment,
            HOME: home,
            XDG_CONFIG_HOME: config,
            XDG_DATA_HOME: data,
            CODEX_HOME: codex,
            TMPDIR: temporary,
            TMP: temporary,
            TEMP: temporary,
            CI: 'true',
            OPENSPEC_TELEMETRY: '0',
            DO_NOT_TRACK: '1',
            OPENSPEC_NO_COMPLETIONS: '1',
            OPENSPEC_CONCURRENCY: '1',
            NO_COLOR: '1',
          },
          encoding: 'buffer',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: this.timeoutMs,
          maxBuffer: this.maxOutputBytes,
          killSignal: 'SIGKILL',
        },
      );
      if (result.error) {
        if (isNodeError(result.error) && result.error.code === 'ETIMEDOUT') {
          throw workflowError(
            'OPENSPEC_TIMEOUT',
            `OpenSpec ${operation} exceeded its execution deadline.`,
            ExitCode.unsafeEnvironment,
          );
        }
        if (isNodeError(result.error) && result.error.code === 'ENOBUFS') {
          throw workflowError(
            'OPENSPEC_OUTPUT_LIMIT',
            `OpenSpec ${operation} exceeded its output limit.`,
            ExitCode.unsafeEnvironment,
          );
        }
        throw processFailure(operation);
      }
      const stdout = decode(result.stdout, operation);
      const stderr = decode(result.stderr, operation);
      if (Buffer.byteLength(stdout) > this.maxOutputBytes) {
        throw workflowError(
          'OPENSPEC_OUTPUT_LIMIT',
          `OpenSpec ${operation} exceeded its output limit.`,
          ExitCode.unsafeEnvironment,
        );
      }
      if (stderr !== expectedStderr) {
        throw workflowError(
          'OPENSPEC_STDERR_REJECTED',
          `OpenSpec ${operation} emitted an unexpected diagnostic.`,
          ExitCode.unsafeEnvironment,
        );
      }
      if (
        result.signal ||
        result.status === null ||
        !allowedStatuses.includes(result.status)
      ) {
        throw processFailure(operation);
      }
      return { stdout, status: result.status };
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

function canonicalExecutionRoot(directory: string): string {
  try {
    const absolute = path.resolve(directory);
    const stats = fs.lstatSync(absolute);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(absolute) !== absolute
    ) {
      throw new Error('unsafe execution root');
    }
    return absolute;
  } catch {
    throw workflowError(
      'OPENSPEC_EXECUTION_ROOT_UNSAFE',
      'The OpenSpec execution root must be a canonical plain directory.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function readBin(value: unknown): string {
  const candidate =
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).openspec === 'string'
      ? (value as Record<string, string>).openspec
      : undefined;
  if (
    candidate !== './bin/openspec.js' ||
    candidate.includes('\\') ||
    path.isAbsolute(candidate) ||
    candidate.split('/').some((segment) => !segment || segment === '..')
  ) {
    throw new Error('OpenSpec bin declaration is unsafe');
  }
  return candidate;
}

function readRecord(filePath: string): Record<string, unknown> {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('manifest is not an object');
  }
  return value as Record<string, unknown>;
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw workflowError(
      'OPENSPEC_LIMIT_INVALID',
      'OpenSpec adapter limits must be positive safe integers.',
      ExitCode.usage,
    );
  }
  return value;
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('OpenSpec installation escapes the repository');
  }
}

function decode(
  value: Buffer | string | null,
  operation: OpenSpecOperation,
): string {
  try {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw outputInvalid(operation);
  }
}

function outputInvalid(operation: OpenSpecOperation) {
  return workflowError(
    'OPENSPEC_OUTPUT_INVALID',
    `OpenSpec ${operation} did not return one valid machine document.`,
    ExitCode.unsafeEnvironment,
  );
}

function processFailure(operation: OpenSpecOperation) {
  return workflowError(
    'OPENSPEC_PROCESS_FAILED',
    `OpenSpec ${operation} did not complete with an allowed process status.`,
    ExitCode.unsafeEnvironment,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
