import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { replaceTextAtomic } from './atomic-text.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  assertPlainDirectory,
  ensurePlainDirectory,
} from './filesystem-safety.ts';
import { PINNED_OPENSPEC_VERSION } from './openspec-executor.ts';

export const OPENSPEC_ASSET_MANIFEST_PATH =
  'workflow/openspec-assets/manifest.json';

const OVERLAY_VERSION = 2;
const FORMATTER_RUNNER = 'node-package-bin:.:prettier/prettier' as const;
const OVERLAY_POLICY = [
  'planning-only',
  'pnpm-exec-openspec',
  'workflow-implementation-handoff',
  'no-external-stores',
  'no-lifecycle-entrypoints',
  'no-tool-wide-openspec-permission',
  'no-tool-specific-primitives',
  'no-unverified-slash-syntax',
  'tool-plural-parity',
  'agents-mirror-codex-final',
].join('\n');

export const OPENSPEC_SOURCE_CLOSURES = [
  {
    root: 'temporary-project' as const,
    disposition: 'reviewed-source-and-discarded-scaffold' as const,
    files: [
      '.claude/commands/opsx/explore.md',
      '.claude/commands/opsx/propose.md',
      '.claude/skills/openspec-explore/SKILL.md',
      '.claude/skills/openspec-propose/SKILL.md',
      '.codex/skills/openspec-explore/SKILL.md',
      '.codex/skills/openspec-propose/SKILL.md',
      'openspec/config.yaml',
    ],
  },
  {
    root: 'isolated-codex-home' as const,
    disposition: 'reviewed-source' as const,
    files: ['prompts/opsx-explore.md', 'prompts/opsx-propose.md'],
  },
] as const;

export type OpenSpecAssetWorkflow = 'explore' | 'propose';
export type OpenSpecAssetTarget = 'codex' | 'claude' | 'agents';
export type OpenSpecAssetKind = 'skill' | 'prompt';
export type OpenSpecAssetSourceRoot =
  'temporary-project' | 'isolated-codex-home';

export type OpenSpecAssetDefinition = {
  target: OpenSpecAssetTarget;
  kind: OpenSpecAssetKind;
  workflow: OpenSpecAssetWorkflow;
  sourceRoot: OpenSpecAssetSourceRoot;
  sourcePath: string;
  sourceKey: string;
  destinationPath: string;
  mirrorOf: string | null;
};

function definition(
  value: Omit<OpenSpecAssetDefinition, 'sourceKey'>,
): OpenSpecAssetDefinition {
  return {
    ...value,
    sourceKey: openSpecAssetSourceKey(value.sourceRoot, value.sourcePath),
  };
}

export const OPENSPEC_ASSET_DEFINITIONS: readonly OpenSpecAssetDefinition[] = [
  definition({
    target: 'codex',
    kind: 'skill',
    workflow: 'explore',
    sourceRoot: 'temporary-project',
    sourcePath: '.codex/skills/openspec-explore/SKILL.md',
    destinationPath: '.codex/skills/openspec-explore/SKILL.md',
    mirrorOf: null,
  }),
  definition({
    target: 'codex',
    kind: 'skill',
    workflow: 'propose',
    sourceRoot: 'temporary-project',
    sourcePath: '.codex/skills/openspec-propose/SKILL.md',
    destinationPath: '.codex/skills/openspec-propose/SKILL.md',
    mirrorOf: null,
  }),
  definition({
    target: 'claude',
    kind: 'skill',
    workflow: 'explore',
    sourceRoot: 'temporary-project',
    sourcePath: '.claude/skills/openspec-explore/SKILL.md',
    destinationPath: '.claude/skills/openspec-explore/SKILL.md',
    mirrorOf: null,
  }),
  definition({
    target: 'claude',
    kind: 'skill',
    workflow: 'propose',
    sourceRoot: 'temporary-project',
    sourcePath: '.claude/skills/openspec-propose/SKILL.md',
    destinationPath: '.claude/skills/openspec-propose/SKILL.md',
    mirrorOf: null,
  }),
  definition({
    target: 'agents',
    kind: 'skill',
    workflow: 'explore',
    sourceRoot: 'temporary-project',
    sourcePath: '.codex/skills/openspec-explore/SKILL.md',
    destinationPath: '.agents/skills/openspec-explore/SKILL.md',
    mirrorOf: '.codex/skills/openspec-explore/SKILL.md',
  }),
  definition({
    target: 'agents',
    kind: 'skill',
    workflow: 'propose',
    sourceRoot: 'temporary-project',
    sourcePath: '.codex/skills/openspec-propose/SKILL.md',
    destinationPath: '.agents/skills/openspec-propose/SKILL.md',
    mirrorOf: '.codex/skills/openspec-propose/SKILL.md',
  }),
  definition({
    target: 'codex',
    kind: 'prompt',
    workflow: 'explore',
    sourceRoot: 'isolated-codex-home',
    sourcePath: 'prompts/opsx-explore.md',
    destinationPath: 'workflow/openspec-assets/prompts/opsx-explore.md',
    mirrorOf: null,
  }),
  definition({
    target: 'codex',
    kind: 'prompt',
    workflow: 'propose',
    sourceRoot: 'isolated-codex-home',
    sourcePath: 'prompts/opsx-propose.md',
    destinationPath: 'workflow/openspec-assets/prompts/opsx-propose.md',
    mirrorOf: null,
  }),
];

export const OPENSPEC_ASSET_DELIVERIES = OPENSPEC_ASSET_DEFINITIONS;

const OPENSPEC_SKILL_CLOSURE = [
  'openspec-explore/SKILL.md',
  'openspec-propose/SKILL.md',
] as const;
const OPENSPEC_ASSET_HOME_CLOSURE = [
  'manifest.json',
  'prompts/opsx-explore.md',
  'prompts/opsx-propose.md',
] as const;

type OpenSpecManifestAssetEntry = {
  target: OpenSpecAssetTarget;
  kind: OpenSpecAssetKind;
  sourceRoot: OpenSpecAssetSourceRoot;
  sourcePath: string;
  destinationPath: string;
  mirrorOf: string | null;
  sourceDigest: string;
  overlayDigest: string;
  finalDigest: string;
};

export type OpenSpecReviewedAssetEntry = OpenSpecAssetDefinition & {
  sourceDigest: string;
  overlayDigest: string;
  overlayContent: string;
};

export type OpenSpecFinalAssetEntry = OpenSpecReviewedAssetEntry & {
  finalDigest: string;
  content: string;
};

export type OpenSpecFormatterMetadata = {
  runner: string;
  configurationDigest: string;
  assetParser: 'markdown';
  manifestParser: 'json';
};

