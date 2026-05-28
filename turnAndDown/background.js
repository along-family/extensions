import {
  DEBUG_LOGS_STORAGE_KEY,
  LAST_INPUT_STORAGE_KEY,
  PAGE_READY_TIMEOUT_MS,
  STATUS_STORAGE_KEY,
  buildPageUrls,
  createIdleStatus,
  validateUserInput
} from "./shared.js";

let currentTask = null;
let currentStatus = createIdleStatus();
let taskSequence = 0;
let debugLogs = [];

const MAX_DEBUG_LOGS = 400;
const SCRIPT_EXECUTION_TIMEOUT_MS = 6000;
const SCRIPT_EXECUTION_TIMEOUT_BUFFER_MS = 5000;
const SCROLL_SCRIPT_RETURN_BUFFER_MS = 1200;
const SCROLL_TO_TOP_DELAY_MS = 20000;
const MIN_TARGET_TIMEOUT_MS = 45000;
const TARGET_TIMEOUT_BUFFER_MS = 35000;
const MAX_DEBUG_LOG_PAYLOAD_CHARS = 5000;
const PANEL_PORT_NAME = "lazy-page-preloader-panel";
const ACTIVE_TASK_STORAGE_KEY = "activePreloadTask";
const TASK_ALARM_NAME = "lazy-page-preloader-active-task";
const PANEL_FILES = {
  css: ["panel.css"],
  js: ["panel.js"]
};

const connectedPanelPorts = new Set();
let taskRunnerPromise = null;
let taskRunnerTaskId = null;

chrome.runtime.onInstalled.addListener(() => {
  void persistStatus(currentStatus);
  void persistDebugLogs();
});

chrome.runtime.onStartup.addListener(() => {
  void restorePersistedState();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TASK_ALARM_NAME) {
    void restorePersistedState();
  }
});

chrome.action.onClicked.addListener((tab) => {
  void togglePanelForTab(tab);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT_NAME) {
    return;
  }

  connectedPanelPorts.add(port);

  port.onMessage.addListener((message) => {
    if (message?.type === "PING") {
      try {
        port.postMessage({ type: "PONG", at: Date.now() });
        port.postMessage({ type: "STATUS_UPDATE", status: currentStatus });
      } catch (error) {
        appendDebugLog("panel-port-pong-failed", {
          error: toLoggableError(error)
        });
      }
    }
  });

  port.onDisconnect.addListener(() => {
    connectedPanelPorts.delete(port);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "GET_STATUS") {
    sendResponse({ ok: true, status: currentStatus });
    return false;
  }

  if (message.type === "GET_DEBUG_LOGS") {
    sendResponse({ ok: true, logs: getRecentDebugLogs(message.limit) });
    return false;
  }

  if (message.type === "GET_PANEL_BOOTSTRAP") {
    void chrome.storage.local
      .get(LAST_INPUT_STORAGE_KEY)
      .then((stored) => {
        sendResponse({
          ok: true,
          status: currentStatus,
          logCount: debugLogs.length,
          lastInput: stored[LAST_INPUT_STORAGE_KEY] || null
        });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          message: error?.message || "加载面板数据失败。"
        });
      });
    return true;
  }

  if (message.type === "CLEAR_DEBUG_LOGS") {
    debugLogs = [];
    void persistDebugLogs();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "STOP_PRELOAD") {
    void stopCurrentTask("user-request")
      .then((response) => {
        sendResponse(response);
      })
      .catch((error) => {
        console.error("Failed to stop preload task:", error);
        sendResponse({
          ok: false,
          message: error?.message || "Failed to stop preload task."
        });
      });
    return true;
  }

  if (message.type === "PAGE_DEBUG_EVENT") {
    appendDebugLog("page-event", message.payload);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "PAGE_DEBUG_SNAPSHOT") {
    appendDebugLog("page-snapshot", message.payload);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "START_PRELOAD") {
    try {
      const response = beginPreloadTask(message.payload);
      sendResponse(response);
    } catch (error) {
      console.error("启动预加载任务失败:", error);
      sendResponse({ ok: false, message: "启动预加载任务失败。" });
    }
    return false;
  }

  return false;
});

void restorePersistedState();

function beginPreloadTask(payload) {
  if (currentTask?.phase === "running") {
    return { ok: false, message: "已有预加载任务正在运行。" };
  }

  debugLogs = [];
  void persistDebugLogs();

  const validation = validateUserInput(payload || {});
  if (!validation.ok) {
    return { ok: false, message: validation.message };
  }

  const { url, count, waitSeconds, concurrentTabs } = validation.value;
  const targets = buildPageUrls(url, count);
  if (!targets.length) {
    return { ok: false, message: "没有从 URL 生成可处理的目标页面。" };
  }

  void chrome.storage.local.set({
    [LAST_INPUT_STORAGE_KEY]: {
      url,
      count,
      waitSeconds,
      concurrentTabs
    }
  });

  const taskId = ++taskSequence;
  const startedAt = new Date().toISOString();
  currentTask = {
    id: taskId,
    phase: "running",
    targets,
    waitSeconds,
    concurrentTabs,
    nextIndex: 0,
    activeTabId: null,
    startedAt
  };

  appendDebugLog("task-start", {
    taskId,
    url,
    count,
    waitSeconds,
    concurrentTabs,
    targets,
    panelConnections: connectedPanelPorts.size
  });

  setStatus({
    phase: "running",
    total: targets.length,
    currentIndex: 0,
    successCount: 0,
    failureCount: 0,
    message: "任务已启动，请保持面板打开以查看实时进度。",
    startedAt
  });

  void persistActiveTask();
  ensureTaskAlarm();
  startTaskRunner(taskId);

  return {
    ok: true,
    status: currentStatus
  };
}

