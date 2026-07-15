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

export const MANIFEST_PATH = 'workflow/codex-assets/manifest.json';
const OVERLAY_VERSION = 1;
const OVERLAY_POLICY = [
  'planning-only',
  'pnpm-exec-openspec',
  'workflow-implementation-handoff',
  'no-external-stores',
  'no-lifecycle-entrypoints',
  'no-tool-specific-primitives',
  'no-unverified-slash-syntax',
].join('\n');

export const ASSETS = [
  {
    kind: 'skill' as const,
    sourcePath: '.codex/skills/openspec-explore/SKILL.md',
    destinationPath: '.codex/skills/openspec-explore/SKILL.md',
  },
  {
    kind: 'skill' as const,
    sourcePath: '.codex/skills/openspec-propose/SKILL.md',
    destinationPath: '.codex/skills/openspec-propose/SKILL.md',
  },
  {
    kind: 'prompt' as const,
    sourcePath: 'prompts/opsx-explore.md',
    destinationPath: 'workflow/codex-assets/prompts/opsx-explore.md',
  },
  {
    kind: 'prompt' as const,
    sourcePath: 'prompts/opsx-propose.md',
    destinationPath: 'workflow/codex-assets/prompts/opsx-propose.md',
  },
] as const;

type AssetManifestEntry = {
  kind: 'skill' | 'prompt';
  sourcePath: string;
  destinationPath: string;
  sourceDigest: string;
  overlayDigest: string;
};

export type CodexAssetManifest = {
  schemaVersion: 1;
  generator: {
    package: '@fission-ai/openspec';
    version: '1.6.0';
    argv: string[];
    profile: 'custom';
    delivery: 'both';
    workflows: ['explore', 'propose'];
  };
  overlay: { version: 1; policyDigest: string };
  assets: AssetManifestEntry[];
};

export function materializeEntries(
  generated: Map<string, string>,
  formatMarkdown: (content: string) => string,
) {
  return ASSETS.map((asset) => {
    const source = generated.get(asset.sourcePath);
    if (source === undefined) {
      throw assetError(
        'CODEX_ASSET_SOURCE_INVALID',
        'Pinned OpenSpec did not generate the expected Codex source.',
      );
    }
    const content = formatMarkdown(applyReviewedOverlay(source));
    verifyReviewedContent(content);
    return {
      ...asset,
      sourceDigest: digest(source),
      overlayDigest: digest(content),
      content,
    };
  });
}

