(function lazyPagePreloaderPanelBootstrap() {
  const existing = window.__lazyPagePreloaderPanel;
  if (existing?.destroy) {
    existing.destroy();
    return;
  }

  const PANEL_PORT_NAME = "lazy-page-preloader-panel";
  const ROOT_ID = "lazy-page-preloader-root";
  const HEARTBEAT_MS = 20000;

  const root = document.createElement("aside");
  root.id = ROOT_ID;
  root.innerHTML = `
    <div class="lpp-shell">
      <div class="lpp-header">
        <div>
          <h1 class="lpp-title">Lazy Page Preloader</h1>
          <p class="lpp-subtitle">Pinned page panel</p>
        </div>
        <button type="button" class="lpp-icon-button" data-role="close" aria-label="Close panel">x</button>
      </div>

      <form class="lpp-form" data-role="form">
        <label class="lpp-field">
          <span class="lpp-label">Paged URL</span>
          <textarea
            data-role="url"
            rows="3"
            placeholder="https://example.com/list?page=10"
            required
          ></textarea>
        </label>

        <div class="lpp-row">
          <label class="lpp-field">
            <span class="lpp-label">Pages</span>
            <input data-role="count" type="number" min="1" max="20" inputmode="numeric" required />
          </label>

          <label class="lpp-field">
            <span class="lpp-label">Wait Seconds</span>
            <input
              data-role="waitSeconds"
              type="number"
              min="3"
              max="30"
              inputmode="numeric"
              required
            />
          </label>
        </div>

        <button data-role="start" type="submit" class="lpp-primary-button">Start Preload</button>
      </form>

      <section class="lpp-panel">
        <div class="lpp-panel-header">
          <h2 class="lpp-panel-title">Status</h2>
          <button type="button" class="lpp-secondary-button" data-role="refresh-status">Refresh</button>
        </div>
        <p class="lpp-status-message" data-role="status-message">Loading...</p>
        <dl class="lpp-status-grid">
          <div>
            <dt>Phase</dt>
            <dd data-role="phase">idle</dd>
          </div>
          <div>
            <dt>Progress</dt>
            <dd data-role="progress">0 / 0</dd>
          </div>
          <div>
            <dt>Success</dt>
            <dd data-role="success-count">0</dd>
          </div>
          <div>
            <dt>Failed</dt>
            <dd data-role="failure-count">0</dd>
          </div>
        </dl>
      </section>

      <section class="lpp-panel">
        <div class="lpp-panel-header">
          <h2 class="lpp-panel-title">Debug Log</h2>
          <div class="lpp-actions">
            <button type="button" class="lpp-secondary-button" data-role="refresh-logs">Refresh</button>
            <button type="button" class="lpp-secondary-button" data-role="clear-logs">Clear</button>
          </div>
        </div>
        <textarea
          data-role="debug-logs"
          class="lpp-debug-logs"
          rows="12"
          readonly
          placeholder="Logs will appear here."
        ></textarea>
      </section>
    </div>
  `;

  document.documentElement.appendChild(root);

  const elements = {
    form: root.querySelector('[data-role="form"]'),
    url: root.querySelector('[data-role="url"]'),
    count: root.querySelector('[data-role="count"]'),
    waitSeconds: root.querySelector('[data-role="waitSeconds"]'),
    start: root.querySelector('[data-role="start"]'),
    statusMessage: root.querySelector('[data-role="status-message"]'),
    phase: root.querySelector('[data-role="phase"]'),
    progress: root.querySelector('[data-role="progress"]'),
    successCount: root.querySelector('[data-role="success-count"]'),
    failureCount: root.querySelector('[data-role="failure-count"]'),
    refreshStatus: root.querySelector('[data-role="refresh-status"]'),
    refreshLogs: root.querySelector('[data-role="refresh-logs"]'),
    clearLogs: root.querySelector('[data-role="clear-logs"]'),
    debugLogs: root.querySelector('[data-role="debug-logs"]'),
    close: root.querySelector('[data-role="close"]')
  };

  let isDestroyed = false;
  let heartbeatId = null;
  let port = null;

  const sendRuntimeMessage = async (message) => {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      return {
        ok: false,
        message: error?.message || "Failed to contact the extension background worker."
      };
    }
  };

  const onRuntimeMessage = (message) => {
    if (message?.type === "STATUS_UPDATE" && message.status) {
      renderStatus(message.status);
    }
  };

  const onSubmit = async (event) => {
    event.preventDefault();

    const payload = {
      url: elements.url.value,
      count: elements.count.value,
      waitSeconds: elements.waitSeconds.value
    };

    const validation = validateUserInput(payload);
    if (!validation.ok) {
      renderStatus(createIdleStatus(validation.message));
      return;
    }

    setBusy(true);
    renderStatus({
      ...createIdleStatus(),
      phase: "running",
      message: "Sending task to the background worker..."
    });

    try {
      const response = await sendRuntimeMessage({
        type: "START_PRELOAD",
        payload: validation.value
      });

      if (!response?.ok) {
        renderStatus(createIdleStatus(response?.message || "Failed to start task."));
        return;
      }

      renderStatus(response.status || createIdleStatus());
      await loadDebugLogs();
    } catch (error) {
      renderStatus(createIdleStatus(error?.message || "Failed to talk to the extension."));
    } finally {
      setBusy(false);
    }
  };

  const onRefreshStatus = async () => {
    const response = await sendRuntimeMessage({ type: "GET_STATUS" });
    if (response?.ok && response.status) {
      renderStatus(response.status);
      return;
    }

    renderStatus(createIdleStatus(response?.message || "Failed to refresh status."));
  };

  const onRefreshLogs = async () => {
    try {
      await loadDebugLogs();
    } catch (error) {
      elements.debugLogs.value = error?.message || String(error);
    }
  };

  const onClearLogs = async () => {
    try {
      await sendRuntimeMessage({ type: "CLEAR_DEBUG_LOGS" });
      elements.debugLogs.value = "";
    } catch (error) {
      elements.debugLogs.value = error?.message || String(error);
    }
  };

  const destroy = () => {
    if (isDestroyed) {
      return;
    }

    isDestroyed = true;
    window.__lazyPagePreloaderPanel = null;

    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    elements.form.removeEventListener("submit", onSubmit);
    elements.refreshStatus.removeEventListener("click", onRefreshStatus);
    elements.refreshLogs.removeEventListener("click", onRefreshLogs);
    elements.clearLogs.removeEventListener("click", onClearLogs);
    elements.close.removeEventListener("click", destroy);

    if (heartbeatId) {
      clearInterval(heartbeatId);
    }

    try {
      port?.disconnect();
    } catch (error) {
      void error;
    }

    root.remove();
  };

  window.__lazyPagePreloaderPanel = { destroy };

  elements.form.addEventListener("submit", onSubmit);
  elements.refreshStatus.addEventListener("click", onRefreshStatus);
  elements.refreshLogs.addEventListener("click", onRefreshLogs);
  elements.clearLogs.addEventListener("click", onClearLogs);
  elements.close.addEventListener("click", destroy);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  try {
    port = chrome.runtime.connect({ name: PANEL_PORT_NAME });
    heartbeatId = window.setInterval(() => {
      try {
        port.postMessage({ type: "PING", at: Date.now() });
      } catch (error) {
        void error;
      }
    }, HEARTBEAT_MS);
  } catch (error) {
    void error;
  }

  void init();

  async function init() {
    elements.count.value = "5";
    elements.waitSeconds.value = "8";

    const bootstrap = await sendRuntimeMessage({ type: "GET_PANEL_BOOTSTRAP" });
    const lastInput = bootstrap?.ok ? bootstrap.lastInput || null : null;
    if (lastInput) {
      elements.count.value = String(clampNumber(lastInput.count || 5, 1, 20));
      elements.waitSeconds.value = String(clampNumber(lastInput.waitSeconds || 8, 3, 30));
    }

    elements.url.value = getCurrentPageUrl() || lastInput?.url || "";
    renderStatus(
      bootstrap?.ok
        ? bootstrap.status || createIdleStatus()
        : createIdleStatus(bootstrap?.message || "Failed to initialize the panel.")
    );
    elements.debugLogs.value = formatDebugLogs(
      bootstrap?.ok && Array.isArray(bootstrap.logs) ? bootstrap.logs : []
    );
    await onRefreshStatus();
  }

  function getCurrentPageUrl() {
    return /^https?:/i.test(location.href) ? location.href : "";
  }

  function renderStatus(status) {
    const safeStatus = status || createIdleStatus();
    elements.statusMessage.textContent = safeStatus.message || "Ready.";
    elements.phase.textContent = safeStatus.phase || "idle";
    elements.progress.textContent = `${safeStatus.currentIndex || 0} / ${safeStatus.total || 0}`;
    elements.successCount.textContent = String(safeStatus.successCount || 0);
    elements.failureCount.textContent = String(safeStatus.failureCount || 0);
  }

  function setBusy(isBusy) {
    elements.start.disabled = isBusy;
    elements.start.textContent = isBusy ? "Starting..." : "Start Preload";
  }

  async function loadDebugLogs() {
    const response = await sendRuntimeMessage({ type: "GET_DEBUG_LOGS" });
    const logs = response?.ok && Array.isArray(response.logs) ? response.logs : [];
    elements.debugLogs.value = formatDebugLogs(logs);
  }

  function formatDebugLogs(logs) {
    if (!logs.length) {
      return "No debug logs yet.";
    }

    return logs
      .map((entry, index) => {
        const payload = JSON.stringify(entry.payload, null, 2);
        return `#${index + 1} ${entry.at} [${entry.type}]\n${payload}`;
      })
      .join("\n\n");
  }

  function clampNumber(value, min, max) {
    return Math.min(Math.max(Number(value) || min, min), max);
  }

  function normalizePositiveInteger(value) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function validateUserInput({ url, count, waitSeconds }) {
    const normalizedUrl = String(url || "").trim();
    if (!normalizedUrl) {
      return { ok: false, message: "Enter a URL that contains a page parameter." };
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(normalizedUrl);
    } catch {
      return { ok: false, message: "The URL is invalid." };
    }

    if (!/^https?:$/.test(parsedUrl.protocol)) {
      return { ok: false, message: "Only http and https URLs are supported." };
    }

    const pageValue = normalizePositiveInteger(parsedUrl.searchParams.get("page"));
    if (!pageValue) {
      return { ok: false, message: "The URL must contain page=<positive integer>." };
    }

    const normalizedCount = normalizePositiveInteger(count);
    if (!normalizedCount || normalizedCount < 1 || normalizedCount > 20) {
      return { ok: false, message: "Pages must be between 1 and 20." };
    }

    const normalizedWaitSeconds = normalizePositiveInteger(waitSeconds);
    if (!normalizedWaitSeconds || normalizedWaitSeconds < 3 || normalizedWaitSeconds > 30) {
      return { ok: false, message: "Wait seconds must be between 3 and 30." };
    }

    return {
      ok: true,
      value: {
        url: parsedUrl.toString(),
        count: normalizedCount,
        waitSeconds: normalizedWaitSeconds
      }
    };
  }

  function createIdleStatus(message = "Ready.") {
    return {
      phase: "idle",
      total: 0,
      currentIndex: 0,
      successCount: 0,
      failureCount: 0,
      message,
      startedAt: null
    };
  }
})();
