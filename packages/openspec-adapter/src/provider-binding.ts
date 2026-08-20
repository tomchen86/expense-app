import {
  assertPlanningProviderV1Migration,
  PlanningProviderBindingError,
  planningProviderBindingDigest,
  type PlanningProviderBindingReaderPort,
  type PlanningProviderBindingV1,
  type ResolvedPlanningProviderBinding,
} from '@jigwright/core/planning-provider-binding';

import { OpenSpecAdapterError } from './planning-provider.ts';

export { OpenSpecAdapterError } from './planning-provider.ts';

const OPENSPEC_PROVIDER_ID = 'openspec';
const OPENSPEC_ADAPTER_CONTRACT_VERSION = 1;
const SCHEMA_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type OpenSpecProviderBindingPolicyV1 = Readonly<{
  providerRequirement: Readonly<{ package: string; version: string }>;
  bindingSchemaPath: string;
  bindingArtifactPath(changeId: string): string;
  legacySchemaNames: readonly string[];
}>;

export type OpenSpecProviderBindingResolverV1 = Readonly<{
  resolveCurrent(
    reader: PlanningProviderBindingReaderPort,
    repositoryRoot: string,
    changeRoot: string,
    changeId: string,
  ): ResolvedPlanningProviderBinding;
  resolveCurrentTransition(
    reader: PlanningProviderBindingReaderPort,
    repositoryRoot: string,
    baselineCommit: string,
    changeRoot: string,
    changeId: string,
    transitionKind: 'introduction' | 'revision',
  ): ResolvedPlanningProviderBinding;
  resolveHistorical(
    reader: PlanningProviderBindingReaderPort,
    repositoryRoot: string,
    commit: string,
    changeRoot: string,
    changeId: string,
  ): ResolvedPlanningProviderBinding;
  resolveHistoricalTransition(
    reader: PlanningProviderBindingReaderPort,
    repositoryRoot: string,
    parentCommit: string,
    candidateCommit: string,
    changeRoot: string,
    changeId: string,
    transitionKind: 'introduction' | 'revision',
  ): ResolvedPlanningProviderBinding;
}>;

export function createOpenSpecProviderBindingResolverV1(
  policy: OpenSpecProviderBindingPolicyV1,
): OpenSpecProviderBindingResolverV1 {
  const legacyMetadata = legacyMetadataPattern(policy.legacySchemaNames);

  const resolveCurrent = (
    reader: PlanningProviderBindingReaderPort,
    repositoryRoot: string,
    changeRoot: string,
    changeId: string,
  ): ResolvedPlanningProviderBinding => {
    const binding = reader.readCurrent(repositoryRoot, changeId);
    if (binding === null) {
      throw providerBindingMissing(policy, changeId);
    }
    assertOpenSpecBinding(policy, binding, changeRoot, changeId);
    return Object.freeze({
      binding,
      source: 'explicit',
      artifactPath: policy.bindingArtifactPath(changeId),
      bindingDigest: planningProviderBindingDigest(binding),
    });
  };

  const resolveHistorical = (
    reader: PlanningProviderBindingReaderPort,
    repositoryRoot: string,
    commit: string,
    changeRoot: string,
    changeId: string,
  ): ResolvedPlanningProviderBinding => {
    const explicit = reader.readPinnedBinding(repositoryRoot, commit, changeId);
    if (explicit !== null) {
      assertOpenSpecBinding(policy, explicit, changeRoot, changeId);
      return Object.freeze({
        binding: explicit,
        source: 'explicit',
        artifactPath: policy.bindingArtifactPath(changeId),
        bindingDigest: planningProviderBindingDigest(explicit),
      });
    }
    if (
      reader.pinnedHistoryContainsPath(
        repositoryRoot,
        commit,
        policy.bindingSchemaPath,
      )
    ) {
      throw providerBindingMissing(policy, changeId);
    }

    const metadata = reader.readPinnedEvidenceFile(
      repositoryRoot,
      commit,
      `${changeRoot}/${changeId}/.openspec.yaml`,
    );
    if (
      metadata === null ||
      !isLegacyOpenSpecMetadata(metadata, legacyMetadata)
    ) {
      throw new OpenSpecAdapterError(
        'PROVIDER_BINDING_LEGACY_UNPROVEN',
        'Historical planning-provider identity is not proven by pre-cutover OpenSpec metadata.',
        { changeId, commit },
      );
    }
    const binding = Object.freeze({
      schemaVersion: 1 as const,
      changeId,
      providerId: OPENSPEC_PROVIDER_ID,
      adapterContractVersion: OPENSPEC_ADAPTER_CONTRACT_VERSION,
      providerRequirement: Object.freeze({ ...policy.providerRequirement }),
      planningRoot: `${changeRoot}/${changeId}`,
    });
    assertOpenSpecBinding(policy, binding, changeRoot, changeId);
    return Object.freeze({
      binding,
      source: 'legacy-inferred',
      artifactPath: null,
      bindingDigest: planningProviderBindingDigest(binding),
    });
  };

  const resolveCurrentTransition = (
    reader: PlanningProviderBindingReaderPort,
    repositoryRoot: string,
    baselineCommit: string,
    changeRoot: string,
    changeId: string,
    transitionKind: 'introduction' | 'revision',
  ): ResolvedPlanningProviderBinding => {
    const candidate = reader.readCurrent(repositoryRoot, changeId);
    if (candidate === null) throw providerBindingMissing(policy, changeId);

    if (transitionKind === 'revision') {
      const previous = resolveHistorical(
        reader,
        repositoryRoot,
        baselineCommit,
        changeRoot,
        changeId,
      );
      assertPlanningProviderV1Migration(previous.binding, candidate);
    } else if (
      reader.readPinnedBinding(repositoryRoot, baselineCommit, changeId) !==
      null
    ) {
      throw new OpenSpecAdapterError(
        'PROVIDER_BINDING_INTRODUCTION_INVALID',
        'A planning introduction cannot reuse a provider binding from its parent.',
        { changeId, baselineCommit },
      );
    }

    return resolveCurrent(reader, repositoryRoot, changeRoot, changeId);
  };

  const resolveHistoricalTransition = (
    reader: PlanningProviderBindingReaderPort,
    repositoryRoot: string,
    parentCommit: string,
    candidateCommit: string,
    changeRoot: string,
    changeId: string,
    transitionKind: 'introduction' | 'revision',
  ): ResolvedPlanningProviderBinding => {
    const candidateRaw = reader.readPinnedBinding(
      repositoryRoot,
      candidateCommit,
      changeId,
    );
    if (transitionKind === 'introduction') {
      if (
        reader.readPinnedBinding(repositoryRoot, parentCommit, changeId) !==
        null
      ) {
        throw new OpenSpecAdapterError(
          'PROVIDER_BINDING_INTRODUCTION_INVALID',
          'A planning introduction cannot reuse a provider binding from its parent.',
          { changeId, parentCommit },
        );
      }
      return resolveHistorical(
        reader,
        repositoryRoot,
        candidateCommit,
        changeRoot,
        changeId,
      );
    }

    let candidate: ResolvedPlanningProviderBinding | undefined;
    let previous: ResolvedPlanningProviderBinding;
    try {
      previous = resolveHistorical(
        reader,
        repositoryRoot,
        parentCommit,
        changeRoot,
        changeId,
      );
    } catch (error) {
      if (
        !(error instanceof OpenSpecAdapterError) ||
        error.code !== 'PROVIDER_BINDING_LEGACY_UNPROVEN'
      ) {
        throw error;
      }
      candidate = resolveHistorical(
        reader,
        repositoryRoot,
        candidateCommit,
        changeRoot,
        changeId,
      );
      if (
        candidate.source !== 'legacy-inferred' ||
        reader.readPinnedEvidenceFile(
          repositoryRoot,
          parentCommit,
          `${changeRoot}/${changeId}/.openspec.yaml`,
        ) !== null
      ) {
        throw error;
      }

      // Preserve the one bootstrap-era repair accepted by the landed reader:
      // an otherwise-existing planning tree may add only its missing canonical
      // OpenSpec metadata before explicit provider bindings existed.
      previous = Object.freeze({
        binding: candidate.binding,
        source: 'legacy-inferred',
        artifactPath: null,
        bindingDigest: candidate.bindingDigest,
      });
    }
    if (candidateRaw === null && previous.source === 'explicit') {
      throw new PlanningProviderBindingError(
        'PROVIDER_MIGRATION_UNSUPPORTED',
        'Planning-provider migration is not supported by binding contract v1.',
      );
    }
    if (candidateRaw !== null) {
      assertPlanningProviderV1Migration(previous.binding, candidateRaw);
    }
    candidate ??= resolveHistorical(
      reader,
      repositoryRoot,
      candidateCommit,
      changeRoot,
      changeId,
    );
    assertPlanningProviderV1Migration(previous.binding, candidate.binding);
    return candidate;
  };

  return Object.freeze({
    resolveCurrent,
    resolveCurrentTransition,
    resolveHistorical,
    resolveHistoricalTransition,
  });
}

