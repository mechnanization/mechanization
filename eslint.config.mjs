import nextPlugin from '@next/eslint-plugin-next';
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * One flat config for the whole workspace.
 *
 * `pnpm lint` referenced ESLint for the life of this repository without ESLint
 * ever being installed or configured, so it has never run — which is why the
 * CI gate added alongside this had nothing to call. The ruleset below is
 * deliberately narrow: rules that catch *defects*, not rules that have opinions
 * about formatting. A first lint config that reports two thousand style
 * complaints is a lint config that gets switched off within a week, and the
 * value here is the handful of real findings, not the arguments about spacing.
 *
 * Type-aware linting (`recommendedTypeChecked`) is the obvious next step and is
 * left out on purpose: it needs a project service per package and roughly
 * quadruples the run, which is a decision worth making deliberately rather than
 * inheriting from whoever set the file up.
 */
export default tseslint.config(
  {
    // Generated Prisma clients, build output, and the vendored agent skills —
    // none of it is ours to fix, and all of it is large.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      // `pnpm build:check` output — the same compiled bundles as `.next`,
      // in a directory that exists so a verification build cannot corrupt a
      // running dev server. Linting either is linting webpack's work.
      '**/.next-check/**',
      '**/generated/**',
      '**/coverage/**',
      '.agents/**',
      'apps/frontend/next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    /**
     * Both environments, everywhere.
     *
     * Splitting them per directory would be tidier and buys nothing: the
     * frontend is Node during SSR and a browser after hydration, and the only
     * thing these declarations do is stop `no-undef` reporting `console` and
     * `setTimeout` as typos.
     */
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      /**
       * The `_`-prefix convention this codebase already follows for a
       * deliberately unused parameter — `use(req, _res, next)` in the tenant
       * middleware, and every Nest lifecycle hook that ignores an argument.
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],

      /**
       * Downgraded, not disabled.
       *
       * `any` appears in this codebase where Prisma's generated types and the
       * domain's own types genuinely disagree — the loosely-typed table
       * delegate in `BackupService` is the clearest case, and it is documented
       * there. Erroring on it would mean either a wave of suppressions or a
       * wave of casts, neither of which makes the code safer.
       */
      '@typescript-eslint/no-explicit-any': 'warn',

      /**
       * Off: the codebase asserts non-null in places where an adjacent guard
       * has already established it (`row.latitude!` after a
       * `latitude: { not: null }` filter), which the compiler cannot see
       * through and a reader can.
       */
      '@typescript-eslint/no-non-null-assertion': 'off',

      // Real defects, all of them silent at runtime.
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-unmodified-loop-condition': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      /**
       * A UTF-8 BOM is data here, not stray whitespace.
       *
       * `buildCitizenTemplate` and the ZIP writer both emit one on purpose —
       * without it Excel opens an Arabic CSV as mojibake, which is the whole
       * reason the byte is there. It sits inside template literals, so the
       * rule's default `skipStrings` does not cover it.
       */
      'no-irregular-whitespace': [
        'error',
        { skipStrings: true, skipTemplates: true, skipRegExps: true },
      ],
    },
  },

  {
    /**
     * `require-atomic-updates` on the backend only.
     *
     * Where it means what it says — a value read before an `await` and written
     * after it — this is exactly the read-then-write shape behind the lost
     * updates in the settlement paths. In React it fires on every
     * `ref.current = …` after an await, which is the ordinary way a component
     * stores an imperative handle, and the noise would bury the real ones.
     */
    files: ['apps/backend/**/*.ts'],
    rules: { 'require-atomic-updates': 'error' },
  },

  {
    /**
     * The React app. These two plugins exist here because the code already
     * carries `eslint-disable` comments naming their rules — written against a
     * `next lint` setup whose config was never committed, so every one of them
     * was reported as "definition for rule not found". The rules are worth
     * having on their own merits; `exhaustive-deps` in particular is the one
     * that catches a stale closure in a map effect.
     */
    files: ['apps/frontend/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, '@next/next': nextPlugin },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      // Warnings: both are real signals and neither is a defect on its own, so
      // they inform rather than block a build.
      'react-hooks/exhaustive-deps': 'warn',
      '@next/next/no-img-element': 'warn',
      /**
       * Off: it looks for a `pages/` directory to validate links against, and
       * this app is App Router only — so the rule reports nothing but its own
       * inability to find one, on every run.
       */
      '@next/next/no-html-link-for-pages': 'off',
    },
  },

  {
    // Scripts and specs run in Node and talk to the console on purpose.
    files: [
      '**/*.spec.ts',
      'apps/backend/src/scripts/**',
      // Genuine CommonJS: the Vercel function entry point and the backup
      // dumper are plain `.js` and `require` is how they load.
      'apps/backend/api/**',
      'apps/backend/backups/**',
      '**/*.config.*',
      'scripts/**',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // `require.main === module` is the CommonJS entry-point guard every CLI
      // in `src/scripts` uses to tell "run me" from "import me".
      '@typescript-eslint/no-require-imports': 'off',
      // `scripts/start.mjs` strips ANSI escapes from child output, which needs
      // the escape character in a pattern.
      'no-control-regex': 'off',
    },
  },
);
