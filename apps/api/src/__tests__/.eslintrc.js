module.exports = {
  // Test-only ESLint config: pragmatic + fast (no type-checking program required)
  env: { jest: true, node: true, es2023: true },
  plugins: ['@typescript-eslint', 'jest', 'jest-formatting'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:jest/recommended',
    'plugin:jest/style',
    'plugin:jest-formatting/recommended',
  ],
  rules: {
    // Tests often stub/match on loose shapes
    '@typescript-eslint/no-explicit-any': 'off',

    // Keep unsafe-* as warnings (surface issues without blocking)
    '@typescript-eslint/no-unsafe-assignment': 'warn',
    '@typescript-eslint/no-unsafe-member-access': 'warn',
    '@typescript-eslint/no-unsafe-call': 'warn',
    '@typescript-eslint/no-unsafe-argument': 'warn',

    // Catch accidental unbound methods in expectations/mocks
    '@typescript-eslint/unbound-method': ['error', { ignoreStatic: true }],

    // Jest hygiene
    'jest/no-focused-tests': 'error', // ban fdescribe/fit
    'jest/no-disabled-tests': 'warn',
    'jest/valid-expect': 'error',
    'jest/expect-expect': ['warn', { assertFunctionNames: ['expect'] }],
  },
};
