// Network Universe, ported from Lamprey Deck.
(() => {
  "use strict";
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const humanBytes = (n) => {
    const u = ["B", "KiB", "MiB", "GiB", "TiB"];
    let v = Number(n) || 0, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
  };
  const backendRequest = (path, method = "GET", body) =>
    window.orqella.call("backend.request", body === undefined ? { method, path } : { method, path, body });
  let toastTimer = null;
  function toast(title, detail, tone = "") {
    let el = document.getElementById("nuToast");
    if (!el) {
      el = document.createElement("div");
      el.id = "nuToast";
      el.className = "nu-toast";
      document.body.appendChild(el);
    }
    el.className = `nu-toast ${tone}`;
    el.innerHTML = `<b>${esc(title)}</b>${detail ? `<span>${esc(detail)}</span>` : ""}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
  }
  async function copyText(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    // Sandboxed module frames usually deny the async clipboard API. Fall back
    // to a temporary textarea so Copy still works from a click.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;left:-10000px;top:0;opacity:0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    area.remove();
    return ok;
  }

  function networkVisible() {
    const section = document.getElementById("networkUniverse");
    if (!section || section.hidden || document.hidden) return false;
    const rect = section.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight + 80;
  }

// ---------------------------------------------------------------------------
// network universe
// ---------------------------------------------------------------------------
const net = {
  data: null,
  local: false,
  paused: false,
  loading: false,
  everLoaded: false,
  selected: null,
  selId: "",
  ai: null,
  aiTimer: null,
  hover: null,
  pinnedProc: "",
  labelHits: [],
  nodes: [],
  links: [],
  scene: null,
  raf: null,
  w: 0,
  h: 0,
  dpr: 1,
  stars: [],
  reduced: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches || false,
};

window.matchMedia?.("(prefers-reduced-motion: reduce)")?.addEventListener?.("change", (e) => {
  net.reduced = e.matches;
});

const NET_TAU = Math.PI * 2;

function netHash(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function netRate(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n < 10 ? (Math.round(n * 10) / 10) : Math.round(n)} B/s`;
  return `${humanBytes(n)}/s`;
}

function netColor(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

let netPaletteCache = null;
let netPaletteAt = 0;

function netPalette() {
  const now = performance.now();
  if (netPaletteCache && now - netPaletteAt < 2000) return netPaletteCache;
  netPaletteAt = now;
  netPaletteCache = {
    bg: netColor("--bg-inset", "#0e0e14"),
    panel: netColor("--panel", "#24283b"),
    accent: netColor("--mint", "#7aa2f7"),
    accent2: netColor("--accent-2", "#bb9af7"),
    cyan: netColor("--blue", "#0db9d7"),
    green: netColor("--green", "#9ece6a"),
    yellow: netColor("--amber", "#e0af68"),
    orange: netColor("--amber-2", "#eb927b"),
    red: netColor("--red", "#f7768e"),
    fg: netColor("--ink", "#a9b1d6"),
    dim: netColor("--muted-2", "#565f89"),
    bright: netColor("--ink", "#c0caf5"),
    mono: netColor("--font-mono", "monospace"),
    font: netColor("--font-sans", "sans-serif"),
  };
  return netPaletteCache;
}

// Canvas needs plain rgba(); theme variables are hex today but stay tolerant.
function netAlpha(color, alpha) {
  const c = String(color || "").trim();
  if (c.startsWith("#")) {
    let h = c.slice(1);
    if (h.length === 3) h = h.split("").map((x) => x + x).join("");
    if (h.length >= 6) {
      const n = parseInt(h.slice(0, 6), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
    }
  }
  const m = c.match(/^rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(",").map((x) => x.trim());
    if (parts.length >= 3) return `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha})`;
  }
  return c || `rgba(255,255,255,${alpha})`;
}

function netHost(c) {
  return c.remote.host || c.remote.ip;
}

function netProcKey(c) {
  // owner_key comes from the socket cgroup: a process, a Docker container, a
  // systemd service, or "unknown" when none of those can be established.
  if (c.process.owner_key) return c.process.owner_key;
  return c.process.pid ? `process:${c.process.pid}` : "unknown";
}

function netProcLabel(c) {
  if (c.process.owner_kind === "unknown") return "owner unknown";
  return c.process.owner_label || (c.process.pid ? c.process.name : "owner unknown");
}

function netGroupName(c) {
  return c.process.owner_label || (c.process.pid ? c.process.name : "unknown");
}

function netGroupColor(key, colors) {
  colors = colors || netPalette();
  if (key === "unknown") return colors.dim;
  const list = [colors.accent, colors.accent2, colors.cyan, colors.green, colors.yellow, colors.orange];
  return list[netHash(key) % list.length];
}

function netAgo(sec) {
  sec = Math.max(0, Number(sec) || 0);
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
  return `${Math.round(sec / 86400)}d`;
}

async function loadNetwork(force = false) {
  if (net.loading || (net.paused && !force)) return;
  net.loading = true;
  try {
    const data = await backendRequest(`/api/network?local=${net.local ? 1 : 0}`);
    net.data = data;
    if (net.hover) {
      const h = net.hover;
      const alive = h.kind === "node" && h.node.kind === "process"
        ? data.connections.some((c) => netProcKey(c) === h.node.key)
        : data.connections.some((c) => c.id === (h.kind === "link" ? h.id : h.node.conn.id));
      if (!alive) {
        net.hover = null;
        const tip = document.getElementById("netTip");
        if (tip) tip.hidden = true;
      }
    }
    if (net.selected) {
      const fresh = data.connections.find((c) => c.id === net.selId);
      if (fresh) net.selected = fresh;
      else if (!data.capped) net.selected = { ...net.selected, gone: true, state: "CLOSED" };
    }
    if (!net.everLoaded && data.connections.length) {
      net.selected = data.connections[0];
      net.selId = net.selected.id;
    }
    net.everLoaded = true;
    renderNetGroups();
    renderNetStats();
    renderNetInspector();
    const updated = document.getElementById("netUpdated");
    if (updated) {
      const when = new Date((data.generated || Date.now() / 1000) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      updated.textContent = data.error
        ? `network error: ${data.error}`
        : `live · ${when}${data.pending_dns ? ` · dns ${data.pending_dns}` : ""}${data.counters === false ? " · counters n/a" : ""}`;
    }
    const empty = document.getElementById("netEmpty");
    if (empty) {
      empty.hidden = !!(data.connections && data.connections.length);
      empty.textContent = data.error ? `Could not read sockets: ${data.error}` : "No active connections.";
    }
  } catch (e) {
    const updated = document.getElementById("netUpdated");
    if (updated) updated.textContent = "read failed";
    const empty = document.getElementById("netEmpty");
    if (empty) { empty.hidden = false; empty.textContent = `Could not read sockets: ${e.message}`; }
  } finally {
    net.loading = false;
  }
}

function renderNetStats() {
  const host = document.getElementById("netStats");
  if (!host) return;
  const d = net.data;
  if (!d) { host.innerHTML = ""; return; }
  const sub = d.capped ? `${d.shown} drawn of ${d.counts.connections}` : `${d.counts.hosts} remote host${d.counts.hosts === 1 ? "" : "s"}`;
  const groups = netGroupsFromData(d);
  const owners = groups.filter((g) => !g.hostOrigin).length;
  const hasUnknown = groups.some((g) => g.hostOrigin);
  const counters = d.counters !== false;
  const cards = [
    ["▼ inbound", counters ? netRate(d.totals.rx_rate) : "—", counters ? `${humanBytes(d.totals.rx_total || 0)} total` : "counter unavailable", "down"],
    ["▲ outbound", counters ? netRate(d.totals.tx_rate) : "—", counters ? `${humanBytes(d.totals.tx_total || 0)} total` : "counter unavailable", "up"],
    ["Links", d.counts.connections, sub, "links"],
    ["Groups", groups.length, `${owners} owner${owners === 1 ? "" : "s"}${hasUnknown ? " + unknown" : ""}`, "procs"],
  ];
  host.innerHTML = cards.map(([k, v, n, cls]) =>
    `<div class="net-stat ${cls}"><span class="net-stat-k">${esc(k)}</span><span class="net-stat-v">${esc(v)}</span><span class="net-stat-n">${esc(n)}</span></div>`).join("");
}

function netLocalValue(ip, port) {
  const host = ip.includes(":") ? `[${ip}]` : ip;
  return `${host}:${port}`;
}

function netGroupsFromData(d) {
  const groups = new Map();
  for (const c of d.connections) {
    const key = netProcKey(c);
    let g = groups.get(key);
    if (!g) {
      const kind = c.process.owner_kind || (c.process.pid ? "process" : "unknown");
      g = {
        key, label: netGroupName(c), kind, pid: c.process.pid,
        container: c.process.container || "", unit: c.process.unit || "",
        hostOrigin: kind === "unknown",
        count: 0, rx: 0, tx: 0, color: netGroupColor(key),
      };
      groups.set(key, g);
    }
    g.count += 1;
    g.rx += c.rx_rate || 0;
    g.tx += c.tx_rate || 0;
  }
  const list = [...groups.values()].sort((a, b) => {
    if (a.hostOrigin !== b.hostOrigin) return a.hostOrigin ? 1 : -1;
    return a.label.localeCompare(b.label);
  });
  const names = new Map();
  for (const g of list) if (!g.hostOrigin) names.set(g.label, (names.get(g.label) || 0) + 1);
  for (const g of list) {
    g.display = g.hostOrigin ? "unknown"
      : names.get(g.label) > 1
        ? `${g.label} ·${g.pid || (g.container || g.unit || "").slice(0, 6)}`
        : g.label;
  }
  return list;
}

function renderNetGroups() {
  const host = document.getElementById("netGroups");
  if (!host) return;
  const d = net.data;
  if (!d || !d.connections.length) {
    net.pinnedProc = "";
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  const groups = netGroupsFromData(d);
  if (net.pinnedProc && !groups.some((g) => g.key === net.pinnedProc)) net.pinnedProc = "";
  const active = net.pinnedProc;
  const scrollLeft = host.scrollLeft;
  const chip = (g) => {
    const title = g.hostOrigin
      ? "unattributed sockets — links come straight from the host"
      : g.kind === "container"
        ? `Docker container ${g.container} · ${g.count} connections`
        : g.kind === "service"
          ? `systemd unit ${g.unit} · ${g.count} connections`
          : `${g.label} · ${g.count} connections`;
    return `
    <button class="net-group ${active === g.key ? "is-active" : ""}" type="button"
            data-group="${esc(g.key)}" title="${esc(title)}">
      <span class="net-group-dot" style="background:${g.color}"></span>
      <span>${esc(g.display || g.label)}</span><span class="net-group-n">${g.count}</span>
    </button>`;
  };
  let html = chip({ key: "", label: "All", display: "All", count: d.connections.length, color: "var(--accent)", kind: "all" });
  for (const g of groups) html += chip(g);
  host.innerHTML = html;
  host.hidden = false;
  host.scrollLeft = scrollLeft;
}

function setNetPinned(key) {
  key = key || "";
  if (key && key === net.pinnedProc) key = "";
  if (key && net.selected && netProcKey(net.selected) !== key) {
    net.selected = null;
    net.selId = "";
  }
  net.pinnedProc = key;
  net.hover = null;
  const tip = document.getElementById("netTip");
  if (tip) tip.hidden = true;
  renderNetGroups();
  renderNetInspector();
}

function agentPermissionState() {
  const module = window.orqella.context?.module || {};
  return {
    granted: (module.granted_permissions || []).includes("agent"),
    pending: (module.pending_permissions || []).includes("agent"),
  };
}

function startNetIdentify() {
  const c = net.selected;
  if (!c) return;
  if (!agentPermissionState().granted) {
    toast("Agent permission required", "Grant Agent in System settings first.", "err");
    return;
  }
  if (net.aiTimer) clearTimeout(net.aiTimer);
  net.ai = {
    connId: c.id,
    status: "preparing",
    log: "",
    findings: "",
    error: null,
    root: "",
    workspaceId: "",
    jobId: "",
    timer: null,
  };
  renderNetInspector();
  (async () => {
    try {
      const workspace = await backendRequest("/api/identify/workspace", "POST", {
        proto: c.proto,
        state: c.state,
        local: c.local,
        remote: c.remote,
        process: c.process,
      });
      net.ai.workspaceId = workspace.id;
      net.ai.root = workspace.root;
      net.ai.status = "starting";
      renderNetInspector();
      const job = await window.orqella.call("agent.start", {
        prompt: workspace.prompt,
        root: workspace.root,
      });
      net.ai.jobId = job.id;
      net.ai.status = job.status || "running";
      renderNetInspector();
      pollNetIdentify();
    } catch (error) {
      net.ai.status = "failed";
      net.ai.error = error.message || "Could not start AI identification.";
      renderNetInspector();
    }
  })();
}

async function pollNetIdentify() {
  const ai = net.ai;
  if (!ai?.jobId) return;
  try {
    const job = await window.orqella.call("agent.status", { id: ai.jobId });
    ai.status = job.status || ai.status;
    ai.log = (job.log || "").slice(-16000);
    ai.error = job.error || null;
    if (job.status === "succeeded") {
      try {
        const result = await backendRequest(`/api/identify/findings?id=${encodeURIComponent(ai.workspaceId)}`);
        ai.findings = result.text || "";
        if (!ai.findings) ai.error = "The agent finished without writing FINDINGS.md.";
      } catch (error) {
        ai.error = error.message || "Could not read the agent findings.";
      }
    }
    renderNetInspector();
    if (job.status === "succeeded" || job.status === "failed") return;
  } catch (error) {
    ai.status = "failed";
    ai.error = error.message || "Could not poll the agent.";
    renderNetInspector();
    return;
  }
  ai.timer = setTimeout(pollNetIdentify, 1500);
}

function renderNetInspector() {
  const body = document.getElementById("netInspectBody");
  const empty = document.getElementById("netInspectEmpty");
  const close = document.getElementById("netInspectClose");
  if (!body || !empty || !close) return;
  const c = net.selected;
  close.hidden = !c;
  empty.hidden = !!c;
  body.hidden = !c;
  if (!c) { body.innerHTML = ""; return; }

  const state = c.gone ? "CLOSED" : c.state;
  const host = c.remote.host;
  const remoteMain = `${host || c.remote.ip}:${c.remote.port}`;
  const now = (net.data && net.data.generated) || Date.now() / 1000;
  const age = netAgo(now - (c.first_seen || now));
  const seen = new Date((c.last_seen || now) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dnsText = host
    ? `<code>${esc(host)}</code><small>reverse DNS for ${esc(c.remote.ip)}</small>`
    : `<code>${esc(c.remote.ip)}</code><small>${isLoopbackText(c) ? "loopback interface" : (net.data?.pending_dns ? "reverse lookup pending…" : "no PTR record")}</small>`;
  const kind = c.process.owner_kind || "unknown";
  const containerId = c.process.container || "";
  const unit = c.process.unit || "";
  const procTitle = kind === "process"
    ? (c.process.name || "process")
    : kind === "unknown" ? "owner unknown" : (c.process.owner_label || "unknown");
  const procLine = (kind === "process"
    ? [c.process.pid ? `pid ${c.process.pid}` : "", c.process.user]
    : kind === "container"
      ? [`container ${containerId.slice(0, 12)}`, c.process.user || "root"]
      : kind === "service"
        ? [`service ${unit}`, c.process.user || "root"]
        : ["owner unknown"]).concat(c.proto).filter(Boolean).join(" · ");
  const procDetail = kind === "process"
    ? (c.process.cmd || `${c.process.name} (pid ${c.process.pid})`)
    : kind === "container"
      ? `Docker container ${containerId.slice(0, 12)}\nAttributed from the socket's cgroup; the container runs as root.`
      : kind === "service"
        ? `systemd unit ${unit}\nAttributed from the socket's cgroup.`
        : "No readable owner, and the socket cgroup did not match a container or systemd service.";

  const agent = agentPermissionState();
  const ai = net.ai && net.ai.connId === c.id ? net.ai : null;
  const aiBusy = ai && ["preparing", "starting", "queued", "running"].includes(ai.status);
  const aiPanel = ai ? `
    <div class="ni-ai">
      <div class="ni-ai-head"><span>AI identification</span><b data-state="${esc(ai.status)}">${esc(ai.status)}</b></div>
      ${aiBusy && !ai.findings ? `<p class="ni-ai-note">Investigating the connection with the configured agent…</p>` : ""}
      ${ai.error ? `<p class="ni-ai-error">${esc(ai.error)}</p>` : ""}
      ${ai.findings ? `<div class="ni-ai-findings">${esc(ai.findings)}</div>` : ""}
      ${ai.log ? `<details class="ni-ai-log-wrap"><summary>Agent log</summary><pre class="ni-ai-log">${esc(ai.log)}</pre></details>` : ""}
      <div class="ni-actions"><button class="btn btn-soft" type="button" data-ni-identify ${aiBusy ? "disabled" : ""}>${ai.jobId ? "Run again" : "Retry"}</button></div>
    </div>` : "";

  body.innerHTML = `
    <div class="ni-title-row">
      <span class="ni-state" data-state="${esc(state)}">${esc(state)}</span>
      <div><h3>${esc(procTitle)}</h3><p>${esc(procLine)}</p></div>
    </div>
    <div class="ni-route">
      <div class="ni-ep"><span>local</span><code>${esc(netLocalValue(c.local.ip, c.local.port))}</code></div>
      <span class="ni-arrow">→</span>
      <div class="ni-ep"><span>remote</span><code>${esc(remoteMain)}</code>${host ? `<small>${esc(c.remote.ip)}</small>` : ""}</div>
    </div>
    <div class="ni-rates">
      <div class="ni-rate down"><span>▼ inbound</span><b>${esc(c.gone ? "—" : c.has_counters ? netRate(c.rx_rate) : "—")}</b></div>
      <div class="ni-rate up"><span>▲ outbound</span><b>${esc(c.gone ? "—" : c.has_counters ? netRate(c.tx_rate) : "—")}</b></div>
    </div>
    <div class="ni-spark-head"><span>traffic history</span><em>rolling window</em></div>
    <canvas class="ni-spark" id="netSpark" aria-label="Traffic history"></canvas>
    <div class="ni-grid">
      <div><span>received</span><b>${c.has_counters ? humanBytes(c.rx_total) : "—"}</b></div>
      <div><span>sent</span><b>${c.has_counters ? humanBytes(c.tx_total) : "—"}</b></div>
      <div><span>RTT</span><b>${c.rtt != null ? `${c.rtt.toFixed(1)} ms` : "—"}</b></div>
      <div><span>retransmits</span><b>${c.has_counters ? c.retrans : "—"}</b></div>
      <div><span>observed</span><b>${esc(age)}</b></div>
      <div><span>last seen</span><b>${esc(seen)}</b></div>
      <div><span>service</span><b>${esc(c.remote.service || "—")}</b></div>
      <div><span>origin</span><b>${esc(kind)}</b></div>
    </div>
    <div class="ni-section"><span>destination</span>
      <div class="ni-dns">${dnsText}</div>
    </div>
    <div class="ni-section"><span>${kind === "process" ? "process" : kind === "container" ? "container" : kind === "service" ? "service" : "owner"}</span>
      <code class="ni-cmd">${esc(procDetail)}</code>
    </div>
    <div class="ni-actions">
      <button class="btn btn-soft" type="button" data-ni-copy="${esc(`${c.remote.ip}:${c.remote.port}`)}">Copy endpoint</button>
      ${kind === "process" && c.process.cmd ? `<button class="btn btn-soft" type="button" data-ni-copy="${esc(c.process.cmd)}">Copy command</button>` : ""}
      ${!ai && agent.granted ? `<button class="btn btn-soft" type="button" data-ni-identify>Identify with AI</button>` : ""}
    </div>
    ${!ai && agent.pending ? `<p class="ni-ai-note">Grant the Agent permission in System settings to enable AI identification.</p>` : ""}
    ${aiPanel}`;
  requestAnimationFrame(drawNetSpark);
}

function isLoopbackText(c) {
  const ip = String(c.remote.ip || "");
  return ip.startsWith("127.") || ip === "::1";
}

function drawNetSpark() {
  const cv = document.getElementById("netSpark");
  const c = net.selected;
  if (!cv || !c) return;
  const w = cv.clientWidth || 280;
  const h = cv.clientHeight || 66;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const colors = netPalette();
  ctx.clearRect(0, 0, w, h);

  const hist = (c.history || []).slice(-36);
  const pad = 3;
  if (net.data?.counters === false) {
    ctx.fillStyle = netAlpha(colors.dim, 0.9);
    ctx.font = `10px ${colors.mono}`;
    ctx.textAlign = "center";
    ctx.fillText("per-socket counters unavailable", w / 2, h / 2);
    return;
  }
  ctx.strokeStyle = netAlpha(colors.dim, 0.25);
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, h - pad); ctx.lineTo(w, h - pad); ctx.stroke();
  if (hist.length < 2) {
    ctx.fillStyle = netAlpha(colors.dim, 0.9);
    ctx.font = `10px ${colors.mono}`;
    ctx.textAlign = "center";
    ctx.fillText("collecting samples…", w / 2, h / 2);
    return;
  }

  const max = Math.max(1, ...hist.map((p) => Math.max(p[1] || 0, p[2] || 0)));
  const xFor = (i) => pad + (i / (hist.length - 1)) * (w - pad * 2);
  const yFor = (v) => h - pad - (Math.max(v, 0) / max) * (h - pad * 2 - 5);

  const path = (idx, fill) => {
    ctx.beginPath();
    hist.forEach((p, i) => {
      const x = xFor(i), y = yFor(p[idx] || 0);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    if (fill) {
      ctx.lineTo(xFor(hist.length - 1), h - pad);
      ctx.lineTo(xFor(0), h - pad);
      ctx.closePath();
    }
  };

  path(1, true);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, netAlpha(colors.cyan, 0.24));
  grad.addColorStop(1, netAlpha(colors.cyan, 0.01));
  ctx.fillStyle = grad;
  ctx.fill();

  path(1, false);
  ctx.strokeStyle = colors.cyan; ctx.lineWidth = 1.5; ctx.stroke();
  path(2, false);
  ctx.strokeStyle = colors.green; ctx.lineWidth = 1.2; ctx.stroke();

  const last = hist.length - 1;
  for (const [idx, color] of [[1, colors.cyan], [2, colors.green]]) {
    ctx.beginPath();
    ctx.arc(xFor(last), yFor(hist[last][idx] || 0), 2.2, 0, NET_TAU);
    ctx.fillStyle = color; ctx.fill();
  }

  ctx.fillStyle = netAlpha(colors.dim, 0.9);
  ctx.font = `9px ${colors.mono}`;
  ctx.textAlign = "right";
  ctx.fillText(netRate(max), w - pad, 10);
}

function netResize() {
  const stage = document.getElementById("netStage");
  const canvas = document.getElementById("netCanvas");
  if (!stage || !canvas) return;
  const rect = stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (Math.abs(rect.width - net.w) < 1 && Math.abs(rect.height - net.h) < 1 && dpr === net.dpr) return;
  net.w = rect.width; net.h = rect.height; net.dpr = dpr;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  net.stars = [];
  for (let i = 0; i < 64; i++) {
    const a = netHash(`star-a-${i}`), b = netHash(`star-b-${i}`);
    net.stars.push({
      x: (a % 10000) / 10000 * rect.width,
      y: (b % 10000) / 10000 * rect.height,
      r: 0.4 + ((a >> 8) % 10) / 12,
      a: 0.08 + ((b >> 4) % 10) / 60,
    });
  }
}

function netQuad(p0, cp, p1, t) {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * cp[0] + t * t * p1[0],
    u * u * p0[1] + 2 * u * t * cp[1] + t * t * p1[1],
  ];
}

function netScene() {
  const d = net.data;
  const w = net.w, h = net.h;
  if (!d || !w || !h) return null;
  const cx = w / 2, cy = h / 2;
  const base = Math.min(w, h);
  const tall = h > w * 1.18;
  const rProc = base * 0.235;
  const rHost = base * 0.415;
  const rxProc = tall ? w * 0.29 : rProc;
  const ryProc = tall ? h * 0.22 : rProc;
  const rxHost = tall ? w * 0.42 : rHost;
  const ryHost = tall ? h * 0.42 : rHost;
  const colors = netPalette();

  const groups = new Map();
  for (const c of d.connections) {
    const key = netProcKey(c);
    let g = groups.get(key);
    if (!g) {
      const kind = c.process.owner_kind || (c.process.pid ? "process" : "unknown");
      g = {
        key, label: netGroupName(c), kind, pid: c.process.pid, user: c.process.user,
        container: c.process.container || "", unit: c.process.unit || "",
        hostOrigin: kind === "unknown", conns: [], rx: 0, tx: 0,
        color: netGroupColor(key, colors),
      };
      groups.set(key, g);
    }
    g.conns.push(c);
    g.rx += c.rx_rate || 0;
    g.tx += c.tx_rate || 0;
  }
  const procs = [...groups.values()].sort((a, b) => {
    if (a.hostOrigin !== b.hostOrigin) return a.hostOrigin ? 1 : -1;
    return a.label.localeCompare(b.label) || (a.pid || 0) - (b.pid || 0);
  });
  const procNames = new Map();
  for (const g of procs) if (!g.hostOrigin) procNames.set(g.label, (procNames.get(g.label) || 0) + 1);
  for (const g of procs) {
    g.display = g.hostOrigin ? "unknown"
      : procNames.get(g.label) > 1
        ? `${g.label} ·${g.pid || (g.container || g.unit || "").slice(0, 6)}`
        : g.label;
  }
  const nodes = [];
  const links = [];
  const sectors = [];
  const maxRate = Math.max(1, ...d.connections.map((c) => (c.rx_rate || 0) + (c.tx_rate || 0)));
  const pinned = net.pinnedProc ? procs.find((g) => g.key === net.pinnedProc) : null;

  const endpointSort = (a, b) =>
    (`${netHost(a)}:${String(a.remote.port).padStart(5, "0")}`)
      .localeCompare(`${netHost(b)}:${String(b.remote.port).padStart(5, "0")}`);

  function addLink(g, c, origin, angle, radiusFactor) {
    const tx = cx + Math.cos(angle) * rxHost * radiusFactor;
    const ty = cy + Math.sin(angle) * ryHost * radiusFactor;
    const visualAngle = Math.atan2(Math.sin(angle) * ryHost, Math.cos(angle) * rxHost);
    const rate = (c.rx_rate || 0) + (c.tx_rate || 0);
    const norm = Math.log1p(rate) / Math.log1p(maxRate);
    const width = rate > 0.5 ? 0.8 + 5.8 * norm : 0.5;
    const node = {
      kind: "remote", conn: c, x: tx, y: ty, angle: visualAngle,
      r: 3.2 + Math.min(3.6, Math.log1p(rate) / 2.1),
      color: rate > 1024 ? colors.cyan : colors.dim,
      groupColor: g.color,
    };
    links.push({
      kind: "link", conn: c, procKey: g.key, color: g.color,
      p0: origin, p1: [tx, ty], cp: [(origin[0] + tx) / 2, (origin[1] + ty) / 2],
      width, norm, node,
    });
    nodes.push(node);
  }

  if (pinned) {
    // Focus mode: one process, one clean orbit of labeled endpoints. Sockets
    // with no readable owner connect straight to the host (`origin` = centre).
    const conns = [...pinned.conns].sort(endpointSort);
    let origin = [cx, cy];
    if (!pinned.hostOrigin) {
      const x = cx, y = cy - ryProc;
      origin = [x, y];
      const rate = pinned.rx + pinned.tx;
      nodes.push({
        kind: "process", key: pinned.key, group: pinned, angle: -Math.PI / 2,
        x, y, r: 8 + Math.min(5, Math.log1p(rate) / 3),
        color: pinned.color, label: pinned.display || pinned.label,
        count: conns.length, rx: pinned.rx, tx: pinned.tx,
      });
    }
    // Direct sockets fan around the full host orbit. A process orbit leaves a
    // small gap directly opposite the process node so no link runs straight
    // through the host core.
    const start = pinned.hostOrigin ? -Math.PI / 2 + 0.02 : Math.PI / 2 + 0.35;
    const span = NET_TAU - (pinned.hostOrigin ? 0.04 : 0.7);
    const rows = conns.length > (net.w < 560 ? 11 : 16) ? 2 : 1;
    conns.forEach((c, i) => {
      const angle = !pinned.hostOrigin && conns.length === 1
        ? 0
        : start + span * ((i + 0.5) / Math.max(conns.length, 1));
      const radiusFactor = 1 - (i % rows) * 0.10;
      addLink(pinned, c, origin, angle, radiusFactor);
    });
  } else {
    // Overview: equal sectors, one per process, with an ordered endpoint arc.
    const count = Math.max(procs.length, 1);
    const sectorW = NET_TAU / count;
    procs.forEach((g, index) => {
      const center = -Math.PI / 2 + index * sectorW;
      const start = center - sectorW / 2;
      const end = center + sectorW / 2;
      sectors.push({ start, end, color: g.color, key: g.key, hostOrigin: g.hostOrigin });

      let origin = [cx, cy];
      if (!g.hostOrigin) {
        const x = cx + Math.cos(center) * rxProc;
        const y = cy + Math.sin(center) * ryProc;
        origin = [x, y];
        const rate = g.rx + g.tx;
        // Labels point inward, keeping the outer arc free for destinations.
        const labelAngle = Math.atan2(-Math.sin(center) * ryProc, -Math.cos(center) * rxProc);
        nodes.push({
          kind: "process", key: g.key, group: g, angle: labelAngle,
          x, y, r: 7 + Math.min(5, Math.log1p(rate) / 3) + Math.min(2.5, g.conns.length * 0.25),
          color: g.color, label: g.display || g.label,
          count: g.conns.length, rx: g.rx, tx: g.tx,
        });
      }

      const conns = [...g.conns].sort(endpointSort);
      const arc = sectorW * Math.min(rxHost, ryHost);
      const perArc = Math.max(2, Math.floor(arc / (net.w < 560 ? 30 : 54)));
      const rows = Math.min(4, Math.max(1, Math.ceil(conns.length / perArc)));
      const margin = conns.length > 1 ? Math.min(sectorW * 0.1, 0.055) : 0;
      const span = Math.max(0, sectorW - margin * 2);
      conns.forEach((c, i) => {
        const angle = conns.length === 1
          ? center
          : start + margin + span * (i / (conns.length - 1));
        const radiusFactor = 1 - (i % rows) * 0.075;
        addLink(g, c, origin, angle, radiusFactor);
      });
    });
  }

  return {
    cx, cy, rProc, rHost, rxProc, ryProc, rxHost, ryHost,
    nodes, links, sectors, colors, maxRate,
    focus: !!pinned, focusKey: pinned ? pinned.key : "",
  };
}

// What the pointer is tracing. Hovering wins for a quick preview; otherwise a
// pinned process stays isolated until the All chip (or empty space) is clicked.
function netFocus() {
  const h = net.hover;
  if (h) {
    if (h.kind === "link") return { active: true, connId: h.id, procKey: netProcKey(h.conn) };
    if (h.node.kind === "process") return { active: true, connId: "", procKey: h.node.key };
    return { active: true, connId: h.node.conn.id, procKey: netProcKey(h.node.conn) };
  }
  if (net.pinnedProc) return { active: true, connId: "", procKey: net.pinnedProc, pinned: true };
  return { active: false, connId: "", procKey: "" };
}

function netDraw(time) {
  net.raf = requestAnimationFrame(netDraw);
  if (!networkVisible()) { cancelAnimationFrame(net.raf); net.raf = null; return; }
  netResize();
  const canvas = document.getElementById("netCanvas");
  const d = net.data;
  if (!canvas || !net.w || !net.h) return;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(net.dpr, 0, 0, net.dpr, 0, 0);
  ctx.clearRect(0, 0, net.w, net.h);
  const scene = netScene();
  net.scene = scene;
  const colors = scene?.colors || netPalette();

  // starfield
  for (const star of net.stars) {
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.r, 0, NET_TAU);
    ctx.fillStyle = netAlpha(colors.bright, star.a);
    ctx.fill();
  }

  if (!scene) { net.nodes = []; net.links = []; net.labelHits = []; return; }
  const { cx, cy, rxProc, ryProc, rxHost, ryHost } = scene;
  const focus = netFocus();

  // Ordered overview: one faint wedge per process, with clear boundaries.
  if (!scene.focus) {
    for (const sector of scene.sectors) {
      const lit = focus.active && focus.procKey === sector.key;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rxHost * 1.03, ryHost * 1.03, 0, sector.start, sector.end, false);
      ctx.ellipse(cx, cy, 34, 34, 0, sector.end, sector.start, true);
      ctx.closePath();
      ctx.fillStyle = netAlpha(sector.color, lit ? 0.075 : 0.028);
      ctx.fill();

      for (const a of [sector.start, sector.end]) {
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * 36, cy + Math.sin(a) * 36);
        ctx.lineTo(cx + Math.cos(a) * rxHost * 1.03, cy + Math.sin(a) * ryHost * 1.03);
        ctx.strokeStyle = netAlpha(sector.color, lit ? 0.32 : 0.1);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  // orbit rings (circles on wide stages, ellipses on tall ones)
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 7]);
  for (const [rx, ry, a] of [
    [rxProc * 0.8, ryProc * 0.8, 0.11],
    [rxProc, ryProc, 0.16],
    [(rxProc + rxHost) / 2, (ryProc + ryHost) / 2, 0.08],
    [rxHost, ryHost, 0.11],
  ]) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, NET_TAU);
    ctx.strokeStyle = netAlpha(colors.accent, a);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // center -> process spokes
  for (const node of scene.nodes) {
    if (node.kind !== "process") continue;
    const related = !focus.active || node.key === focus.procKey;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(node.x, node.y);
    ctx.strokeStyle = netAlpha(node.color, related ? 0.14 : 0.04);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Straight radial links, with a dark casing underneath so crossing lines
  // stay distinguishable against the starfield.
  const ordered = [...scene.links].sort((a, b) => a.norm - b.norm);
  for (const link of ordered) {
    const sameProc = focus.procKey && link.procKey === focus.procKey;
    const related = !focus.active || (focus.connId ? link.conn.id === focus.connId : sameProc);
    const casing = !focus.active ? 0.72 : related ? 0.92 : sameProc ? 0.4 : 0.12;
    ctx.beginPath();
    ctx.moveTo(link.p0[0], link.p0[1]);
    ctx.lineTo(link.p1[0], link.p1[1]);
    ctx.strokeStyle = netAlpha(colors.bg, casing);
    ctx.lineWidth = link.width + 3.5;
    ctx.stroke();
  }

  for (const link of ordered) {
    const selected = link.conn.id === net.selId;
    const sameProc = focus.procKey && link.procKey === focus.procKey;
    const sameConn = focus.connId && link.conn.id === focus.connId;
    const traced = focus.active && (focus.connId ? sameConn : sameProc);
    let alpha;
    if (selected) alpha = 0.98;
    else if (focus.active) alpha = sameConn ? 1 : sameProc ? 0.2 : 0.035;
    else alpha = 0.3 + 0.5 * link.norm;

    ctx.beginPath();
    ctx.moveTo(link.p0[0], link.p0[1]);
    ctx.lineTo(link.p1[0], link.p1[1]);
    ctx.strokeStyle = netAlpha(link.color, traced ? 0.98 : alpha);
    ctx.lineWidth = link.width + (selected ? 2.2 : traced ? 1.1 : 0);
    if (selected || traced) {
      ctx.shadowColor = netAlpha(link.color, 0.65);
      ctx.shadowBlur = 14;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // packets: outbound uses the process colour, inbound cyan
  if (!net.reduced) {
    for (const link of scene.links) {
      const rate = (link.conn.rx_rate || 0) + (link.conn.tx_rate || 0);
      if (rate < 1) continue;
      const sameProc = focus.procKey && link.procKey === focus.procKey;
      const sameConn = focus.connId && link.conn.id === focus.connId;
      if (focus.active && !(focus.connId ? sameConn : sameProc)) continue;
      const count = link.norm > 0.6 ? 3 : link.norm > 0.2 ? 2 : 1;
      const seed = (netHash(link.conn.id) % 1000) / 1000;
      const speed = 0.00011 * (0.6 + link.norm * 2.2);
      for (let i = 0; i < count; i++) {
        const phase = (time * speed + seed + i / count) % 1;
        if ((link.conn.tx_rate || 0) > 0.5) {
          const [px, py] = netQuad(link.p0, link.cp, link.p1, phase);
          ctx.beginPath(); ctx.arc(px, py, 1.25 + link.norm * 1.5, 0, NET_TAU);
          ctx.fillStyle = netAlpha(link.color, 0.9); ctx.fill();
        }
        if ((link.conn.rx_rate || 0) > 0.5) {
          const [px, py] = netQuad(link.p0, link.cp, link.p1, 1 - phase);
          ctx.beginPath(); ctx.arc(px, py, 1.25 + link.norm * 1.5, 0, NET_TAU);
          ctx.fillStyle = netAlpha(colors.cyan, 0.9); ctx.fill();
        }
      }
    }
  }

  // selected/hovered remote highlight
  for (const link of scene.links) {
    const selected = link.conn.id === net.selId;
    const hovered = net.hover?.kind === "link" && net.hover.id === link.conn.id;
    if (!selected && !hovered) continue;
    ctx.beginPath();
    ctx.arc(link.p1[0], link.p1[1], link.node.r + 8, 0, NET_TAU);
    ctx.strokeStyle = netAlpha(colors.cyan, selected ? 0.85 : 0.5);
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  netDrawCenter(ctx, scene, colors, time);
  netDrawNodes(ctx, scene, colors, focus);
  net.nodes = scene.nodes;
  net.links = scene.links;
}

function netDrawCenter(ctx, scene, colors, time) {
  const { cx, cy } = scene;
  const d = net.data;
  const pulse = net.reduced ? 0.5 : (Math.sin(time * 0.002) + 1) / 2;
  const glow = ctx.createRadialGradient(cx, cy, 2, cx, cy, 64);
  glow.addColorStop(0, netAlpha(colors.accent, 0.32));
  glow.addColorStop(0.55, netAlpha(colors.accent, 0.08));
  glow.addColorStop(1, netAlpha(colors.accent, 0));
  ctx.beginPath(); ctx.arc(cx, cy, 64, 0, NET_TAU); ctx.fillStyle = glow; ctx.fill();

  ctx.beginPath(); ctx.arc(cx, cy, 26 + pulse * 2.5, 0, NET_TAU);
  ctx.fillStyle = netAlpha(colors.accent, 0.13); ctx.fill();
  ctx.strokeStyle = netAlpha(colors.accent, 0.7); ctx.lineWidth = 1.4; ctx.stroke();

  ctx.beginPath(); ctx.arc(cx, cy, 5, 0, NET_TAU);
  ctx.fillStyle = colors.bright; ctx.fill();

  ctx.textAlign = "center";
  ctx.font = `600 11.5px ${colors.font}`;
  ctx.fillStyle = colors.bright;
  ctx.fillText((d.host || "this machine").toUpperCase(), cx, cy + 43);
  ctx.font = `9.5px ${colors.mono}`;
  ctx.fillStyle = colors.dim;
  ctx.fillText(`↓ ${netRate(d.totals.rx_rate)}   ↑ ${netRate(d.totals.tx_rate)}`, cx, cy + 57);
}

// Keep a label inside the canvas even when its node hugs an edge, skip it if
// it would land on a higher-priority label, and return the hit box. Endpoint
// labels are pills: they're easier to read and much easier to click.
function netDrawLabel(ctx, text, node, out, angle, boxes, opts) {
  const pill = opts?.pill !== false;
  const padX = pill ? 7 : 2;
  const h = pill ? 18 : 14;
  const textColor = ctx.fillStyle;
  const tw = ctx.measureText(text).width;
  const side = Math.cos(angle) >= 0 ? 1 : -1;
  const align = side > 0 ? "left" : "right";
  let lx = node.x + side * out;
  let y = node.y + Math.sin(angle) * out;
  const pw = tw + padX * 2;
  let boxX = side > 0 ? lx - padX : lx - tw - padX;
  let boxY = y - h / 2;

  if (boxX < 4) { const d = 4 - boxX; boxX += d; lx += d; }
  if (boxX + pw > net.w - 4) { const d = boxX + pw - (net.w - 4); boxX -= d; lx -= d; }
  if (boxY < 4) { const d = 4 - boxY; boxY += d; y += d; }
  if (boxY + h > net.h - 4) { const d = boxY + h - (net.h - 4); boxY -= d; y -= d; }

  const box = { x: boxX, y: boxY, w: pw, h };
  const clash = boxes.some((b) =>
    box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y);
  if (clash) return null;

  boxes.push(box);
  if (pill) {
    const r = 6;
    ctx.beginPath();
    ctx.moveTo(box.x + r, box.y);
    ctx.lineTo(box.x + box.w - r, box.y);
    ctx.quadraticCurveTo(box.x + box.w, box.y, box.x + box.w, box.y + r);
    ctx.lineTo(box.x + box.w, box.y + box.h - r);
    ctx.quadraticCurveTo(box.x + box.w, box.y + box.h, box.x + box.w - r, box.y + box.h);
    ctx.lineTo(box.x + r, box.y + box.h);
    ctx.quadraticCurveTo(box.x, box.y + box.h, box.x, box.y + box.h - r);
    ctx.lineTo(box.x, box.y + r);
    ctx.quadraticCurveTo(box.x, box.y, box.x + r, box.y);
    ctx.closePath();
    ctx.fillStyle = netAlpha(opts?.bg || netPalette().bg, 0.88);
    ctx.fill();
    ctx.strokeStyle = netAlpha(opts?.border || "#7aa2f7", opts?.strong ? 0.75 : 0.34);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.textAlign = align;
  ctx.fillStyle = textColor;
  ctx.fillText(text, lx, y);
  return box;
}

function netDrawNodes(ctx, scene, colors, focus) {
  const d = net.data;
  const selectedProc = net.selected ? netProcKey(net.selected) : "";
  const hoverId = net.hover?.kind === "link" ? net.hover.id : "";
  const hoverNodeKey = net.hover?.kind === "node" ? net.hover.key : "";
  const overviewLabels = net.w < 560 ? 0 : 10;
  const remoteRank = new Map(
    [...d.connections].sort((a, b) => (b.rx_rate + b.tx_rate) - (a.rx_rate + a.tx_rate))
      .slice(0, overviewLabels).map((c) => [c.id, true])
  );
  const endpointCounts = new Map();
  for (const c of d.connections) {
    const key = `${netHost(c)}:${c.remote.port}`;
    endpointCounts.set(key, (endpointCounts.get(key) || 0) + 1);
  }

  const labels = [];
  for (const node of scene.nodes) {
    if (node.kind === "process") {
      const selected = node.key === selectedProc;
      const hovered = hoverNodeKey === `proc:${node.key}`;
      const related = !focus.active || node.key === focus.procKey;
      const alpha = selected || hovered || related ? 1 : 0.22;

      ctx.globalAlpha = alpha;
      ctx.beginPath(); ctx.arc(node.x, node.y, node.r, 0, NET_TAU);
      ctx.fillStyle = netAlpha(node.color, selected ? 0.7 : 0.3);
      ctx.fill();
      ctx.strokeStyle = netAlpha(node.color, selected || hovered ? 1 : 0.8);
      ctx.lineWidth = selected || hovered ? 2 : 1.2;
      if (selected || hovered) { ctx.shadowColor = netAlpha(node.color, 0.8); ctx.shadowBlur = 16; }
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.beginPath(); ctx.arc(node.x, node.y, Math.max(2, node.r * 0.32), 0, NET_TAU);
      ctx.fillStyle = colors.bright; ctx.fill();
      ctx.globalAlpha = 1;

      if (!focus.active || related || selected) {
        let name = node.label;
        if (net.w < 560 && name.length > 11) name = `${name.slice(0, 10)}…`;
        labels.push({
          text: node.count > 1 ? `${name} ×${node.count}` : name,
          node, out: node.r + 13, angle: node.angle,
          priority: selected ? 160 : hovered ? 155 : related ? 150 : 20,
          font: `${selected || hovered ? "600 " : ""}10.5px ${colors.font}`,
          color: selected || hovered ? colors.bright : colors.fg,
          border: node.color,
          key: `proc:${node.key}`,
          pill: true,
        });
      }
    } else {
      const c = node.conn;
      const selected = c.id === net.selId;
      const hovered = hoverId === c.id || hoverNodeKey === `conn:${c.id}`;
      const sameProc = !!focus.procKey && netProcKey(c) === focus.procKey;
      const sameConn = !!focus.connId && c.id === focus.connId;
      const alpha = !focus.active ? 1 : selected || hovered || sameConn ? 1 : sameProc ? 0.55 : 0.15;

      ctx.globalAlpha = alpha;
      ctx.beginPath(); ctx.arc(node.x, node.y, node.r + (selected ? 1.6 : 0), 0, NET_TAU);
      ctx.fillStyle = netAlpha(node.color, selected ? 0.95 : 0.62);
      ctx.fill();
      if (selected || hovered || (focus.active && sameProc)) {
        ctx.beginPath(); ctx.arc(node.x, node.y, node.r + (selected ? 7 : 5), 0, NET_TAU);
        ctx.strokeStyle = netAlpha(node.groupColor || colors.cyan, selected ? 0.85 : 0.5);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      const showLabel = selected || hovered || (focus.active ? sameProc : remoteRank.has(c.id));
      if (showLabel) {
        const host = netHost(c);
        const maxHost = net.w < 560 ? 15 : 23;
        const short = host.length > maxHost ? `${host.slice(0, maxHost - 1)}…` : host;
        const duplicate = (endpointCounts.get(`${host}:${c.remote.port}`) || 0) > 1;
        labels.push({
          text: `${short}:${c.remote.port}${duplicate ? ` ·${c.local.port}` : ""}`,
          node, out: node.r + 10, angle: node.angle,
          priority: selected ? 170 : hovered ? 165 : focus.active && sameProc ? 140 : 10,
          font: `${selected || hovered ? "600 " : ""}9.5px ${colors.mono}`,
          color: selected || hovered ? colors.bright : colors.fg,
          border: node.groupColor || colors.cyan,
          key: `conn:${c.id}`,
          pill: true,
        });
      }
    }
  }

  labels.sort((a, b) => b.priority - a.priority);
  const boxes = [];
  const hits = [];
  ctx.textBaseline = "middle";
  for (const label of labels) {
    ctx.font = label.font;
    ctx.fillStyle = label.color;
    const box = netDrawLabel(ctx, label.text, label.node, label.out, label.angle, boxes, {
      pill: label.pill, border: label.border, strong: label.node.kind === "remote",
    });
    if (box) {
      hits.push({ kind: "node", key: label.key, node: label.node, dist: 0, box });
    }
  }
  net.labelHits = hits;
  ctx.textBaseline = "alphabetic";
}

function netPick(mx, my) {
  let best = null;
  // Pills first: clicking the destination label should inspect that socket.
  for (const hit of net.labelHits) {
    const b = hit.box;
    if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) {
      return hit;
    }
  }
  for (const node of net.nodes) {
    const d = Math.hypot(mx - node.x, my - node.y);
    const reach = Math.max(16, node.r + 10);
    if (d < reach && (!best || d < best.dist)) {
      best = node.kind === "process"
        ? { kind: "node", key: `proc:${node.key}`, node, dist: d }
        : { kind: "node", key: `conn:${node.conn.id}`, node, dist: d };
    }
  }
  if (best) return best;
  for (const link of net.links) {
    for (let i = 0; i <= 14; i++) {
      const [px, py] = netQuad(link.p0, link.cp, link.p1, i / 14);
      const d = Math.hypot(mx - px, my - py);
      if (d < Math.max(9, link.width / 2 + 4) && (!best || d < best.dist)) {
        best = { kind: "link", id: link.conn.id, conn: link.conn, dist: d };
        break;
      }
    }
  }
  return best;
}

function netSelectHit(hit) {
  if (!hit) return;
  if (hit.kind === "node" && hit.node.kind === "process") {
    setNetPinned(hit.node.key);
    return;
  }

  net.selected = hit.kind === "node" ? hit.node.conn : hit.conn;
  net.selId = net.selected.id;
  net.hover = null;
  document.getElementById("netTip").hidden = true;
  renderNetInspector();
  if (window.innerWidth <= 1080) {
    document.getElementById("netInspect")?.scrollIntoView({ behavior: net.reduced ? "auto" : "smooth", block: "nearest" });
  }
}

function netTipFor(hit) {
  const c = hit.kind === "node" ? (hit.node.kind === "process" ? null : hit.node.conn) : hit.conn;
  const h = document.getElementById("netTip");
  const colorsLine = (v, cls) => `<span class="${cls}">${v}</span>`;
  if (hit.kind === "node" && hit.node.kind === "process") {
    const g = hit.node.group;
    const where = g.kind === "container"
      ? `Docker container ${String(g.container || "").slice(0, 12)}`
      : g.kind === "service" ? `systemd unit ${g.unit}`
        : g.pid ? `pid ${g.pid}` : (g.user || "owner unknown");
    h.innerHTML = `<b>${esc(g.display || g.label)}</b>
      <div class="tip-row">${g.conns.length} connection${g.conns.length === 1 ? "" : "s"} · ${esc(where)}</div>
      <div>${colorsLine(`▼ ${net.data?.counters === false ? "—" : netRate(g.rx)}`, "tip-rx")} ${colorsLine(`▲ ${net.data?.counters === false ? "—" : netRate(g.tx)}`, "tip-tx")}</div>`;
    return;
  }
  h.innerHTML = `<b>${esc(netHost(c))}:${c.remote.port}</b>
    <div class="tip-row">${esc(netProcLabel(c))}${c.process.pid ? ` · pid ${c.process.pid}` : ""} · ${esc(c.state)}</div>
    <div class="tip-row">${esc(c.remote.ip)}${c.remote.service ? ` · ${esc(c.remote.service)}` : ""}</div>
    <div>${colorsLine(`▼ ${c.has_counters ? netRate(c.rx_rate) : "—"}`, "tip-rx")} ${colorsLine(`▲ ${c.has_counters ? netRate(c.tx_rate) : "—"}`, "tip-tx")}</div>
    <div class="tip-row">click to inspect</div>`;
}

function wireNetwork() {
  const canvas = document.getElementById("netCanvas");
  canvas?.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const hit = netPick(mx, my);
    net.hover = hit;
    canvas.style.cursor = hit ? "pointer" : "crosshair";
    const tip = document.getElementById("netTip");
    if (!hit) { tip.hidden = true; return; }
    netTipFor(hit);
    tip.hidden = false;
    tip.style.left = `${Math.min(mx + 14, Math.max(0, net.w - 250))}px`;
    tip.style.top = `${Math.min(my + 14, Math.max(0, net.h - 96))}px`;
  });
  canvas?.addEventListener("pointerleave", () => {
    net.hover = null;
    document.getElementById("netTip").hidden = true;
    if (canvas) canvas.style.cursor = "crosshair";
  });
  canvas?.addEventListener("pointerdown", (e) => {
    const rect = canvas.getBoundingClientRect();
    const hit = netPick(e.clientX - rect.left, e.clientY - rect.top);
    if (hit) {
      e.preventDefault();
      netSelectHit(hit);
    } else if (net.pinnedProc) {
      setNetPinned("");
    }
  });

  document.getElementById("netGroups")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-group]");
    if (btn) setNetPinned(btn.dataset.group || "");
  });
  document.getElementById("netLocal")?.addEventListener("change", (e) => {
    net.local = !!e.target.checked;
    loadNetwork(true);
  });
  document.getElementById("netPause")?.addEventListener("click", () => {
    net.paused = !net.paused;
    const btn = document.getElementById("netPause");
    btn.textContent = net.paused ? "▶ Resume" : "❚❚ Pause";
    if (!net.paused) loadNetwork(true);
    else document.getElementById("netUpdated").textContent = "paused";
  });
  document.getElementById("netRefresh")?.addEventListener("click", () => loadNetwork(true));
  document.getElementById("netInspectClose")?.addEventListener("click", () => {
    net.selected = null;
    net.selId = "";
    renderNetInspector();
  });
  document.getElementById("netInspectBody")?.addEventListener("click", async (e) => {
    const aiButton = e.target.closest("button[data-ni-identify]");
    if (aiButton) {
      e.preventDefault();
      startNetIdentify();
      return;
    }
    const btn = e.target.closest("button[data-ni-copy]");
    if (!btn) return;
    const text = btn.dataset.niCopy || "";
    if (await copyText(text)) toast("Copied", text, "ok");
    else toast("Could not copy", "select the text manually", "err");
  });

  if (document.getElementById("netStage")) new ResizeObserver(() => netResize()).observe(document.getElementById("netStage"));
}

function openNetworkView() {
  netResize();
  if (!net.raf) net.raf = requestAnimationFrame(netDraw);
  if (!net.data) document.getElementById("netEmpty").hidden = false;
  loadNetwork();
}

function closeNetworkView() {
  if (net.raf) cancelAnimationFrame(net.raf);
  net.raf = null;
}

  let wired = false;
  let pollStarted = false;
  async function boot(attempt = 0) {
    if (!wired) { wireNetwork(); wired = true; }
    const section = document.getElementById("networkUniverse");
    let platform = null;
    try { platform = await backendRequest("/api/platform"); } catch {}
    if (!platform) {
      if (attempt < 10) {
        setTimeout(() => boot(attempt + 1), Math.min(2000, 500 + attempt * 250));
        return;
      }
      if (section) section.hidden = true;
      return;
    }
    if (!platform.network) {
      if (section) section.hidden = true;
      return;
    }
    if (section) section.hidden = false;
    loadNetwork();
    if (!net.raf) net.raf = requestAnimationFrame(netDraw);
    if (!pollStarted) {
      pollStarted = true;
      setInterval(() => {
        if (!networkVisible()) return;
        loadNetwork();
        if (!net.raf) net.raf = requestAnimationFrame(netDraw);
      }, 2500);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden && networkVisible() && !net.raf) net.raf = requestAnimationFrame(netDraw);
      });
    }
  }

  window.orqella.ready(() => boot());
})();
