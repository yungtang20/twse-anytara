import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**", "dist/**", "build/**", "coverage/**", ".tmp/**", "tmp/**",
      ".superpowers/**",
      "scripts/_poc_*/**", "scripts/_goodinfo_*/**", "scripts/_check_schema.ts",
      "**/*.min.js", "**/downloaded/**", "**/generated/**", "**/*.js", "**/*.mjs",
    ],
  },
  { ...eslint.configs.recommended, files: ["**/*.{ts,tsx}"] },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: ["**/*.{ts,tsx}"] })),
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "prefer-const": "off",
      "no-irregular-whitespace": "off",
      "no-unsafe-finally": "off",
      "preserve-caught-error": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "no-empty": "off",
      "no-control-regex": "off",
      "no-extra-boolean-cast": "off",
      "no-useless-escape": "off",
    },
  },
);
