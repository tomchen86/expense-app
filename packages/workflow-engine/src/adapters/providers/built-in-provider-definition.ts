import {
  ProviderDefinitionSnapshotError,
  assertProviderDefinitionSnapshot,
  createProviderDefinitionSnapshot,
  type ProviderDefinitionSnapshot,
} from '@jigwright/agent-runtime';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type { ProviderId } from '../../modules/provider-orchestration/provider-registry.ts';

type CandidateSet = Readonly<
  Partial<Record<NodeJS.Platform, readonly string[]>>
>;

type BuiltInProviderDefinition = Readonly<{
  definitionId: string;
  definitionRevision: number;
  providerFamily: ProviderId;
  protocol: string;
  commandProfile: string;
  candidates: CandidateSet;
}>;

// The version-owned candidate sets below are the single executable-selection
// source. Provider adapters re-export the current set for compatibility; the
// snapshot registry retains prior revisions for durable historical readers.
const CLAUDE_EXECUTABLE_CANDIDATES_V1: CandidateSet = Object.freeze({
  darwin: Object.freeze(['/opt/homebrew/bin/claude', '/usr/local/bin/claude']),
});

const CODEX_EXECUTABLE_CANDIDATES_V1: CandidateSet = Object.freeze({
  darwin: Object.freeze([
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ]),
});

export const CLAUDE_EXECUTABLE_CANDIDATES = CLAUDE_EXECUTABLE_CANDIDATES_V1;
export const CODEX_EXECUTABLE_CANDIDATES = CODEX_EXECUTABLE_CANDIDATES_V1;

// When candidates, protocol parsing, or mandatory command semantics change,
// retain the old descriptor and add a new current revision.
const BUILT_IN_PROVIDER_DEFINITIONS: Readonly<
  Record<ProviderId, readonly BuiltInProviderDefinition[]>
> = Object.freeze({
  claude: Object.freeze([
    Object.freeze({
      definitionId: 'claude-built-in-reviewed',
      definitionRevision: 1,
      providerFamily: 'claude',
      protocol: 'claude-stream-json-v1',
      commandProfile: 'claude-fixed-read-only-v1',
      candidates: CLAUDE_EXECUTABLE_CANDIDATES_V1,
    }),
  ]),
  codex: Object.freeze([
    Object.freeze({
      definitionId: 'codex-built-in-reviewed',
      definitionRevision: 1,
      providerFamily: 'codex',
      protocol: 'codex-jsonl-v1',
      commandProfile: 'codex-fixed-read-only-v1',
      candidates: CODEX_EXECUTABLE_CANDIDATES_V1,
    }),
  ]),
});

export type KnownProviderDefinitionExpectation = Readonly<{
  providerId?: ProviderId;
  platform?: NodeJS.Platform;
  executableCandidatePath?: string;
}>;

export function resolveBuiltInProviderDefinitionSnapshot(
  providerId: ProviderId,
  platform: NodeJS.Platform,
): ProviderDefinitionSnapshot | null {
  return snapshotFromDefinition(
    BUILT_IN_PROVIDER_DEFINITIONS[providerId].at(-1)!,
    platform,
  );
}

function snapshotFromDefinition(
  definition: BuiltInProviderDefinition,
  platform: NodeJS.Platform,
): ProviderDefinitionSnapshot | null {
  const executableCandidates = definition.candidates[platform];
  if (executableCandidates === undefined) return null;
  return createProviderDefinitionSnapshot({
    definitionId: definition.definitionId,
    definitionRevision: definition.definitionRevision,
    providerFamily: definition.providerFamily,
    protocol: definition.protocol,
    platform,
    executableCandidates,
    commandProfile: definition.commandProfile,
  });
}

/**
 * Admit only a snapshot reproduced by the retained code-owned built-in
 * registry. A self-consistent caller-authored digest is deliberately
 * insufficient to claim the built-in-reviewed trust tier.
 */
export function assertKnownBuiltInProviderDefinitionSnapshot(
  value: unknown,
  expectation: KnownProviderDefinitionExpectation = {},
): ProviderDefinitionSnapshot {
  const admitted = assertProviderDefinitionSnapshot(value);
  const providerId = admitted.providerFamily as ProviderId;
  const known = BUILT_IN_PROVIDER_DEFINITIONS[providerId]?.find(
    (definition) =>
      definition.definitionId === admitted.definitionId &&
      definition.definitionRevision === admitted.definitionRevision,
  );
  if (
    known === undefined ||
    (expectation.providerId !== undefined &&
      expectation.providerId !== providerId) ||
    (expectation.platform !== undefined &&
      expectation.platform !== admitted.platform)
  ) {
    throw new ProviderDefinitionSnapshotError();
  }
  const expected = snapshotFromDefinition(
    known,
    admitted.platform as NodeJS.Platform,
  );
  if (
    expected === null ||
    canonicalJson(expected) !== canonicalJson(admitted) ||
    (expectation.executableCandidatePath !== undefined &&
      !admitted.executableCandidates.includes(
        expectation.executableCandidatePath,
      ))
  ) {
    throw new ProviderDefinitionSnapshotError();
  }
  return admitted;
}
