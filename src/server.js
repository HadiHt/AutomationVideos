import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import { json, html, redirect, readJson, notFound, methodNotAllowed, setCookie } from "./utils/http.js";
import { ensureDir } from "./utils/files.js";
import { TiktokService } from "./services/tiktok.js";
import { PipelineService } from "./services/pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");

function sanitizeAccount(account) {
  if (!account) {
    return null;
  }

  return {
    openId: account.openId,
    scope: account.scope,
    connectedAt: account.connectedAt,
    refreshedAt: account.refreshedAt || null,
    accessTokenExpiresAt: account.accessTokenExpiresAt,
    refreshTokenExpiresAt: account.refreshTokenExpiresAt,
    creatorInfo: account.creatorInfo || null,
    creatorInfoFetchedAt: account.creatorInfoFetchedAt || null
  };
}

function sanitizeJob(job) {
  if (!job) {
    return null;
  }

  return {
    id: job.id,
    title: job.title,
    status: job.status,
    stage: job.stage,
    progress: job.progress ?? 0,
    statusMessage: job.statusMessage || "",
    metrics: job.metrics || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    scriptText: job.scriptText,
    error: job.error,
    scenes: job.scenes,
    prompts: job.prompts,
    captions: job.captions,
    output: job.output,
    publish: job.publish
  };
}

function terminalPublishStatus(status) {
  return status === "PUBLISH_COMPLETE" || status === "FAILED";
}

async function serveStatic(response, filePath) {
  try {
    const content = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const contentType =
      extension === ".html"
        ? "text/html; charset=utf-8"
        : extension === ".css"
          ? "text/css; charset=utf-8"
          : extension === ".js"
            ? "application/javascript; charset=utf-8"
            : extension === ".json"
              ? "application/json; charset=utf-8"
              : extension === ".png"
                ? "image/png"
                : "application/octet-stream";
    response.writeHead(200, { "Content-Type": contentType });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      notFound(response);
      return;
    }
    throw error;
  }
}

async function serveBinaryFile(response, filePath, contentType) {
  const content = await fs.readFile(filePath);
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": content.length
  });
  response.end(content);
}