export type OpenSpecAssetManifest = {
  schemaVersion: 2;
  generator: {
    package: '@fission-ai/openspec';
    version: '1.6.0';
    argv: [
      'init',
      '<temporary-project>',
      '--tools',
      'codex,claude',
      '--profile',
      'custom',
      '--force',
    ];
    tools: ['codex', 'claude'];
    profile: 'custom';
    delivery: 'both';
    workflows: ['explore', 'propose'];
    sourceClosures: Array<{
      root: OpenSpecAssetSourceRoot;
      disposition: 'reviewed-source-and-discarded-scaffold' | 'reviewed-source';
      files: string[];
    }>;
  };
  overlay: {
    version: 2;
    policyDigest: string;
  };
  formatter: OpenSpecFormatterMetadata;
  assets: OpenSpecManifestAssetEntry[];
};

export function openSpecAssetSourceKey(
  root: OpenSpecAssetSourceRoot,
  sourcePath: string,
): string {
  return `${root}/${sourcePath}`;
}

export function materializeOpenSpecReviewedEntries(
  generated: ReadonlyMap<string, string>,
): OpenSpecReviewedAssetEntry[] {
  assertGeneratedSourceClosure(generated);
  assertGeneratedToolParity(generated);

  const reviewedByDestination = new Map<string, OpenSpecReviewedAssetEntry>();
  for (const asset of OPENSPEC_ASSET_DEFINITIONS) {
    if (asset.mirrorOf !== null) {
      const canonical = reviewedByDestination.get(asset.mirrorOf);
      if (!canonical) {
        throw openSpecAssetError(
          'OPENSPEC_ASSET_SOURCE_INVALID',
          'An OpenSpec planning asset mirror has no reviewed canonical source.',
          { destinationPath: asset.destinationPath },
        );
      }
      reviewedByDestination.set(asset.destinationPath, {
        ...asset,
        sourceDigest: canonical.sourceDigest,
        overlayDigest: canonical.overlayDigest,
        overlayContent: canonical.overlayContent,
      });
      continue;
    }

    const source = generated.get(asset.sourceKey);
    if (source === undefined) {
      throw openSpecAssetError(
        'OPENSPEC_ASSET_SOURCE_INVALID',
        'Pinned OpenSpec did not generate an expected planning source.',
        { sourceKey: asset.sourceKey },
      );
    }
    const overlayContent = applyOpenSpecPlanningAssetOverlay(source);
    verifyOpenSpecPlanningAssetContent(overlayContent);
    reviewedByDestination.set(asset.destinationPath, {
      ...asset,
      sourceDigest: digestOpenSpecAssetContent(source),
      overlayDigest: digestOpenSpecAssetContent(overlayContent),
      overlayContent,
    });
  }

  return OPENSPEC_ASSET_DEFINITIONS.map((asset) => {
    const reviewed = reviewedByDestination.get(asset.destinationPath);
    if (!reviewed) {
      throw openSpecAssetError(
        'OPENSPEC_ASSET_SOURCE_INVALID',
        'An OpenSpec planning asset was not reviewed.',
        { destinationPath: asset.destinationPath },
      );
    }
    return reviewed;
  });
}

export const reviewOpenSpecPlanningAssetSources =
  materializeOpenSpecReviewedEntries;

export function materializeOpenSpecFinalEntries(
  reviewed: readonly OpenSpecReviewedAssetEntry[],
  formatMarkdown: (content: string) => string,
): OpenSpecFinalAssetEntry[] {
  assertReviewedEntries(reviewed);
  const finalByDestination = new Map<string, OpenSpecFinalAssetEntry>();

  for (const entry of reviewed) {
    if (entry.mirrorOf !== null) {
      continue;
    }
    const content = formatMarkdown(entry.overlayContent);
    verifyOpenSpecPlanningAssetContent(content);
    finalByDestination.set(entry.destinationPath, {
      ...entry,
      finalDigest: digestOpenSpecAssetContent(content),
      content,
    });
  }

  for (const entry of reviewed) {
    if (entry.mirrorOf === null) {
      continue;
    }
    const canonical = finalByDestination.get(entry.mirrorOf);
    if (!canonical) {
      throw openSpecAssetError(
        'OPENSPEC_ASSET_MIRROR_INVALID',
        'An OpenSpec agent mirror has no formatted Codex final.',
        { destinationPath: entry.destinationPath },
      );
    }
    finalByDestination.set(entry.destinationPath, {
      ...entry,
      finalDigest: canonical.finalDigest,
      content: canonical.content,
    });
  }

  const entries = reviewed.map((entry) => {
    const final = finalByDestination.get(entry.destinationPath);
    if (!final) {
      throw openSpecAssetError(
        'OPENSPEC_ASSET_SOURCE_INVALID',
        'An OpenSpec planning asset final was not materialized.',
        { destinationPath: entry.destinationPath },
      );
    }
    return final;
  });
  assertFinalToolParity(entries);
  return entries;
}

export function createOpenSpecAssetManifest(
  entries: readonly OpenSpecFinalAssetEntry[],
  formatter: OpenSpecFormatterMetadata,
): OpenSpecAssetManifest {
  assertFinalEntries(entries);
  if (
    formatter.runner !== FORMATTER_RUNNER ||
    formatter.assetParser !== 'markdown' ||
    formatter.manifestParser !== 'json' ||
    !isDigest(formatter.configurationDigest)
  ) {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_MANIFEST_INVALID',
      'OpenSpec asset formatter metadata is invalid.',
    );
  }
  return {
    schemaVersion: 2,
    generator: expectedGeneratorPolicy(),
    overlay: {
      version: OVERLAY_VERSION,
      policyDigest: digestOpenSpecAssetContent(OVERLAY_POLICY),
    },
    formatter: { ...formatter },
    assets: entries.map((entry) => manifestEntry(entry)),
  };
}

export function verifyOpenSpecManifestReviewedEntries(
  manifest: OpenSpecAssetManifest,
  reviewed: readonly OpenSpecReviewedAssetEntry[],
): void {
  if (!isOpenSpecAssetManifest(manifest)) {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_MANIFEST_INVALID',
      'The OpenSpec planning asset manifest is invalid.',
    );
  }
  assertReviewedEntries(reviewed);
  for (const [index, expected] of reviewed.entries()) {
    const actual = manifest.assets[index];
    if (
      !actual ||
      actual.sourceDigest !== expected.sourceDigest ||
      actual.overlayDigest !== expected.overlayDigest
    ) {
      throw openSpecAssetError(
        'OPENSPEC_ASSET_GENERATOR_DRIFT',
        'Generated OpenSpec planning sources or reviewed overlays have drifted.',
        { destinationPath: expected.destinationPath },
      );
    }
  }
}

