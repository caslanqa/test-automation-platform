import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';
import playwright from 'eslint-plugin-playwright';
import prettier from 'eslint-plugin-prettier';

export default [
  // Ignore patterns (monorepo-wide)
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/allure-results/**',
      '**/allure-report/**',
      'packages/create/template/**',
      '**/templates/**',
      '**/*.log',
      // Build-tool config files that intentionally sit outside their package's tsconfig `include`
      // (e.g. Vite must stay outside `rootDir` so `tsc -b` never tries to compile it) — no type
      // info is needed to lint these, and typescript-eslint's `allowDefaultProject` fallback for
      // them is unreliable across a full multi-project repo lint run. Prettier still formats them
      // via `npm run format`/`format:check`.
      '**/vite.config.ts',
    ],
  },

  // Base config for all TypeScript files (including the mobile-inspector's React UI, the only
  // consumer of `.tsx` in the monorepo today)
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        // Monorepo: let typescript-eslint locate the nearest tsconfig per file
        // instead of pinning a single root project.
        projectService: true,
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      playwright: playwright,
      prettier: prettier,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...prettierConfig.rules,

      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'warn',

      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      'no-debugger': 'warn',
      'no-duplicate-imports': 'off',
      'prefer-const': 'warn',
      'no-var': 'error',

      'max-len': [
        'warn',
        { code: 120, ignoreComments: true, ignoreStrings: true, ignoreTemplateLiterals: true },
      ],
      'prefer-template': 'warn',
      'object-shorthand': 'warn',
      'arrow-body-style': ['warn', 'as-needed'],

      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },

  // Playwright test files
  {
    files: ['**/*.spec.ts', '**/*.test.ts', '**/tests/**/*.ts'],
    plugins: {
      playwright: playwright,
    },
    rules: {
      ...playwright.configs['flat/recommended'].rules,
      '@typescript-eslint/no-explicit-any': 'off',
      // `test.as(session)('title', fn)` is a valid test block the plugin can't statically detect.
      'playwright/no-standalone-expect': 'off',
      'playwright/no-wait-for-timeout': 'off',
      'playwright/no-conditional-expect': 'off',
      'playwright/no-conditional-in-test': 'off',
      'playwright/no-networkidle': 'off',
      'playwright/no-wait-for-navigation': 'off',
    },
  },
];