function startTaskRunner(taskId) {
  if ((taskRunnerPromise && taskRunnerTaskId === taskId) || !isCurrentTask(taskId)) {
    return;
  }

  taskRunnerTaskId = taskId;
  taskRunnerPromise = Promise.resolve()
    .then(async () => {
      const task = currentTask;
      if (!task || task.id !== taskId) {
        return;
      }

      await runPreloadTask(
        task.id,
        task.targets,
        task.waitSeconds,
        task.concurrentTabs || 1,
        task.nextIndex || 0
      );
    })
    .catch((error) => {
      console.error("Unexpected preload task error:", error);
      appendDebugLog("task-crash", {
        taskId,
        error: toLoggableError(error)
      });

      if (!isCurrentTask(taskId)) {
        return;
      }

      finishTask({
        phase: "failed-partial",
        message: "任务异常中断，请查看诊断日志。"
      });
    })
    .finally(() => {
      if (taskRunnerTaskId === taskId) {
        taskRunnerPromise = null;
        taskRunnerTaskId = null;
      }
    });
}

async function runPreloadTask(
  taskId,
  targets,
  waitSeconds,
  concurrentTabs = 1,
  startIndex = 0
) {
  const batchSize = Math.min(Math.max(concurrentTabs || 1, 1), targets.length);

  for (let batchStart = startIndex; batchStart < targets.length; batchStart += batchSize) {
    if (!isCurrentTask(taskId)) {
      return;
    }

    const batchTargets = targets
      .slice(batchStart, batchStart + batchSize)
      .map((target, offset) => ({
        target,
        index: batchStart + offset
      }));

    currentTask.nextIndex = batchStart;
    await persistActiveTask();

    setStatus({
      currentIndex: batchStart + 1,
      message:
        batchTargets.length > 1
          ? `正在同时处理第 ${batchStart + 1}-${batchStart + batchTargets.length}/${targets.length} 个后台标签页。`
          : `正在处理第 ${batchStart + 1}/${targets.length} 个后台标签页。`
    });

    appendDebugLog("batch-start", {
      taskId,
      batchStart,
      batchSize: batchTargets.length,
      concurrentTabs: batchSize,
      targets: batchTargets.map(({ target, index }) => ({
        index,
        page: target.page,
        url: target.url
      }))
    });

    await Promise.all(
      batchTargets.map(({ target, index }) =>
        runTarget(taskId, target, waitSeconds, index, targets.length, batchTargets.length)
      )
    );

    if (isCurrentTask(taskId)) {
      currentTask.nextIndex = batchStart + batchTargets.length;
      await persistActiveTask();
    }
  }

  if (!isCurrentTask(taskId)) {
    return;
  }

  const hasFailure = currentStatus.failureCount > 0;
  appendDebugLog("task-finish", {
    taskId,
    phase: hasFailure ? "failed-partial" : "completed",
    successCount: currentStatus.successCount,
    failureCount: currentStatus.failureCount
  });

  finishTask({
    phase: hasFailure ? "failed-partial" : "completed",
    message: hasFailure
      ? `任务完成，但存在失败页面。成功：${currentStatus.successCount}，失败：${currentStatus.failureCount}。`
      : `任务完成，已处理 ${currentStatus.successCount} 个页面。`
  });
}

async function runTarget(taskId, target, waitSeconds, index, total, batchSize) {
  if (!isCurrentTask(taskId)) {
    return;
  }

  try {
    appendDebugLog("target-start", {
      taskId,
      index,
      page: target.page,
      url: target.url,
      tabId: target.tabId || null,
      batchSize
    });

    await withTargetTimeout(
      processTarget(target, waitSeconds, index, total, batchSize),
      target,
      waitSeconds
    );
    if (!isCurrentTask(taskId)) {
      return;
    }

    appendDebugLog("target-success", {
      taskId,
      index,
      page: target.page,
      url: target.url,
      tabId: target.tabId || null,
      batchSize
    });

    incrementStatus("successCount");
    setStatus({
      currentIndex: getCompletedProgress(index),
      message: `已完成第 ${index + 1}/${total} 个页面：page=${target.page}`
    });
  } catch (error) {
    if (!isCurrentTask(taskId)) {
      return;
    }

    if (isExpectedTargetInterruption(error)) {
      appendDebugLog("target-interrupted", {
        taskId,
        index,
        page: target.page,
        url: target.url,
        tabId: target.tabId || null,
        batchSize,
        error: toLoggableError(error)
      });
      incrementStatus("failureCount");
      setStatus({
        currentIndex: getCompletedProgress(index),
        message: `page=${target.page} 处理中断，已跳过并继续下一个页面。`
      });
      return;
    }

    console.error(
      `[LazyPagePreloader] 处理失败: page=${target.page} url=${target.url}`,
      error
    );

    appendDebugLog("target-failure", {
      taskId,
      index,
      page: target.page,
      url: target.url,
      tabId: target.tabId || null,
      batchSize,
      error: toLoggableError(error)
    });

    incrementStatus("failureCount");
    setStatus({
      currentIndex: getCompletedProgress(index),
      message: `page=${target.page} 处理失败，继续下一个页面。`
    });
  }
}

