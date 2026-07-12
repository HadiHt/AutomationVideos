const state = {
  app: null,
  selectedJobId: null,
  pollTimer: null,
  videoPlayback: {
    jobId: null,
    currentTime: 0,
    paused: true
  },
  lastJobSnapshot: null,
  publishFormJobId: null
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    const message = body?.message || body?.error || `Request failed: ${response.status}`;
    throw new Error(message);
  }

  return body;
}

function formatDate(value) {
  if (!value) {
    return "Not available";
  }
  return new Date(value).toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function setStatus(message) {
  document.getElementById("server-status").textContent = message;
}

function currentJob() {
  return state.app?.jobs?.find((job) => job.id === state.selectedJobId) || state.app?.jobs?.[0] || null;
}

function getJobSignature(job) {
  if (!job) {
    return "";
  }

  return JSON.stringify({
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    updatedAt: job.updatedAt,
    outputPath: job.output?.videoPath || null,
    error: job.error?.message || null
  });
}

function captureVideoPlayback() {
  const video = document.querySelector("#job-detail video");
  const job = currentJob();
  if (!video || !job) {
    return;
  }

  state.videoPlayback = {
    jobId: job.id,
    currentTime: video.currentTime || 0,
    paused: video.paused
  };
}

function isReviewVideoPlaying() {
  const video = document.querySelector("#job-detail video");
  return Boolean(video && !video.paused && !video.ended);
}

function renderProgress(job) {
  const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));
  const label = job.statusMessage || `${job.status} / ${job.stage}`;
  return `
    <div class="progress-block">
      <div class="progress-copy">
        <strong>${escapeHtml(label)}</strong>
        <span>${progress}%</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill ${escapeHtml(job.status)}" style="width:${progress}%"></div>
      </div>
    </div>
  `;
}

function renderAccount() {
  const account = state.app?.account;
  const node = document.getElementById("account-card");

  if (!account) {
    node.innerHTML = `
      <div class="empty-state">
        <p>No TikTok account is connected yet.</p>
        <p>Connect your self-use creator account before attempting direct post.</p>
      </div>
    `;
    return;
  }

  const creator = account.creatorInfo;
  node.innerHTML = `
    <div class="account-grid">
      <div class="meta-card">
        <strong>Open ID</strong>
        <div class="mono">${escapeHtml(account.openId)}</div>
      </div>
      <div class="meta-card">
        <strong>Scopes</strong>
        <div>${escapeHtml(account.scope || "Unknown")}</div>
      </div>
      <div class="meta-card">
        <strong>Connected</strong>
        <div>${formatDate(account.connectedAt)}</div>
      </div>
      <div class="meta-card">
        <strong>Access token expires</strong>
        <div>${formatDate(account.accessTokenExpiresAt)}</div>
      </div>
    </div>
    ${
      creator
        ? `
          <div class="detail-block" style="margin-top:16px">
            <h3>${escapeHtml(creator.creator_nickname || "Connected creator")}</h3>
            <div class="meta-grid">
              <div class="meta-card">
                <strong>Username</strong>
                <div>${escapeHtml(creator.creator_username || "Unknown")}</div>
              </div>
              <div class="meta-card">
                <strong>Privacy options</strong>
                <div>${creator.privacy_level_options.map((item) => escapeHtml(item)).join(", ")}</div>
              </div>
              <div class="meta-card">
                <strong>Max duration</strong>
                <div>${creator.max_video_post_duration_sec} seconds</div>
              </div>
              <div class="meta-card">
                <strong>Comments / Duet / Stitch</strong>
                <div>${creator.comment_disabled ? "locked" : "available"} / ${creator.duet_disabled ? "locked" : "available"} / ${creator.stitch_disabled ? "locked" : "available"}</div>
              </div>
            </div>
          </div>
        `
        : `
          <div class="empty-state" style="margin-top:16px">
            <p>Creator capabilities have not been fetched yet.</p>
            <p>Use "Refresh creator info" to load privacy options, duration limits, and interaction rules from TikTok.</p>
          </div>
        `
    }
  `;
}

