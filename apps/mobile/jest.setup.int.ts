// Load the existing component setup which has all the necessary mocks
require('./src/__tests__/setup-component.ts');

// IMPORTANT: Do not mock expo-router in integration tests
// Integration tests need the real expo-router functionality
