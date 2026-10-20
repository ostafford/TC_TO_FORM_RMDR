import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Three projects, as in EH_Webhook:
 *  - "node":        pure logic (message wording, time formatting). No runtime.
 *  - "worker":      the Worker as a black box inside workerd, real local D1
 *                   with migrations applied, a fake Connecteam behind the client.
 *  - "integration": live checks against a real Connecteam account. NOT run by
 *                   `npm test`; `npm run test:integration` self-skips without
 *                   the values it needs in .dev.vars.
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

  return {
    test: {
      projects: [
        {
          test: {
            name: "node",
            include: ["test/**/*.test.ts"],
            exclude: ["test/worker/**", "test/**/*.integration.test.ts"],
            environment: "node",
          },
        },
        {
          test: {
            name: "integration",
            include: ["test/**/*.integration.test.ts"],
            environment: "node",
            setupFiles: ["./test/setup.env.ts"],
          },
        },
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                bindings: {
                  // Test-only binding so the setup file can apply migrations.
                  TEST_MIGRATIONS: migrations,
                  // A Deployment's settings, filled in for the tests only. The
                  // tracked wrangler.jsonc keeps them blank.
                  CT_API_KEY: "test-api-key",
                  CT_WEBHOOK_SECRET: "test-webhook-secret",
                  COMPLIANCE_FORM_ID: "9001",
                  CT_PUBLISHER_ID: "4242",
                  WHERE_TO_FIND: "the Forms tab in the Connecteam app",
                  GRACE_PERIOD_MINUTES: "30",
                  ESCALATION_DELAY_MINUTES: "240",
                  TIME_ZONE: "Australia/Sydney",
                },
              },
            }),
          ],
          test: {
            name: "worker",
            include: ["test/worker/**/*.test.ts"],
            setupFiles: ["./test/worker/apply-migrations.ts"],
          },
        },
      ],
    },
  };
});
