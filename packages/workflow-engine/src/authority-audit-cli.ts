import fs from 'node:fs';
import path from 'node:path';

import {
  anchorProtectedAuthorityAuditLedger,
  canonicalAuditDestructionGrantEnvelope,
  configureProtectedAuthorityAuditLedger,
  createPinnedAuthorityAuditAnchorBackend,
  createPinnedAuditDestructionSignatureVerifier,
  deriveAuthorityAuditRepositoryId,
  destroyProtectedAuthorityAuditLedger,
  scanAuthorityAuditLedger,
  verifyProtectedAuthorityAuditAnchors,
  type AuditDestructionGrantEnvelope,
  type AuthorityAuditLedgerScope,
} from './runtime/storage-journal/authority-audit-ledger.ts';
import {
  showAuthorityAuditTask,
  verifyAuthorityAuditEvents,
} from './runtime/storage-journal/authority-audit-service.ts';
import { ExitCode, workflowError } from './foundation/errors/errors.ts';
import {
  discoverRepository,
  runGit,
} from './runtime/repository-transaction/git.ts';
import { parseMaintainerPolicy } from './modules/authority/maintainer-policy.ts';

const MAX_AUDIT_INPUT_PATH_BYTES = 4_096;
const MAX_AUDIT_INPUT_FILE_BYTES = 32_768;
const PROTECTED_AUDIT_ASSURANCE =
  'bootstrap-only-local-filesystem-worm-not-remote-sealed' as const;

export type AuthorityAuditCliRuntime = Readonly<{
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  now?: Date;
}>;

type AuthorityAuditCliAssurance = typeof PROTECTED_AUDIT_ASSURANCE | null;

type AuthorityAuditProfileCliResult = Readonly<{
  kind: 'authority-audit-cli-result.v1';
  action: 'profile';
  requestedSubject: 'development' | 'protected';
  verified: true;
  assurance: AuthorityAuditCliAssurance;
  result: ReturnType<typeof scanAuthorityAuditLedger>;
}>;

type AuthorityAuditShowCliResult = Readonly<{
  kind: 'authority-audit-cli-result.v1';
  action: 'show';
  requestedSubject: string;
  verified: boolean;
  assurance: AuthorityAuditCliAssurance;
  result: ReturnType<typeof showAuthorityAuditTask>;
}>;

type AuthorityAuditVerifyCliResult = Readonly<{
  kind: 'authority-audit-cli-result.v1';
  action: 'verify';
  requestedSubject: string;
  verified: boolean;
  assurance: AuthorityAuditCliAssurance;
  result: ReturnType<typeof verifyAuthorityAuditEvents>;
}>;

type AuthorityAuditAnchorCliResult = Readonly<{
  kind: 'authority-audit-cli-result.v1';
  action: 'anchor';
  requestedSubject: string;
  verified: true;
  assurance: typeof PROTECTED_AUDIT_ASSURANCE;
  result: ReturnType<typeof anchorProtectedAuthorityAuditLedger>;
}>;

type AuthorityAuditVerifyAnchorsCliResult = Readonly<{
  kind: 'authority-audit-cli-result.v1';
  action: 'verify-anchors';
  requestedSubject: string;
  verified: true;
  assurance: typeof PROTECTED_AUDIT_ASSURANCE;
  result: ReturnType<typeof verifyProtectedAuthorityAuditAnchors>;
}>;

type AuthorityAuditDestroyCliResult = Readonly<{
  kind: 'authority-audit-cli-result.v1';
  action: 'destroy';
  requestedSubject: string;
  verified: true;
  assurance: typeof PROTECTED_AUDIT_ASSURANCE;
  result: ReturnType<typeof destroyProtectedAuthorityAuditLedger>;
}>;

export type AuthorityAuditCliResult =
  | AuthorityAuditProfileCliResult
  | AuthorityAuditShowCliResult
  | AuthorityAuditVerifyCliResult
  | AuthorityAuditAnchorCliResult
  | AuthorityAuditVerifyAnchorsCliResult
  | AuthorityAuditDestroyCliResult;

