import {
  createOpenSpecPlanningProviderPortV1,
  OpenSpecAdapterError,
} from '@jigwright/openspec-adapter/planning-provider';

import type {
  PlanningProviderExecutionContext,
  PlanningProviderPort,
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

const REQUIRED_SCHEMA_NAMES = Object.freeze(['spec-driven', 'expense-app']);
const SUPPORTED_CONTRACT_NAMES = Object.freeze([
  'spec-driven',
  'expense-app',
  'expense-app-v2',
]);

/**
 * Thin production composition facade. The native OpenSpec process/parser
 * remains injected here while provider evidence mapping is package-owned.
 */
export function createOpenSpecPlanningProviderPort(
  repositoryRoot: string,
): PlanningProviderPort {
  const installation = resolveOpenSpecInstallation(repositoryRoot);
  const extracted = createOpenSpecPlanningProviderPortV1({
    repositoryRoot: installation.repositoryRoot,
    providerRequirement: Object.freeze({
      package: OPENSPEC_PACKAGE_NAME,
      version: OPENSPEC_PACKAGE_VERSION,
    }),
    installation: Object.freeze({
      providerVersion: installation.version,
      lockfileVersion: installation.lockfileVersion,
      lockedVersion: installation.lockedVersion,
      integrity: installation.integrity,
      buildScriptsAllowed: installation.buildScriptsAllowed,
    }),
    requiredSchemaNames: REQUIRED_SCHEMA_NAMES,
    supportedContractNames: SUPPORTED_CONTRACT_NAMES,
    native: createOpenSpecAdapter(installation.repositoryRoot),
  });

  return Object.freeze({
    id: extracted.id,
    contractVersion: extracted.contractVersion,
    inspectInstallation(context: PlanningProviderExecutionContext) {
      return mapOpenSpecAdapterError(() =>
        extracted.inspectInstallation(context),
      );
    },
    validateChange(context: PlanningProviderExecutionContext) {
      return mapOpenSpecAdapterError(() => extracted.validateChange(context));
    },
    inspectChange(context: PlanningProviderExecutionContext) {
      return mapOpenSpecAdapterError(() => extracted.inspectChange(context));
    },
  });
}

function mapOpenSpecAdapterError<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof OpenSpecAdapterError)) throw error;
    throw workflowError(error.code, error.message, ExitCode.verification, {
      ...(error.details === undefined ? {} : { details: { ...error.details } }),
    });
  }
}
