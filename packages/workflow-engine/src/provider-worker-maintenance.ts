import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import {
  assertPrivateInvestigationDirectory,
  createPrivateCanonicalJson,
  ensurePrivateInvestigationDirectory,
  readPrivateCanonicalJson,
} from './investigation-session-store.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import type { ProviderInvocationRecord } from './provider-invocation-store.ts';

const WARNING_FILE = /^[0-9a-f]{64}\.json$/;

export type ProviderWorkerMaintenanceWarning = Readonly<{
  schemaVersion: 1;
  kind: 'provider-worker-maintenance-warning';
  warningId: string;
  operation:
    'automatic-retry' | 'retry-schedule-pump' | 'retention-maintenance';
  invocationId: string;
  terminalRevision: number;
  terminalState: 'succeeded' | 'failed';
  errorCode: string;
  message: string;
  occurredAt: string;
}>;

export function recordProviderWorkerMaintenanceWarning(
  cwd: string,
  record: ProviderInvocationRecord,
  operation: ProviderWorkerMaintenanceWarning['operation'],
  error: unknown,
): ProviderWorkerMaintenanceWarning {
  if (record.state !== 'succeeded' && record.state !== 'failed') {
    throw providerWorkerMaintenanceUnsafe();
  }
  const errorCode =
    error instanceof WorkflowError
      ? error.code
      : 'PROVIDER_WORKER_MAINTENANCE_UNEXPECTED';
  const identity = {
    kind: 'provider-worker-maintenance-warning',
    operation,
    invocationId: record.invocationId,
    terminalRevision: record.revision,
    terminalState: record.state,
    errorCode,
  };
  const warning = assertProviderWorkerMaintenanceWarning({
    schemaVersion: 1,
    kind: 'provider-worker-maintenance-warning',
    warningId: digestCanonical(identity),
    operation,
    invocationId: record.invocationId,
    terminalRevision: record.revision,
    terminalState: record.state,
    errorCode,
    message: `Provider worker ${operation} failed after the terminal outcome was durable (${errorCode}).`,
    occurredAt: record.updatedAt,
  });
  const context = loadInvestigationRuntimeContext(cwd);
  const root = warningRoot(context.runtime.root);
  ensurePrivateInvestigationDirectory(
    context.runtime,
    root,
    providerWorkerMaintenanceUnsafe,
  );
  createPrivateCanonicalJson(
    context.runtime,
    path.join(root, `${warning.warningId.slice('sha256:'.length)}.json`),
    warning,
    providerWorkerMaintenanceUnsafe,
    'PROVIDER_WORKER_MAINTENANCE_WARNING_CONFLICT',
  );
  const durable = listProviderWorkerMaintenanceWarnings(cwd).find(
    ({ warningId }) => warningId === warning.warningId,
  );
  if (
    durable === undefined ||
    canonicalJson(durable) !== canonicalJson(warning)
  ) {
    throw providerWorkerMaintenanceUnsafe();
  }
  return durable;
}

export function listProviderWorkerMaintenanceWarnings(
  cwd: string,
): ProviderWorkerMaintenanceWarning[] {
  const context = loadInvestigationRuntimeContext(cwd);
  const root = warningRoot(context.runtime.root);
  const stats = fs.lstatSync(root, { throwIfNoEntry: false });
  if (stats === undefined) return [];
  assertPrivateInvestigationDirectory(
    context.runtime,
    root,
    providerWorkerMaintenanceUnsafe,
  );
  return fs
    .readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !WARNING_FILE.test(entry.name)
      ) {
        throw providerWorkerMaintenanceUnsafe();
      }
      const warning = assertProviderWorkerMaintenanceWarning(
        readPrivateCanonicalJson(
          context.runtime,
          path.join(root, entry.name),
          providerWorkerMaintenanceUnsafe,
        ),
      );
      if (`${warning.warningId.slice('sha256:'.length)}.json` !== entry.name) {
        throw providerWorkerMaintenanceUnsafe();
      }
      return warning;
    });
}

function warningRoot(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'provider-worker-maintenance', 'warnings');
}

function assertProviderWorkerMaintenanceWarning(
  value: unknown,
): ProviderWorkerMaintenanceWarning {
  if (
    !isRecord(value) ||
    canonicalJson(Object.keys(value).sort()) !==
      canonicalJson(
        [
          'schemaVersion',
          'kind',
          'warningId',
          'operation',
          'invocationId',
          'terminalRevision',
          'terminalState',
          'errorCode',
          'message',
          'occurredAt',
        ].sort(),
      ) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-worker-maintenance-warning' ||
    !isDigest(value.warningId) ||
    (value.operation !== 'automatic-retry' &&
      value.operation !== 'retry-schedule-pump' &&
      value.operation !== 'retention-maintenance') ||
    typeof value.invocationId !== 'string' ||
    value.invocationId.length === 0 ||
    !Number.isSafeInteger(value.terminalRevision) ||
    (value.terminalRevision as number) < 1 ||
    (value.terminalState !== 'succeeded' && value.terminalState !== 'failed') ||
    typeof value.errorCode !== 'string' ||
    !/^[A-Z][A-Z0-9_]{1,127}$/.test(value.errorCode) ||
    typeof value.message !== 'string' ||
    value.message.length === 0 ||
    !isTimestamp(value.occurredAt)
  ) {
    throw providerWorkerMaintenanceUnsafe();
  }
  return deepFreeze(
    structuredClone(value) as unknown as ProviderWorkerMaintenanceWarning,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function digestCanonical(value: unknown): string {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}

function providerWorkerMaintenanceUnsafe(): WorkflowError {
  return workflowError(
    'PROVIDER_WORKER_MAINTENANCE_WARNING_UNSAFE',
    'The provider worker maintenance warning journal is unsafe.',
    ExitCode.staleState,
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
