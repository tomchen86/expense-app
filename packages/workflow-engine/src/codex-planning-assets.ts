import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { replaceTextAtomic } from './atomic-text.ts';
import {
  ASSETS,
  MANIFEST_PATH,
  assertExactFiles,
  assetError,
  canonicalDirectory,
  createManifest,
  materializeEntries,
  readManifest,
  readPlainFile,
  verifyRepositoryAssetClosure,
  verifyRepositoryAssets,
  writeRepositoryFile,
} from './codex-planning-asset-contract.ts';
import { createTrustedExecutionEnvironment } from './execution-environment.ts';
import { ensurePlainDirectory } from './filesystem-safety.ts';
import { resolveOpenSpecInstallation } from './openspec-executor.ts';
import { resolveCheckRunner } from './runner-resolution.ts';

const EXPECTED_GENERATOR_STDERR =
  '- Setting up Codex...\n✔ Setup complete for Codex\n';

export type CodexPlanningAssetOptions = {
  installationRepositoryRoot?: string;
  callerEnvironment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export function generateCodexPlanningAssets(
  repositoryRoot: string,
  options: CodexPlanningAssetOptions = {},
): { assetPaths: string[]; manifestPath: string } {
  const root = canonicalDirectory(repositoryRoot);
  const format = createDocumentFormatter(
    options.installationRepositoryRoot ?? root,
  );
  const generated = generateUpstreamAssets(root, options);
  const entries = materializeEntries(generated, (content) =>
    format(content, 'markdown'),
  );
  const manifest = createManifest(entries);

  for (const entry of entries) {
    writeRepositoryFile(root, entry.destinationPath, entry.content);
  }
  writeRepositoryFile(
    root,
    MANIFEST_PATH,
    format(`${JSON.stringify(manifest, null, 2)}\n`, 'json'),
  );
  verifyRepositoryAssetClosure(root);
  return {
    assetPaths: entries.map(({ destinationPath }) => destinationPath),
    manifestPath: MANIFEST_PATH,
  };
}

export function checkCodexPlanningAssets(
  repositoryRoot: string,
  options: CodexPlanningAssetOptions = {},
): { valid: true; assetPaths: string[] } {
  const root = canonicalDirectory(repositoryRoot);
  const format = createDocumentFormatter(
    options.installationRepositoryRoot ?? root,
  );
  const manifest = readManifest(root);
  const generated = generateUpstreamAssets(root, options);
  const entries = materializeEntries(generated, (content) =>
    format(content, 'markdown'),
  );
  const expected = createManifest(entries);
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
    throw assetError(
      'CODEX_ASSET_GENERATOR_DRIFT',
      'Generated Codex planning sources or overlay digests have drifted.',
    );
  }
  verifyRepositoryAssets(root, manifest);
  verifyRepositoryAssetClosure(root);
  return {
    valid: true,
    assetPaths: manifest.assets.map(({ destinationPath }) => destinationPath),
  };
}

export function installCodexPlanningPrompts(
  repositoryRoot: string,
  codexHome: string,
): { installedPaths: string[] } {
  const root = canonicalDirectory(repositoryRoot);
  const manifest = readManifest(root);
  verifyRepositoryAssets(root, manifest);
  verifyRepositoryAssetClosure(root);

  const home = canonicalDirectory(codexHome);
  const promptsDirectory = path.join(home, 'prompts');
  ensurePlainDirectory(promptsDirectory);
  const promptEntries = manifest.assets.filter(
    (entry) => entry.kind === 'prompt',
  );
  const targets = promptEntries.map((entry) => ({
    entry,
    path: path.join(promptsDirectory, path.basename(entry.sourcePath)),
  }));
  for (const target of targets) {
    if (fs.lstatSync(target.path, { throwIfNoEntry: false })) {
      throw assetError(
        'CODEX_PROMPT_EXISTS',
        'A Codex planning prompt already exists; the installer never overwrites prompts.',
      );
    }
  }
  for (const target of targets) {
    const source = readPlainFile(path.join(root, target.entry.destinationPath));
    replaceTextAtomic(target.path, source, {
      allowCreate: true,
      defaultMode: 0o600,
    });
  }
  return { installedPaths: targets.map((target) => target.path) };
}

