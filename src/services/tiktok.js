import crypto from "node:crypto";
import fs from "node:fs/promises";

function encodeForm(data) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null && value !== "") {
      form.set(key, String(value));
    }
  }
  return form;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomPkce(length = 64) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  let output = "";
  const bytes = crypto.randomBytes(length);
  for (let index = 0; index < length; index += 1) {
    output += alphabet[bytes[index] % alphabet.length];
  }
  return output;
}

export class TiktokService {
  constructor(config, store) {
    this.config = config;
    this.store = store;
  }

  isConfigured() {
    return Boolean(this.config.tiktok.clientKey && this.config.tiktok.clientSecret);
  }

  async createAuthorizationUrl() {
    if (!this.isConfigured()) {
      throw new Error("TikTok client key/secret are not configured.");
    }

    const state = crypto.randomUUID();
    const authState = {
      value: state,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.tiktok.authStateTtlMs
    };

    const params = new URLSearchParams({
      client_key: this.config.tiktok.clientKey,
      response_type: "code",
      scope: this.config.tiktok.scopes.join(","),
      redirect_uri: this.config.tiktok.redirectUri,
      state
    });

    if (this.config.tiktok.platform === "desktop") {
      authState.codeVerifier = randomPkce(64);
      params.set("code_challenge", sha256Hex(authState.codeVerifier));
      params.set("code_challenge_method", "S256");
    }

    await this.store.saveAuthState(authState);

    return {
      state,
      url: `${this.config.tiktok.authorizationUrl}?${params.toString()}`
    };
  }

  async handleCallback({ state, code, error, errorDescription }) {
    if (error) {
      throw new Error(errorDescription || error);
    }

    const authState = await this.store.consumeAuthState(state);
    if (!authState) {
      throw new Error("The TikTok login state is missing or expired.");
    }

    if (!code) {
      throw new Error("The TikTok callback did not include an authorization code.");
    }

    const form = encodeForm({
      client_key: this.config.tiktok.clientKey,
      client_secret: this.config.tiktok.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: this.config.tiktok.redirectUri,
      code_verifier: authState.codeVerifier
    });

    const tokenResponse = await fetch(`${this.config.tiktok.apiBaseUrl}/v2/oauth/token/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form
    });

    const tokenBody = await tokenResponse.json();
    if (!tokenResponse.ok || tokenBody.error) {
      throw new Error(tokenBody.error_description || tokenBody.message || tokenBody.error || "TikTok token exchange failed.");
    }

    const account = {
      openId: tokenBody.open_id,
      scope: tokenBody.scope,
      accessToken: tokenBody.access_token,
      refreshToken: tokenBody.refresh_token,
      tokenType: tokenBody.token_type || "Bearer",
      accessTokenExpiresAt: new Date(Date.now() + Number(tokenBody.expires_in || 0) * 1000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + Number(tokenBody.refresh_expires_in || 0) * 1000).toISOString(),
      connectedAt: new Date().toISOString(),
      creatorInfo: null
    };

    return this.store.saveAccount(account);
  }

  async getAccount() {
    const state = await this.store.getState();
    return state.account;
  }

  async withFreshAccessToken() {
    const state = await this.store.getState();
    const account = state.account;
    if (!account) {
      throw new Error("No TikTok account is connected.");
    }

    const expiresAt = new Date(account.accessTokenExpiresAt).getTime();
    const refreshBufferMs = 10 * 60 * 1000;
    if (Number.isFinite(expiresAt) && expiresAt - Date.now() > refreshBufferMs) {
      return account;
    }

    if (!account.refreshToken) {
      throw new Error("The TikTok access token is expired and no refresh token is stored.");
    }

    const form = encodeForm({
      client_key: this.config.tiktok.clientKey,
      client_secret: this.config.tiktok.clientSecret,
      grant_type: "refresh_token",
      refresh_token: account.refreshToken
    });

    const response = await fetch(`${this.config.tiktok.apiBaseUrl}/v2/oauth/token/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form
    });

    const body = await response.json();
    if (!response.ok || body.error) {
      throw new Error(body.error_description || body.message || body.error || "TikTok token refresh failed.");
    }

    const nextAccount = {
      ...account,
      scope: body.scope || account.scope,
      accessToken: body.access_token,
      refreshToken: body.refresh_token || account.refreshToken,
      tokenType: body.token_type || account.tokenType,
      accessTokenExpiresAt: new Date(Date.now() + Number(body.expires_in || 0) * 1000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + Number(body.refresh_expires_in || 0) * 1000).toISOString(),
      refreshedAt: new Date().toISOString()
    };

