const crypto = require("crypto");

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

function serializeError(error) {
  if (!error) {
    return null;
  }

  return {
    message: error.message,
    code: error.code,
    status:
      error.statusCode || error.status || error.response?.status || undefined,
    errors: Array.isArray(error.errors)
      ? error.errors.map((entry) => ({
          message: entry?.message,
          reason: entry?.reason,
        }))
      : undefined,
  };
}

function sanitizeValue(value) {
  if (value === undefined) {
    return undefined;
  }

  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 497)}...` : value;
  }

  if (value instanceof Error) {
    return serializeError(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (typeof value === "object") {
    const sanitized = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      const cleanValue = sanitizeValue(nestedValue);
      if (cleanValue !== undefined) {
        sanitized[key] = cleanValue;
      }
    }
    return sanitized;
  }

  return String(value);
}

function writeLog(level, event, meta = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitizeValue(meta),
  };
  const line = JSON.stringify(payload);

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

function logInfo(event, meta) {
  writeLog("info", event, meta);
}

function logWarn(event, meta) {
  writeLog("warn", event, meta);
}

function logError(event, meta) {
  writeLog("error", event, meta);
}

function getRequestLogContext(req, extra = {}) {
  return {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    userId: req.session?.user?.email || req.session?.id,
    ...sanitizeValue(extra),
  };
}

function requestContextMiddleware(req, res, next) {
  const requestId = req.get("x-request-id") || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  const startedAt = Date.now();
  logInfo("http.request.start", getRequestLogContext(req));

  res.on("finish", () => {
    logInfo(
      "http.request.finish",
      getRequestLogContext(req, {
        durationMs: Date.now() - startedAt,
        statusCode: res.statusCode,
      }),
    );
  });

  next();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorStatus(error) {
  return error?.statusCode || error?.status || error?.response?.status;
}

function isRetryableError(error) {
  const status = getErrorStatus(error);
  if (status && RETRYABLE_STATUS_CODES.has(status)) {
    return true;
  }

  if (error?.code && RETRYABLE_ERROR_CODES.has(error.code)) {
    return true;
  }

  const message = error?.message?.toLowerCase?.() || "";
  return (
    message.includes("rate limit") ||
    message.includes("timeout") ||
    message.includes("temporar") ||
    message.includes("socket hang up")
  );
}

async function retryAsync(operation, options = {}) {
  const {
    label = "operation",
    attempts = 3,
    baseDelayMs = 300,
    factor = 2,
    maxDelayMs = 4000,
    shouldRetry = isRetryableError,
    context = {},
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error)) {
        throw error;
      }

      const delayMs = Math.min(
        maxDelayMs,
        Math.round(baseDelayMs * factor ** (attempt - 1) + Math.random() * 100),
      );

      logWarn("retry.scheduled", {
        label,
        attempt,
        attempts,
        delayMs,
        ...sanitizeValue(context),
        error: serializeError(error),
      });

      await sleep(delayMs);
    }
  }

  throw lastError;
}

module.exports = {
  getRequestLogContext,
  isRetryableError,
  logError,
  logInfo,
  logWarn,
  requestContextMiddleware,
  retryAsync,
  serializeError,
};
