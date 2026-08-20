import {
  planningProviderResultDigest,
  type PlanningProviderChangeResult,
  type PlanningProviderDiagnostic,
  type PlanningProviderExecutionContext,
  type PlanningProviderInstallationEvidence,
  type PlanningProviderPort,
  type PlanningProviderReadinessBlocker,
} from '@jigwright/core/planning-provider-port';

const PROVIDER_ID = 'openspec';
const CONTRACT_VERSION = 1;

export type OpenSpecAdapterErrorCode =
  | 'PLANNING_PROVIDER_CONTEXT_INVALID'
  | 'PROVIDER_BINDING_INTRODUCTION_INVALID'
  | 'PROVIDER_BINDING_LEGACY_UNPROVEN'
  | 'PROVIDER_BINDING_MISMATCH'
  | 'PROVIDER_BINDING_MISSING';

export class OpenSpecAdapterError extends Error {
  readonly code: OpenSpecAdapterErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: OpenSpecAdapterErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'OpenSpecAdapterError';
    this.code = code;
    this.details = details;
  }
}

export type OpenSpecPlanningInstallationV1 = Readonly<{
  providerVersion: string;
  lockfileVersion: string;
  lockedVersion: string;
  integrity: string;
  buildScriptsAllowed: false;
}>;

export type OpenSpecPlanningNativeIssueV1 = Readonly<{
  level?: unknown;
  path?: unknown;
  message?: unknown;
  line?: unknown;
  column?: unknown;
  [key: string]: unknown;
}>;

export type OpenSpecPlanningNativeV1 = Readonly<{
  whichSchema(name: string): unknown;
  validateSchema(name: string): unknown;
  status(
    changeId: string,
    schemaName: string,
  ): Readonly<{
    isComplete: boolean;
    artifacts: readonly Readonly<{
      id: string;
      status: string;
      missingDependencies: readonly string[];
    }>[];
  }>;
  validateChange(changeId: string): Readonly<{
    valid: boolean;
    items: readonly Readonly<{
      issues: readonly OpenSpecPlanningNativeIssueV1[];
    }>[];
  }>;
}>;

export type OpenSpecPlanningProviderConfigV1 = Readonly<{
  repositoryRoot: string;
  providerRequirement: Readonly<{ package: string; version: string }>;
  installation: OpenSpecPlanningInstallationV1;
  requiredSchemaNames: readonly string[];
  supportedContractNames: readonly string[];
  native: OpenSpecPlanningNativeV1;
}>;

export function createOpenSpecPlanningProviderPortV1(
  config: OpenSpecPlanningProviderConfigV1,
): PlanningProviderPort {
  const installationEvidence: PlanningProviderInstallationEvidence =
    Object.freeze({
      providerId: PROVIDER_ID,
      adapterContractVersion: CONTRACT_VERSION,
      providerVersion: config.installation.providerVersion,
      installationDigest: planningProviderResultDigest('installation', {
        providerId: PROVIDER_ID,
        adapterContractVersion: CONTRACT_VERSION,
        package: config.providerRequirement.package,
        version: config.providerRequirement.version,
        lockfileVersion: config.installation.lockfileVersion,
        lockedVersion: config.installation.lockedVersion,
        integrity: config.installation.integrity,
        buildScriptsAllowed: config.installation.buildScriptsAllowed,
      }),
    });

  const validateSchemas = (context: PlanningProviderExecutionContext): void => {
    assertContext(config, context);
    for (const schemaName of config.requiredSchemaNames) {
      config.native.whichSchema(schemaName);
      config.native.validateSchema(schemaName);
    }
  };
  const validateNativeChange = (
    context: PlanningProviderExecutionContext,
    readiness: PlanningProviderChangeResult['readiness'],
    blockers: readonly PlanningProviderReadinessBlocker[],
  ): PlanningProviderChangeResult => {
    const validation = config.native.validateChange(context.changeId);
    const diagnostics = stableDiagnostics(
      validation.items.flatMap(({ issues }) => issues),
    );
    return freezeChangeResult({
      readiness,
      blockers,
      valid: validation.valid,
      diagnostics,
      validationDigest: planningProviderResultDigest('validation', {
        changeId: context.changeId,
        valid: validation.valid,
        diagnostics,
      }),
    });
  };

  return Object.freeze({
    id: PROVIDER_ID,
    contractVersion: CONTRACT_VERSION,
    inspectInstallation(context: PlanningProviderExecutionContext) {
      assertContext(config, context);
      return installationEvidence;
    },
    validateChange(context: PlanningProviderExecutionContext) {
      validateSchemas(context);
      return validateNativeChange(context, 'ready', []);
    },
    inspectChange(context: PlanningProviderExecutionContext) {
      validateSchemas(context);
      const status = config.native.status(
        context.changeId,
        context.contractName,
      );
      const blockers = status.artifacts
        .filter(({ status: artifactStatus }) => artifactStatus !== 'done')
        .map(
          ({ id, status: artifactStatus, missingDependencies }) =>
            ({
              artifactId: id,
              status: artifactStatus,
              missingDependencies: [...missingDependencies].sort(compareText),
            }) satisfies PlanningProviderReadinessBlocker,
        )
        .sort((left, right) => compareText(left.artifactId, right.artifactId));
      return validateNativeChange(
        context,
        status.isComplete ? 'ready' : 'blocked',
        blockers,
      );
    },
  });
}

function assertContext(
  config: OpenSpecPlanningProviderConfigV1,
  context: PlanningProviderExecutionContext,
): void {
  if (
    context.repositoryRoot !== config.repositoryRoot ||
    context.readOnly !== true ||
    context.planningRoot !== `openspec/changes/${context.changeId}` ||
    !config.supportedContractNames.includes(context.contractName)
  ) {
    throw new OpenSpecAdapterError(
      'PLANNING_PROVIDER_CONTEXT_INVALID',
      'OpenSpec planning-provider context is not exact.',
    );
  }
}

function stableDiagnostics(
  issues: readonly OpenSpecPlanningNativeIssueV1[],
): PlanningProviderDiagnostic[] {
  return issues
    .map((issue) => ({
      level: issue.level as PlanningProviderDiagnostic['level'],
      path: String(issue.path),
      message: String(issue.message),
      ...(typeof issue.line === 'number' ? { line: issue.line } : {}),
      ...(typeof issue.column === 'number' ? { column: issue.column } : {}),
    }))
    .sort(compareDiagnostics);
}

function freezeChangeResult(
  result: PlanningProviderChangeResult,
): PlanningProviderChangeResult {
  return Object.freeze({
    ...result,
    blockers: Object.freeze(
      result.blockers.map((blocker) =>
        Object.freeze({
          ...blocker,
          missingDependencies: Object.freeze([...blocker.missingDependencies]),
        }),
      ),
    ),
    diagnostics: Object.freeze(
      result.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })),
    ),
  });
}

function compareDiagnostics(
  left: PlanningProviderDiagnostic,
  right: PlanningProviderDiagnostic,
): number {
  return (
    compareText(left.path, right.path) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    (left.column ?? 0) - (right.column ?? 0) ||
    compareText(left.level, right.level) ||
    compareText(left.message, right.message)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
