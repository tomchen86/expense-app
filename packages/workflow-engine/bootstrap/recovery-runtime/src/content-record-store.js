import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from './errors.js';
import { assertPlainDirectory, ensurePlainDirectory, } from './filesystem-safety.js';
export function writeContentRecord(directory, record) {
    const content = `${JSON.stringify(record, null, 2)}\n`;
    const id = digest(content);
    ensurePlainDirectory(directory);
    const recordPath = path.join(directory, `${id}.json`);
    let descriptor;
    let created = false;
    try {
        descriptor = fs.openSync(recordPath, 'wx', 0o600);
        created = true;
        fs.writeFileSync(descriptor, content, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
    }
    catch (error) {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
        if (isNodeError(error) && error.code === 'EEXIST') {
            if (readPlainRecordFile(recordPath) === content) {
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
export function readContentRecord(directory, recordId) {
    if (!/^[0-9a-f]{64}$/.test(recordId)) {
        throw invalidRecord('CONTENT_RECORD_ID_INVALID');
    }
    assertPlainDirectory(directory);
    const recordPath = path.join(directory, `${recordId}.json`);
    let content;
    try {
        content = readPlainRecordFile(recordPath);
    }
    catch {
        throw invalidRecord('CONTENT_RECORD_UNREADABLE');
    }
    if (digest(content) !== recordId) {
        throw invalidRecord('CONTENT_RECORD_DIGEST_MISMATCH');
    }
    let value;
    try {
        value = JSON.parse(content);
    }
    catch {
        throw invalidRecord('CONTENT_RECORD_INVALID');
    }
    if (!isRecord(value) ||
        value.schemaVersion !== 1 ||
        typeof value.kind !== 'string' ||
        typeof value.createdAt !== 'string' ||
        Number.isNaN(Date.parse(value.createdAt))) {
        throw invalidRecord('CONTENT_RECORD_INVALID');
    }
    return value;
}
function readPlainRecordFile(recordPath) {
    const absolute = path.resolve(recordPath);
    const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!stats?.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        fs.realpathSync(absolute) !== absolute) {
        throw invalidRecord('CONTENT_RECORD_FILE_UNSAFE');
    }
    return fs.readFileSync(absolute, 'utf8');
}
function digest(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function invalidRecord(code) {
    return workflowError(code, 'Content-addressed workflow record is invalid.', ExitCode.staleState);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
