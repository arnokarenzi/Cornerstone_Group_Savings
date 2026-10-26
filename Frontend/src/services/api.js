import axios from "axios";

// Set VITE_API_BASE_URL in each deployment (for example, https://api.example.com/api).
// The localhost fallback is for local development only.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000/api";

const API = axios.create({
  baseURL: API_BASE_URL.replace(/\/$/, ""),
  timeout: 20000,
  withCredentials: true,
  headers: { Accept: "application/json" },
});

// Authentication is carried by an HttpOnly cookie. JavaScript deliberately does
// not read or persist the session credential. Production deployments reject legacy
// bearer-token auth; it remains available only for local development/testing.

// All write requests receive a global, dismissible tick/cross message. The server
// sends success only after its database transaction commits, so a green message is
// a confirmation of persistence rather than merely of button submission.
function isWriteRequest(config) {
  return ["post", "put", "patch", "delete"].includes(String(config?.method || "get").toLowerCase());
}
function isAuthRequest(config) {
  return String(config?.url || "").includes("/auth/");
}
function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function shortSignature(value) {
  // Small deterministic fingerprint used only to locate the random idempotency
  // key in sessionStorage; the server computes the authoritative SHA-256 hash.
  let hash1 = 0x811c9dc5;
  let hash2 = 0x01000193;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    hash1 = Math.imul(hash1 ^ code, 0x01000193) >>> 0;
    hash2 = Math.imul(hash2 ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${hash1.toString(16)}${hash2.toString(16)}`;
}
function getIdempotencyUserScope() {
  if (typeof window === "undefined") return "server";
  try {
    const user = JSON.parse(window.sessionStorage.getItem("cornestone_user") || "null");
    const groupId = user?.groupId ?? user?.group_id ?? "unknown-group";
    const userId = user?.id ?? "unknown-user";
    return `${groupId}:${userId}`;
  } catch {
    return "unknown-session";
  }
}
function getOrCreateIdempotencyKey(config) {
  if (typeof window === "undefined" || isAuthRequest(config) || !isWriteRequest(config)) return null;
  const signature = stableValue({
    userScope: getIdempotencyUserScope(),
    method: String(config.method || "post").toLowerCase(),
    url: String(config.url || ""),
    params: config.params || {},
    data: config.data || {},
  });
  const storageKey = `cornestone:idempotency:${shortSignature(signature)}`;
  try {
    let key = window.sessionStorage.getItem(storageKey);
    if (!key) {
      key = typeof window.crypto?.randomUUID === "function"
        ? window.crypto.randomUUID()
        : `cs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
      window.sessionStorage.setItem(storageKey, key);
    }
    config._cornestoneIdempotencyStorageKey = storageKey;
    return key;
  } catch {
    // If sessionStorage is unavailable, this request remains functional, but its
    // outcome cannot be safely retried automatically by the client.
    return typeof window.crypto?.randomUUID === "function" ? window.crypto.randomUUID() : null;
  }
}
function clearIdempotencyKey(config) {
  const storageKey = config?._cornestoneIdempotencyStorageKey;
  if (!storageKey || typeof window === "undefined") return;
  try { window.sessionStorage.removeItem(storageKey); } catch { /* sessionStorage may be disabled */ }
}
function dispatchRecordFeedback(type, message) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("cornestone:record-feedback", {
    detail: { type, message: String(message || (type === "success" ? "Record saved successfully." : "The record could not be saved.")) },
  }));
}

// Financial mutation retries reuse the same random idempotency key while an
// identical action is pending or its network outcome is unknown. The server uses
// its own cryptographic request hash and database uniqueness constraint.
API.interceptors.request.use((config) => {
  const key = getOrCreateIdempotencyKey(config);
  if (key) {
    if (config.headers?.set) config.headers.set("Idempotency-Key", key);
    else config.headers = { ...(config.headers || {}), "Idempotency-Key": key };
  }
  return config;
});

// Expired/disabled sessions are cleared consistently instead of leaving the UI
// in a logged-in state that can no longer call the API. Login failures stay on the login form.
API.interceptors.response.use(
  (response) => {
    const { config, data } = response;
    clearIdempotencyKey(config);
    if (isWriteRequest(config) && !isAuthRequest(config) && !config?.suppressRecordFeedback) {
      if (data?.success === false) dispatchRecordFeedback("error", data.message || "The server did not save this record.");
      else dispatchRecordFeedback("success", data?.message || "Record saved successfully in the database.");
    }
    return response;
  },
  (error) => {
    const status = error?.response?.status;
    // Keep a key for no-response/5xx and for explicit idempotency-fence conflicts:
    // the database may already have accepted the financial action. The backend
    // deletes a newly reserved key for ordinary 4xx business/validation errors,
    // so those deterministic rejections can be retried after correcting the issue.
    const responseCode = String(error?.response?.data?.code || "");
    const uncertainIdempotencyCodes = new Set([
      "IDEMPOTENCY_KEY_SCOPE_CONFLICT",
      "IDEMPOTENCY_KEY_PAYLOAD_CONFLICT",
      "IDEMPOTENCY_RESULT_UNAVAILABLE",
      "IDEMPOTENCY_OUTCOME_UNCERTAIN",
    ]);
    if (status && status < 500 && !uncertainIdempotencyCodes.has(responseCode)) clearIdempotencyKey(error?.config);
    const url = String(error?.config?.url || "");
    const isLoginEndpoint = url.includes("/auth/login");
    if (isWriteRequest(error?.config) && !isAuthRequest(error?.config) && !error?.config?.suppressRecordFeedback && error?.code !== "ERR_CANCELED") {
      dispatchRecordFeedback(error?.response ? "error" : "warning", error?.response?.data?.message || (error?.response
        ? `The record was not saved (HTTP ${status || "error"}).`
        : "The server could not be reached. The save status is unknown; check the current records before retrying to avoid a duplicate."));
    }
    if (status === 401 && !isLoginEndpoint) {
      sessionStorage.removeItem("cornestone_token");
      sessionStorage.removeItem("cornestone_user");
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("cornestone:session-expired"));
    }
    return Promise.reject(error);
  },
);

export default API;
