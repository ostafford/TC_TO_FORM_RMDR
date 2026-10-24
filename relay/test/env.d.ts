// The bindings `env` from "cloudflare:test" carries in the relay tests.
import type { Env as RelayEnv } from "../src/index.js";

declare global {
  namespace Cloudflare {
    interface Env extends RelayEnv {}
  }
}
