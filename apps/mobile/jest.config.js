module.exports = {
  preset: 'jest-expo',
  transform: { '^.+\\.[jt]sx?$': 'babel-jest' },
  projects: [
    {
      displayName: 'unit',
      testMatch: ['<rootDir>/**/__tests__/**/*.unit.(ts|tsx)'],
      setupFilesAfterEnv: ['<rootDir>/jest.setup.unit.ts'],
      testEnvironment: 'jsdom',
      transform: { '^.+\\.[jt]sx?$': 'babel-jest' },
      collectCoverageFrom: [
        'src/store/**/*.{ts,tsx}',
        'src/hooks/**/*.{ts,tsx}',
        'src/utils/**/*.{ts,tsx}',
        'src/constants/**/*.{ts,tsx}',
        '!src/**/__tests__/**',
      ],
      coveragePathIgnorePatterns: [
        '<rootDir>/src/components/',
        '<rootDir>/src/screens/',
        '<rootDir>/src/app',
      ],
      coverageThreshold: {
        global: {
          branches: 80,
          functions: 90,
          lines: 90,
          statements: 90,
        },
      },
    },
    {
      displayName: 'integration',
      testMatch: ['<rootDir>/**/__tests__/**/*.int.(ts|tsx)'],
      setupFilesAfterEnv: ['<rootDir>/jest.setup.int.ts'],
      testEnvironment: 'jsdom',
      transform: { '^.+\\.[jt]sx?$': 'babel-jest' },
    },
  ],
  coverageReporters: ['text-summary', 'lcov', 'html', 'html-spa'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transformIgnorePatterns: [
    'node_modules/(?!(?:\\.pnpm/)?((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|expo-router|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg))',
  ],
};