export function applyOpenSpecPlanningAssetOverlay(source: string): string {
  const normalized = source.replaceAll('\r\n', '\n');
  const withoutStore = normalized.replace(
    /^\*\*Store selection:\*\*[^\n]*(?:\n\n|\n)?/m,
    '',
  );
  const adapted = withoutStore
    .replace(/^allowed-tools: Bash\(openspec:\*\)\n/m, '')
    .replace(
      /^compatibility: Requires openspec CLI\.$/m,
      'compatibility: Requires the repository-pinned OpenSpec CLI and workflow engine.',
    )
    .replaceAll('the **AskUserQuestion tool**', 'an open-ended question')
    .replaceAll('**AskUserQuestion tool**', 'an open-ended question')
    .replaceAll('the **TodoWrite tool**', 'a task list')
    .replaceAll('**TodoWrite tool**', 'a task list')
    .replaceAll(
      '/opsx:apply',
      'pnpm workflow start <change-id> --task <task-id>',
    )
    .replaceAll('/opsx:explore', 'openspec-explore')
    .replaceAll('/opsx:propose', 'openspec-propose')
    .replace(
      /\bopenspec (?=(?:list|status|instructions|new|validate|show|doctor|context)\b)/g,
      'pnpm exec openspec ',
    );
  return `${adapted.trimEnd()}\n\n## Repository workflow boundary\n\nThis interface is planning-only. Use \`pnpm exec openspec\` for the reviewed planning commands above, submit planning changes with \`pnpm workflow plan-commit <change-id>\`, and begin implementation only with \`pnpm workflow start <change-id> --task <task-id>\`. OpenSpec lifecycle operations and external planning stores are outside this interface.\n`;
}

export function verifyOpenSpecPlanningAssetContent(content: string): void {
  const fixedForbidden: Array<[string, RegExp]> = [
    [
      'lifecycle-command',
      /\bopenspec\b[^\r\n]*\b(?:apply|update|sync|archive|bulk(?:-|\s+)archive|store)\b/i,
    ],
    ['external-store', /--store(?:\s|=|$)/i],
    [
      'spectra-command',
      /\bspectra\b(?=[^\r\n]*(?:--(?:help|version)\b|\b(?:apply|update|sync|archive|bulk(?:-|\s+)archive|store|list|status|instructions|new|validate|show|doctor|context|explore|propose)\b))/i,
    ],
    ['spectra-slash-command', /\/spectra(?=$|[^a-z0-9])/i],
    ['openspec-slash-command', /\/openspec(?=$|[^a-z0-9])/i],
    ['opsx-command', /\/opsx(?=$|[^a-z0-9])/i],
    ['opsx-token', /\bopsx\b/i],
    ['declared-tool-authority', /allowed-tools/i],
    ['tool-wide-permission', /\bBash\s*\([^\r\n)]*\bopenspec\b/i],
    ['tool-primitive', /\b(?:AskUserQuestion|TodoWrite)\b/i],
    ['store-guidance', /^\*\*Store selection:\*\*/m],
    ['shell-expansion-or-escape', /[$\\{}]/],
    ['shell-posix-character-class', /\[\[:[a-z]+:\]\]/i],
    ['shell-nested-character-class', /\[\[[^\r\n]*\]\]/],
    ['shell-extended-glob', /[@+?!*]\([^\r\n)]*\)/],
    ['shell-option-mutation', /\b(?:setopt|unsetopt|shopt)\b/i],
    [
      'shell-command-synthesis',
      /\b(?:xargs|eval|printf|echo|base64|sed|corepack)\b/i,
    ],
    ['shell-interpreter-wrapper', /\b(?:ba|z|da)?sh\s+-c\b/i],
    [
      'executable-interpreter-synthesis',
      /\b(?:node|python\d*|perl|ruby|php|lua|bash|zsh|dash|sh)\b(?=\s+(?:-[a-z]|[<>]\())/i,
    ],
    [
      'external-store-environment',
      /\b[A-Z0-9_]*OPENSPEC[A-Z0-9_]*STORE[A-Z0-9_]*\s*=/i,
    ],
    [
      'unreviewed-openspec-wrapper',
      /\b(?:npx|sudo|doas|env(?:[ \t]+\S+)*|command|exec|npm[ \t]+exec|bunx|yarn)[ \t]+pnpm[ \t]+exec[ \t]+openspec\b/im,
    ],
  ];
  const commandSurfaceForbidden: Array<[string, RegExp]> = [
    [
      'unreviewed-slash-command',
      /(?:^|[^a-z0-9_./-])\/[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_-]*)?(?=$|[^a-z0-9_:/-])/im,
    ],
  ];
  const commandSurface = normalizeCommandSurface(content);
  const matched =
    fixedForbidden.find(([, pattern]) => pattern.test(content)) ??
    fixedForbidden.find(([, pattern]) => pattern.test(commandSurface)) ??
    commandSurfaceForbidden.find(([, pattern]) => pattern.test(commandSurface));
  const unreviewedOpenSpecToken = findUnreviewedOpenSpecToken(commandSurface);
  const commandLikeSpectraToken = findCommandLikeSpectraToken(commandSurface);
  const commandAdaptation =
    findProtectedShellGlob(content) ||
    hasCommandAdaptationSurface(commandSurface);
  if (
    !content.endsWith('\n') ||
    content.includes('\r') ||
    !content.includes('pnpm exec openspec') ||
    !content.includes('pnpm workflow plan-commit') ||
    !content.includes('pnpm workflow start') ||
    matched ||
    unreviewedOpenSpecToken ||
    commandLikeSpectraToken ||
    commandAdaptation
  ) {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_FORBIDDEN_AUTHORITY',
      'An OpenSpec planning asset exposes unreviewed commands, tools, stores, or lifecycle authority.',
      {
        pattern:
          matched?.[0] ??
          (unreviewedOpenSpecToken
            ? 'unreviewed-openspec-token'
            : commandLikeSpectraToken
              ? 'command-like-spectra-token'
              : commandAdaptation
                ? 'command-adaptation'
                : null),
      },
    );
  }
}

export function readOpenSpecAssetManifest(
  repositoryRoot: string,
): OpenSpecAssetManifest {
  let value: unknown;
  try {
    const content = readOpenSpecAssetFile(
      path.join(repositoryRoot, OPENSPEC_ASSET_MANIFEST_PATH),
    );
    value = JSON.parse(content) as unknown;
    if (!openSpecAssetJsonHasUniqueKeys(content)) {
      throw new Error('duplicate OpenSpec asset manifest key');
    }
  } catch {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_MANIFEST_INVALID',
      'The OpenSpec planning asset manifest is missing or invalid.',
    );
  }
  if (!isOpenSpecAssetManifest(value)) {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_MANIFEST_INVALID',
      'The OpenSpec planning asset manifest is missing or invalid.',
    );
  }
  return value;
}

