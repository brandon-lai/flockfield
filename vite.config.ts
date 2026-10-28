import { defineConfig } from "vite";

export default defineConfig({
  root: "client",
  envDir: "..",
  build: { outDir: "../dist", emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 900 },
  server: { port: 5199, host: true },
});
