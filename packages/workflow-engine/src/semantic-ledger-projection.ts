import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import type { EvidenceNode } from './evidence-node.ts';
import { ExitCode, workflowError } from './errors.ts';
import { readInvestigationWhyNode } from './investigation-why.ts';
import {
  createLedgerEntry,
  type LedgerEntry,
  type LedgerEntryInput,
} from './semantic-ledger.ts';
import {
  readLedgerEntry,
  readLedgerIndex,
  updateLedgerIndex,
  writeLedgerEntry,
  type LedgerIndex,
} from './semantic-ledger-store.ts';

/**
 * Pure projection primitive for completed, engine-validated full-blob WHY
 * evidence. It is intentionally not mounted on propose/status: production
 * promotion belongs after exact implementation reconciliation and remains
 * blocked until that lifecycle owns the required typed mutation evidence.
 * This records only a planning-time claim, never an implementation result; no
 * mutation disposition or post-implementation assurance is inferred from the
 * author's prose.
 */
export function projectInvestigationWhyToLedger(input: {
  repositoryRoot: string;
  changeId: string;
  baselineCommit: string;
  whyNodes: readonly EvidenceNode[];
  policyDigest: string;
}): Readonly<{ entries: readonly LedgerEntry[]; index: LedgerIndex }> {
  const priorIndex = readLedgerIndex(input.repositoryRoot);
  const seenPaths = new Set<string>();
  const entries = [...input.whyNodes]
    .map((node) => ({ node, why: readInvestigationWhyNode(node) }))
    .sort((left, right) => {
      const leftPath = left.why.path.utf8 ?? left.why.path.rawBase64;
      const rightPath = right.why.path.utf8 ?? right.why.path.rawBase64;
      return leftPath.localeCompare(rightPath);
    })
    .map(({ node, why }) => {
      const subjectPath = why.path.utf8;
      if (subjectPath === null) {
        throw projectionInvalid(
          'A semantic ledger subject requires a canonical UTF-8 repository path.',
        );
      }
      if (seenPaths.has(subjectPath)) {
        throw projectionInvalid(
          `Semantic ledger projection received duplicate WHY claims for ${subjectPath}.`,
        );
      }
      seenPaths.add(subjectPath);
      const subjectId = fileSubjectId(subjectPath);
      const currentId = priorIndex.subjects[subjectId]?.currentEntryId;
      const current =
        currentId === undefined
          ? null
          : readLedgerEntry(input.repositoryRoot, currentId);
      const entryInput: LedgerEntryInput = {
        schemaVersion: 1,
        kind: 'semantic-ledger-entry',
        subject: { subjectId, kind: 'file', path: subjectPath },
        binding: {
          baselineCommit: input.baselineCommit,
          blobDigest: prefixedDigest(why.blob.contentSha256),
          sourceDigest: prefixedDigest(why.blob.contentSha256),
          semanticDigest: semanticClaimDigest(why),
          extractorVersion: 'investigation-why-file-claim.v1',
        },
        why: {
          responsibility: why.why,
          protectedInvariants: [why.protectedInvariant],
          // The investigation schema has no typed failure-mode or semantic
          // dependency field. Empty is honest; inferring either from prose
          // would turn an actor claim into an engine result.
          failureModes: [],
          reviewerQuestions: [why.reviewerQuestion],
        },
        semanticDependencies: [],
        policyDigest: prefixedDigest(input.policyDigest),
        provenance: {
          changeId: input.changeId,
          createdAtCommit: input.baselineCommit,
        },
        supersedes: current?.entryId ?? null,
        status: 'current',
      };
      if (current !== null && sameClaim(current, entryInput)) {
        return current;
      }
      return createLedgerEntry(entryInput);
    });

  for (const entry of entries) {
    writeLedgerEntry(input.repositoryRoot, entry);
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    index: updateLedgerIndex(input.repositoryRoot, entries),
  });
}

function sameClaim(current: LedgerEntry, candidate: LedgerEntryInput): boolean {
  return (
    canonicalJson({
      subject: current.subject,
      binding: current.binding,
      why: current.why,
      semanticDependencies: current.semanticDependencies,
      policyDigest: current.policyDigest,
    }) ===
    canonicalJson({
      subject: candidate.subject,
      binding: candidate.binding,
      why: candidate.why,
      semanticDependencies: candidate.semanticDependencies,
      policyDigest: candidate.policyDigest,
    })
  );
}

function semanticClaimDigest(
  why: ReturnType<typeof readInvestigationWhyNode>,
): string {
  return prefixedDigest(
    sha256(
      canonicalJson({
        schema: 'investigation-why-file-claim.v1',
        path: why.path,
        blob: why.blob,
        relationshipsToChange: why.relationshipsToChange,
        why: why.why,
        protectedInvariant: why.protectedInvariant,
        reviewerQuestion: why.reviewerQuestion,
        answer: why.answer,
        semanticAssurance: why.semanticAssurance,
      }),
    ),
  );
}

function fileSubjectId(subjectPath: string): string {
  return `file.${sha256(subjectPath)}`;
}

function prefixedDigest(value: string): string {
  const normalized = value.replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw projectionInvalid(
      'Semantic ledger projection received a bad digest.',
    );
  }
  return `sha256:${normalized}`;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function projectionInvalid(message: string) {
  return workflowError(
    'SEMANTIC_LEDGER_PROJECTION_INVALID',
    message,
    ExitCode.guard,
  );
}
