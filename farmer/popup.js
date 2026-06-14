import {
  DEFAULT_QUANTITY,
  formatDateTime,
  formatRelative,
  normalizeQuantity
} from "./shared.js";

const summary = document.querySelector("#summary");
const runBadge = document.querySelector("#run-badge");
const toggleButton = document.querySelector("#toggle-button");
const refreshButton = document.querySelector("#refresh-button");
const saveButton = document.querySelector("#save-button");
const quantityField = document.querySelector("#quantity");
const cookieTextField = document.querySelector("#cookieText");
const cropCount = document.querySelector("#crop-count");
const cropName = document.querySelector("#crop-name");
const maturesAt = document.querySelector("#matures-at");
const nextHarvestAt = document.querySelector("#next-harvest-at");
const nextStatusRefreshAt = document.querySelector("#next-status-refresh-at");
const nextPlantAt = document.querySelector("#next-plant-at");
const lastActionAt = document.querySelector("#last-action-at");
const lastStatusAt = document.querySelector("#last-status-at");
const errorMessage = document.querySelector("#error-message");

let currentState = null;
let tickerId = null;

init().catch((error) => {
  renderError(error?.message || "初始化失败");
});

toggleButton.addEventListener("click", async () => {
  setBusy(true);
  try {
    const response = await chrome.runtime.sendMessage({
      type: currentState?.enabled ? "STOP" : "START"
    });
    handleResponse(response);
  } catch (error) {
    renderError(error?.message || "操作失败");
  } finally {
    setBusy(false);
  }
});

refreshButton.addEventListener("click", async () => {
  setBusy(true);
  try {
    const response = await chrome.runtime.sendMessage({ type: "REFRESH_NOW" });
    handleResponse(response);
  } catch (error) {
    renderError(error?.message || "查询失败");
  } finally {
    setBusy(false);
  }
});

saveButton.addEventListener("click", async () => {
  const quantity = normalizeQuantity(quantityField.value);
  if (!quantity) {
    renderError("种植数量必须是正整数。");
    return;
  }

  setBusy(true);
  try {
    const response = await chrome.runtime.sendMessage({
      type: "SAVE_CONFIG",
      payload: {
        quantity,
        cookieText: cookieTextField.value
      }
    });
    handleResponse(response);
  } catch (error) {
    renderError(error?.message || "保存失败");
  } finally {
    setBusy(false);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "STATE_UPDATE" && message.state) {
    renderState(message.state);
  }
});

async function init() {
  quantityField.value = String(DEFAULT_QUANTITY);
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  handleResponse(response);

  tickerId = window.setInterval(() => {
    if (currentState) {
      renderState(currentState, { keepInputs: true });
    }
  }, 1000);

  window.addEventListener("unload", () => {
    if (tickerId) {
      window.clearInterval(tickerId);
    }
  });
}

function handleResponse(response) {
  if (!response?.ok) {
    renderError(response?.message || "操作失败");
    return;
  }

  renderState(response.state);
}

function renderState(state, options = {}) {
  currentState = state;
  const enabled = Boolean(state.enabled);

  summary.textContent = state.message || (enabled ? "运行中" : "等待启动");
  runBadge.textContent = enabled ? "运行中" : "停止";
  runBadge.classList.toggle("active", enabled);
  toggleButton.textContent = enabled ? "停止" : "启动";

  if (!options.keepInputs) {
    quantityField.value = String(state.quantity || DEFAULT_QUANTITY);
    cookieTextField.value = state.cookieText || "";
  }

  cropCount.textContent = String(state.cropCount || 0);
  cropName.textContent = state.cropName || state.cropSeedId || "-";
  maturesAt.textContent = withRelative(state.maturesAt);
  nextHarvestAt.textContent = withRelative(state.nextHarvestAt);
  nextStatusRefreshAt.textContent = withRelative(state.nextStatusRefreshAt);
  nextPlantAt.textContent = withRelative(state.nextPlantAt);
  lastActionAt.textContent = formatDateTime(state.lastActionAt);
  lastStatusAt.textContent = formatDateTime(state.lastStatusAt);

  if (state.lastError) {
    renderError(state.lastError);
  } else {
    clearError();
  }
}

function withRelative(value) {
  const absolute = formatDateTime(value);
  if (absolute === "-") {
    return "-";
  }

  return `${absolute} (${formatRelative(value)})`;
}

function setBusy(isBusy) {
  toggleButton.disabled = isBusy;
  refreshButton.disabled = isBusy;
  saveButton.disabled = isBusy;
}

function renderError(message) {
  errorMessage.hidden = false;
  errorMessage.textContent = message;
}

function clearError() {
  errorMessage.hidden = true;
  errorMessage.textContent = "";
}
