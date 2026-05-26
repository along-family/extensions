import {
  DEBUG_LOGS_STORAGE_KEY,
  LAST_INPUT_STORAGE_KEY,
  PAGE_LOAD_TIMEOUT_MS,
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
const PANEL_PORT_NAME = "lazy-page-preloader-panel";
const PANEL_FILES = {
  css: ["panel.css"],
  js: ["panel.js"]
};

const connectedPanelPorts = new Set();

chrome.runtime.onInstalled.addListener(() => {
  void persistStatus(currentStatus);
  void persistDebugLogs();
});

chrome.runtime.onStartup.addListener(() => {
  void restorePersistedState();
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
    sendResponse({ ok: true, logs: debugLogs });
    return false;
  }

  if (message.type === "GET_PANEL_BOOTSTRAP") {
    void chrome.storage.local
      .get(LAST_INPUT_STORAGE_KEY)
      .then((stored) => {
        sendResponse({
          ok: true,
          status: currentStatus,
          logs: debugLogs,
          lastInput: stored[LAST_INPUT_STORAGE_KEY] || null
        });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          message: error?.message || "Failed to load panel bootstrap data."
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
      console.error("Failed to start preload task:", error);
      sendResponse({ ok: false, message: "Failed to start the preload task." });
    }
    return false;
  }

  return false;
});

void restorePersistedState();

function beginPreloadTask(payload) {
  if (currentTask?.phase === "running") {
    return { ok: false, message: "Another preload task is already running." };
  }

  debugLogs = [];
  void persistDebugLogs();

  const validation = validateUserInput(payload || {});
  if (!validation.ok) {
    return { ok: false, message: validation.message };
  }

  const { url, count, waitSeconds } = validation.value;
  const targets = buildPageUrls(url, count);
  if (!targets.length) {
    return { ok: false, message: "No target pages were generated from the URL." };
  }

  void chrome.storage.local.set({
    [LAST_INPUT_STORAGE_KEY]: {
      url,
      count,
      waitSeconds
    }
  });

  const taskId = ++taskSequence;
  currentTask = {
    id: taskId,
    phase: "running"
  };

  appendDebugLog("task-start", {
    taskId,
    url,
    count,
    waitSeconds,
    targets,
    panelConnections: connectedPanelPorts.size
  });

  setStatus({
    phase: "running",
    total: targets.length,
    currentIndex: 0,
    successCount: 0,
    failureCount: 0,
    message: "Task started. The panel can stay open while the worker runs.",
    startedAt: new Date().toISOString()
  });

  Promise.resolve().then(() =>
    runPreloadTask(taskId, targets, waitSeconds).catch((error) => {
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
        message: "The task crashed unexpectedly. Check the debug log."
      });
    })
  );

  return {
    ok: true,
    status: currentStatus
  };
}

async function runPreloadTask(taskId, targets, waitSeconds) {
  for (let index = 0; index < targets.length; index += 1) {
    if (!isCurrentTask(taskId)) {
      return;
    }

    const target = targets[index];
    setStatus({
      currentIndex: index + 1,
      message: `Processing page ${target.page} (${index + 1}/${targets.length})`
    });

    try {
      appendDebugLog("target-start", {
        taskId,
        index,
        page: target.page,
        url: target.url
      });

      await processTarget(target, waitSeconds);

      appendDebugLog("target-success", {
        taskId,
        index,
        page: target.page,
        url: target.url
      });

      incrementStatus("successCount");
      setStatus({
        message: `Finished page ${target.page} (${index + 1}/${targets.length})`
      });
    } catch (error) {
      console.error(
        `[LazyPagePreloader] Failed: page=${target.page} url=${target.url}`,
        error
      );

      appendDebugLog("target-failure", {
        taskId,
        index,
        page: target.page,
        url: target.url,
        error: toLoggableError(error)
      });

      incrementStatus("failureCount");
      setStatus({
        message: `Page ${target.page} failed. Continuing with the next page.`
      });
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
      ? `Finished with partial failures. Success: ${currentStatus.successCount}, failed: ${currentStatus.failureCount}.`
      : `Finished successfully. Loaded ${currentStatus.successCount} pages.`
  });
}

async function processTarget(target, waitSeconds) {
  const createdTab = await chrome.tabs.create({
    url: target.url,
    active: false
  });

  const tabId = createdTab.id;
  appendDebugLog("tab-created", {
    tabId: tabId ?? null,
    url: target.url,
    active: createdTab.active,
    status: createdTab.status
  });

  if (!tabId) {
    throw new Error("Failed to create a background tab.");
  }

  await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  await waitForTabComplete(tabId, PAGE_LOAD_TIMEOUT_MS);

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
}

