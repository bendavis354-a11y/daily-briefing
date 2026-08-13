// Shared HTTP helper for every Google API call in the pipeline.
//
// Two failure modes this guards against:
//   1. A blocked or blackholed connection hanging the run — every request gets a
//      hard timeout so a genuine failure reports itself instead of stalling.
//   2. Transient proxy failures. The sandbox routes outbound HTTPS through an
//      agent proxy that intermittently answers `503 DNS resolution failure` when
//      several fresh connections open at once (the metadata fan-out does exactly
//      that). The host is reachable; the same request succeeds on retry.
const FETCH_TIMEOUT_MS = 30000;
const RETRIES = 4;
const BACKOFF_MS = 400;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function fetchWithRetry(url, options = {}) {
  let lastError;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_MS * 2 ** (attempt - 1));

    let res;
    try {
      res = await fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      lastError = err;
      continue;
    }

    if (res.ok || !RETRYABLE_STATUS.has(res.status)) return res;

    // Read the body so the error surfaced after the last attempt carries the
    // proxy's or Google's own explanation.
    lastError = new Error(`${res.status} ${await res.text()}`);
  }

  throw lastError;
}
