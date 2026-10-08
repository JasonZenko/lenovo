import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runSmoke } from "../scripts/chat-smoke.mjs";

const ORIGIN = "https://lenovodatastoragecentral.com";

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => handler(req, res, body));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function smokeAgainst(handler, env = {}) {
  const server = await serve(handler);
  try {
    const { port } = server.address();
    return await runSmoke({ AIDA_CHAT_URL: `http://127.0.0.1:${port}/api/chat`, AIDA_EMBED_ORIGIN: ORIGIN, ...env }, () => {});
  } finally {
    server.close();
  }
}

const cors = (res, origin = ORIGIN) => {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-widget-key");
};

test("passes when the chat route returns a model reply", async () => {
  const r = await smokeAgainst((req, res, body) => {
    cors(res);
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    assert.equal(req.headers.origin, ORIGIN);
    assert.match(JSON.parse(body).message, /Aida/);
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"reply":"The ThinkSystem DE4000H fits well."}');
  });
  assert.equal(r.cause, "ok");
  assert.equal(r.ok, true);
});

test("detects a Cloudflare managed challenge on the chat route", async () => {
  const r = await smokeAgainst((req, res) => {
    if (req.method === "OPTIONS") { cors(res); return res.writeHead(204).end(); }
    res.writeHead(403, { Server: "cloudflare", "cf-ray": "abc123-LHR", "cf-mitigated": "challenge" }).end("<title>Just a moment...</title>");
  });
  assert.equal(r.cause, "cloudflare-challenge");
});

test("detects a Cloudflare WAF custom rule block (1020)", async () => {
  const r = await smokeAgainst((req, res) => {
    if (req.method === "OPTIONS") { cors(res); return res.writeHead(204).end(); }
    res.writeHead(403, { Server: "cloudflare", "cf-ray": "abc123-LHR" }).end("error code: 1020");
  });
  assert.equal(r.cause, "cloudflare-1020");
});

test("detects a rejected CORS preflight", async () => {
  const r = await smokeAgainst((req, res) => {
    if (req.method === "OPTIONS") return res.writeHead(403).end("origin not allowed");
    res.writeHead(403).end("Forbidden");
  });
  assert.equal(r.cause, "cors-preflight");
});

test("detects a server-side origin allowlist that omits the embed origin", async () => {
  const r = await smokeAgainst((req, res) => {
    if (req.method === "OPTIONS") { cors(res); return res.writeHead(204).end(); }
    if (req.headers.origin === ORIGIN) return res.writeHead(403).end("Forbidden");
    res.writeHead(200).end('{"reply":"ok"}');
  });
  assert.equal(r.cause, "origin-allowlist");
});

test("detects an expired upstream model key surfaced as 403", async () => {
  const r = await smokeAgainst((req, res) => {
    if (req.method === "OPTIONS") { cors(res); return res.writeHead(204).end(); }
    res.writeHead(403, { "Content-Type": "application/json" }).end('{"error":{"message":"API key expired. Please renew the API key."}}');
  });
  assert.equal(r.cause, "upstream-auth");
});

test("flags a route mismatch", async () => {
  const r = await smokeAgainst((req, res) => {
    if (req.method === "OPTIONS") { cors(res); return res.writeHead(204).end(); }
    res.writeHead(404).end("Not Found");
  });
  assert.equal(r.cause, "route-mismatch");
});

test("fails a 2xx whose Access-Control-Allow-Origin a browser would reject", async () => {
  const r = await smokeAgainst((req, res) => {
    cors(res, "https://old-domain.example");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    res.writeHead(200).end('{"reply":"hi"}');
  });
  assert.equal(r.cause, "cors-mismatch");
});

test("sends extra widget headers without printing their values", async () => {
  const lines = [];
  const server = await serve((req, res) => {
    cors(res);
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    assert.equal(req.headers["x-widget-key"], "s3cret-value");
    res.writeHead(200).end('{"reply":"hi"}');
  });
  try {
    const { port } = server.address();
    const r = await runSmoke({
      AIDA_CHAT_URL: `http://127.0.0.1:${port}/api/chat`,
      AIDA_EMBED_ORIGIN: ORIGIN,
      AIDA_CHAT_HEADERS: '{"x-widget-key":"s3cret-value"}',
    }, (l) => lines.push(l));
    assert.equal(r.ok, true);
    assert.ok(!lines.join("\n").includes("s3cret-value"));
  } finally {
    server.close();
  }
});
