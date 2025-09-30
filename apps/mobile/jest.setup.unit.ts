// Load the existing component setup which has all the necessary mocks
require('./src/__tests__/setup-component.ts');

// Polyfill TextEncoder/TextDecoder for Node.js environment
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

// Mock expo-router for unit tests
jest.mock('expo-router');
