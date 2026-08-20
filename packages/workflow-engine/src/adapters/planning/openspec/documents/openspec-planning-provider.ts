import {
  planningProviderResultDigest,
  type PlanningProviderChangeResult,
  type PlanningProviderDiagnostic,
  type PlanningProviderExecutionContext,
  type PlanningProviderInstallationEvidence,
  type PlanningProviderPort,
  type PlanningProviderReadinessBlocker,
} from '../../../../modules/planning-provider/planning-provider-port.ts';
import {
  ExitCode,
  workflowError,
} from '../../../../foundation/errors/errors.ts';
import {
  createOpenSpecAdapter,
  resolveOpenSpecInstallation,
} from './openspec-adapter.ts';
import {
  OPENSPEC_PACKAGE_NAME,
  OPENSPEC_PACKAGE_VERSION,
} from './openspec-provenance.ts';

const PROVIDER_ID = 'openspec';
const CONTRACT_VERSION = 1;

export function createOpenSpecPlanningProviderPort(
  repositoryRoot: string,
): PlanningProviderPort {
  const installation = resolveOpenSpecInstallation(repositoryRoot);
  const adapter = createOpenSpecAdapter(installation.repositoryRoot);
  const installationEvidence: PlanningProviderInstallationEvidence =
    Object.freeze({
      providerId: PROVIDER_ID,
      adapterContractVersion: CONTRACT_VERSION,
      providerVersion: installation.version,
      installationDigest: planningProviderResultDigest('installation', {
        providerId: PROVIDER_ID,
        adapterContractVersion: CONTRACT_VERSION,
        package: OPENSPEC_PACKAGE_NAME,
        version: OPENSPEC_PACKAGE_VERSION,
        lockfileVersion: installation.lockfileVersion,
        lockedVersion: installation.lockedVersion,
        integrity: installation.integrity,
        buildScriptsAllowed: installation.buildScriptsAllowed,
      }),
    });

  const validateSchemas = (context: PlanningProviderExecutionContext): void => {
    assertContext(installation.repositoryRoot, context);
    for (const schemaName of ['spec-driven', 'expense-app']) {
      adapter.whichSchema(schemaName);
      adapter.validateSchema(schemaName);
    }
  };
  const validateNativeChange = (
    context: PlanningProviderExecutionContext,
    readiness: PlanningProviderChangeResult['readiness'],
    blockers: readonly PlanningProviderReadinessBlocker[],
  ): PlanningProviderChangeResult => {
    const validation = adapter.validateChange(context.changeId);
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
      assertContext(installation.repositoryRoot, context);
      return installationEvidence;
    },
    validateChange(context: PlanningProviderExecutionContext) {
      validateSchemas(context);
      return validateNativeChange(context, 'ready', []);
    },
    inspectChange(context: PlanningProviderExecutionContext) {
      validateSchemas(context);
      const status = adapter.status(context.changeId, context.contractName);
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
  repositoryRoot: string,
  context: PlanningProviderExecutionContext,
): void {
  if (
    context.repositoryRoot !== repositoryRoot ||
    context.readOnly !== true ||
    context.planningRoot !== `openspec/changes/${context.changeId}` ||
    !['spec-driven', 'expense-app', 'expense-app-v2'].includes(
      context.contractName,
    )
  ) {
    throw workflowError(
      'PLANNING_PROVIDER_CONTEXT_INVALID',
      'OpenSpec planning-provider context is not exact.',
      ExitCode.verification,
    );
  }
}

function stableDiagnostics(
  issues: Array<Record<string, unknown>>,
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
