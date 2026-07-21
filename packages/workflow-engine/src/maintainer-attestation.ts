import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertAuthorityAttestationPayload,
  authorityAttestationTagRef,
  canonicalAttestationEnvelope,
  canonicalAttestationPayload,
  validateAttestedTransitionPair,
  validateAuthorityTransitionIdentity,
  type AttestationGrantBaseMapping,
  type AttestedCommitFacts,
  type AuthorityAttestationEnvelope,
  type AuthorityAttestationPayload,
} from './authority-attestation.ts';
import { loadWorkflowConfig } from './contracts.ts';
import { ExitCode, workflowError } from './errors.ts';
import { commitFacts } from './git-transitions.ts';
import {
  discoverRepository,
  protectedBranchRef,
  runGit,
  runGitWithEnvironment,
} from './git.ts';
import {
  canonicalGrantPayload,
  parseMaintainerGrantEnvelope,
  validateGrantPayload,
  type MaintainerGrantEnvelope,
} from './maintainer-grant.ts';
import {
  parseMaintainerPolicy,
  type MaintainerPolicy,
} from './maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from './maintainer-signer.ts';

export const AUTHORITY_ATTESTATION_SIGNATURE_NAMESPACE =
  'expense-app.workflow.authority-attestation.v1';

const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAINTAINER_POLICY_PATH = 'workflow/maintainer-policy.json';

export type AuthorityAttestationRequest = {
  originalCommit: string;
  mainCommit: string;
  grantBasePairs: Array<{ originalBase: string; mainBase: string }>;
};

export type AuthorityAttestationIssueOptions = {
  now?: Date;
  signer?: MaintainerSignerProvider;
};

export type AuthorityAttestationIssueResult = {
  grantId: string;
  tagRef: string;
  publishCommand: string;
  envelope: AuthorityAttestationEnvelope;
};

export function issueAuthorityAttestation(
  cwd: string,
  request: AuthorityAttestationRequest,
  options: AuthorityAttestationIssueOptions = {},
): AuthorityAttestationIssueResult {
  const repository = discoverRepository(cwd);
  if (repository.statusEntries.length > 0) {
    throw workflowError(
      'AUTHORITY_ATTESTATION_DIRTY_WORKTREE',
      'Authority attestations can be issued only from a clean worktree.',
      ExitCode.conflict,
    );
  }
  const repositoryRoot = repository.repositoryRoot;
  const policy = loadHeadPolicy(repositoryRoot);
  const origin = runGit(repositoryRoot, ['remote', 'get-url', 'origin']).trim();
  if (origin !== policy.repository.origin) {
    throw workflowError(
      'MAINTAINER_REPOSITORY_MISMATCH',
      'The repository origin does not match the trusted maintainer policy.',
      ExitCode.guard,
    );
  }
  assertRequestShape(request);

  const config = loadWorkflowConfig(repositoryRoot);
  const protectedBranch = config.protectedBranches[0];
  if (!protectedBranch) {
    throw invalidRequest('No protected branch is configured.');
  }
  const protectedRef = protectedBranchRef(protectedBranch);
  if (
    !runGit(
      repositoryRoot,
      ['rev-parse', '--verify', protectedRef],
      true,
    ).trim()
  ) {
    throw mainUnreachable(protectedRef);
  }

  const original = attestedFacts(repositoryRoot, request.originalCommit);
  const main = attestedFacts(repositoryRoot, request.mainCommit);
  const identity = validateAuthorityTransitionIdentity(original, main);
  assertMainContained(repositoryRoot, protectedRef, main.oid);
  assertOriginalCommitSignature(repositoryRoot, policy, original.oid);

  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) {
    throw invalidRequest('Authority attestation issue time is invalid.');
  }
  const signer =
    options.signer ?? createInteractiveSshSigner(repositoryRoot, policy);
  signer.assertHumanPresent();

  const primaryEnvelope = readGrantEnvelope(
    repositoryRoot,
    policy,
    identity.grantId,
  );
  if (
    primaryEnvelope.payload.changeId !== identity.changeId ||
    primaryEnvelope.payload.baseCommit !== original.parentOids[0]
  ) {
    throw grantInvalid(identity.grantId);
  }
  validateBoundGrant(repositoryRoot, policy, primaryEnvelope, now, signer);

  const grantBases = request.grantBasePairs
    .map((pair) =>
      resolveGrantBaseMapping(repositoryRoot, policy, pair, now, signer, {
        protectedRef,
      }),
    )
    .sort((left, right) => (left.originalBase < right.originalBase ? -1 : 1));

  const payload: AuthorityAttestationPayload = {
    version: 1,
    grantId: identity.grantId,
    repositoryId: policy.repository.id,
    repositoryOrigin: policy.repository.origin,
    protectedBranch,
    originalCommit: original.oid,
    mainCommit: main.oid,
    grantBases,
    policyBlob: runGit(repositoryRoot, [
      'rev-parse',
      `HEAD:${MAINTAINER_POLICY_PATH}`,
    ]).trim(),
    issuedAt: now.toISOString(),
    signer: signer.identity(),
  };
  assertAuthorityAttestationPayload(payload);

  const tagRef = authorityAttestationTagRef(payload.grantId);
  if (runGit(repositoryRoot, ['rev-parse', '--verify', tagRef], true).trim()) {
    throw workflowError(
      'AUTHORITY_ATTESTATION_EXISTS',
      `Authority attestation ${payload.grantId} already has a local tag.`,
      ExitCode.conflict,
    );
  }

  const canonicalPayload = canonicalAttestationPayload(payload);
  const signature = signer.sign(
    canonicalPayload,
    AUTHORITY_ATTESTATION_SIGNATURE_NAMESPACE,
  );
  signer.verify(
    canonicalPayload,
    signature,
    payload.signer,
    AUTHORITY_ATTESTATION_SIGNATURE_NAMESPACE,
  );
  const envelope: AuthorityAttestationEnvelope = { payload, signature };
  const canonicalEnvelope = canonicalAttestationEnvelope(envelope);

  createAttestationTag(
    repositoryRoot,
    original.oid,
    tagRef,
    canonicalEnvelope,
    payload.signer,
  );

  return {
    grantId: payload.grantId,
    tagRef,
    publishCommand: `git push origin ${tagRef}:${tagRef}`,
    envelope,
  };
}

