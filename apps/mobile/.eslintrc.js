module.exports = {
  root: true,
  extends: ['@react-native-community'],
  rules: {
    // Allow console.log in development and tests
    'no-console': 'off',
    // Relax some styling rules for now
    'react-native/no-inline-styles': 'warn',
  },
};