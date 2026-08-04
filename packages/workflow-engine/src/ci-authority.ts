import crypto from 'node:crypto';

import { deriveAuthorityAuditRepositoryId } from './authority-audit-ledger.ts';
import {
  authorityApplicationReceiptTagRef,
  listAuthorityApplicationReceiptTagRefs,
  readAuthorityApplicationReceiptTag,
  signedGrantEnvelopeDigest,
  verifyAuthorityApplicationReceiptSignature,
  type AuthorityApplicationReceiptTag,
} from './authority-application-receipt.ts';
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
  MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
  canonicalMaintainerGrantV2Envelope,
  canonicalMaintainerGrantV2Payload,
  parseMaintainerGrantV2Envelope,
  type MaintainerGrantV2Envelope,
} from './maintainer-grant-v2.ts';
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
  if (commit.parents.length !== 1) {
    throw ciAuthorityError(
      'CI_AUTHORITY_COMMIT_INVALID',
      'Authority verification requires one canonical single-parent authority commit.',
    );
  }
  if (commit.trailers?.kind === 'authority-candidate') {
    return validateCiAuthorityCandidateCommit(repositoryRoot, commit);
  }
  if (commit.trailers?.kind !== 'authority') {
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
    allowExpired: true,
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
      commit.hash,
      envelope.payload.changeId,
      parentPolicy.requiredChecks,
    ),
  };
}

