import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTHORITY_ATTESTATION_TAG_PREFIX,
  authorityAttestationTagRef,
  canonicalAttestationEnvelope,
  canonicalAttestationPayload,
  parseAuthorityAttestationEnvelope,
  validateAttestedTransitionPair,
  validateAuthorityTransitionIdentity,
  type AttestedCommitFacts,
  type AuthorityAttestationEnvelope,
  type AuthorityAttestationPayload,
} from '../src/authority-attestation.ts';
import { WorkflowError } from '../src/errors.ts';

const PRIMARY_GRANT = '402b4c86-4b97-4c69-8c5c-bba5995b4387';
const BASE_GRANT_A = '049a929b-2b42-47f1-bbbb-3327e8df4350';
const BASE_GRANT_B = '0eadc18e-a772-41af-a4e1-e7befc6a2660';
const SIGNATURE =
  '-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQAAADMAAAAL\n-----END SSH SIGNATURE-----\n';

const AUTHORITY_MESSAGE =
  'Validate break-glass maintainer authority\n' +
  '\n' +
  'Change: pilot-break-glass-maintainer-authority\n' +
  'Transition: authority-maintenance\n' +
  `Grant: ${PRIMARY_GRANT}\n`;

const PLAN_MESSAGE =
  'Plan pilot-break-glass-maintainer-authority\n' +
  '\n' +
  'Change: pilot-break-glass-maintainer-authority\n' +
  'Transition: plan\n';

function oid(character: string): string {
  return character.repeat(40);
}

function validPayload(): AuthorityAttestationPayload {
  return {
    version: 1,
    grantId: PRIMARY_GRANT,
    repositoryId: 'github:R_kgDOOotVag',
    repositoryOrigin: 'https://github.com/tomchen86/expense-app.git',
    protectedBranch: 'main',
    originalCommit: oid('a'),
    mainCommit: oid('b'),
    grantBases: [
      {
        originalBase: oid('c'),
        mainBase: oid('d'),
        grantIds: [BASE_GRANT_A, BASE_GRANT_B],
      },
      {
        originalBase: oid('e'),
        mainBase: oid('f'),
        grantIds: [PRIMARY_GRANT],
      },
    ],
    policyBlob: oid('9'),
    issuedAt: '2026-07-17T04:00:00.000Z',
    signer: 'tomchen86',
  };
}

function validEnvelope(): AuthorityAttestationEnvelope {
  return { payload: validPayload(), signature: SIGNATURE };
}

function facts(overrides: Partial<AttestedCommitFacts>): AttestedCommitFacts {
  return {
    oid: oid('a'),
    tree: oid('1'),
    parentOids: [oid('2')],
    parentTree: oid('3'),
    message: AUTHORITY_MESSAGE,
    ...overrides,
  };
}

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}

test('attestation envelope round-trips through its canonical serialization', () => {
  const envelope = validEnvelope();
  const raw = canonicalAttestationEnvelope(envelope);

  assert.ok(raw.endsWith('\n'));
  assert.deepEqual(parseAuthorityAttestationEnvelope(raw), envelope);
  assert.equal(
    canonicalAttestationEnvelope(parseAuthorityAttestationEnvelope(raw)),
    raw,
  );
});

test('attestation tag names derive only from a valid primary grant', () => {
  assert.equal(
    authorityAttestationTagRef(PRIMARY_GRANT),
    `${AUTHORITY_ATTESTATION_TAG_PREFIX}${PRIMARY_GRANT}`,
  );
  for (const grantId of ['', 'not-a-grant', PRIMARY_GRANT.toUpperCase()]) {
    assert.throws(
      () => authorityAttestationTagRef(grantId),
      (error) => isWorkflowError(error, 'AUTHORITY_ATTESTATION_INVALID'),
      grantId,
    );
  }
});

