import crypto from 'node:crypto';

import {
  AUTHORITY_ATTESTATION_TAG_PREFIX,
  canonicalAttestationEnvelope,
  canonicalAttestationPayload,
  parseAuthorityAttestationEnvelope,
  validateAttestedTransitionPair,
  validateAuthorityTransitionIdentity,
  type AttestedCommitFacts,
  type AuthorityAttestationEnvelope,
} from '../../modules/authority/authority-attestation.ts';
import { authorityApplicationReceiptTagPrefix } from '../../modules/authority/authority-application-receipt.ts';
import { validateCiAuthorityCommit } from './ci-authority.ts';
import { readFileAtCommit, type RangeCommit } from './ci-git.ts';
import {
  verifySshDataSignature,
  verifyTrustedCommitSignature,
} from '../../adapters/signing/ssh/ci-signature.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import { commitFacts } from '../../runtime/repository-transaction/git-transitions.ts';
import { runGit } from '../../runtime/repository-transaction/git.ts';
import {
  HUMAN_RESOLUTION_SIGNATURE_NAMESPACE,
  canonicalHumanResolutionGrantPayload,
  canonicalGrantEnvelope,
  canonicalGrantPayload,
  parseMaintainerGrantEnvelope,
  readHistoricalHumanResolutionAuditTagReadOnly,
  validateGrantPayload,
  type MaintainerGrantEnvelope,
} from '../../modules/authority/maintainer-grant.ts';
import {
  MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
  canonicalMaintainerGrantV2Payload,
  parseMaintainerGrantV2Envelope,
  type MaintainerGrantV2Envelope,
} from '../../modules/authority/maintainer-grant-v2.ts';
import {
  parseMaintainerPolicy,
  type MaintainerPolicy,
  type TrustedMaintainerSigner,
} from '../../modules/authority/maintainer-policy.ts';
import { AUTHORITY_ATTESTATION_SIGNATURE_NAMESPACE } from '../../application/control-plane/maintainer-attestation.ts';
import {
  ManagedTrailerSyntaxError,
  parseManagedTrailers,
  type AuthorityCandidateManagedTrailers,
  type AuthorityManagedTrailers,
} from '../../modules/lifecycle/managed-trailers.ts';

const MAINTAINER_POLICY_PATH = 'workflow/maintainer-policy.json';
const WORKFLOW_CONFIG_PATH = 'workflow/config.json';

export type AttestedAuthority = {
  grantId: string;
  changeId: string;
  originalCommit: string;
  mainCommit: string;
};

export type DirectAuthority = {
  grantId: string;
  changeId: string;
  commit: string;
};

export type CiAttestationResult = {
  attestedAuthorities: AttestedAuthority[];
  directAuthorities: DirectAuthority[];
};

type GrantTagRecord = {
  grantId: string;
  target: string;
  envelope: MaintainerGrantEnvelope | MaintainerGrantV2Envelope;
};

