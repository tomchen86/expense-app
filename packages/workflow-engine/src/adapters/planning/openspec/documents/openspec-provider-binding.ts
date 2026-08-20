import {
  createOpenSpecProviderBindingResolverV1,
  OpenSpecAdapterError,
} from '@jigwright/openspec-adapter/provider-binding';
import { PlanningProviderBindingError } from '@jigwright/core/planning-provider-binding';

import {
  ExitCode,
  workflowError,
} from '../../../../foundation/errors/errors.ts';
import type {
  PlanningProviderBindingReaderPort,
  ResolvedPlanningProviderBinding,
} from '../../../../modules/planning-provider/planning-provider-binding.ts';
import { planningProviderBindingPath } from '../../../../modules/source/planning-paths.ts';
import {
  OPENSPEC_PACKAGE_NAME,
  OPENSPEC_PACKAGE_VERSION,
} from './openspec-provenance.ts';

const RESOLVER = createOpenSpecProviderBindingResolverV1({
  providerRequirement: Object.freeze({
    package: OPENSPEC_PACKAGE_NAME,
    version: OPENSPEC_PACKAGE_VERSION,
  }),
  bindingSchemaPath: 'workflow/schemas/planning-provider-binding.schema.json',
  bindingArtifactPath: planningProviderBindingPath,
  legacySchemaNames: Object.freeze(['expense-app', 'expense-app-v2']),
});

export function resolveCurrentOpenSpecProviderBinding(
  reader: PlanningProviderBindingReaderPort,
  repositoryRoot: string,
  changeRoot: string,
  changeId: string,
): ResolvedPlanningProviderBinding {
  return mapProviderBindingError(() =>
    RESOLVER.resolveCurrent(reader, repositoryRoot, changeRoot, changeId),
  );
}

export function resolveCurrentOpenSpecPlanningTransitionBinding(
  reader: PlanningProviderBindingReaderPort,
  repositoryRoot: string,
  baselineCommit: string,
  changeRoot: string,
  changeId: string,
  transitionKind: 'introduction' | 'revision',
): ResolvedPlanningProviderBinding {
  return mapProviderBindingError(() =>
    RESOLVER.resolveCurrentTransition(
      reader,
      repositoryRoot,
      baselineCommit,
      changeRoot,
      changeId,
      transitionKind,
    ),
  );
}

export function resolveHistoricalOpenSpecProviderBinding(
  reader: PlanningProviderBindingReaderPort,
  repositoryRoot: string,
  commit: string,
  changeRoot: string,
  changeId: string,
): ResolvedPlanningProviderBinding {
  return mapProviderBindingError(() =>
    RESOLVER.resolveHistorical(
      reader,
      repositoryRoot,
      commit,
      changeRoot,
      changeId,
    ),
  );
}

export function resolveHistoricalOpenSpecPlanningTransitionBinding(
  reader: PlanningProviderBindingReaderPort,
  repositoryRoot: string,
  parentCommit: string,
  candidateCommit: string,
  changeRoot: string,
  changeId: string,
  transitionKind: 'introduction' | 'revision',
): ResolvedPlanningProviderBinding {
  return mapProviderBindingError(() =>
    RESOLVER.resolveHistoricalTransition(
      reader,
      repositoryRoot,
      parentCommit,
      candidateCommit,
      changeRoot,
      changeId,
      transitionKind,
    ),
  );
}

function mapProviderBindingError<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof OpenSpecAdapterError) {
      throw workflowError(error.code, error.message, ExitCode.verification, {
        ...(error.details === undefined
          ? {}
          : { details: { ...error.details } }),
      });
    }
    if (error instanceof PlanningProviderBindingError) {
      throw workflowError(
        error.code,
        error.message,
        error.code === 'PROVIDER_MIGRATION_UNSUPPORTED'
          ? ExitCode.guard
          : ExitCode.verification,
      );
    }
    throw error;
  }
}
