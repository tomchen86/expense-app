import { canonicalCheckDefinition } from './ci-historical-contract.ts';
import {
  listCommitPaths,
  readFileAtCommit,
  type RangeCommit,
} from './ci-git.ts';
import {
  verifySshDataSignature,
  verifyTrustedCommitSignature,
} from './ci-signature.ts';
import {
  parseCheckCommand,
  parseTasks,
  type CheckDefinition,
} from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { commitFacts } from './git-transitions.ts';
import { runGit } from './git.ts';
import {
  canonicalGrantEnvelope,
  canonicalGrantPayload,
  parseMaintainerGrantEnvelope,
  validateGrantPayload,
  type MaintainerGrantEnvelope,
} from './maintainer-grant.ts';
import {
  parseMaintainerPolicy,
  type MaintainerPolicy,
  type TrustedMaintainerSigner,
} from './maintainer-policy.ts';
import {
  ManagedTrailerSyntaxError,
  parseManagedTrailers,
} from './managed-trailers.ts';

export type CiAuthorityResult = {
  grantId: string;
  changeId: string;
  allowedPaths: string[];
  requiredCheckDefinitions: Record<string, string>;
};

export function validateCiAuthorityCommit(
  repositoryRoot: string,
  commit: RangeCommit,
  evaluatedAt: Date = new Date(),
): CiAuthorityResult {
  if (commit.parents.length !== 1 || commit.trailers?.kind !== 'authority') {
    throw ciAuthorityError(
      'CI_AUTHORITY_COMMIT_INVALID',
      'Authority verification requires one canonical single-parent authority commit.',
    );
  }
  const parent = commit.parents[0];
  const policyContent = requiredFile(
    repositoryRoot,
    parent,
    'workflow/maintainer-policy.json',
  );
  const parentPolicy = parsePolicy(
    policyContent,
    'CI_AUTHORITY_POLICY_INVALID',
  );
  const policyBlob = runGit(repositoryRoot, [
    'rev-parse',
    `${parent}:workflow/maintainer-policy.json`,
  ]).trim();
  const envelope = readAuditEnvelope(
    repositoryRoot,
    parent,
    commit.trailers.grantId,
    parentPolicy,
  );
  if (
    envelope.payload.grantId !== commit.trailers.grantId ||
    envelope.payload.changeId !== commit.trailers.changeId
  ) {
    throw ciAuthorityError(
      'CI_AUTHORITY_GRANT_MISMATCH',
      'Authority trailers do not match the protected grant envelope.',
    );
  }
  const evaluationDate = exactDate(evaluatedAt);
  validateGrantPayload(envelope.payload, parentPolicy, {
    now: evaluationDate,
    expectedBase: parent,
    expectedPolicyBlob: policyBlob,
  });
  assertGrantValidAtCommit(repositoryRoot, commit.hash, envelope);
  assertGrantPathsAtParent(
    repositoryRoot,
    parent,
    envelope.payload.allowedPaths,
  );
  verifyEnvelopeSignature(envelope, parentPolicy);
  verifyCommitSignature(
    repositoryRoot,
    commit.hash,
    envelope.payload.signer,
    parentPolicy,
  );
  assertGrantNotPreviouslyClaimed(
    repositoryRoot,
    parent,
    envelope.payload.grantId,
  );

  const changedPaths = listCommitPaths(repositoryRoot, commit);
  if (
    changedPaths.length === 0 ||
    changedPaths.some(
      (filePath) => !envelope.payload.allowedPaths.includes(filePath),
    )
  ) {
    throw ciAuthorityError(
      'CI_AUTHORITY_SCOPE_INVALID',
      'Authority commit contains a path absent from its exact grant.',
      { changedPaths, allowedPaths: envelope.payload.allowedPaths },
    );
  }
  assertPolicyTransition(repositoryRoot, parent, commit.hash, parentPolicy);

  return {
    grantId: envelope.payload.grantId,
    changeId: envelope.payload.changeId,
    allowedPaths: [...envelope.payload.allowedPaths],
    requiredCheckDefinitions: loadAuthorityCheckDefinitions(
      repositoryRoot,
      parent,
      envelope.payload.changeId,
      parentPolicy.requiredChecks,
    ),
  };
}

