import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  workflowError,
  type WorkflowError,
} from './foundation/errors/errors.ts';
import {
  createPrivateCanonicalJson,
  readPrivateCanonicalJson,
} from './investigation-session-store.ts';
import type { InvestigationRuntimePaths } from './paths.ts';
import {
  parsePreMergeAssuranceNode,
  type PreMergeAssuranceNode,
} from './modules/assurance/pre-merge-assurance.ts';

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;

type PreMergeAssuranceBinding = Readonly<{
  schemaVersion: 1;
  kind: 'pre-merge-assurance-binding.v1';
  bindingDigest: string;
  baseCommit: string;
  headCommit: string;
  requiredCoverageDigest: string;
  nodeId: string;
  resultDigest: string;
}>;

export function storePreMergeAssurance(
  paths: InvestigationRuntimePaths,
  candidate: PreMergeAssuranceNode,
): PreMergeAssuranceNode {
  const node = parsePreMergeAssuranceNode(candidate);
  const objectPath = assuranceObjectPath(paths, node.nodeId);
  createPrivateCanonicalJson(
    paths,
    objectPath,
    node,
    storeUnsafe,
    'PRE_MERGE_ASSURANCE_OBJECT_CONFLICT',
  );
  const binding = createBinding(node);
  createPrivateCanonicalJson(
    paths,
    assuranceBindingPath(paths, binding.baseCommit, binding.headCommit),
    binding,
    storeUnsafe,
    'PRE_MERGE_ASSURANCE_BINDING_CONFLICT',
  );
  return readPreMergeAssurance(paths, binding.baseCommit, binding.headCommit)!;
}

/** Strict, read-only replay. Missing state returns null without creating dirs. */
export function readPreMergeAssurance(
  paths: InvestigationRuntimePaths,
  requestedBaseCommit: string,
  requestedHeadCommit: string,
): PreMergeAssuranceNode | null {
  const baseCommit = objectId(requestedBaseCommit);
  const headCommit = objectId(requestedHeadCommit);
  const bindingPath = assuranceBindingPath(paths, baseCommit, headCommit);
  const bindingStats = fs.lstatSync(bindingPath, { throwIfNoEntry: false });
  if (bindingStats === undefined) return null;
  const binding = parseBinding(
    readPrivateCanonicalJson(paths, bindingPath, storeUnsafe),
  );
  if (binding.baseCommit !== baseCommit || binding.headCommit !== headCommit) {
    throw storeUnsafe();
  }
  let node: PreMergeAssuranceNode;
  try {
    node = parsePreMergeAssuranceNode(
      readPrivateCanonicalJson(
        paths,
        assuranceObjectPath(paths, binding.nodeId),
        storeUnsafe,
      ),
    );
  } catch {
    throw storeUnsafe();
  }
  if (
    node.nodeId !== binding.nodeId ||
    node.resultDigest !== binding.resultDigest ||
    node.requiredCoverage.manifestDigest !== binding.requiredCoverageDigest ||
    node.requiredCoverage.baseCommit !== baseCommit ||
    node.requiredCoverage.headCommit !== headCommit
  ) {
    throw storeUnsafe();
  }
  return node;
}

export function preMergeAssuranceBindingPath(
  paths: InvestigationRuntimePaths,
  baseCommit: string,
  headCommit: string,
): string {
  return assuranceBindingPath(
    paths,
    objectId(baseCommit),
    objectId(headCommit),
  );
}

function createBinding(node: PreMergeAssuranceNode): PreMergeAssuranceBinding {
  const body = {
    schemaVersion: 1 as const,
    kind: 'pre-merge-assurance-binding.v1' as const,
    baseCommit: node.requiredCoverage.baseCommit,
    headCommit: node.requiredCoverage.headCommit,
    requiredCoverageDigest: node.requiredCoverage.manifestDigest,
    nodeId: node.nodeId,
    resultDigest: node.resultDigest,
  };
  return Object.freeze({
    ...body,
    bindingDigest: sha256(canonicalJson(body)),
  });
}

function parseBinding(value: unknown): PreMergeAssuranceBinding {
  if (
    !isRecord(value) ||
    canonicalJson(Object.keys(value).sort()) !==
      canonicalJson(
        [
          'schemaVersion',
          'kind',
          'bindingDigest',
          'baseCommit',
          'headCommit',
          'requiredCoverageDigest',
          'nodeId',
          'resultDigest',
        ].sort(),
      ) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'pre-merge-assurance-binding.v1'
  ) {
    throw storeUnsafe();
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'pre-merge-assurance-binding.v1' as const,
    baseCommit: objectId(value.baseCommit),
    headCommit: objectId(value.headCommit),
    requiredCoverageDigest: digest(value.requiredCoverageDigest),
    nodeId: digest(value.nodeId),
    resultDigest: digest(value.resultDigest),
  };
  if (value.bindingDigest !== sha256(canonicalJson(body))) {
    throw storeUnsafe();
  }
  return Object.freeze({
    ...body,
    bindingDigest: digest(value.bindingDigest),
  });
}

function assuranceObjectPath(
  paths: InvestigationRuntimePaths,
  nodeId: string,
): string {
  return path.join(
    paths.root,
    'pre-merge-assurance',
    'objects',
    `${digest(nodeId)}.json`,
  );
}

function assuranceBindingPath(
  paths: InvestigationRuntimePaths,
  baseCommit: string,
  headCommit: string,
): string {
  return path.join(
    paths.root,
    'pre-merge-assurance',
    'bindings',
    `${baseCommit}.${headCommit}.json`,
  );
}

function objectId(value: unknown): string {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) {
    throw storeUnsafe();
  }
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw storeUnsafe();
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function storeUnsafe(): WorkflowError {
  return workflowError(
    'PRE_MERGE_ASSURANCE_STORE_UNSAFE',
    'The durable pre-merge assurance store is malformed or unsafe.',
    ExitCode.guard,
  );
}
