# Automation Videos

Localhost app for generating vertical AI-assisted videos and publishing them to TikTok with the official `video.publish` flow.

## What this app does

- Connects one TikTok creator account through Login Kit / OAuth.
- Fetches creator-specific publish capabilities before showing post settings.
- Generates a local MP4 from a script using:
  - Piper for narration
  - ComfyUI for background images
  - MoviePy + FFmpeg through the bundled Python renderer
- Requires explicit publish consent inside the app before uploading.
- Direct-posts with TikTok's Content Posting API and polls publish status.

## Requirements

- Node.js 20+
- Python 3.11+
- FFmpeg available to MoviePy
- Piper installed locally
- ComfyUI running locally with a working API workflow
- A TikTok developer app with:
  - Login Kit enabled
  - Content Posting API enabled
  - `video.publish` approved
  - a redirect URI registered for desktop-style localhost auth

## Setup

1. Copy `.env.example` to `.env`.
2. Fill in `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET`.
3. Set `PIPER_MODEL_PATH` to your downloaded voice model. The local setup uses `en_US-lessac-high` with slightly slower pacing for more natural narration.
4. Update `workflows/comfyui_api.json` to match the workflow and checkpoint on your ComfyUI install.
5. Install Python packages:

```bash
pip install -r requirements.txt
```

6. Start ComfyUI:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-comfyui.ps1
```

7. Start the app:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-app.ps1
```

8. Open [http://127.0.0.1:3455](http://127.0.0.1:3455).

## Notes

- The app is designed for one self-use TikTok account.
- The privacy dropdown intentionally has no default value because TikTok requires a manual choice.
- Preset title text stays editable before publish.
- During unaudited testing, TikTok may restrict posted content to private visibility.
- The app uses `FILE_UPLOAD` because the rendered MP4 lives locally on the same machine.
- Generated narration is mastered with FFmpeg for clearer speech, consistent loudness, and safe output peaks. Set `VOICE_MASTERING_ENABLED=false` to retain Piper's raw WAV output.

## Project structure

- `src/` Node server, persistence, TikTok integration, and generation coordinator
- `public/` localhost UI
- `tools/render_video.py` MoviePy renderer invoked by the Node pipeline
- `workflows/comfyui_api.json` starter API graph for ComfyUI
- `data/state.json` runtime state store

## Verification

Run the Node tests:

```bash
npm test
```
