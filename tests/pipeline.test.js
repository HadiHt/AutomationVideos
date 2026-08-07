import test from "node:test";
import assert from "node:assert/strict";

import { pipelineInternals } from "../src/services/pipeline.js";

test("scene chunking keeps the script within the configured scene window", () => {
  const sentences = [
    "One.",
    "Two.",
    "Three.",
    "Four.",
    "Five.",
    "Six.",
    "Seven.",
    "Eight."
  ];

  const scenes = pipelineInternals.buildSceneChunks(sentences, 3, 6);
  assert.equal(scenes.length, 4);
  assert.equal(scenes[0], "One. Two.");
  assert.equal(scenes[3], "Seven. Eight.");
});

test("caption chunking groups words into readable slices", () => {
  const captions = pipelineInternals.buildCaptionChunks("In 1919 a small village woke up to total silence", 4);
  assert.deepEqual(captions, ["In 1919 a small", "village woke up", "to total silence"]);
});

test("caption chunking never crosses sentence boundaries", () => {
  const captions = pipelineInternals.buildCaptionChunks("The first sentence ends here. The next one starts cleanly.", 4);
  assert.deepEqual(captions, ["The first sentence", "ends here.", "The next one", "starts cleanly."]);
});

test("caption timeline keeps later captions on screen proportionally to text length", () => {
  const timeline = pipelineInternals.buildCaptionTimeline(
    ["Short line", "This caption chunk is meaningfully longer", "End"],
    9
  );

  assert.equal(timeline.length, 3);
  assert.equal(timeline[0].startSec, 0);
  assert.ok(timeline[1].endSec - timeline[1].startSec > timeline[0].endSec - timeline[0].startSec);
  assert.equal(timeline[2].endSec, 9);
  assert.equal(timeline[1].startSec, timeline[0].endSec);
  assert.equal(timeline[2].startSec, timeline[1].endSec);
});

test("caption timeline does not collapse captions at the end of a dense narration", () => {
  const captions = Array.from({ length: 31 }, (_, index) => `Caption number ${index + 1} ends here.`);
  const timeline = pipelineInternals.buildCaptionTimeline(captions, 41.784);

  for (let index = 0; index < timeline.length; index += 1) {
    const caption = timeline[index];
    assert.ok(caption.endSec > caption.startSec, `caption ${index} must have positive duration`);
    assert.ok(caption.endSec - caption.startSec >= 0.44, `caption ${index} must remain readable`);
    if (index > 0) {
      assert.equal(caption.startSec, timeline[index - 1].endSec);
    }
  }

  assert.equal(timeline.at(-1).endSec, 41.784);
});

test("deepReplace injects prompt and dimensions into a workflow tree", () => {
  const workflow = {
    prompt: "{{prompt}}",
    nested: {
      width: "{{width}}",
      height: "{{height}}"
    }
  };

  const result = pipelineInternals.deepReplace(workflow, {
    "{{prompt}}": "foggy village at dawn",
    "{{width}}": 1080,
    "{{height}}": 1920
  });

  assert.equal(result.prompt, "foggy village at dawn");
  assert.equal(result.nested.width, "1080");
  assert.equal(result.nested.height, "1920");
});

test("WAV duration parsing supports metadata chunks added by FFmpeg", () => {
  const makeChunk = (id, data) => {
    const padding = data.length % 2;
    const chunk = Buffer.alloc(8 + data.length + padding);
    chunk.write(id, 0, 4, "ascii");
    chunk.writeUInt32LE(data.length, 4);
    data.copy(chunk, 8);
    return chunk;
  };

  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(1, 2);
  format.writeUInt32LE(48000, 4);
  format.writeUInt32LE(96000, 8);
  format.writeUInt16LE(2, 12);
  format.writeUInt16LE(16, 14);

  const chunks = [
    makeChunk("fmt ", format),
    makeChunk("LIST", Buffer.from("voice mastering metadata")),
    makeChunk("data", Buffer.alloc(96000))
  ];
  const wave = Buffer.alloc(12 + chunks.reduce((total, chunk) => total + chunk.length, 0));
  wave.write("RIFF", 0, 4, "ascii");
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write("WAVE", 8, 4, "ascii");
  let offset = 12;
  for (const chunk of chunks) {
    chunk.copy(wave, offset);
    offset += chunk.length;
  }

  assert.equal(pipelineInternals.wavDurationSeconds(wave), 1);
});
