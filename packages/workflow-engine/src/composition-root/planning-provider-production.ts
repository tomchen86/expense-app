import {
  inspectPlanningTransition as inspectPlanningTransitionWithReader,
  resolveHistoricalOpenSpecPlanningTransitionBinding as resolveHistoricalOpenSpecPlanningTransitionBindingWithReader,
  resolveHistoricalOpenSpecProviderBinding as resolveHistoricalOpenSpecProviderBindingWithReader,
} from '../adapters/planning/openspec/documents/planning-contract.ts';
import { planningProviderBindingReader } from '../runtime/repository-transaction/planning-provider-binding-store.ts';

export function inspectPlanningTransition(
  repositoryRoot: string,
  baselineHead: string,
  changeRoot: string,
  changeId: string,
  changedPaths: string[],
  deletedPaths: readonly string[] = [],
  reopenAuthorized = false,
) {
  return inspectPlanningTransitionWithReader(
    planningProviderBindingReader,
    repositoryRoot,
    baselineHead,
    changeRoot,
    changeId,
    changedPaths,
    deletedPaths,
    reopenAuthorized,
  );
}

export function resolveHistoricalOpenSpecPlanningTransitionBinding(
  repositoryRoot: string,
  parentCommit: string,
  candidateCommit: string,
  changeRoot: string,
  changeId: string,
  transitionKind: 'introduction' | 'revision',
) {
  return resolveHistoricalOpenSpecPlanningTransitionBindingWithReader(
    planningProviderBindingReader,
    repositoryRoot,
    parentCommit,
    candidateCommit,
    changeRoot,
    changeId,
    transitionKind,
  );
}

export function resolveHistoricalOpenSpecProviderBinding(
  repositoryRoot: string,
  commit: string,
  changeRoot: string,
  changeId: string,
) {
  return resolveHistoricalOpenSpecProviderBindingWithReader(
    planningProviderBindingReader,
    repositoryRoot,
    commit,
    changeRoot,
    changeId,
  );
}
