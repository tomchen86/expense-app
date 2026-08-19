import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { runGitBuffer } from './git.ts';

const OBJECT_ID_PATTERN = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const TREE_DIGEST_SCHEMA = 'investigation-tree-v1';
const TAB = 0x09;
const NUL = 0x00;
const LF = 0x0a;
const SENSITIVE_BASENAMES = new Set([
  '.env',
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'application_default_credentials.json',
  'auth.json',
  'credentials',
  'credentials.json',
  'credentials.toml',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'kubeconfig',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
  'service-account-key.json',
  'service-account.json',
]);
const SENSITIVE_SUFFIXES = [
  '.jks',
  '.key',
  '.keystore',
  '.p12',
  '.pem',
  '.pfx',
];

/**
 * Fixed V1 tracked-tree maxima. A caller may lower any field to exercise a
 * bound; it may never raise one above the code-owned maximum.
 */
export const TRACKED_TREE_LIMITS = {
  maxBlobBytes: 2 * 1024 * 1024,
  maxTotalScannedBytes: 64 * 1024 * 1024,
} as const;

export type TrackedTreeLimits = {
  -readonly [Key in keyof typeof TRACKED_TREE_LIMITS]: number;
};

/**
 * Process-local operational fence. It is deliberately excluded from tree and
 * evidence identity: expiry aborts the attempt without producing semantic
 * output, while deterministic byte-work limits govern replayable narrowing.
 */
export type TrackedTreeOperationalDeadline = {
  expiresAtMonotonicMillis: number;
};

export type TrackedTreePathIdentity = {
  rawBase64: string;
  utf8: string | null;
};

export type TrackedTreeSkipReason =
  | 'symlink'
  | 'submodule'
  | 'binary'
  | 'invalid-utf8'
  | 'oversize'
  | 'sensitive-path'
  | 'sensitive-suppressed'
  | 'total-budget'
  | 'unsupported';

/**
 * One enumerated tree entry with preserved object identity. Path identity is raw
 * base64 plus a fatal-UTF-8 display (or null). `objectType` and `byteSize` are
 * the exact Git metadata (`byteSize` is null where Git reports no size, e.g. a
 * submodule gitlink). A regular text blob within the byte maxima and total
 * budget carries `content` plus its `contentSha256`; every other object records
 * the exact skip reason and never exposes bytes.
 */
export type TrackedTreeEntry = {
  path: TrackedTreePathIdentity;
  objectId: string;
  objectType: string;
  mode: string;
  byteSize: number | null;
  content?: Buffer;
  contentSha256?: string;
  skipReason?: TrackedTreeSkipReason;
};

export type TrackedTreeSnapshot = {
  treeOid: string;
  treeDigest: string;
  entries: TrackedTreeEntry[];
  totalScannedBlobBytes: number;
  budgetExceeded: boolean;
};

/**
 * Enumerate a pinned Git tree NUL-safely and read the eligible regular text
 * blobs selected within the total byte budget as buffers. Only an exact full
 * tree/commit object ID is accepted; a symbolic ref such as `HEAD` is rejected.
 * Symlinks and submodules are never followed; paths recognized by the code-owned
 * V1 environment/credential policy are never read. Path bytes are preserved
 * verbatim and entries are sorted by raw path bytes with `Buffer.compare`.
 * Blobs are selected for reading in raw-path order up to
 * `maxTotalScannedBytes`; anything beyond it is a deterministic `total-budget`
 * skip. Duplicate blob content is read once but every path is retained.
 */
