import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.react-router/**",
      "**/.wrangler/**",
      "**/worker-configuration.d.ts",
      "**/*.d.ts",
      "packages/db/migrations/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='console'][callee.property.name=/^(log|debug|info|warn|error|trace)$/]",
          message:
            "Use the structured logger from @inkloom/core/logger instead of console.* so secrets are redacted and logs stay JSON.",
        },
      ],
    },
  },
  {
    /*
     * Standalone tooling: CLI scripts, e2e specs, tests and configs.
     *
     * `no-restricted-syntax` exists to keep `console.*` out of APPLICATION code,
     * where the structured logger redacts secrets and keeps output as JSON. A
     * CLI harness printing a table to a terminal is the case the rule is not
     * about. `.mjs` is included deliberately: leaving it out meant one plain
     * script carried 43 errors that no per-file suppression should have been
     * needed to silence.
     */
    files: [
      "scripts/**/*.{ts,mjs,js}",
      "e2e/**/*.ts",
      "**/*.test.ts",
      "**/*.config.*",
    ],
    languageOptions: {
      /*
       * Declared inline rather than pulling in the `globals` package for one
       * override. These are the Node and Web APIs a CLI script legitimately
       * uses; the application packages get theirs from their own tsconfig.
       */
      globals: {
        process: "readonly",
        console: "readonly",
        fetch: "readonly",
        URL: "readonly",
        performance: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        AbortSignal: "readonly",
        AbortController: "readonly",
        crypto: "readonly",
        Buffer: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        Response: "readonly",
        Request: "readonly",
        Headers: "readonly",
      },
    },
    rules: { "no-restricted-syntax": "off" },
  },
);