function validateCiAuthorityCandidateCommit(
  repositoryRoot: string,
  commit: RangeCommit,
): CiAuthorityResult {
  const trailers = commit.trailers;
  if (trailers?.kind !== 'authority-candidate') {
    throw ciAuthorityError(
      'CI_AUTHORITY_COMMIT_INVALID',
      'V2 authority verification requires canonical candidate trailers.',
    );
  }
  const parent = commit.parents[0]!;
  const parentPolicyContent = requiredFile(
    repositoryRoot,
    parent,
    'workflow/maintainer-policy.json',
  );
  const policy = parsePolicy(
    parentPolicyContent,
    'CI_AUTHORITY_POLICY_INVALID',
  );
  const receiptTag = readCandidateApplicationReceipt(
    repositoryRoot,
    commit.hash,
    policy,
  );
  const receipt = receiptTag.envelope;
  const payload = receipt.payload;
  if (
    receiptTag.target !== commit.hash ||
    payload.candidateCommit !== commit.hash ||
    payload.newRefOid !== commit.hash ||
    payload.terminalCommit !== commit.hash
  ) {
    throw ciAuthorityError(
      'CI_AUTHORITY_V2_RECEIPT_COMMIT_MISMATCH',
      'Portable authority receipt does not bind this exact candidate commit.',
    );
  }
  const expectedReceiptRef = authorityApplicationReceiptTagRef(
    policy,
    payload.grantId,
  );
  if (receiptTag.ref !== expectedReceiptRef) {
    throw ciAuthorityError(
      'CI_AUTHORITY_V2_RECEIPT_REF_MISMATCH',
      'Portable authority receipt is published under the wrong protected ref.',
    );
  }
  const envelope = readV2GrantEnvelope(
    repositoryRoot,
    parent,
    payload.grantId,
    payload.grantTagRef,
    policy,
  );
  if (
    payload.grantEnvelopeDigest !==
    signedGrantEnvelopeDigest(canonicalMaintainerGrantV2Envelope(envelope))
  ) {
    throw ciAuthorityError(
      'CI_AUTHORITY_V2_RECEIPT_TAMPERED',
      'Portable authority receipt does not bind the exact signed v2 grant envelope.',
    );
  }
  try {
    verifyAuthorityApplicationReceiptSignature(
      receipt,
      policy,
      'CI_AUTHORITY_V2_RECEIPT_SIGNATURE_INVALID',
    );
  } catch (error) {
    if (
      workflowErrorCode(error) === 'CI_AUTHORITY_V2_RECEIPT_SIGNATURE_INVALID'
    ) {
      throw error;
    }
    throw ciAuthorityError(
      'CI_AUTHORITY_V2_RECEIPT_SIGNATURE_INVALID',
      'Portable authority receipt signature is invalid or untrusted.',
    );
  }
  const grantSigner = trustedSigner(policy, envelope.payload.signer);
  verifySshDataSignature(
    canonicalMaintainerGrantV2Payload(envelope.payload),
    envelope.signature,
    grantSigner,
    MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
    'CI_AUTHORITY_V2_GRANT_SIGNATURE_INVALID',
  );
  const policyBlob = runGit(repositoryRoot, [
    'rev-parse',
    `${parent}:workflow/maintainer-policy.json`,
  ]).trim();
  const candidate = envelope.payload.candidateBundle;
  if (
    candidate === null ||
    envelope.payload.grantId !== payload.grantId ||
    envelope.payload.changeId !== trailers.changeId ||
    envelope.payload.changeId !== payload.changeId ||
    envelope.payload.repositoryId !== policy.repository.id ||
    envelope.payload.repositoryOrigin !== policy.repository.origin ||
    envelope.payload.repositoryId !== payload.repositoryId ||
    envelope.payload.repositoryOrigin !== payload.repositoryOrigin ||
    payload.auditRepositoryId !==
      deriveAuthorityAuditRepositoryId(payload.repositoryId) ||
    envelope.payload.baseCommit !== parent ||
    envelope.payload.policyBlob !== policyBlob ||
    envelope.payload.policyDigest !== digest(parentPolicyContent) ||
    envelope.payload.signer !== payload.signer ||
    candidate.candidateBundleDigest !== payload.candidateBundleDigest ||
    envelope.payload.candidateBundleDigest !== payload.candidateBundleDigest ||
    candidate.effectsManifestDigest !== payload.effectsManifestDigest ||
    envelope.payload.effectsManifestDigest !== payload.effectsManifestDigest ||
    envelope.payload.patchDigest !== payload.candidatePatchDigest ||
    candidate.manifest.patchDigest !== payload.candidatePatchDigest ||
    candidate.candidateCommit !== commit.hash ||
    candidate.resultTree !== payload.candidateTree
  ) {
    throw ciAuthorityError(
      'CI_AUTHORITY_V2_RECEIPT_TAMPERED',
      'Portable authority receipt differs from its signed grant and candidate bundle.',
    );
  }
  if (
    payload.targetRef !== candidate.targetRef ||
    payload.oldRefOid !== candidate.expectedOldCommit ||
    payload.oldRefOid !== parent
  ) {
    throw ciAuthorityError(
      'CI_AUTHORITY_V2_RECEIPT_REF_MISMATCH',
      'Portable authority receipt does not bind the signed candidate target ref and old OID.',
    );
  }
  if (
    payload.oldRefGeneration !== candidate.expectedRefGeneration ||
    payload.newRefGeneration !== candidate.expectedRefGeneration + 1
  ) {
    throw ciAuthorityError(
      'CI_AUTHORITY_V2_RECEIPT_GENERATION_MISMATCH',
      'Portable authority receipt does not bind the signed ref generation transition.',
    );
  }
  const facts = commitFacts(repositoryRoot, commit.hash);
  if (
    facts.tree !== candidate.resultTree ||
    facts.tree !== payload.candidateTree ||
    facts.message !== candidate.commitMessage ||
    JSON.stringify(facts.parents) !== JSON.stringify([parent])
  ) {
    throw ciAuthorityError(
      'CI_AUTHORITY_V2_RECEIPT_COMMIT_MISMATCH',
      'Candidate commit object differs from the portable authority receipt.',
    );
  }
  const casAt = Date.parse(payload.casAt);
  if (
    casAt < Date.parse(envelope.payload.issuedAt) ||
    casAt > Date.parse(envelope.payload.expiresAt)
  ) {
    throw ciAuthorityError(
      'CI_AUTHORITY_V2_RECEIPT_CAS_INVALID',
      'Portable authority receipt places the protected ref CAS outside the grant lifetime.',
    );
  }
  verifyCommitSignature(repositoryRoot, commit.hash, payload.signer, policy);
  const changedPaths = listCommitPaths(repositoryRoot, commit);
  if (
    changedPaths.length === 0 ||
    JSON.stringify(changedPaths) !==
      JSON.stringify(envelope.payload.allowedPaths) ||
    JSON.stringify(changedPaths) !==
      JSON.stringify(candidate.manifest.files.map(({ path }) => path))
  ) {
    throw ciAuthorityError(
      'CI_AUTHORITY_SCOPE_INVALID',
      'Authority candidate diff differs from its exact signed patch manifest.',
      { changedPaths, allowedPaths: envelope.payload.allowedPaths },
    );
  }
  assertPolicyTransition(repositoryRoot, parent, commit.hash, policy);
  return {
    grantId: payload.grantId,
    changeId: payload.changeId,
    allowedPaths: [...envelope.payload.allowedPaths],
    requiredCheckDefinitions: loadAuthorityCheckDefinitions(
      repositoryRoot,
      parent,
      commit.hash,
      payload.changeId,
      policy.requiredChecks,
    ),
  };
}

