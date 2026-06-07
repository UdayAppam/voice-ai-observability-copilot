module.exports = {
  env: { node: true, es2022: true },
  extends: ['eslint:recommended'],
  parserOptions: { ecmaVersion: 2022 },
  rules: {
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-console': 'warn',
    'eqeqeq': 'error',
    'no-var': 'error',
    'prefer-const': 'error',
    'no-throw-literal': 'error',
  },
}
