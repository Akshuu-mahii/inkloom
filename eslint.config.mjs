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
    files: ["scripts/**/*.ts", "e2e/**/*.ts", "**/*.test.ts", "**/*.config.*"],
    rules: { "no-restricted-syntax": "off" },
  },
);
