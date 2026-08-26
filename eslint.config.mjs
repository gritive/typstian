import eslint from "@eslint/js";
import globals from "globals";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "main.js",
      "node_modules",
      ".playwright-mcp",
      "helper/wasm/pkg",
      "helper/wasm/target"
    ]
  },
  eslint.configs.recommended,
  {
    files: ["helper/wasm/tests/**/*.mjs"],
    languageOptions: { globals: { ...globals.node } }
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts"]
  })),
  ...obsidianmd.configs.recommended.map((config) => ({
    ...config,
    ignores: [...(config.ignores ?? []), "scripts/**", "tests/**", "helper/**", "*.mjs", "*.mts"]
  })),
  {
    files: ["**/*.ts"],
    ignores: ["scripts/**", "tests/**", "helper/**"],
    plugins: { obsidianmd },
    rules: {
      // Typst is a product name, so it keeps its capital inside UI sentences.
      // `ignoreWords` leaves the plugin's own brand list intact.
      "obsidianmd/ui/sentence-case": ["error", { ignoreWords: ["Typst", "Typstian"] }]
    }
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error"
    }
  }
);