test('attestation parser rejects every ambiguous or noncanonical encoding', () => {
  const canonical = canonicalAttestationEnvelope(validEnvelope());
  const mutate = (
    change: (payload: Record<string, unknown>) => void,
  ): string => {
    const value = JSON.parse(canonical) as {
      payload: Record<string, unknown>;
      signature: string;
    };
    change(value.payload);
    return `${JSON.stringify(value)}\n`;
  };
  const invalidEncodings: Array<[string, string]> = [
    ['not json', 'not-json'],
    ['oversized envelope', `${' '.repeat(40_000)}${canonical}`],
    ['missing trailing newline', canonical.slice(0, -1)],
    ['reordered keys', mutateEnvelopeKeyOrder(canonical)],
    ['whitespace variant', canonical.replace('{"payload"', '{ "payload"')],
    [
      'extra payload field',
      mutate((payload) => {
        payload.extra = true;
      }),
    ],
    [
      'missing payload field',
      mutate((payload) => {
        delete payload.policyBlob;
      }),
    ],
    [
      'wrong version',
      mutate((payload) => {
        payload.version = 2;
      }),
    ],
    [
      'partial object id',
      mutate((payload) => {
        payload.originalCommit = 'abc123';
      }),
    ],
    [
      'uppercase object id',
      mutate((payload) => {
        payload.mainCommit = 'B'.repeat(40);
      }),
    ],
    [
      'identical original and main commits',
      mutate((payload) => {
        payload.mainCommit = payload.originalCommit;
      }),
    ],
    [
      'invalid grant id',
      mutate((payload) => {
        payload.grantId = 'grant';
      }),
    ],
    [
      'invalid repository id',
      mutate((payload) => {
        payload.repositoryId = 'gitlab:thing';
      }),
    ],
    [
      'invalid origin',
      mutate((payload) => {
        payload.repositoryOrigin = 'git@github.com:tomchen86/expense-app.git';
      }),
    ],
    [
      'invalid branch',
      mutate((payload) => {
        payload.protectedBranch = 'refs/heads/../main';
      }),
    ],
    [
      'invalid timestamp',
      mutate((payload) => {
        payload.issuedAt = '2026-07-17T04:00:00Z';
      }),
    ],
    [
      'invalid signer',
      mutate((payload) => {
        payload.signer = '-leading-dash';
      }),
    ],
    [
      'grant bases unsorted',
      mutate((payload) => {
        (payload.grantBases as unknown[]).reverse();
      }),
    ],
    [
      'duplicate original base',
      mutate((payload) => {
        const bases = payload.grantBases as Array<Record<string, unknown>>;
        bases[1].originalBase = bases[0].originalBase;
      }),
    ],
    [
      'duplicate main base',
      mutate((payload) => {
        const bases = payload.grantBases as Array<Record<string, unknown>>;
        bases[1].mainBase = bases[0].mainBase;
      }),
    ],
    [
      'grant base maps a commit to itself',
      mutate((payload) => {
        const bases = payload.grantBases as Array<Record<string, unknown>>;
        bases[0].mainBase = bases[0].originalBase;
      }),
    ],
    [
      'grant base with no grants',
      mutate((payload) => {
        (payload.grantBases as Array<Record<string, unknown>>)[0].grantIds = [];
      }),
    ],
    [
      'unsorted grant ids',
      mutate((payload) => {
        const bases = payload.grantBases as Array<Record<string, unknown>>;
        bases[0].grantIds = [BASE_GRANT_B, BASE_GRANT_A];
      }),
    ],
    [
      'duplicate grant ids',
      mutate((payload) => {
        const bases = payload.grantBases as Array<Record<string, unknown>>;
        bases[0].grantIds = [BASE_GRANT_A, BASE_GRANT_A];
      }),
    ],
    [
      'grant base entry with extra field',
      mutate((payload) => {
        const bases = payload.grantBases as Array<Record<string, unknown>>;
        bases[0].note = 'extra';
      }),
    ],
  ];

  for (const [name, raw] of invalidEncodings) {
    assert.throws(
      () => parseAuthorityAttestationEnvelope(raw),
      (error) => isWorkflowError(error, 'AUTHORITY_ATTESTATION_INVALID'),
      name,
    );
  }
});