function readAuditEnvelope(
  repositoryRoot: string,
  parent: string,
  grantId: string,
  policy: MaintainerPolicy,
): MaintainerGrantEnvelope {
  const tagRef = `${policy.auditTagPrefix}${grantId}`;
  try {
    const raw = runGit(repositoryRoot, ['cat-file', 'tag', tagRef]);
    const separator = raw.indexOf('\n\n');
    if (separator === -1) throw new Error('tag body missing');
    const headers = raw.slice(0, separator).split('\n');
    const objectHeaders = headers.filter((line) => line.startsWith('object '));
    const typeHeaders = headers.filter((line) => line.startsWith('type '));
    const tagHeaders = headers.filter((line) => line.startsWith('tag '));
    if (
      objectHeaders.length !== 1 ||
      objectHeaders[0] !== `object ${parent}` ||
      typeHeaders.length !== 1 ||
      typeHeaders[0] !== 'type commit' ||
      tagHeaders.length !== 1 ||
      tagHeaders[0] !== `tag ${tagRef.slice('refs/tags/'.length)}`
    ) {
      throw new Error('tag headers differ');
    }
    const envelope = parseMaintainerGrantEnvelope(raw.slice(separator + 2));
    if (canonicalGrantEnvelope(envelope) !== raw.slice(separator + 2)) {
      throw new Error('tag envelope differs');
    }
    return envelope;
  } catch {
    throw ciAuthorityError(
      'CI_AUTHORITY_AUDIT_TAG_INVALID',
      'The exact protected maintainer grant tag is missing or invalid.',
    );
  }
}

function verifyEnvelopeSignature(
  envelope: MaintainerGrantEnvelope,
  policy: MaintainerPolicy,
): void {
  const signer = trustedSigner(policy, envelope.payload.signer);
  verifySshDataSignature(
    canonicalGrantPayload(envelope.payload),
    envelope.signature,
    signer,
    policy.signatureNamespace,
    'CI_AUTHORITY_GRANT_SIGNATURE_INVALID',
  );
}

function verifyCommitSignature(
  repositoryRoot: string,
  commitHash: string,
  identity: string,
  policy: MaintainerPolicy,
): void {
  verifyTrustedCommitSignature(
    repositoryRoot,
    commitHash,
    trustedSigner(policy, identity),
    'CI_AUTHORITY_COMMIT_SIGNATURE_INVALID',
  );
}

function assertGrantValidAtCommit(
  repositoryRoot: string,
  commitHash: string,
  envelope: MaintainerGrantEnvelope,
): void {
  const rawTimestamp = runGit(repositoryRoot, [
    'show',
    '-s',
    '--format=%cI',
    commitHash,
  ]).trim();
  const committedAt = Date.parse(rawTimestamp);
  const issuedAt = Date.parse(envelope.payload.issuedAt);
  const expiresAt = Date.parse(envelope.payload.expiresAt);
  if (
    !Number.isFinite(committedAt) ||
    committedAt < issuedAt ||
    committedAt > expiresAt
  ) {
    throw ciAuthorityError(
      'CI_AUTHORITY_GRANT_TIME_INVALID',
      'Authority commit was not created within its signed grant lifetime.',
    );
  }
}

function assertGrantPathsAtParent(
  repositoryRoot: string,
  parent: string,
  allowedPaths: string[],
): void {
  for (const filePath of allowedPaths) {
    const output = runGit(repositoryRoot, [
      'ls-tree',
      '-z',
      parent,
      '--',
      `:(literal)${filePath}`,
    ]);
    const match = /^(100644|100755) blob [0-9a-f]{40,64}\t([^\0]+)\0$/.exec(
      output,
    );
    if (!match || match[2] !== filePath) {
      throw ciAuthorityError(
        'CI_AUTHORITY_GRANT_PATH_INVALID',
        'Authority grant does not name an exact tracked parent regular file.',
        { path: filePath },
      );
    }
  }
}

function assertGrantNotPreviouslyClaimed(
  repositoryRoot: string,
  parent: string,
  grantId: string,
): void {
  const ancestors = runGit(repositoryRoot, ['rev-list', parent])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const hash of ancestors) {
    try {
      const trailers = parseManagedTrailers(
        commitFacts(repositoryRoot, hash).message,
      );
      if (trailers?.kind === 'authority' && trailers.grantId === grantId) {
        throw ciAuthorityError(
          'CI_AUTHORITY_GRANT_REPLAYED',
          'Authority grant was already claimed by an ancestor commit.',
          { priorCommit: hash },
        );
      }
    } catch (error) {
      if (error instanceof ManagedTrailerSyntaxError) continue;
      throw error;
    }
  }
}

function assertPolicyTransition(
  repositoryRoot: string,
  parent: string,
  commitHash: string,
  parentPolicy: MaintainerPolicy,
): void {
  const policyPath = 'workflow/maintainer-policy.json';
  const before = requiredFile(repositoryRoot, parent, policyPath);
  const after = readFileAtCommit(repositoryRoot, commitHash, policyPath);
  if (after === before) return;
  if (after === undefined) {
    throw ciAuthorityError(
      'CI_AUTHORITY_POLICY_REMOVED',
      'Authority commit may not remove the maintainer policy.',
    );
  }
  const candidate = parsePolicy(
    after,
    'CI_AUTHORITY_POLICY_TRANSITION_INVALID',
  );
  if (
    JSON.stringify(candidate.repository) !==
      JSON.stringify(parentPolicy.repository) ||
    candidate.auditTagPrefix !== parentPolicy.auditTagPrefix ||
    candidate.signatureNamespace !== parentPolicy.signatureNamespace ||
    candidate.maxTtlMinutes !== parentPolicy.maxTtlMinutes ||
    candidate.maxUses !== parentPolicy.maxUses ||
    (parentPolicy.phase === 'sealed' && candidate.phase !== 'sealed') ||
    parentPolicy.sealedImmutablePaths.some(
      (filePath) => !candidate.sealedImmutablePaths.includes(filePath),
    ) ||
    parentPolicy.requiredChecks.some(
      (checkId) => !candidate.requiredChecks.includes(checkId),
    )
  ) {
    throw ciAuthorityError(
      'CI_AUTHORITY_POLICY_TRANSITION_INVALID',
      'Authority policy transition changes stable identity, rolls back phase, or weakens trust roots.',
    );
  }
}

