import path from 'node:path';

import { WorkflowError } from './errors.ts';
import { assertOpenSpecSchemaDirectory } from './openspec-adapter.ts';
import {
  createOpenSpecProcess,
  PINNED_OPENSPEC_VERSION,
  resolveOpenSpecInstallation,
  type OpenSpecInstallation,
} from './openspec-executor.ts';
import {
  parseDoctor,
  type OpenSpecDiagnostic,
} from './openspec-doctor-payload.ts';
import {
  parseSchemaResolution,
  parseSchemaValidation,
} from './openspec-payloads.ts';
import { OPENSPEC_PACKAGE_NAME } from './openspec-provenance.ts';

type InstallationDiagnostic = {
  ok: boolean;
  packageName: typeof OPENSPEC_PACKAGE_NAME;
  declaredVersion: '1.6.0';
  lockfileVersion: '9.0' | null;
  lockedVersion: string | null;
  integrity: string | null;
  buildScriptsAllowed: boolean | null;
  installedVersion: string | null;
  packageDirectory: string | null;
  binPath: string | null;
};

type RuntimeDiagnostic = {
  ok: boolean;
  version: string | null;
};

type RootDiagnostic = {
  ok: boolean;
  path: string | null;
  source: 'nearest' | null;
  healthy: boolean | null;
  storeActive: boolean | null;
};

type SchemaDiagnostic = {
  name: 'spec-driven';
  expectedSource: 'package';
  ok: boolean;
  resolution: { source: 'package'; path: string } | null;
  validation: { valid: boolean; issueCount: number } | null;
};

export type OpenSpecDiagnosticReport = {
  expectedVersion: '1.6.0';
  healthy: boolean;
  installation: InstallationDiagnostic;
  runtime: RuntimeDiagnostic;
  root: RootDiagnostic;
  schemas: SchemaDiagnostic[];
  diagnostics: OpenSpecDiagnostic[];
};

export function diagnoseOpenSpec(
  repositoryRoot: string,
): OpenSpecDiagnosticReport {
  const report = emptyReport();
  let installation: OpenSpecInstallation;
  try {
    installation = resolveOpenSpecInstallation(repositoryRoot);
    report.installation = {
      ok: true,
      packageName: OPENSPEC_PACKAGE_NAME,
      declaredVersion: PINNED_OPENSPEC_VERSION,
      lockfileVersion: installation.lockfileVersion,
      lockedVersion: installation.lockedVersion,
      integrity: installation.integrity,
      buildScriptsAllowed: installation.buildScriptsAllowed,
      installedVersion: installation.version,
      packageDirectory: installation.packageDirectory,
      binPath: installation.binPath,
    };
  } catch (error) {
    report.diagnostics.push(
      diagnosticFrom(
        error,
        'OPENSPEC_INSTALLATION_DIAGNOSTIC_FAILED',
        'openspec.installation',
      ),
    );
    return finalize(report);
  }

  const openspec = createOpenSpecProcess(installation);
  try {
    report.runtime = { ok: true, version: openspec.version() };
  } catch (error) {
    if (
      error instanceof WorkflowError &&
      typeof error.details?.observedVersion === 'string'
    ) {
      report.runtime.version = error.details.observedVersion;
    }
    report.diagnostics.push(
      diagnosticFrom(
        error,
        'OPENSPEC_RUNTIME_DIAGNOSTIC_FAILED',
        'openspec.runtime',
      ),
    );
    return finalize(report);
  }

  try {
    const executed = openspec.doctor();
    const doctor = parseDoctor(
      executed.value,
      installation.repositoryRoot,
      executed.status,
    );
    report.root = {
      ok: doctor.root?.healthy === true,
      path: doctor.root?.path ?? null,
      source: doctor.root?.source ?? null,
      healthy: doctor.root?.healthy ?? null,
      storeActive: doctor.resolved ? false : null,
    };
    report.diagnostics.push(...doctor.diagnostics);
  } catch (error) {
    report.diagnostics.push(
      diagnosticFrom(error, 'OPENSPEC_ROOT_DIAGNOSTIC_FAILED', 'openspec.root'),
    );
  }

  diagnosePackageSchema(report, installation, openspec);
  return finalize(report);
}