export function verifyOpenSpecRepositoryAssets(
  repositoryRoot: string,
  manifest: OpenSpecAssetManifest,
): void {
  if (!isOpenSpecAssetManifest(manifest)) {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_MANIFEST_INVALID',
      'The OpenSpec planning asset manifest is invalid.',
    );
  }
  const root = canonicalOpenSpecAssetDirectory(repositoryRoot);
  const contentByDestination = new Map<string, string>();
  for (const asset of manifest.assets) {
    const content = readOpenSpecAssetFile(
      path.join(root, asset.destinationPath),
    );
    verifyOpenSpecPlanningAssetContent(content);
    if (digestOpenSpecAssetContent(content) !== asset.finalDigest) {
      throw openSpecAssetError(
        'OPENSPEC_ASSET_REPOSITORY_DRIFT',
        'A reviewed OpenSpec planning asset differs from its final-byte digest.',
        { destinationPath: asset.destinationPath },
      );
    }
    contentByDestination.set(asset.destinationPath, content);
  }
  assertRepositoryToolParity(contentByDestination);
}

export function verifyOpenSpecRepositoryClosure(repositoryRoot: string): void {
  const root = canonicalOpenSpecAssetDirectory(repositoryRoot);
  verifyOpenSpecSkillClosures(root, false);
  verifyOpenSpecClaudeCommandClosure(root);
  verifyOpenSpecAssetHomeClosure(root, false);
}

export function verifyOpenSpecRepositoryWritePlan(
  repositoryRoot: string,
): void {
  const root = canonicalOpenSpecAssetDirectory(repositoryRoot);
  for (const relativePath of [
    ...OPENSPEC_ASSET_DEFINITIONS.map((entry) => entry.destinationPath),
    OPENSPEC_ASSET_MANIFEST_PATH,
  ]) {
    assertOpenSpecAssetWriteTarget(root, relativePath);
  }
  verifyOpenSpecSkillClosures(root, true);
  verifyOpenSpecClaudeCommandClosure(root);
  verifyOpenSpecAssetHomeClosure(root, true);
}

function verifyOpenSpecSkillClosures(
  repositoryRoot: string,
  includePlannedFiles: boolean,
): void {
  for (const skillsRoot of [
    '.codex/skills',
    '.claude/skills',
    '.agents/skills',
  ]) {
    const files = prospectiveFiles(
      listOptionalPlainFiles(path.join(repositoryRoot, skillsRoot)),
      includePlannedFiles ? OPENSPEC_SKILL_CLOSURE : [],
    );
    const actual = files.filter((file) =>
      firstSegmentMatchesNamespace(file, 'openspec'),
    );
    if (JSON.stringify(actual) !== JSON.stringify(OPENSPEC_SKILL_CLOSURE)) {
      throw openSpecAssetError(
        'OPENSPEC_ASSET_CLOSURE_INVALID',
        'Repository OpenSpec skills contain a missing or unreviewed entry point.',
        { root: skillsRoot },
      );
    }
    if (
      files.some(
        (file) =>
          firstSegmentMatchesNamespace(file, 'opsx') ||
          firstSegmentMatchesNamespace(file, 'spectra'),
      )
    ) {
      throw openSpecAssetError(
        'OPENSPEC_ASSET_CLOSURE_INVALID',
        'Repository skills contain an unreviewed planning entry point.',
        { root: skillsRoot },
      );
    }
    for (const file of files) {
      if (
        !OPENSPEC_SKILL_CLOSURE.includes(
          file as (typeof OPENSPEC_SKILL_CLOSURE)[number],
        ) &&
        path.basename(file).toLowerCase() === 'skill.md' &&
        containsUnreviewedPlanningEntryPoint(
          readOpenSpecAssetFile(path.join(repositoryRoot, skillsRoot, file)),
        )
      ) {
        throw openSpecAssetError(
          'OPENSPEC_ASSET_CLOSURE_INVALID',
          'Repository skills contain hidden OpenSpec lifecycle authority.',
          { root: skillsRoot, file },
        );
      }
    }
  }
}

function verifyOpenSpecClaudeCommandClosure(repositoryRoot: string): void {
  const claudeCommands = listOptionalPlainFiles(
    path.join(repositoryRoot, '.claude/commands'),
  );
  if (
    claudeCommands.some((file) => {
      const commandSegments = file
        .split('/')
        .map((segment) => segment.toLowerCase());
      return (
        commandSegments.some((segment) =>
          ['opsx', 'openspec', 'spectra'].some((namespace) =>
            segment.startsWith(namespace),
          ),
        ) ||
        containsUnreviewedPlanningEntryPoint(
          readOpenSpecAssetFile(
            path.join(repositoryRoot, '.claude/commands', file),
          ),
        )
      );
    })
  ) {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_CLOSURE_INVALID',
      'Repository Claude commands contain an undelivered planning entry point.',
    );
  }
}

function verifyOpenSpecAssetHomeClosure(
  repositoryRoot: string,
  includePlannedFiles: boolean,
): void {
  const files = prospectiveFiles(
    listOptionalPlainFiles(
      path.join(repositoryRoot, 'workflow/openspec-assets'),
    ),
    includePlannedFiles ? OPENSPEC_ASSET_HOME_CLOSURE : [],
  );
  if (JSON.stringify(files) !== JSON.stringify(OPENSPEC_ASSET_HOME_CLOSURE)) {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_CLOSURE_INVALID',
      'Repository OpenSpec asset home contains missing or unreviewed files.',
      { actual: files, expected: OPENSPEC_ASSET_HOME_CLOSURE },
    );
  }
}

export function assertExactOpenSpecAssetFiles(
  directory: string,
  expected: readonly string[],
): void {
  if (!fs.lstatSync(path.resolve(directory), { throwIfNoEntry: false })) {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_CLOSURE_INVALID',
      'Generated OpenSpec output contains missing or unreviewed files.',
    );
  }
  const actual = listPlainFiles(directory);
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_CLOSURE_INVALID',
      'Generated OpenSpec output contains missing or unreviewed files.',
      { actual, expected: sortedExpected },
    );
  }
}

export const assertExactOpenSpecFiles = assertExactOpenSpecAssetFiles;

export function canonicalOpenSpecAssetDirectory(directory: string): string {
  try {
    const canonical = fs.realpathSync(path.resolve(directory));
    assertPlainDirectory(canonical);
    return canonical;
  } catch {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_PATH_UNSAFE',
      'An OpenSpec asset directory is missing or unsafe.',
    );
  }
}

export function readOpenSpecAssetFile(filePath: string): string {
  const absolute = path.resolve(filePath);
  const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    fs.realpathSync(absolute) !== absolute
  ) {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_PATH_UNSAFE',
      'An OpenSpec asset is missing or is not a canonical single-link plain file.',
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      fs.readFileSync(absolute),
    );
  } catch {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_CONTENT_INVALID',
      'An OpenSpec asset is not valid UTF-8 text.',
    );
  }
}

