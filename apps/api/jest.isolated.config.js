const config = {
  displayName: 'API Isolated Tests',
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/__tests__/isolated'],
  testMatch: ['**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  // NO setupFilesAfterEnv - completely isolated
  testTimeout: 10000,
  maxWorkers: 1,
  // No globals needed for isolated tests
};

module.exports = config;
