import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

// Tests run inside the Workers runtime (workerd) via @cloudflare/vitest-plugin.
// No automated test contacts the live Moodle site: outbound fetch is stubbed
// per-test (see test/_stubs.ts), so global_fetch_strictly_public is omitted here.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2025-10-01",
        compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
        kvNamespaces: ["OAUTH_KV"],
        bindings: {
          MOODLE_BASE_URL: "https://moodle.example.test",
          ALLOWED_REDIRECT_URIS: "https://claude.ai/api/mcp/auth_callback",
          GEMINI_REDIRECT_DISCOVERY: "off",
          INLINE_FILE_CAP_BYTES: "10485760",
          MOODLE_TOKEN: "test-moodle-token",
          GOOGLE_CLIENT_ID: "test-google-client-id.apps.googleusercontent.com",
          GOOGLE_CLIENT_SECRET: "test-google-client-secret",
          ALLOWED_GOOGLE_SUB: "1234567890",
          COOKIE_ENCRYPTION_KEY: "test-cookie-encryption-key-at-least-32b",
          LINK_SIGNING_KEYS: "k1:dGVzdC1zaWduaW5nLWtleS1udW1iZXItb25lLTEyMzQ1",
        },
      },
    }),
  ],
});
