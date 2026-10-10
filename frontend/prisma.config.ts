import { existsSync } from "node:fs";
import { defineConfig, env } from "prisma/config";

// Prisma 7 no longer auto-loads .env; production injects real env vars instead.
if (existsSync(".env")) process.loadEnvFile();

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: { url: env("DATABASE_URL") },
});
