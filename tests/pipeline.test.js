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
  assert.deepEqual(captions, ["In 1919 a small", "village woke up to", "total silence"]);
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
