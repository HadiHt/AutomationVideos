import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from moviepy.audio.fx.all import audio_loop
from moviepy.editor import AudioFileClip, CompositeAudioClip, CompositeVideoClip, ImageClip, concatenate_videoclips
import moviepy.video.fx.all as vfx


def load_manifest(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def ensure_parent(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)


def load_font(font_path, fallback_family, size):
    if font_path and Path(font_path).exists():
        return ImageFont.truetype(font_path, size=size)

    candidate_families = [
        fallback_family,
        "arial.ttf",
        "segoeui.ttf",
        "DejaVuSans.ttf"
    ]
    for candidate in candidate_families:
        try:
            return ImageFont.truetype(candidate, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def build_caption_overlay(caption, width, height, font_path, fallback_family, temp_dir):
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    font = load_font(font_path, fallback_family, max(28, width // 17))
    max_text_width = int(width * 0.8)

    words = caption["text"].split()
    lines = []
    current_line = []
    for word in words:
        candidate = " ".join(current_line + [word])
        bbox = draw.textbbox((0, 0), candidate, font=font, stroke_width=4)
        if bbox[2] - bbox[0] > max_text_width and current_line:
            lines.append(" ".join(current_line))
            current_line = [word]
        else:
            current_line.append(word)
    if current_line:
        lines.append(" ".join(current_line))

    line_gap = 12
    line_boxes = [draw.textbbox((0, 0), line, font=font, stroke_width=4) for line in lines]
    total_height = sum((box[3] - box[1]) for box in line_boxes) + (len(lines) - 1) * line_gap
    start_y = int(height * 0.68 - total_height / 2)

    for index, line in enumerate(lines):
        box = line_boxes[index]
        line_width = box[2] - box[0]
        x = int((width - line_width) / 2)
        y = start_y + sum((line_boxes[item][3] - line_boxes[item][1]) + line_gap for item in range(index))
        draw.text((x, y), line, font=font, fill="white", stroke_width=4, stroke_fill="black")

    overlay_path = Path(temp_dir) / f"caption-{caption['index']:03d}.png"
    image.save(overlay_path)
    return str(overlay_path)


def build_scene_clip(scene, width, height, transition_seconds, zoom_strength):
    clip = (
        ImageClip(scene["imagePath"])
        .set_duration(scene["durationSec"] + transition_seconds)
        .resize(height=height)
        .fx(vfx.resize, lambda t: 1 + (zoom_strength * min(1.0, t / max(scene["durationSec"], 0.001))))
        .set_position("center")
    )

    if clip.w < width:
        clip = clip.resize(width=width)

    return clip.crop(x_center=clip.w / 2, y_center=clip.h / 2, width=width, height=height)


def compose_video(manifest, output_path, metadata_path):
    width = int(manifest["imageWidth"])
    height = int(manifest["imageHeight"])
    fps = int(manifest["fps"])
    transition_seconds = float(manifest["transitionSeconds"])
    zoom_strength = float(manifest["zoomStrength"])

    audio_clip = AudioFileClip(manifest["audioPath"])
    temp_dir = Path(output_path).parent / "captions"
    temp_dir.mkdir(parents=True, exist_ok=True)

    scene_clips = [
        build_scene_clip(scene, width, height, transition_seconds, zoom_strength)
        for scene in manifest["scenes"]
    ]
    video_clip = concatenate_videoclips(scene_clips, method="compose", padding=-transition_seconds)

    caption_layers = []
    for caption in manifest["captions"]:
        overlay_path = build_caption_overlay(
            caption,
            width,
            height,
            manifest.get("fontPath"),
            manifest.get("fallbackFontFamily", "Arial"),
            temp_dir
        )
        caption_clip = (
            ImageClip(overlay_path)
            .set_start(float(caption["startSec"]))
            .set_end(float(caption["endSec"]))
            .set_position((0, 0))
        )
        caption_layers.append(caption_clip)

    final_clip = CompositeVideoClip([video_clip] + caption_layers, size=(width, height)).set_audio(audio_clip)

    music_path = manifest.get("musicPath")
    if music_path and Path(music_path).exists():
        music_clip = audio_loop(AudioFileClip(music_path).volumex(0.18), duration=final_clip.duration)
        final_clip = final_clip.set_audio(CompositeAudioClip([audio_clip, music_clip]))

    ensure_parent(output_path)
    final_clip.write_videofile(
        output_path,
        fps=fps,
        codec="libx264",
        audio_codec="aac",
        temp_audiofile=str(Path(output_path).with_suffix(".audio.m4a")),
        remove_temp=True,
        threads=4
    )

    with open(metadata_path, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "durationSec": final_clip.duration,
                "width": width,
                "height": height,
                "fps": fps
            },
            handle,
            indent=2
        )

    final_clip.close()
    audio_clip.close()


def main():
    parser = argparse.ArgumentParser(description="Render a vertical TikTok video from a generation manifest.")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--metadata", required=True)
    args = parser.parse_args()

    manifest = load_manifest(args.manifest)
    compose_video(manifest, args.output, args.metadata)


if __name__ == "__main__":
    main()
