import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

export type PlanningProviderExecutionContext = Readonly<{
  repositoryRoot: string;
  planningRoot: string;
  changeId: string;
  contractName: string;
  revision: Readonly<
    { kind: 'worktree' } | { kind: 'commit'; objectId: string }
  >;
  readOnly: true;
}>;

export type PlanningProviderDiagnostic = Readonly<{
  level: 'ERROR' | 'WARNING' | 'INFO';
  path: string;
  message: string;
  line?: number;
  column?: number;
}>;

export type PlanningProviderReadinessBlocker = Readonly<{
  artifactId: string;
  status: string;
  missingDependencies: readonly string[];
}>;

export type PlanningProviderInstallationEvidence = Readonly<{
  providerId: string;
  adapterContractVersion: number;
  providerVersion: string;
  installationDigest: string;
}>;

export type PlanningProviderChangeResult = Readonly<{
  readiness: 'ready' | 'blocked';
  blockers: readonly PlanningProviderReadinessBlocker[];
  valid: boolean;
  diagnostics: readonly PlanningProviderDiagnostic[];
  validationDigest: string;
}>;

export interface PlanningProviderPort {
  readonly id: string;
  readonly contractVersion: number;
  inspectInstallation(
    context: PlanningProviderExecutionContext,
  ): PlanningProviderInstallationEvidence;
  validateChange(
    context: PlanningProviderExecutionContext,
  ): PlanningProviderChangeResult;
  inspectChange(
    context: PlanningProviderExecutionContext,
  ): PlanningProviderChangeResult;
}

export type PlanningProviderEvaluation = Readonly<{
  installation: PlanningProviderInstallationEvidence;
  change: PlanningProviderChangeResult;
  evaluationDigest: string;
}>;

export function evaluatePlanningProvider(
  port: PlanningProviderPort,
  context: PlanningProviderExecutionContext,
): PlanningProviderEvaluation {
  assertPortIdentity(port);
  if (context.readOnly !== true) {
    throw providerContractInvalid(
      'Planning-provider evaluation must be explicitly read-only.',
    );
  }
  if (
    !context.repositoryRoot ||
    !context.planningRoot ||
    !context.changeId ||
    !context.contractName
  ) {
    throw providerContractInvalid(
      'Planning-provider execution context is incomplete.',
    );
  }
  const installation = normalizeInstallationEvidence(
    port.inspectInstallation(context),
    port.id,
    port.contractVersion,
  );
  const validation = normalizeChangeResult(port.validateChange(context));
  if (validation.readiness !== 'ready' || validation.blockers.length !== 0) {
    throw providerContractInvalid(
      'Planning-provider validation returned readiness blockers.',
    );
  }
  const change = normalizeChangeResult(port.inspectChange(context));
  if (
    validation.valid !== change.valid ||
    validation.validationDigest !== change.validationDigest ||
    canonicalJson(validation.diagnostics) !== canonicalJson(change.diagnostics)
  ) {
    throw providerContractInvalid(
      'Planning-provider validation and inspection evidence contradict each other.',
    );
  }
  const evaluationDigest = digest('planning-provider-evaluation-v1', {
    context,
    installation,
    validation,
    change,
  });
  return Object.freeze({ installation, change, evaluationDigest });
}

export function planningProviderResultDigest(
  domain: string,
  value: unknown,
): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(domain)) {
    throw providerContractInvalid(
      'Planning-provider result digest domain is invalid.',
    );
  }
  return digest(`planning-provider-${domain}-v1`, value);
}

function assertPortIdentity(port: PlanningProviderPort): void {
  if (
    !isRecord(port) ||
    typeof port.id !== 'string' ||
    !PROVIDER_ID.test(port.id) ||
    !Number.isSafeInteger(port.contractVersion) ||
    port.contractVersion < 1 ||
    typeof port.inspectInstallation !== 'function' ||
    typeof port.validateChange !== 'function' ||
    typeof port.inspectChange !== 'function'
  ) {
    throw providerContractInvalid(
      'Planning-provider port identity is invalid.',
    );
  }
}

function normalizeInstallationEvidence(
  value: unknown,
  providerId: string,
  contractVersion: number,
): PlanningProviderInstallationEvidence {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'adapterContractVersion',
      'installationDigest',
      'providerId',
      'providerVersion',
    ]) ||
    value.providerId !== providerId ||
    value.adapterContractVersion !== contractVersion ||
    typeof value.providerVersion !== 'string' ||
    value.providerVersion.length === 0 ||
    typeof value.installationDigest !== 'string' ||
    !DIGEST.test(value.installationDigest)
  ) {
    throw providerContractInvalid(
      'Planning-provider installation evidence contradicts the compiled port.',
    );
  }
  return Object.freeze({
    providerId: value.providerId,
    adapterContractVersion: value.adapterContractVersion,
    providerVersion: value.providerVersion,
    installationDigest: value.installationDigest,
  });
}