function loadAuthorityCheckDefinitions(
  repositoryRoot: string,
  parent: string,
  changeId: string,
  policyChecks: string[],
): Record<string, string> {
  const tasks = parseTasks(
    requiredFile(
      repositoryRoot,
      parent,
      `openspec/changes/${changeId}/tasks.md`,
    ),
  );
  const guard = parseJson(
    requiredFile(
      repositoryRoot,
      parent,
      `openspec/changes/${changeId}/guard.json`,
    ),
  );
  if (
    !isRecord(guard) ||
    !hasExactKeys(guard, ['schemaVersion', 'changeId', 'tasks']) ||
    guard.schemaVersion !== 1 ||
    guard.changeId !== changeId ||
    !isRecord(guard.tasks) ||
    JSON.stringify(Object.keys(guard.tasks).sort()) !==
      JSON.stringify(tasks.map(({ id }) => id).sort())
  ) {
    throw ciAuthorityError(
      'CI_AUTHORITY_PARENT_GUARD_INVALID',
      'Authority change does not have a valid parent guard contract.',
    );
  }
  const taskChecks = Object.values(guard.tasks).flatMap((value) => {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['allowedPaths', 'requiredChecks']) ||
      !isStringArray(value.allowedPaths) ||
      value.allowedPaths.length === 0 ||
      !isStringArray(value.requiredChecks) ||
      value.requiredChecks.length === 0
    ) {
      throw ciAuthorityError(
        'CI_AUTHORITY_PARENT_GUARD_INVALID',
        'Authority parent guard contains an invalid task policy.',
      );
    }
    return value.requiredChecks;
  });
  const requiredChecks = [...new Set([...policyChecks, ...taskChecks])].sort();
  const checksDocument = parseJson(
    requiredFile(repositoryRoot, parent, 'workflow/checks.json'),
  );
  if (
    !isRecord(checksDocument) ||
    !hasExactKeys(checksDocument, ['schemaVersion', 'checks']) ||
    checksDocument.schemaVersion !== 1 ||
    !isRecord(checksDocument.checks)
  ) {
    throw ciAuthorityError(
      'CI_AUTHORITY_PARENT_CHECKS_INVALID',
      'Authority parent check registry is invalid.',
    );
  }
  const checkRegistry = checksDocument.checks;
  return Object.fromEntries(
    requiredChecks.map((checkId) => {
      const value = checkRegistry[checkId];
      if (
        !isRecord(value) ||
        !hasExactKeys(value, ['command', 'destructiveDatabase']) ||
        !isStringArray(value.command) ||
        !parseCheckCommand(value.command) ||
        typeof value.destructiveDatabase !== 'boolean'
      ) {
        throw ciAuthorityError(
          'CI_AUTHORITY_PARENT_CHECKS_INVALID',
          `Authority parent check is missing or invalid: ${checkId}.`,
        );
      }
      const definition: CheckDefinition = {
        command: value.command,
        destructiveDatabase: value.destructiveDatabase,
      };
      return [checkId, canonicalCheckDefinition(definition)];
    }),
  );
}

function trustedSigner(
  policy: MaintainerPolicy,
  identity: string,
): TrustedMaintainerSigner {
  const signer = policy.trustedSigners.find(
    (candidate) => candidate.identity === identity,
  );
  if (!signer) {
    throw ciAuthorityError(
      'CI_AUTHORITY_SIGNER_UNTRUSTED',
      'Authority grant signer is absent from the parent policy.',
    );
  }
  return signer;
}

function requiredFile(
  repositoryRoot: string,
  commit: string,
  filePath: string,
): string {
  const content = readFileAtCommit(repositoryRoot, commit, filePath);
  if (content === undefined) {
    throw ciAuthorityError(
      'CI_AUTHORITY_PARENT_CONTRACT_MISSING',
      `Authority parent is missing ${filePath}.`,
    );
  }
  return content;
}

function parsePolicy(content: string, code: string): MaintainerPolicy {
  try {
    return parseMaintainerPolicy(JSON.parse(content));
  } catch {
    throw ciAuthorityError(code, 'Maintainer policy is invalid.');
  }
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function exactDate(value: Date): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw ciAuthorityError(
      'CI_AUTHORITY_EVALUATION_TIME_INVALID',
      'Authority CI evaluation time is invalid.',
    );
  }
  return date;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function ciAuthorityError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return workflowError(code, message, ExitCode.verification, { details });
}
