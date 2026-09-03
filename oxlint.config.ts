import { defineConfig } from "oxlint"

export default defineConfig({
  ignorePatterns: [
    ".alchemy/**",
    "**/dist/**",
    "**/node_modules/**",
    "**/.output/**",
    "**/.tanstack/**",
    "src/routeTree.gen.ts",
  ],
})