export function verifyBaseAuthorityAttestations(
  repositoryRoot: string,
  base: string,
  evaluatedAt: Date = new Date(),
): CiAttestationResult {
  const firstParentHashes = runGit(repositoryRoot, [
    'rev-list',
    '--first-parent',
    base,
  ])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const firstParentSet = new Set(firstParentHashes);

  const authorityCommits: Array<
    RangeCommit & {
      trailers: AuthorityManagedTrailers | AuthorityCandidateManagedTrailers;
    }
  > = [];
  for (const hash of firstParentHashes) {
    try {
      const facts = commitFacts(repositoryRoot, hash);
      const trailers = parseManagedTrailers(facts.message);
      if (
        trailers?.kind === 'authority' ||
        trailers?.kind === 'authority-candidate'
      ) {
        authorityCommits.push({
          hash: facts.hash,
          subject: facts.message.split('\n', 1)[0],
          parents: facts.parents,
          trailers,
        });
      }
    } catch (error) {
      if (error instanceof ManagedTrailerSyntaxError) continue;
      throw error;
    }
  }
  if (authorityCommits.length === 0) {
    return { attestedAuthorities: [], directAuthorities: [] };
  }

  const policy = loadBasePolicy(repositoryRoot, base);
  const protectedBranches = loadProtectedBranches(repositoryRoot, base);
  const grantTags = listGrantTags(repositoryRoot, policy);
  const attestationRefs = new Set(
    runGit(repositoryRoot, [
      'for-each-ref',
      '--format=%(refname)',
      AUTHORITY_ATTESTATION_TAG_PREFIX,
    ])
      .split('\n')
      .filter(Boolean),
  );
  const usedOriginals = new Set<string>();
  const usedMains = new Set<string>();
  const baseMappings = new Map<string, string>();
  const attested: AttestedAuthority[] = [];
  const direct: DirectAuthority[] = [];

  for (const commit of authorityCommits.reverse()) {
    let attestationGrantId: string;
    let envelope: AuthorityAttestationEnvelope;
    if (commit.trailers.kind === 'authority-candidate') {
      try {
        const validated = validateCiAuthorityCommit(
          repositoryRoot,
          commit,
          evaluatedAt,
        );
        direct.push({
          grantId: validated.grantId,
          changeId: validated.changeId,
          commit: commit.hash,
        });
        continue;
      } catch (directError) {
        const candidates = [...attestationRefs]
          .map((ref) =>
            readAttestationEnvelope(
              repositoryRoot,
              ref.slice(AUTHORITY_ATTESTATION_TAG_PREFIX.length),
            ),
          )
          .filter(({ payload }) => payload.mainCommit === commit.hash);
        if (candidates.length === 0 && directError instanceof WorkflowError) {
          throw directError;
        }
        if (candidates.length !== 1) {
          throw attestationError(
            'CI_ATTESTATION_MISSING',
            'A rewritten v2 authority candidate requires one exact protected attestation.',
            {
              commit: commit.hash,
              directValidationCode:
                directError instanceof WorkflowError
                  ? directError.code
                  : 'UNKNOWN',
            },
          );
        }
        envelope = candidates[0];
        attestationGrantId = envelope.payload.grantId;
      }
    } else {
      attestationGrantId = commit.trailers.grantId;
      const attestationRef = `${AUTHORITY_ATTESTATION_TAG_PREFIX}${attestationGrantId}`;
      if (!attestationRefs.has(attestationRef)) {
        try {
          const validated = validateCiAuthorityCommit(
            repositoryRoot,
            commit,
            evaluatedAt,
          );
          direct.push({
            grantId: validated.grantId,
            changeId: validated.changeId,
            commit: commit.hash,
          });
        } catch (error) {
          if (error instanceof WorkflowError) {
            throw attestationError(
              'CI_ATTESTATION_MISSING',
              `Protected-main authority commit has no attestation tag for ${attestationGrantId} and is not directly replayable.`,
              { directValidationCode: error.code },
            );
          }
          throw error;
        }
        continue;
      }
      envelope = readAttestationEnvelope(repositoryRoot, attestationGrantId);
    }
    const payload = envelope.payload;
    if (
      payload.grantId !== attestationGrantId ||
      payload.mainCommit !== commit.hash ||
      payload.repositoryId !== policy.repository.id ||
      payload.repositoryOrigin !== policy.repository.origin ||
      !protectedBranches.includes(payload.protectedBranch)
    ) {
      throw attestationError(
        'CI_ATTESTATION_MAPPING_INVALID',
        'The protected attestation does not bind this authority commit.',
        { commit: commit.hash, grantId: attestationGrantId },
      );
    }
    const attestationSigner = trustedSigner(policy, payload.signer);
    verifySshDataSignature(
      canonicalAttestationPayload(payload),
      envelope.signature,
      attestationSigner,
      AUTHORITY_ATTESTATION_SIGNATURE_NAMESPACE,
      'CI_ATTESTATION_SIGNATURE_INVALID',
    );

    const original = attestedFacts(repositoryRoot, payload.originalCommit);
    const main = attestedFacts(repositoryRoot, payload.mainCommit);
    const transitionTrailers = wrapMapping(commit.hash, () =>
      validateAttestedTransitionPair(original, main),
    );
    let identity: { grantId: string; changeId: string };
    if (commit.trailers.kind === 'authority-candidate') {
      if (transitionTrailers.kind !== 'authority-candidate') {
        throw attestationError(
          'CI_ATTESTATION_MAPPING_INVALID',
          'The attested transition does not preserve authority-candidate trailers.',
          { commit: commit.hash },
        );
      }
      identity = validateCiAuthorityCommit(
        repositoryRoot,
        {
          hash: original.oid,
          subject: original.message.split('\n', 1)[0],
          parents: [...original.parentOids],
          trailers: transitionTrailers,
        },
        evaluatedAt,
      );
    } else {
      identity = wrapMapping(commit.hash, () =>
        validateAuthorityTransitionIdentity(original, main),
      );
    }
    if (
      identity.grantId !== payload.grantId ||
      identity.changeId !== commit.trailers.changeId
    ) {
      throw attestationError(
        'CI_ATTESTATION_MAPPING_INVALID',
        'The attested transition identity does not match its trailers.',
        { commit: commit.hash },
      );
    }

    const primaryGrant = grantTags.get(payload.grantId);
    if (!primaryGrant) {
      throw attestationError(
        'CI_ATTESTATION_GRANT_MISSING',
        `No protected maintainer grant tag exists for ${payload.grantId}.`,
      );
    }
    if (
      primaryGrant.envelope.payload.changeId !== identity.changeId ||
      primaryGrant.envelope.payload.baseCommit !== original.parentOids[0]
    ) {
      throw attestationError(
        'CI_ATTESTATION_GRANT_INVALID',
        'The primary grant does not bind the attested original commit.',
        { grantId: payload.grantId },
      );
    }
    validateHistoricalGrant(repositoryRoot, policy, primaryGrant, evaluatedAt);
    if (primaryGrant.envelope.payload.version === 1) {
      assertCommitInsideGrantLifetime(
        repositoryRoot,
        original.oid,
        primaryGrant.envelope,
      );
    }
    verifyTrustedCommitSignature(
      repositoryRoot,
      original.oid,
      trustedSigner(policy, primaryGrant.envelope.payload.signer),
      'CI_ATTESTATION_ORIGINAL_SIGNATURE_INVALID',
    );

    for (const mapping of payload.grantBases) {
      const mappingOriginal = attestedFacts(
        repositoryRoot,
        mapping.originalBase,
      );
      const mappingMain = attestedFacts(repositoryRoot, mapping.mainBase);
      wrapMapping(commit.hash, () =>
        validateAttestedTransitionPair(mappingOriginal, mappingMain),
      );
      if (!firstParentSet.has(mapping.mainBase)) {
        throw attestationError(
          'CI_ATTESTATION_MAIN_UNREACHABLE',
          'A mapped grant base is not on protected first-parent history.',
          { mainBase: mapping.mainBase },
        );
      }
      const bound = [...grantTags.values()]
        .filter(
          (record) =>
            record.envelope.payload.baseCommit === mapping.originalBase,
        )
        .map((record) => record.grantId)
        .sort();
      if (JSON.stringify(bound) !== JSON.stringify(mapping.grantIds)) {
        throw attestationError(
          'CI_ATTESTATION_GRANT_BASES_INCOMPLETE',
          'The attested grant-base mapping omits or invents bound grants.',
          {
            originalBase: mapping.originalBase,
            bound,
            mapped: mapping.grantIds,
          },
        );
      }
      for (const grantId of mapping.grantIds) {
        const record = grantTags.get(grantId);
        if (!record || record.target !== mapping.originalBase) {
          throw attestationError(
            'CI_ATTESTATION_GRANT_INVALID',
            'A mapped grant tag does not target its original base.',
            { grantId },
          );
        }
        validateHistoricalGrant(repositoryRoot, policy, record, evaluatedAt);
      }
      const existing = baseMappings.get(mapping.originalBase);
      if (
        (existing !== undefined && existing !== mapping.mainBase) ||
        [...baseMappings.entries()].some(
          ([originalBase, mainBase]) =>
            mainBase === mapping.mainBase &&
            originalBase !== mapping.originalBase,
        )
      ) {
        throw attestationError(
          'CI_ATTESTATION_MAPPING_CONFLICT',
          'Conflicting grant-base mappings were attested.',
          { originalBase: mapping.originalBase },
        );
      }
      baseMappings.set(mapping.originalBase, mapping.mainBase);
    }

    if (usedOriginals.has(original.oid) || usedMains.has(main.oid)) {
      throw attestationError(
        'CI_ATTESTATION_MAPPING_CONFLICT',
        'An original or protected-main commit participates in two mappings.',
        { originalCommit: original.oid, mainCommit: main.oid },
      );
    }
    usedOriginals.add(original.oid);
    usedMains.add(main.oid);
    attested.push({
      grantId: payload.grantId,
      changeId: identity.changeId,
      originalCommit: original.oid,
      mainCommit: main.oid,
    });
  }

  return {
    attestedAuthorities: attested.sort((left, right) =>
      left.grantId.localeCompare(right.grantId),
    ),
    directAuthorities: direct.sort((left, right) =>
      left.grantId.localeCompare(right.grantId),
    ),
  };
}

