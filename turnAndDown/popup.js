import {
  DEBUG_LOGS_STORAGE_KEY,
  DEFAULT_COUNT,
  DEFAULT_WAIT_SECONDS,
  LAST_INPUT_STORAGE_KEY,
  STATUS_STORAGE_KEY,
  clampNumber,
  createIdleStatus,
  validateUserInput
} from "./shared.js";

const form = document.querySelector("#preload-form");
const urlField = document.querySelector("#url");
const countField = document.querySelector("#count");
const waitField = document.querySelector("#waitSeconds");
const startButton = document.querySelector("#start-button");
const stopButton = document.querySelector("#stop-button");
const statusMessage = document.querySelector("#status-message");
const phaseValue = document.querySelector("#phase");
const progressValue = document.querySelector("#progress");
const successCountValue = document.querySelector("#success-count");
const failureCountValue = document.querySelector("#failure-count");
const refreshLogsButton = document.querySelector("#refresh-logs-button");
const clearLogsButton = document.querySelector("#clear-logs-button");
const debugLogsField = document.querySelector("#debug-logs");

function isExtensionContextInvalidated(error) {
  return /Extension context invalidated/i.test(error?.message || "");
}

function getRuntimeErrorMessage(error, fallbackMessage) {
  return isExtensionContextInvalidated(error)
    ? "扩展刚刚被重载或更新，当前弹窗已经失效。请关闭后重新打开扩展弹窗。"
    : error?.message || fallbackMessage;
}

init().catch((error) => {
  console.error("Popup initialization failed:", error);
  renderStatus({
    ...createIdleStatus(),
    message: "初始化失败，请重新打开弹窗。"
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    url: urlField.value,
    count: countField.value,
    waitSeconds: waitField.value
  };

  const validation = validateUserInput(payload);
  if (!validation.ok) {
    renderStatus({
      ...createIdleStatus(),
      message: validation.message
    });
    return;
  }

  setBusy(true);
  renderStatus({
    ...createIdleStatus(),
    phase: "running",
    message: "正在发送启动请求..."
  });

  try {
    const response = await chrome.runtime.sendMessage({
      type: "START_PRELOAD",
      payload: validation.value
    });

    if (!response?.ok) {
      renderStatus({
        ...createIdleStatus(),
        message: response?.message || "启动失败，请重试。"
      });
      return;
    }

    renderStatus(response.status || createIdleStatus());
    await loadDebugLogs();
  } catch (error) {
    console.error("Failed to start task:", error);
    renderStatus({
      ...createIdleStatus(),
      message: getRuntimeErrorMessage(error, "启动失败，请检查扩展权限。")
    });
  } finally {
    setBusy(false);
  }
});

refreshLogsButton?.addEventListener("click", () => {
  loadDebugLogs().catch((error) => {
    console.error("Failed to refresh debug logs:", error);
    if (debugLogsField) {
      debugLogsField.value = `刷新日志失败: ${getRuntimeErrorMessage(error, String(error))}`;
    }
  });
});

clearLogsButton?.addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "CLEAR_DEBUG_LOGS" });
    if (debugLogsField) {
      debugLogsField.value = "";
    }
  } catch (error) {
    console.error("Failed to clear debug logs:", error);
  }
});

stopButton?.addEventListener("click", async () => {
  stopButton.disabled = true;
  stopButton.textContent = "停止中...";

  try {
    const response = await chrome.runtime.sendMessage({ type: "STOP_PRELOAD" });
    if (response?.ok && response.status) {
      renderStatus(response.status);
      await loadDebugLogs();
      return;
    }

    renderStatus({
      ...createIdleStatus(),
      message: response?.message || "停止失败，请重试。"
    });
  } catch (error) {
    console.error("Failed to stop task:", error);
    renderStatus({
      ...createIdleStatus(),
      message: getRuntimeErrorMessage(error, "停止失败，请检查扩展后台。")
    });
  } finally {
    stopButton.textContent = "停止";
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "STATUS_UPDATE" && message.status) {
    renderStatus(message.status);
  }
});

async function init() {
  countField.value = String(DEFAULT_COUNT);
  waitField.value = String(DEFAULT_WAIT_SECONDS);

  const [sessionState, localState, activeTabUrl] = await Promise.all([
    chrome.storage.session.get(STATUS_STORAGE_KEY),
    chrome.storage.local.get(LAST_INPUT_STORAGE_KEY),
    detectActiveTabUrl()
  ]);

  const lastInput = localState[LAST_INPUT_STORAGE_KEY];
  if (lastInput) {
    countField.value = String(clampNumber(lastInput.count || DEFAULT_COUNT, 1, 20));
    waitField.value = String(
      clampNumber(lastInput.waitSeconds || DEFAULT_WAIT_SECONDS, 3, 30)
    );
  }

  urlField.value = activeTabUrl || lastInput?.url || "";

  const cachedStatus = sessionState[STATUS_STORAGE_KEY] || createIdleStatus();
  renderStatus(cachedStatus);
  await loadDebugLogs();

  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    if (response?.ok && response.status) {
      renderStatus(response.status);
    }
  } catch (error) {
    console.warn("Failed to fetch live status:", error);
    if (isExtensionContextInvalidated(error)) {
      renderStatus({
        ...createIdleStatus(),
        message: getRuntimeErrorMessage(error, "无法读取实时状态。")
      });
    }
  }
}

async function detectActiveTabUrl() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true
    });
    if (tab?.url && /^https?:/.test(tab.url)) {
      return tab.url;
    }
  } catch (error) {
    console.warn("Failed to query active tab:", error);
  }

  return "";
}

function renderStatus(status) {
  const safeStatus = status || createIdleStatus();
  statusMessage.textContent = safeStatus.message || "等待开始";
  phaseValue.textContent = safeStatus.phase || "idle";
  progressValue.textContent = `${safeStatus.currentIndex || 0} / ${safeStatus.total || 0}`;
  successCountValue.textContent = String(safeStatus.successCount || 0);
  failureCountValue.textContent = String(safeStatus.failureCount || 0);
  if (stopButton) {
    stopButton.disabled = safeStatus.phase !== "running";
  }
}

function setBusy(isBusy) {
  startButton.disabled = isBusy;
  startButton.textContent = isBusy ? "启动中..." : "开始预加载";
}

async function loadDebugLogs() {
  if (!debugLogsField) {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_DEBUG_LOGS" });
    if (response?.ok && Array.isArray(response.logs)) {
      debugLogsField.value = formatDebugLogs(response.logs);
      return;
    }
  } catch (error) {
    console.warn("Failed to fetch live debug logs:", error);
    if (isExtensionContextInvalidated(error)) {
      debugLogsField.value = getRuntimeErrorMessage(error, "无法读取实时日志。");
      return;
    }
  }

  const stored = await chrome.storage.session.get(DEBUG_LOGS_STORAGE_KEY);
  const logs = stored[DEBUG_LOGS_STORAGE_KEY] || [];
  debugLogsField.value = formatDebugLogs(logs);
}

function formatDebugLogs(logs) {
  if (!logs.length) {
    return "暂无诊断日志。运行一次任务后再刷新这里。";
  }

  return logs
    .map((entry, index) => {
      const payload = JSON.stringify(entry.payload, null, 2);
      return `#${index + 1} ${entry.at} [${entry.type}]\n${payload}`;
    })
    .join("\n\n");
}