async function processTarget(target, waitSeconds, index, total, batchSize) {
  let tabId = target.tabId || null;
  const startedAt = Date.now();

  try {
    if (tabId) {
      const existingTab = await getExistingTab(tabId);
      if (!existingTab) {
        appendDebugLog("stale-target-tab-cleared", {
          tabId,
          page: target.page,
          url: target.url
        });

        target.tabId = null;
        tabId = null;
        await persistActiveTask();
      }
    }

    if (!tabId) {
      const createdTab = await chrome.tabs.create({
        url: target.url,
        active: false
      });

      tabId = createdTab.id || null;
      if (!tabId) {
        throw new Error(`创建后台标签页失败：page=${target.page}`);
      }

      target.tabId = tabId;
      await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});

      appendDebugLog("tab-created", {
        tabId,
        url: target.url,
        page: target.page,
        active: createdTab.active,
        status: createdTab.status
      });

      await persistActiveTask();
    }

    if (currentTask) {
      currentTask.activeTabId = tabId;
      await persistActiveTask();
    }

    setStatus({
      message:
        batchSize > 1
          ? `同时打开 ${batchSize} 个后台标签页；正在处理第 ${index + 1}/${total} 个：page=${target.page}`
          : `正在处理第 ${index + 1}/${total} 个后台标签页：page=${target.page}`
    });
    const readyResult = await waitForTabReady(tabId, PAGE_READY_TIMEOUT_MS);
    appendDebugLog("tab-ready", {
      tabId,
      url: target.url,
      ...readyResult
    });

    const probeResult = await installDebugProbe(tabId);
    appendDebugLog("probe-installed", {
      tabId,
      url: target.url,
      probeResult
    });

    const beforeScrollSnapshot = await collectDebugSnapshot(tabId, "before-scroll");
    appendDebugLog("snapshot-before-scroll", {
      tabId,
      url: target.url,
      snapshot: beforeScrollSnapshot
    });

    setStatus({
      message:
        batchSize > 1
          ? `同时打开 ${batchSize} 个后台标签页；第 ${index + 1}/${total} 个正在滚动加载，预计等待 ${waitSeconds} 秒。`
          : `第 ${index + 1}/${total} 个后台标签页正在滚动加载，预计等待 ${waitSeconds} 秒。`
    });
    const scrollResult = await scrollTabToBottom(tabId, waitSeconds);
    appendDebugLog("scroll-result", {
      tabId,
      url: target.url,
      scrollResult
    });

    const afterScrollSnapshot = await collectDebugSnapshot(tabId, "after-scroll");
    appendDebugLog("snapshot-after-scroll", {
      tabId,
      url: target.url,
      snapshot: afterScrollSnapshot
    });

    analyzeTargetOutcome(target, beforeScrollSnapshot, scrollResult, afterScrollSnapshot);

    try {
      const topScrollScheduleResult = await scheduleScrollTabToTop(
        tabId,
        SCROLL_TO_TOP_DELAY_MS
      );
      appendDebugLog("scroll-top-scheduled", {
        tabId,
        url: target.url,
        topScrollScheduleResult
      });
    } catch (error) {
      appendDebugLog("scroll-top-schedule-failed", {
        tabId,
        url: target.url,
        error: toLoggableError(error)
      });
    }

    appendDebugLog("target-timing", {
      page: target.page,
      url: target.url,
      elapsedMs: Date.now() - startedAt
    });
  } finally {
    if (currentTask?.activeTabId === tabId) {
      currentTask.activeTabId = null;
      await persistActiveTask();
    }
  }
}

async function getExistingTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (error) {
    if (error?.message?.includes("No tab with id")) {
      return null;
    }

    throw error;
  }
}

function analyzeTargetOutcome(target, beforeScrollSnapshot, scrollResult, afterScrollSnapshot) {
  const beforeImages = beforeScrollSnapshot?.imageStats || null;
  const afterImages = afterScrollSnapshot?.imageStats || null;
  const visibilityState =
    afterScrollSnapshot?.visibilityState || scrollResult?.visibilityState || "unknown";

  if (
    visibilityState === "hidden" &&
    afterImages &&
    (afterImages.pending > 0 || afterImages.lazy > 0)
  ) {
    appendDebugLog("background-visibility-warning", {
      page: target.page,
      url: target.url,
      message:
        "页面加载时仍处于隐藏状态，部分懒加载实现可能不会触发。"
    });
  }

  if (
    beforeImages &&
    afterImages &&
    (beforeImages.total > 0 || afterImages.total > 0) &&
    afterImages.complete <= beforeImages.complete &&
    afterImages.pending >= beforeImages.pending
  ) {
    appendDebugLog("no-image-progress-warning", {
      page: target.page,
      url: target.url,
      beforeImages,
      afterImages,
      message:
        "滚动后图片完成数量没有增加，站点可能需要前台可见性或其他滚动触发方式。"
    });
  }

  if (scrollResult?.rounds?.length) {
    const lastRound = scrollResult.rounds[scrollResult.rounds.length - 1];
    if (lastRound?.pending > 0) {
      appendDebugLog("pending-images-after-scroll", {
        page: target.page,
        url: target.url,
        pendingImages: lastRound.pending
      });
    }
  }
}

function waitForTabReady(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const startedAt = Date.now();

    const timeoutId = setTimeout(() => {
      cleanup();
      resolve({
        reason: "timeout",
        elapsedMs: Date.now() - startedAt
      });
    }, timeoutMs);

    const onUpdated = (updatedTabId, changeInfo) => {
      if (
        updatedTabId !== tabId ||
        (changeInfo.status !== "loading" && changeInfo.status !== "complete")
      ) {
        return;
      }

      checkReady(`tabs-${changeInfo.status}`);
    };

    const onRemoved = (removedTabId) => {
      if (removedTabId !== tabId) {
        return;
      }

      cleanup();
      reject(new Error("标签页在加载完成前已关闭。"));
    };

    const cleanup = () => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    checkReady("initial");

    function checkReady(reason) {
      chrome.scripting
        .executeScript({
          target: { tabId },
          func: () => ({
            readyState: document.readyState,
            href: location.href
          })
        })
        .then(([{ result } = {}]) => {
          if (settled || !result) {
            return;
          }

          cleanup();
          resolve({
            reason,
            readyState: result.readyState,
            href: result.href,
            elapsedMs: Date.now() - startedAt
          });
        })
        .catch(() => {
          void chrome.tabs
            .get(tabId)
            .then((tab) => {
              if (settled || tab.status !== "complete") {
                return;
              }

              cleanup();
              resolve({
                reason: "tab-complete",
                elapsedMs: Date.now() - startedAt
              });
            })
            .catch((error) => {
              cleanup();
              reject(error);
            });
        });
    }
  });
}