function diagnosePackageSchema(
  report: OpenSpecDiagnosticReport,
  installation: OpenSpecInstallation,
  openspec: ReturnType<typeof createOpenSpecProcess>,
): void {
  const schema = report.schemas[0]!;
  const expectation = {
    name: schema.name,
    source: schema.expectedSource,
    path: path.join(installation.packageDirectory, 'schemas', schema.name),
  } as const;
  try {
    assertOpenSpecSchemaDirectory(installation, expectation);
    const resolution = parseSchemaResolution(
      openspec.whichSchema(schema.name).value,
      expectation,
    );
    assertOpenSpecSchemaDirectory(installation, expectation);
    schema.resolution = {
      source: schema.expectedSource,
      path: resolution.path,
    };
  } catch (error) {
    report.diagnostics.push(
      diagnosticFrom(
        error,
        'OPENSPEC_SCHEMA_RESOLUTION_DIAGNOSTIC_FAILED',
        'openspec.schema.spec-driven',
      ),
    );
  }

  try {
    assertOpenSpecSchemaDirectory(installation, expectation);
    const validation = parseSchemaValidation(
      openspec.validateSchema(schema.name).value,
      expectation,
    );
    assertOpenSpecSchemaDirectory(installation, expectation);
    schema.validation = {
      valid: validation.valid,
      issueCount: validation.issues.length,
    };
    if (!validation.valid || validation.issues.length > 0) {
      report.diagnostics.push({
        severity: 'error',
        code: 'OPENSPEC_SCHEMA_INVALID',
        message: 'The pinned spec-driven schema payload is not valid.',
        target: 'openspec.schema.spec-driven',
      });
    }
  } catch (error) {
    report.diagnostics.push(
      diagnosticFrom(
        error,
        'OPENSPEC_SCHEMA_VALIDATION_DIAGNOSTIC_FAILED',
        'openspec.schema.spec-driven',
      ),
    );
  }

  schema.ok =
    schema.resolution !== null &&
    schema.validation?.valid === true &&
    schema.validation.issueCount === 0;
}

function emptyReport(): OpenSpecDiagnosticReport {
  return {
    expectedVersion: PINNED_OPENSPEC_VERSION,
    healthy: false,
    installation: {
      ok: false,
      packageName: OPENSPEC_PACKAGE_NAME,
      declaredVersion: PINNED_OPENSPEC_VERSION,
      lockfileVersion: null,
      lockedVersion: null,
      integrity: null,
      buildScriptsAllowed: null,
      installedVersion: null,
      packageDirectory: null,
      binPath: null,
    },
    runtime: { ok: false, version: null },
    root: {
      ok: false,
      path: null,
      source: null,
      healthy: null,
      storeActive: null,
    },
    schemas: [
      {
        name: 'spec-driven',
        expectedSource: 'package',
        ok: false,
        resolution: null,
        validation: null,
      },
    ],
    diagnostics: [],
  };
}

function finalize(report: OpenSpecDiagnosticReport): OpenSpecDiagnosticReport {
  report.healthy =
    report.installation.ok &&
    report.runtime.ok &&
    report.root.ok &&
    report.schemas.every(({ ok }) => ok) &&
    report.diagnostics.every(({ severity }) => severity === 'info');
  return report;
}

function diagnosticFrom(
  error: unknown,
  fallbackCode: string,
  target: string,
): OpenSpecDiagnostic {
  if (error instanceof WorkflowError) {
    return {
      severity: 'error',
      code: fallbackCode,
      message: error.message,
      target,
      causeCode: error.code,
    };
  }
  return {
    severity: 'error',
    code: fallbackCode,
    message: 'OpenSpec diagnostics could not be completed safely.',
    target,
  };
}
