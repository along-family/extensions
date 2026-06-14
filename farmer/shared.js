export const API_ORIGIN = "https://cdk.hybgzs.com";
export const API_BASE_URL = `${API_ORIGIN}/api/farm`;
export const FARM_PAGE_URL = `${API_ORIGIN}/entertainment/farm`;
export const STORAGE_KEY = "farmHelperState";
export const SEED_ID = "starfruit";
export const DEFAULT_QUANTITY = 17;
export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = 999;

export const ALARMS = {
  status: "farm-helper-status-refresh",
  harvest: "farm-helper-harvest",
  plant: "farm-helper-plant"
};

export function createDefaultState() {
  return {
    enabled: false,
    quantity: DEFAULT_QUANTITY,
    cookieText: "",
    phase: "idle",
    message: "等待启动",
    cropCount: 0,
    cropName: "",
    cropSeedId: "",
    maturesAt: null,
    nextHarvestAt: null,
    nextStatusRefreshAt: null,
    nextPlantAt: null,
    lastActionAt: null,
    lastStatusAt: null,
    lastError: ""
  };
}

export function normalizeQuantity(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed)) {
    return null;
  }

  return Math.min(Math.max(parsed, MIN_QUANTITY), MAX_QUANTITY);
}

export function parseCookieText(cookieText) {
  const text = String(cookieText || "").trim();
  if (!text) {
    return [];
  }

  return text
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex <= 0) {
        return null;
      }

      const name = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      if (!name) {
        return null;
      }

      return { name, value };
    })
    .filter(Boolean);
}

export function formatDateTime(value) {
  if (!value) {
    return "-";
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "-";
  }

  return new Date(timestamp).toLocaleString("zh-CN", {
    hour12: false
  });
}

export function formatRelative(value) {
  if (!value) {
    return "-";
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "-";
  }

  const diffSeconds = Math.round((timestamp - Date.now()) / 1000);
  if (diffSeconds <= 0) {
    return "已到时间";
  }

  const hours = Math.floor(diffSeconds / 3600);
  const minutes = Math.floor((diffSeconds % 3600) / 60);
  const seconds = diffSeconds % 60;

  if (hours > 0) {
    return `${hours}小时${minutes}分`;
  }

  if (minutes > 0) {
    return `${minutes}分${seconds}秒`;
  }

  return `${seconds}秒`;
}
