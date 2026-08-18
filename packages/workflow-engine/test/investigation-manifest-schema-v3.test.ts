import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { sourceRepositoryRoot } from './fixture.ts';

test('the standalone v3 Manifest schema is closed and resolves every local definition', () => {
  const schema = JSON.parse(
    fs.readFileSync(
      path.join(
        sourceRepositoryRoot,
        'workflow/schemas/investigation-manifest-v3.schema.json',
      ),
      'utf8',
    ),
  ) as Record<string, unknown>;
  assert.equal(
    schema.$id,
    'https://expense-app.local/workflow/investigation-manifest-v3.schema.json',
  );
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    'schemaVersion',
    'kind',
    'repositoryId',
    'changeId',
    'investigationId',
    'normalizedIntent',
    'intentDigest',
    'authoring',
    'applicability',
    'investigationApproval',
    'manifestDigest',
  ]);

  const definitions = schema.$defs as Record<string, unknown>;
  assert.ok(definitions.ordinaryApplicability);
  assert.ok(definitions.exemptionApplicability);
  walkSchema(schema, (node) => {
    if (node.$ref !== undefined) {
      assert.equal(typeof node.$ref, 'string');
      const match = /^#\/\$defs\/([^/]+)$/.exec(node.$ref as string);
      assert.ok(match, `only local one-level refs are allowed: ${node.$ref}`);
      assert.ok(definitions[match![1]!], `unresolved schema ref: ${node.$ref}`);
    }
    if (node.type === 'object' && node.properties !== undefined) {
      assert.equal(
        node.additionalProperties,
        false,
        'every structured v3 object must reject unknown properties',
      );
    }
  });
});

function walkSchema(
  value: unknown,
  visit: (node: Record<string, unknown>) => void,
): void {
  if (typeof value !== 'object' || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((entry) => walkSchema(entry, visit));
    return;
  }
  const record = value as Record<string, unknown>;
  visit(record);
  Object.values(record).forEach((entry) => walkSchema(entry, visit));
}
