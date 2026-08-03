const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const prettier = require("eslint-config-prettier");

module.exports = tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "supabase/**", "examples/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // vitest.config.ts sits outside `src`, so it is not in tsconfig's
        // `include` — this lets the type-aware rules still lint it.
        projectService: { allowDefaultProject: ["vitest.config.ts", "drizzle.config.ts"] },
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // Drizzle's `.returning()` yields an array whose first element is
      // statically optional but dynamically guaranteed, and `request.tenant` is
      // guaranteed by the /v1 preHandler. Both are asserted with `!` throughout
      // by design, so this rule would fire on correct code everywhere.
      "@typescript-eslint/no-non-null-assertion": "off",
      // Fastify's contracts REQUIRE async functions (plugins, handlers, hooks)
      // whether or not the body happens to await anything. `async () => ({
      // status: "ok" })` is the idiomatic health handler, not a mistake.
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Kept ON deliberately: the codebase uses deliberate fire-and-forget
      // (last_used_at telemetry, deferred plugin registration), and each site
      // marks itself with `void`. An unmarked floating promise is a bug.
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    // `inject().json()` returns `any` by design — it deserialises an arbitrary
    // HTTP body. Asserting on it is the entire point of a route test, so the
    // no-unsafe-* family fires on every correct assertion. Typing each one
    // would add noise without catching a single real bug.
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  // The flat config itself is CommonJS (package.json is "type": "commonjs"),
  // so it is linted without type information.
  {
    files: ["eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      // Spread the parent's languageOptions first: disableTypeChecked turns the
      // project service OFF there, and replacing the object wholesale would put
      // it back on — which fails, since this file is not in tsconfig's include.
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { require: "readonly", module: "writable", __dirname: "readonly" },
    },
    rules: {
      // Merge, don't replace: disableTypeChecked's own `rules` object is what
      // switches every type-aware rule off, and overwriting it would leave them
      // enabled on a file that has no type information.
      ...tseslint.configs.disableTypeChecked.rules,
      // This file has to be CommonJS — package.json is "type": "commonjs", so
      // ESLint would not be able to load an ESM flat config here.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  prettier,
);