type ParsedAuthorityAuditCommand =
  | Readonly<{
      action: 'profile';
      subject: 'development';
      auditRoot: string;
    }>
  | Readonly<{
      action: 'profile';
      subject: 'protected';
      auditRoot: string;
      backendRoot: string;
      destructionPublicKey: string;
    }>
  | Readonly<{
      action: 'show' | 'verify';
      subject: string;
      auditRoot: string;
    }>
  | Readonly<{
      action: 'anchor' | 'verify-anchors';
      auditRoot: string;
    }>
  | Readonly<{
      action: 'destroy';
      auditRoot: string;
      grantFile: string;
    }>;

export function dispatchAuthorityAuditCommand(
  argv: readonly ['profile', ...string[]],
  cwd: string,
  runtime?: AuthorityAuditCliRuntime,
): AuthorityAuditProfileCliResult;
export function dispatchAuthorityAuditCommand(
  argv: readonly ['show', ...string[]],
  cwd: string,
  runtime?: AuthorityAuditCliRuntime,
): AuthorityAuditShowCliResult;
export function dispatchAuthorityAuditCommand(
  argv: readonly ['verify', ...string[]],
  cwd: string,
  runtime?: AuthorityAuditCliRuntime,
): AuthorityAuditVerifyCliResult;
export function dispatchAuthorityAuditCommand(
  argv: readonly ['anchor', ...string[]],
  cwd: string,
  runtime?: AuthorityAuditCliRuntime,
): AuthorityAuditAnchorCliResult;
export function dispatchAuthorityAuditCommand(
  argv: readonly ['verify-anchors', ...string[]],
  cwd: string,
  runtime?: AuthorityAuditCliRuntime,
): AuthorityAuditVerifyAnchorsCliResult;
export function dispatchAuthorityAuditCommand(
  argv: readonly ['destroy', ...string[]],
  cwd: string,
  runtime?: AuthorityAuditCliRuntime,
): AuthorityAuditDestroyCliResult;
export function dispatchAuthorityAuditCommand(
  argv: readonly string[],
  cwd: string,
  runtime?: AuthorityAuditCliRuntime,
): AuthorityAuditCliResult;
export function dispatchAuthorityAuditCommand(
  argv: readonly string[],
  cwd: string,
  runtime: AuthorityAuditCliRuntime = {},
): AuthorityAuditCliResult {
  const parsed = parseArguments(argv);
  const resolved = resolveAuthorityAuditScope(cwd, parsed.auditRoot);

  if (
    parsed.action === 'verify' &&
    parsed.subject !== resolved.repositoryIdentity
  ) {
    throw workflowError(
      'AUTHORITY_AUDIT_REPOSITORY_MISMATCH',
      'Requested repository identity does not match the exact current trust base.',
      ExitCode.verification,
    );
  }

  if (parsed.action === 'profile') {
    if (parsed.subject === 'protected') {
      assertControllingTerminal(runtime);
      assertProtectedBackendRootInput(parsed.backendRoot, resolved.scope);
      const destructionPublicKeyPem = readPrivateInputFile(
        parsed.destructionPublicKey,
        'destruction public key',
      );
      configureProtectedAuthorityAuditLedger(resolved.scope, {
        backendRoot: parsed.backendRoot,
        destructionPublicKeyPem,
      });
    }
    const result = scanAuthorityAuditLedger({
      ...resolved.scope,
      profile: parsed.subject,
    });
    return {
      kind: 'authority-audit-cli-result.v1',
      action: 'profile',
      requestedSubject: parsed.subject,
      verified: true,
      assurance:
        parsed.subject === 'protected' ? PROTECTED_AUDIT_ASSURANCE : null,
      result,
    };
  }

  if (parsed.action === 'show') {
    const result = showAuthorityAuditTask(resolved.scope, parsed.subject);
    return {
      kind: 'authority-audit-cli-result.v1',
      action: 'show',
      requestedSubject: parsed.subject,
      verified: result.ok,
      assurance:
        result.profile === 'protected' ? PROTECTED_AUDIT_ASSURANCE : null,
      result,
    };
  }

  if (parsed.action === 'verify') {
    const result = verifyAuthorityAuditEvents(resolved.scope);
    return {
      kind: 'authority-audit-cli-result.v1',
      action: 'verify',
      requestedSubject: parsed.subject,
      verified: result.ok,
      assurance:
        result.profile === 'protected' ? PROTECTED_AUDIT_ASSURANCE : null,
      result,
    };
  }

  if (parsed.action === 'anchor') {
    const result = anchorProtectedAuthorityAuditLedger(resolved.scope, {
      anchoredAt: exactRuntimeNow(runtime).toISOString(),
      backend: createPinnedAuthorityAuditAnchorBackend(resolved.scope),
    });
    return {
      kind: 'authority-audit-cli-result.v1',
      action: 'anchor',
      requestedSubject: resolved.repositoryIdentity,
      verified: true,
      assurance: PROTECTED_AUDIT_ASSURANCE,
      result,
    };
  }

  if (parsed.action === 'verify-anchors') {
    const result = verifyProtectedAuthorityAuditAnchors(resolved.scope, [
      createPinnedAuthorityAuditAnchorBackend(resolved.scope),
    ]);
    return {
      kind: 'authority-audit-cli-result.v1',
      action: 'verify-anchors',
      requestedSubject: resolved.repositoryIdentity,
      verified: result.ok,
      assurance: PROTECTED_AUDIT_ASSURANCE,
      result,
    };
  }

  if (parsed.action !== 'destroy') {
    throw auditUsageError();
  }
  const envelope = readCanonicalAuditDestructionGrant(parsed.grantFile);
  const result = destroyProtectedAuthorityAuditLedger(
    resolved.scope,
    envelope,
    {
      now: exactRuntimeNow(runtime).toISOString(),
      verifyHumanSignature: createPinnedAuditDestructionSignatureVerifier(
        resolved.scope,
      ),
    },
  );
  return {
    kind: 'authority-audit-cli-result.v1',
    action: 'destroy',
    requestedSubject: envelope.payload.grantId,
    verified: true,
    assurance: PROTECTED_AUDIT_ASSURANCE,
    result,
  };
}

