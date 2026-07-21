import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  OPENSPEC_ASSET_MANIFEST_PATH,
  OPENSPEC_SOURCE_CLOSURES,
  canonicalOpenSpecAssetDirectory,
  createOpenSpecAssetManifest,
  materializeOpenSpecFinalEntries,
  materializeOpenSpecReviewedEntries,
  openSpecAssetError,
  openSpecAssetJsonHasUniqueKeys,
  readOpenSpecAssetFile,
  readOpenSpecAssetManifest,
  verifyOpenSpecManifestReviewedEntries,
  verifyOpenSpecRepositoryClosure,
  verifyOpenSpecRepositoryWritePlan,
  verifyOpenSpecRepositoryAssets,
  writeOpenSpecAssetFile,
  assertExactOpenSpecAssetFiles,
  type OpenSpecFormatterMetadata,
} from './openspec-planning-asset-contract.ts';
import { createTrustedExecutionEnvironment } from './execution-environment.ts';
import { resolveOpenSpecInstallation } from './openspec-executor.ts';
import { resolveCheckRunner } from './runner-resolution.ts';

const EXPECTED_GENERATOR_STDERR =
  '- Setting up Codex...\n' +
  '✔ Setup complete for Codex\n' +
  '- Setting up Claude Code...\n' +
  '✔ Setup complete for Claude Code\n';
const EXPECTED_GENERATOR_STDOUT =
  '- Creating OpenSpec structure...\n' +
  '▌ OpenSpec structure created\n' +
  '\n' +
  'OpenSpec Setup Complete\n' +
  '\n' +
  'Created: Codex, Claude Code\n' +
  '2 skills and 2 commands in .codex, .claude/\n' +
  'Config: openspec/config.yaml (schema: spec-driven)\n' +
  '\n' +
  'Getting started:\n' +
  '  Start your first change: /opsx:propose "your idea"\n' +
  '\n' +
  'Learn more: https://github.com/Fission-AI/OpenSpec\n' +
  'Feedback:   https://github.com/Fission-AI/OpenSpec/issues\n' +
  '\n' +
  'Restart your IDE for slash commands to take effect.\n' +
  '\n';
const FORMATTER_RUNNER_DEFINITION: {
  command: string[];
  destructiveDatabase: false;
} = {
  command: ['node-package-bin', '.', 'prettier', 'prettier'],
  destructiveDatabase: false,
} as const;

