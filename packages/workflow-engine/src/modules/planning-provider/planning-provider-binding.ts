import crypto from 'node:crypto';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { normalizeExactRepositoryPath } from '../../foundation/repository-path/repository-path.ts';

const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u;

export type PlanningProviderBindingV1 = Readonly<{
  schemaVersion: 1;
  changeId: string;
  providerId: string;
  adapterContractVersion: number;
  providerRequirement: Readonly<{
    package: string;
    version: string;
  }>;
  planningRoot: string;
}>;

export type ResolvedPlanningProviderBinding = Readonly<{
  binding: PlanningProviderBindingV1;
  source: 'explicit' | 'legacy-inferred';
  artifactPath: string | null;
  bindingDigest: string;
}>;

export type PlanningProviderBindingReaderPort = Readonly<{
  readCurrent(
    repositoryRoot: string,
    changeId: string,
  ): PlanningProviderBindingV1 | null;
  readPinnedBinding(
    repositoryRoot: string,
    commit: string,
    changeId: string,
  ): PlanningProviderBindingV1 | null;
  readPinnedEvidenceFile(
    repositoryRoot: string,
    commit: string,
    requestedPath: string,
  ): Uint8Array | null;
  pinnedHistoryContainsPath(
    repositoryRoot: string,
    commit: string,
    requestedPath: string,
  ): boolean;
}>;

export function parsePlanningProviderBinding(
  source: string,
  expectedChangeId: string,
): PlanningProviderBindingV1 {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw bindingInvalid('Planning-provider binding must be valid JSON.');
  }
  if (
    isRecord(value) &&
    Object.hasOwn(value, 'schemaVersion') &&
    value.schemaVersion !== 1
  ) {
    throw workflowError(
      'PROVIDER_BINDING_VERSION_UNSUPPORTED',
      'Planning-provider binding schema version is not supported.',
      ExitCode.verification,
    );
  }
  const binding = assertPlanningProviderBinding(value, expectedChangeId);
  if (source !== renderPlanningProviderBinding(binding)) {
    throw bindingInvalid(
      'Planning-provider binding must use the canonical JSON encoding.',
    );
  }
  return binding;
}

export function renderPlanningProviderBinding(
  value: PlanningProviderBindingV1,
): string {
  const binding = assertPlanningProviderBinding(value, value.changeId);
  return `${JSON.stringify(binding, null, 2)}\n`;
}

export function planningProviderBindingDigest(
  value: PlanningProviderBindingV1,
): string {
  return crypto
    .createHash('sha256')
    .update('planning-provider-binding-v1\0')
    .update(renderPlanningProviderBinding(value))
    .digest('hex');
}

export function assertPlanningProviderV1Migration(
  previous: PlanningProviderBindingV1,
  candidate: PlanningProviderBindingV1,
): void {
  if (
    previous.schemaVersion !== candidate.schemaVersion ||
    previous.changeId !== candidate.changeId ||
    previous.providerId !== candidate.providerId ||
    previous.adapterContractVersion !== candidate.adapterContractVersion ||
    previous.planningRoot !== candidate.planningRoot ||
    previous.providerRequirement.package !==
      candidate.providerRequirement.package ||
    previous.providerRequirement.version !==
      candidate.providerRequirement.version
  ) {
    throw workflowError(
      'PROVIDER_MIGRATION_UNSUPPORTED',
      'Planning-provider migration is not supported by binding contract v1.',
      ExitCode.guard,
    );
  }
}

function assertPlanningProviderBinding(
  value: unknown,
  expectedChangeId: string,
): PlanningProviderBindingV1 {
  if (!CHANGE_ID.test(expectedChangeId) || !isRecord(value)) {
    throw bindingInvalid('Planning-provider binding identity is invalid.');
  }
  assertExactKeys(value, [
    'adapterContractVersion',
    'changeId',
    'planningRoot',
    'providerId',
    'providerRequirement',
    'schemaVersion',
  ]);
  if (!isRecord(value.providerRequirement)) {
    throw bindingInvalid(
      'Planning-provider binding requirement must be an object.',
    );
  }
  assertExactKeys(value.providerRequirement, ['package', 'version']);
  let planningRoot: string;
  try {
    planningRoot =
      typeof value.planningRoot === 'string'
        ? normalizeExactRepositoryPath(value.planningRoot)
        : '';
  } catch {
    throw bindingInvalid('Planning-provider root is not a safe exact path.');
  }
  if (
    value.schemaVersion !== 1 ||
    value.changeId !== expectedChangeId ||
    typeof value.providerId !== 'string' ||
    !PROVIDER_ID.test(value.providerId) ||
    !Number.isSafeInteger(value.adapterContractVersion) ||
    (value.adapterContractVersion as number) < 1 ||
    typeof value.providerRequirement.package !== 'string' ||
    !PACKAGE_NAME.test(value.providerRequirement.package) ||
    typeof value.providerRequirement.version !== 'string' ||
    !VERSION.test(value.providerRequirement.version) ||
    planningRoot !== value.planningRoot
  ) {
    throw bindingInvalid('Planning-provider binding fields are invalid.');
  }
  return Object.freeze({
    schemaVersion: 1,
    changeId: value.changeId,
    providerId: value.providerId,
    adapterContractVersion: value.adapterContractVersion as number,
    providerRequirement: Object.freeze({
      package: value.providerRequirement.package,
      version: value.providerRequirement.version,
    }),
    planningRoot,
  });
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const observed = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    observed.length !== required.length ||
    observed.some((key, index) => key !== required[index])
  ) {
    throw bindingInvalid('Planning-provider binding fields are not exact.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bindingInvalid(message: string): ReturnType<typeof workflowError> {
  return workflowError(
    'PROVIDER_BINDING_INVALID',
    message,
    ExitCode.verification,
  );
}
