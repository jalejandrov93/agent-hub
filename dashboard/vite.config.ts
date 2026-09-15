import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const rootDir = import.meta.dirname

// https://vite.dev/config/
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "./src"),
      // Root zod schemas (src/schemas.mjs) are the single source of truth for
      // API shapes; the dashboard never redeclares zod as its own dependency.
      "@shared": path.resolve(rootDir, "../src/schemas.mjs"),
    },
  },
  build: {
    outDir: "dist",
    manifest: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
})
