import { defineConfig } from "vitest/config";

// Separate from vite.config.ts, whose root is the client folder.
export default defineConfig({ test: { root: ".", include: ["tests/**/*.test.ts"], testTimeout: 60_000 } });
