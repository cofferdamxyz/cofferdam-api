// typescript-eslint's type-checked rules over the Worker, the XMTP operator
// Workers, the tests and the scripts (workspace rules/cofferdam-infrastructure.md).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// The Mac lanes (project rule: cloud sessions do not edit them). Their remaining
// findings are warnings until they are fixed on the Mac; then delete this block.
const MAC_LANES = ['src/routes/chat.ts', 'src/services/chat/**', 'src/services/inference/**'];

export default tseslint.config(
  { ignores: ['node_modules/**', '**/.wrangler/**', 'dist/**'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { project: './tsconfig.test.json', tsconfigRootDir: import.meta.dirname },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // Assertions that restate the inferred type are harmless, and the rule's
      // autofix changes contextual typing (viem reads, fixtures).
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      // Durable Object RPC methods and store interfaces are async by contract.
      '@typescript-eslint/require-await': 'off',
      // Parsers coerce untrusted JSON and SQLite cells with String() on purpose.
      '@typescript-eslint/no-base-to-string': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // Tests poke at untyped JSON bodies and stub async interfaces with sync bodies.
    files: ['test/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly', fetch: 'readonly', Response: 'readonly' } },
  },
  {
    files: MAC_LANES,
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/consistent-type-imports': 'warn',
      '@typescript-eslint/switch-exhaustiveness-check': 'warn',
      eqeqeq: 'warn',
    },
  },
);
