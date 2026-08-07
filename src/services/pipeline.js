import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { ensureDir, readJsonFile, writeJsonFile, safeSlug } from "../utils/files.js";
import { runCommand } from "../utils/exec.js";

function splitIntoSentences(text) {
  return text
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function deepReplace(value, replacements) {
  if (typeof value === "string") {
    let next = value;
    for (const [token, replacement] of Object.entries(replacements)) {
      next = next.split(token).join(String(replacement));
    }
    return next;
  }

  if (Array.isArray(value)) {
    return value.map((item) => deepReplace(item, replacements));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepReplace(item, replacements)]));
  }

  return value;
}

function buildSceneChunks(sentences, minScenes, maxScenes) {
  if (sentences.length === 0) {
    return [];
  }

  const targetScenes = clamp(Math.ceil(sentences.length / 2), minScenes, maxScenes);
  const chunkSize = Math.max(1, Math.ceil(sentences.length / targetScenes));
  const scenes = [];

  for (let index = 0; index < sentences.length; index += chunkSize) {
    scenes.push(sentences.slice(index, index + chunkSize).join(" "));
  }

  return scenes;
}

function buildCaptionChunks(text, wordsPerChunk) {
  const chunks = [];

  for (const sentence of splitIntoSentences(text)) {
    const words = sentence.split(/\s+/).map((item) => item.trim()).filter(Boolean);
    const chunkCount = Math.max(1, Math.ceil(words.length / wordsPerChunk));
    const baseChunkSize = Math.floor(words.length / chunkCount);
    const largerChunkCount = words.length % chunkCount;
    let cursor = 0;

    for (let index = 0; index < chunkCount; index += 1) {
      const chunkSize = baseChunkSize + (index < largerChunkCount ? 1 : 0);
      chunks.push(words.slice(cursor, cursor + chunkSize).join(" "));
      cursor += chunkSize;
    }
  }

  return chunks;
}

function buildCaptionTimeline(chunks, audioDurationSec) {
  if (!chunks.length || audioDurationSec <= 0) {
    return [];
  }

  const weightedChunks = chunks.map((text) => {
    const words = text.split(/\s+/).filter(Boolean);
    const characters = text.replace(/\s+/g, "").length;
    const commaPauses = (text.match(/[,;]/g) || []).length;
    const sentencePauses = (text.match(/[.!?]/g) || []).length;
    const clausePauses = (text.match(/[:—–]/g) || []).length;
    return {
      text,
      weight: Math.max(
        0.1,
        words.length * 0.18 +
          characters * 0.012 +
          commaPauses * 0.14 +
          clausePauses * 0.18 +
          sentencePauses * 0.28
      )
    };
  });

  const totalWeight = weightedChunks.reduce((sum, chunk) => sum + chunk.weight, 0);
  const maxEnd = Math.max(audioDurationSec, 0.1);
  const minimumDuration = Math.min(0.45, maxEnd / weightedChunks.length);
  const weightedDuration = Math.max(0, maxEnd - minimumDuration * weightedChunks.length);
  let cursor = 0;

  return weightedChunks.map((chunk, index) => {
    const duration = minimumDuration + (chunk.weight / totalWeight) * weightedDuration;
    const startSec = cursor;
    const endSec = index === weightedChunks.length - 1 ? maxEnd : Math.min(maxEnd, startSec + duration);

    cursor = endSec;

    return {
      index,
      text: chunk.text,
      startSec: Number(startSec.toFixed(3)),
      endSec: Number(endSec.toFixed(3))
    };
  });
}