function legacyMetadataPattern(schemaNames: readonly string[]): RegExp {
  const names = [...new Set(['spec-driven', ...schemaNames])];
  if (names.some((name) => !SCHEMA_NAME.test(name))) {
    throw new TypeError('Legacy OpenSpec schema name is invalid.');
  }
  const alternatives = names
    .sort(compareText)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('|');
  return new RegExp(
    `^schema: (${alternatives})\\ncreated: (\\d{4}-\\d{2}-\\d{2})\\n$`,
    'u',
  );
}

function isLegacyOpenSpecMetadata(
  bytes: Uint8Array,
  legacyMetadata: RegExp,
): boolean {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  if (source === 'schema: spec-driven\n') return true;
  const match = legacyMetadata.exec(source);
  return match !== null && isCanonicalDate(match[2]!);
}

function isCanonicalDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  const timestamp = Date.UTC(year!, month! - 1, day!);
  return new Date(timestamp).toISOString().slice(0, 10) === value;
}

function assertOpenSpecBinding(
  policy: OpenSpecProviderBindingPolicyV1,
  binding: PlanningProviderBindingV1,
  changeRoot: string,
  changeId: string,
): void {
  if (
    binding.changeId !== changeId ||
    binding.providerId !== OPENSPEC_PROVIDER_ID ||
    binding.adapterContractVersion !== OPENSPEC_ADAPTER_CONTRACT_VERSION ||
    binding.providerRequirement.package !==
      policy.providerRequirement.package ||
    binding.providerRequirement.version !==
      policy.providerRequirement.version ||
    binding.planningRoot !== `${changeRoot}/${changeId}`
  ) {
    throw new OpenSpecAdapterError(
      'PROVIDER_BINDING_MISMATCH',
      'Planning-provider binding does not select the reviewed OpenSpec adapter contract.',
      { changeId, providerId: binding.providerId },
    );
  }
}

function providerBindingMissing(
  policy: OpenSpecProviderBindingPolicyV1,
  changeId: string,
): OpenSpecAdapterError {
  return new OpenSpecAdapterError(
    'PROVIDER_BINDING_MISSING',
    'A managed change after the planning-provider cutover requires an explicit binding.',
    { changeId, path: policy.bindingArtifactPath(changeId) },
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
