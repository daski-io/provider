import { readdirSync } from "node:fs";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";

// Core is service-neutral. Services may consume core contracts but may not
// import sibling services or provider-specific extensions.
const SERVICES = readdirSync(new URL("./src/services", import.meta.url), {
  withFileTypes: true,
}).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

const SIBLING_ZONES = [];
for (const target of SERVICES) {
  for (const from of SERVICES) {
    if (target === from) continue;
    SIBLING_ZONES.push({
      target: `./src/services/${target}`,
      from: `./src/services/${from}`,
      message:
        `services/${target} must not import from services/${from}. Services integrate ` +
        `through core contracts.`,
    });
  }
}

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "*.cjs",
      "scripts/**",
      "test/**",
      "src/**/tests/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    plugins: { import: importPlugin },
    settings: {
      "import/resolver": {
        typescript: { alwaysTryTypes: true },
      },
    },
    rules: {
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "./src/core",
              from: "./src/services",
              message:
                "core/ must not import from services/. Services consume core contracts.",
            },
            {
              target: "./src/core",
              from: "./src/providerExtensions",
              message:
                "core/ must not import provider-specific extensions.",
            },
            {
              target: "./src/services",
              from: "./src/providerExtensions",
              message:
                "services must use policy-neutral core extension contracts.",
            },
            {
              target: "./src/providerExtensions",
              from: "./src/services",
              message:
                "provider extensions must remain service-independent.",
            },
            ...SIBLING_ZONES,
          ],
        },
      ],
      "import/no-cycle": ["error", { maxDepth: 6 }],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "no-empty": "off",
    },
  },
);
