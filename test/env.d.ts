/// <reference types="@cloudflare/vitest-plugin/types" />

import type { Env } from "../src/types.js";

declare module "cloudflare:test" {
  // The Miniflare bindings configured in vitest.config.ts satisfy our Env.
  interface ProvidedEnv extends Env {}
}
