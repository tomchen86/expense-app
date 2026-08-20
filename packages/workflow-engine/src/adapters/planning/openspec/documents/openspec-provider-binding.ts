import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../../../foundation/errors/errors.ts';
import {
  assertPlanningProviderV1Migration,
  planningProviderBindingDigest,
  type PlanningProviderBindingReaderPort,
  type PlanningProviderBindingV1,
  type ResolvedPlanningProviderBinding,
} from '../../../../modules/planning-provider/planning-provider-binding.ts';
import { planningProviderBindingPath } from '../../../../modules/source/planning-paths.ts';
import {
  OPENSPEC_PACKAGE_NAME,
  OPENSPEC_PACKAGE_VERSION,
} from './openspec-provenance.ts';

const OPENSPEC_PROVIDER_ID = 'openspec';
const OPENSPEC_ADAPTER_CONTRACT_VERSION = 1;
const PLANNING_PROVIDER_BINDING_SCHEMA_PATH =
  'workflow/schemas/planning-provider-binding.schema.json';
const LEGACY_OPENSPEC_METADATA =
  /^schema: (expense-app|expense-app-v2|spec-driven)\ncreated: (\d{4}-\d{2}-\d{2})\n$/u;

export function resolveCurrentOpenSpecProviderBinding(
  reader: PlanningProviderBindingReaderPort,
  repositoryRoot: string,
  changeRoot: string,
  changeId: string,
): ResolvedPlanningProviderBinding {
  const binding = reader.readCurrent(repositoryRoot, changeId);
  if (binding === null) {
    throw providerBindingMissing(changeId);
  }
  assertOpenSpecBinding(binding, changeRoot, changeId);
  return Object.freeze({
    binding,
    source: 'explicit',
    artifactPath: planningProviderBindingPath(changeId),
    bindingDigest: planningProviderBindingDigest(binding),
  });
}

export function resolveCurrentOpenSpecPlanningTransitionBinding(
  reader: PlanningProviderBindingReaderPort,
  repositoryRoot: string,
  baselineCommit: string,
  changeRoot: string,
  changeId: string,
  transitionKind: 'introduction' | 'revision',
): ResolvedPlanningProviderBinding {
  const candidate = reader.readCurrent(repositoryRoot, changeId);
  if (candidate === null) throw providerBindingMissing(changeId);

  if (transitionKind === 'revision') {
    const previous = resolveHistoricalOpenSpecProviderBinding(
      reader,
      repositoryRoot,
      baselineCommit,
      changeRoot,
      changeId,
    );
    assertPlanningProviderV1Migration(previous.binding, candidate);
  } else if (
    reader.readPinnedBinding(repositoryRoot, baselineCommit, changeId) !== null
  ) {
    throw workflowError(
      'PROVIDER_BINDING_INTRODUCTION_INVALID',
      'A planning introduction cannot reuse a provider binding from its parent.',
      ExitCode.verification,
      { details: { changeId, baselineCommit } },
    );
  }

  return resolveCurrentOpenSpecProviderBinding(
    reader,
    repositoryRoot,
    changeRoot,
    changeId,
  );
}

