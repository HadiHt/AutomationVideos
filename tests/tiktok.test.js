import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JsonStore } from "../src/store.js";
import { TiktokService } from "../src/services/tiktok.js";

function makeConfig() {
  return {
    tiktok: {
      clientKey: "client_key",
      clientSecret: "client_secret",
      scopes: ["user.info.basic", "video.publish"],
      redirectUri: "http://127.0.0.1:3455/api/tiktok/callback",
      authStateTtlMs: 60000,
      pollingIntervalMs: 5000,
      pollingTimeoutMs: 300000,
      apiBaseUrl: "https://open.tiktokapis.com",
      authorizationUrl: "https://www.tiktok.com/v2/auth/authorize/",
      platform: "desktop"
    }
  };
}

test("authorization URL includes PKCE parameters for desktop mode", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "automation-videos-"));
  const store = new JsonStore(path.join(tempDir, "state.json"));
  const service = new TiktokService(makeConfig(), store);

  const auth = await service.createAuthorizationUrl();
  const url = new URL(auth.url);

  assert.equal(url.origin + url.pathname, "https://www.tiktok.com/v2/auth/authorize/");
  assert.equal(url.searchParams.get("client_key"), "client_key");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "user.info.basic,video.publish");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
});