async function scrollTabToBottom(tabId, waitSeconds) {
  let scriptResult = null;
  try {
    scriptResult = await executeScriptWithTimeout(
      {
        target: { tabId },
        func: performScrollToBottom,
        args: [waitSeconds * 1000, SCROLL_SCRIPT_RETURN_BUFFER_MS]
      },
      waitSeconds * 1000 + SCRIPT_EXECUTION_TIMEOUT_BUFFER_MS,
      "scroll-tab-to-bottom"
    );
  } catch (error) {
    if (!isScriptExecutionTimeout(error)) {
      throw error;
    }

    appendDebugLog("scroll-timeout-handled", {
      tabId,
      error: toLoggableError(error)
    });
    return {
      timedOut: true,
      timeoutHandled: true,
      elapsedMs: error.details?.timeoutMs || null,
      reason: "scroll-tab-to-bottom-timeout"
    };
  }

  const [{ result } = {}] = scriptResult;
  return result || null;
}

async function scheduleScrollTabToTop(tabId, delayMs) {
  const [{ result } = {}] = await executeScriptWithTimeout(
    {
      target: { tabId },
      func: scheduleScrollToTopInPage,
      args: [delayMs]
    },
    SCRIPT_EXECUTION_TIMEOUT_MS,
    "schedule-scroll-to-top"
  );

  return result || null;
}

async function installDebugProbe(tabId) {
  const [{ result } = {}] = await executeScriptWithTimeout(
    {
      target: { tabId },
      func: installDebugProbeInPage
    },
    SCRIPT_EXECUTION_TIMEOUT_MS,
    "install-debug-probe"
  );

  return result || null;
}

async function collectDebugSnapshot(tabId, label) {
  try {
    const [{ result } = {}] = await executeScriptWithTimeout(
      {
        target: { tabId },
        func: collectDebugSnapshotInPage,
        args: [label]
      },
      SCRIPT_EXECUTION_TIMEOUT_MS,
      `collect-debug-snapshot:${label}`
    );

    return result || null;
  } catch (error) {
    appendDebugLog("snapshot-collect-failed", {
      tabId,
      label,
      error: toLoggableError(error)
    });
    return null;
  }
}

