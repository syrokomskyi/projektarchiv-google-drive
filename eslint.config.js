import tseslint from "typescript-eslint";

function createNoAsAnyRule() {
  return {
    meta: {
      type: "problem",
      docs: { description: "Disallow `as any` type assertions" },
      schema: [],
      messages: {
        noAsAny:
          "Unexpected `as any`. Fix the call-site type or use `unknown`; `as any` on workspace-internal APIs silently drops properties and causes runtime bugs.",
      },
    },
    create(context) {
      return {
        TSAsExpression(node) {
          if (node.typeAnnotation && node.typeAnnotation.type === "TSAnyKeyword") {
            context.report({ node, messageId: "noAsAny" });
          }
        },
      };
    },
  };
}

export default tseslint.config(
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["src/**/*.ts"],
    ignores: ["**/*.d.ts", "**/*.template.ts", "**/*.template.mjs"],
  })),
  {
    files: ["src/**/*.ts"],
    ignores: ["**/*.d.ts", "**/*.template.ts", "**/*.template.mjs"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        sourceType: "module",
        ecmaVersion: "latest",
      },
    },
    plugins: {
      "local-rules": {
        rules: {
          "no-as-any": createNoAsAnyRule(),
        },
      },
    },
    rules: {
      "local-rules/no-as-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Test files — allow `any` and `as any` for partial mocking of complex types
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "local-rules/no-as-any": "off",
    },
  },
);
