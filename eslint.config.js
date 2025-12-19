import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default [
  {
    ignores: ['dist/**', 'node_modules/**', '.dist/**', '.dist-cache/**']
  },

  // Base JS recommended rules
  js.configs.recommended,

  {
    languageOptions: {
      globals: globals.node,
      sourceType: 'module'
    }
  },

  // TypeScript recommended rules (no type-checking)
  ...tseslint.configs.recommended,

  {
    rules: {
      // Keep console logs allowed for CLI adapter.
      'no-console': 'off',
      // Temporary
      '@typescript-eslint/no-explicit-any': 'off',

      // Common pattern in ACP handlers.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  }
]