export function writeOpenSpecAssetFile(
  repositoryRoot: string,
  relativePath: string,
  content: string,
): void {
  const root = canonicalOpenSpecAssetDirectory(repositoryRoot);
  const target = safeOpenSpecRepositoryPath(root, relativePath);
  try {
    ensurePlainDirectory(path.dirname(target));
    const existing = fs.lstatSync(target, { throwIfNoEntry: false });
    if (
      existing &&
      (!existing.isFile() ||
        existing.isSymbolicLink() ||
        existing.nlink !== 1 ||
        fs.realpathSync(target) !== target)
    ) {
      throw new Error('unsafe existing OpenSpec asset');
    }
    replaceTextAtomic(target, content, {
      allowCreate: true,
      defaultMode: 0o644,
    });
  } catch {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_PATH_UNSAFE',
      'An OpenSpec asset destination is unsafe.',
      { relativePath },
    );
  }
}

export function digestOpenSpecAssetContent(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function openSpecAssetError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return workflowError(code, message, ExitCode.verification, {
    ...(details ? { details } : {}),
  });
}

function expectedGeneratorPolicy(): OpenSpecAssetManifest['generator'] {
  return {
    package: '@fission-ai/openspec',
    version: PINNED_OPENSPEC_VERSION,
    argv: [
      'init',
      '<temporary-project>',
      '--tools',
      'codex,claude',
      '--profile',
      'custom',
      '--force',
    ],
    tools: ['codex', 'claude'],
    profile: 'custom',
    delivery: 'both',
    workflows: ['explore', 'propose'],
    sourceClosures: OPENSPEC_SOURCE_CLOSURES.map((closure) => ({
      root: closure.root,
      disposition: closure.disposition,
      files: [...closure.files],
    })),
  };
}

function manifestEntry(
  entry: OpenSpecFinalAssetEntry,
): OpenSpecManifestAssetEntry {
  return {
    target: entry.target,
    kind: entry.kind,
    sourceRoot: entry.sourceRoot,
    sourcePath: entry.sourcePath,
    destinationPath: entry.destinationPath,
    mirrorOf: entry.mirrorOf,
    sourceDigest: entry.sourceDigest,
    overlayDigest: entry.overlayDigest,
    finalDigest: entry.finalDigest,
  };
}

function assertGeneratedSourceClosure(
  generated: ReadonlyMap<string, string>,
): void {
  const expected = OPENSPEC_SOURCE_CLOSURES.flatMap((closure) =>
    closure.files.map((file) => openSpecAssetSourceKey(closure.root, file)),
  ).sort();
  const actual = [...generated.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_CLOSURE_INVALID',
      'Pinned OpenSpec generated a missing or unreviewed source.',
      { actual, expected },
    );
  }
}

function assertGeneratedToolParity(
  generated: ReadonlyMap<string, string>,
): void {
  for (const workflow of ['explore', 'propose'] as const) {
    const codex = generated.get(
      openSpecAssetSourceKey(
        'temporary-project',
        `.codex/skills/openspec-${workflow}/SKILL.md`,
      ),
    );
    const claude = generated.get(
      openSpecAssetSourceKey(
        'temporary-project',
        `.claude/skills/openspec-${workflow}/SKILL.md`,
      ),
    );
    if (codex === undefined || claude === undefined || codex !== claude) {
      throw openSpecAssetError(
        'OPENSPEC_ASSET_TOOL_PARITY_INVALID',
        'Pinned OpenSpec generated divergent Codex and Claude skill sources.',
        { workflow },
      );
    }
  }
}

function assertReviewedEntries(
  entries: readonly OpenSpecReviewedAssetEntry[],
): void {
  if (entries.length !== OPENSPEC_ASSET_DEFINITIONS.length) {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_SOURCE_INVALID',
      'The reviewed OpenSpec delivery set is incomplete.',
    );
  }
  for (const [index, entry] of entries.entries()) {
    const expected = OPENSPEC_ASSET_DEFINITIONS[index]!;
    if (
      !sameDefinition(entry, expected) ||
      !isDigest(entry.sourceDigest) ||
      !isDigest(entry.overlayDigest) ||
      digestOpenSpecAssetContent(entry.overlayContent) !== entry.overlayDigest
    ) {
      throw openSpecAssetError(
        'OPENSPEC_ASSET_SOURCE_INVALID',
        'A reviewed OpenSpec delivery entry is invalid.',
        { destinationPath: expected.destinationPath },
      );
    }
    verifyOpenSpecPlanningAssetContent(entry.overlayContent);
  }
}

function assertFinalEntries(entries: readonly OpenSpecFinalAssetEntry[]): void {
  assertReviewedEntries(entries);
  for (const [index, entry] of entries.entries()) {
    const expected = OPENSPEC_ASSET_DEFINITIONS[index]!;
    if (
      !isDigest(entry.finalDigest) ||
      digestOpenSpecAssetContent(entry.content) !== entry.finalDigest
    ) {
      throw openSpecAssetError(
        'OPENSPEC_ASSET_SOURCE_INVALID',
        'An OpenSpec delivery final is invalid.',
        { destinationPath: expected.destinationPath },
      );
    }
    verifyOpenSpecPlanningAssetContent(entry.content);
  }
  assertFinalToolParity(entries);
}

function assertFinalToolParity(
  entries: readonly OpenSpecFinalAssetEntry[],
): void {
  const contentByDestination = new Map(
    entries.map((entry) => [entry.destinationPath, entry.content]),
  );
  assertRepositoryToolParity(contentByDestination);
}

function assertRepositoryToolParity(
  contentByDestination: ReadonlyMap<string, string>,
): void {
  for (const workflow of ['explore', 'propose'] as const) {
    const codexPath = `.codex/skills/openspec-${workflow}/SKILL.md`;
    const claudePath = `.claude/skills/openspec-${workflow}/SKILL.md`;
    const agentsPath = `.agents/skills/openspec-${workflow}/SKILL.md`;
    const codex = contentByDestination.get(codexPath);
    const claude = contentByDestination.get(claudePath);
    const agents = contentByDestination.get(agentsPath);
    if (codex === undefined || claude === undefined || codex !== claude) {
      throw openSpecAssetError(
        'OPENSPEC_ASSET_TOOL_PARITY_INVALID',
        'Reviewed Codex and Claude planning skills are not byte-identical.',
        { workflow },
      );
    }
    if (agents === undefined || agents !== codex) {
      throw openSpecAssetError(
        'OPENSPEC_ASSET_MIRROR_INVALID',
        'A reviewed agent skill is not a byte-identical Codex mirror.',
        { workflow },
      );
    }
  }
}

