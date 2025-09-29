// Load the existing component setup which has all the necessary mocks
require('./src/__tests__/setup-component.ts');

// Mock expo-router for unit tests
jest.mock('expo-router');
