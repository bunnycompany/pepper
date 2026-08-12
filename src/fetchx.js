import { log } from './log.js';

const UA = 'pepper-mnn/0.1 (+https://github.com/bunnycompany/pepper)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fetch a URL as text. Returns null on ANY failure (bad status, timeout,
// network error). One retry with a short pause. Never throws.
export async function fetchText(url, { timeoutMs = 15000 } = {}) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'user-agent': UA,
          accept: 'application/rss+xml, application/atom+xml, application/json, text/xml, */*',
        },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (e) {
      if (attempt === 2) {
        log.warn('fetch failed:', String(url).slice(0, 120), '-', e?.message || String(e));
        return null;
      }
      await sleep(300);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// Fetch a URL and parse it as JSON. Returns null on any failure. Never throws.
export async function fetchJSON(url, opts) {
  const text = await fetchText(url, opts);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