function sameDefinition(
  value: OpenSpecAssetDefinition,
  expected: OpenSpecAssetDefinition,
): boolean {
  return (
    value.target === expected.target &&
    value.kind === expected.kind &&
    value.workflow === expected.workflow &&
    value.sourceRoot === expected.sourceRoot &&
    value.sourcePath === expected.sourcePath &&
    value.sourceKey === expected.sourceKey &&
    value.destinationPath === expected.destinationPath &&
    value.mirrorOf === expected.mirrorOf
  );
}

function isOpenSpecAssetManifest(
  value: unknown,
): value is OpenSpecAssetManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'generator',
      'overlay',
      'formatter',
      'assets',
    ]) ||
    value.schemaVersion !== 2 ||
    !isRecord(value.generator) ||
    !hasExactKeys(value.generator, [
      'package',
      'version',
      'argv',
      'tools',
      'profile',
      'delivery',
      'workflows',
      'sourceClosures',
    ]) ||
    !isRecord(value.overlay) ||
    !hasExactKeys(value.overlay, ['version', 'policyDigest']) ||
    !isRecord(value.formatter) ||
    !hasExactKeys(value.formatter, [
      'runner',
      'configurationDigest',
      'assetParser',
      'manifestParser',
    ]) ||
    !Array.isArray(value.assets)
  ) {
    return false;
  }

  const generator = expectedGeneratorPolicy();
  if (
    JSON.stringify(value.generator) !== JSON.stringify(generator) ||
    value.overlay.version !== OVERLAY_VERSION ||
    value.overlay.policyDigest !== digestOpenSpecAssetContent(OVERLAY_POLICY) ||
    value.formatter.runner !== FORMATTER_RUNNER ||
    !isDigest(value.formatter.configurationDigest) ||
    value.formatter.assetParser !== 'markdown' ||
    value.formatter.manifestParser !== 'json' ||
    value.assets.length !== OPENSPEC_ASSET_DEFINITIONS.length
  ) {
    return false;
  }

  return value.assets.every((entry, index) => {
    const expected = OPENSPEC_ASSET_DEFINITIONS[index]!;
    return (
      isRecord(entry) &&
      hasExactKeys(entry, [
        'target',
        'kind',
        'sourceRoot',
        'sourcePath',
        'destinationPath',
        'mirrorOf',
        'sourceDigest',
        'overlayDigest',
        'finalDigest',
      ]) &&
      entry.target === expected.target &&
      entry.kind === expected.kind &&
      entry.sourceRoot === expected.sourceRoot &&
      entry.sourcePath === expected.sourcePath &&
      entry.destinationPath === expected.destinationPath &&
      entry.mirrorOf === expected.mirrorOf &&
      isDigest(entry.sourceDigest) &&
      isDigest(entry.overlayDigest) &&
      isDigest(entry.finalDigest)
    );
  });
}

