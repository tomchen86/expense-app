import path from 'node:path';

import {
  deriveAuthorityAuditRepositoryId,
  type AuthorityAuditLedgerScope,
} from './authority-audit-ledger.ts';
import {
  showAuthorityAuditTask,
  verifyAuthorityAuditEvents,
} from './authority-audit-service.ts';
import { ExitCode, workflowError } from './errors.ts';
import { discoverRepository, runGit } from './git.ts';
import { parseMaintainerPolicy } from './maintainer-policy.ts';

export type AuthorityAuditCliResult = Readonly<{
  kind: 'authority-audit-cli-result.v1';
  action: 'show' | 'verify';
  requestedSubject: string;
  verified: boolean;
  result: ReturnType<
    typeof showAuthorityAuditTask | typeof verifyAuthorityAuditEvents
  >;
}>;

export function dispatchAuthorityAuditCommand(
  argv: readonly string[],
  cwd: string,
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
  const result =
    parsed.action === 'show'
      ? showAuthorityAuditTask(resolved.scope, parsed.subject)
      : verifyAuthorityAuditEvents(resolved.scope);
  return {
    kind: 'authority-audit-cli-result.v1',
    action: parsed.action,
    requestedSubject: parsed.subject,
    verified: result.ok,
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
    '  audit show <task-id> --audit-root <absolute-external-path>',
    '  audit verify <repository-id> --audit-root <absolute-external-path>',
  ].join('\n');
}

function parseArguments(argv: readonly string[]): {
  action: 'show' | 'verify';
  subject: string;
  auditRoot: string;
} {
  if (
    argv.length !== 4 ||
    !['show', 'verify'].includes(argv[0] ?? '') ||
    typeof argv[1] !== 'string' ||
    argv[1].length === 0 ||
    argv[1].trim() !== argv[1] ||
    argv[2] !== '--audit-root' ||
    typeof argv[3] !== 'string'
  ) {
    throw auditUsageError();
  }
  return {
    action: argv[0] as 'show' | 'verify',
    subject: argv[1],
    auditRoot: argv[3],
  };
}

function assertExternalAuditRoot(value: string): string {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value
  ) {
    throw auditUsageError();
  }
  return value;
}

function auditUsageError() {
  return workflowError(
    'AUTHORITY_AUDIT_USAGE',
    authorityAuditUsage(),
    ExitCode.usage,
  );
}