export function resolveHistoricalOpenSpecProviderBinding(
  reader: PlanningProviderBindingReaderPort,
  repositoryRoot: string,
  commit: string,
  changeRoot: string,
  changeId: string,
): ResolvedPlanningProviderBinding {
  const explicit = reader.readPinnedBinding(repositoryRoot, commit, changeId);
  if (explicit !== null) {
    assertOpenSpecBinding(explicit, changeRoot, changeId);
    return Object.freeze({
      binding: explicit,
      source: 'explicit',
      artifactPath: planningProviderBindingPath(changeId),
      bindingDigest: planningProviderBindingDigest(explicit),
    });
  }
  if (
    reader.pinnedHistoryContainsPath(
      repositoryRoot,
      commit,
      PLANNING_PROVIDER_BINDING_SCHEMA_PATH,
    )
  ) {
    throw providerBindingMissing(changeId);
  }

  const metadata = reader.readPinnedEvidenceFile(
    repositoryRoot,
    commit,
    `${changeRoot}/${changeId}/.openspec.yaml`,
  );
  if (metadata === null || !isLegacyOpenSpecMetadata(metadata)) {
    throw workflowError(
      'PROVIDER_BINDING_LEGACY_UNPROVEN',
      'Historical planning-provider identity is not proven by pre-cutover OpenSpec metadata.',
      ExitCode.verification,
      { details: { changeId, commit } },
    );
  }
  const binding = Object.freeze({
    schemaVersion: 1 as const,
    changeId,
    providerId: OPENSPEC_PROVIDER_ID,
    adapterContractVersion: OPENSPEC_ADAPTER_CONTRACT_VERSION,
    providerRequirement: Object.freeze({
      package: OPENSPEC_PACKAGE_NAME,
      version: OPENSPEC_PACKAGE_VERSION,
    }),
    planningRoot: `${changeRoot}/${changeId}`,
  });
  assertOpenSpecBinding(binding, changeRoot, changeId);
  return Object.freeze({
    binding,
    source: 'legacy-inferred',
    artifactPath: null,
    bindingDigest: planningProviderBindingDigest(binding),
  });
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
  const candidateRaw = reader.readPinnedBinding(
    repositoryRoot,
    candidateCommit,
    changeId,
  );
  if (transitionKind === 'introduction') {
    if (
      reader.readPinnedBinding(repositoryRoot, parentCommit, changeId) !== null
    ) {
      throw workflowError(
        'PROVIDER_BINDING_INTRODUCTION_INVALID',
        'A planning introduction cannot reuse a provider binding from its parent.',
        ExitCode.verification,
        { details: { changeId, parentCommit } },
      );
    }
    return resolveHistoricalOpenSpecProviderBinding(
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
    previous = resolveHistoricalOpenSpecProviderBinding(
      reader,
      repositoryRoot,
      parentCommit,
      changeRoot,
      changeId,
    );
  } catch (error) {
    if (
      !(error instanceof WorkflowError) ||
      error.code !== 'PROVIDER_BINDING_LEGACY_UNPROVEN'
    ) {
      throw error;
    }
    candidate = resolveHistoricalOpenSpecProviderBinding(
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

    // The historical CI contract permits one bootstrap-era repair: an
    // otherwise-existing planning tree may add its missing canonical OpenSpec
    // metadata. The repaired candidate proves the only provider identity that
    // existed before provider bindings, while a corrupt parent metadata file
    // remains a hard failure rather than being silently replaced.
    previous = Object.freeze({
      binding: candidate.binding,
      source: 'legacy-inferred',
      artifactPath: null,
      bindingDigest: candidate.bindingDigest,
    });
  }
  if (candidateRaw === null && previous.source === 'explicit') {
    throw unsupportedProviderMigration();
  }
  if (candidateRaw !== null) {
    assertPlanningProviderV1Migration(previous.binding, candidateRaw);
  }
  candidate ??= resolveHistoricalOpenSpecProviderBinding(
    reader,
    repositoryRoot,
    candidateCommit,
    changeRoot,
    changeId,
  );
  assertPlanningProviderV1Migration(previous.binding, candidate.binding);
  return candidate;
}

function isLegacyOpenSpecMetadata(bytes: Uint8Array): boolean {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  if (source === 'schema: spec-driven\n') return true;
  const match = LEGACY_OPENSPEC_METADATA.exec(source);
  return match !== null && isCanonicalDate(match[2]!);
}

function isCanonicalDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  const timestamp = Date.UTC(year!, month! - 1, day!);
  return new Date(timestamp).toISOString().slice(0, 10) === value;
}

function assertOpenSpecBinding(
  binding: PlanningProviderBindingV1,
  changeRoot: string,
  changeId: string,
): void {
  if (
    binding.changeId !== changeId ||
    binding.providerId !== OPENSPEC_PROVIDER_ID ||
    binding.adapterContractVersion !== OPENSPEC_ADAPTER_CONTRACT_VERSION ||
    binding.providerRequirement.package !== OPENSPEC_PACKAGE_NAME ||
    binding.providerRequirement.version !== OPENSPEC_PACKAGE_VERSION ||
    binding.planningRoot !== `${changeRoot}/${changeId}`
  ) {
    throw workflowError(
      'PROVIDER_BINDING_MISMATCH',
      'Planning-provider binding does not select the reviewed OpenSpec adapter contract.',
      ExitCode.verification,
      { details: { changeId, providerId: binding.providerId } },
    );
  }
}

function providerBindingMissing(
  changeId: string,
): ReturnType<typeof workflowError> {
  return workflowError(
    'PROVIDER_BINDING_MISSING',
    'A managed change after the planning-provider cutover requires an explicit binding.',
    ExitCode.verification,
    { details: { changeId, path: planningProviderBindingPath(changeId) } },
  );
}

function unsupportedProviderMigration(): ReturnType<typeof workflowError> {
  return workflowError(
    'PROVIDER_MIGRATION_UNSUPPORTED',
    'Planning-provider migration is not supported by binding contract v1.',
    ExitCode.guard,
  );
}
