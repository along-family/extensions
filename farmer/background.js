import {
  ALARMS,
  API_BASE_URL,
  API_ORIGIN,
  DEFAULT_QUANTITY,
  FARM_PAGE_URL,
  SEED_ID,
  STORAGE_KEY,
  createDefaultState,
  normalizeQuantity,
  parseCookieText
} from "./shared.js";

const ONE_HOUR_SECONDS = 60 * 60;
const STATUS_RANDOM_SECONDS = 300;
const HARVEST_RANDOM_SECONDS = 100;
const PLANT_RANDOM_SECONDS = 60;

let operationQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  void initializeState();
});

chrome.runtime.onStartup.addListener(() => {
  void restoreScheduledAlarms();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARMS.status) {
    void enqueueOperation(() => runStatusCheck("alarm"));
    return;
  }

  if (alarm.name === ALARMS.harvest) {
    void enqueueOperation(() => runHarvest());
    return;
  }

  if (alarm.name === ALARMS.plant) {
    void enqueueOperation(() => runPlant());
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "GET_STATE") {
    void getState()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, message: getErrorMessage(error) }));
    return true;
  }

  if (message.type === "SAVE_CONFIG") {
    void saveConfig(message.payload || {})
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, message: getErrorMessage(error) }));
    return true;
  }

  if (message.type === "START") {
    void enqueueOperation(() => startAutomation())
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, message: getErrorMessage(error) }));
    return true;
  }

  if (message.type === "STOP") {
    void stopAutomation()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, message: getErrorMessage(error) }));
    return true;
  }

  if (message.type === "REFRESH_NOW") {
    void enqueueOperation(() => runStatusCheck("manual"))
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, message: getErrorMessage(error) }));
    return true;
  }

  return false;
});

void restoreScheduledAlarms();

async function initializeState() {
  const state = await getState();
  await setState({
    ...state,
    quantity: normalizeQuantity(state.quantity) || DEFAULT_QUANTITY
  });
  await restoreScheduledAlarms();
}

async function startAutomation() {
  await clearAllAlarms();
  await setState({
    ...(await getState()),
    enabled: true,
    phase: "running",
    message: "已启动，正在查询农场状态",
    lastError: ""
  });

  return runStatusCheck("start");
}

async function stopAutomation() {
  await clearAllAlarms();
  return setState({
    ...(await getState()),
    enabled: false,
    phase: "idle",
    message: "已停止",
    nextHarvestAt: null,
    nextStatusRefreshAt: null,
    nextPlantAt: null
  });
}

async function saveConfig(payload) {
  const quantity = normalizeQuantity(payload.quantity);
  if (!quantity) {
    throw new Error("种植数量必须是正整数。");
  }

  const cookieText = String(payload.cookieText || "").trim();
  const state = await getState();
  const nextState = await setState({
    ...state,
    quantity,
    cookieText,
    lastError: ""
  });

  if (cookieText) {
    await syncCookieText(cookieText);
  }

  return nextState;
}

async function runStatusCheck(source) {
  const state = await getState();
  if (!state.enabled && source !== "manual") {
    return state;
  }

  await setState({
    ...state,
    phase: state.enabled ? "running" : "idle",
    message: "正在查询农场状态",
    lastError: ""
  });

  try {
    const response = await farmFetch("/crops", {
      method: "GET"
    });

    const crops = normalizeCrops(response);
    const firstCrop = crops[0] || null;
    const now = Date.now();
    const nextStatusRefreshAt = state.enabled
      ? createFutureIso(ONE_HOUR_SECONDS + randomInteger(STATUS_RANDOM_SECONDS))
      : null;

    let nextHarvestAt = null;
    let message = "查询成功";

    if (firstCrop?.maturesAt) {
      await chrome.alarms.clear(ALARMS.plant);
      nextHarvestAt = chooseHarvestTime(state, firstCrop.maturesAt, now);
      if (state.enabled) {
        scheduleAlarm(ALARMS.harvest, nextHarvestAt);
      }
      message = isTimeReached(firstCrop.maturesAt) ? "作物已成熟，已安排延迟收割" : "作物生长中";
    } else if (state.enabled) {
      await chrome.alarms.clear(ALARMS.harvest);
      const nextPlantAt = createFutureIso(randomInteger(PLANT_RANDOM_SECONDS));
      scheduleAlarm(ALARMS.plant, nextPlantAt);
      const nextState = await setState({
        ...(await getState()),
        phase: "running",
        message: "当前没有作物，已安排种植",
        cropCount: 0,
        cropName: "",
        cropSeedId: "",
        maturesAt: null,
        nextHarvestAt: null,
        nextPlantAt,
        nextStatusRefreshAt,
        lastStatusAt: new Date().toISOString(),
        lastActionAt: new Date().toISOString(),
        lastError: ""
      });

      if (nextStatusRefreshAt) {
        scheduleAlarm(ALARMS.status, nextStatusRefreshAt);
      }
      return nextState;
    }

    if (nextStatusRefreshAt) {
      scheduleAlarm(ALARMS.status, nextStatusRefreshAt);
    }

    return setState({
      ...(await getState()),
      phase: state.enabled ? "running" : "idle",
      message,
      cropCount: crops.length,
      cropName: firstCrop?.seedName || "",
      cropSeedId: firstCrop?.seedId || "",
      maturesAt: firstCrop?.maturesAt || null,
      nextHarvestAt,
      nextStatusRefreshAt,
      nextPlantAt: null,
      lastStatusAt: new Date().toISOString(),
      lastActionAt: new Date().toISOString(),
      lastError: ""
    });
  } catch (error) {
    const nextStatusRefreshAt = state.enabled
      ? createFutureIso(ONE_HOUR_SECONDS + randomInteger(STATUS_RANDOM_SECONDS))
      : null;

    if (nextStatusRefreshAt) {
      scheduleAlarm(ALARMS.status, nextStatusRefreshAt);
    }

    return setState({
      ...(await getState()),
      phase: state.enabled ? "error" : "idle",
      message: "查询失败",
      nextStatusRefreshAt,
      lastActionAt: new Date().toISOString(),
      lastError: getErrorMessage(error)
    });
  }
}