export type OpenSpecPlanningAssetOptions = {
  installationRepositoryRoot?: string;
  formatterRepositoryRoot?: string;
  callerEnvironment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export function generateOpenSpecPlanningAssets(
  repositoryRoot: string,
  options: OpenSpecPlanningAssetOptions = {},
): { assetPaths: string[]; manifestPath: string } {
  const root = canonicalOpenSpecAssetDirectory(repositoryRoot);
  verifyOpenSpecRepositoryWritePlan(root);
  const formatter = createAssetFormatter(
    options.formatterRepositoryRoot ?? root,
  );
  const generated = generateUpstreamAssets(root, options);
  const reviewed = materializeOpenSpecReviewedEntries(generated);
  const entries = materializeOpenSpecFinalEntries(
    reviewed,
    formatter.formatMarkdown,
  );
  const manifest = createOpenSpecAssetManifest(entries, formatter.metadata);
  const formattedManifest = formatter.formatJson(
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  assertFormatterPreservedManifest(manifest, formattedManifest);

  for (const entry of entries) {
    writeOpenSpecAssetFile(root, entry.destinationPath, entry.content);
  }
  writeOpenSpecAssetFile(root, OPENSPEC_ASSET_MANIFEST_PATH, formattedManifest);
  const trackedManifest = readOpenSpecAssetManifest(root);
  verifyOpenSpecManifestReviewedEntries(trackedManifest, reviewed);
  verifyOpenSpecRepositoryAssets(root, trackedManifest);
  verifyOpenSpecRepositoryClosure(root);
  return {
    assetPaths: entries.map((entry) => entry.destinationPath),
    manifestPath: OPENSPEC_ASSET_MANIFEST_PATH,
  };
}

export function checkOpenSpecPlanningAssets(
  repositoryRoot: string,
  options: OpenSpecPlanningAssetOptions = {},
): { valid: true; assetPaths: string[] } {
  const root = canonicalOpenSpecAssetDirectory(repositoryRoot);
  const manifest = readOpenSpecAssetManifest(root);
  const generated = generateUpstreamAssets(root, options);
  const reviewed = materializeOpenSpecReviewedEntries(generated);

  verifyOpenSpecManifestReviewedEntries(manifest, reviewed);
  verifyOpenSpecRepositoryAssets(root, manifest);
  verifyOpenSpecRepositoryClosure(root);
  return {
    valid: true,
    assetPaths: manifest.assets.map((entry) => entry.destinationPath),
  };
}

function generateUpstreamAssets(
  repositoryRoot: string,
  options: OpenSpecPlanningAssetOptions,
): Map<string, string> {
  void options.callerEnvironment;
  const installation = resolveOpenSpecInstallation(
    options.installationRepositoryRoot ?? repositoryRoot,
  );
  const trustedEnvironment = createTrustedExecutionEnvironment();
  const temporaryBase = trustedEnvironment.TMPDIR;
  if (!temporaryBase) {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_ENVIRONMENT_INVALID',
      'A trusted temporary directory is unavailable.',
    );
  }
  const temporaryRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(temporaryBase), 'workflow-openspec-assets-'),
  );
  const project = path.join(temporaryRoot, 'project');
  const home = path.join(temporaryRoot, 'home');
  const config = path.join(temporaryRoot, 'config');
  const data = path.join(temporaryRoot, 'data');
  const codexHome = path.join(temporaryRoot, 'codex-home');
  const temporary = path.join(temporaryRoot, 'temp');
  for (const directory of [project, home, config, data, codexHome, temporary]) {
    fs.mkdirSync(directory);
  }
  const openspecConfig = path.join(config, 'openspec');
  fs.mkdirSync(openspecConfig);
  fs.writeFileSync(
    path.join(openspecConfig, 'config.json'),
    `${JSON.stringify(
      {
        featureFlags: {},
        profile: 'custom',
        delivery: 'both',
        workflows: ['explore', 'propose'],
      },
      null,
      2,
    )}\n`,
  );

  try {
    const maxOutputBytes = positiveLimit(
      options.maxOutputBytes ?? 8 * 1024 * 1024,
    );
    const result = spawnSync(
      fs.realpathSync(process.execPath),
      [
        installation.binPath,
        'init',
        project,
        '--tools',
        'codex,claude',
        '--profile',
        'custom',
        '--force',
      ],
      {
        cwd: temporaryRoot,
        shell: false,
        env: {
          ...trustedEnvironment,
          HOME: home,
          XDG_CONFIG_HOME: config,
          XDG_DATA_HOME: data,
          CODEX_HOME: codexHome,
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
          CI: 'true',
          OPENSPEC_TELEMETRY: '0',
          DO_NOT_TRACK: '1',
          OPENSPEC_NO_COMPLETIONS: '1',
          NO_COLOR: '1',
        },
        encoding: 'buffer',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: positiveLimit(options.timeoutMs ?? 30_000),
        maxBuffer: maxOutputBytes,
        killSignal: 'SIGKILL',
      },
    );
    const stdout = decodeProcessOutput(
      result.stdout,
      'OPENSPEC_ASSET_GENERATION_FAILED',
      'Pinned OpenSpec generation emitted invalid UTF-8.',
    );
    const stderr = decodeProcessOutput(
      result.stderr,
      'OPENSPEC_ASSET_GENERATION_FAILED',
      'Pinned OpenSpec generation emitted invalid UTF-8.',
    );
    if (
      result.error ||
      result.signal ||
      result.status !== 0 ||
      stderr !== EXPECTED_GENERATOR_STDERR ||
      stdout !== EXPECTED_GENERATOR_STDOUT ||
      Buffer.byteLength(stdout) > maxOutputBytes
    ) {
      throw openSpecAssetError(
        'OPENSPEC_ASSET_GENERATION_FAILED',
        'Pinned OpenSpec tool-plural generation did not complete cleanly.',
        {
          status: result.status,
          signal: result.signal,
          errorCode:
            result.error && 'code' in result.error
              ? String(result.error.code)
              : null,
          stderr,
        },
      );
    }

    const roots = new Map([
      ['temporary-project', project],
      ['isolated-codex-home', codexHome],
    ]);
    for (const closure of OPENSPEC_SOURCE_CLOSURES) {
      const sourceRoot = roots.get(closure.root);
      if (!sourceRoot) {
        throw openSpecAssetError(
          'OPENSPEC_ASSET_MANIFEST_INVALID',
          'An OpenSpec source closure has an unknown root.',
        );
      }
      assertExactOpenSpecAssetFiles(sourceRoot, closure.files);
    }

    const generated = new Map<string, string>();
    for (const closure of OPENSPEC_SOURCE_CLOSURES) {
      const sourceRoot = roots.get(closure.root)!;
      for (const sourcePath of closure.files) {
        generated.set(
          `${closure.root}/${sourcePath}`,
          readOpenSpecAssetFile(path.join(sourceRoot, sourcePath)),
        );
      }
    }
    return generated;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function createAssetFormatter(repositoryRoot: string): {
  metadata: OpenSpecFormatterMetadata;
  formatMarkdown: (content: string) => string;
  formatJson: (content: string) => string;
} {
  const root = canonicalOpenSpecAssetDirectory(repositoryRoot);
  const runner = resolveCheckRunner(
    root,
    'openspec-asset-formatter',
    FORMATTER_RUNNER_DEFINITION,
  );
  if (runner.runner !== 'node-package-bin:.:prettier/prettier') {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_FORMAT_FAILED',
      'The resolved repository formatter identity is unexpected.',
    );
  }
  const format = (content: string, parser: 'json' | 'markdown'): string => {
    const maxOutputBytes = 8 * 1024 * 1024;
    const result = spawnSync(
      runner.executable,
      [...runner.args, '--parser', parser],
      {
        cwd: root,
        shell: false,
        env: createTrustedExecutionEnvironment(),
        input: Buffer.from(content),
        encoding: 'buffer',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
        maxBuffer: maxOutputBytes,
        killSignal: 'SIGKILL',
      },
    );
    const stdout = decodeProcessOutput(
      result.stdout,
      'OPENSPEC_ASSET_FORMAT_FAILED',
      'The declared repository formatter emitted invalid UTF-8.',
    );
    if (
      result.error ||
      result.signal ||
      result.status !== 0 ||
      decodeProcessOutput(
        result.stderr,
        'OPENSPEC_ASSET_FORMAT_FAILED',
        'The declared repository formatter emitted invalid UTF-8.',
      ) !== '' ||
      Buffer.byteLength(stdout) > maxOutputBytes
    ) {
      throw openSpecAssetError(
        'OPENSPEC_ASSET_FORMAT_FAILED',
        'The declared repository formatter did not produce a reviewed asset.',
      );
    }
    return stdout;
  };
  return {
    metadata: {
      runner: 'node-package-bin:.:prettier/prettier',
      configurationDigest: formatterConfigurationDigest(root, runner.digest),
      assetParser: 'markdown',
      manifestParser: 'json',
    },
    formatMarkdown: (content) => format(content, 'markdown'),
    formatJson: (content) => format(content, 'json'),
  };
}