function renderJobs() {
  const node = document.getElementById("jobs-list");
  const jobs = state.app?.jobs || [];

  if (!jobs.length) {
    node.innerHTML = `<div class="empty-state"><p>No jobs yet. Generate your first script-to-video run.</p></div>`;
    return;
  }

  if (!state.selectedJobId) {
    state.selectedJobId = jobs[0].id;
  }

  node.innerHTML = jobs
    .map((job) => {
      const active = job.id === state.selectedJobId ? "active" : "";
      return `
        <article class="job-card ${active}" data-job-id="${escapeHtml(job.id)}">
          <div class="job-card-header">
            <div>
              <h3>${escapeHtml(job.title)}</h3>
              <div class="meta-list">Created ${formatDate(job.createdAt)}</div>
            </div>
            <div class="status-chip ${escapeHtml(job.status)}">${escapeHtml(job.status)} / ${escapeHtml(job.stage)}</div>
          </div>
          ${renderProgress(job)}
          <div class="job-grid" style="margin-top:14px">
            <div class="meta-card">
              <strong>Scenes</strong>
              <div>${job.scenes?.length || 0}</div>
            </div>
            <div class="meta-card">
              <strong>Captions</strong>
              <div>${job.captions?.length || 0}</div>
            </div>
            <div class="meta-card">
              <strong>Duration</strong>
              <div>${job.output?.durationSec ? `${job.output.durationSec.toFixed(1)}s` : "Pending"}</div>
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  node.querySelectorAll("[data-job-id]").forEach((element) => {
    element.addEventListener("click", () => {
      state.selectedJobId = element.getAttribute("data-job-id");
      renderJobs();
      renderJobDetail();
      syncPublishForm();
    });
  });
}

function renderJobDetail() {
  const job = currentJob();
  const node = document.getElementById("job-detail");

  captureVideoPlayback();

  if (!job) {
    node.innerHTML = "Select a job to review.";
    return;
  }

  if (job.status === "failed") {
    node.innerHTML = `
      <div class="detail-block">
        <h3>${escapeHtml(job.title)}</h3>
        <p class="status-chip failed">Generation failed</p>
        <pre>${escapeHtml(job.error?.message || "Unknown error")}</pre>
      </div>
    `;
    return;
  }

  const outputPreview = job.output?.videoPath
    ? `<div class="preview-frame"><video controls src="/api/jobs/${encodeURIComponent(job.id)}/video"></video></div>`
    : `<div class="preview-frame empty-state"><p>Video preview will appear after the render completes.</p></div>`;

  node.innerHTML = `
    <div class="detail-grid">
      <div>
        ${outputPreview}
        <div class="detail-block" style="margin-top:14px">
          <h3>${escapeHtml(job.title)}</h3>
          <div class="status-chip ${escapeHtml(job.status)}">${escapeHtml(job.status)} / ${escapeHtml(job.stage)}</div>
          ${renderProgress(job)}
          <p class="supporting-copy">Updated ${formatDate(job.updatedAt)}</p>
          <pre>${escapeHtml(job.scriptText || "")}</pre>
        </div>
      </div>
      <div class="detail-columns">
        <div class="detail-block">
          <h4>Render metadata</h4>
          <div class="meta-grid">
            <div class="meta-card"><strong>Duration</strong><div>${job.output?.durationSec ? `${job.output.durationSec.toFixed(2)}s` : "Pending"}</div></div>
            <div class="meta-card"><strong>Resolution</strong><div>${job.output?.width || "-"} x ${job.output?.height || "-"}</div></div>
            <div class="meta-card"><strong>FPS</strong><div>${job.output?.fps || "-"}</div></div>
            <div class="meta-card"><strong>Images</strong><div>${job.output?.imageAssets?.length || 0}</div></div>
            <div class="meta-card"><strong>Scene progress</strong><div>${job.metrics?.generatedScenes ?? 0} / ${job.metrics?.totalScenes ?? job.scenes?.length ?? 0}</div></div>
          </div>
        </div>
        <div class="detail-block">
          <h4>Scene prompts</h4>
          <div class="scene-list">
            ${(job.scenes || []).map((scene) => `
              <div class="scene-item">
                <strong>Scene ${scene.index + 1}</strong>
                <div>${escapeHtml(scene.text)}</div>
                <div class="supporting-copy">${escapeHtml(scene.prompt || "")}</div>
              </div>
            `).join("") || "<p>No scenes yet.</p>"}
          </div>
        </div>
        <div class="detail-block">
          <h4>Caption timeline</h4>
          <div class="timeline-list">
            ${(job.captions || []).map((caption) => `
              <div class="timeline-item">
                <strong>${caption.startSec?.toFixed?.(2) ?? "-"}s to ${caption.endSec?.toFixed?.(2) ?? "-"}s</strong>
                <div>${escapeHtml(caption.text || "")}</div>
              </div>
            `).join("") || "<p>No captions yet.</p>"}
          </div>
        </div>
      </div>
    </div>
  `;

  const video = node.querySelector("video");
  if (video) {
    const playback = state.videoPlayback;
    if (playback.jobId === job.id) {
      video.addEventListener(
        "loadedmetadata",
        () => {
          if (playback.currentTime > 0) {
            video.currentTime = Math.min(playback.currentTime, Math.max(0, video.duration || playback.currentTime));
          }
          if (!playback.paused) {
            video.play().catch(() => {});
          }
        },
        { once: true }
      );
    }

    const syncPlayback = () => {
      state.videoPlayback = {
        jobId: job.id,
        currentTime: video.currentTime || 0,
        paused: video.paused
      };
    };

    video.addEventListener("timeupdate", syncPlayback);
    video.addEventListener("pause", syncPlayback);
    video.addEventListener("play", syncPlayback);
  }
}

function syncPublishForm() {
  const job = currentJob();
  const creatorInfo = state.app?.account?.creatorInfo;
  const privacySelect = document.getElementById("privacy-level");
  const publishTitle = document.getElementById("publish-title");
  const disableComment = document.getElementById("disable-comment");
  const disableDuet = document.getElementById("disable-duet");
  const disableStitch = document.getElementById("disable-stitch");
  const consentCheckbox = document.getElementById("consent-checkbox");
  const visibilityCheckbox = document.getElementById("visibility-checkbox");
  const publishButton = document.getElementById("publish-button");

  const preserveValues = Boolean(job && state.publishFormJobId === job.id);
  const formValues = {
    title: publishTitle.value,
    privacyLevel: privacySelect.value,
    disableComment: disableComment.checked,
    disableDuet: disableDuet.checked,
    disableStitch: disableStitch.checked,
    consent: consentCheckbox.checked,
    visibilityNotice: visibilityCheckbox.checked
  };

  privacySelect.innerHTML = `<option value="">Choose a privacy level manually</option>`;
  (creatorInfo?.privacy_level_options || []).forEach((option) => {
    const node = document.createElement("option");
    node.value = option;
    node.textContent = option;
    privacySelect.appendChild(node);
  });

  publishTitle.value = preserveValues ? formValues.title : job?.title || "";
  privacySelect.value = preserveValues && Array.from(privacySelect.options).some((option) => option.value === formValues.privacyLevel)
    ? formValues.privacyLevel
    : "";

  disableComment.disabled = Boolean(creatorInfo?.comment_disabled);
  disableDuet.disabled = Boolean(creatorInfo?.duet_disabled);
  disableStitch.disabled = Boolean(creatorInfo?.stitch_disabled);

  disableComment.checked = disableComment.disabled || (preserveValues && formValues.disableComment);
  disableDuet.checked = disableDuet.disabled || (preserveValues && formValues.disableDuet);
  disableStitch.checked = disableStitch.disabled || (preserveValues && formValues.disableStitch);
  consentCheckbox.checked = preserveValues && formValues.consent;
  visibilityCheckbox.checked = preserveValues && formValues.visibilityNotice;

  publishButton.disabled = !job || job.status !== "completed" || !creatorInfo;
  state.publishFormJobId = job?.id || null;
}

function renderPublishHistory() {
  const node = document.getElementById("publish-history");
  const items = state.app?.publishes || [];
  if (!items.length) {
    node.innerHTML = `<div class="empty-state"><p>No publish attempts yet.</p></div>`;
    return;
  }

  node.innerHTML = items
    .map((item) => `
      <article class="history-card">
        <div class="history-card-header">
          <div>
            <h3>${escapeHtml(item.publishId)}</h3>
            <div class="meta-list">Job ${escapeHtml(item.jobId)}</div>
          </div>
          <div class="status-chip ${escapeHtml((item.status || "").toLowerCase())}">${escapeHtml(item.status || "Unknown")}</div>
        </div>
        <div class="meta-grid" style="margin-top:14px">
          <div class="meta-card"><strong>Updated</strong><div>${formatDate(item.updatedAt)}</div></div>
          <div class="meta-card"><strong>Fail reason</strong><div>${escapeHtml(item.failReason || "None")}</div></div>
          <div class="meta-card"><strong>Public post IDs</strong><div>${escapeHtml((item.publiclyAvailablePostId || []).join(", ") || "Pending")}</div></div>
        </div>
      </article>
    `)
    .join("");
}

async function refreshState() {
  const previousJob = currentJob();
  const previousSignature = getJobSignature(previousJob);
  const preservePlayingVideo = isReviewVideoPlaying();
  const appState = await api("/api/state");
  state.app = appState;
  if (!state.selectedJobId && appState.jobs?.length) {
    state.selectedJobId = appState.jobs[0].id;
  }
  const nextJob = currentJob();
  const nextSignature = getJobSignature(nextJob);
  setStatus(`App state synced at ${new Date().toLocaleTimeString()}`);
  renderAccount();
  renderJobs();
  if (!(preservePlayingVideo && previousJob?.id === nextJob?.id && previousJob?.status === "completed" && nextJob?.status === "completed")) {
    if (previousSignature !== nextSignature || state.lastJobSnapshot !== nextSignature) {
      renderJobDetail();
      state.lastJobSnapshot = nextSignature;
    }
  }
  syncPublishForm();
  renderPublishHistory();
}

async function handleGenerateSubmit(event) {
  event.preventDefault();
  const title = document.getElementById("title-input").value.trim();
  const scriptText = document.getElementById("script-input").value.trim();
  if (!scriptText) {
    setStatus("Add a script before generating.");
    return;
  }

  setStatus("Starting generation job...");
  await api("/api/generate", {
    method: "POST",
    body: JSON.stringify({ title, scriptText })
  });
  document.getElementById("script-input").value = "";
  document.getElementById("title-input").value = "";
  await refreshState();
}

async function handleRefreshCreator() {
  setStatus("Refreshing TikTok creator info...");
  await api("/api/tiktok/creator-info");
  await refreshState();
}

async function handlePublishSubmit(event) {
  event.preventDefault();
  const job = currentJob();
  if (!job) {
    setStatus("Select a completed job first.");
    return;
  }

  const payload = {
    jobId: job.id,
    title: document.getElementById("publish-title").value.trim(),
    privacyLevel: document.getElementById("privacy-level").value,
    disableComment: document.getElementById("disable-comment").checked,
    disableDuet: document.getElementById("disable-duet").checked,
    disableStitch: document.getElementById("disable-stitch").checked,
    consent: document.getElementById("consent-checkbox").checked,
    unauditedVisibilityNoticeAccepted: document.getElementById("visibility-checkbox").checked
  };

  const feedback = document.getElementById("publish-feedback");
  feedback.className = "publish-feedback";
  feedback.textContent = "";

  try {
    const result = await api("/api/tiktok/publish", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    feedback.classList.add("success");
    feedback.textContent = `Upload accepted. TikTok publish ID: ${result.publish.publishId}`;
    await refreshState();
  } catch (error) {
    feedback.classList.add("error");
    feedback.textContent = error.message;
  }
}

function startPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
  }
  state.pollTimer = setInterval(() => {
    refreshState().catch((error) => {
      setStatus(error.message);
    });
  }, 4000);
}

async function init() {
  document.getElementById("generate-form").addEventListener("submit", (event) => {
    handleGenerateSubmit(event).catch((error) => setStatus(error.message));
  });

  document.getElementById("refresh-creator-info").addEventListener("click", (event) => {
    event.preventDefault();
    handleRefreshCreator().catch((error) => setStatus(error.message));
  });

  document.getElementById("publish-form").addEventListener("submit", (event) => {
    handlePublishSubmit(event).catch((error) => setStatus(error.message));
  });

  await refreshState();
  startPolling();
}

init().catch((error) => {
  setStatus(error.message);
});