async function runHarvest() {
  const state = await getState();
  if (!state.enabled) {
    return state;
  }

  await setState({
    ...state,
    phase: "running",
    message: "正在收割",
    lastError: ""
  });

  try {
    await farmFetch("/harvest-all", {
      method: "POST",
      body: {}
    });

    await chrome.alarms.clear(ALARMS.harvest);
    const nextPlantAt = createFutureIso(randomInteger(PLANT_RANDOM_SECONDS));
    scheduleAlarm(ALARMS.plant, nextPlantAt);

    return setState({
      ...(await getState()),
      phase: "running",
      message: "收割成功，已安排种植",
      nextHarvestAt: null,
      nextPlantAt,
      lastActionAt: new Date().toISOString(),
      lastError: ""
    });
  } catch (error) {
    const retryAt = createFutureIso(randomInteger(HARVEST_RANDOM_SECONDS));
    scheduleAlarm(ALARMS.harvest, retryAt);

    return setState({
      ...(await getState()),
      phase: "error",
      message: "收割失败，已安排重试",
      nextHarvestAt: retryAt,
      lastActionAt: new Date().toISOString(),
      lastError: getErrorMessage(error)
    });
  }
}

async function runPlant() {
  const state = await getState();
  if (!state.enabled) {
    return state;
  }

  await setState({
    ...state,
    phase: "running",
    message: "正在种植",
    lastError: ""
  });

  try {
    await farmFetch("/plant-batch", {
      method: "POST",
      body: {
        seedId: SEED_ID,
        quantity: normalizeQuantity(state.quantity) || DEFAULT_QUANTITY
      }
    });

    await chrome.alarms.clear(ALARMS.plant);
    await setState({
      ...(await getState()),
      phase: "running",
      message: "种植成功，正在刷新状态",
      nextPlantAt: null,
      lastActionAt: new Date().toISOString(),
      lastError: ""
    });

    return runStatusCheck("plant");
  } catch (error) {
    const retryAt = createFutureIso(randomInteger(PLANT_RANDOM_SECONDS));
    scheduleAlarm(ALARMS.plant, retryAt);

    return setState({
      ...(await getState()),
      phase: "error",
      message: "种植失败，已安排重试",
      nextPlantAt: retryAt,
      lastActionAt: new Date().toISOString(),
      lastError: getErrorMessage(error)
    });
  }
}

async function farmFetch(path, options) {
  const state = await getState();
  if (state.cookieText) {
    await syncCookieText(state.cookieText);
  }

  const method = options.method || "GET";
  const tabId = await getFarmTabId();
  await waitForTabReady(tabId, 15000);

  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: performFarmFetchInPage,
    args: [`${API_BASE_URL}${path}`, method, options.body ?? null]
  });

  if (!result?.ok) {
    throw new Error(result?.message || "接口请求失败。");
  }

  return result.data;
}