export function readPinnedTrackedTree(request: {
  repositoryRoot: string;
  treeOid: string;
  limits?: TrackedTreeLimits;
  operationalDeadline?: TrackedTreeOperationalDeadline;
}): TrackedTreeSnapshot {
  const { repositoryRoot, treeOid, operationalDeadline } = request;
  if (!OBJECT_ID_PATTERN.test(treeOid)) {
    throw treeInvalid('Tree object ID must be a full SHA-1 or SHA-256 hash.');
  }
  const limits = assertTrackedTreeLimits(
    request.limits ?? { ...TRACKED_TREE_LIMITS },
  );

  assertOperationalDeadline(operationalDeadline);
  const rawEntries = enumerateTree(
    repositoryRoot,
    treeOid,
    operationalDeadline,
  );
  rawEntries.sort((left, right) =>
    Buffer.compare(left.pathBuffer, right.pathBuffer),
  );
  assertNoDuplicatePaths(rawEntries);

  // Any object referenced by a recognized sensitive path is sensitive wherever
  // it appears: a duplicate non-sensitive path MUST NOT be read as a back door.
  const sensitiveOids = new Set<string>();
  for (const raw of rawEntries) {
    assertOperationalDeadline(operationalDeadline);
    if (isSensitivePath(raw.pathBuffer)) {
      sensitiveOids.add(raw.objectId);
    }
  }

  // Select unique blobs to read in raw-path order, bounded by the total budget,
  // BEFORE any cat-file read. Sensitive and oversize blobs are never read.
  const selectedOids = new Set<string>();
  const budgetSkippedOids = new Set<string>();
  let runningTotal = 0;
  for (const raw of rawEntries) {
    assertOperationalDeadline(operationalDeadline);
    if (
      !isRegularBlob(raw.mode) ||
      isSensitivePath(raw.pathBuffer) ||
      sensitiveOids.has(raw.objectId) ||
      raw.size === null ||
      raw.size > limits.maxBlobBytes ||
      selectedOids.has(raw.objectId) ||
      budgetSkippedOids.has(raw.objectId)
    ) {
      continue;
    }
    if (runningTotal + raw.size <= limits.maxTotalScannedBytes) {
      selectedOids.add(raw.objectId);
      runningTotal += raw.size;
    } else {
      budgetSkippedOids.add(raw.objectId);
    }
  }
  const blobs = readBlobs(
    repositoryRoot,
    [...selectedOids],
    operationalDeadline,
  );

  const uniqueScannedBytes = new Map<string, number>();
  const entries: TrackedTreeEntry[] = rawEntries.map((raw) => {
    assertOperationalDeadline(operationalDeadline);
    const path: TrackedTreePathIdentity = {
      rawBase64: raw.pathBuffer.toString('base64'),
      utf8: decodeUtf8(raw.pathBuffer),
    };
    const base: TrackedTreeEntry = {
      path,
      objectId: raw.objectId,
      objectType: raw.type,
      mode: raw.mode,
      byteSize: raw.size,
    };

    if (raw.mode === '120000') {
      return { ...base, skipReason: 'symlink' };
    }
    if (raw.mode === '160000') {
      return { ...base, skipReason: 'submodule' };
    }
    if (!isRegularBlob(raw.mode)) {
      return { ...base, skipReason: 'unsupported' };
    }
    if (isSensitivePath(raw.pathBuffer)) {
      return { ...base, skipReason: 'sensitive-path' };
    }
    if (sensitiveOids.has(raw.objectId)) {
      return { ...base, skipReason: 'sensitive-suppressed' };
    }
    if (raw.size === null || raw.size > limits.maxBlobBytes) {
      return { ...base, skipReason: 'oversize' };
    }
    if (budgetSkippedOids.has(raw.objectId)) {
      return { ...base, skipReason: 'total-budget' };
    }
    const content = blobs.get(raw.objectId);
    if (content === undefined) {
      return { ...base, skipReason: 'unsupported' };
    }
    if (content.includes(NUL)) {
      return { ...base, skipReason: 'binary' };
    }
    if (decodeUtf8(content) === null) {
      return { ...base, skipReason: 'invalid-utf8' };
    }
    uniqueScannedBytes.set(raw.objectId, content.byteLength);
    return { ...base, content, contentSha256: sha256(content) };
  });

  assertOperationalDeadline(operationalDeadline);
  return {
    treeOid,
    treeDigest: computeTreeDigest(treeOid, entries),
    entries,
    totalScannedBlobBytes: sum(uniqueScannedBytes),
    budgetExceeded: budgetSkippedOids.size > 0,
  };
}

type RawTreeEntry = {
  mode: string;
  type: string;
  objectId: string;
  size: number | null;
  pathBuffer: Buffer;
};

