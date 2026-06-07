module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  extends: ['eslint:recommended', 'plugin:vue/vue3-recommended'],
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  rules: {
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'prefer-const': 'error',
    'eqeqeq': 'error',
    'vue/multi-word-component-names': 'off',
    'vue/no-unused-vars': 'error',
    'vue/component-name-in-template-casing': ['error', 'PascalCase'],
  },
}
