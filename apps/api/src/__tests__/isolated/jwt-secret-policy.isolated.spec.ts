import * as fs from 'fs';
import * as path from 'path';

import { resolveJwtSecrets } from '../../config/jwt-secret-policy';

const validEnv = {
  JWT_SECRET: 'unit-test-access-secret-value',
  JWT_REFRESH_SECRET: 'unit-test-refresh-secret-value',
};

describe('JWT secret policy', () => {
  it('returns explicitly configured distinct secrets', () => {
    expect(resolveJwtSecrets(validEnv)).toEqual({
      accessSecret: validEnv.JWT_SECRET,
      refreshSecret: validEnv.JWT_REFRESH_SECRET,
    });
  });

  it.each([
    ['JWT_SECRET is missing', { ...validEnv, JWT_SECRET: undefined }],
    ['JWT_SECRET is blank', { ...validEnv, JWT_SECRET: '   ' }],
    [
      'JWT_REFRESH_SECRET is missing',
      { ...validEnv, JWT_REFRESH_SECRET: undefined },
    ],
    ['JWT_REFRESH_SECRET is blank', { ...validEnv, JWT_REFRESH_SECRET: '' }],
  ])('fails closed when %s', (_label, env) => {
    expect(() =>
      resolveJwtSecrets(env as Record<string, string | undefined>),
    ).toThrow(/JWT_SECRET|JWT_REFRESH_SECRET/);
  });

  it.each([
    [
      'access secret is the published development literal',
      {
        ...validEnv,
        JWT_SECRET: 'development-secret-change-in-production',
      },
    ],
    [
      'refresh secret is the published development literal',
      {
        ...validEnv,
        JWT_REFRESH_SECRET: 'development-refresh-secret',
      },
    ],
    [
      'the published literals are swapped between variables',
      {
        JWT_SECRET: 'development-refresh-secret',
        JWT_REFRESH_SECRET: 'development-secret-change-in-production',
      },
    ],
  ])(
    'rejects a forbidden value even when set explicitly: %s',
    (_label, env) => {
      expect(() => resolveJwtSecrets(env)).toThrow(/JWT_/);
    },
  );

  it('rejects identical access and refresh secrets', () => {
    expect(() =>
      resolveJwtSecrets({
        JWT_SECRET: 'shared-secret-value',
        JWT_REFRESH_SECRET: 'shared-secret-value',
      }),
    ).toThrow(/distinct|differ/i);
  });

  it('never reports the rejected value in the error message', () => {
    try {
      resolveJwtSecrets({
        ...validEnv,
        JWT_SECRET: 'development-secret-change-in-production',
      });
      throw new Error('resolveJwtSecrets did not throw');
    } catch (error) {
      expect(String(error)).not.toContain(
        'development-secret-change-in-production',
      );
    }
  });
});

describe('auth sources carry no fallback secret literals', () => {
  const consumerSources = [
    'src/config/app.config.ts',
    'src/guards/jwt-auth.guard.ts',
    'src/modules/auth.module.ts',
    'src/services/auth.service.ts',
  ];
  const forbiddenLiterals = [
    'development-secret-change-in-production',
    'development-refresh-secret',
  ];

  it.each(consumerSources)('%s', (relativePath) => {
    const content = fs.readFileSync(
      path.join(__dirname, '../../..', relativePath),
      'utf8',
    );
    for (const literal of forbiddenLiterals) {
      expect(content.includes(literal)).toBe(false);
    }
  });
});
