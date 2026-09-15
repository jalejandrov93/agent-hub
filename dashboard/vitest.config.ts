import path from "path"
import { defineConfig, mergeConfig } from "vitest/config"
import viteConfig from "./vite.config.ts"

const rootDir = import.meta.dirname

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "happy-dom",
      globals: true,
      css: false,
      setupFiles: ["./src/test/setup.ts"],
    },
    resolve: {
      alias: {
        "@": path.resolve(rootDir, "./src"),
        "@shared": path.resolve(rootDir, "../src/schemas.mjs"),
      },
    },
  })
)
