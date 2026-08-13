// Load the existing component setup which has all the necessary mocks
require('./src/__tests__/setup-component.ts');

global.__DEV__ = true;

// Polyfill TextEncoder/TextDecoder for Node.js environment
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

if (!global.crypto) {
  Object.defineProperty(global, 'crypto', {
    configurable: true,
    value: require('crypto').webcrypto,
  });
}

jest.mock('expo-crypto', () => ({
  randomUUID: () => require('crypto').randomUUID(),
}));

// Mock expo-router for unit tests
jest.mock('expo-router');
