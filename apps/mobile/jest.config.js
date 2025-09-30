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
      transformIgnorePatterns: [
        'node_modules/(?!.*(?:@react-native/js-polyfills|(jest-)?react-native|@react-native(?:-community)?|react-native-.*|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|expo-modules-core|sentry-expo|native-base|react-native-svg))',
      ],
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
      transformIgnorePatterns: [
        'node_modules/(?!.*(?:@react-native/js-polyfills|(jest-)?react-native|@react-native(?:-community)?|react-native-.*|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|expo-modules-core|sentry-expo|native-base|react-native-svg))',
      ],
    },
  ],
  coverageReporters: ['text-summary', 'lcov', 'html', 'html-spa'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
};
