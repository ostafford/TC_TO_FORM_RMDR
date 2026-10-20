import { applyD1Migrations, env } from "cloudflare:test";

// Setup files run outside per-test storage isolation and may run more than once;
// applyD1Migrations() only applies what hasn't been applied yet, so this is safe.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
