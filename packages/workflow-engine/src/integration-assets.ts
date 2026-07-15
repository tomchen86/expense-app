import fs from 'node:fs';
import path from 'node:path';

import { checkCodexPlanningAssets } from './codex-planning-assets.ts';
import {
  MANIFEST_PATH,
  readManifest,
  verifyRepositoryAssetClosure,
  verifyRepositoryAssets,
} from './codex-planning-asset-contract.ts';
import { inspectOpenSpecSchemaContract } from './openspec-schema-contract.ts';

export function validateWorkflowIntegrationAssets(
  repositoryRoot: string,
  options: { regeneratePlanningAssets?: boolean } = {},
): void {
  const installationPresent = fs.existsSync(
    path.join(repositoryRoot, 'node_modules/@fission-ai/openspec/package.json'),
  );
  if (installationPresent || options.regeneratePlanningAssets) {
    inspectOpenSpecSchemaContract(repositoryRoot);
  }
  if (!fs.existsSync(path.join(repositoryRoot, MANIFEST_PATH))) return;
  const manifest = readManifest(repositoryRoot);
  verifyRepositoryAssets(repositoryRoot, manifest);
  verifyRepositoryAssetClosure(repositoryRoot);
  if (options.regeneratePlanningAssets)
    checkCodexPlanningAssets(repositoryRoot);
}