function readAttestationEnvelope(
  repositoryRoot: string,
  grantId: string,
): AuthorityAttestationEnvelope {
  const tagRef = `${AUTHORITY_ATTESTATION_TAG_PREFIX}${grantId}`;
  let raw: string;
  try {
    raw = runGit(repositoryRoot, ['cat-file', 'tag', tagRef]);
  } catch {
    throw invalidAttestationTag(grantId);
  }
  const separator = raw.indexOf('\n\n');
  if (separator === -1) {
    throw invalidAttestationTag(grantId);
  }
  const headers = raw.slice(0, separator).split('\n');
  const objectHeaders = headers.filter((line) => line.startsWith('object '));
  const typeHeaders = headers.filter((line) => line.startsWith('type '));
  const tagHeaders = headers.filter((line) => line.startsWith('tag '));
  const envelope = (() => {
    try {
      return parseAuthorityAttestationEnvelope(raw.slice(separator + 2));
    } catch {
      throw invalidAttestationTag(grantId);
    }
  })();
  if (
    objectHeaders.length !== 1 ||
    objectHeaders[0] !== `object ${envelope.payload.originalCommit}` ||
    typeHeaders.length !== 1 ||
    typeHeaders[0] !== 'type commit' ||
    tagHeaders.length !== 1 ||
    tagHeaders[0] !== `tag ${tagRef.slice('refs/tags/'.length)}` ||
    canonicalAttestationEnvelope(envelope) !== raw.slice(separator + 2)
  ) {
    throw invalidAttestationTag(grantId);
  }
  return envelope;
}

