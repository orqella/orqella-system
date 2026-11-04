// Cross-platform service browser for the System module.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const backendRequest = (path, method = "GET", body) =>
    window.orqella.call("backend.request", body === undefined ? { method, path } : { method, path, body });
  const state = {
    scope: "user", scopes: ["user"], manager: "services",
    features: { timers: false, logs: false, actions: [] },
    chip: "active", filter: "", data: null, logUnit: "", timer: null,
    available: false, loading: false, pendingLoad: false, pendingStop: "", stopTimer: null,
  };

  function sysIn(seconds) {
    if (seconds === null || seconds === undefined) return "—";
    const s = Math.round(seconds);
    if (s === 0) return "now";
    const abs = Math.abs(s);
    const out = abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.round(abs / 60)}m` : abs < 86400 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86400)}d`;
    return s < 0 ? `${out} ago` : `in ${out}`;
  }

  function sysState(active, sub) {
    if (active === "failed") return "failed";
    if (active === "active") return sub === "exited" || sub === "paused" ? "exited" : "active";
    if (active === "activating" || sub === "auto-restart") return "restarting";
    return "inactive";
  }

  function enabled(value) {
    return { enabled: "enabled", disabled: "disabled", static: "static", generated: "generated",
      transient: "transient", indirect: "indirect", alias: "alias" }[value] || value || "";
  }

  function logButton(unit) {
    if (!state.features.logs) return "";
    return `<button class="btn btn-soft" data-act="logs" data-unit="${esc(unit)}">Logs</button>`;
  }

  function actions(item) {
    const logs = logButton(item.unit);
    if (state.data.readonly) return logs;
    if (state.manager === "systemd" && item.unit === "orqella.service") {
      return `<span class="sysd-self">the dashboard</span>${logs}`;
    }
    const allowed = new Set(item.actions || state.features.actions || []);
    if (!allowed.size) return logs;
    const unit = esc(item.unit);
    const restart = allowed.has("restart")
      ? `<button class="btn btn-soft" data-act="restart" data-unit="${unit}">Restart</button>` : "";
    if (item.active === "failed") {
      if (allowed.has("restart") && item.unit_type === "service") return restart + logs;
      if (allowed.has("reset-failed")) return `<button class="btn btn-soft" data-act="reset-failed" data-unit="${unit}">Reset</button>${logs}`;
      return logs;
    }
    if (item.active === "active" && allowed.has("stop")) {
      const stopLabel = state.pendingStop === item.unit ? "Confirm stop" : "Stop";
      return `${restart}<button class="btn btn-soft ${state.pendingStop === item.unit ? "danger" : ""}" data-act="stop" data-unit="${unit}">${stopLabel}</button>${logs}`;
    }
    if (item.active !== "active" && allowed.has("start")) {
      return `${restart}<button class="btn btn-soft" data-act="start" data-unit="${unit}">Start</button>${logs}`;
    }
    return `${item.active === "active" ? restart : ""}${logs}`;
  }

  function applyScopes() {
    const scopes = state.scopes.length ? state.scopes : ["user"];
    if (!scopes.includes(state.scope)) state.scope = scopes[0];
    const host = $("sysdScope");
    if (host) host.hidden = scopes.length <= 1;
    document.querySelectorAll("#sysdScope button").forEach((button) => {
      button.hidden = !scopes.includes(button.dataset.scope);
      button.classList.toggle("is-active", button.dataset.scope === state.scope);
    });
  }

  function render() {
    const d = state.data;
    if (!d) return;
    const c = d.counts || {};
    const timers = d.features?.timers ? ` · ${c.timers || 0} timers` : "";
    $("sysdSummary").textContent = `${d.manager || state.manager || "services"} · ${c.active || 0} active · ${c.failed || 0} failed${timers}`;
    const note = d.readonly_note || "";
    $("sysdReadonly").hidden = !note;
    if (note) $("sysdReadonly").textContent = note;
    state.features = d.features || state.features;
    state.scopes = d.scopes || state.scopes;
    state.manager = d.manager || state.manager;
    applyScopes();
    const timersChip = document.querySelector('#sysdChips button[data-chip="timers"]');
    if (timersChip) timersChip.hidden = !state.features.timers;
    if (state.chip === "timers" && !state.features.timers) state.chip = "active";
    document.querySelectorAll("#sysdChips button").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.chip === state.chip);
    });

    let items;
    if (state.chip === "timers") items = (d.timers || []).map((t) => ({ ...t, kind: "timer" }));
    else if (state.chip === "failed") items = (d.failed_units || []).map((u) => ({ ...u, kind: "service" }));
    else {
      let services = d.services || [];
      if (state.chip === "active") services = services.filter((s) => s.active === "active" || s.active === "failed");
      items = services.map((s) => ({ ...s, kind: "service" }));
    }

    const q = state.filter.toLowerCase().trim();
    if (q) items = items.filter((item) => [item.label, item.description, item.activates]
      .some((value) => String(value || "").toLowerCase().includes(q)));

    const list = $("sysdList");
    if (!items.length) {
      const message = d.error ? esc(d.error) : state.chip === "failed" ? "No failed services." : "Nothing matches.";
      list.innerHTML = `<div class="sysd-empty">${message}</div>`;
      return;
    }

    const rows = [];
    for (const item of items) {
      if (item.kind === "timer") {
        const scheduled = item.next_in !== null;
        rows.push(`<div class="sysd-row">
          <span class="sysd-dot" data-state="${scheduled ? "timer" : "inactive"}"></span>
          <div class="sysd-main">
            <div class="sysd-unit">${esc(item.label)}<span class="sysd-sub">${scheduled ? "scheduled" : "inactive"}</span></div>
            <div class="sysd-desc">activates ${esc(item.activates || "—")}</div>
          </div>
          <div class="sysd-meta">${scheduled ? `next ${esc(sysIn(item.next_in))}` : "not scheduled"}${item.last ? ` · last ${esc(sysIn(-item.last_ago))}` : ""}</div>
          <div class="sysd-actions">${logButton(item.activates || item.unit)}</div>
        </div>`);
      } else {
        const tone = sysState(item.active, item.sub);
        rows.push(`<div class="sysd-row">
          <span class="sysd-dot" data-state="${tone}"></span>
          <div class="sysd-main">
            <div class="sysd-unit">${esc(item.label)}<span class="sysd-sub">${esc(item.active === "active" ? item.sub : item.active)}</span></div>
            <div class="sysd-desc">${esc(item.description || "—")}</div>
          </div>
          <div class="sysd-meta">${esc(enabled(item.enabled) || "—")}</div>
          <div class="sysd-actions">${actions(item)}</div>
        </div>`);
      }
    }
    list.innerHTML = rows.join("");
  }

  async function load() {
    if (!state.available) return;
    if (state.loading) {
      state.pendingLoad = true;
      return;
    }
    state.loading = true;
    const list = $("sysdList");
    if (!list.innerHTML) list.innerHTML = `<div class="sysd-empty">Reading services…</div>`;
    try {
      const data = await backendRequest(`/api/services?scope=${encodeURIComponent(state.scope)}`);
      if (data.available === false) {
        state.available = false;
        $("servicesControl").hidden = true;
        if (state.timer) clearInterval(state.timer);
        state.timer = null;
        return;
      }
      state.data = data;
      render();
    } catch (error) {
      list.innerHTML = `<div class="sysd-empty">Could not read services (${esc(error.message)}).</div>`;
    } finally {
      state.loading = false;
      if (state.pendingLoad) {
        state.pendingLoad = false;
        setTimeout(load, 0);
      }
    }
  }

  async function action(unit, name) {
    // The module iframe does not allow window.confirm(); use an inline
    // two-click confirmation for the destructive action instead.
    if (name === "stop" && state.pendingStop !== unit) {
      state.pendingStop = unit;
      clearTimeout(state.stopTimer);
      state.stopTimer = setTimeout(() => { state.pendingStop = ""; render(); }, 5000);
      render();
      showToast("Confirm stop", `Click Stop again for ${unit}`, "err");
      return;
    }
    if (name === "stop") state.pendingStop = "";
    clearTimeout(state.stopTimer);
    const label = name === "reset-failed" ? "reset" : name;
    try {
      const result = await backendRequest("/api/services/action", "POST", { scope: state.scope, unit, action: name });
      showToast(`${label} ${unit}`, result.ok ? "done" : (result.detail || "failed"), result.ok ? "ok" : "err");
    } catch (error) {
      showToast(`${label} failed`, error.message, "err");
    }
    await load();
  }

  async function showLogs(unit) {
    if (!state.features.logs) return;
    state.logUnit = unit;
    $("sysdLogsPanel").hidden = false;
    $("sysdLogsTitle").textContent = unit;
    $("sysdLogs").textContent = "Loading…";
    try {
      const data = await backendRequest(`/api/services/logs?scope=${state.scope}&unit=${encodeURIComponent(unit)}&lines=120`);
      $("sysdLogs").textContent = data.text || "(no log entries)";
    } catch (error) {
      $("sysdLogs").textContent = `Could not read logs: ${error.message}`;
    }
  }

  let toastTimer = null;
  function showToast(title, detail, tone = "") {
    const el = $("sysdToast") || document.createElement("div");
    el.id = "sysdToast";
    el.className = `sysd-toast ${tone}`;
    el.innerHTML = `<b>${esc(title)}</b>${detail ? `<span>${esc(detail)}</span>` : ""}`;
    if (!el.parentNode) document.body.appendChild(el);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
  }

  function setChip(chip) {
    if (chip === "timers" && !state.features.timers) return;
    state.chip = chip;
    document.querySelectorAll("#sysdChips button").forEach((button) => button.classList.toggle("is-active", button.dataset.chip === chip));
    render();
  }

  function wire() {
    const details = $("servicesControl");
    details.addEventListener("toggle", () => {
      if (!details.open) {
        if (state.timer) clearInterval(state.timer);
        state.timer = null;
        return;
      }
      load();
      if (state.timer) clearInterval(state.timer);
      state.timer = setInterval(load, 10000);
    });

    $("sysdScope").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-scope]");
      if (!button) return;
      state.scope = button.dataset.scope;
      applyScopes();
      load();
    });
    $("sysdChips").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-chip]");
      if (button) setChip(button.dataset.chip);
    });
    $("sysdFilter").addEventListener("input", (event) => { state.filter = event.target.value; render(); });
    $("sysdRefresh").addEventListener("click", load);
    $("sysdList").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-act]");
      if (!button) return;
      if (button.dataset.act === "logs") showLogs(button.dataset.unit);
      else action(button.dataset.unit, button.dataset.act);
    });
    $("sysdLogsClose").addEventListener("click", () => { $("sysdLogsPanel").hidden = true; state.logUnit = ""; });
    $("sysdLogsRefresh").addEventListener("click", () => { if (state.logUnit) showLogs(state.logUnit); });
  }

  let wired = false;
  async function boot(attempt = 0) {
    if (!wired) { wire(); wired = true; }
    const details = $("servicesControl");
    try {
      const platform = await backendRequest("/api/platform");
      state.available = !!platform.services;
      state.manager = platform.service_manager || "services";
      state.scopes = platform.service_scopes?.length ? platform.service_scopes : ["user"];
      if (!state.scopes.includes(state.scope)) state.scope = state.scopes[0];
      applyScopes();
    } catch (error) {
      // The sidecar can still be starting when the page first mounts.
      if (attempt < 10) {
        setTimeout(() => boot(attempt + 1), Math.min(2000, 500 + attempt * 250));
        return;
      }
      state.available = false;
    }
    details.hidden = !state.available;
  }

  window.orqella.ready(() => boot());
})();
