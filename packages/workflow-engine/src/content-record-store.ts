import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';

export type ContentRecord = {
  schemaVersion: 1;
  kind: string;
  createdAt: string;
  [key: string]: unknown;
};

export function writeContentRecord(
  directory: string,
  record: ContentRecord,
): string {
  const content = `${JSON.stringify(record, null, 2)}\n`;
  const id = digest(content);
  fs.mkdirSync(directory, { recursive: true });
  assertPlainDirectory(directory);
  const recordPath = path.join(directory, `${id}.json`);
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = fs.openSync(recordPath, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    if (isNodeError(error) && error.code === 'EEXIST') {
      if (fs.readFileSync(recordPath, 'utf8') === content) {
        return id;
      }
      throw invalidRecord('CONTENT_RECORD_COLLISION');
    }
    if (created) {
      fs.rmSync(recordPath, { force: true });
    }
    throw error;
  }
  return id;
}

export function readContentRecord(
  directory: string,
  recordId: string,
): ContentRecord {
  if (!/^[0-9a-f]{64}$/.test(recordId)) {
    throw invalidRecord('CONTENT_RECORD_ID_INVALID');
  }
  assertPlainDirectory(directory);
  const recordPath = path.join(directory, `${recordId}.json`);
  let content: string;
  try {
    content = fs.readFileSync(recordPath, 'utf8');
  } catch {
    throw invalidRecord('CONTENT_RECORD_UNREADABLE');
  }
  if (digest(content) !== recordId) {
    throw invalidRecord('CONTENT_RECORD_DIGEST_MISMATCH');
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw invalidRecord('CONTENT_RECORD_INVALID');
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.kind !== 'string' ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(Date.parse(value.createdAt))
  ) {
    throw invalidRecord('CONTENT_RECORD_INVALID');
  }
  return value as ContentRecord;
}

function assertPlainDirectory(directory: string): void {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw invalidRecord('CONTENT_RECORD_DIRECTORY_UNSAFE');
  }
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function invalidRecord(code: string) {
  return workflowError(
    code,
    'Content-addressed workflow record is invalid.',
    ExitCode.staleState,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
