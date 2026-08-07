import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function parseEnvFile(content) {
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function loadDotEnv() {
  const envPath = path.join(projectRoot, ".env");
  try {
    const content = await fs.readFile(envPath, "utf8");
    const parsed = parseEnvFile(content);
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${name}: ${error.message}`);
  }
}

export async function loadConfig() {
  await loadDotEnv();

  const port = Number(process.env.PORT || "3455");
  const host = process.env.HOST || "127.0.0.1";
  const baseUrl = process.env.APP_BASE_URL || `http://${host}:${port}`;
  const redirectPath = process.env.TIKTOK_REDIRECT_PATH || "/api/tiktok/callback";
  const dataDir = path.resolve(projectRoot, process.env.DATA_DIR || "data");
  const runtimeDir = path.resolve(projectRoot, process.env.RUNTIME_DIR || "data/runtime");
  const workflowPath = path.resolve(projectRoot, process.env.COMFYUI_WORKFLOW_PATH || "workflows/comfyui_api.json");
  const rendererScriptPath = path.resolve(projectRoot, process.env.RENDERER_SCRIPT_PATH || "tools/render_video.py");

  const config = {
    projectRoot,
    server: {
      host,
      port,
      baseUrl
    },
    paths: {
      dataDir,
      runtimeDir,
      workflowPath,
      rendererScriptPath
    },
    tiktok: {
      clientKey: process.env.TIKTOK_CLIENT_KEY || "",
      clientSecret: process.env.TIKTOK_CLIENT_SECRET || "",
      scopes: (process.env.TIKTOK_SCOPES || "user.info.basic,video.publish").split(",").map((item) => item.trim()).filter(Boolean),
      redirectUri: `${baseUrl}${redirectPath}`,
      authStateTtlMs: Number(process.env.TIKTOK_AUTH_STATE_TTL_MS || "600000"),
      pollingIntervalMs: Number(process.env.TIKTOK_POLLING_INTERVAL_MS || "5000"),
      pollingTimeoutMs: Number(process.env.TIKTOK_POLLING_TIMEOUT_MS || "300000"),
      apiBaseUrl: process.env.TIKTOK_API_BASE_URL || "https://open.tiktokapis.com",
      authorizationUrl: process.env.TIKTOK_AUTHORIZATION_URL || "https://www.tiktok.com/v2/auth/authorize/",
      platform: process.env.TIKTOK_PLATFORM || "desktop"
    },
    pipeline: {
      defaultSceneCountMin: Number(process.env.DEFAULT_SCENE_COUNT_MIN || "6"),
      defaultSceneCountMax: Number(process.env.DEFAULT_SCENE_COUNT_MAX || "10"),
      captionWordsPerChunk: Number(process.env.CAPTION_WORDS_PER_CHUNK || "4"),
      imageWidth: Number(process.env.IMAGE_WIDTH || "1080"),
      imageHeight: Number(process.env.IMAGE_HEIGHT || "1920"),
      fps: Number(process.env.VIDEO_FPS || "30"),
      transitionSeconds: Number(process.env.VIDEO_TRANSITION_SECONDS || "0.35"),
      zoomStrength: Number(process.env.VIDEO_ZOOM_STRENGTH || "0.12"),
      promptSuffix:
        process.env.PROMPT_SUFFIX ||
        "cinematic, realistic, dramatic lighting, high detail, vertical 9:16, TikTok background, no text, no logos, no watermark",
      piperExecutable: process.env.PIPER_EXECUTABLE || "piper",
      piperArgs: parseJsonEnv("PIPER_ARGS_JSON", []),
      piperModelPath: process.env.PIPER_MODEL_PATH || "",
      piperVoiceConfigPath: process.env.PIPER_VOICE_CONFIG_PATH || "",
      voiceMasteringEnabled: process.env.VOICE_MASTERING_ENABLED !== "false",
      voiceMasteringFilter:
        process.env.VOICE_MASTERING_FILTER ||
        "highpass=f=70,lowpass=f=10500,acompressor=threshold=-18dB:ratio=2.5:attack=20:release=180:makeup=1.5,loudnorm=I=-16:LRA=7:TP=-1.5",
      ffmpegExecutable: process.env.FFMPEG_EXECUTABLE || "ffmpeg",
      comfyuiBaseUrl: process.env.COMFYUI_BASE_URL || "http://127.0.0.1:8188",
      rendererPythonExecutable: process.env.RENDERER_PYTHON_EXECUTABLE || "python",
      musicPath: process.env.BACKGROUND_MUSIC_PATH || "",
      fontPath: process.env.CAPTION_FONT_PATH || "",
      ffprobeExecutable: process.env.FFPROBE_EXECUTABLE || "ffprobe",
      fallbackFontFamily: process.env.CAPTION_FALLBACK_FONT || "Arial"
    }
  };

  return config;
}