function enumerateTree(
  repositoryRoot: string,
  treeOid: string,
  operationalDeadline?: TrackedTreeOperationalDeadline,
): RawTreeEntry[] {
  const output = runGitBuffer(
    repositoryRoot,
    ['ls-tree', '-r', '-l', '-z', treeOid],
    gitDeadlineOptions(operationalDeadline),
  );
  assertOperationalDeadline(operationalDeadline);
  if (output.length > 0 && output[output.length - 1] !== NUL) {
    throw treeInvalid('ls-tree output is not NUL-terminated.');
  }
  const entries: RawTreeEntry[] = [];
  let position = 0;
  while (position < output.length) {
    assertOperationalDeadline(operationalDeadline);
    const recordEnd = output.indexOf(NUL, position);
    if (recordEnd === -1) {
      throw treeInvalid('Unterminated ls-tree record.');
    }
    const record = output.subarray(position, recordEnd);
    position = recordEnd + 1;
    if (record.length === 0) {
      throw treeInvalid('Empty ls-tree record.');
    }
    const tabIndex = record.indexOf(TAB);
    if (tabIndex === -1) {
      throw treeInvalid('Malformed ls-tree record.');
    }
    const meta = record.subarray(0, tabIndex).toString('utf8');
    const fields = meta.split(/\s+/).filter(Boolean);
    if (fields.length !== 4) {
      throw treeInvalid('Malformed ls-tree metadata.');
    }
    const [mode, type, objectId, sizeField] = fields;
    if (!/^[0-7]{6}$/.test(mode!) || !OBJECT_ID_PATTERN.test(objectId!)) {
      throw treeInvalid('Invalid ls-tree mode or object ID.');
    }
    if (
      ((mode === '100644' || mode === '100755' || mode === '120000') &&
        type !== 'blob') ||
      (mode === '160000' && type !== 'commit')
    ) {
      throw treeInvalid('Inconsistent ls-tree mode/object-type relationship.');
    }
    const size = sizeField === '-' ? null : Number(sizeField);
    if (size !== null && (!Number.isInteger(size) || size < 0)) {
      throw treeInvalid('Invalid ls-tree object size.');
    }
    if (
      (type === 'blob' && size === null) ||
      (type === 'commit' && size !== null)
    ) {
      throw treeInvalid('Inconsistent ls-tree object type/size relationship.');
    }
    entries.push({
      mode: mode!,
      type: type!,
      objectId: objectId!,
      size,
      pathBuffer: Buffer.from(record.subarray(tabIndex + 1)),
    });
  }
  return entries;
}

function readBlobs(
  repositoryRoot: string,
  oids: string[],
  operationalDeadline?: TrackedTreeOperationalDeadline,
): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  if (oids.length === 0) {
    return blobs;
  }
  const output = runGitBuffer(repositoryRoot, ['cat-file', '--batch'], {
    input: Buffer.from(`${oids.join('\n')}\n`, 'utf8'),
    ...gitDeadlineOptions(operationalDeadline),
  });
  assertOperationalDeadline(operationalDeadline);
  let position = 0;
  for (const oid of oids) {
    assertOperationalDeadline(operationalDeadline);
    const headerEnd = output.indexOf(LF, position);
    if (headerEnd === -1) {
      throw treeInvalid('Truncated cat-file batch response.');
    }
    const header = output.subarray(position, headerEnd).toString('utf8');
    position = headerEnd + 1;
    const fields = header.split(' ');
    if (fields.length !== 3 || fields[0] !== oid || fields[1] !== 'blob') {
      throw treeInvalid('Unexpected cat-file batch header.');
    }
    const size = Number(fields[2]);
    if (
      !Number.isInteger(size) ||
      size < 0 ||
      position + size >= output.length
    ) {
      throw treeInvalid('Invalid cat-file batch object size.');
    }
    if (output[position + size] !== LF) {
      throw treeInvalid('cat-file batch object is not LF-terminated.');
    }
    blobs.set(oid, Buffer.from(output.subarray(position, position + size)));
    position += size + 1;
  }
  if (position !== output.length) {
    throw treeInvalid('Trailing bytes in cat-file batch response.');
  }
  return blobs;
}