function validateHistoricalGrant(
  repositoryRoot: string,
  policy: MaintainerPolicy,
  record: GrantTagRecord,
  evaluatedAt: Date,
): void {
  const baseCommit = record.envelope.payload.baseCommit;
  const policyBlob = runGit(
    repositoryRoot,
    ['rev-parse', `${baseCommit}:${MAINTAINER_POLICY_PATH}`],
    true,
  ).trim();
  if (!policyBlob) {
    throw attestationError(
      'CI_ATTESTATION_GRANT_INVALID',
      'A mapped grant base does not carry a maintainer policy.',
      { grantId: record.grantId },
    );
  }
  if (record.envelope.payload.version === 2) {
    const policyContent = runGit(repositoryRoot, [
      'show',
      `${baseCommit}:${MAINTAINER_POLICY_PATH}`,
    ]);
    if (
      record.envelope.payload.policyBlob !== policyBlob ||
      record.envelope.payload.policyDigest !==
        crypto.createHash('sha256').update(policyContent).digest('hex') ||
      record.envelope.payload.repositoryId !== policy.repository.id ||
      record.envelope.payload.repositoryOrigin !== policy.repository.origin
    ) {
      throw attestationError(
        'CI_ATTESTATION_GRANT_INVALID',
        'A mapped v2 grant envelope fails validation under base policy.',
        { grantId: record.grantId },
      );
    }
    verifySshDataSignature(
      canonicalMaintainerGrantV2Payload(record.envelope.payload),
      record.envelope.signature,
      trustedSigner(policy, record.envelope.payload.signer),
      MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
      'CI_ATTESTATION_GRANT_SIGNATURE_INVALID',
    );
    return;
  }
  try {
    validateGrantPayload(record.envelope.payload, policy, {
      now: evaluatedAt,
      expectedBase: baseCommit,
      expectedPolicyBlob: policyBlob,
      allowExpired: true,
    });
  } catch {
    throw attestationError(
      'CI_ATTESTATION_GRANT_INVALID',
      'A mapped grant envelope fails validation under base policy.',
      { grantId: record.grantId },
    );
  }
  verifySshDataSignature(
    canonicalGrantPayload(record.envelope.payload),
    record.envelope.signature,
    trustedSigner(policy, record.envelope.payload.signer),
    policy.signatureNamespace,
    'CI_ATTESTATION_GRANT_SIGNATURE_INVALID',
  );
}

