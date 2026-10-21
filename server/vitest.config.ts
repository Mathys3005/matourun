import { defineConfig } from "vitest/config";

// Test files share one Postgres database: run them one after another.
export default defineConfig({ test: { fileParallelism: false } });
