export interface JwtSecrets {
  accessSecret: string;
  refreshSecret: string;
}

const forbiddenSecrets = new Set([
  'development-secret-change-in-production',
  'development-refresh-secret',
]);

const requireSecret = (
  environment: Readonly<Record<string, string | undefined>>,
  name: 'JWT_SECRET' | 'JWT_REFRESH_SECRET',
): string => {
  const secret = environment[name]?.trim();

  if (!secret) {
    throw new Error(`${name} must be explicitly configured and non-blank.`);
  }

  if (forbiddenSecrets.has(secret)) {
    throw new Error(`${name} uses a forbidden published development value.`);
  }

  return secret;
};

export const resolveJwtSecrets = (
  environment: Readonly<Record<string, string | undefined>>,
): JwtSecrets => {
  const accessSecret = requireSecret(environment, 'JWT_SECRET');
  const refreshSecret = requireSecret(environment, 'JWT_REFRESH_SECRET');

  if (accessSecret === refreshSecret) {
    throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be distinct.');
  }

  return { accessSecret, refreshSecret };
};