function assertCommitInsideGrantLifetime(
  repositoryRoot: string,
  commitHash: string,
  envelope: MaintainerGrantEnvelope | MaintainerGrantV2Envelope,
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
    throw attestationError(
      'CI_ATTESTATION_GRANT_TIME_INVALID',
      'The original authority commit is outside its signed grant lifetime.',
    );
  }
}

function listGrantTags(
  repositoryRoot: string,
  policy: MaintainerPolicy,
): Map<string, GrantTagRecord> {
  const prefix = policy.auditTagPrefix;
  const refs = runGit(repositoryRoot, [
    'for-each-ref',
    '--format=%(refname)',
    prefix.endsWith('/') ? prefix.slice(0, -1) : prefix,
  ])
    .split('\n')
    .filter(Boolean);
  const records = new Map<string, GrantTagRecord>();
  for (const ref of refs) {
    if (ref.startsWith(authorityApplicationReceiptTagPrefix(policy))) {
      continue;
    }
    const grantId = ref.slice(prefix.length);
    try {
      const resolution = readHistoricalHumanResolutionAuditTagReadOnly(
        repositoryRoot,
        policy,
        ref,
      );
      if (resolution !== null) {
        verifySshDataSignature(
          canonicalHumanResolutionGrantPayload(resolution.payload),
          resolution.signature,
          trustedSigner(policy, resolution.payload.signer),
          HUMAN_RESOLUTION_SIGNATURE_NAMESPACE,
          'CI_ATTESTATION_GRANT_INVALID',
        );
        continue;
      }
    } catch {
      throw invalidGrantTag(grantId);
    }
    let raw: string;
    try {
      raw = runGit(repositoryRoot, ['cat-file', 'tag', ref]);
    } catch {
      throw invalidGrantTag(grantId);
    }
    const separator = raw.indexOf('\n\n');
    if (separator === -1) {
      throw invalidGrantTag(grantId);
    }
    let envelope: MaintainerGrantEnvelope;
    try {
      envelope = parseMaintainerGrantEnvelope(raw.slice(separator + 2));
    } catch {
      try {
        const v2 = parseMaintainerGrantV2Envelope(raw.slice(separator + 2));
        const target = runGit(repositoryRoot, [
          'rev-parse',
          `${ref}^{commit}`,
        ]).trim();
        if (
          v2.payload.grantId !== grantId ||
          target !== v2.payload.baseCommit
        ) {
          throw new Error('v2 grant binding differs');
        }
        verifySshDataSignature(
          canonicalMaintainerGrantV2Payload(v2.payload),
          v2.signature,
          trustedSigner(policy, v2.payload.signer),
          MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
          'CI_ATTESTATION_GRANT_INVALID',
        );
        records.set(grantId, { grantId, target, envelope: v2 });
        continue;
      } catch {
        throw invalidGrantTag(grantId);
      }
    }
    if (
      envelope.payload.grantId !== grantId ||
      canonicalGrantEnvelope(envelope) !== raw.slice(separator + 2)
    ) {
      throw invalidGrantTag(grantId);
    }
    const target = runGit(repositoryRoot, [
      'rev-parse',
      `${ref}^{commit}`,
    ]).trim();
    if (target !== envelope.payload.baseCommit) {
      throw invalidGrantTag(grantId);
    }
    records.set(grantId, { grantId, target, envelope });
  }
  return records;
}

