export const DEFAULT_COUNT = 5;
export const DEFAULT_WAIT_SECONDS = 8;
export const MIN_COUNT = 1;
export const MAX_COUNT = 20;
export const MIN_WAIT_SECONDS = 3;
export const MAX_WAIT_SECONDS = 30;
export const PAGE_LOAD_TIMEOUT_MS = 30000;
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

export function validateUserInput({ url, count, waitSeconds }) {
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
  if (!normalizedCount || normalizedCount < MIN_COUNT || normalizedCount > MAX_COUNT) {
    return {
      ok: false,
      message: `Pages must be between ${MIN_COUNT} and ${MAX_COUNT}.`
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
      message: `Wait seconds must be between ${MIN_WAIT_SECONDS} and ${MAX_WAIT_SECONDS}.`
    };
  }

  return {
    ok: true,
    value: {
      url: parsedUrl.toString(),
      count: normalizedCount,
      waitSeconds: normalizedWaitSeconds,
      currentPage: pageValue
    }
  };
}

export function buildPageUrls(inputUrl, count) {
  const parsedUrl = new URL(inputUrl);
  const currentPage = normalizePositiveInteger(parsedUrl.searchParams.get("page"));
  if (!currentPage) {
    throw new Error("The URL must contain a valid page parameter.");
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

export function createIdleStatus(message = "Ready.") {
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
