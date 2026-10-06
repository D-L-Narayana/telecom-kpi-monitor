import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["node_modules", "dist", "e2e"],
    css: false,
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "src/theme/**"],
      reporter: ["text", "text-summary", "lcov"],
      reportsDirectory: "coverage",
      thresholds: { lines: 80 },
    },
  },
});
