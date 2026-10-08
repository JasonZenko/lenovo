#!/usr/bin/env node
// End-to-end smoke test for the Aida chat path.
// Sends a real chat message the way the embedded widget does (browser-like
// Origin/Referer, CORS preflight, JSON POST) and, on failure, reports which
// layer rejected it. A passing health endpoint does not imply this passes.
//
// Usage:
//   AIDA_CHAT_URL=https://<chat-host>/<chat-route> node scripts/chat-smoke.mjs
//
// Env:
//   AIDA_CHAT_URL      required  exact URL the widget POSTs chat messages to
//   AIDA_EMBED_ORIGIN  optional  page origin hosting the widget
//                                (default https://lenovodatastoragecentral.com)
//   AIDA_CHAT_BODY     optional  JSON request body; "{{message}}" is replaced
//                                (default {"message":"{{message}}"})
//   AIDA_CHAT_HEADERS  optional  JSON object of extra headers the widget sends
//                                (e.g. a public widget key). Values are never printed.
//   AIDA_CHAT_MESSAGE  optional  test prompt
//   AIDA_TIMEOUT_MS    optional  per-request timeout (default 30000)

import { pathToFileURL } from "node:url";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

export function classify({ status, headers, body, preflight, noOriginStatus }) {
  const h = (name) => (headers?.get?.(name) ?? "").toLowerCase();
  const text = (body ?? "").slice(0, 4000);
  const lower = text.toLowerCase();
  const viaCloudflare = h("server").includes("cloudflare") || h("cf-ray") !== "";

  if (status >= 200 && status < 300) {
    if (!text.trim()) return { ok: false, cause: "empty-reply", detail: "2xx but empty body: backend accepted the request but the model returned nothing." };
    return { ok: true, cause: "ok", detail: "Chat request succeeded." };
  }

  if (status === 403) {
    if (h("cf-mitigated") === "challenge" || /just a moment|cf-chl|challenge-platform|attention required/.test(lower)) {
      return { ok: false, cause: "cloudflare-challenge", detail: "Cloudflare Bot Fight / Managed Challenge / WAF challenge is intercepting the chat route. Fix: add a WAF skip rule (or exclude the route from Bot Fight Mode / Super Bot Fight Mode) for the chat path in the Cloudflare dashboard." };
    }
    const cfCode = lower.match(/error code:?\s*(10\d\d)/)?.[1];
    if (viaCloudflare && cfCode) {
      const why = {
        "1006": "IP banned by zone settings",
        "1007": "IP banned by zone settings",
        "1008": "IP banned by zone settings",
        "1009": "country blocked",
        "1010": "Browser Integrity Check rejected the client signature",
        "1012": "access denied by zone",
        "1020": "a custom WAF / firewall rule blocked the request",
      }[cfCode] ?? "Cloudflare edge block";
      return { ok: false, cause: `cloudflare-${cfCode}`, detail: `Cloudflare error ${cfCode}: ${why}. Check Security > Events in the Cloudflare dashboard for the Ray ID ${headers.get("cf-ray") ?? "(none)"}.` };
    }
    if (preflight && preflight.status >= 400) {
      return { ok: false, cause: "cors-preflight", detail: `CORS preflight (OPTIONS) returned ${preflight.status}. The chat host does not accept the embed origin. Add the origin to the allowlist and make OPTIONS return 2xx with Access-Control-Allow-* headers.` };
    }
    if (noOriginStatus !== undefined && noOriginStatus >= 200 && noOriginStatus < 300) {
      return { ok: false, cause: "origin-allowlist", detail: "Same request succeeds without an Origin header but fails with the embed origin: the server-side origin allowlist is missing this origin." };
    }
    if (/invalid.{0,20}(api.?key|token)|api key|expired|unauthori[sz]ed|permission|not allowed|forbidden.{0,40}(key|token|project)|quota|billing|organization/.test(lower)) {
      return { ok: false, cause: "upstream-auth", detail: "403 body mentions a key/token/permission problem: likely an expired, revoked or under-scoped API key between the proxy and the model provider, or a widget token the proxy no longer accepts." };
    }
    return { ok: false, cause: "forbidden-unknown", detail: "403 without a recognisable signature. Compare the body/headers below with the host's access logs." };
  }

  if (status === 401) return { ok: false, cause: "unauthorized", detail: "401: missing or rejected credentials on the chat route." };
  if (status === 404 || status === 405) return { ok: false, cause: "route-mismatch", detail: `${status}: the widget is calling a route/method the backend does not serve.` };
  if (status === 429) return { ok: false, cause: "rate-limited", detail: "429: rate limited by edge or model provider." };
  return { ok: false, cause: `http-${status}`, detail: `Unexpected HTTP ${status}.` };
}

