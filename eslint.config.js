import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(
  {
    ignores: [
      "**/dist/**",
      "**/out/**",
      "**/cache/**",
      "**/.next/**",
      "**/next-env.d.ts",
      "packages/foundry/lib/**",
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ["server/src/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/features/**"],
              message: "Shared code cannot depend on feature modules. Wire features in app.ts.",
            },
          ],
        },
      ],
    },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
