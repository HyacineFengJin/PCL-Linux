import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  // Local library snapshots are useful for UI development, but never ship them.
  publicDir: command === "build" ? false : "public",
  server: { strictPort: true },
}));