function attestedFacts(
  repositoryRoot: string,
  commitOid: string,
): AttestedCommitFacts {
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

function wrapMapping<T>(commitHash: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof WorkflowError) {
      throw attestationError(
        'CI_ATTESTATION_MAPPING_INVALID',
        'An attested transition mapping failed identity validation.',
        { commit: commitHash, cause: error.message },
      );
    }
    throw error;
  }
}

function loadBasePolicy(
  repositoryRoot: string,
  base: string,
): MaintainerPolicy {
  const content = readFileAtCommit(
    repositoryRoot,
    base,
    MAINTAINER_POLICY_PATH,
  );
  if (content === undefined) {
    throw attestationError(
      'CI_ATTESTATION_POLICY_MISSING',
      'Protected history contains authority transitions without a base maintainer policy.',
    );
  }
  try {
    return parseMaintainerPolicy(JSON.parse(content));
  } catch {
    throw attestationError(
      'CI_ATTESTATION_POLICY_MISSING',
      'The base maintainer policy is invalid.',
    );
  }
}

function loadProtectedBranches(repositoryRoot: string, base: string): string[] {
  const content = readFileAtCommit(repositoryRoot, base, WORKFLOW_CONFIG_PATH);
  if (content !== undefined) {
    try {
      const parsed = JSON.parse(content) as { protectedBranches?: unknown };
      if (
        Array.isArray(parsed.protectedBranches) &&
        parsed.protectedBranches.every((value) => typeof value === 'string')
      ) {
        return parsed.protectedBranches;
      }
    } catch {
      // fall through to the fail-closed error below
    }
  }
  throw attestationError(
    'CI_ATTESTATION_POLICY_MISSING',
    'The base workflow config does not declare protected branches.',
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
    throw attestationError(
      'CI_ATTESTATION_SIGNER_UNTRUSTED',
      'An attestation or grant signer is absent from the base trusted lineage.',
      { identity },
    );
  }
  return signer;
}

function invalidAttestationTag(grantId: string) {
  return attestationError(
    'CI_ATTESTATION_TAG_INVALID',
    `Attestation tag for ${grantId} is malformed or noncanonical.`,
  );
}

function invalidGrantTag(grantId: string) {
  return attestationError(
    'CI_ATTESTATION_GRANT_INVALID',
    `Protected grant tag ${grantId} is malformed or noncanonical.`,
  );
}

function attestationError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return workflowError(code, message, ExitCode.verification, { details });
}