    await this.store.saveAccount(nextAccount);
    return nextAccount;
  }

  async fetchCreatorInfo() {
    const account = await this.withFreshAccessToken();
    const response = await fetch(`${this.config.tiktok.apiBaseUrl}/v2/post/publish/creator_info/query/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8"
      },
      body: "{}"
    });

    const body = await response.json();
    if (!response.ok || body.error?.code && body.error.code !== "ok") {
      throw new Error(body.error?.message || "TikTok creator info request failed.");
    }

    const mergedAccount = {
      ...account,
      creatorInfo: body.data,
      creatorInfoFetchedAt: new Date().toISOString()
    };

    await this.store.saveAccount(mergedAccount);
    return body.data;
  }

  async publishVideo({ job, title, privacyLevel, disableComment, disableDuet, disableStitch, videoCoverTimestampMs = 0, consent }) {
    if (!consent) {
      throw new Error("Explicit user consent is required before uploading content to TikTok.");
    }

    if (!privacyLevel) {
      throw new Error("A TikTok privacy level must be selected before publishing.");
    }

    const account = await this.withFreshAccessToken();
    const creatorInfo = account.creatorInfo || (await this.fetchCreatorInfo());

    if (!creatorInfo.privacy_level_options?.includes(privacyLevel)) {
      throw new Error("The requested TikTok privacy level is not allowed for the connected creator.");
    }

    if (creatorInfo.comment_disabled && disableComment === false) {
      throw new Error("Comments are disabled for the connected creator account.");
    }

    if (creatorInfo.duet_disabled && disableDuet === false) {
      throw new Error("Duet is disabled for the connected creator account.");
    }

    if (creatorInfo.stitch_disabled && disableStitch === false) {
      throw new Error("Stitch is disabled for the connected creator account.");
    }

    const fileStats = await fs.stat(job.output.videoPath);
    const chunkSize = Math.min(Math.max(5 * 1024 * 1024, fileStats.size), 10 * 1024 * 1024);
    const totalChunkCount = Math.ceil(fileStats.size / chunkSize);

    const initResponse = await fetch(`${this.config.tiktok.apiBaseUrl}/v2/post/publish/video/init/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8"
      },
      body: JSON.stringify({
        post_info: {
          title,
          privacy_level: privacyLevel,
          disable_comment: disableComment,
          disable_duet: disableDuet,
          disable_stitch: disableStitch,
          video_cover_timestamp_ms: videoCoverTimestampMs
        },
        source_info: {
          source: "FILE_UPLOAD",
          video_size: fileStats.size,
          chunk_size: chunkSize,
          total_chunk_count: totalChunkCount
        }
      })
    });

    const initBody = await initResponse.json();
    if (!initResponse.ok || initBody.error?.code && initBody.error.code !== "ok") {
      throw new Error(initBody.error?.message || "TikTok publish initialization failed.");
    }

    const uploadUrl = initBody.data?.upload_url;
    const publishId = initBody.data?.publish_id;
    if (!uploadUrl || !publishId) {
      throw new Error("TikTok did not return an upload URL or publish ID.");
    }

    const fileBuffer = await fs.readFile(job.output.videoPath);
    let offset = 0;
    while (offset < fileBuffer.length) {
      const chunk = fileBuffer.subarray(offset, Math.min(offset + chunkSize, fileBuffer.length));
      const uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Range": `bytes ${offset}-${offset + chunk.length - 1}/${fileBuffer.length}`,
          "Content-Length": String(chunk.length)
        },
        body: chunk
      });

      if (uploadResponse.status !== 201 && uploadResponse.status !== 206) {
        const uploadText = await uploadResponse.text();
        throw new Error(`TikTok upload failed: ${uploadText || uploadResponse.statusText}`);
      }

      offset += chunk.length;
    }

    return {
      publishId,
      uploadUrl,
      uploadCompletedAt: new Date().toISOString()
    };
  }

  async fetchPublishStatus(publishId) {
    const account = await this.withFreshAccessToken();
    const response = await fetch(`${this.config.tiktok.apiBaseUrl}/v2/post/publish/status/fetch/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8"
      },
      body: JSON.stringify({ publish_id: publishId })
    });

    const body = await response.json();
    if (!response.ok || body.error?.code && body.error.code !== "ok") {
      throw new Error(body.error?.message || "TikTok publish status request failed.");
    }

    return body.data;
  }
}
