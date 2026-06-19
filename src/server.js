const express = require("express");
const pkg = require("../package.json");

const app = express();
const port = Number(process.env.PORT || 3020);
const sharedSecret = process.env.SHARED_SECRET;

app.use(express.json({ limit: "1mb" }));

function requireSharedSecret(req, res, next) {
  if (!sharedSecret) {
    return next();
  }

  if (req.get("x-sms-secret") !== sharedSecret) {
    return res.status(401).json({
      ok: false,
      status: "unauthorized",
      error: "Invalid or missing webhook secret"
    });
  }

  return next();
}

function summarizePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      type: Array.isArray(payload) ? "array" : typeof payload,
      keys: [],
      sizeBytes: Buffer.byteLength(JSON.stringify(payload ?? null))
    };
  }

  const serialized = JSON.stringify(payload);

  return {
    type: "object",
    keys: Object.keys(payload).slice(0, 20),
    sizeBytes: Buffer.byteLength(serialized)
  };
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    status: "healthy"
  });
});

app.get("/api/version", (_req, res) => {
  res.json({
    ok: true,
    app: pkg.name,
    version: pkg.version,
    build: {
      sha: process.env.GITHUB_SHA || process.env.BUILD_SHA || null,
      date: process.env.BUILD_DATE || null
    }
  });
});

app.post("/webhook/test", requireSharedSecret, (req, res) => {
  const summary = summarizePayload(req.body);

  console.log(
    JSON.stringify({
      event: "webhook.test.received",
      receivedAt: new Date().toISOString(),
      summary
    })
  );

  res.json({
    ok: true,
    status: "received",
    summary
  });
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    status: "not_found",
    error: `No route for ${req.method} ${req.path}`
  });
});

app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({
      ok: false,
      status: "bad_request",
      error: "Invalid JSON body"
    });
  }

  if (err && err.type === "entity.too.large") {
    return res.status(413).json({
      ok: false,
      status: "payload_too_large",
      error: "JSON body exceeds the 1mb limit"
    });
  }

  console.error(err);

  return res.status(500).json({
    ok: false,
    status: "error",
    error: "Internal server error"
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`sms-gateway listening on port ${port}`);
});
