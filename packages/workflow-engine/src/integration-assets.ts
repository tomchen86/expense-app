import fs from 'node:fs';
import path from 'node:path';

import { checkOpenSpecPlanningAssets } from './openspec-planning-assets.ts';
import {
  readOpenSpecAssetManifest,
  verifyOpenSpecRepositoryAssets,
  verifyOpenSpecRepositoryClosure,
} from './openspec-planning-asset-contract.ts';
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
  const manifest = readOpenSpecAssetManifest(repositoryRoot);
  verifyOpenSpecRepositoryAssets(repositoryRoot, manifest);
  verifyOpenSpecRepositoryClosure(repositoryRoot);
  if (options.regeneratePlanningAssets)
    checkOpenSpecPlanningAssets(repositoryRoot);
}