test('attestation parser rejects a malformed signature block', () => {
  for (const signature of [
    'not-armored',
    '-----BEGIN SSH SIGNATURE-----\nU1NI U0lH\n-----END SSH SIGNATURE-----\n',
    '-----BEGIN SSH SIGNATURE-----\r\nU1NIU0lH\r\n-----END SSH SIGNATURE-----\n',
    `-----BEGIN SSH SIGNATURE-----\n${'A'.repeat(20_000)}\n-----END SSH SIGNATURE-----\n`,
  ]) {
    const raw = `${JSON.stringify({
      payload: JSON.parse(canonicalAttestationPayload(validPayload())),
      signature,
    })}\n`;
    assert.throws(
      () => parseAuthorityAttestationEnvelope(raw),
      (error) =>
        isWorkflowError(error, 'AUTHORITY_ATTESTATION_INVALID') ||
        isWorkflowError(error, 'MAINTAINER_SIGNATURE_INVALID'),
    );
  }
});

test('an attested transition pair proves the same single-parent transition', () => {
  const original = facts({ oid: oid('a') });
  const main = facts({ oid: oid('b'), parentOids: [oid('4')] });

  const trailers = validateAttestedTransitionPair(original, main);
  assert.deepEqual(trailers, {
    kind: 'authority',
    changeId: 'pilot-break-glass-maintainer-authority',
    transition: 'authority-maintenance',
    grantId: PRIMARY_GRANT,
  });

  const planPair = validateAttestedTransitionPair(
    facts({ oid: oid('a'), message: PLAN_MESSAGE }),
    facts({ oid: oid('b'), message: PLAN_MESSAGE }),
  );
  assert.equal(planPair.kind, 'plan');
});

test('transition pairs fail closed on every identity mismatch', () => {
  const cases: Array<[string, AttestedCommitFacts, AttestedCommitFacts]> = [
    ['identical commit ids', facts({}), facts({})],
    [
      'different result trees',
      facts({ oid: oid('a') }),
      facts({ oid: oid('b'), tree: oid('5') }),
    ],
    [
      'root commit',
      facts({ oid: oid('a'), parentOids: [], parentTree: undefined }),
      facts({ oid: oid('b') }),
    ],
    [
      'merge commit',
      facts({ oid: oid('a') }),
      facts({ oid: oid('b'), parentOids: [oid('2'), oid('6')] }),
    ],
    [
      'different parent trees',
      facts({ oid: oid('a') }),
      facts({ oid: oid('b'), parentTree: oid('7') }),
    ],
    [
      'missing parent tree',
      facts({ oid: oid('a'), parentTree: undefined }),
      facts({ oid: oid('b') }),
    ],
    [
      'byte-different messages',
      facts({ oid: oid('a') }),
      facts({ oid: oid('b'), message: `${AUTHORITY_MESSAGE} ` }),
    ],
    [
      'unmanaged message',
      facts({ oid: oid('a'), message: 'Ordinary commit\n' }),
      facts({ oid: oid('b'), message: 'Ordinary commit\n' }),
    ],
    [
      'malformed managed trailer block',
      facts({ oid: oid('a'), message: 'Bad\n\nChange: demo\nTask: one\n' }),
      facts({ oid: oid('b'), message: 'Bad\n\nChange: demo\nTask: one\n' }),
    ],
    ['invalid object id', facts({ oid: 'short' }), facts({ oid: oid('b') })],
  ];

  for (const [name, original, main] of cases) {
    assert.throws(
      () => validateAttestedTransitionPair(original, main),
      (error) => isWorkflowError(error, 'AUTHORITY_TRANSITION_MISMATCH'),
      name,
    );
  }
});

test('authority transition identity requires the authority transition kind', () => {
  const identity = validateAuthorityTransitionIdentity(
    facts({ oid: oid('a') }),
    facts({ oid: oid('b') }),
  );
  assert.equal(identity.changeId, 'pilot-break-glass-maintainer-authority');
  assert.equal(identity.grantId, PRIMARY_GRANT);

  assert.throws(
    () =>
      validateAuthorityTransitionIdentity(
        facts({ oid: oid('a'), message: PLAN_MESSAGE }),
        facts({ oid: oid('b'), message: PLAN_MESSAGE }),
      ),
    (error) => isWorkflowError(error, 'AUTHORITY_TRANSITION_MISMATCH'),
  );
});

function mutateEnvelopeKeyOrder(canonical: string): string {
  const value = JSON.parse(canonical) as {
    payload: Record<string, unknown>;
    signature: string;
  };
  return `${JSON.stringify({ signature: value.signature, payload: value.payload })}\n`;
}