async function executeScriptWithTimeout(scriptOptions, timeoutMs, label) {
  const tabId = scriptOptions?.target?.tabId || null;
  const normalizedTimeoutMs = Math.max(Number(timeoutMs) || 0, 1000);
  let timeoutId = null;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`Script execution timed out: ${label}`);
      error.name = "ScriptExecutionTimeoutError";
      error.details = {
        label,
        tabId,
        timeoutMs: normalizedTimeoutMs
      };

      appendDebugLog("script-execution-timeout", error.details);
      reject(error);
    }, normalizedTimeoutMs);
  });

  try {
    return await Promise.race([
      chrome.scripting.executeScript(scriptOptions),
      timeoutPromise
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function togglePanelForTab(tab) {
  const targetTab = await resolvePanelTargetTab(tab);
  if (!targetTab?.id || !isInjectableUrl(targetTab.url)) {
    await notifyCompletion(
      "无法打开面板",
      "请先打开普通 http/https 页面，然后再次点击扩展。"
    );
    return;
  }

  try {
    if (targetTab.id !== tab?.id) {
      await chrome.tabs.update(targetTab.id, { active: true }).catch(() => {});
    }

    await chrome.scripting.insertCSS({
      target: { tabId: targetTab.id },
      files: PANEL_FILES.css
    });

    await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      files: PANEL_FILES.js
    });
  } catch (error) {
    console.error("注入面板失败:", error);
    appendDebugLog("panel-injection-failure", {
      tabId: targetTab.id,
      url: targetTab.url,
      error: toLoggableError(error)
    });
    await notifyCompletion(
      "面板注入失败",
      "Chrome 阻止了在当前页面注入脚本。"
    );
  }
}

async function resolvePanelTargetTab(tab) {
  if (tab?.id && isInjectableUrl(tab.url)) {
    return tab;
  }

  try {
    const tabs = await chrome.tabs.query({
      currentWindow: true
    });
    return (
      tabs.find((candidate) => candidate.active && isInjectableUrl(candidate.url)) ||
      tabs.find((candidate) => isInjectableUrl(candidate.url)) ||
      tab
    );
  } catch (error) {
    appendDebugLog("panel-target-tab-resolution-failed", {
      tabId: tab?.id || null,
      url: tab?.url || "",
      error: toLoggableError(error)
    });
    return tab;
  }
}

function isInjectableUrl(url) {
  return typeof url === "string" && /^https?:/i.test(url);
}

function scheduleScrollToTopInPage(delayMs) {
  const timerKey = "__lazyPagePreloaderScrollToTopTimer";
  const normalizedDelayMs = Math.max(Number(delayMs) || 0, 0);
  const getScrollableTargets = () => {
    const targets = [window];
    const nodes = Array.from(document.querySelectorAll("body *"));
    const scrollableNodes = nodes
      .filter((node) => {
        const style = window.getComputedStyle(node);
        const overflowY = style.overflowY;
        return (
          node.scrollHeight - node.clientHeight > 8 &&
          (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay")
        );
      })
      .slice(0, 20);

    return targets.concat(scrollableNodes);
  };

  if (window[timerKey]) {
    clearTimeout(window[timerKey]);
  }

  window[timerKey] = setTimeout(() => {
    for (const target of getScrollableTargets()) {
      if (target === window) {
        window.scrollTo({
          top: 0,
          behavior: "auto"
        });
        continue;
      }

      target.scrollTop = 0;
      target.dispatchEvent(new Event("scroll", { bubbles: true }));
    }

    window.dispatchEvent(new Event("scroll"));
    document.dispatchEvent(new Event("scroll"));
    window[timerKey] = null;
  }, normalizedDelayMs);

  return {
    scheduled: true,
    delayMs: normalizedDelayMs
  };
}

function performScrollToBottom(maxWaitMs, returnBufferMs = 1000) {
  const sleep = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  const getScrollHeight = () =>
    Math.max(
      document.body?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0
    );

  const getViewportHeight = () => Math.max(window.innerHeight || 0, 600);

  const getScrollableTargets = (limit = 8) => {
    const targets = [window];
    const nodes = Array.from(document.querySelectorAll("body *"));
    const scrollableNodes = nodes
      .filter((node) => {
        const style = window.getComputedStyle(node);
        const overflowY = style.overflowY;
        return (
          node.scrollHeight - node.clientHeight > 8 &&
          (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay")
        );
      })
      .sort(
        (first, second) =>
          second.scrollHeight - second.clientHeight - (first.scrollHeight - first.clientHeight)
      )
      .slice(0, limit);

    return targets.concat(scrollableNodes);
  };

  const getTargetScrollTop = (target) => {
    if (target === window) {
      return window.scrollY || document.documentElement.scrollTop || 0;
    }

    return target.scrollTop || 0;
  };

  const getTargetViewportHeight = (target) => {
    if (target === window) {
      return getViewportHeight();
    }

    return Math.max(target.clientHeight || 0, 1);
  };

  const getTargetMaxScrollTop = (target) => {
    if (target === window) {
      return Math.max(getScrollHeight() - getViewportHeight(), 0);
    }

    return Math.max((target.scrollHeight || 0) - (target.clientHeight || 0), 0);
  };

  const scrollTargetTo = (target, top) => {
    if (target === window) {
      window.scrollTo({
        top,
        behavior: "auto"
      });
      return;
    }

    target.scrollTop = top;
    target.dispatchEvent(new Event("scroll", { bubbles: true }));
  };

  const getImageStats = () => {
    const images = Array.from(document.images);
    let complete = 0;
    let pending = 0;
    let eager = 0;
    let lazy = 0;

    for (const image of images) {
      if (image.complete && image.naturalWidth > 0) {
        complete += 1;
      } else {
        pending += 1;
      }

      if (image.loading === "lazy") {
        lazy += 1;
      }

      if (image.loading === "eager") {
        eager += 1;
      }
    }

    return {
      total: images.length,
      complete,
      pending,
      lazy,
      eager
    };
  };

  const promoteLazyMedia = () => {
    const mediaNodes = document.querySelectorAll("img, source");
    const copiedAttrs = [
      ["data-src", "src"],
      ["data-lazy-src", "src"],
      ["data-original", "src"],
      ["data-srcset", "srcset"],
      ["data-lazy-srcset", "srcset"]
    ];

    for (const node of mediaNodes) {
      if ("loading" in node) {
        try {
          node.loading = "eager";
        } catch (error) {
          void error;
        }
      }

      for (const [fromAttr, toAttr] of copiedAttrs) {
        if (!node.hasAttribute(fromAttr) || node.getAttribute(toAttr)) {
          continue;
        }

        node.setAttribute(toAttr, node.getAttribute(fromAttr) || "");
      }
    }
  };

  const pokePageObservers = () => {
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    document.dispatchEvent(new Event("scroll"));
  };

  const progressiveScroll = () => {
    const scrollTargets = getScrollableTargets();
    let pageState = null;
    let remainingScrollable = 0;

    for (const target of scrollTargets) {
      const viewport = getTargetViewportHeight(target);
      const scrollTop = getTargetScrollTop(target);
      const maxScrollTop = getTargetMaxScrollTop(target);
      const stepSize = Math.max(Math.floor(viewport * 0.85), 240);
      const nextTop = Math.min(scrollTop + stepSize, maxScrollTop);

      scrollTargetTo(target, nextTop);

      if (nextTop < maxScrollTop - 4) {
        remainingScrollable += 1;
      }

      if (target === window) {
        pageState = {
          nextTop,
          maxScrollTop,
          viewport
        };
      }
    }

    return {
      ...(pageState || {
        nextTop: 0,
        maxScrollTop: 0,
        viewport: getViewportHeight()
      }),
      scrollableTargets: scrollTargets.length,
      remainingScrollable
    };
  };

  return (async () => {
    const startedAt = Date.now();
    const requestedWaitMs = Math.max(maxWaitMs || 0, 1000);
    const safeReturnBufferMs = Math.min(
      Math.max(Number(returnBufferMs) || 0, 500),
      Math.max(Math.floor(requestedWaitMs / 2), 500)
    );
    const deadline = startedAt + Math.max(requestedWaitMs - safeReturnBufferMs, 500);
    const rounds = [];
    let stableRounds = 0;
    let lastHeight = -1;
    let lastCompleteCount = -1;
    let lastPendingCount = Number.POSITIVE_INFINITY;
    let timedOut = false;

    while (Date.now() < deadline) {
      promoteLazyMedia();
      const scrollState = progressiveScroll();
      pokePageObservers();

      await sleep(300);

      promoteLazyMedia();
      window.scrollTo({
        top: Math.max(getScrollHeight() - scrollState.viewport, 0),
        behavior: "auto"
      });
      for (const target of getScrollableTargets()) {
        scrollTargetTo(target, getTargetMaxScrollTop(target));
      }
      pokePageObservers();

      await sleep(900);

      const height = getScrollHeight();
      const stats = getImageStats();
      const nearBottom =
        window.scrollY + scrollState.viewport >= height - 4 &&
        scrollState.remainingScrollable === 0;

      rounds.push({
        height,
        pending: stats.pending,
        complete: stats.complete,
        scrollY: window.scrollY,
        nearBottom,
        scrollableTargets: scrollState.scrollableTargets,
        remainingScrollable: scrollState.remainingScrollable,
        visibility: document.visibilityState
      });

      const noMoreGrowth = height <= lastHeight;
      const noMoreImageProgress =
        stats.complete <= lastCompleteCount && stats.pending >= lastPendingCount;

      if (nearBottom && noMoreGrowth && noMoreImageProgress) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
      }

      lastHeight = height;
      lastCompleteCount = stats.complete;
      lastPendingCount = stats.pending;

      if (nearBottom && stats.pending === 0) {
        break;
      }

      if (stableRounds >= 2) {
        break;
      }
    }

    timedOut = Date.now() >= deadline;
    promoteLazyMedia();
    window.scrollTo({
      top: getScrollHeight(),
      behavior: "auto"
    });
    for (const target of getScrollableTargets()) {
      scrollTargetTo(target, getTargetMaxScrollTop(target));
    }
    pokePageObservers();

    return {
      href: window.location.href,
      finalHeight: getScrollHeight(),
      finalScrollY: window.scrollY,
      visibilityState: document.visibilityState,
      elapsedMs: Date.now() - startedAt,
      requestedWaitMs,
      timedOut,
      rounds,
      images: getImageStats()
    };
  })();
}

function installDebugProbeInPage() {
  const globalKey = "__lazyPagePreloaderDebug";
  const maxStoredEvents = 80;
  const maxImageEventCount = 30;
  const maxMutationCount = 20;

  const truncate = (value, maxLength = 160) => {
    if (typeof value !== "string") {
      return value;
    }

    return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
  };

  const getResourceStats = () => {
    const stats = {
      total: 0,
      img: 0,
      css: 0,
      script: 0,
      fetch: 0,
      xmlhttprequest: 0,
      other: 0
    };

    for (const entry of performance.getEntriesByType("resource")) {
      stats.total += 1;
      const type = entry.initiatorType || "other";
      if (type in stats) {
        stats[type] += 1;
      } else {
        stats.other += 1;
      }
    }

    return stats;
  };

  const getImageStats = () => {
    const images = Array.from(document.images);
    let complete = 0;
    let pending = 0;
    let lazy = 0;
    let eager = 0;
    let withCurrentSrc = 0;
    let withSrc = 0;
    let withDataSrc = 0;

    for (const image of images) {
      if (image.complete && image.naturalWidth > 0) {
        complete += 1;
      } else {
        pending += 1;
      }

      if (image.loading === "lazy") {
        lazy += 1;
      }

      if (image.loading === "eager") {
        eager += 1;
      }

      if (image.currentSrc) {
        withCurrentSrc += 1;
      }

      if (image.getAttribute("src")) {
        withSrc += 1;
      }

      if (image.dataset?.src || image.getAttribute("data-src")) {
        withDataSrc += 1;
      }
    }

    return {
      total: images.length,
      complete,
      pending,
      lazy,
      eager,
      withCurrentSrc,
      withSrc,
      withDataSrc
    };
  };

  const sampleImages = () =>
    Array.from(document.images)
      .slice(0, 8)
      .map((image, index) => ({
        index,
        loading: image.loading || "",
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        src: truncate(image.getAttribute("src") || ""),
        currentSrc: truncate(image.currentSrc || ""),
        dataSrc: truncate(image.dataset?.src || image.getAttribute("data-src") || "")
      }));

  const buildSnapshot = (label) => ({
    label,
    href: window.location.href,
    title: document.title,
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    hasFocus: document.hasFocus(),
    scrollY: window.scrollY,
    innerHeight: window.innerHeight,
    scrollHeight: Math.max(
      document.body?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0
    ),
    imageStats: getImageStats(),
    resourceStats: getResourceStats(),
    imageSamples: sampleImages()
  });

  const sendMessage = (type, payload) => {
    try {
      if (chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type, payload }).catch(() => {});
      }
    } catch (error) {
      void error;
    }
  };

  if (window[globalKey]?.installed) {
    return window[globalKey].getSnapshot("probe-already-installed");
  }

  const state = {
    installed: true,
    events: [],
    imageEvents: 0,
    mutationEvents: 0
  };

  const pushEvent = (type, detail = {}) => {
    const event = {
      at: new Date().toISOString(),
      type,
      visibilityState: document.visibilityState,
      detail
    };

    state.events.push(event);
    if (state.events.length > maxStoredEvents) {
      state.events.shift();
    }
  };

  state.getSnapshot = (label) => {
    const snapshot = {
      ...buildSnapshot(label),
      recentEvents: state.events.slice(-12)
    };

    return snapshot;
  };

  window[globalKey] = state;

  document.addEventListener("visibilitychange", () => {
    pushEvent("visibilitychange", state.getSnapshot("visibilitychange"));
  });

  window.addEventListener("focus", () => {
    pushEvent("focus", state.getSnapshot("focus"));
  });

  window.addEventListener("pageshow", () => {
    pushEvent("pageshow", state.getSnapshot("pageshow"));
  });

  document.addEventListener(
    "load",
    (event) => {
      if (!(event.target instanceof HTMLImageElement)) {
        return;
      }

      if (state.imageEvents >= maxImageEventCount) {
        return;
      }

      state.imageEvents += 1;
      pushEvent("image-load", {
        index: state.imageEvents,
        src: truncate(event.target.getAttribute("src") || ""),
        currentSrc: truncate(event.target.currentSrc || ""),
        naturalWidth: event.target.naturalWidth
      });
    },
    true
  );

  document.addEventListener(
    "error",
    (event) => {
      if (!(event.target instanceof HTMLImageElement)) {
        return;
      }

      if (state.imageEvents >= maxImageEventCount) {
        return;
      }

      state.imageEvents += 1;
      pushEvent("image-error", {
        index: state.imageEvents,
        src: truncate(event.target.getAttribute("src") || ""),
        currentSrc: truncate(event.target.currentSrc || "")
      });
    },
    true
  );

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (state.mutationEvents >= maxMutationCount) {
        return;
      }

      const target = mutation.target;
      if (!(target instanceof HTMLImageElement) && !(target instanceof HTMLSourceElement)) {
        continue;
      }

      state.mutationEvents += 1;
      pushEvent("media-attr-change", {
        index: state.mutationEvents,
        tagName: target.tagName,
        attributeName: mutation.attributeName || "",
        src: truncate(target.getAttribute("src") || ""),
        srcset: truncate(target.getAttribute("srcset") || ""),
        dataSrc: truncate(target.getAttribute("data-src") || ""),
        dataSrcset: truncate(target.getAttribute("data-srcset") || "")
      });
    }
  });

  observer.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "data-src", "data-srcset", "loading"]
  });

  pushEvent("probe-installed", state.getSnapshot("probe-installed"));
  return state.getSnapshot("probe-installed");
}

