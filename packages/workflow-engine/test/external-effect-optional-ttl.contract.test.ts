import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalExternalEffectGrantPayload,
  EXTERNAL_EFFECT_MAX_TTL_SECONDS,
  EXTERNAL_EFFECT_SIGNATURE_NAMESPACE,
  issueExternalEffectGrant,
  type ExternalEffectGrantRequest,
} from '../src/external-effect-grant.ts';
import {
  EFFECT_GRANT_ID,
  EFFECT_ISSUED_AT,
  prepareExternalEffectFixture,
  publishGrantRequest,
} from './external-effect-fixture.ts';
import {
  createFixtureRepository,
  isWorkflowError,
  sourceRepositoryRoot,
} from './fixture.ts';

test('omitted external-effect TTL is code-owned through signing and durable publication', () => {
  const fixture = prepareExternalEffectFixture();
  try {
    const request = requestWithoutTtl(fixture);
    assert.equal(Object.hasOwn(request, 'ttlSeconds'), false);

    const result = issueExternalEffectGrant(fixture.repository, request, {
      onAuditRecord: fixture.audit,
      grantId: EFFECT_GRANT_ID,
      now: EFFECT_ISSUED_AT,
      signer: fixture.signer,
    });

    assert.equal(Object.hasOwn(request, 'ttlSeconds'), false);
    assert.equal(
      result.envelope.payload.expiresAt,
      new Date(
        EFFECT_ISSUED_AT.getTime() + EXTERNAL_EFFECT_MAX_TTL_SECONDS * 1000,
      ).toISOString(),
    );
    assert.equal(
      fixture.signedByDomain
        .get(EXTERNAL_EFFECT_SIGNATURE_NAMESPACE)
        ?.has(canonicalExternalEffectGrantPayload(result.envelope.payload)),
      true,
    );

    const persisted = JSON.parse(
      fs.readFileSync(result.recordPath, 'utf8'),
    ) as {
      envelope: { payload: { expiresAt: string } };
    };
    assert.equal(
      persisted.envelope.payload.expiresAt,
      result.envelope.payload.expiresAt,
    );
  } finally {
    fixture.dispose();
  }
});

test('explicit external-effect TTL preserves exact 1..300 bounds and fails closed outside them', () => {
  for (const ttlSeconds of [1, EXTERNAL_EFFECT_MAX_TTL_SECONDS]) {
    const fixture = prepareExternalEffectFixture();
    try {
      const result = issueExternalEffectGrant(
        fixture.repository,
        { ...publishGrantRequest(fixture), ttlSeconds },
        {
          onAuditRecord: fixture.audit,
          grantId: EFFECT_GRANT_ID,
          now: EFFECT_ISSUED_AT,
          signer: fixture.signer,
        },
      );
      assert.equal(
        result.envelope.payload.expiresAt,
        new Date(EFFECT_ISSUED_AT.getTime() + ttlSeconds * 1000).toISOString(),
      );
    } finally {
      fixture.dispose();
    }
  }

  for (const ttlSeconds of [0, EXTERNAL_EFFECT_MAX_TTL_SECONDS + 1]) {
    const fixture = prepareExternalEffectFixture();
    try {
      assert.throws(
        () =>
          issueExternalEffectGrant(
            fixture.repository,
            { ...publishGrantRequest(fixture), ttlSeconds },
            {
              onAuditRecord: fixture.audit,
              grantId: EFFECT_GRANT_ID,
              now: EFFECT_ISSUED_AT,
              signer: fixture.signer,
            },
          ),
        (error) => isWorkflowError(error, 'EXTERNAL_EFFECT_GRANT_INVALID'),
      );
    } finally {
      fixture.dispose();
    }
  }
});

test('external-effect TTL distinguishes an omitted property from an own undefined value', () => {
  const fixture = prepareExternalEffectFixture();
  try {
    const request = requestWithoutTtl(fixture);
    Object.defineProperty(request, 'ttlSeconds', {
      configurable: true,
      enumerable: true,
      value: undefined,
      writable: true,
    });
    assert.equal(Object.hasOwn(request, 'ttlSeconds'), true);

    assert.throws(
      () =>
        issueExternalEffectGrant(fixture.repository, request, {
          onAuditRecord: fixture.audit,
          grantId: EFFECT_GRANT_ID,
          now: EFFECT_ISSUED_AT,
          signer: fixture.signer,
        }),
      (error) => isWorkflowError(error, 'EXTERNAL_EFFECT_GRANT_INVALID'),
    );
  } finally {
    fixture.dispose();
  }
});

test('external-effect TTL never inherits authority from the request prototype', () => {
  const fixture = prepareExternalEffectFixture();
  try {
    const ownRequest = requestWithoutTtl(fixture);
    const request = Object.assign(
      Object.create({ ttlSeconds: 1 }) as ExternalEffectGrantRequest,
      ownRequest,
    );
    assert.equal(Object.hasOwn(request, 'ttlSeconds'), false);
    assert.equal(request.ttlSeconds, 1);

    assert.throws(
      () =>
        issueExternalEffectGrant(fixture.repository, request, {
          onAuditRecord: fixture.audit,
          grantId: EFFECT_GRANT_ID,
          now: EFFECT_ISSUED_AT,
          signer: fixture.signer,
        }),
      (error) => isWorkflowError(error, 'EXTERNAL_EFFECT_GRANT_INVALID'),
    );
  } finally {
    fixture.dispose();
  }
});

test('external-effect CLI accepts only canonical decimal integer TTL tokens', () => {
  const repository = createFixtureRepository();
  try {
    for (const ttlToken of ['1.5', '300junk', '+1', '01']) {
      const result = runExternalEffectIssueCli(repository, ttlToken);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(cliErrorCode(result.stderr), 'INVALID_USAGE');
    }

    for (const ttlToken of ['1', '300']) {
      const result = runExternalEffectIssueCli(repository, ttlToken);
      assert.equal(
        cliErrorCode(result.stderr),
        'TASK_MANDATE_NOT_FOUND',
        result.stderr,
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function requestWithoutTtl(fixture: {
  repository: string;
  binding: ExternalEffectGrantRequest['mandateBinding'];
}): ExternalEffectGrantRequest {
  const request = publishGrantRequest(fixture);
  assert.equal(Reflect.deleteProperty(request, 'ttlSeconds'), true);
  return request;
}

function runExternalEffectIssueCli(repository: string, ttlToken: string) {
  const digest = `sha256:${'0'.repeat(64)}`;
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
      'external-effect',
      'issue',
      '--grant',
      EFFECT_GRANT_ID,
      '--task',
      'missing-external-effect-task',
      '--kind',
      'publish-git-ref',
      '--target-file',
      'missing-target.json',
      '--artifact-digest',
      digest,
      '--prestate-digest',
      digest,
      '--rollback-plan-file',
      'none',
      '--idempotency-key',
      'ttl-parser-contract',
      '--ttl-seconds',
      ttlToken,
      '--json',
    ],
    { cwd: repository, encoding: 'utf8' },
  );
}

function cliErrorCode(stderr: string): string | undefined {
  return (JSON.parse(stderr) as { error?: { code?: string } }).error?.code;
}