async function getFarmTabId() {
  const tabs = await chrome.tabs.query({
    url: `${API_ORIGIN}/*`
  });

  const farmTab = tabs.find((tab) => tab.url?.startsWith(FARM_PAGE_URL)) || tabs[0];
  if (farmTab?.id) {
    return farmTab.id;
  }

  const createdTab = await chrome.tabs.create({
    url: FARM_PAGE_URL,
    active: false
  });

  if (!createdTab.id) {
    throw new Error("无法打开农场页面。");
  }

  return createdTab.id;
}

function waitForTabReady(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("农场页面加载超时。"));
    }, timeoutMs);

    const cleanup = () => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };

    const finish = () => {
      cleanup();
      resolve();
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    };

    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) {
        cleanup();
        reject(new Error("农场页面已关闭。"));
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (!settled && tab.status === "complete") {
          finish();
        }
      })
      .catch((error) => {
        cleanup();
        reject(error);
      });
  });
}

async function performFarmFetchInPage(url, method, body) {
  try {
    const init = {
      method,
      mode: "cors",
      credentials: "include",
      headers: {
        accept: "*/*",
        "cache-control": "no-cache",
        pragma: "no-cache"
      },
      referrer: "https://cdk.hybgzs.com/entertainment/farm"
    };

    if (body !== null) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);
    const text = await response.text();
    let data = null;

    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!response.ok) {
      return {
        ok: false,
        message: `接口请求失败：HTTP ${response.status}`,
        data
      };
    }

    if (data && typeof data === "object" && data.success === false) {
      return {
        ok: false,
        message: data.message || "接口返回失败。",
        data
      };
    }

    return {
      ok: true,
      data
    };
  } catch (error) {
    return {
      ok: false,
      message: error?.message || String(error || "接口请求失败。")
    };
  }
}

async function syncCookieText(cookieText) {
  const cookies = parseCookieText(cookieText);
  if (!cookies.length) {
    return;
  }

  await Promise.all(
    cookies.map((cookie) =>
      chrome.cookies.set({
        url: FARM_PAGE_URL,
        name: cookie.name,
        value: cookie.value,
        path: "/",
        secure: true
      })
    )
  );
}

async function restoreScheduledAlarms() {
  const state = await getState();
  await clearAllAlarms();

  if (!state.enabled) {
    return;
  }

  scheduleAlarm(ALARMS.status, state.nextStatusRefreshAt);
  scheduleAlarm(ALARMS.harvest, state.nextHarvestAt);
  scheduleAlarm(ALARMS.plant, state.nextPlantAt);
}

async function clearAllAlarms() {
  await Promise.all(Object.values(ALARMS).map((name) => chrome.alarms.clear(name)));
}

function scheduleAlarm(name, isoTime) {
  const timestamp = Date.parse(isoTime || "");
  if (!Number.isFinite(timestamp)) {
    return;
  }

  chrome.alarms.create(name, {
    when: Math.max(timestamp, Date.now() + 1000)
  });
}

function chooseHarvestTime(state, maturesAt, now) {
  const existingTime = Date.parse(state.nextHarvestAt || "");
  if (
    state.maturesAt === maturesAt &&
    Number.isFinite(existingTime) &&
    existingTime > now - 1000
  ) {
    return state.nextHarvestAt;
  }

  const matureTime = Date.parse(maturesAt);
  const baseTime = Number.isFinite(matureTime) ? Math.max(matureTime, now) : now;
  return new Date(baseTime + randomInteger(HARVEST_RANDOM_SECONDS) * 1000).toISOString();
}

function normalizeCrops(response) {
  if (Array.isArray(response?.data)) {
    return response.data;
  }

  if (Array.isArray(response?.crops)) {
    return response.crops;
  }

  return [];
}

function isTimeReached(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function randomInteger(maxInclusive) {
  return Math.floor(Math.random() * (maxInclusive + 1));
}

function createFutureIso(delaySeconds) {
  return new Date(Date.now() + Math.max(delaySeconds, 0) * 1000).toISOString();
}

function enqueueOperation(operation) {
  const nextOperation = operationQueue.catch(() => {}).then(operation);
  operationQueue = nextOperation.catch(() => {});
  return nextOperation;
}

async function getState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return {
    ...createDefaultState(),
    ...(stored[STORAGE_KEY] || {})
  };
}

async function setState(nextState) {
  const state = {
    ...createDefaultState(),
    ...nextState
  };

  await chrome.storage.local.set({
    [STORAGE_KEY]: state
  });

  broadcastState(state);
  return state;
}

function broadcastState(state) {
  chrome.runtime.sendMessage({ type: "STATE_UPDATE", state }).catch(() => {});
}

function getErrorMessage(error) {
  return error?.message || String(error || "未知错误");
}