async function bootstrap() {
  const config = await loadConfig();
  await ensureDir(config.paths.dataDir);
  await ensureDir(config.paths.runtimeDir);
  const store = new JsonStore(path.join(config.paths.dataDir, "state.json"));
  const tiktok = new TiktokService(config, store);
  const pipeline = new PipelineService(config, store);

  async function pollPublish(publishId, jobId) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < config.tiktok.pollingTimeoutMs) {
      try {
        const status = await tiktok.fetchPublishStatus(publishId);
        const publishRecord = {
          publishId,
          jobId,
          status: status.status,
          failReason: status.fail_reason || null,
          publiclyAvailablePostId: status.publicaly_available_post_id || [],
          uploadedBytes: status.uploaded_bytes ?? null,
          downloadedBytes: status.downloaded_bytes ?? null,
          updatedAt: new Date().toISOString()
        };
        await store.savePublish(publishRecord);
        const job = await store.getJob(jobId);
        if (job) {
          await store.updateJob(jobId, {
            publish: {
              ...(job.publish || {}),
              ...publishRecord
            }
          });
        }
        if (terminalPublishStatus(status.status)) {
          return;
        }
      } catch (error) {
        const job = await store.getJob(jobId);
        if (job) {
          await store.updateJob(jobId, {
            publish: {
              ...(job.publish || {}),
              status: "POLL_ERROR",
              failReason: error.message,
              updatedAt: new Date().toISOString()
            }
          });
        }
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, config.tiktok.pollingIntervalMs));
    }
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, config.server.baseUrl);

      if (request.method === "GET" && url.pathname === "/api/health") {
        json(response, 200, {
          ok: true,
          serverTime: new Date().toISOString(),
          configured: {
            tiktok: tiktok.isConfigured(),
            rendererScript: true
          }
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/state") {
        const state = await store.getState();
        json(response, 200, {
          account: sanitizeAccount(state.account),
          jobs: state.jobs.map(sanitizeJob),
          publishes: state.publishes
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/generate") {
        const body = await readJson(request);
        const scriptText = (body.scriptText || "").trim();
        if (!scriptText) {
          json(response, 400, { error: "script_required" });
          return;
        }

        const job = await pipeline.createJob({
          scriptText,
          title: body.title || ""
        });
        json(response, 202, { job: sanitizeJob(job) });
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
        const segments = url.pathname.split("/").filter(Boolean);
        if (segments.length === 4 && segments[3] === "video") {
          const jobId = segments[2];
          const job = await store.getJob(jobId);
          if (!job?.output?.videoPath) {
            notFound(response);
            return;
          }
          await serveBinaryFile(response, job.output.videoPath, "video/mp4");
          return;
        }

        const jobId = url.pathname.split("/").pop();
        const job = await store.getJob(jobId);
        if (!job) {
          notFound(response);
          return;
        }
        json(response, 200, { job: sanitizeJob(job) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/tiktok/connect") {
        const auth = await tiktok.createAuthorizationUrl();
        setCookie(response, "tt_auth_state", auth.state, { maxAge: config.tiktok.authStateTtlMs });
        redirect(response, auth.url);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/tiktok/callback") {
        try {
          await tiktok.handleCallback({
            state: url.searchParams.get("state") || "",
            code: url.searchParams.get("code") || "",
            error: url.searchParams.get("error") || "",
            errorDescription: url.searchParams.get("error_description") || ""
          });

          html(
            response,
            200,
            `<!doctype html><html><head><meta charset="utf-8"><title>TikTok connected</title></head><body><script>window.location.href='/'</script><p>TikTok account connected. You can close this tab.</p></body></html>`
          );
        } catch (error) {
          html(
            response,
            400,
            `<!doctype html><html><head><meta charset="utf-8"><title>TikTok error</title></head><body><h1>Connection failed</h1><p>${error.message}</p><p><a href="/">Return to the app</a></p></body></html>`
          );
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/tiktok/creator-info") {
        const creatorInfo = await tiktok.fetchCreatorInfo();
        json(response, 200, { creatorInfo });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/tiktok/publish") {
        const body = await readJson(request);
        const job = await store.getJob(body.jobId);
        if (!job) {
          notFound(response);
          return;
        }

        if (job.status !== "completed" || !job.output?.videoPath) {
          json(response, 409, { error: "job_not_ready" });
          return;
        }

        const creatorInfo = (await tiktok.getAccount())?.creatorInfo || (await tiktok.fetchCreatorInfo());
        if (job.output.durationSec > creatorInfo.max_video_post_duration_sec) {
          json(response, 400, {
            error: "duration_exceeded",
            maxVideoPostDurationSec: creatorInfo.max_video_post_duration_sec,
            actualDurationSec: job.output.durationSec
          });
          return;
        }

        if (!body.unauditedVisibilityNoticeAccepted) {
          json(response, 400, {
            error: "visibility_notice_required",
            message: "Acknowledge the unaudited/private-visibility notice before publishing."
          });
          return;
        }

        const publishResult = await tiktok.publishVideo({
          job,
          title: body.title || job.title,
          privacyLevel: body.privacyLevel,
          disableComment: Boolean(body.disableComment),
          disableDuet: Boolean(body.disableDuet),
          disableStitch: Boolean(body.disableStitch),
          videoCoverTimestampMs: Number(body.videoCoverTimestampMs || 0),
          consent: Boolean(body.consent)
        });

        const publishRecord = {
          publishId: publishResult.publishId,
          jobId: job.id,
          status: "UPLOAD_COMPLETE",
          failReason: null,
          publiclyAvailablePostId: [],
          updatedAt: new Date().toISOString(),
          uploadCompletedAt: publishResult.uploadCompletedAt
        };

        await store.savePublish(publishRecord);
        await store.updateJob(job.id, {
          publish: {
            title: body.title || job.title,
            privacyLevel: body.privacyLevel,
            disableComment: Boolean(body.disableComment),
            disableDuet: Boolean(body.disableDuet),
            disableStitch: Boolean(body.disableStitch),
            explicitConsentCapturedAt: new Date().toISOString(),
            unauditedVisibilityNoticeAccepted: Boolean(body.unauditedVisibilityNoticeAccepted),
            ...publishRecord
          }
        });

        pollPublish(publishResult.publishId, job.id).catch(() => {});
        json(response, 202, { publish: publishRecord });
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/tiktok/publish/")) {
        const publishId = url.pathname.split("/").pop();
        const publish = await store.getPublish(publishId);
        if (!publish) {
          notFound(response);
          return;
        }
        json(response, 200, { publish });
        return;
      }

      if (request.method !== "GET" && !url.pathname.startsWith("/api/")) {
        methodNotAllowed(response, ["GET"]);
        return;
      }

      const requestedPath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      await serveStatic(response, path.join(publicDir, requestedPath));
    } catch (error) {
      json(response, 500, {
        error: "internal_error",
        message: error.message
      });
    }
  });

  server.listen(config.server.port, config.server.host, () => {
    console.log(`AutomationVideos listening on ${config.server.baseUrl}`);
  });
}

bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