function gitDeadlineOptions(
  deadline: TrackedTreeOperationalDeadline | undefined,
): { timeoutMs?: number } {
  if (deadline === undefined) {
    return {};
  }
  const remaining = deadline.expiresAtMonotonicMillis - performance.now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw operationalTimeout();
  }
  return { timeoutMs: Math.max(1, Math.ceil(remaining)) };
}

function assertOperationalDeadline(
  deadline: TrackedTreeOperationalDeadline | undefined,
): void {
  if (
    deadline !== undefined &&
    (!Number.isFinite(deadline.expiresAtMonotonicMillis) ||
      performance.now() >= deadline.expiresAtMonotonicMillis)
  ) {
    throw operationalTimeout();
  }
}

function computeTreeDigest(
  treeOid: string,
  entries: TrackedTreeEntry[],
): string {
  return sha256Hex(
    canonicalJson({
      schema: TREE_DIGEST_SCHEMA,
      treeOid,
      entries: entries.map((entry) => ({
        rawBase64: entry.path.rawBase64,
        objectId: entry.objectId,
        objectType: entry.objectType,
        mode: entry.mode,
        byteSize: entry.byteSize,
      })),
    }),
  );
}

function assertNoDuplicatePaths(entries: RawTreeEntry[]): void {
  for (let index = 1; index < entries.length; index += 1) {
    if (
      Buffer.compare(
        entries[index - 1]!.pathBuffer,
        entries[index]!.pathBuffer,
      ) === 0
    ) {
      throw treeInvalid('Duplicate raw path in pinned tree.');
    }
  }
}

function assertTrackedTreeLimits(limits: TrackedTreeLimits): TrackedTreeLimits {
  for (const key of Object.keys(TRACKED_TREE_LIMITS) as Array<
    keyof TrackedTreeLimits
  >) {
    const value = limits[key];
    if (
      !Number.isInteger(value) ||
      value < 1 ||
      value > TRACKED_TREE_LIMITS[key]
    ) {
      throw treeInvalid(`Tracked-tree limit ${String(key)} is out of range.`);
    }
  }
  return limits;
}

function isRegularBlob(mode: string): boolean {
  return mode === '100644' || mode === '100755';
}

/**
 * Recognized tracked environment and credential files are never read. This is a
 * deliberately explicit code-owned V1 path policy: it covers conventional
 * environment files, package/cloud credential stores, private-key names and
 * extensions, and `.ssh`/Docker auth locations without guessing from arbitrary
 * source-code words such as "token" or "auth".
 */
function isSensitivePath(pathBuffer: Buffer): boolean {
  // Git path identity is raw bytes. Sensitive ASCII basename/segment checks
  // therefore run directly over those bytes: an invalid-UTF-8 parent directory
  // must not hide a valid `/.env` or `/.ssh/id_rsa` suffix. UTF-8 decoding is
  // reserved for the optional display field elsewhere.
  const lowerPath = asciiLowerPath(pathBuffer);
  const segments = lowerPath.split('/');
  const basename = segments.at(-1) ?? '';
  return (
    SENSITIVE_BASENAMES.has(basename) ||
    basename.startsWith('.env.') ||
    SENSITIVE_SUFFIXES.some((suffix) => basename.endsWith(suffix)) ||
    segments.includes('.ssh') ||
    lowerPath.endsWith('/.docker/config.json') ||
    lowerPath === '.docker/config.json'
  );
}

function asciiLowerPath(buffer: Buffer): string {
  const lowered = Buffer.allocUnsafe(buffer.length);
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index]!;
    lowered[index] = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
  }
  return lowered.toString('latin1');
}

function decodeUtf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function sum(values: Map<string, number>): number {
  let total = 0;
  for (const value of values.values()) {
    total += value;
  }
  return total;
}

function sha256(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function treeInvalid(message: string) {
  return workflowError('PINNED_TREE_INVALID', message, ExitCode.usage);
}

function operationalTimeout() {
  return workflowError(
    'INVESTIGATION_SCAN_TIMEOUT',
    'Investigation tree reading exceeded its operational deadline.',
    ExitCode.unsafeEnvironment,
  );
}
