import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendAuthorityAuditRecord, authorityAuditLedgerPaths, scanAuthorityAuditLedger, } from './authority-audit-ledger.js';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.js';
import { ExitCode, workflowError } from '../../foundation/errors/errors.js';
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,191}$/;
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,255}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,127}$/;
const MAX_EVENT_BYTES = 4_096;
const EVENT_KEYS = [
    'actor',
    'candidateBundleDigest',
    'changeId',
    'command',
    'errorCode',
    'eventId',
    'eventType',
    'externalEffect',
    'grantDigest',
    'idempotencyKey',
    'kind',
    'occurredAt',
    'outcomeDigest',
    'poststateDigest',
    'prestateDigest',
    'providerInvocation',
    'repositoryId',
    'result',
    'schemaVersion',
    'taskId',
    'workflowId',
];
export function recordAuthorityAuditEvent(scope, rawInput, hooks = {}) {
    const input = assertEventInput(rawInput);
    const event = buildAuthorityAuditEvent(scope.repositoryId, input);
    const bytes = canonicalAuthorityAuditEvent(event);
    const eventDigest = digest(bytes);
    const ledger = appendAuthorityAuditRecord(scope, authorityAuditAppendInputForEvent(event), hooks.now === undefined ? {} : { now: hooks.now });
    hooks.testAfterLedgerAppend?.();
    const eventPath = publishEventObject(scope, eventDigest, bytes, hooks);
    return deepFreeze({ eventDigest, eventPath, event, ledger });
}
export function verifyAuthorityAuditEvents(scope) {
    const scan = scanAuthorityAuditLedger(scope);
    const paths = authorityAuditServicePaths(scope);
    assertEventDirectoryClosure(paths.events, new Set(scan.records.map(({ record }) => record.resultDigest)));
    const events = [];
    let legacyUnprojectedCount = 0;
    for (const ledger of scan.records) {
        const eventPath = path.join(paths.events, `${ledger.record.resultDigest.slice('sha256:'.length)}.json`);
        if (!fs.lstatSync(eventPath, { throwIfNoEntry: false })) {
            legacyUnprojectedCount += 1;
            continue;
        }
        const bytes = readExactEventFile(eventPath);
        if (digest(bytes) !== ledger.record.resultDigest)
            throw eventUnsafe();
        const event = parseAuthorityAuditEvent(bytes.toString('utf8'));
        assertEventMatchesLedger(event, ledger, scan.repositoryId);
        events.push(deepFreeze({
            eventDigest: ledger.record.resultDigest,
            eventPath,
            event,
            ledger,
        }));
    }
    return deepFreeze({
        repositoryId: scan.repositoryId,
        profile: scan.profile,
        ok: legacyUnprojectedCount === 0,
        recordCount: scan.recordCount,
        projectedEventCount: events.length,
        legacyUnprojectedCount,
        headSequence: scan.headSequence,
        headRecordDigest: scan.headRecordDigest,
        events,
    });
}
export function showAuthorityAuditTask(scope, requestedTaskId) {
    const taskId = assertSubject(requestedTaskId, 'task ID');
    const verified = verifyAuthorityAuditEvents(scope);
    return deepFreeze({
        ...verified,
        events: verified.events.filter((entry) => entry.event.taskId === taskId),
    });
}
export function canonicalAuthorityAuditEvent(event) {
    assertStoredEvent(event);
    const bytes = `${canonicalJson(event)}\n`;
    if (Buffer.byteLength(bytes) > MAX_EVENT_BYTES)
        throw eventInvalid();
    return bytes;
}
export function buildAuthorityAuditEvent(repositoryId, rawInput) {
    const input = assertEventInput(rawInput);
    const eventId = digest(canonicalJson({
        kind: 'authority-audit-event-identity.v1',
        repositoryId,
        eventType: input.eventType,
        idempotencyKey: input.idempotencyKey,
    }));
    return deepFreeze({
        schemaVersion: 1,
        kind: 'authority-audit-event.v1',
        eventId,
        repositoryId,
        ...structuredClone(input),
    });
}
export function authorityAuditAppendInputForEvent(event) {
    const checked = assertStoredEvent(event);
    return {
        eventType: checked.eventType,
        occurredAt: checked.occurredAt,
        idempotencyKey: checked.idempotencyKey,
        grantDigest: checked.grantDigest,
        candidateBundleDigest: checked.candidateBundleDigest,
        prestateDigest: checked.prestateDigest,
        poststateDigest: checked.poststateDigest,
        result: checked.result,
        resultDigest: digest(canonicalAuthorityAuditEvent(checked)),
    };
}
export function parseAuthorityAuditEvent(raw) {
    if (typeof raw !== 'string' ||
        Buffer.byteLength(raw) > MAX_EVENT_BYTES ||
        !raw.endsWith('\n')) {
        throw eventUnsafe();
    }
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw eventUnsafe();
    }
    const event = assertStoredEvent(value);
    if (canonicalAuthorityAuditEvent(event) !== raw)
        throw eventUnsafe();
    return event;
}
function assertEventInput(raw) {
    if (!isRecord(raw) ||
        !hasExactKeys(raw, EVENT_KEYS.filter((key) => !['eventId', 'kind', 'repositoryId', 'schemaVersion'].includes(key)))) {
        throw eventInvalid();
    }
    const occurredAt = assertTimestamp(raw.occurredAt);
    const result = assertResult(raw.result);
    const input = {
        eventType: assertEventType(raw.eventType),
        occurredAt,
        idempotencyKey: assertDigest(raw.idempotencyKey),
        actor: assertActor(raw.actor),
        taskId: assertNullableSubject(raw.taskId, 'task ID'),
        changeId: assertNullableSubject(raw.changeId, 'change ID'),
        workflowId: assertNullableSubject(raw.workflowId, 'workflow ID'),
        grantDigest: assertNullableDigest(raw.grantDigest),
        candidateBundleDigest: assertNullableDigest(raw.candidateBundleDigest),
        prestateDigest: assertNullableDigest(raw.prestateDigest),
        poststateDigest: assertNullableDigest(raw.poststateDigest),
        command: assertCommand(raw.command),
        providerInvocation: assertProviderInvocation(raw.providerInvocation),
        externalEffect: assertExternalEffect(raw.externalEffect),
        result,
        outcomeDigest: assertDigest(raw.outcomeDigest),
        errorCode: raw.errorCode === null
            ? null
            : typeof raw.errorCode === 'string' && ERROR_CODE.test(raw.errorCode)
                ? raw.errorCode
                : (() => {
                    throw eventInvalid();
                })(),
    };
    if ((result === 'failed') !== (input.errorCode !== null)) {
        throw eventInvalid();
    }
    return deepFreeze(input);
}
function assertStoredEvent(raw) {
    if (!isRecord(raw) ||
        !hasExactKeys(raw, EVENT_KEYS) ||
        raw.schemaVersion !== 1 ||
        raw.kind !== 'authority-audit-event.v1') {
        throw eventInvalid();
    }
    const input = assertEventInput(Object.fromEntries(Object.entries(raw).filter(([key]) => !['eventId', 'kind', 'repositoryId', 'schemaVersion'].includes(key))));
    const repositoryId = assertDigest(raw.repositoryId);
    const eventId = assertDigest(raw.eventId);
    if (buildAuthorityAuditEvent(repositoryId, input).eventId !== eventId) {
        throw eventInvalid();
    }
    return deepFreeze({
        schemaVersion: 1,
        kind: 'authority-audit-event.v1',
        eventId,
        repositoryId,
        ...structuredClone(input),
    });
}
function assertEventMatchesLedger(event, ledger, repositoryId) {
    const record = ledger.record;
    if (event.repositoryId !== repositoryId ||
        event.eventType !== record.eventType ||
        event.occurredAt !== record.occurredAt ||
        event.idempotencyKey !== record.idempotencyKey ||
        event.grantDigest !== record.grantDigest ||
        event.candidateBundleDigest !== record.candidateBundleDigest ||
        event.prestateDigest !== record.prestateDigest ||
        event.poststateDigest !== record.poststateDigest ||
        event.result !== record.result) {
        throw eventUnsafe();
    }
}
function authorityAuditServicePaths(scope) {
    const ledger = authorityAuditLedgerPaths(scope);
    return { events: ledger.events };
}
function assertEventDirectoryClosure(events, permittedDigests) {
    const stats = fs.lstatSync(events, { throwIfNoEntry: false });
    if (!stats?.isDirectory() ||
        stats.isSymbolicLink() ||
        (stats.mode & 0o777) !== 0o700) {
        throw eventUnsafe();
    }
    for (const name of fs.readdirSync(events)) {
        const match = /^([0-9a-f]{64})\.json$/.exec(name);
        if (match === null ||
            !permittedDigests.has(`sha256:${match[1]}`)) {
            throw eventUnsafe();
        }
        const child = fs.lstatSync(path.join(events, name));
        if (!child.isFile() || child.isSymbolicLink())
            throw eventUnsafe();
    }
}
function publishEventObject(scope, eventDigest, bytes, hooks) {
    const { events } = authorityAuditServicePaths(scope);
    ensurePrivateDirectory(events);
    recoverPreparedEvents(events, eventDigest, bytes);
    const eventPath = path.join(events, `${eventDigest.slice('sha256:'.length)}.json`);
    if (fs.lstatSync(eventPath, { throwIfNoEntry: false })) {
        if (readExactEventFile(eventPath).toString('utf8') !== bytes) {
            throw eventUnsafe();
        }
        return eventPath;
    }
    const temporaryPath = path.join(events, `.${eventDigest.slice('sha256:'.length)}.${crypto.randomUUID()}.tmp`);
    const descriptor = fs.openSync(temporaryPath, fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW, 0o600);
    try {
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
    hooks.testAfterEventPreparation?.();
    try {
        fs.linkSync(temporaryPath, eventPath);
    }
    catch (error) {
        if (!isErrno(error, 'EEXIST'))
            throw error;
        if (readExactEventFile(eventPath).toString('utf8') !== bytes) {
            throw eventUnsafe();
        }
    }
    finally {
        if (fs.lstatSync(temporaryPath, { throwIfNoEntry: false })) {
            fs.unlinkSync(temporaryPath);
        }
    }
    fsyncDirectory(events);
    if (readExactEventFile(eventPath).toString('utf8') !== bytes) {
        throw eventUnsafe();
    }
    return eventPath;
}
function recoverPreparedEvents(events, expectedDigest, expectedBytes) {
    const aliases = fs
        .readdirSync(events)
        .filter((name) => name.startsWith(`.${expectedDigest.slice(7)}.`));
    for (const alias of aliases) {
        if (!/^\.[0-9a-f]{64}\.[0-9a-f-]{36}\.tmp$/.test(alias)) {
            throw eventUnsafe();
        }
        const aliasPath = path.join(events, alias);
        const bytes = readExactEventFile(aliasPath).toString('utf8');
        if (bytes !== expectedBytes)
            throw eventUnsafe();
        fs.unlinkSync(aliasPath);
    }
    if (aliases.length > 0)
        fsyncDirectory(events);
}
function readExactEventFile(filePath) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats?.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        (stats.mode & 0o777) !== 0o600 ||
        stats.size > MAX_EVENT_BYTES) {
        throw eventUnsafe();
    }
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const opened = fs.fstatSync(descriptor);
        if (opened.dev !== stats.dev ||
            opened.ino !== stats.ino ||
            opened.size !== stats.size ||
            opened.nlink !== stats.nlink) {
            throw eventUnsafe();
        }
        return fs.readFileSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function ensurePrivateDirectory(directory) {
    const parent = path.dirname(directory);
    const parentStats = fs.lstatSync(parent, { throwIfNoEntry: false });
    if (!parentStats?.isDirectory() || parentStats.isSymbolicLink()) {
        throw eventUnsafe();
    }
    try {
        fs.mkdirSync(directory, { mode: 0o700 });
        fsyncDirectory(parent);
    }
    catch (error) {
        if (!isErrno(error, 'EEXIST'))
            throw error;
    }
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stats?.isDirectory() ||
        stats.isSymbolicLink() ||
        (stats.mode & 0o777) !== 0o700) {
        throw eventUnsafe();
    }
}
function assertActor(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ['identity', 'kind']) ||
        !['agent', 'engine', 'human'].includes(String(value.kind)) ||
        typeof value.identity !== 'string' ||
        !IDENTITY.test(value.identity)) {
        throw eventInvalid();
    }
    return {
        kind: value.kind,
        identity: value.identity,
    };
}
function assertCommand(value) {
    if (value === null)
        return null;
    if (!isRecord(value) ||
        !hasExactKeys(value, ['argvDigest', 'name']) ||
        typeof value.name !== 'string' ||
        !IDENTITY.test(value.name)) {
        throw eventInvalid();
    }
    return { name: value.name, argvDigest: assertDigest(value.argvDigest) };
}
function assertProviderInvocation(value) {
    if (value === null)
        return null;
    if (!isRecord(value) ||
        !hasExactKeys(value, ['invocationId', 'providerId', 'requestDigest']) ||
        typeof value.providerId !== 'string' ||
        !IDENTITY.test(value.providerId) ||
        typeof value.invocationId !== 'string' ||
        !SUBJECT.test(value.invocationId)) {
        throw eventInvalid();
    }
    return {
        providerId: value.providerId,
        invocationId: value.invocationId,
        requestDigest: assertDigest(value.requestDigest),
    };
}
function assertExternalEffect(value) {
    if (value === null)
        return null;
    if (!isRecord(value) ||
        !hasExactKeys(value, ['idempotencyKey', 'kind', 'targetDigest']) ||
        typeof value.kind !== 'string' ||
        !IDENTITY.test(value.kind)) {
        throw eventInvalid();
    }
    return {
        kind: value.kind,
        targetDigest: assertDigest(value.targetDigest),
        idempotencyKey: assertDigest(value.idempotencyKey),
    };
}
function assertEventType(value) {
    if (typeof value !== 'string' ||
        ![
            'abort',
            'apply-grant',
            'branch-update',
            'candidate-bundle',
            'cas',
            'command',
            'control-plane-grant',
            'error',
            'escalation-request',
            'external-effect',
            'file-change',
            'grant-consume',
            'poststate',
            'provider-invocation',
            'recovery',
            'revoke',
            'rollback',
            'supersede',
            'task-mandate',
        ].includes(value)) {
        throw eventInvalid();
    }
    return value;
}
function assertResult(value) {
    if (typeof value !== 'string' ||
        ![
            'aborted',
            'failed',
            'recorded',
            'revoked',
            'rolled-back',
            'succeeded',
            'superseded',
        ].includes(value)) {
        throw eventInvalid();
    }
    return value;
}
function assertTimestamp(value) {
    if (typeof value !== 'string' ||
        Number.isNaN(Date.parse(value)) ||
        new Date(value).toISOString() !== value) {
        throw eventInvalid();
    }
    return value;
}
function assertDigest(value) {
    if (typeof value !== 'string' || !DIGEST.test(value))
        throw eventInvalid();
    return value;
}
function assertNullableDigest(value) {
    return value === null ? null : assertDigest(value);
}
function assertSubject(value, _label) {
    if (typeof value !== 'string' || !SUBJECT.test(value))
        throw eventInvalid();
    return value;
}
function assertNullableSubject(value, label) {
    return value === null ? null : assertSubject(value, label);
}
function hasExactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return JSON.stringify(actual) === JSON.stringify(expected);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isErrno(error, code) {
    return isRecord(error) && error.code === code;
}
function digest(value) {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
function fsyncDirectory(directory) {
    const descriptor = fs.openSync(directory, 'r');
    try {
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function eventInvalid() {
    return workflowError('AUTHORITY_AUDIT_EVENT_INVALID', 'Authority audit event does not match its strict bounded schema.', ExitCode.verification);
}
function eventUnsafe() {
    return workflowError('AUTHORITY_AUDIT_EVENT_UNSAFE', 'Authority audit event storage is missing, indirect, malformed, or tampered.', ExitCode.unsafeEnvironment);
}
function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
    }
    return value;
}
