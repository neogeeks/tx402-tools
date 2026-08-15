import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Deliberately small. Formatting is not linted — nobody's session should end in
 * a style argument — but the rules that catch real Workers bugs are on, and
 * they are type-aware:
 *
 *  - `no-floating-promises` — a dropped promise in a Worker is a request that
 *    silently does half its work. This is the single most common Workers bug.
 *  - `no-misused-promises` — an async handler passed where a sync one is
 *    expected fails the same way.
 *  - `require-await` off: an async handler with no await is a legitimate shape
 *    for a route that only sometimes awaits.
 */
export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", ".wrangler/**", "coverage/**", "packages/**/dist/**"] },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "no-console": ["error", { allow: ["error", "warn", "log"] }],
      eqeqeq: ["error", "smart"],
    },
  },
  {
    // Gate scripts, the fixture generator and the package placeholder bins are
    // plain Node ESM.
    files: ["scripts/**/*.mjs", "spec/fixtures/*.mjs", "packages/**/bin/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { process: "readonly", console: "readonly", Buffer: "readonly" } },
  },
  {
    files: ["test/**/*.ts", "vitest.config.ts", "eslint.config.js"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
);