function collectDebugSnapshotInPage(label) {
  const state = window.__lazyPagePreloaderDebug;
  if (state?.getSnapshot) {
    return state.getSnapshot(label);
  }

  return {
    label,
    href: window.location.href,
    title: document.title,
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    message: "诊断探针未安装"
  };
}

function incrementStatus(key) {
  setStatus({
    [key]: (currentStatus[key] || 0) + 1
  });
}

function getCompletedProgress(index) {
  const countedProgress = (currentStatus.successCount || 0) + (currentStatus.failureCount || 0);
  return Math.max(countedProgress, index + 1);
}

function getTargetTimeoutMs(waitSeconds) {
  return Math.max(
    MIN_TARGET_TIMEOUT_MS,
    (Number(waitSeconds) || 0) * 1000 + TARGET_TIMEOUT_BUFFER_MS
  );
}

function withTargetTimeout(promise, target, waitSeconds) {
  const timeoutMs = getTargetTimeoutMs(waitSeconds);
  let timeoutId = null;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`Target processing timed out after ${timeoutMs}ms`);
      error.name = "TargetProcessingTimeoutError";
      error.details = {
        page: target?.page || null,
        url: target?.url || "",
        tabId: target?.tabId || null,
        timeoutMs
      };

      appendDebugLog("target-timeout", error.details);
      if (Number.isInteger(target?.tabId)) {
        chrome.tabs.remove(target.tabId).catch((removeError) => {
          appendDebugLog("target-timeout-close-tab-failed", {
            tabId: target.tabId,
            error: toLoggableError(removeError)
          });
        });
      }

      reject(error);
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