const redact = (obj) => Object.fromEntries(Object.keys(obj).map((k) => [k, "[redacted]"]));

async function timedFetch(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, redirect: "manual" });
  } finally {
    clearTimeout(t);
  }
}

export async function runSmoke(env = process.env, log = console.log) {
  const url = env.AIDA_CHAT_URL;
  if (!url) throw new Error("AIDA_CHAT_URL is required (the exact URL the widget POSTs chat messages to).");
  const origin = env.AIDA_EMBED_ORIGIN ?? "https://lenovodatastoragecentral.com";
  const message = env.AIDA_CHAT_MESSAGE ?? "Hi Aida, which Lenovo storage would suit a 50TB virtualisation workload?";
  const bodyTemplate = env.AIDA_CHAT_BODY ?? '{"message":"{{message}}"}';
  const extraHeaders = env.AIDA_CHAT_HEADERS ? JSON.parse(env.AIDA_CHAT_HEADERS) : {};
  const timeoutMs = Number(env.AIDA_TIMEOUT_MS ?? 30000);
  const body = bodyTemplate.replaceAll("{{message}}", JSON.stringify(message).slice(1, -1));

  log(`chat URL:     ${url}`);
  log(`embed origin: ${origin}`);
  if (Object.keys(extraHeaders).length) log(`extra headers: ${JSON.stringify(redact(extraHeaders))}`);

  const preflight = await timedFetch(url, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": ["content-type", ...Object.keys(extraHeaders)].join(",").toLowerCase(),
      "User-Agent": BROWSER_UA,
    },
  }, timeoutMs);
  const acao = preflight.headers.get("access-control-allow-origin");
  log(`preflight:    ${preflight.status} allow-origin=${acao ?? "(missing)"}`);

  const baseHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream, */*",
    "User-Agent": BROWSER_UA,
    ...extraHeaders,
  };
  const res = await timedFetch(url, {
    method: "POST",
    headers: { ...baseHeaders, Origin: origin, Referer: `${origin}/` },
    body,
  }, timeoutMs);
  const text = await res.text();
  log(`chat POST:    ${res.status} server=${res.headers.get("server") ?? "-"} cf-ray=${res.headers.get("cf-ray") ?? "-"} cf-mitigated=${res.headers.get("cf-mitigated") ?? "-"}`);

  let noOriginStatus;
  if (res.status === 403) {
    const bare = await timedFetch(url, { method: "POST", headers: baseHeaders, body }, timeoutMs);
    noOriginStatus = bare.status;
    log(`no-Origin POST: ${noOriginStatus}`);
  }

  const result = classify({ status: res.status, headers: res.headers, body: text, preflight, noOriginStatus });
  if (result.ok && acao && acao !== "*" && acao !== origin) {
    result.ok = false;
    result.cause = "cors-mismatch";
    result.detail = `Server replied but Access-Control-Allow-Origin is "${acao}", not "${origin}"; a browser would block the reply.`;
  }
  log(`body (first 500 chars): ${text.slice(0, 500).replace(/\s+/g, " ")}`);
  log(`\nRESULT: ${result.ok ? "PASS" : "FAIL"} [${result.cause}] ${result.detail}`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runSmoke().then(
    (r) => process.exit(r.ok ? 0 : 1),
    (e) => {
      console.error(`ERROR: ${e.message}`);
      process.exit(2);
    },
  );
}