function generateUpstreamAssets(
  repositoryRoot: string,
  options: CodexPlanningAssetOptions,
): Map<string, string> {
  void options.callerEnvironment;
  const installationRoot = options.installationRepositoryRoot ?? repositoryRoot;
  const installation = resolveOpenSpecInstallation(installationRoot);
  const trustedEnvironment = createTrustedExecutionEnvironment();
  const temporaryBase = trustedEnvironment.TMPDIR;
  if (!temporaryBase) {
    throw assetError(
      'CODEX_ASSET_ENVIRONMENT_INVALID',
      'A trusted temporary directory is unavailable.',
    );
  }
  const temporaryRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(temporaryBase), 'workflow-codex-assets-'),
  );
  const project = path.join(temporaryRoot, 'project');
  const home = path.join(temporaryRoot, 'home');
  const config = path.join(temporaryRoot, 'config');
  const data = path.join(temporaryRoot, 'data');
  const codex = path.join(temporaryRoot, 'codex');
  const temporary = path.join(temporaryRoot, 'temp');
  for (const directory of [project, home, config, data, codex, temporary]) {
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
        'codex',
        '--profile',
        'custom',
        '--force',
      ],
      {
        cwd: installation.repositoryRoot,
        shell: false,
        env: {
          ...trustedEnvironment,
          HOME: home,
          XDG_CONFIG_HOME: config,
          XDG_DATA_HOME: data,
          CODEX_HOME: codex,
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
    if (
      result.error ||
      result.signal ||
      result.status !== 0 ||
      decode(result.stderr) !== EXPECTED_GENERATOR_STDERR ||
      Buffer.byteLength(decode(result.stdout)) > maxOutputBytes
    ) {
      throw assetError(
        'CODEX_ASSET_GENERATION_FAILED',
        'Pinned OpenSpec Codex generation did not complete cleanly.',
        {
          status: result.status,
          signal: result.signal,
          errorCode:
            result.error && 'code' in result.error
              ? String(result.error.code)
              : null,
          stderr: decode(result.stderr),
        },
      );
    }

    assertExactFiles(path.join(project, '.codex'), [
      'skills/openspec-explore/SKILL.md',
      'skills/openspec-propose/SKILL.md',
    ]);
    assertExactFiles(codex, [
      'prompts/opsx-explore.md',
      'prompts/opsx-propose.md',
    ]);
    return new Map(
      ASSETS.map((asset) => {
        const sourceRoot = asset.kind === 'skill' ? project : codex;
        return [
          asset.sourcePath,
          readPlainFile(path.join(sourceRoot, asset.sourcePath)),
        ];
      }),
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function createDocumentFormatter(
  repositoryRoot: string,
): (content: string, parser: 'json' | 'markdown') => string {
  const root = canonicalDirectory(repositoryRoot);
  const runner = resolveCheckRunner(root, 'codex-asset-formatter', {
    command: ['node-package-bin', '.', 'prettier', 'prettier'],
    destructiveDatabase: false,
  });
  return (content, parser) => {
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
    if (
      result.error ||
      result.signal ||
      result.status !== 0 ||
      decode(result.stderr) !== '' ||
      Buffer.byteLength(decode(result.stdout)) > maxOutputBytes
    ) {
      throw assetError(
        'CODEX_ASSET_FORMAT_FAILED',
        'The declared repository formatter did not produce a reviewed asset.',
      );
    }
    return decode(result.stdout);
  };
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw assetError(
      'CODEX_ASSET_LIMIT_INVALID',
      'Codex asset process limits must be positive safe integers.',
    );
  }
  return value;
}

function decode(value: Buffer | string | null): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.isBuffer(value) ? value : Buffer.from(value ?? ''),
    );
  } catch {
    throw assetError(
      'CODEX_ASSET_GENERATION_FAILED',
      'Pinned OpenSpec Codex generation emitted invalid UTF-8.',
    );
  }
}
