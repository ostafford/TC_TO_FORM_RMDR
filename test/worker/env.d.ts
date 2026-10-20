// The bindings `env` from "cloudflare:test" carries in the worker tests.
import type { D1Migration } from "cloudflare:test";
import type { Env as WorkerEnv } from "../../src/env.js";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