function finishTask({ phase, message }) {
  currentTask = null;
  void clearActiveTask();
  clearTaskAlarm();
  setStatus({
    phase,
    message
  });
  void notifyCompletion(
    phase === "failed-partial" ? "预加载完成但存在警告" : "预加载完成",
    message
  );
}

async function stopCurrentTask(reason = "user-request") {
  const stored = await chrome.storage.local.get(ACTIVE_TASK_STORAGE_KEY);
  const persistedTask = stored[ACTIVE_TASK_STORAGE_KEY] || null;
  const taskToStop = currentTask || persistedTask;

  if (!taskToStop && currentStatus.phase !== "running") {
    await clearActiveTask();
    clearTaskAlarm();
    return {
      ok: true,
      status: currentStatus,
      message: "No running task to stop."
    };
  }

  const stoppedTaskId = taskToStop?.id || currentTask?.id || null;
  appendDebugLog("task-stop-request", {
    taskId: stoppedTaskId,
    reason
  });

  currentTask = null;
  await clearActiveTask();
  clearTaskAlarm();

  const closeResult = await closeTaskTabs(taskToStop);
  appendDebugLog("task-stopped", {
    taskId: stoppedTaskId,
    closedTabIds: closeResult.closedTabIds,
    failedTabIds: closeResult.failedTabIds
  });

  setStatus({
    phase: "stopped",
    message: closeResult.closedTabIds.length
      ? `Task stopped. Closed ${closeResult.closedTabIds.length} preload tab(s).`
      : "Task stopped."
  });

  return {
    ok: true,
    status: currentStatus,
    closedTabIds: closeResult.closedTabIds,
    failedTabIds: closeResult.failedTabIds
  };
}

async function closeTaskTabs(task) {
  const tabIds = collectTaskTabIds(task);
  if (!tabIds.length) {
    return {
      closedTabIds: [],
      failedTabIds: []
    };
  }

  const results = await Promise.all(
    tabIds.map(async (tabId) => {
      try {
        await chrome.tabs.remove(tabId);
        return { tabId, ok: true };
      } catch (error) {
        appendDebugLog("stop-close-tab-failed", {
          tabId,
          error: toLoggableError(error)
        });
        return { tabId, ok: false };
      }
    })
  );

  return {
    closedTabIds: results.filter((result) => result.ok).map((result) => result.tabId),
    failedTabIds: results.filter((result) => !result.ok).map((result) => result.tabId)
  };
}

function collectTaskTabIds(task) {
  const tabIds = new Set();
  if (!task) {
    return [];
  }

  if (Number.isInteger(task.activeTabId)) {
    tabIds.add(task.activeTabId);
  }

  for (const target of task.targets || []) {
    if (Number.isInteger(target?.tabId)) {
      tabIds.add(target.tabId);
    }
  }

  return [...tabIds];
}

function isCurrentTask(taskId) {
  return currentTask?.id === taskId;
}

function setStatus(patch) {
  currentStatus = {
    ...currentStatus,
    ...patch
  };
  void persistStatus(currentStatus);
  broadcastStatus(currentStatus);
}

async function persistActiveTask() {
  if (!currentTask) {
    return;
  }

  await chrome.storage.local.set({
    [ACTIVE_TASK_STORAGE_KEY]: {
      id: currentTask.id,
      phase: currentTask.phase,
      targets: currentTask.targets,
      waitSeconds: currentTask.waitSeconds,
      concurrentTabs: currentTask.concurrentTabs || 1,
      nextIndex: currentTask.nextIndex || 0,
      activeTabId: currentTask.activeTabId || null,
      startedAt: currentTask.startedAt
    }
  });
}

async function clearActiveTask() {
  await chrome.storage.local.remove(ACTIVE_TASK_STORAGE_KEY);
}

