import crypto from 'node:crypto';

import type { ChecksConfig } from './contracts.ts';

export function digestRequiredCheckDefinitions(
  checks: ChecksConfig,
  checkIds: string[],
): Record<string, string> {
  return Object.fromEntries(
    checkIds.map((checkId) => [
      checkId,
      crypto
        .createHash('sha256')
        .update(JSON.stringify(checks.checks[checkId]))
        .digest('hex'),
    ]),
  );
}