export function resolveAuthorityAuditScope(
  cwd: string,
  requestedAuditRoot: string,
): Readonly<{
  repositoryIdentity: string;
  scope: AuthorityAuditLedgerScope;
}> {
  const repository = discoverRepository(cwd);
  const auditRoot = assertExternalAuditRoot(requestedAuditRoot);
  let policyValue: unknown;
  try {
    policyValue = JSON.parse(
      runGit(repository.repositoryRoot, [
        'show',
        `${repository.head}:workflow/maintainer-policy.json`,
      ]),
    ) as unknown;
  } catch {
    throw workflowError(
      'AUTHORITY_AUDIT_TRUST_BASE_MISSING',
      'Audit inspection requires the exact current maintainer trust base.',
      ExitCode.verification,
    );
  }
  const policy = parseMaintainerPolicy(policyValue);
  return {
    repositoryIdentity: policy.repository.id,
    scope: {
      externalAuditRoot: auditRoot,
      repositoryRoot: repository.repositoryRoot,
      repositoryId: deriveAuthorityAuditRepositoryId(policy.repository.id),
    },
  };
}

export function authorityAuditUsage(): string {
  return [
    'Usage: pnpm workflow audit <command> --audit-root <absolute-external-path>',
    '  audit profile development --audit-root <absolute-external-path>',
    '  audit profile protected --audit-root <absolute-external-path> --backend-root <absolute-private-path> --destruction-public-key <absolute-private-file>',
    '  audit show <task-id> --audit-root <absolute-external-path>',
    '  audit verify <repository-id> --audit-root <absolute-external-path>',
    '  audit anchor --audit-root <absolute-external-path>',
    '  audit verify-anchors --audit-root <absolute-external-path>',
    '  audit destroy --grant-file <absolute-private-file> --audit-root <absolute-external-path>',
  ].join('\n');
}

