import fs from 'node:fs';
import path from 'node:path';

import {
  computeProtectedCapabilityEntryDigestsFromWorktree,
  parseProtectedCapabilitiesManifestSource,
  type ProtectedCapabilitiesManifestSource,
} from '../src/adapters/consumer/expense-app/work-registry/protected-capabilities.ts';
import { replaceTextAtomic } from '../src/runtime/repository-transaction/atomic-text.ts';

const MANIFEST_PATH = 'workflow/protected-capabilities.json';

export type ProtectedCapabilitiesGenerationMode = '--check' | '--write';

export function projectProtectedCapabilitiesManifest(
  repositoryRoot: string,
): ProtectedCapabilitiesManifestSource {
  const root = fs.realpathSync(repositoryRoot);
  const source = readManifestSource(root);
  return {
    kind: source.kind,
    schemaVersion: source.schemaVersion,
    manifestPath: source.manifestPath,
    entries: source.entries.map(
      ({ capability, entrypoints, dependencies }) => ({
        capability,
        entrypoints,
        dependencies,
        ...computeProtectedCapabilityEntryDigestsFromWorktree(root, {
          entrypoints,
          dependencies,
        }),
      }),
    ),
  };
}

export async function renderProtectedCapabilitiesManifest(
  repositoryRoot: string,
): Promise<string> {
  return `${JSON.stringify(
    projectProtectedCapabilitiesManifest(repositoryRoot),
    null,
    2,
  )}\n`;
}

export async function generateProtectedCapabilitiesManifest(
  repositoryRoot: string,
  mode: ProtectedCapabilitiesGenerationMode,
): Promise<ProtectedCapabilitiesManifestSource> {
  const root = fs.realpathSync(repositoryRoot);
  const manifestPath = path.join(root, MANIFEST_PATH);
  const expected = await renderProtectedCapabilitiesManifest(root);
  if (mode === '--write') {
    replaceTextAtomic(manifestPath, expected);
  } else {
    const observed = readRegularTextFile(manifestPath);
    if (observed !== expected) {
      throw new Error(
        'Protected capability manifest is stale; run generate-protected-capabilities.ts --write.',
      );
    }
  }
  return parseProtectedCapabilitiesManifestSource(JSON.parse(expected));
}

function readManifestSource(
  repositoryRoot: string,
): ProtectedCapabilitiesManifestSource {
  const manifestPath = path.join(repositoryRoot, MANIFEST_PATH);
  const content = readRegularTextFile(manifestPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new Error('Protected capability manifest is not valid JSON.');
  }
  return parseProtectedCapabilitiesManifestSource(parsed);
}

function readRegularTextFile(filePath: string): string {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    stats === undefined ||
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1
  ) {
    throw new Error('Protected capability manifest path is unsafe.');
  }
  return fs.readFileSync(filePath, 'utf8');
}

function parseMode(
  argv: readonly string[],
): ProtectedCapabilitiesGenerationMode {
  if (argv.length !== 1 || (argv[0] !== '--check' && argv[0] !== '--write')) {
    throw new Error(
      'Usage: generate-protected-capabilities.ts [--check|--write]',
    );
  }
  return argv[0];
}

if (import.meta.main) {
  const mode = parseMode(process.argv.slice(2));
  const manifest = await generateProtectedCapabilitiesManifest(
    process.cwd(),
    mode,
  );
  process.stdout.write(
    `${JSON.stringify({
      command: 'protected-capabilities',
      ok: true,
      mode,
      entries: manifest.entries.length,
    })}\n`,
  );
}