function resolveGrantBaseMapping(
  repositoryRoot: string,
  policy: MaintainerPolicy,
  pair: { originalBase: string; mainBase: string },
  now: Date,
  signer: MaintainerSignerProvider,
  options: { protectedRef: string },
): AttestationGrantBaseMapping {
  const original = attestedFacts(repositoryRoot, pair.originalBase);
  const main = attestedFacts(repositoryRoot, pair.mainBase);
  validateAttestedTransitionPair(original, main);
  assertMainContained(repositoryRoot, options.protectedRef, main.oid);

  const grantIds = listGrantTagIds(repositoryRoot, policy)
    .filter((grantId) => {
      const envelope = readGrantEnvelope(repositoryRoot, policy, grantId);
      return envelope.payload.baseCommit === original.oid;
    })
    .sort();
  if (grantIds.length === 0) {
    throw grantMissing(pair.originalBase);
  }
  for (const grantId of grantIds) {
    validateBoundGrant(
      repositoryRoot,
      policy,
      readGrantEnvelope(repositoryRoot, policy, grantId),
      now,
      signer,
    );
  }
  return {
    originalBase: original.oid,
    mainBase: main.oid,
    grantIds,
  };
}

function validateBoundGrant(
  repositoryRoot: string,
  policy: MaintainerPolicy,
  envelope: MaintainerGrantEnvelope,
  now: Date,
  signer: MaintainerSignerProvider,
): void {
  const baseCommit = envelope.payload.baseCommit;
  validateGrantPayload(envelope.payload, policy, {
    now,
    expectedBase: baseCommit,
    expectedPolicyBlob: runGit(repositoryRoot, [
      'rev-parse',
      `${baseCommit}:${MAINTAINER_POLICY_PATH}`,
    ]).trim(),
    allowExpired: true,
  });
  signer.verify(
    canonicalGrantPayload(envelope.payload),
    envelope.signature,
    envelope.payload.signer,
  );
}

function readGrantEnvelope(
  repositoryRoot: string,
  policy: MaintainerPolicy,
  grantId: string,
): MaintainerGrantEnvelope {
  const tagRef = `${policy.auditTagPrefix}${grantId}`;
  if (!runGit(repositoryRoot, ['rev-parse', '--verify', tagRef], true).trim()) {
    throw grantMissing(grantId);
  }
  if (runGit(repositoryRoot, ['cat-file', '-t', tagRef]).trim() !== 'tag') {
    throw grantInvalid(grantId);
  }
  const raw = runGit(repositoryRoot, ['cat-file', 'tag', tagRef]);
  const boundary = raw.indexOf('\n\n');
  if (boundary === -1) {
    throw grantInvalid(grantId);
  }
  const envelope = parseMaintainerGrantEnvelope(raw.slice(boundary + 2));
  const target = runGit(repositoryRoot, [
    'rev-parse',
    `${tagRef}^{commit}`,
  ]).trim();
  if (
    envelope.payload.grantId !== grantId ||
    envelope.payload.baseCommit !== target
  ) {
    throw grantInvalid(grantId);
  }
  return envelope;
}

function listGrantTagIds(
  repositoryRoot: string,
  policy: MaintainerPolicy,
): string[] {
  const prefix = policy.auditTagPrefix;
  return runGit(repositoryRoot, [
    'for-each-ref',
    '--format=%(refname)',
    prefix.endsWith('/') ? prefix.slice(0, -1) : prefix,
  ])
    .split('\n')
    .filter(Boolean)
    .map((ref) => ref.slice(prefix.length));
}

