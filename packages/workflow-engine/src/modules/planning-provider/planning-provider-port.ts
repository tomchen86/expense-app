import {
  evaluatePlanningProvider as evaluateCorePlanningProvider,
  PlanningProviderContractError,
  planningProviderResultDigest as corePlanningProviderResultDigest,
  type PlanningProviderChangeResult,
  type PlanningProviderDiagnostic,
  type PlanningProviderEvaluation,
  type PlanningProviderExecutionContext,
  type PlanningProviderInstallationEvidence,
  type PlanningProviderPort,
  type PlanningProviderReadinessBlocker,
} from '@jigwright/core/planning-provider-port';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export type {
  PlanningProviderChangeResult,
  PlanningProviderDiagnostic,
  PlanningProviderEvaluation,
  PlanningProviderExecutionContext,
  PlanningProviderInstallationEvidence,
  PlanningProviderPort,
  PlanningProviderReadinessBlocker,
};

/**
 * Compatibility facade for the mechanically extracted neutral provider port.
 * WorkflowError remains a workflow-engine concern; contract bytes and
 * validation now have one implementation in @jigwright/core.
 */
export function evaluatePlanningProvider(
  port: PlanningProviderPort,
  context: PlanningProviderExecutionContext,
): PlanningProviderEvaluation {
  return mapContractError(() => evaluateCorePlanningProvider(port, context));
}

export function planningProviderResultDigest(
  domain: string,
  value: unknown,
): string {
  return mapContractError(() =>
    corePlanningProviderResultDigest(domain, value),
  );
}

function mapContractError<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof PlanningProviderContractError)) throw error;
    throw workflowError(error.code, error.message, ExitCode.verification);
  }
}