function wavDurationSeconds(buffer) {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Generated Piper output is not a valid WAV file.");
  }

  let byteRate = 0;
  let dataSize = 0;
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;

    if (chunkId === "fmt " && chunkSize >= 12 && chunkDataOffset + 12 <= buffer.length) {
      byteRate = buffer.readUInt32LE(chunkDataOffset + 8);
    } else if (chunkId === "data") {
      dataSize = Math.min(chunkSize, Math.max(0, buffer.length - chunkDataOffset));
    }

    if (byteRate && dataSize) {
      break;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!byteRate || !dataSize) {
    throw new Error("Generated WAV file is missing duration metadata.");
  }

  return dataSize / byteRate;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export class PipelineService {
  constructor(config, store) {
    this.config = config;
    this.store = store;
    this.runningJobs = new Map();
  }

  async createJob({ scriptText, title }) {
    const normalizedTitle = (title || scriptText.split(/\r?\n/)[0] || "Untitled video").trim();
    const slug = safeSlug(normalizedTitle);
    const id = `${slug}_${Date.now()}`;
    const jobDir = path.join(this.config.paths.runtimeDir, "jobs", id);
    const job = {
      id,
      title: normalizedTitle,
      status: "queued",
      stage: "queued",
      progress: 0,
      statusMessage: "Waiting to start",
      metrics: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      scriptText,
      scriptPath: path.join(jobDir, "script.txt"),
      workDir: jobDir,
      scenes: [],
      prompts: [],
      captions: [],
      output: null,
      error: null,
      publish: null
    };

    await this.store.addJob(job);
    this.runInBackground(id).catch(() => {});
    return job;
  }

  async runInBackground(jobId) {
    if (this.runningJobs.has(jobId)) {
      return this.runningJobs.get(jobId);
    }

    const task = this.runJob(jobId).finally(() => {
      this.runningJobs.delete(jobId);
    });
    this.runningJobs.set(jobId, task);
    return task;
  }

  async runJob(jobId) {
    const job = await this.store.getJob(jobId);
    if (!job) {
      return;
    }

    try {
      await this.updateJob(jobId, {
        status: "running",
        stage: "preparing",
        progress: 5,
        statusMessage: "Preparing job workspace",
        error: null
      });
      await ensureDir(job.workDir);
      await ensureDir(path.join(job.workDir, "audio"));
      await ensureDir(path.join(job.workDir, "images"));
      await ensureDir(path.join(job.workDir, "output"));
      await fs.writeFile(job.scriptPath, job.scriptText, "utf8");

      const sentences = splitIntoSentences(job.scriptText);
      if (sentences.length === 0) {
        throw new Error("The script is empty. Add at least one sentence before generating.");
      }

      const scenes = buildSceneChunks(
        sentences,
        this.config.pipeline.defaultSceneCountMin,
        this.config.pipeline.defaultSceneCountMax
      ).map((sceneText, index) => ({
        index,
        text: sceneText,
        prompt: `${sceneText}, ${this.config.pipeline.promptSuffix}`
      }));

      const captions = buildCaptionChunks(job.scriptText, this.config.pipeline.captionWordsPerChunk);
      await this.updateJob(jobId, {
        stage: "voiceover",
        progress: 15,
        statusMessage: "Generating narration with Piper",
        scenes,
        prompts: scenes.map((scene) => scene.prompt),
        captions,
        metrics: {
          totalScenes: scenes.length,
          generatedScenes: 0
        }
      });

      const audioPath = path.join(job.workDir, "audio", "voice.wav");
      await this.generateVoiceover(job.scriptText, audioPath);
      const audioBuffer = await fs.readFile(audioPath);
      const audioDurationSec = wavDurationSeconds(audioBuffer);

      await this.updateJob(jobId, {
        stage: "images",
        progress: 25,
        statusMessage: `Generating scene 1 of ${scenes.length} in ComfyUI`
      });
      const imageAssets = await this.generateImages(job, scenes);

      const perSceneDurationSec = audioDurationSec / Math.max(1, scenes.length);
      const captionTimeline = buildCaptionTimeline(captions, audioDurationSec);

      await this.updateJob(jobId, {
        stage: "render",
        progress: 78,
        statusMessage: "Rendering video with MoviePy and FFmpeg"
      });
      const manifestPath = path.join(job.workDir, "output", "render-manifest.json");
      const videoPath = path.join(job.workDir, "output", "final_tiktok.mp4");
      const metadataPath = path.join(job.workDir, "output", "render-metadata.json");
      const manifest = {
        title: job.title,
        scriptText: job.scriptText,
        audioPath,
        audioDurationSec,
        videoPath,
        imageWidth: this.config.pipeline.imageWidth,
        imageHeight: this.config.pipeline.imageHeight,
        fps: this.config.pipeline.fps,
        transitionSeconds: this.config.pipeline.transitionSeconds,
        zoomStrength: this.config.pipeline.zoomStrength,
        musicPath: this.config.pipeline.musicPath || null,
        fontPath: this.config.pipeline.fontPath || null,
        fallbackFontFamily: this.config.pipeline.fallbackFontFamily,
        scenes: scenes.map((scene, index) => ({
          index,
          text: scene.text,
          prompt: scene.prompt,
          durationSec: Number(perSceneDurationSec.toFixed(3)),
          imagePath: imageAssets[index].imagePath
        })),
        captions: captionTimeline
      };
      await writeJsonFile(manifestPath, manifest);

      await this.renderVideo({ manifestPath, videoPath, metadataPath, cwd: job.workDir, jobId });

      const metadata = await readJsonFile(metadataPath);
      const output = {
        videoPath,
        audioPath,
        metadataPath,
        manifestPath,
        durationSec: metadata.durationSec,
        width: metadata.width,
        height: metadata.height,
        fps: metadata.fps,
        imageAssets
      };

      await this.updateJob(jobId, {
        status: "completed",
        stage: "completed",
        progress: 100,
        statusMessage: "Video is ready for review and publish",
        output,
        scenes,
        captions: captionTimeline
      });
    } catch (error) {
      await this.updateJob(jobId, {
        status: "failed",
        stage: "failed",
        progress: 100,
        statusMessage: "Generation failed",
        error: {
          message: error.message,
          stack: error.stack
        }
      });
    }
  }

  async updateJob(jobId, patch) {
    return this.store.updateJob(jobId, patch);
  }

  async generateVoiceover(scriptText, outputPath) {
    if (!this.config.pipeline.piperModelPath) {
      throw new Error("PIPER_MODEL_PATH is not configured.");
    }

    const rawOutputPath = outputPath.replace(/\.wav$/i, ".raw.wav");
    const args = [
      ...this.config.pipeline.piperArgs,
      "--model",
      this.config.pipeline.piperModelPath,
      "--output_file",
      rawOutputPath
    ];

    if (this.config.pipeline.piperVoiceConfigPath) {
      args.push("--config", this.config.pipeline.piperVoiceConfigPath);
    }

    await runCommand(this.config.pipeline.piperExecutable, args, {
      stdin: scriptText
    });

    if (!this.config.pipeline.voiceMasteringEnabled) {
      await fs.rename(rawOutputPath, outputPath);
      return;
    }

    try {
      await runCommand(this.config.pipeline.ffmpegExecutable, [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        rawOutputPath,
        "-af",
        this.config.pipeline.voiceMasteringFilter,
        "-ar",
        "48000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        outputPath
      ]);
    } finally {
      await fs.rm(rawOutputPath, { force: true });
    }
  }

  async generateImages(job, scenes) {
    const workflow = await readJsonFile(this.config.paths.workflowPath);
    const imageAssets = [];

    for (const scene of scenes) {
      await this.updateJob(job.id, {
        stage: "images",
        progress: Math.min(74, 25 + Math.round((scene.index / Math.max(1, scenes.length)) * 45)),
        statusMessage: `Generating scene ${scene.index + 1} of ${scenes.length} in ComfyUI`,
        metrics: {
          totalScenes: scenes.length,
          generatedScenes: scene.index
        }
      });

      const seed = crypto.randomInt(1, 2 ** 31);
      const promptGraph = deepReplace(workflow, {
        "{{prompt}}": scene.prompt,
        "{{seed}}": seed,
        "{{width}}": this.config.pipeline.imageWidth,
        "{{height}}": this.config.pipeline.imageHeight
      });

      const promptResponse = await fetch(`${this.config.pipeline.comfyuiBaseUrl}/prompt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ prompt: promptGraph })
      });

      const promptBody = await promptResponse.json();
      if (!promptResponse.ok || !promptBody.prompt_id) {
        throw new Error(`ComfyUI prompt submission failed for scene ${scene.index + 1}.`);
      }

      const promptId = promptBody.prompt_id;
      const history = await this.pollComfyHistory(promptId);
      const firstImage = this.extractFirstImage(history);
      if (!firstImage) {
        throw new Error(`ComfyUI did not return an image for scene ${scene.index + 1}.`);
      }

      const imageResponse = await fetch(
        `${this.config.pipeline.comfyuiBaseUrl}/view?filename=${encodeURIComponent(firstImage.filename)}&subfolder=${encodeURIComponent(firstImage.subfolder || "")}&type=${encodeURIComponent(firstImage.type || "output")}`
      );

      if (!imageResponse.ok) {
        throw new Error(`Failed to download ComfyUI image for scene ${scene.index + 1}.`);
      }

      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      const imagePath = path.join(job.workDir, "images", `scene-${String(scene.index + 1).padStart(2, "0")}.png`);
      await fs.writeFile(imagePath, imageBuffer);
      imageAssets.push({
        sceneIndex: scene.index,
        promptId,
        imagePath
      });

      await this.updateJob(job.id, {
        stage: "images",
        progress: Math.min(75, 25 + Math.round(((scene.index + 1) / Math.max(1, scenes.length)) * 45)),
        statusMessage: `Generated scene ${scene.index + 1} of ${scenes.length}`,
        metrics: {
          totalScenes: scenes.length,
          generatedScenes: scene.index + 1
        }
      });
    }

    return imageAssets;
  }

  async pollComfyHistory(promptId) {
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      const response = await fetch(`${this.config.pipeline.comfyuiBaseUrl}/history/${promptId}`);
      if (!response.ok) {
        throw new Error("Failed to query ComfyUI history.");
      }

      const body = await response.json();
      if (body[promptId]?.outputs) {
        return body[promptId];
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    throw new Error("Timed out waiting for ComfyUI image generation.");
  }

  extractFirstImage(historyEntry) {
    const outputs = historyEntry.outputs || {};
    for (const value of Object.values(outputs)) {
      if (value?.images?.length) {
        return value.images[0];
      }
    }
    return null;
  }

  async renderVideo({ manifestPath, videoPath, metadataPath, cwd, jobId }) {
    if (!(await fileExists(this.config.paths.rendererScriptPath))) {
      throw new Error(`Renderer script not found at ${this.config.paths.rendererScriptPath}.`);
    }

    const interval = setInterval(async () => {
      try {
        if (await fileExists(videoPath)) {
          const stats = await fs.stat(videoPath);
          const estimatedProgress = Math.min(96, 78 + Math.round(Math.min(1, stats.size / 12_000_000) * 18));
          await this.updateJob(jobId, {
            stage: "render",
            progress: estimatedProgress,
            statusMessage: `Rendering video (${(stats.size / 1024 / 1024).toFixed(1)} MB written)`
          });
        }
      } catch {
        // Ignore transient stat failures while the renderer is creating the file.
      }
    }, 2000);

    try {
      await runCommand(
        this.config.pipeline.rendererPythonExecutable,
        [this.config.paths.rendererScriptPath, "--manifest", manifestPath, "--output", videoPath, "--metadata", metadataPath],
        { cwd }
      );
    } finally {
      clearInterval(interval);
    }

    if (!(await fileExists(videoPath))) {
      throw new Error("Renderer did not produce the final MP4 file.");
    }

    if (!(await fileExists(metadataPath))) {
      throw new Error("Renderer did not produce render metadata.");
    }
  }
}

export const pipelineInternals = {
  splitIntoSentences,
  buildSceneChunks,
  buildCaptionChunks,
  buildCaptionTimeline,
  wavDurationSeconds,
  deepReplace
};