function ensureTaskAlarm() {
  chrome.alarms.create(TASK_ALARM_NAME, {
    delayInMinutes: 1,
    periodInMinutes: 1
  });
}

function clearTaskAlarm() {
  chrome.alarms.clear(TASK_ALARM_NAME).catch(() => {});
}

async function persistStatus(status) {
  await chrome.storage.session.set({
    [STATUS_STORAGE_KEY]: status
  });
}

async function persistDebugLogs() {
  await chrome.storage.session.set({
    [DEBUG_LOGS_STORAGE_KEY]: debugLogs
  });
}

function broadcastStatus(status) {
  chrome.runtime.sendMessage({ type: "STATUS_UPDATE", status }).catch(() => {});
  for (const port of connectedPanelPorts) {
    try {
      port.postMessage({ type: "STATUS_UPDATE", status });
    } catch (error) {
      appendDebugLog("panel-port-status-failed", {
        error: toLoggableError(error)
      });
    }
  }
}

async function notifyCompletion(title, message) {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9sX5TRwAAAAASUVORK5CYII=",
      title,
      message
    });
  } catch (error) {
    console.warn("通知不可用:", error);
  }
}

function appendDebugLog(type, payload) {
  debugLogs.push({
    at: new Date().toISOString(),
    type,
    payload: compactDebugPayload(payload)
  });

  if (debugLogs.length > MAX_DEBUG_LOGS) {
    debugLogs = debugLogs.slice(-MAX_DEBUG_LOGS);
  }

  void persistDebugLogs().catch((error) => {
    console.warn("保存诊断日志失败:", error);
  });
}

function getRecentDebugLogs(limit = 80) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 80, 1), MAX_DEBUG_LOGS);
  return debugLogs.slice(-normalizedLimit);
}

function compactDebugPayload(payload) {
  try {
    const serialized = JSON.stringify(payload);
    if (!serialized || serialized.length <= MAX_DEBUG_LOG_PAYLOAD_CHARS) {
      return payload;
    }

    return {
      truncated: true,
      originalLength: serialized.length,
      preview: serialized.slice(0, MAX_DEBUG_LOG_PAYLOAD_CHARS)
    };
  } catch (error) {
    return {
      truncated: true,
      error: toLoggableError(error),
      preview: String(payload).slice(0, MAX_DEBUG_LOG_PAYLOAD_CHARS)
    };
  }
}

async function restorePersistedState() {
  if (currentTask?.phase === "running") {
    ensureTaskAlarm();
    startTaskRunner(currentTask.id);
    return;
  }

  const [sessionStored, localStored] = await Promise.all([
    chrome.storage.session.get([STATUS_STORAGE_KEY, DEBUG_LOGS_STORAGE_KEY]),
    chrome.storage.local.get(ACTIVE_TASK_STORAGE_KEY)
  ]);

  currentStatus = sessionStored[STATUS_STORAGE_KEY] || createIdleStatus();
  debugLogs = sessionStored[DEBUG_LOGS_STORAGE_KEY] || [];

  const activeTask = localStored[ACTIVE_TASK_STORAGE_KEY];
  if (isRestorableTask(activeTask)) {
    if (activeTask.activeTabId) {
      appendDebugLog("stale-tab-left-open", {
        tabId: activeTask.activeTabId,
        message: "扩展后台重启前正在处理的标签页已保留，任务将从当前页重新开始。"
      });
      activeTask.activeTabId = null;
      await chrome.storage.local.set({
        [ACTIVE_TASK_STORAGE_KEY]: activeTask
      });
    }

    taskSequence = Math.max(taskSequence, activeTask.id || 0);
    currentTask = {
      ...activeTask,
      phase: "running"
    };

    if (currentStatus.phase !== "running") {
      setStatus({
        phase: "running",
        total: activeTask.targets.length,
        currentIndex: activeTask.nextIndex || 0,
        successCount: currentStatus.successCount || 0,
        failureCount: currentStatus.failureCount || 0,
        message: "扩展后台重启后已恢复未完成任务。",
        startedAt: activeTask.startedAt || new Date().toISOString()
      });
    }

    appendDebugLog("task-resume", {
      taskId: activeTask.id,
      nextIndex: activeTask.nextIndex || 0,
      total: activeTask.targets.length
    });

    ensureTaskAlarm();
    startTaskRunner(activeTask.id);
    return;
  }

  if (currentStatus.phase === "running") {
    currentTask = null;
    currentStatus = {
      ...createIdleStatus(),
      phase: "failed-partial",
      message:
        "扩展后台在任务运行中重启，任务已标记为部分失败。"
    };
    void persistStatus(currentStatus);
  }
}

function isRestorableTask(task) {
  return (
    task &&
    task.phase === "running" &&
    Number.isInteger(task.id) &&
    Array.isArray(task.targets) &&
    task.targets.length > 0 &&
    Number.isInteger(task.waitSeconds) &&
    (!task.concurrentTabs || Number.isInteger(task.concurrentTabs)) &&
    Number.isInteger(task.nextIndex) &&
    task.nextIndex >= 0 &&
    task.nextIndex <= task.targets.length
  );
}

function isScriptExecutionTimeout(error) {
  return error?.name === "ScriptExecutionTimeoutError";
}

function isTargetProcessingTimeout(error) {
  return error?.name === "TargetProcessingTimeoutError";
}

function isMissingTabError(error) {
  const message = error?.message || "";
  return message.includes("No tab with id") || message.includes("No tab with given id");
}

function isExpectedTargetInterruption(error) {
  return (
    isMissingTabError(error) ||
    isScriptExecutionTimeout(error) ||
    isTargetProcessingTimeout(error)
  );
}

function toLoggableError(error) {
  if (!error) {
    return null;
  }

  if (typeof error === "string") {
    return { message: error };
  }

  return {
    name: error.name || "Error",
    message: error.message || String(error),
    stack: error.stack || ""
  };
}