function parseArguments(argv: readonly string[]): ParsedAuthorityAuditCommand {
  if (argv.length === 0 || argv.some((value) => typeof value !== 'string')) {
    throw auditUsageError();
  }
  const action = argv[0];
  if (action === 'profile') {
    const subject = assertSubject(argv[1]);
    if (subject === 'development') {
      const flags = parseExactFlags(argv.slice(2), ['--audit-root']);
      return {
        action,
        subject,
        auditRoot: flags.get('--audit-root')!,
      };
    }
    if (subject === 'protected') {
      const flags = parseExactFlags(argv.slice(2), [
        '--audit-root',
        '--backend-root',
        '--destruction-public-key',
      ]);
      return {
        action,
        subject,
        auditRoot: flags.get('--audit-root')!,
        backendRoot: flags.get('--backend-root')!,
        destructionPublicKey: flags.get('--destruction-public-key')!,
      };
    }
    throw auditUsageError();
  }
  if (action === 'show' || action === 'verify') {
    const subject = assertSubject(argv[1]);
    const flags = parseExactFlags(argv.slice(2), ['--audit-root']);
    return {
      action,
      subject,
      auditRoot: flags.get('--audit-root')!,
    };
  }
  if (action === 'anchor' || action === 'verify-anchors') {
    const flags = parseExactFlags(argv.slice(1), ['--audit-root']);
    return { action, auditRoot: flags.get('--audit-root')! };
  }
  if (action === 'destroy') {
    const flags = parseExactFlags(argv.slice(1), [
      '--audit-root',
      '--grant-file',
    ]);
    return {
      action,
      auditRoot: flags.get('--audit-root')!,
      grantFile: flags.get('--grant-file')!,
    };
  }
  throw auditUsageError();
}

function parseExactFlags(
  argv: readonly string[],
  expectedFlags: readonly string[],
): ReadonlyMap<string, string> {
  if (argv.length !== expectedFlags.length * 2) throw auditUsageError();
  const permitted = new Set(expectedFlags);
  const parsed = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      typeof flag !== 'string' ||
      !permitted.has(flag) ||
      parsed.has(flag) ||
      typeof value !== 'string' ||
      value.length === 0 ||
      value.trim() !== value ||
      value.includes('\0')
    ) {
      throw auditUsageError();
    }
    parsed.set(flag, value);
  }
  if (expectedFlags.some((flag) => !parsed.has(flag))) throw auditUsageError();
  return parsed;
}

function assertSubject(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value) > 512
  ) {
    throw auditUsageError();
  }
  return value;
}

function assertExternalAuditRoot(value: string): string {
  if (!isCanonicalAbsolutePath(value)) throw auditUsageError();
  return value;
}

function assertCanonicalInputFilePath(value: string): string {
  if (!isCanonicalAbsolutePath(value)) throw auditUsageError();
  return value;
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= MAX_AUDIT_INPUT_PATH_BYTES &&
    !value.includes('\0') &&
    path.isAbsolute(value) &&
    path.normalize(value) === value
  );
}

function assertControllingTerminal(runtime: AuthorityAuditCliRuntime): void {
  const stdinIsTTY = runtime.stdinIsTTY ?? process.stdin.isTTY === true;
  const stdoutIsTTY = runtime.stdoutIsTTY ?? process.stdout.isTTY === true;
  if (stdinIsTTY !== true || stdoutIsTTY !== true) {
    throw workflowError(
      'AUTHORITY_AUDIT_CONTROLLING_TERMINAL_REQUIRED',
      'Protected audit configuration requires both controlling stdin and stdout terminals.',
      ExitCode.guard,
    );
  }
}

function exactRuntimeNow(runtime: AuthorityAuditCliRuntime): Date {
  const now = runtime.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw workflowError(
      'AUTHORITY_AUDIT_CLOCK_INVALID',
      'Authority audit command requires a valid trusted runtime clock.',
      ExitCode.usage,
    );
  }
  return new Date(now.getTime());
}

