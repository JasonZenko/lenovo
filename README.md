# Lenovo "Aida" assistant

Brand assets for the Aida assistant on Lenovo Data Storage Central, plus an
end-to-end smoke test for the chat path.

The Aida widget, proxy/worker and model backend are **not** in this repository.

## Chat-path smoke test

`scripts/chat-smoke.mjs` sends a real chat message the way the embedded widget
does: a CORS preflight, then a JSON POST with the embed page's `Origin` and
`Referer`. A passing `/health` endpoint does not mean this passes. On failure it
reports which layer rejected the request:

| Cause | Meaning |
| --- | --- |
| `cloudflare-challenge` | Bot Fight Mode / Managed Challenge on the chat route |
| `cloudflare-10xx` | Cloudflare edge block (1020 = custom WAF rule, 1010 = Browser Integrity Check) |
| `cors-preflight` / `cors-mismatch` | Embed origin not allowed by the chat host |
| `origin-allowlist` | Works without `Origin`, 403 with the embed origin |
| `upstream-auth` | 403 body mentions an expired/invalid key or token |
| `route-mismatch` | 404/405: the widget calls a route the backend no longer serves |
| `empty-reply` | 2xx but no model output |

Requires Node 18+ and no dependencies.

```bash
AIDA_CHAT_URL="https://<chat-host>/<chat-route>" \
AIDA_EMBED_ORIGIN="https://lenovodatastoragecentral.com" \
npm run smoke:chat
```

Optional: `AIDA_CHAT_BODY` (JSON body, `{{message}}` is substituted; default
`{"message":"{{message}}"}`) and `AIDA_CHAT_HEADERS` (JSON object of extra headers
the widget sends; values are never printed). Exit code is 0 on pass, 1 on a
failed chat request, 2 on a configuration error.

`npm test` runs the smoke test against local mock servers that reproduce each
403 cause above.

## Verifying the live embed

1. Open the page hosting the widget in a private window, open DevTools > Network,
   filter on Fetch/XHR, and send Aida a message.
2. Click the request that carries the message. Copy its **Request URL**, the
   request payload shape, and any non-cookie custom headers.
3. Run the smoke test with those values (`AIDA_CHAT_URL`, `AIDA_CHAT_BODY`,
   `AIDA_CHAT_HEADERS`). It should print `RESULT: PASS`.
4. In the browser, confirm the reply renders and the Console shows no CORS errors.