function applyReviewedOverlay(source: string): string {
  const normalized = source.replaceAll('\r\n', '\n');
  const withoutStore = normalized.replace(
    /^\*\*Store selection:\*\*.*\n\n/m,
    '',
  );
  const adapted = withoutStore
    .replace(/^allowed-tools: Bash\(openspec:\*\)\n/m, '')
    .replace(
      /^compatibility: Requires openspec CLI\.$/m,
      'compatibility: Requires the repository-pinned OpenSpec CLI and workflow engine.',
    )
    .replaceAll('**AskUserQuestion tool**', 'an open-ended question')
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

function verifyReviewedContent(content: string): void {
  const forbidden = [
    /Bash\(openspec:\*\)/,
    /\/opsx:/,
    /--store\b/,
    /(?:AskUserQuestion|TodoWrite) tool/,
    /(?:^|[\s`])(?:npx|pnpm(?! exec))\s+openspec\b/m,
    /(?<!pnpm exec )\bopenspec\s+(?:apply|sync|archive|bulk-archive|store)\b/m,
    /(?<!pnpm exec )\bopenspec\s+(?:list|status|instructions|new|validate|show|doctor|context)\b/m,
  ];
  const matchedForbidden = forbidden.find((pattern) => pattern.test(content));
  if (
    !content.endsWith('\n') ||
    content.includes('\r') ||
    !content.includes('pnpm exec openspec') ||
    !content.includes('pnpm workflow plan-commit') ||
    !content.includes('pnpm workflow start') ||
    matchedForbidden
  ) {
    throw assetError(
      'CODEX_ASSET_FORBIDDEN_AUTHORITY',
      'A Codex asset exposes unreviewed commands, tools, stores, or lifecycle authority.',
      { pattern: matchedForbidden?.source ?? null },
    );
  }
}

export function createManifest(
  entries: Array<{
    kind: 'skill' | 'prompt';
    sourcePath: string;
    destinationPath: string;
    sourceDigest: string;
    overlayDigest: string;
  }>,
): CodexAssetManifest {
  return {
    schemaVersion: 1,
    generator: {
      package: '@fission-ai/openspec',
      version: PINNED_OPENSPEC_VERSION,
      argv: [
        'init',
        '<temporary-project>',
        '--tools',
        'codex',
        '--profile',
        'custom',
        '--force',
      ],
      profile: 'custom',
      delivery: 'both',
      workflows: ['explore', 'propose'],
    },
    overlay: { version: OVERLAY_VERSION, policyDigest: digest(OVERLAY_POLICY) },
    assets: entries.map(
      ({ kind, sourcePath, destinationPath, sourceDigest, overlayDigest }) => ({
        kind,
        sourcePath,
        destinationPath,
        sourceDigest,
        overlayDigest,
      }),
    ),
  };
}

export function readManifest(repositoryRoot: string): CodexAssetManifest {
  let value: unknown;
  try {
    value = JSON.parse(readPlainFile(path.join(repositoryRoot, MANIFEST_PATH)));
  } catch {
    throw assetError(
      'CODEX_ASSET_MANIFEST_INVALID',
      'The Codex planning asset manifest is missing or invalid.',
    );
  }
  if (!isManifest(value)) {
    throw assetError(
      'CODEX_ASSET_MANIFEST_INVALID',
      'The Codex planning asset manifest is missing or invalid.',
    );
  }
  return value;
}

function isManifest(value: unknown): value is CodexAssetManifest {
  if (
    !isRecord(value) ||
    !isRecord(value.generator) ||
    !isRecord(value.overlay)
  ) {
    return false;
  }
  if (
    value.schemaVersion !== 1 ||
    value.generator.package !== '@fission-ai/openspec' ||
    value.generator.version !== PINNED_OPENSPEC_VERSION ||
    value.generator.profile !== 'custom' ||
    value.generator.delivery !== 'both' ||
    JSON.stringify(value.generator.workflows) !==
      JSON.stringify(['explore', 'propose']) ||
    JSON.stringify(value.generator.argv) !==
      JSON.stringify(createManifest([]).generator.argv) ||
    value.overlay.version !== OVERLAY_VERSION ||
    value.overlay.policyDigest !== digest(OVERLAY_POLICY) ||
    !Array.isArray(value.assets) ||
    value.assets.length !== ASSETS.length
  ) {
    return false;
  }
  return value.assets.every((entry, index) => {
    const expected = ASSETS[index];
    return (
      isRecord(entry) &&
      entry.kind === expected?.kind &&
      entry.sourcePath === expected.sourcePath &&
      entry.destinationPath === expected.destinationPath &&
      isDigest(entry.sourceDigest) &&
      isDigest(entry.overlayDigest)
    );
  });
}

export function verifyRepositoryAssets(
  repositoryRoot: string,
  manifest: CodexAssetManifest,
): void {
  for (const asset of manifest.assets) {
    const content = readPlainFile(
      path.join(repositoryRoot, asset.destinationPath),
    );
    verifyReviewedContent(content);
    if (digest(content) !== asset.overlayDigest) {
      throw assetError(
        'CODEX_ASSET_REPOSITORY_DRIFT',
        'A reviewed Codex planning asset differs from its manifest.',
      );
    }
  }
}

export function verifyRepositoryAssetClosure(repositoryRoot: string): void {
  const skillsRoot = path.join(repositoryRoot, '.codex/skills');
  const openSpecSkillFiles = fs.existsSync(skillsRoot)
    ? listPlainFiles(skillsRoot).filter((file) => file.startsWith('openspec-'))
    : [];
  const expectedSkills = ASSETS.filter(({ kind }) => kind === 'skill').map(
    ({ destinationPath }) => destinationPath.replace(/^\.codex\/skills\//, ''),
  );
  if (JSON.stringify(openSpecSkillFiles) !== JSON.stringify(expectedSkills)) {
    throw assetError(
      'CODEX_ASSET_CLOSURE_INVALID',
      'Repository OpenSpec skills contain an unreviewed entry point.',
    );
  }
  assertExactFiles(path.join(repositoryRoot, 'workflow/codex-assets/prompts'), [
    'opsx-explore.md',
    'opsx-propose.md',
  ]);
}

export function assertExactFiles(directory: string, expected: string[]): void {
  const actual = listPlainFiles(directory);
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw assetError(
      'CODEX_ASSET_CLOSURE_INVALID',
      'Generated Codex output contains missing or unreviewed files.',
    );
  }
}

function listPlainFiles(directory: string): string[] {
  const root = canonicalDirectory(directory);
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw assetError(
          'CODEX_ASSET_PATH_UNSAFE',
          'Codex asset directories may not contain symbolic links.',
        );
      }
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        const stats = fs.lstatSync(absolute);
        if (stats.nlink !== 1) {
          throw assetError(
            'CODEX_ASSET_PATH_UNSAFE',
            'Codex assets must be single-link plain files.',
          );
        }
        files.push(path.relative(root, absolute).split(path.sep).join('/'));
      } else {
        throw assetError(
          'CODEX_ASSET_PATH_UNSAFE',
          'Codex asset directories contain an unsupported entry.',
        );
      }
    }
  };
  visit(root);
  return files.sort();
}

export function writeRepositoryFile(
  repositoryRoot: string,
  relativePath: string,
  content: string,
): void {
  const target = safeRepositoryPath(repositoryRoot, relativePath);
  ensurePlainDirectory(path.dirname(target));
  replaceTextAtomic(target, content, { allowCreate: true, defaultMode: 0o644 });
}

function safeRepositoryPath(
  repositoryRoot: string,
  relativePath: string,
): string {
  if (
    !relativePath ||
    relativePath.includes('\\') ||
    path.isAbsolute(relativePath) ||
    relativePath.split('/').some((segment) => !segment || segment === '..')
  ) {
    throw assetError(
      'CODEX_ASSET_PATH_UNSAFE',
      'A Codex asset path is unsafe.',
    );
  }
  const target = path.join(repositoryRoot, relativePath);
  const relative = path.relative(repositoryRoot, target);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw assetError(
      'CODEX_ASSET_PATH_UNSAFE',
      'A Codex asset path escapes the repository.',
    );
  }
  return target;
}

export function readPlainFile(filePath: string): string {
  const absolute = path.resolve(filePath);
  const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    fs.realpathSync(absolute) !== absolute
  ) {
    throw assetError(
      'CODEX_ASSET_PATH_UNSAFE',
      'A Codex asset is missing or is not a canonical plain file.',
    );
  }
  return fs.readFileSync(absolute, 'utf8');
}

export function canonicalDirectory(directory: string): string {
  try {
    const canonical = fs.realpathSync(path.resolve(directory));
    assertPlainDirectory(canonical);
    return canonical;
  } catch {
    throw assetError(
      'CODEX_ASSET_PATH_UNSAFE',
      'A Codex asset directory is missing or unsafe.',
    );
  }
}

function digest(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assetError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return workflowError(code, message, ExitCode.verification, {
    ...(details ? { details } : {}),
  });
}
