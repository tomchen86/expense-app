// Integration test setup - minimal mocks only
// DO NOT load setup-component.ts as it mocks @react-navigation/native
// which breaks expo-router/testing-library

// Define React Native globals
global.__DEV__ = true;
global.setImmediate =
  global.setImmediate || ((fn, ...args) => global.setTimeout(fn, 0, ...args));

// Mock React Native modules (copied from setup-component.ts, excluding Navigation mock)
jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  Reanimated.default.call = () => {};
  return Reanimated;
});

jest.mock('react-native-gesture-handler', () =>
  require('react-native-gesture-handler/jestSetup'),
);

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }) => children,
  SafeAreaView: ({ children }) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('expo-status-bar', () => ({
  StatusBar: 'StatusBar',
}));

// IMPORTANT: Do not mock expo-router or @react-navigation/native
// Integration tests need real router functionality
