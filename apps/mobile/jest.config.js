module.exports = {
  preset: 'react-native',
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup-component.ts'],
  coverageProvider: 'v8',
  transform: {
    '^.+\\.(js|jsx|ts|tsx)$': [
      'babel-jest',
      {
        presets: ['module:metro-react-native-babel-preset'],
      },
    ],
  },
  testMatch: [
    '<rootDir>/src/**/__tests__/**/*.test.{js,ts,tsx}',
    '<rootDir>/src/**/*.test.{js,ts,tsx}',
  ],
  collectCoverageFrom: [
    'src/store/**/*.{ts,tsx}',
    'src/hooks/**/*.{ts,tsx}',
    'src/utils/**/*.{ts,tsx}',
    'src/constants/**/*.{ts,tsx}',
    '!src/**/__tests__/**',
  ],
  coverageReporters: ['text-summary', 'lcov', 'html', 'html-spa'],
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
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|react-native-.*|@react-navigation|react-navigation|@react-native-community|@react-native-picker)/)',
  ],
};
