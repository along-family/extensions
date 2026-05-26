export const DEFAULT_COUNT = 5;
export const DEFAULT_WAIT_SECONDS = 8;
export const DEFAULT_CONCURRENT_TABS = 1;
export const MIN_COUNT = 1;
export const MAX_COUNT = 20;
export const MIN_WAIT_SECONDS = 3;
export const MAX_WAIT_SECONDS = 30;
export const MIN_CONCURRENT_TABS = 1;
export const MAX_CONCURRENT_TABS = 5;
export const PAGE_READY_TIMEOUT_MS = 4000;
export const STATUS_STORAGE_KEY = "taskStatus";
export const LAST_INPUT_STORAGE_KEY = "lastUsedInput";
export const DEBUG_LOGS_STORAGE_KEY = "debugLogs";

export function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function normalizePositiveInteger(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function validateUserInput({ url, count, waitSeconds, concurrentTabs }) {
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
  if (!normalizedCount || normalizedCount < MIN_COUNT || normalizedCount > MAX_COUNT) {
    return {
      ok: false,
      message: `页数必须在 ${MIN_COUNT} 到 ${MAX_COUNT} 之间。`
    };
  }

  const normalizedWaitSeconds = normalizePositiveInteger(waitSeconds);
  if (
    !normalizedWaitSeconds ||
    normalizedWaitSeconds < MIN_WAIT_SECONDS ||
    normalizedWaitSeconds > MAX_WAIT_SECONDS
  ) {
    return {
      ok: false,
      message: `等待秒数必须在 ${MIN_WAIT_SECONDS} 到 ${MAX_WAIT_SECONDS} 之间。`
    };
  }

  const normalizedConcurrentTabs =
    normalizePositiveInteger(concurrentTabs) || DEFAULT_CONCURRENT_TABS;
  if (
    normalizedConcurrentTabs < MIN_CONCURRENT_TABS ||
    normalizedConcurrentTabs > MAX_CONCURRENT_TABS
  ) {
    return {
      ok: false,
      message: `同时打开数必须在 ${MIN_CONCURRENT_TABS} 到 ${MAX_CONCURRENT_TABS} 之间。`
    };
  }

  return {
    ok: true,
    value: {
      url: parsedUrl.toString(),
      count: normalizedCount,
      waitSeconds: normalizedWaitSeconds,
      concurrentTabs: normalizedConcurrentTabs,
      currentPage: pageValue
    }
  };
}

export function buildPageUrls(inputUrl, count) {
  const parsedUrl = new URL(inputUrl);
  const currentPage = normalizePositiveInteger(parsedUrl.searchParams.get("page"));
  if (!currentPage) {
    throw new Error("URL 必须包含有效的 page 参数。");
  }

  const urls = [];
  for (let index = 0; index < count; index += 1) {
    const page = currentPage - index;
    if (page < 1) {
      break;
    }

    const nextUrl = new URL(parsedUrl.toString());
    nextUrl.searchParams.set("page", String(page));
    urls.push({
      page,
      url: nextUrl.toString()
    });
  }

  return urls;
}

export function createIdleStatus(message = "准备就绪。") {
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