function analyzeTargetOutcome(target, beforeScrollSnapshot, scrollResult, afterScrollSnapshot) {
  const beforeImages = beforeScrollSnapshot?.imageStats || null;
  const afterImages = afterScrollSnapshot?.imageStats || null;
  const visibilityState =
    afterScrollSnapshot?.visibilityState || scrollResult?.visibilityState || "unknown";

  if (visibilityState === "hidden") {
    appendDebugLog("background-visibility-warning", {
      page: target.page,
      url: target.url,
      message:
        "This page stayed hidden while loading. Some lazy-load implementations stall in background tabs."
    });
  }

  if (
    beforeImages &&
    afterImages &&
    afterImages.complete <= beforeImages.complete &&
    afterImages.pending >= beforeImages.pending
  ) {
    appendDebugLog("no-image-progress-warning", {
      page: target.page,
      url: target.url,
      beforeImages,
      afterImages,
      message:
        "Image completion did not improve after scrolling. The site may require foreground visibility or a different scroll trigger."
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

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(`Page load timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") {
        return;
      }

      cleanup();
      resolve();
    };

    const onRemoved = (removedTabId) => {
      if (removedTabId !== tabId) {
        return;
      }

      cleanup();
      reject(new Error("The tab was closed before loading completed."));
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

    void chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") {
          cleanup();
          resolve();
        }
      })
      .catch((error) => {
        cleanup();
        reject(error);
      });
  });
}

async function scrollTabToBottom(tabId, waitSeconds) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: performScrollToBottom,
    args: [waitSeconds * 1000]
  });

  return result || null;
}

async function installDebugProbe(tabId) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: installDebugProbeInPage
  });

  return result || null;
}

async function collectDebugSnapshot(tabId, label) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: collectDebugSnapshotInPage,
    args: [label]
  });

  return result || null;
}

async function togglePanelForTab(tab) {
  if (!tab?.id || !isInjectableUrl(tab.url)) {
    await notifyCompletion(
      "Cannot open panel",
      "Open a normal http/https page first, then click the extension again."
    );
    return;
  }

  try {
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: PANEL_FILES.css
    });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: PANEL_FILES.js
    });
  } catch (error) {
    console.error("Failed to inject panel:", error);
    appendDebugLog("panel-injection-failure", {
      tabId: tab.id,
      url: tab.url,
      error: toLoggableError(error)
    });
    await notifyCompletion(
      "Panel injection failed",
      "Chrome blocked script injection on this page."
    );
  }
}

function isInjectableUrl(url) {
  return typeof url === "string" && /^https?:/i.test(url);
}

function performScrollToBottom(maxWaitMs) {
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
    const viewport = getViewportHeight();
    const scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
    const maxScrollTop = Math.max(getScrollHeight() - viewport, 0);
    const stepSize = Math.max(Math.floor(viewport * 0.85), 240);
    const nextTop = Math.min(scrollTop + stepSize, maxScrollTop);

    window.scrollTo({
      top: nextTop,
      behavior: "auto"
    });

    return {
      nextTop,
      maxScrollTop,
      viewport
    };
  };

  return (async () => {
    const startedAt = Date.now();
    const deadline = startedAt + Math.max(maxWaitMs || 0, 1000);
    const rounds = [];
    let stableRounds = 0;
    let lastHeight = -1;
    let lastCompleteCount = -1;
    let lastPendingCount = Number.POSITIVE_INFINITY;

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
      pokePageObservers();

      await sleep(900);

      const height = getScrollHeight();
      const stats = getImageStats();
      const nearBottom = window.scrollY + scrollState.viewport >= height - 4;

      rounds.push({
        height,
        pending: stats.pending,
        complete: stats.complete,
        scrollY: window.scrollY,
        nearBottom,
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

    promoteLazyMedia();
    window.scrollTo({
      top: getScrollHeight(),
      behavior: "auto"
    });
    pokePageObservers();

    return {
      href: window.location.href,
      finalHeight: getScrollHeight(),
      finalScrollY: window.scrollY,
      visibilityState: document.visibilityState,
      elapsedMs: Date.now() - startedAt,
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

    sendMessage("PAGE_DEBUG_EVENT", {
      href: window.location.href,
      title: document.title,
      event
    });
  };

  state.getSnapshot = (label) => {
    const snapshot = {
      ...buildSnapshot(label),
      recentEvents: state.events.slice(-12)
    };

    sendMessage("PAGE_DEBUG_SNAPSHOT", snapshot);
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
    message: "debug probe not installed"
  };
}

function incrementStatus(key) {
  setStatus({
    [key]: (currentStatus[key] || 0) + 1
  });
}

function finishTask({ phase, message }) {
  currentTask = null;
  setStatus({
    phase,
    message
  });
  void notifyCompletion(
    phase === "failed-partial" ? "Preload finished with warnings" : "Preload finished",
    message
  );
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
    console.warn("Notification unavailable:", error);
  }
}

function appendDebugLog(type, payload) {
  debugLogs.push({
    at: new Date().toISOString(),
    type,
    payload
  });

  if (debugLogs.length > MAX_DEBUG_LOGS) {
    debugLogs = debugLogs.slice(-MAX_DEBUG_LOGS);
  }

  void persistDebugLogs().catch((error) => {
    console.warn("Failed to persist debug logs:", error);
  });
}

async function restorePersistedState() {
  const stored = await chrome.storage.session.get([
    STATUS_STORAGE_KEY,
    DEBUG_LOGS_STORAGE_KEY
  ]);

  currentStatus = stored[STATUS_STORAGE_KEY] || createIdleStatus();
  debugLogs = stored[DEBUG_LOGS_STORAGE_KEY] || [];

  if (currentStatus.phase === "running") {
    currentTask = null;
    currentStatus = {
      ...createIdleStatus(),
      phase: "failed-partial",
      message:
        "The extension worker restarted while a task was running. This is a common MV3 failure mode."
    };
    void persistStatus(currentStatus);
  }
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