function normalizeCommandSurface(content: string): string {
  const decoded = decodeHtmlEntities(content.normalize('NFKC'));
  const commentBodies = [...decoded.matchAll(/<!--([\s\S]*?)-->/g)].map(
    (match) => match[1] ?? '',
  );
  const withoutHtml =
    `${decoded.replaceAll(/<!--[\s\S]*?-->/g, '')}\n${commentBodies.join('\n')}`
      .replaceAll(/<\?[\s\S]*?\?>/g, '')
      .replaceAll(/<!\[CDATA\[[\s\S]*?\]\]>/gi, '')
      .replaceAll(/<![a-z][^>]*>/gi, '')
      .replaceAll(/<\/?[a-z](?:[^>"']|"[^"]*"|'[^']*')*>/gi, '')
      .replaceAll(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  return normalizeMarkdownReferenceLinks(withoutHtml)
    .replaceAll(/\\\r?\n/g, '')
    .replaceAll(/\\(?=[a-z0-9])/gi, '')
    .replaceAll(/["']/g, '')
    .replaceAll(/[*~]/g, '')
    .replaceAll(/[\u200B-\u200D\u2060\uFEFF]/g, '');
}

function normalizeMarkdownReferenceLinks(content: string): string {
  const normalizeLabel = (label: string): string =>
    label
      .replaceAll(/\r?\n[ \t]*(?:(?:>[ \t]?)+|(?:[-+*]|\d+[.)])[ \t]+)/g, ' ')
      .trim()
      .replaceAll(/\s+/g, ' ')
      .toLowerCase();
  const definitions = new Set(
    [...content.matchAll(/\[([^\]]{1,999})\]:/g)].map((match) =>
      normalizeLabel(match[1]!),
    ),
  );
  const fullReferences = content.replaceAll(
    /!?\[([^\]]*)\][ \t\r\n]*\[([^\]]*)\]/g,
    (match, label: string, reference: string) =>
      definitions.has(normalizeLabel(reference || label)) ? label : match,
  );
  return fullReferences.replaceAll(/!?\[([^\]]+)\]/g, (match, label: string) =>
    definitions.has(normalizeLabel(label)) ? label : match,
  );
}

function findUnreviewedOpenSpecToken(content: string): boolean {
  for (const match of content.matchAll(/\bopenspec\b/gi)) {
    const index = match.index;
    const lineStart = content.lastIndexOf('\n', index - 1) + 1;
    const nextNewline = content.indexOf('\n', index);
    const lineEnd = nextNewline === -1 ? content.length : nextNewline;
    const before = content.slice(lineStart, index);
    const after = content.slice(index + 'openspec'.length, lineEnd);

    if (before.endsWith('pnpm exec ')) {
      if (
        match[0] === 'openspec' &&
        isReviewedOpenSpecInvocation(
          content,
          lineStart,
          lineEnd,
          index - 'pnpm exec '.length,
        )
      ) {
        continue;
      }
      return true;
    }
    if (
      (before.endsWith('.') && after.startsWith('.yaml')) ||
      after.startsWith('-explore') ||
      after.startsWith('-propose') ||
      after.startsWith('/config.yaml') ||
      (/^\s*author:\s*$/.test(before) && after.trim().length === 0)
    ) {
      continue;
    }
    if (
      match[0] !== 'openspec' &&
      /^\s+(?:artifacts?|awareness|system|cli|lifecycle)\b/i.test(after)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function isReviewedOpenSpecInvocation(
  content: string,
  lineStart: number,
  lineEnd: number,
  invocationStart: number,
): boolean {
  let command: string;
  if (content[invocationStart - 1] === '`') {
    const closingBacktick = content.indexOf('`', invocationStart);
    if (closingBacktick === -1 || closingBacktick > lineEnd) {
      return false;
    }
    command = content.slice(invocationStart, closingBacktick);
  } else {
    if (content.slice(lineStart, invocationStart).trim().length !== 0) {
      return false;
    }
    command = content.slice(invocationStart, lineEnd);
  }
  command = command.replaceAll(/[ \t]+/g, ' ').trim();

  return [
    /^pnpm exec openspec$/,
    /^pnpm exec openspec list(?: --json)?$/,
    /^pnpm exec openspec status(?: --change)?(?: --json)?$/,
    /^pnpm exec openspec new change$/,
    /^pnpm exec openspec instructions(?: --change --json)?$/,
  ].some((pattern) => pattern.test(command));
}

function decodeHtmlEntities(content: string): string {
  return content
    .replaceAll(/&#(x[0-9a-f]+|[0-9]+);/gi, (entity, encoded: string) => {
      const hexadecimal = encoded[0]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(
        hexadecimal ? encoded.slice(1) : encoded,
        hexadecimal ? 16 : 10,
      );
      try {
        return Number.isSafeInteger(codePoint)
          ? String.fromCodePoint(codePoint)
          : entity;
      } catch {
        return entity;
      }
    })
    .replaceAll(
      /&(amp|apos|gt|lt|quot);/gi,
      (entity, name: string) =>
        ({
          amp: '&',
          apos: "'",
          gt: '>',
          lt: '<',
          quot: '"',
        })[name.toLowerCase()] ?? entity,
    );
}

function hasCommandAdaptationSurface(content: string): boolean {
  return (
    findUnreviewedShellControl(content) ||
    findProtectedShellGlob(content) ||
    hasAdjacentInlineCode(content)
  );
}

function hasAdjacentInlineCode(content: string): boolean {
  for (const line of content.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      continue;
    }
    let searchFrom = 0;
    while (searchFrom < line.length) {
      const opening = line.indexOf('`', searchFrom);
      if (opening === -1) {
        break;
      }
      const closing = line.indexOf('`', opening + 1);
      if (closing === -1) {
        return true;
      }
      if (
        /[a-z0-9_./-]/i.test(line[opening - 1] ?? '') ||
        /[a-z0-9_/-]/i.test(line[closing + 1] ?? '') ||
        (line.slice(0, opening).trim().length === 0 &&
          line.slice(closing + 1).trim().length !== 0)
      ) {
        return true;
      }
      searchFrom = closing + 1;
    }
  }
  return false;
}

function findUnreviewedShellControl(content: string): boolean {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    const markdownTableRow = trimmed.startsWith('|') && trimmed.endsWith('|');
    if (
      /(?:&&|\|\||;|<<|>>|[<>]\()/.test(line) ||
      (line.includes('|') && !markdownTableRow)
    ) {
      return true;
    }
  }
  return false;
}

function findProtectedShellGlob(content: string): boolean {
  for (const match of content.matchAll(/[^\s`"']+/g)) {
    let token = match[0].replace(/^[,;:]+|[,;:.]+$/g, '');
    if (token.startsWith('(') && token.endsWith(')') && token.includes('/')) {
      token = token.slice(1, -1);
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) {
      continue;
    }
    const basename = token.split('/').at(-1) ?? '';
    const groupedLiteral = collapseLiteralShellGroups(basename);
    const repeatedGroupLiteral = groupedLiteral?.replaceAll(/#+/g, '');
    const qualifierlessGlob = stripZshGlobQualifier(basename);
    if (
      (token.includes('/') && /[#~^]/.test(basename)) ||
      basename.startsWith('^') ||
      basename.includes('(#')
    ) {
      return true;
    }
    if (
      ['openspec', 'spectra', 'opsx'].some(
        (protectedName) =>
          (/[*?[]/.test(basename) &&
            shellGlobCanMatch(basename, protectedName)) ||
          (qualifierlessGlob !== null &&
            shellGlobCanMatch(qualifierlessGlob, protectedName)) ||
          groupedLiteral === protectedName ||
          repeatedGroupLiteral === protectedName,
      )
    ) {
      return true;
    }
  }
  return false;
}

function stripZshGlobQualifier(pattern: string): string | null {
  const match = /^(.*)\([^()\r\n]*\)$/.exec(pattern);
  const candidate = match?.[1];
  return candidate && /[*?[]/.test(candidate) ? candidate : null;
}

function collapseLiteralShellGroups(pattern: string): string | null {
  let collapsed = pattern.toLowerCase();
  while (/\([^()|]*\)/.test(collapsed)) {
    collapsed = collapsed.replaceAll(/\(([^()|]*)\)/g, '$1');
  }
  return collapsed === pattern.toLowerCase() || /[()]/.test(collapsed)
    ? null
    : collapsed;
}

function shellGlobCanMatch(pattern: string, literal: string): boolean {
  const candidate = pattern.toLowerCase();
  const expected = literal.toLowerCase();
  const memo = new Map<string, boolean>();
  const visit = (patternIndex: number, literalIndex: number): boolean => {
    const key = `${patternIndex}:${literalIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let matched: boolean;
    if (patternIndex === candidate.length) {
      matched = literalIndex === expected.length;
    } else if (candidate[patternIndex] === '*') {
      matched =
        visit(patternIndex + 1, literalIndex) ||
        (literalIndex < expected.length &&
          visit(patternIndex, literalIndex + 1));
    } else if (literalIndex === expected.length) {
      matched = false;
    } else if (candidate[patternIndex] === '?') {
      matched = visit(patternIndex + 1, literalIndex + 1);
    } else if (candidate[patternIndex] === '[') {
      const closing = candidate.indexOf(']', patternIndex + 1);
      if (closing === -1) {
        matched = false;
      } else {
        const body = candidate.slice(patternIndex + 1, closing);
        const negated = body.startsWith('!') || body.startsWith('^');
        const choices = negated ? body.slice(1) : body;
        const included = shellCharacterClassIncludes(
          choices,
          expected[literalIndex]!,
        );
        matched =
          (negated ? !included : included) &&
          visit(closing + 1, literalIndex + 1);
      }
    } else {
      matched =
        candidate[patternIndex] === expected[literalIndex] &&
        visit(patternIndex + 1, literalIndex + 1);
    }
    memo.set(key, matched);
    return matched;
  };
  return visit(0, 0);
}

function shellCharacterClassIncludes(
  choices: string,
  character: string,
): boolean {
  const code = character.codePointAt(0)!;
  for (let index = 0; index < choices.length; index += 1) {
    if (index + 2 < choices.length && choices[index + 1] === '-') {
      const lower = choices[index]!.codePointAt(0)!;
      const upper = choices[index + 2]!.codePointAt(0)!;
      if (lower <= code && code <= upper) {
        return true;
      }
      index += 2;
    } else if (choices[index] === character) {
      return true;
    }
  }
  return false;
}

function containsUnreviewedPlanningEntryPoint(content: string): boolean {
  const commandSurface = normalizeCommandSurface(content);
  return (
    /\b(?:openspec|spectra|opsx)[a-z0-9_-]*/i.test(commandSurface) ||
    /\b(?:xargs|eval|printf|echo|base64|sed|corepack)\b/i.test(
      commandSurface,
    ) ||
    /\b(?:ba|z|da)?sh\s+-c\b/i.test(commandSurface) ||
    /\b(?:node|python\d*|perl|ruby|php|lua|bash|zsh|dash|sh)\b(?=\s+(?:-[a-z]|[<>]\())/i.test(
      commandSurface,
    ) ||
    /[$\\{}]/.test(content) ||
    hasCommandAdaptationSurface(commandSurface)
  );
}

function findCommandLikeSpectraToken(content: string): boolean {
  for (const match of content.matchAll(/\bspectra\b/gi)) {
    const index = match.index;
    const lineStart = content.lastIndexOf('\n', index - 1) + 1;
    const nextNewline = content.indexOf('\n', index);
    const lineEnd = nextNewline === -1 ? content.length : nextNewline;
    const before = content.slice(lineStart, index);
    const after = content.slice(index + 'spectra'.length, lineEnd);
    if (
      /historical name\s*$/i.test(before) &&
      /^\s+(?:also\s+)?appears only as prose[.]?\s*$/i.test(after)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function prospectiveFiles(
  existing: readonly string[],
  planned: readonly string[],
): string[] {
  return [...new Set([...existing, ...planned])].sort();
}

function firstSegmentMatchesNamespace(
  file: string,
  namespace: 'openspec' | 'opsx' | 'spectra',
): boolean {
  const first = file.split('/')[0]!.toLowerCase();
  return first.startsWith(namespace);
}

function assertOpenSpecAssetWriteTarget(
  repositoryRoot: string,
  relativePath: string,
): void {
  const target = safeOpenSpecRepositoryPath(repositoryRoot, relativePath);
  let current = repositoryRoot;
  const parentSegments = path
    .relative(repositoryRoot, path.dirname(target))
    .split(path.sep)
    .filter(Boolean);
  for (const segment of parentSegments) {
    current = path.join(current, segment);
    const stats = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stats) {
      assertOpenSpecAssetParentWritable(path.dirname(current), relativePath);
      return;
    }
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(current) !== current
    ) {
      throw openSpecAssetError(
        'OPENSPEC_ASSET_PATH_UNSAFE',
        'An OpenSpec asset destination parent is unsafe.',
        { relativePath },
      );
    }
  }

  assertOpenSpecAssetParentWritable(current, relativePath);

  const stats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (
    stats &&
    (!stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      fs.realpathSync(target) !== target)
  ) {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_PATH_UNSAFE',
      'An OpenSpec asset destination is unsafe.',
      { relativePath },
    );
  }
  if (stats) {
    try {
      fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK);
    } catch {
      throw openSpecAssetError(
        'OPENSPEC_ASSET_PATH_UNSAFE',
        'An existing OpenSpec asset destination cannot be safely replaced.',
        { relativePath },
      );
    }
  }
}

function assertOpenSpecAssetParentWritable(
  directory: string,
  relativePath: string,
): void {
  try {
    fs.accessSync(directory, fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_PATH_UNSAFE',
      'An OpenSpec asset destination parent is not writable.',
      { relativePath },
    );
  }
}

function safeOpenSpecRepositoryPath(
  repositoryRoot: string,
  relativePath: string,
): string {
  if (
    !relativePath ||
    relativePath.includes('\\') ||
    path.isAbsolute(relativePath) ||
    /^[a-zA-Z]:/.test(relativePath) ||
    relativePath
      .split('/')
      .some(
        (segment) =>
          !segment ||
          segment === '.' ||
          segment === '..' ||
          hasControlCharacters(segment),
      )
  ) {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_PATH_UNSAFE',
      'An OpenSpec asset path is unsafe.',
      { relativePath },
    );
  }
  const target = path.join(repositoryRoot, relativePath);
  const relative = path.relative(repositoryRoot, target);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_PATH_UNSAFE',
      'An OpenSpec asset path escapes the repository.',
      { relativePath },
    );
  }
  return target;
}

function listOptionalPlainFiles(directory: string): string[] {
  const absolute = path.resolve(directory);
  const stats = fs.lstatSync(absolute, {
    throwIfNoEntry: false,
  });
  if (!stats) {
    return [];
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(absolute) !== absolute
  ) {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_PATH_UNSAFE',
      'An optional OpenSpec asset root is unsafe.',
    );
  }
  return listPlainFiles(absolute);
}

function listPlainFiles(directory: string): string[] {
  const root = canonicalOpenSpecAssetDirectory(directory);
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw openSpecAssetError(
          'OPENSPEC_ASSET_PATH_UNSAFE',
          'OpenSpec asset directories may not contain symbolic links.',
        );
      }
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        const stats = fs.lstatSync(absolute);
        if (stats.nlink !== 1 || fs.realpathSync(absolute) !== absolute) {
          throw openSpecAssetError(
            'OPENSPEC_ASSET_PATH_UNSAFE',
            'OpenSpec assets must be canonical single-link plain files.',
          );
        }
        files.push(path.relative(root, absolute).split(path.sep).join('/'));
      } else {
        throw openSpecAssetError(
          'OPENSPEC_ASSET_PATH_UNSAFE',
          'OpenSpec asset directories contain an unsupported entry.',
        );
      }
    }
  };
  visit(root);
  return files.sort();
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function openSpecAssetJsonHasUniqueKeys(content: string): boolean {
  let index = 0;
  const skipWhitespace = (): void => {
    while (/\s/.test(content[index] ?? '')) {
      index += 1;
    }
  };
  const parseString = (): string => {
    const start = index;
    index += 1;
    while (index < content.length) {
      if (content[index] === '\\') {
        index += 2;
      } else if (content[index] === '"') {
        index += 1;
        return JSON.parse(content.slice(start, index)) as string;
      } else {
        index += 1;
      }
    }
    throw new Error('unterminated JSON string');
  };
  const parseValue = (): boolean => {
    skipWhitespace();
    if (content[index] === '{') {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (content[index] === '}') {
        index += 1;
        return true;
      }
      while (index < content.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) {
          return false;
        }
        keys.add(key);
        skipWhitespace();
        index += 1;
        if (!parseValue()) {
          return false;
        }
        skipWhitespace();
        if (content[index] === '}') {
          index += 1;
          return true;
        }
        index += 1;
      }
      return false;
    }
    if (content[index] === '[') {
      index += 1;
      skipWhitespace();
      if (content[index] === ']') {
        index += 1;
        return true;
      }
      while (index < content.length) {
        if (!parseValue()) {
          return false;
        }
        skipWhitespace();
        if (content[index] === ']') {
          index += 1;
          return true;
        }
        index += 1;
      }
      return false;
    }
    if (content[index] === '"') {
      parseString();
      return true;
    }
    while (index < content.length && !/[\s,\]}]/.test(content[index] ?? '')) {
      index += 1;
    }
    return true;
  };

  try {
    const valid = parseValue();
    skipWhitespace();
    return valid && index === content.length;
  } catch {
    return false;
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}
