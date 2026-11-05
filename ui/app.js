(() => {
  const $ = (id) => document.getElementById(id);
  const defaults = { refresh_ms: 3000, show_cores: true, show_disks: true, show_network: true, show_temperatures: true, show_gpus: true, show_batteries: true, show_machines: true, compact: false, cpu_warn: 85, memory_warn: 85, disk_warn: 90 };
  let context = { node: { id: "local", name: "local" }, config: {} };
  let cfg = { ...defaults };
  let timer = null;
  const pct = (n) => `${Math.round(n || 0)}%`;
  const bytes = (n) => { const u=["B","KiB","MiB","GiB","TiB"]; let v=Number(n)||0,i=0; while(v>=1024&&i<u.length-1){v/=1024;i++;} return `${v.toFixed(i?1:0)} ${u[i]}`; };
  const rate = (n) => `${bytes(n)}/s`;
  const uptime = (s) => { const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60); return d?`${d}d ${h}h`:h?`${h}h ${m}m`:`${m}m`; };
  const warnClass = (value, threshold) => value >= threshold ? "bad" : value >= threshold * .8 ? "warn" : "";
  const setMeter = (id, value, threshold) => { const bar=$(id); bar.style.width=`${Math.min(100,value||0)}%`; bar.style.background = value >= threshold ? "var(--red)" : value >= threshold*.8 ? "var(--amber)" : ""; };
  const nodeLabel = () => context.node?.name || "local";

  async function tick() {
    try {
      const m = await window.orqella.call("system.metrics", { node: context.node?.id || "local" });
      $("host").textContent = m.hostname;
      $("node-label").textContent = nodeLabel() === m.hostname ? "" : nodeLabel();
      $("cpu-value").textContent = pct(m.cpu_percent);
      $("cpu-value").className = warnClass(m.cpu_percent, cfg.cpu_warn);
      setMeter("cpu-bar", m.cpu_percent, cfg.cpu_warn);
      $("cpu-detail").textContent = `${m.cpu_count} logical cores`;
      const memPct = m.memory_percent || 0;
      $("mem-value").textContent = pct(memPct);
      $("mem-value").className = warnClass(memPct, cfg.memory_warn);
      setMeter("mem-bar", memPct, cfg.memory_warn);
      $("mem-detail").textContent = `${bytes(m.memory_used)} of ${bytes(m.memory_total)}`;
      const swapPct = m.swap_percent || 0;
      $("swap-value").textContent = m.swap_total ? pct(swapPct) : "none";
      $("swap-bar").style.width = `${Math.min(100,swapPct)}%`;
      $("swap-detail").textContent = m.swap_total ? `${bytes(m.swap_used)} of ${bytes(m.swap_total)}` : "no swap configured";
      const loadSupported = !/windows/i.test(m.os || "");
      $("load-value").textContent = loadSupported ? (m.load_one || 0).toFixed(2) : "–";
      $("load-detail").textContent = loadSupported ? `${m.load_one.toFixed(2)} · ${m.load_five.toFixed(2)} · ${m.load_fifteen.toFixed(2)}` : "";
      $("uptime").textContent = uptime(m.uptime_secs);
      $("kernel").textContent = m.kernel || m.os;
      $("processes").textContent = m.processes;
      $("captured").textContent = `updated ${new Date(m.captured_at).toLocaleTimeString()}`;
      $("platform").textContent = `${m.os} · ${m.arch}`;
      $("health").classList.add("ok"); $("health").innerHTML = "<span></span><b>Live</b>";
      if (cfg.compact) $("systemModule").classList.add("compact"); else $("systemModule").classList.remove("compact");
      renderCores(m.cpu_cores || [], cfg.cpu_warn);
      renderDisks(m.disks || [], cfg.disk_warn);
      renderNetwork(m.networks || []);
      renderTemps(m.temperatures || []);
      renderGpus(m.gpus || []);
      renderBatteries(m.batteries || []);
      if (cfg.show_machines) { try { renderMachines(await window.orqella.call("nodes.list")); } catch { renderMachines([]); } }
    } catch (error) {
      $("health").classList.remove("ok"); $("health").innerHTML = "<span></span><b>Offline</b>"; $("captured").textContent = error.message || "unable to reach node";
    }
  }

  function renderCores(cores, threshold) {
    const section=$("cores-section"); section.hidden = !cfg.show_cores || !cores.length;
    if (section.hidden) return;
    $("core-summary").textContent = `${cores.length} cores · avg ${pct(cores.reduce((a,b)=>a+b,0)/cores.length)}`;
    $("cores").innerHTML = cores.map((value,index) => { const load=Math.round(Math.max(8,Math.min(90,value))); return `<div class="core" title="Core ${index}: ${pct(value)}" style="background:color-mix(in srgb,var(--mint) ${load}%,var(--bg-inset));color:${value>70?'var(--accent-ink)':'var(--ink)'}">${index}</div>`; }).join("");
  }
  function renderMachines(nodes) {
    const section=$("machines-section"); section.hidden = !cfg.show_machines;
    if (section.hidden) return;
    $("machines").innerHTML = nodes.length ? nodes.map(n => `<div class="machine"><div><b>${escape(n.name)}</b><small>${n.local?"this machine":`${n.latency_ms||0} ms`}</small></div><span class="dot ${n.online?"online":""}"></span></div>`).join("") : `<div class="empty">No machines configured.</div>`;
  }
  function renderDisks(disks, threshold) {
    const section=$("disks-section"); section.hidden = !cfg.show_disks || !disks.length;
    if (section.hidden) return;
    $("disks").innerHTML = disks.sort((a,b)=>b.total-a.total).slice(0,8).map(d => `<div class="disk"><div class="disk-top"><b>${escape(d.mount)}</b><small>${escape(d.name)} · ${bytes(d.used)} / ${bytes(d.total)} · ${Math.round(d.percent)}%</small></div><div class="meter"><i style="width:${Math.min(100,d.percent)}%;background:${d.percent>=threshold?'var(--red)':d.percent>=threshold*.8?'var(--amber)':'linear-gradient(90deg,var(--mint),var(--mint-dim))'}"></i></div></div>`).join("");
  }
  function renderNetwork(networks) {
    const section=$("network-section"); section.hidden = !cfg.show_network || !networks.length;
    if (section.hidden) return;
    const rx=networks.reduce((a,n)=>a+n.received_rate,0), tx=networks.reduce((a,n)=>a+n.transmitted_rate,0);
    $("net-total").textContent = `${rate(rx)} in · ${rate(tx)} out`;
    $("networks").innerHTML = networks.map(n => `<div class="network"><div class="network-top"><b>${escape(n.interface)}</b><small>↓ ${rate(n.received_rate)} · ↑ ${rate(n.transmitted_rate)}</small></div></div>`).join("");
  }
  function renderTemps(temps) { const section=$("temps-section"); section.hidden=!cfg.show_temperatures||!temps.length; if(section.hidden)return; $("temps").innerHTML=temps.map(t=>`<span class="pill">${escape(t.label)} <b>${Math.round(t.current)}°C</b></span>`).join(""); }
  function renderGpus(gpus) { const section=$("gpus-section"); section.hidden=!cfg.show_gpus||!gpus.length; if(section.hidden)return; $("gpus").innerHTML=gpus.map(g=>`<span class="pill">${escape(g.name)} ${g.driver?`· ${escape(g.driver)}`:""} ${g.busy!=null?`<b>${g.busy}%</b>`:""} ${g.temperature!=null?`<b>${Math.round(g.temperature)}°C</b>`:""}</span>`).join(""); }
  function renderBatteries(batteries) { const section=$("batteries-section"); section.hidden=!cfg.show_batteries||!batteries.length; if(section.hidden)return; $("batteries").innerHTML=batteries.map(b=>`<span class="pill">${escape(b.name)} <b>${b.percent!=null?`${Math.round(b.percent)}%`:"–"}</b> ${escape(b.status)}</span>`).join(""); }
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

  window.orqella.ready((ctx) => {
    context = ctx; cfg = { ...defaults, ...(ctx.config || {}) };
    $("node-label").textContent = nodeLabel();
    tick();
    const interval = Math.max(1000, Number(cfg.refresh_ms) || 3000);
    if (timer) clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) tick(); }, interval);
  });
})();
