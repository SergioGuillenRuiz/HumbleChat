'use strict'
const globals = require('globals')

const base = { ecmaVersion: 2023 }
module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'src/renderer/vendor/**', 'test/.tmp/**', 'test/shots/**'] },
  {
    files: ['**/*.js'],
    languageOptions: { ...base, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-redeclare': 'error',
      'no-const-assign': 'error',
      'no-self-assign': 'error',
      'no-unsafe-finally': 'error',
      'eqeqeq': ['warn', 'smart'],
    },
  },
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: { ...base, sourceType: 'module', globals: { ...globals.browser, hc: 'readonly' } },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: { ...base, sourceType: 'commonjs', globals: { ...globals.node, ...globals.browser } }, // evalúan código dentro de la página
  },
]
