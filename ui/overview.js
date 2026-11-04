(() => {
  const $ = (id) => document.getElementById(id);
  const bytes = (n) => { const u=["B","KiB","MiB","GiB","TiB"]; let v=n||0,i=0; while(v>=1024&&i<u.length-1){v/=1024;i++;} return `${v.toFixed(i?1:0)} ${u[i]}`; };
  let context = { node: { name: "local" }, config: {} };
  const tick = async () => {
    try {
      const m = await window.orqella.call("system.metrics", { node: context.node?.id || "local" });
      $("host").textContent = m.hostname;
      $("cpu").textContent = `${Math.round(m.cpu_percent)}%`;
      $("mem").textContent = `${Math.round(m.memory_percent || 0)}%`;
      $("load").textContent = (m.load_one || 0).toFixed(2);
      $("updated").textContent = `updated ${new Date(m.captured_at).toLocaleTimeString()} · ${bytes(m.memory_used)} / ${bytes(m.memory_total)}`;
      $("node").textContent = context.node?.name || "local";
      $("state").textContent = "live"; $("state").classList.add("ok");
      try { const nodes = await window.orqella.call("nodes.list"); $("machines").textContent = `${nodes.filter((n) => n.online).length}/${nodes.length}`; } catch { $("machines").textContent = "–"; }
    } catch (error) { $("state").textContent = "offline"; $("state").classList.remove("ok"); $("updated").textContent = error.message; }
  };
  window.orqella.ready((ctx) => { context = ctx; tick(); setInterval(() => { if (!document.hidden) tick(); }, 5000); });
})();