function attestedFacts(
  repositoryRoot: string,
  commitOid: string,
): AttestedCommitFacts {
  if (!COMMIT_OID.test(commitOid)) {
    throw invalidRequest(
      'Authority attestation requests need full commit object IDs.',
    );
  }
  const facts = commitFacts(repositoryRoot, commitOid);
  const parentTree =
    facts.parents.length === 1
      ? runGit(repositoryRoot, [
          'rev-parse',
          `${facts.parents[0]}^{tree}`,
        ]).trim()
      : undefined;
  return {
    oid: facts.hash,
    tree: facts.tree,
    parentOids: facts.parents,
    parentTree,
    message: facts.message,
  };
}

function assertMainContained(
  repositoryRoot: string,
  protectedRef: string,
  commitOid: string,
): void {
  try {
    runGit(repositoryRoot, [
      'merge-base',
      '--is-ancestor',
      commitOid,
      protectedRef,
    ]);
  } catch {
    throw mainUnreachable(commitOid);
  }
}

function assertOriginalCommitSignature(
  repositoryRoot: string,
  policy: MaintainerPolicy,
  commitOid: string,
): void {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-attest-signers-'),
  );
  fs.chmodSync(temporaryDirectory, 0o700);
  const allowedSignersPath = path.join(temporaryDirectory, 'allowed-signers');
  try {
    fs.writeFileSync(
      allowedSignersPath,
      policy.trustedSigners
        .map(
          (signer) =>
            `${signer.identity} namespaces="git" ${signer.publicKey}\n`,
        )
        .join(''),
      { encoding: 'utf8', mode: 0o600 },
    );
    runGit(repositoryRoot, [
      '-c',
      `gpg.ssh.allowedSignersFile=${allowedSignersPath}`,
      'verify-commit',
      commitOid,
    ]);
  } catch {
    throw workflowError(
      'AUTHORITY_ATTESTATION_SIGNATURE_INVALID',
      'The original authority commit is not signed by a trusted maintainer key.',
      ExitCode.verification,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function createAttestationTag(
  repositoryRoot: string,
  targetCommit: string,
  tagRef: string,
  message: string,
  signerIdentity: string,
): void {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-attestation-tag-'),
  );
  fs.chmodSync(temporaryDirectory, 0o700);
  const messagePath = path.join(temporaryDirectory, 'message');
  try {
    fs.writeFileSync(messagePath, message, { encoding: 'utf8', mode: 0o600 });
    runGitWithEnvironment(
      repositoryRoot,
      [
        'tag',
        '--annotate',
        '--cleanup=verbatim',
        '--file',
        messagePath,
        tagRef.slice('refs/tags/'.length),
        targetCommit,
      ],
      {
        GIT_COMMITTER_NAME: signerIdentity,
        GIT_COMMITTER_EMAIL: 'workflow-maintainer@users.noreply.github.com',
      },
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function loadHeadPolicy(repositoryRoot: string): MaintainerPolicy {
  try {
    return parseMaintainerPolicy(
      JSON.parse(
        runGit(repositoryRoot, ['show', `HEAD:${MAINTAINER_POLICY_PATH}`]),
      ),
    );
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      throw error;
    }
    throw workflowError(
      'MAINTAINER_POLICY_INVALID',
      'The repository head does not contain a valid maintainer policy.',
      ExitCode.guard,
    );
  }
}

function assertRequestShape(request: AuthorityAttestationRequest): void {
  if (
    typeof request !== 'object' ||
    request === null ||
    !COMMIT_OID.test(request.originalCommit) ||
    !COMMIT_OID.test(request.mainCommit) ||
    !Array.isArray(request.grantBasePairs) ||
    request.grantBasePairs.some(
      (pair) =>
        typeof pair !== 'object' ||
        pair === null ||
        !COMMIT_OID.test(pair.originalBase) ||
        !COMMIT_OID.test(pair.mainBase),
    )
  ) {
    throw invalidRequest(
      'Authority attestation requests need full commit object IDs.',
    );
  }
}

function invalidRequest(message: string) {
  return workflowError(
    'AUTHORITY_ATTESTATION_INVALID',
    message,
    ExitCode.guard,
  );
}

function grantMissing(identity: string) {
  return workflowError(
    'AUTHORITY_ATTESTATION_GRANT_MISSING',
    `No protected maintainer grant is bound to ${identity}.`,
    ExitCode.guard,
  );
}

function grantInvalid(grantId: string) {
  return workflowError(
    'AUTHORITY_ATTESTATION_GRANT_INVALID',
    `Maintainer grant ${grantId} does not match its attested binding.`,
    ExitCode.guard,
  );
}

function mainUnreachable(identity: string) {
  return workflowError(
    'AUTHORITY_ATTESTATION_MAIN_UNREACHABLE',
    `${identity} is not contained in the fetched protected branch.`,
    ExitCode.verification,
  );
}