function assertFormatterPreservedManifest(
  expected: unknown,
  formatted: string,
): void {
  let actual: unknown;
  try {
    actual = JSON.parse(formatted) as unknown;
  } catch {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_FORMAT_FAILED',
      'The formatter produced an invalid OpenSpec asset manifest.',
    );
  }
  if (
    !openSpecAssetJsonHasUniqueKeys(formatted) ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  ) {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_FORMAT_FAILED',
      'The formatter changed the OpenSpec asset manifest semantics.',
    );
  }
}

function formatterConfigurationDigest(
  repositoryRoot: string,
  runnerDigest: string,
): string {
  const candidates = [
    '.editorconfig',
    '.prettierrc',
    '.prettierrc.cjs',
    '.prettierrc.cts',
    '.prettierrc.js',
    'prettier.config.cjs',
    'prettier.config.js',
    'prettier.config.cts',
    'prettier.config.mjs',
    'prettier.config.mts',
    'prettier.config.ts',
    '.prettierrc.json',
    '.prettierrc.json5',
    '.prettierrc.mjs',
    '.prettierrc.mts',
    '.prettierrc.toml',
    '.prettierrc.ts',
    '.prettierrc.yaml',
    '.prettierrc.yml',
    'package.json',
    'package.yaml',
  ].sort();
  const hash = crypto.createHash('sha256');
  hash.update('runner\0');
  hash.update(runnerDigest);
  for (const relativePath of candidates) {
    const candidate = path.join(repositoryRoot, relativePath);
    if (fs.lstatSync(candidate, { throwIfNoEntry: false })) {
      const content = readOpenSpecAssetFile(candidate);
      hash.update('\0config\0');
      hash.update(relativePath);
      hash.update('\0');
      hash.update(String(Buffer.byteLength(content)));
      hash.update('\0');
      hash.update(content);
    }
  }
  return hash.digest('hex');
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw openSpecAssetError(
      'OPENSPEC_ASSET_LIMIT_INVALID',
      'OpenSpec asset process limits must be positive safe integers.',
    );
  }
  return value;
}

function decodeProcessOutput(
  value: Buffer | string | null,
  code: string,
  message: string,
): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Buffer.isBuffer(value) ? value : Buffer.from(value ?? ''),
    );
  } catch {
    throw openSpecAssetError(code, message);
  }
}
