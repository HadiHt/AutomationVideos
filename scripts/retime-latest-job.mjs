import fs from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "../src/config.js";
import { PipelineService, pipelineInternals } from "../src/services/pipeline.js";
import { JsonStore } from "../src/store.js";
import { runCommand } from "../src/utils/exec.js";

const config = await loadConfig();
const store = new JsonStore(path.join(config.paths.dataDir, "state.json"));
const state = await store.getState();
const job = state.jobs.find((item) => item.status === "completed" && item.output?.manifestPath && item.output?.videoPath);

if (!job) {
  throw new Error("No completed video job is available to retime.");
}

const originalManifest = JSON.parse(await fs.readFile(job.output.manifestPath, "utf8"));
const captionChunks = pipelineInternals.buildCaptionChunks(job.scriptText, config.pipeline.captionWordsPerChunk);
const captions = pipelineInternals.buildCaptionTimeline(captionChunks, originalManifest.audioDurationSec);
const outputDir = path.dirname(job.output.videoPath);
const retimedManifestPath = path.join(outputDir, "render-manifest-retimed.json");
const retimedVideoPath = path.join(outputDir, "final_tiktok_retimed.mp4");
const retimedMetadataPath = path.join(outputDir, "render-metadata-retimed.json");

await fs.writeFile(
  retimedManifestPath,
  JSON.stringify({ ...originalManifest, captions, videoPath: retimedVideoPath }, null, 2),
  "utf8"
);

await runCommand(
  config.pipeline.rendererPythonExecutable,
  [
    config.paths.rendererScriptPath,
    "--manifest",
    retimedManifestPath,
    "--output",
    retimedVideoPath,
    "--metadata",
    retimedMetadataPath
  ],
  { cwd: job.workDir }
);

const metadata = JSON.parse(await fs.readFile(retimedMetadataPath, "utf8"));
await store.updateJob(job.id, {
  captions,
  output: {
    ...job.output,
    videoPath: retimedVideoPath,
    manifestPath: retimedManifestPath,
    metadataPath: retimedMetadataPath,
    durationSec: metadata.durationSec,
    width: metadata.width,
    height: metadata.height,
    fps: metadata.fps
  }
});

console.log(
  JSON.stringify({
    jobId: job.id,
    captionCount: captions.length,
    videoPath: retimedVideoPath,
    firstCaption: captions[0],
    lastCaption: captions.at(-1)
  })
);