function readCandidateApplicationReceipt(
  repositoryRoot: string,
  commitHash: string,
  policy: MaintainerPolicy,
): AuthorityApplicationReceiptTag {
  const refs = listAuthorityApplicationReceiptTagRefs(repositoryRoot, policy);
  const targeted = refs.filter(
    (ref) =>
      runGit(
        repositoryRoot,
        ['rev-parse', '--verify', `${ref}^{commit}`],
        true,
      ).trim() === commitHash,
  );
  if (targeted.length > 1) {
    throw ciAuthorityError(
      'CI_AUTHORITY_V2_RECEIPT_REPLAYED',
      'Multiple portable authority receipts claim the same candidate commit.',
    );
  }
  let tag: AuthorityApplicationReceiptTag | undefined;
  if (targeted.length === 1) {
    try {
      tag = readAuthorityApplicationReceiptTag(repositoryRoot, targeted[0]!);
    } catch {
      throw ciAuthorityError(
        'CI_AUTHORITY_V2_RECEIPT_INVALID',
        'Portable authority receipt tag is malformed or noncanonical.',
      );
    }
  } else {
    const payloadMatches: AuthorityApplicationReceiptTag[] = [];
    for (const ref of refs) {
      try {
        const candidate = readAuthorityApplicationReceiptTag(
          repositoryRoot,
          ref,
        );
        if (candidate.envelope.payload.candidateCommit === commitHash) {
          payloadMatches.push(candidate);
        }
      } catch {
        // An unrelated malformed receipt cannot authorize this commit. A tag
        // targeting this commit was handled above and fails closed.
      }
    }
    if (payloadMatches.length > 1) {
      throw ciAuthorityError(
        'CI_AUTHORITY_V2_RECEIPT_REPLAYED',
        'Multiple portable authority receipt payloads claim the same candidate commit.',
      );
    }
    tag = payloadMatches[0];
  }
  if (tag === undefined) {
    throw ciAuthorityError(
      'CI_AUTHORITY_V2_RECEIPT_REQUIRED',
      'Remote CI requires one portable signed application receipt for this v2 authority candidate.',
    );
  }
  if (tag.target !== commitHash) {
    throw ciAuthorityError(
      'CI_AUTHORITY_V2_RECEIPT_COMMIT_MISMATCH',
      'Portable authority receipt tag targets a different commit.',
    );
  }
  const duplicateGrantRefs = refs.filter((ref) => {
    if (ref === tag!.ref) return false;
    try {
      return (
        readAuthorityApplicationReceiptTag(repositoryRoot, ref).envelope.payload
          .grantId === tag!.envelope.payload.grantId
      );
    } catch {
      return false;
    }
  });
  if (duplicateGrantRefs.length > 0) {
    throw ciAuthorityError(
      'CI_AUTHORITY_V2_RECEIPT_REPLAYED',
      'One v2 grant is claimed by more than one portable application receipt.',
    );
  }
  return tag;
}

function readV2GrantEnvelope(
  repositoryRoot: string,
  parent: string,
  grantId: string,
  requestedRef: string,
  policy: MaintainerPolicy,
): MaintainerGrantV2Envelope {
  const expectedRef = `${policy.auditTagPrefix}${grantId}`;
  if (requestedRef !== expectedRef) {
    throw ciAuthorityError(
      'CI_AUTHORITY_V2_RECEIPT_REF_MISMATCH',
      'Portable authority receipt names the wrong protected grant ref.',
    );
  }
  try {
    const raw = runGit(repositoryRoot, ['cat-file', 'tag', expectedRef]);
    const separator = raw.indexOf('\n\n');
    if (separator === -1) throw new Error('tag body missing');
    const headers = raw.slice(0, separator).split('\n');
    if (
      headers.filter((line) => line === `object ${parent}`).length !== 1 ||
      headers.filter((line) => line === 'type commit').length !== 1 ||
      headers.filter(
        (line) => line === `tag ${expectedRef.slice('refs/tags/'.length)}`,
      ).length !== 1
    ) {
      throw new Error('tag headers differ');
    }
    const envelope = parseMaintainerGrantV2Envelope(raw.slice(separator + 2));
    if (
      envelope.payload.grantId !== grantId ||
      envelope.payload.baseCommit !== parent ||
      canonicalMaintainerGrantV2Envelope(envelope) !== raw.slice(separator + 2)
    ) {
      throw new Error('grant binding differs');
    }
    return envelope;
  } catch {
    throw ciAuthorityError(
      'CI_AUTHORITY_V2_GRANT_INVALID',
      'The exact protected v2 grant tag is missing, malformed, or bound to another base.',
    );
  }
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function workflowErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined;
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
  definitionSource: string,
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
    requiredFile(repositoryRoot, definitionSource, 'workflow/checks.json'),
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
