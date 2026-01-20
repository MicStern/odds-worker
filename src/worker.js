function jsonResponse(obj, status = 200, origin = "*") {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

function corsPreflight(origin = "*") {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

function randomId(len = 12) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  for (let i = 0; i < len; i++) out += chars[arr[i] % chars.length];
  return out;
}

function clampStr(s, maxLen) {
  const t = String(s || "").trim();
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

function isInt(n) {
  return Number.isInteger(n) && Number.isFinite(n);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";

    if (request.method === "OPTIONS") return corsPreflight(origin);

    try {
      // POST /api/create
      if (request.method === "POST" && url.pathname === "/api/create") {
        const body = await request.json().catch(() => null);
        if (!body) return jsonResponse({ error: "Invalid JSON" }, 400, origin);

        const maxX = Number(body.maxX);
        const challenge = clampStr(body.challenge, 500);
        const report = clampStr(body.report, 2000);

        if (!isInt(maxX) || maxX < 1 || maxX > 1000000) {
          return jsonResponse({ error: "maxX must be an integer between 1 and 1000000" }, 400, origin);
        }
        if (!challenge || !report) {
          return jsonResponse({ error: "challenge and report are required" }, 400, origin);
        }

        const sessionId = randomId(14);

        const record = {
          sessionId,
          maxX,
          challenge,
          report,
          locked: false,
          pick: null,
          createdAt: Date.now()
        };

        // TTL: e.g. 7 days
        const ttlSeconds = 7 * 24 * 60 * 60;

        await env.ODDS.put(`session:${sessionId}`, JSON.stringify(record), {
          expirationTtl: ttlSeconds
        });

        return jsonResponse({ sessionId }, 200, origin);
      }

      // GET /api/session/:id
      if (request.method === "GET" && url.pathname.startsWith("/api/session/")) {
        const parts = url.pathname.split("/").filter(Boolean);
        // ["api","session",":id"]
        if (parts.length !== 3) return jsonResponse({ error: "Bad request" }, 400, origin);

        const sessionId = parts[2];
        const raw = await env.ODDS.get(`session:${sessionId}`);
        if (!raw) return jsonResponse({ error: "Not found" }, 404, origin);

        const rec = JSON.parse(raw);

        // Do not leak pick if you want it secret until later.
        // Currently returning locked status only.
        return jsonResponse({
          sessionId: rec.sessionId,
          maxX: rec.maxX,
          challenge: rec.challenge,
          report: rec.report,
          locked: !!rec.locked
        }, 200, origin);
      }

      // POST /api/session/:id/submit
      if (request.method === "POST" && url.pathname.startsWith("/api/session/") && url.pathname.endsWith("/submit")) {
        const parts = url.pathname.split("/").filter(Boolean);
        // ["api","session",":id","submit"]
        if (parts.length !== 4) return jsonResponse({ error: "Bad request" }, 400, origin);

        const sessionId = parts[2];
        const raw = await env.ODDS.get(`session:${sessionId}`);
        if (!raw) return jsonResponse({ error: "Not found" }, 404, origin);

        const rec = JSON.parse(raw);
        if (rec.locked) return jsonResponse({ error: "locked" }, 409, origin);

        const body = await request.json().catch(() => null);
        if (!body) return jsonResponse({ error: "Invalid JSON" }, 400, origin);

        const pick = Number(body.pick);
        if (!isInt(pick) || pick < 1 || pick > rec.maxX) {
          return jsonResponse({ error: `pick must be an integer between 1 and ${rec.maxX}` }, 400, origin);
        }

        // Lock and store pick
        rec.pick = pick;
        rec.locked = true;
        rec.lockedAt = Date.now();

        // Keep same remaining TTL: easiest is re-put without TTL (KV will persist).
        // Better: preserve TTL roughly, but for simplicity we set a fixed TTL from now.
        const ttlSeconds = 7 * 24 * 60 * 60;
        await env.ODDS.put(`session:${sessionId}`, JSON.stringify(rec), {
          expirationTtl: ttlSeconds
        });

        return jsonResponse({ ok: true, pick }, 200, origin);
      }

      return jsonResponse({ error: "Not found" }, 404, origin);

    } catch (e) {
      return jsonResponse({ error: "Server error", detail: String(e.message || e) }, 500, origin);
    }
  }
};