function assertProtectedBackendRootInput(
  backendRoot: string,
  scope: AuthorityAuditLedgerScope,
): void {
  if (!isCanonicalAbsolutePath(backendRoot)) throw auditUsageError();
  let stats: fs.Stats;
  let realBackendRoot: string;
  try {
    stats = fs.lstatSync(backendRoot);
    realBackendRoot = fs.realpathSync(backendRoot);
  } catch {
    throw protectedConfigurationInputInvalid();
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== 0o700 ||
    realBackendRoot !== backendRoot ||
    pathsOverlap(backendRoot, scope.repositoryRoot) ||
    pathsOverlap(backendRoot, scope.externalAuditRoot)
  ) {
    throw protectedConfigurationInputInvalid();
  }
}

function readCanonicalAuditDestructionGrant(
  grantFile: string,
): AuditDestructionGrantEnvelope {
  const bytes = readPrivateInputFile(grantFile, 'audit destruction grant');
  let raw: unknown;
  try {
    raw = JSON.parse(bytes) as unknown;
  } catch {
    throw destructionGrantFileInvalid();
  }
  const canonical = canonicalAuditDestructionGrantEnvelope(
    raw as AuditDestructionGrantEnvelope,
  );
  if (bytes !== canonical) throw destructionGrantFileInvalid();
  return JSON.parse(canonical) as AuditDestructionGrantEnvelope;
}

function readPrivateInputFile(filePathValue: string, label: string): string {
  const filePath = assertCanonicalInputFilePath(filePathValue);
  let descriptor: number | undefined;
  try {
    const realPath = fs.realpathSync(filePath);
    const before = fs.lstatSync(filePath);
    if (
      realPath !== filePath ||
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      (before.mode & 0o777) !== 0o600 ||
      before.size < 1 ||
      before.size > MAX_AUDIT_INPUT_FILE_BYTES
    ) {
      throw inputFileUnsafe(label);
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY |
        (typeof fs.constants.O_NOFOLLOW === 'number'
          ? fs.constants.O_NOFOLLOW
          : 0),
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.size !== before.size
    ) {
      throw inputFileUnsafe(label);
    }
    const content = fs.readFileSync(descriptor, 'utf8');
    const after = fs.fstatSync(descriptor);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.nlink !== 1 ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      Buffer.byteLength(content) !== opened.size
    ) {
      throw inputFileUnsafe(label);
    }
    return content;
  } catch (error) {
    if (isWorkflowErrorCode(error, 'AUTHORITY_AUDIT_INPUT_FILE_UNSAFE')) {
      throw error;
    }
    throw inputFileUnsafe(label);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = path.relative(left, right);
  const rightToLeft = path.relative(right, left);
  return (
    leftToRight === '' ||
    rightToLeft === '' ||
    (!leftToRight.startsWith('..') && !path.isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith('..') && !path.isAbsolute(rightToLeft))
  );
}

function isWorkflowErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function protectedConfigurationInputInvalid() {
  return workflowError(
    'AUTHORITY_AUDIT_PROTECTED_CONFIGURATION_INVALID',
    'Protected audit configuration requires a canonical, private, external backend root.',
    ExitCode.unsafeEnvironment,
  );
}

function inputFileUnsafe(label: string) {
  return workflowError(
    'AUTHORITY_AUDIT_INPUT_FILE_UNSAFE',
    `Authority audit ${label} must be an exact canonical regular 0600 file.`,
    ExitCode.unsafeEnvironment,
  );
}

function destructionGrantFileInvalid() {
  return workflowError(
    'AUTHORITY_AUDIT_DESTRUCTION_GRANT_INVALID',
    'Audit destruction grant file is not exact canonical JSON.',
    ExitCode.verification,
  );
}

function auditUsageError() {
  return workflowError(
    'AUTHORITY_AUDIT_USAGE',
    authorityAuditUsage(),
    ExitCode.usage,
  );
}
