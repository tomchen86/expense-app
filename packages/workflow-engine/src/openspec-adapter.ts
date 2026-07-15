import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';
import {
  createOpenSpecProcess,
  resolveOpenSpecInstallation,
  type OpenSpecInstallation,
} from './openspec-executor.ts';
import { assertChangeId } from './paths.ts';
import { parseDoctor, type OpenSpecDoctor } from './openspec-doctor-payload.ts';
import {
  parseChangeList,
  parseInstructions,
  parseSchemaResolution,
  parseSchemaValidation,
  parseStatus,
  parseValidation,
  type OpenSpecChangeList,
  type OpenSpecInstructions,
  type OpenSpecSchemaResolution,
  type OpenSpecSchemaValidation,
  type OpenSpecStatus,
  type OpenSpecValidation,
} from './openspec-payloads.ts';

export { resolveOpenSpecInstallation };
export type { OpenSpecInstallation };

export type OpenSpecAdapterOptions = {
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export type OpenSpecAdapter = {
  version(): '1.6.0';
  doctor(): OpenSpecDoctor;
  listChanges(): OpenSpecChangeList;
  whichSchema(name: string): OpenSpecSchemaResolution;
  validateSchema(name: string): OpenSpecSchemaValidation;
  status(changeId: string, schemaName: string): OpenSpecStatus;
  instructions(
    changeId: string,
    schemaName: string,
    artifactId: string,
  ): OpenSpecInstructions;
  validateChange(changeId: string): OpenSpecValidation;
  validateAllSpecs(): OpenSpecValidation;
};

export function createOpenSpecAdapter(
  repositoryRoot: string,
  options: OpenSpecAdapterOptions = {},
): OpenSpecAdapter {
  const installation = resolveOpenSpecInstallation(repositoryRoot);
  const openspec = createOpenSpecProcess(installation, options);
  openspec.version();

  return {
    version: () => openspec.version(),
    doctor: () => {
      const executed = openspec.doctor();
      return parseDoctor(
        executed.value,
        installation.repositoryRoot,
        executed.status,
      );
    },
    listChanges: () => {
      const changesDirectory = path.join(
        installation.repositoryRoot,
        'openspec/changes',
      );
      return withCanonicalDirectory(
        installation.repositoryRoot,
        changesDirectory,
        () =>
          parseChangeList(
            openspec.listChanges().value,
            installation.repositoryRoot,
          ),
      );
    },
    whichSchema: (name) => {
      const schema = schemaExpectation(installation, name);
      const resolution = parseSchemaResolution(
        openspec.whichSchema(schema.name).value,
        schema,
      );
      assertOpenSpecSchemaDirectory(installation, schema);
      return resolution;
    },
    validateSchema: (name) => {
      const schema = schemaExpectation(installation, name);
      const validation = parseSchemaValidation(
        openspec.validateSchema(schema.name).value,
        schema,
      );
      assertOpenSpecSchemaDirectory(installation, schema);
      return validation;
    },
    status: (changeId, schemaName) => {
      const change = assertChangeId(changeId);
      const schema = safeName(schemaName);
      return withChangeDirectory(installation.repositoryRoot, change, () =>
        parseStatus(openspec.status(change, schema).value, {
          repositoryRoot: installation.repositoryRoot,
          changeId: change,
          schemaName: schema,
        }),
      );
    },
    instructions: (changeId, schemaName, artifactId) => {
      const change = assertChangeId(changeId);
      const schema = safeName(schemaName);
      const artifact = safeName(artifactId);
      return withChangeDirectory(installation.repositoryRoot, change, () =>
        parseInstructions(
          openspec.instructions(change, schema, artifact).value,
          {
            repositoryRoot: installation.repositoryRoot,
            changeId: change,
            schemaName: schema,
            artifactId: artifact,
          },
        ),
      );
    },
    validateChange: (changeId) => {
      const change = assertChangeId(changeId);
      return withChangeDirectory(installation.repositoryRoot, change, () => {
        const executed = openspec.validateChange(change);
        const validation = parseValidation(executed.value, {
          repositoryRoot: installation.repositoryRoot,
          expectedType: 'change',
          expectedId: change,
        });
        assertValidationExit(executed.status, validation.valid);
        return validation;
      });
    },
    validateAllSpecs: () => {
      const specsDirectory = path.join(
        installation.repositoryRoot,
        'openspec/specs',
      );
      return withCanonicalDirectory(
        installation.repositoryRoot,
        specsDirectory,
        () => {
          const executed = openspec.validateAllSpecs();
          const validation = parseValidation(executed.value, {
            repositoryRoot: installation.repositoryRoot,
            expectedType: 'spec',
          });
          assertValidationExit(executed.status, validation.valid);
          return validation;
        },
      );
    },
  };
}

function schemaExpectation(
  installation: OpenSpecInstallation,
  requestedName: string,
): { name: string; source: 'package' | 'project'; path: string } {
  const name = safeName(requestedName);
  const expected =
    name === 'spec-driven'
      ? {
          name,
          source: 'package' as const,
          path: path.join(installation.packageDirectory, 'schemas', name),
        }
      : {
          name,
          source: 'project' as const,
          path: path.join(
            installation.repositoryRoot,
            'openspec/schemas',
            name,
          ),
        };
  assertOpenSpecSchemaDirectory(installation, expected);
  return expected;
}

export function assertOpenSpecSchemaDirectory(
  installation: OpenSpecInstallation,
  expected: { source: 'package' | 'project'; path: string },
): void {
  assertCanonicalDirectory(
    expected.source === 'package'
      ? installation.packageDirectory
      : installation.repositoryRoot,
    expected.path,
  );
}

function withChangeDirectory<T>(
  repositoryRoot: string,
  changeId: string,
  operation: () => T,
): T {
  return withCanonicalDirectory(
    repositoryRoot,
    path.join(repositoryRoot, 'openspec/changes', changeId),
    operation,
  );
}

function withCanonicalDirectory<T>(
  root: string,
  directory: string,
  operation: () => T,
): T {
  assertCanonicalDirectory(root, directory);
  const result = operation();
  assertCanonicalDirectory(root, directory);
  return result;
}

function assertCanonicalDirectory(root: string, directory: string): void {
  try {
    const canonicalRoot = fs.realpathSync(root);
    const absoluteDirectory = path.resolve(directory);
    const stats = fs.lstatSync(absoluteDirectory);
    const canonicalDirectory = fs.realpathSync(absoluteDirectory);
    const relative = path.relative(canonicalRoot, canonicalDirectory);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      canonicalDirectory !== absoluteDirectory ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error('unsafe OpenSpec directory');
    }
  } catch {
    throw workflowError(
      'OPENSPEC_PATH_UNSAFE',
      'An OpenSpec operation target is not a canonical repository directory.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function safeName(value: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw workflowError(
      'OPENSPEC_IDENTIFIER_INVALID',
      'OpenSpec operation contains an invalid identifier.',
      ExitCode.usage,
    );
  }
  return value;
}

function assertValidationExit(status: number, valid: boolean): void {
  if ((valid && status !== 0) || (!valid && status !== 1)) {
    throw workflowError(
      'OPENSPEC_PAYLOAD_INVALID',
      'OpenSpec validation exit status contradicts its result payload.',
      ExitCode.unsafeEnvironment,
    );
  }
}
