(function lazyPagePreloaderPanelBootstrap() {
  const ROOT_ID = "lazy-page-preloader-root";
  const existing = window.__lazyPagePreloaderPanel;
  const existingRoot = document.getElementById(ROOT_ID);
  if (existingRoot && existing?.destroy) {
    try {
      existing.destroy();
    } catch (error) {
      existingRoot.remove();
      window.__lazyPagePreloaderPanel = null;
    }
  }

  if (existingRoot) {
    existingRoot.remove();
  }

  if (existing?.destroy) {
    try {
      existing.destroy();
    } catch (error) {
      void error;
    }
    window.__lazyPagePreloaderPanel = null;
  }

  const PANEL_PORT_NAME = "lazy-page-preloader-panel";
  const HEARTBEAT_MS = 20000;
  const LOG_FETCH_LIMIT = 50;
  const MAX_LOG_PAYLOAD_CHARS = 2000;

  const root = document.createElement("aside");
  root.id = ROOT_ID;
  root.innerHTML = `
    <div class="lpp-shell">
      <div class="lpp-header">
        <div>
          <h1 class="lpp-title">懒加载预加载器</h1>
          <p class="lpp-subtitle">页面固定面板</p>
        </div>
        <button type="button" class="lpp-icon-button" data-role="close" aria-label="关闭面板">x</button>
      </div>

      <form class="lpp-form" data-role="form">
        <label class="lpp-field">
          <span class="lpp-label">分页 URL</span>
          <textarea
            data-role="url"
            rows="3"
            placeholder="https://example.com/list?page=10"
            required
          ></textarea>
        </label>

        <div class="lpp-row">
          <label class="lpp-field">
            <span class="lpp-label">跳转页数</span>
            <input data-role="count" type="number" min="1" max="20" inputmode="numeric" required />
          </label>

          <label class="lpp-field">
            <span class="lpp-label">等待秒数</span>
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

        <label class="lpp-field">
          <span class="lpp-label">同时打开数</span>
          <input data-role="concurrentTabs" type="number" min="1" max="5" inputmode="numeric" required />
        </label>

        <div class="lpp-form-actions">
          <button data-role="start" type="submit" class="lpp-primary-button">开始预加载</button>
          <button data-role="stop" type="button" class="lpp-stop-button" disabled>停止</button>
        </div>
      </form>

      <section class="lpp-panel">
        <div class="lpp-panel-header">
          <h2 class="lpp-panel-title">状态</h2>
          <button type="button" class="lpp-secondary-button" data-role="refresh-status">刷新</button>
        </div>
        <p class="lpp-status-message" data-role="status-message">加载中...</p>
        <dl class="lpp-status-grid">
          <div>
            <dt>阶段</dt>
            <dd data-role="phase">idle</dd>
          </div>
          <div>
            <dt>进度</dt>
            <dd data-role="progress">0 / 0</dd>
          </div>
          <div>
            <dt>成功</dt>
            <dd data-role="success-count">0</dd>
          </div>
          <div>
            <dt>失败</dt>
            <dd data-role="failure-count">0</dd>
          </div>
        </dl>
      </section>

      <section class="lpp-panel">
        <div class="lpp-panel-header">
          <h2 class="lpp-panel-title">诊断日志</h2>
          <div class="lpp-actions">
            <button type="button" class="lpp-secondary-button" data-role="refresh-logs">刷新</button>
            <button type="button" class="lpp-secondary-button" data-role="export-logs">导出</button>
            <button type="button" class="lpp-secondary-button" data-role="clear-logs">清空</button>
          </div>
        </div>
        <textarea
          data-role="debug-logs"
          class="lpp-debug-logs"
          rows="12"
          readonly
          placeholder="日志会显示在这里。"
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
    concurrentTabs: root.querySelector('[data-role="concurrentTabs"]'),
    start: root.querySelector('[data-role="start"]'),
    stop: root.querySelector('[data-role="stop"]'),
    statusMessage: root.querySelector('[data-role="status-message"]'),
    phase: root.querySelector('[data-role="phase"]'),
    progress: root.querySelector('[data-role="progress"]'),
    successCount: root.querySelector('[data-role="success-count"]'),
    failureCount: root.querySelector('[data-role="failure-count"]'),
    refreshStatus: root.querySelector('[data-role="refresh-status"]'),
    refreshLogs: root.querySelector('[data-role="refresh-logs"]'),
    exportLogs: root.querySelector('[data-role="export-logs"]'),
    clearLogs: root.querySelector('[data-role="clear-logs"]'),
    debugLogs: root.querySelector('[data-role="debug-logs"]'),
    close: root.querySelector('[data-role="close"]')
  };

  let isDestroyed = false;
  let heartbeatId = null;
  let logRefreshTimer = null;
  let port = null;

  const isExtensionContextInvalidated = (error) =>
    /Extension context invalidated/i.test(error?.message || "");

  const getRuntimeErrorMessage = (error, fallbackMessage) =>
    isExtensionContextInvalidated(error)
      ? "扩展刚刚被重载或更新，当前面板已经失效。请重新点击扩展图标打开面板。"
      : error?.message || fallbackMessage;

  const markContextInvalidated = () => {
    if (heartbeatId) {
      clearInterval(heartbeatId);
      heartbeatId = null;
    }

    try {
      port?.onMessage?.removeListener(onPortMessage);
      port?.disconnect();
    } catch (error) {
      void error;
    }
    port = null;

    setBusy(false);
    renderStatus(
      createIdleStatus(
        "扩展刚刚被重载或更新，当前面板已经失效。请重新点击扩展图标打开面板。"
      )
    );

    elements.debugLogs.value =
      "当前面板属于旧的扩展上下文，已无法继续读取日志。请重新打开面板后再刷新日志。";
  };

  const sendRuntimeMessage = async (message) => {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        markContextInvalidated();
      }
      return {
        ok: false,
        message: getRuntimeErrorMessage(error, "无法连接扩展后台。")
      };
    }
  };

  const onRuntimeMessage = (message) => {
    if (message?.type === "STATUS_UPDATE" && message.status) {
      renderStatus(message.status);
      scheduleLogRefresh();
    }
  };

  const onPortMessage = (message) => {
    if (message?.type === "STATUS_UPDATE" && message.status) {
      renderStatus(message.status);
      scheduleLogRefresh();
    }
  };

  const onSubmit = async (event) => {
    event.preventDefault();

    const payload = {
      url: elements.url.value,
      count: elements.count.value,
      waitSeconds: elements.waitSeconds.value,
      concurrentTabs: elements.concurrentTabs.value
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
      message: "正在发送任务到后台..."
    });

    try {
      const response = await sendRuntimeMessage({
        type: "START_PRELOAD",
        payload: validation.value
      });

      if (!response?.ok) {
        renderStatus(createIdleStatus(response?.message || "启动任务失败。"));
        return;
      }

      renderStatus(response.status || createIdleStatus());
      await loadDebugLogs();
    } catch (error) {
      renderStatus(createIdleStatus(error?.message || "无法连接扩展。"));
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

    renderStatus(createIdleStatus(response?.message || "刷新状态失败。"));
  };

  const onStop = async () => {
    elements.stop.disabled = true;
    elements.stop.textContent = "停止中...";

    try {
      const response = await sendRuntimeMessage({ type: "STOP_PRELOAD" });
      if (response?.ok && response.status) {
        renderStatus(response.status);
        await loadDebugLogs();
        return;
      }

      renderStatus(createIdleStatus(response?.message || "停止失败，请重试。"));
    } catch (error) {
      renderStatus(createIdleStatus(error?.message || "停止失败，请检查扩展后台。"));
    } finally {
      elements.stop.textContent = "停止";
    }
  };

  const onRefreshLogs = async () => {
    try {
      await loadDebugLogs();
    } catch (error) {
      elements.debugLogs.value = getRuntimeErrorMessage(error, String(error));
    }
  };

  const onClearLogs = async () => {
    try {
      await sendRuntimeMessage({ type: "CLEAR_DEBUG_LOGS" });
      elements.debugLogs.value = "";
    } catch (error) {
      elements.debugLogs.value = getRuntimeErrorMessage(error, String(error));
    }
  };

  const onExportLogs = async () => {
    try {
      await loadDebugLogs();
      const content = elements.debugLogs.value || "暂无诊断日志。";
      const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      link.href = url;
      link.download = `lazy-page-preloader-log-${stamp}.txt`;
      document.documentElement.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      elements.debugLogs.value = getRuntimeErrorMessage(error, String(error));
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
    elements.stop.removeEventListener("click", onStop);
    elements.refreshStatus.removeEventListener("click", onRefreshStatus);
    elements.refreshLogs.removeEventListener("click", onRefreshLogs);
    elements.exportLogs.removeEventListener("click", onExportLogs);
    elements.clearLogs.removeEventListener("click", onClearLogs);
    elements.close.removeEventListener("click", destroy);

    if (heartbeatId) {
      clearInterval(heartbeatId);
    }

    if (logRefreshTimer) {
      clearTimeout(logRefreshTimer);
    }

    try {
      port?.onMessage?.removeListener(onPortMessage);
      port?.disconnect();
    } catch (error) {
      void error;
    }

    root.remove();
  };

  window.__lazyPagePreloaderPanel = { destroy };

  elements.form.addEventListener("submit", onSubmit);
  elements.stop.addEventListener("click", onStop);
  elements.refreshStatus.addEventListener("click", onRefreshStatus);
  elements.refreshLogs.addEventListener("click", onRefreshLogs);
  elements.exportLogs.addEventListener("click", onExportLogs);
  elements.clearLogs.addEventListener("click", onClearLogs);
  elements.close.addEventListener("click", destroy);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  try {
    port = chrome.runtime.connect({ name: PANEL_PORT_NAME });
    port.onMessage.addListener(onPortMessage);
    heartbeatId = window.setInterval(() => {
      try {
        port.postMessage({ type: "PING", at: Date.now() });
      } catch (error) {
        if (isExtensionContextInvalidated(error)) {
          markContextInvalidated();
        }
      }
    }, HEARTBEAT_MS);
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      markContextInvalidated();
    }
  }

  void init();

  async function init() {
    elements.count.value = "5";
    elements.waitSeconds.value = "8";
    elements.concurrentTabs.value = "1";

    const bootstrap = await sendRuntimeMessage({ type: "GET_PANEL_BOOTSTRAP" });
    const lastInput = bootstrap?.ok ? bootstrap.lastInput || null : null;
    if (lastInput) {
      elements.count.value = String(clampNumber(lastInput.count || 5, 1, 20));
      elements.waitSeconds.value = String(clampNumber(lastInput.waitSeconds || 8, 3, 30));
      elements.concurrentTabs.value = String(clampNumber(lastInput.concurrentTabs || 1, 1, 5));
    }

    elements.url.value = getCurrentPageUrl() || lastInput?.url || "";
    renderStatus(
      bootstrap?.ok
        ? bootstrap.status || createIdleStatus()
        : createIdleStatus(bootstrap?.message || "初始化面板失败。")
    );
    elements.debugLogs.value =
      bootstrap?.ok && bootstrap.logCount
        ? `Logs are not loaded. Click refresh to load the latest ${LOG_FETCH_LIMIT} of ${bootstrap.logCount}.`
        : "Logs are not loaded. Click refresh when needed.";
    await onRefreshStatus();
  }

  function getCurrentPageUrl() {
    return /^https?:/i.test(location.href) ? location.href : "";
  }

  function renderStatus(status) {
    const safeStatus = status || createIdleStatus();
    elements.statusMessage.textContent = safeStatus.message || "准备就绪。";
    elements.phase.textContent = phaseText(safeStatus.phase || "idle");
    elements.progress.textContent = `${safeStatus.currentIndex || 0} / ${safeStatus.total || 0}`;
    elements.successCount.textContent = String(safeStatus.successCount || 0);
    elements.failureCount.textContent = String(safeStatus.failureCount || 0);
    elements.stop.disabled = safeStatus.phase !== "running";
  }

  function phaseText(phase) {
    const phaseMap = {
      idle: "空闲",
      running: "运行中",
      completed: "已完成",
      "failed-partial": "部分失败",
      failed: "失败"
    };

    return phaseMap[phase] || phase;
  }

  function setBusy(isBusy) {
    elements.start.disabled = isBusy;
    elements.start.textContent = isBusy ? "启动中..." : "开始预加载";
  }

  async function loadDebugLogs() {
    const response = await sendRuntimeMessage({
      type: "GET_DEBUG_LOGS",
      limit: LOG_FETCH_LIMIT
    });
    const logs = response?.ok && Array.isArray(response.logs) ? response.logs : [];
    elements.debugLogs.value = formatDebugLogs(logs);
  }

  function scheduleLogRefresh() {
    if (logRefreshTimer) {
      return;
    }

    logRefreshTimer = window.setTimeout(() => {
      logRefreshTimer = null;
      loadDebugLogs().catch((error) => {
        elements.debugLogs.value = getRuntimeErrorMessage(error, String(error));
      });
    }, 1200);
  }

  function formatDebugLogs(logs) {
    if (!logs.length) {
      return "暂无诊断日志。";
    }

    return logs
      .map((entry, index) => {
        const payload = truncateText(JSON.stringify(entry.payload, null, 2));
        return `#${index + 1} ${entry.at} [${entry.type}]\n${payload}`;
      })
      .join("\n\n");
  }

  function truncateText(value) {
    const text = String(value || "");
    if (text.length <= MAX_LOG_PAYLOAD_CHARS) {
      return text;
    }

    return `${text.slice(0, MAX_LOG_PAYLOAD_CHARS)}\n... truncated ${text.length - MAX_LOG_PAYLOAD_CHARS} chars ...`;
  }

  function clampNumber(value, min, max) {
    return Math.min(Math.max(Number(value) || min, min), max);
  }

  function normalizePositiveInteger(value) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function validateUserInput({ url, count, waitSeconds, concurrentTabs }) {
    const normalizedUrl = String(url || "").trim();
    if (!normalizedUrl) {
      return { ok: false, message: "请输入包含 page 参数的 URL。" };
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(normalizedUrl);
    } catch {
      return { ok: false, message: "URL 格式不正确。" };
    }

    if (!/^https?:$/.test(parsedUrl.protocol)) {
      return { ok: false, message: "仅支持 http 和 https URL。" };
    }

    const pageValue = normalizePositiveInteger(parsedUrl.searchParams.get("page"));
    if (!pageValue) {
      return { ok: false, message: "URL 必须包含 page=<正整数> 参数。" };
    }

    const normalizedCount = normalizePositiveInteger(count);
    if (!normalizedCount || normalizedCount < 1 || normalizedCount > 20) {
      return { ok: false, message: "跳转页数必须在 1 到 20 之间。" };
    }

    const normalizedWaitSeconds = normalizePositiveInteger(waitSeconds);
    if (!normalizedWaitSeconds || normalizedWaitSeconds < 3 || normalizedWaitSeconds > 30) {
      return { ok: false, message: "等待秒数必须在 3 到 30 之间。" };
    }

    const normalizedConcurrentTabs = normalizePositiveInteger(concurrentTabs) || 1;
    if (normalizedConcurrentTabs < 1 || normalizedConcurrentTabs > 5) {
      return { ok: false, message: "同时打开数必须在 1 到 5 之间。" };
    }

    return {
      ok: true,
      value: {
        url: parsedUrl.toString(),
        count: normalizedCount,
        waitSeconds: normalizedWaitSeconds,
        concurrentTabs: normalizedConcurrentTabs
      }
    };
  }

  function createIdleStatus(message = "准备就绪。") {
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
