import { resolveJwtSecrets } from './jwt-secret-policy';

export const getAppConfig = () => {
  const { accessSecret, refreshSecret } = resolveJwtSecrets(process.env);

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    apiPrefix: process.env.API_PREFIX || 'api',
    jwtSecret: accessSecret,
    jwtRefreshSecret: refreshSecret,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  };
};
