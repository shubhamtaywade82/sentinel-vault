// vault-watchdog — background mini-service for the Sentinel Vault.
// Independent Bun project. Calls the vault's POST /api/v1/internal/watchdog
// on a schedule to keep credentials fresh while consumers are offline.

const PORT = 3030; // SPEC: fixed port, never process.env.PORT
const VAULT_ADMIN_TOKEN =
  process.env.VAULT_ADMIN_TOKEN ?? "vault-admin-demo-token-CHANGE-ME";
const VAULT_URL = process.env.VAULT_URL ?? "http://localhost:4750";
const WATCHDOG_INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS ?? 20000);
const WARMUP_MS = 3000;
const RING_MAX = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RunSummary = {
  ts: string;
  ok: boolean;
  status?: number;
  checked?: number;
  refreshed?: number;
  reauthRequired?: number;
  errors?: number;
  message?: string;
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const startedAt = Date.now();
let lastRun: string | null = null;
let lastResult: string | null = null;
let nextTickAt = Date.now() + WARMUP_MS; // updated after every tick
const runs: RunSummary[] = [];
// SECURITY (R12): overlap guard — if a tick is still in flight when the next
// interval fires, skip it. A slow upstream must not cause overlapping POSTs
// that could double-refresh the same connection. Single-instance guard; for
// multi-instance deployments use a distributed lock (documented in README).
let tickInFlight = false;
// Bounded HTTP timeout for the watchdog's call to the vault API. Prevents a
// hung upstream from blocking the scheduler indefinitely.
const FETCH_TIMEOUT_MS = Number(process.env.WATCHDOG_FETCH_TIMEOUT_MS ?? 15000);

function pushSummary(s: RunSummary): void {
  runs.push(s);
  if (runs.length > RING_MAX) runs.shift();
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

async function runWatchdogTick(): Promise<void> {
  // Overlap guard: skip if the previous tick hasn't finished.
  if (tickInFlight) {
    const ts = new Date().toISOString();
    pushSummary({ ts, ok: false, status: 0, message: "skipped: previous tick in flight" });
    lastRun = ts;
    lastResult = "skipped (overlap)";
    console.log(`[watchdog] SKIP tick — previous tick still in flight`);
    return;
  }
  tickInFlight = true;
  try {
    await runWatchdogTickInner();
  } finally {
    tickInFlight = false;
  }
}

async function runWatchdogTickInner(): Promise<void> {
  const ts = new Date().toISOString();
  const url = `${VAULT_URL}/api/v1/internal/watchdog`;
  try {
    // Bounded fetch with an AbortController so a hung vault API can't block
    // the scheduler indefinitely.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VAULT_ADMIN_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const snippet = text.replace(/\s+/g, " ").slice(0, 160);
      pushSummary({ ts, ok: false, status: res.status, message: snippet });
      lastRun = ts;
      lastResult = `failed status=${res.status}`;
      console.log(
        `[watchdog] FAILED status=${res.status} msg=${snippet || "<empty>"}`
      );
      return;
    }

    const data = (await res.json()) as {
      checked?: number;
      refreshed?: unknown;
      reauthRequired?: unknown;
      errors?: unknown;
    };
    const checked = typeof data.checked === "number" ? data.checked : 0;
    const refreshedCount = Array.isArray(data.refreshed)
      ? data.refreshed.length
      : 0;
    const reauthCount = Array.isArray(data.reauthRequired)
      ? data.reauthRequired.length
      : 0;
    const errorCount = Array.isArray(data.errors) ? data.errors.length : 0;

    pushSummary({
      ts,
      ok: true,
      status: 200,
      checked,
      refreshed: refreshedCount,
      reauthRequired: reauthCount,
      errors: errorCount,
    });
    lastRun = ts;
    lastResult = `ok checked=${checked} refreshed=${refreshedCount} reauth=${reauthCount} errors=${errorCount}`;
    console.log(
      `[watchdog] checked=${checked} refreshed=${refreshedCount} reauth=${reauthCount} errors=${errorCount}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    pushSummary({ ts, ok: false, status: 0, message: msg });
    lastRun = ts;
    lastResult = isTimeout ? `timeout (${FETCH_TIMEOUT_MS}ms)` : `error ${msg}`;
    // ECONNREFUSED / DNS / timeout / abort — do NOT crash. Retry next tick.
    console.log(
      `[watchdog] FAILED status=${isTimeout ? "TIMEOUT" : "NET"} msg=${msg}`
    );
  }
}

// Warmup at +3s, then recurring interval starting from the warmup completion.
let warmupHandle: ReturnType<typeof setTimeout> | null = null;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

function startScheduler(): void {
  nextTickAt = Date.now() + WARMUP_MS;
  warmupHandle = setTimeout(async () => {
    await runWatchdogTick();
    nextTickAt = Date.now() + WATCHDOG_INTERVAL_MS;
    intervalHandle = setInterval(async () => {
      await runWatchdogTick();
      nextTickAt = Date.now() + WATCHDOG_INTERVAL_MS;
    }, WATCHDOG_INTERVAL_MS);
  }, WARMUP_MS);
}

function stopScheduler(): void {
  if (warmupHandle) {
    clearTimeout(warmupHandle);
    warmupHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

// ---------------------------------------------------------------------------
// HTTP server (Bun.serve)
// ---------------------------------------------------------------------------

function buildHealthJson(): string {
  const uptimeSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const body = {
    service: "vault-watchdog",
    status: "alive",
    port: PORT,
    uptimeSec,
    lastRun,
    lastResult,
    // extra (not required by spec, useful for the dashboard's live countdown):
    nextTickAt: new Date(nextTickAt).toISOString(),
    intervalMs: WATCHDOG_INTERVAL_MS,
    vaultUrl: VAULT_URL,
    runsBuffered: runs.length,
  };
  return JSON.stringify(body);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderStatusPage(): string {
  const uptimeSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const last10 = runs.slice(-10).reverse();

  const rows = last10
    .map((r) => {
      const statusColor = r.ok ? "#34d399" : "#fb7185";
      const statusText = r.ok ? "OK" : "FAIL";
      const detail = r.ok
        ? `checked=${r.checked ?? 0} · refreshed=${r.refreshed ?? 0} · reauth=${r.reauthRequired ?? 0} · errors=${r.errors ?? 0}`
        : `status=${r.status ?? 0} · ${escapeHtml(r.message ?? "")}`;
      const time = r.ts.slice(11, 19); // HH:MM:SS
      return `<tr>
        <td><span class="dot" style="background:${statusColor}"></span></td>
        <td class="ts">${time}</td>
        <td><span class="pill" style="color:${statusColor};border-color:${statusColor}">${statusText}</span></td>
        <td class="detail">${detail}</td>
      </tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>🛡️ Sentinel Vault Watchdog</title>
<style>
  :root {
    --bg: #0a0b0f;
    --panel: #111319;
    --panel-2: #161922;
    --border: #232838;
    --text: #e4e7ee;
    --muted: #8b93a7;
    --accent: #34d399;
    --warn: #fbbf24;
    --err: #fb7185;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
  body {
    font-family: var(--mono);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    padding: 24px;
    gap: 18px;
  }
  h1 {
    font-size: 22px;
    margin: 0;
    letter-spacing: 0.2px;
  }
  .sub {
    color: var(--muted);
    font-size: 12px;
    margin-top: 2px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
  }
  .card .k {
    color: var(--muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .card .v {
    margin-top: 6px;
    font-size: 16px;
    word-break: break-word;
  }
  .card .v.big { font-size: 22px; }
  .pill {
    display: inline-block;
    padding: 2px 8px;
    border: 1px solid;
    border-radius: 999px;
    font-size: 12px;
  }
  .alive { color: var(--accent); border-color: var(--accent); }
  .section {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px 18px;
  }
  .section h2 {
    margin: 0 0 12px 0;
    font-size: 13px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-weight: 600;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th, td {
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  th {
    color: var(--muted);
    font-weight: 500;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  tr:last-child td { border-bottom: none; }
  .ts { color: var(--muted); white-space: nowrap; }
  .detail { color: var(--text); }
  .dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    box-shadow: 0 0 8px currentColor;
  }
  .empty { color: var(--muted); font-size: 13px; padding: 8px 0; }
  .countdown { color: var(--accent); font-variant-numeric: tabular-nums; }
  footer {
    margin-top: auto;
    color: var(--muted);
    font-size: 11px;
    padding-top: 6px;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <header>
    <h1>🛡️ Sentinel Vault Watchdog</h1>
    <div class="sub">Background credential-refresh sidecar · port ${PORT} · → ${escapeHtml(VAULT_URL)}</div>
  </header>

  <section class="grid">
    <div class="card">
      <div class="k">Status</div>
      <div class="v"><span class="pill alive">alive</span></div>
    </div>
    <div class="card">
      <div class="k">Uptime</div>
      <div class="v big" id="uptime">${uptimeSec}s</div>
    </div>
    <div class="card">
      <div class="k">Next tick in</div>
      <div class="v big countdown" id="countdown">—</div>
    </div>
    <div class="card">
      <div class="k">Interval</div>
      <div class="v">${WATCHDOG_INTERVAL_MS / 1000}s · warmup ${WARMUP_MS / 1000}s</div>
    </div>
    <div class="card">
      <div class="k">Last run</div>
      <div class="v" id="lastRun">${lastRun ? escapeHtml(lastRun) : "—"}</div>
    </div>
    <div class="card">
      <div class="k">Last result</div>
      <div class="v" id="lastResult">${lastResult ? escapeHtml(lastResult) : "—"}</div>
    </div>
  </section>

  <section class="section">
    <h2>Recent run summaries <span style="color:var(--muted);font-weight:400;text-transform:none;letter-spacing:0">(last 10 · in-memory ring buffer)</span></h2>
    ${
      last10.length === 0
        ? `<div class="empty">No ticks yet — warmup fires ${WARMUP_MS / 1000}s after start.</div>`
        : `<table>
      <thead>
        <tr><th></th><th>Time</th><th>Outcome</th><th>Detail</th></tr>
      </thead>
      <tbody id="logBody">
        ${rows}
      </tbody>
    </table>`
    }
  </section>

  <footer>
    <code>GET /health</code> · <code>GET /</code> (this page) · SIGINT/SIGTERM = graceful shutdown ·
    target: <code>POST ${escapeHtml(VAULT_URL)}/api/v1/internal/watchdog</code>
  </footer>

<script>
  // Live countdown + recent-runs refetch. Keeps the page fresh without reloads.
  const healthUrl = "/health";
  async function refresh() {
    try {
      const r = await fetch(healthUrl, { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      const up = j.uptimeSec ?? 0;
      const upEl = document.getElementById("uptime");
      if (upEl) upEl.textContent = up + "s";
      const lr = document.getElementById("lastRun");
      if (lr) lr.textContent = j.lastRun ?? "—";
      const lres = document.getElementById("lastResult");
      if (lres) lres.textContent = j.lastResult ?? "—";
      if (j.nextTickAt) {
        const target = new Date(j.nextTickAt).getTime();
        const cd = document.getElementById("countdown");
        if (cd) {
          const tick = () => {
            const ms = target - Date.now();
            if (ms <= 0) { cd.textContent = "due"; cd.style.color = "var(--warn)"; return; }
            const s = Math.ceil(ms / 1000);
            cd.textContent = s + "s";
          };
          tick();
          if (!window.__cd) window.__cd = setInterval(tick, 1000);
        }
      }
    } catch (_) { /* ignore transient fetch errors */ }
  }
  refresh();
  setInterval(refresh, 2000);
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return new Response(buildHealthJson(), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(renderStatusPage(), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return new Response(
      JSON.stringify({ error: "not_found", path: url.pathname }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  },
});

startScheduler();

console.log(
  `🛡️  vault-watchdog listening on :${PORT}  →  ${VAULT_URL}  (interval=${WATCHDOG_INTERVAL_MS}ms warmup=${WARMUP_MS}ms)`
);

function shutdown(reason: string): void {
  console.log(`[watchdog] shutdown (${reason})`);
  stopScheduler();
  try {
    server.stop(true); // stop immediately
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