function normalizeChangeResult(value: unknown): PlanningProviderChangeResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'blockers',
      'diagnostics',
      'readiness',
      'valid',
      'validationDigest',
    ]) ||
    !Array.isArray(value.blockers) ||
    !Array.isArray(value.diagnostics) ||
    (value.readiness !== 'ready' && value.readiness !== 'blocked') ||
    typeof value.valid !== 'boolean' ||
    typeof value.validationDigest !== 'string' ||
    !DIGEST.test(value.validationDigest) ||
    (value.readiness === 'ready' && value.blockers.length > 0) ||
    (value.readiness === 'blocked' && value.blockers.length === 0)
  ) {
    throw providerContractInvalid(
      'Planning-provider change result is internally inconsistent.',
    );
  }
  const blockers = value.blockers.map((blocker) =>
    normalizeReadinessBlocker(blocker),
  );
  if (
    new Set(blockers.map((blocker) => blocker.artifactId)).size !==
      blockers.length ||
    canonicalJson(blockers) !==
      canonicalJson(
        [...blockers].sort((left, right) =>
          compareText(left.artifactId, right.artifactId),
        ),
      )
  ) {
    throw providerContractInvalid(
      'Planning-provider readiness blockers are not canonical.',
    );
  }
  const diagnostics = value.diagnostics.map((diagnostic) =>
    normalizeDiagnostic(diagnostic),
  );
  if (
    canonicalJson(diagnostics) !==
      canonicalJson([...diagnostics].sort(compareDiagnostics)) ||
    new Set(diagnostics.map((diagnostic) => canonicalJson(diagnostic))).size !==
      diagnostics.length ||
    (value.valid &&
      diagnostics.some((diagnostic) => diagnostic.level === 'ERROR'))
  ) {
    throw providerContractInvalid(
      'Planning-provider diagnostics are not canonical.',
    );
  }
  return Object.freeze({
    readiness: value.readiness,
    blockers: Object.freeze(blockers),
    valid: value.valid,
    diagnostics: Object.freeze(diagnostics),
    validationDigest: value.validationDigest,
  });
}

function normalizeReadinessBlocker(
  value: unknown,
): PlanningProviderReadinessBlocker {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['artifactId', 'missingDependencies', 'status']) ||
    typeof value.artifactId !== 'string' ||
    value.artifactId.length === 0 ||
    typeof value.status !== 'string' ||
    value.status.length === 0 ||
    !Array.isArray(value.missingDependencies) ||
    value.missingDependencies.some(
      (dependency) => typeof dependency !== 'string' || dependency.length === 0,
    ) ||
    new Set(value.missingDependencies).size !==
      value.missingDependencies.length ||
    canonicalJson(value.missingDependencies) !==
      canonicalJson([...value.missingDependencies].sort(compareText))
  ) {
    throw providerContractInvalid(
      'Planning-provider readiness blockers are not canonical.',
    );
  }
  return Object.freeze({
    artifactId: value.artifactId,
    status: value.status,
    missingDependencies: Object.freeze([...value.missingDependencies]),
  });
}

function normalizeDiagnostic(value: unknown): PlanningProviderDiagnostic {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['column', 'level', 'line', 'message', 'path'],
      true,
    ) ||
    !['ERROR', 'WARNING', 'INFO'].includes(String(value.level)) ||
    typeof value.level !== 'string' ||
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    typeof value.message !== 'string' ||
    value.message.length === 0 ||
    (value.line !== undefined &&
      (!Number.isSafeInteger(value.line) || Number(value.line) < 1)) ||
    (value.column !== undefined &&
      (!Number.isSafeInteger(value.column) || Number(value.column) < 1))
  ) {
    throw providerContractInvalid(
      'Planning-provider diagnostics are not canonical.',
    );
  }
  return Object.freeze({
    level: value.level as PlanningProviderDiagnostic['level'],
    path: value.path,
    message: value.message,
    ...(value.line === undefined ? {} : { line: value.line as number }),
    ...(value.column === undefined ? {} : { column: value.column as number }),
  });
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  optional = false,
): boolean {
  const actual = Object.keys(value).sort(compareText);
  const allowed = [...expected].sort(compareText);
  if (actual.some((key) => !allowed.includes(key))) return false;
  return optional || canonicalJson(actual) === canonicalJson(allowed);
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

function digest(domain: string, value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(domain)
    .update('\0')
    .update(canonicalJson(value))
    .digest('hex');
}

function providerContractInvalid(
  message: string,
): ReturnType<typeof workflowError> {
  return workflowError(
    'PLANNING_PROVIDER_CONTRACT_INVALID',
    message,
    ExitCode.verification,
  );
}
