// 页面模块：单页界面。列表、柜位台、转移台、履历均由 /api/state 同一份数据渲染
export function buildPage(statuses, taskSteps) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>岩芯切片实验室 · 恒温柜与温漂转移台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --stone:#73706a; --warn:#9a6a16; --bad:#9c3b32; --ok:#3d6b46; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:24px; } main { padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:54px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; }
    button.ghost { background:#fff; color:var(--accent); border:1px solid var(--accent); } button.warn { background:var(--warn); } button.bad { background:var(--bad); } button:disabled { opacity:.45; cursor:not-allowed; }
    .tabs { display:flex; gap:8px; margin-bottom:16px; } .tabs button { background:#e5e9e0; color:var(--ink); } .tabs button.active { background:var(--accent); color:#fff; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:22px; } .stat span { color:var(--muted); font-size:13px; }
    .lab-grid { display:grid; grid-template-columns:370px 1fr; gap:18px; align-items:start; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; margin-right:5px; }
    .pill.ok { background:#eef5ec; color:var(--ok); border-color:#b9d0b4; } .pill.drift { background:#fbf1dd; color:var(--warn); border-color:#e4cf9c; }
    .pill.stale { background:#f7e7e4; color:var(--bad); border-color:#dfb3ac; } .pill.moving { background:#e8eef5; color:#34507e; border-color:#b7c6dd; } .pill.off { color:var(--muted); }
    .slice { border-top:1px solid var(--line); padding-top:10px; display:grid; gap:6px; }
    .row { display:flex; gap:6px; flex-wrap:wrap; align-items:center; } .row > * { flex:1 1 auto; } .row > button { flex:0 0 auto; }
    .cabinet-board { margin-top:18px; } .cabinet { margin-bottom:14px; } .cabinet h3 { margin:10px 0 8px; font-size:15px; color:var(--stone); }
    .slots { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:8px; }
    .slot { border:1px solid var(--line); border-radius:6px; padding:8px 10px; background:#fafbf8; font-size:12px; } .slot b { display:block; }
    .slot.free { border-style:dashed; color:var(--muted); } .slot.taken { background:#eef5ec; border-color:#b9d0b4; } .slot.reserved { background:#e8eef5; border-color:#b7c6dd; }
    .timeline { display:grid; gap:8px; } .ev { border-left:3px solid var(--accent); background:#fff; border:1px solid var(--line); border-left-width:3px; border-radius:6px; padding:9px 12px; font-size:13px; }
    .trf { border:1px solid var(--line); border-radius:8px; background:#fff; padding:12px 14px; margin-bottom:10px; display:grid; gap:6px; }
    .blockers { color:var(--bad); font-size:12px; } .hidden { display:none; }
    @media (max-width:950px){ header{display:block;padding:18px 16px;} main{padding:16px;} .lab-grid{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header>
    <div><h1>岩芯切片实验室</h1><div class="meta">恒温柜位 · 温漂转移台 · 每片一个柜位，不可重复分配</div></div>
    <button id="reload">刷新</button>
  </header>
  <main>
    <div class="tabs">
      <button data-tab="lab" class="active">实验台与柜位</button>
      <button data-tab="transfer">温漂转移台</button>
      <button data-tab="history">履历</button>
    </div>

    <section id="view-lab">
      <div class="lab-grid">
        <form id="form" class="panel">
          <h2>创建岩芯样本</h2>
          <label>项目</label><input name="project" required>
          <label>钻孔编号</label><input name="borehole" required>
          <label>岩芯箱号</label><input name="coreBox" required>
          <label>取样深度</label><input name="depth" required>
          <label>负责人</label><input name="owner" required>
          <label>初始切片编号</label><input name="sliceId" required>
          <label>染色方法</label><input name="method" required>
          <button>保存样本</button>
        </form>
        <div>
          <div class="stats" id="stats"></div>
          <div class="grid" id="samples"></div>
        </div>
      </div>
      <div class="panel cabinet-board"><h2>恒温柜位（2~8℃，湿度≤60%）</h2><div id="cabinets"></div></div>
    </section>

    <section id="view-transfer" class="hidden">
      <div class="panel" style="margin-bottom:14px"><h2>待确认转移（原柜位未释放）</h2><div id="pending"></div></div>
      <div class="panel"><h2>已确认转移</h2><div id="confirmed"></div></div>
    </section>

    <section id="view-history" class="hidden">
      <div class="panel"><h2>操作履历</h2><div class="timeline" id="events"></div></div>
    </section>
  </main>
  <script>
    const statuses = ${JSON.stringify(statuses)};
    const steps = ${JSON.stringify(taskSteps)};
    let view = { samples: [], slots: [], transfers: [], events: [] };
    const $ = sel => document.querySelector(sel);
    const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
    const dt = s => s ? new Date(s).toLocaleString("zh-CN", { hour12:false }) : "";

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ? errText(data.error) : "请求失败");
      return data;
    }
    function errText(code) {
      return {
        slot_occupied:"柜位已被占用或预留", already_stored:"该切片已在柜，请先转出或复检",
        transfer_pending:"该切片已有待确认转移", not_stored:"切片尚未入柜",
        storage_stale:"编号信息已变化，柜位结论失效，请重新登记", source_changed:"原柜位状态已变化",
        not_deliverable:"存在不可交付的切片", sample_id_duplicated:"样本编号重复",
        slice_id_duplicated:"切片编号重复"
      }[code] || code;
    }
    function slotLabel(id){ return id; }
    function freeSlotOptions(sampleId, sliceId, excludeId) {
      return view.slots.filter(s => {
        if (s.id === excludeId) return false;
        if (!s.occupant) return true;
        return s.occupant.kind === "storage" && s.occupant.sampleId === sampleId && s.occupant.sliceId === sliceId;
      }).map(s => '<option value="'+esc(s.id)+'">'+esc(s.id)+'</option>').join("");
    }

    function renderStats() {
      const allSlices = view.samples.flatMap(s => s.slices);
      const cards = [
        ...statuses.map(s => [s, view.samples.filter(x => x.status === s).length]),
        ["空柜位", view.slots.filter(s => !s.occupant).length],
        ["待确认转移", view.transfers.filter(t => t.status === "待确认").length],
        ["温漂待转移", allSlices.filter(x => x.state === "待转移").length],
        ["结论失效", allSlices.filter(x => x.state === "结论失效").length]
      ];
      $("#stats").innerHTML = cards.map(c => '<div class="stat"><span>'+c[0]+'</span><strong>'+c[1]+'</strong></div>').join("");
    }

    function statePill(slice) {
      const map = { "合格":"ok", "待转移":"drift", "结论失效":"stale", "转移待确认":"moving", "未入柜":"off" };
      return '<span class="pill '+map[slice.state]+'">'+esc(slice.state)+'</span>';
    }

    function storageActions(sample, slice) {
      const sid = sample.id + "|" + slice.id;
      if (slice.transfer) {
        const t = slice.transfer;
        return '<div class="trf"><b>转移待确认 '+esc(t.id)+'</b>'
          + '<div class="meta">'+esc(t.fromSlotId)+' → '+esc(t.toSlotId)+' · 接收人 '+esc(t.receiver)+' · '+esc(t.temperature)+'℃ / '+esc(t.humidity)+'% · 新柜判定 '+esc(t.verdict)+'</div>'
          + '<div class="meta">原因：'+esc(t.reason)+'</div>'
          + '<div class="row"><button data-act="transfer-confirm" data-ref="'+esc(sid)+'" data-tid="'+esc(t.id)+'">确认转移</button>'
          + '<button class="bad" data-act="transfer-cancel" data-ref="'+esc(sid)+'" data-tid="'+esc(t.id)+'">取消（不留记录）</button></div></div>';
      }
      if (!slice.storage) {
        return '<div class="row"><select data-f="slotId">'+freeSlotOptions(sample.id, slice.id).replace('<option', '<option selected hidden value="">选择柜位</option><option')+'</select></div>'
          + '<div class="row"><input type="number" step="0.1" data-f="temperature" placeholder="温度℃"><input type="number" step="0.1" data-f="humidity" placeholder="湿度%"><input data-f="custodian" placeholder="保管人"></div>'
          + '<button data-act="store" data-ref="'+esc(sid)+'">入柜登记</button>';
      }
      const s = slice.storage;
      let html = '<div class="meta">柜位 '+esc(s.slotId)+' · '+esc(s.temperature)+'℃ / '+esc(s.humidity)+'% · 保管人 '+esc(s.custodian)+' · 判定 '+esc(s.verdict)+'</div>';
      if (slice.stale) html += '<div class="blockers">样本编号、钻孔、岩芯箱或切片编号已变化，柜位结论失效：重新登记后方可交付。</div>';
      html += '<div class="row"><button class="ghost" data-act="toggle-restore" data-ref="'+esc(sid)+'">重新登记/复检</button>'
        + '<button class="warn" data-act="toggle-transfer" data-ref="'+esc(sid)+'">申请转移</button></div>'
        + '<div id="restore-'+btoa(unescape(encodeURIComponent(sid)))+'" class="hidden">'
        + '<div class="row"><select data-f="rSlotId"><option value="">保持原柜位 '+esc(s.slotId)+'</option>'+freeSlotOptions(sample.id, slice.id, s.slotId)+'</select></div>'
        + '<div class="row"><input type="number" step="0.1" data-f="rTemperature" placeholder="温度℃" value="'+esc(s.temperature)+'"><input type="number" step="0.1" data-f="rHumidity" placeholder="湿度%" value="'+esc(s.humidity)+'"><input data-f="rCustodian" placeholder="保管人" value="'+esc(s.custodian)+'"></div>'
        + '<button data-act="restorage" data-ref="'+esc(sid)+'">提交复检登记</button></div>'
        + '<div id="transfer-'+btoa(unescape(encodeURIComponent(sid)))+'" class="hidden">'
        + '<div class="row"><select data-f="tSlotId">'+freeSlotOptions(sample.id, slice.id, s.slotId).replace('<option', '<option selected hidden value="">选择新柜位</option><option')+'</select></div>'
        + '<div class="row"><input type="number" step="0.1" data-f="tTemperature" placeholder="新柜温度℃"><input type="number" step="0.1" data-f="tHumidity" placeholder="新柜湿度%"></div>'
        + '<div class="row"><input data-f="receiver" placeholder="接收人"><input data-f="reason" placeholder="转移原因（如超温）"></div>'
        + '<button class="warn" data-act="transfer-request" data-ref="'+esc(sid)+'">登记转移（仅预留柜位）</button></div>';
      return html;
    }

    function renderSamples() {
      $("#samples").innerHTML = view.samples.map(sample => {
        const blockers = sample.deliveryBlockers || [];
        const delivered = sample.delivery === "已交付";
        let html = '<article class="card"><div class="row" style="justify-content:space-between"><h3 style="margin:0">'+esc(sample.project)+'</h3>'
          + '<span class="pill">'+esc(sample.status)+'</span></div>'
          + '<div class="meta">'+esc(sample.id)+' · '+esc(sample.borehole)+' · '+esc(sample.coreBox)+' · '+esc(sample.depth)+' · '+esc(sample.owner)+'</div>'
          + '<div class="row"><button class="ghost" data-act="edit-sample" data-sid="'+esc(sample.id)+'">改编号/钻孔/岩芯箱</button>'
          + (delivered ? '<span class="pill ok">已交付</span>' : '<button data-act="deliver" data-sid="'+esc(sample.id)+'"'+(blockers.length?' disabled':'')+'>标记交付</button>')+'</div>';
        if (blockers.length) html += '<div class="blockers">不可交付：'+blockers.map(b => esc(b.sliceId)+'（'+esc(b.reason)+'）').join("；")+'</div>';
        html += sample.slices.map(slice =>
          '<div class="slice"><div class="row" style="justify-content:space-between"><b>'+esc(slice.id)+'</b>'+statePill(slice)+'</div>'
          + '<div class="meta">'+esc(slice.method)+' · 制片步骤 '+esc(slice.status)+'</div>'
          + storageActions(sample, slice)
          + '<div class="row"><button class="ghost" data-act="edit-slice" data-ref="'+esc(sample.id+"|"+slice.id)+'">改切片编号</button></div>'
          + '<div class="row"><select data-step="'+esc(sample.id+"|"+slice.id)+'">'+steps.map(st => '<option '+(st===slice.status?'selected':'')+'>'+st+'</option>').join("")+'</select>'
          + '<input data-note="'+esc(sample.id+"|"+slice.id)+'" placeholder="步骤备注/观察结果"></div>'
          + '<button data-act="log" data-ref="'+esc(sample.id+"|"+slice.id)+'">记录步骤</button>'
          + '<div class="meta">'+slice.logs.map(l => esc(l.step)+"："+esc(l.note)).join(" / ")+'</div></div>'
        ).join("");
        html += '<div class="row"><input data-new-slice="'+esc(sample.id)+'" placeholder="新切片编号"><input data-method="'+esc(sample.id)+'" placeholder="染色方法">'
          + '<button data-act="add-slice" data-sid="'+esc(sample.id)+'">添加切片</button></div></article>';
        return html;
      }).join("");
    }

    function renderCabinets() {
      const groups = {};
      view.slots.forEach(s => { (groups[s.cabinet] = groups[s.cabinet] || []).push(s); });
      $("#cabinets").innerHTML = Object.keys(groups).sort().map(cab =>
        '<div class="cabinet"><h3>恒温柜 '+esc(cab)+'</h3><div class="slots">'+groups[cab].map(s => {
          if (!s.occupant) return '<div class="slot free"><b>'+esc(s.id)+'</b>空柜位</div>';
          const o = s.occupant;
          if (o.kind === "reserved") return '<div class="slot reserved"><b>'+esc(s.id)+'</b>已预留<br>'+esc(o.sampleId)+' / '+esc(o.sliceId)+'<br>'+esc(o.refId)+'</div>';
          return '<div class="slot taken"><b>'+esc(s.id)+'</b>'+esc(o.sampleId)+' / '+esc(o.sliceId)+'<br>'+esc(o.verdict)+'</div>';
        }).join("")+'</div></div>'
      ).join("");
    }

    function transferCard(t, confirmed) {
      let html = '<div class="trf"><b>'+esc(t.id)+'</b>'
        + '<div class="meta">'+esc(t.sampleId)+' / '+esc(t.sliceId)+' · '+esc(t.fromSlotId)+' → '+esc(t.toSlotId)+'</div>'
        + '<div class="meta">接收人 '+esc(t.receiver)+' · 新柜 '+esc(t.temperature)+'℃ / '+esc(t.humidity)+'% · 判定 '+esc(t.verdict)+'</div>'
        + '<div class="meta">原因：'+esc(t.reason)+' · 申请于 '+dt(t.requestedAt)+(t.confirmedAt?' · 确认于 '+dt(t.confirmedAt):'')+'</div>';
      if (!confirmed) {
        const ref = t.sampleId+"|"+t.sliceId;
        html += '<div class="row"><button data-act="transfer-confirm" data-ref="'+esc(ref)+'" data-tid="'+esc(t.id)+'">确认转移（释放原柜位）</button>'
          + '<button class="bad" data-act="transfer-cancel" data-ref="'+esc(ref)+'" data-tid="'+esc(t.id)+'">取消</button></div>';
      }
      return html + '</div>';
    }
    function renderTransfers() {
      const pending = view.transfers.filter(t => t.status === "待确认");
      const confirmed = view.transfers.filter(t => t.status === "已确认");
      $("#pending").innerHTML = pending.length ? pending.map(t => transferCard(t, false)).join("") : '<div class="meta">暂无待确认转移</div>';
      $("#confirmed").innerHTML = confirmed.length ? confirmed.map(t => transferCard(t, true)).join("") : '<div class="meta">暂无已确认转移</div>';
    }

    function eventText(e) {
      switch (e.type) {
        case "stored": return (e.transferId ? "转移入柜 " : "入柜 ") + esc(e.slotId) + " · " + esc(e.sliceId) + " · " + esc(e.temperature) + "℃/" + esc(e.humidity) + "% · 保管人 " + esc(e.custodian) + " · 判定 " + esc(e.verdict) + (e.note ? "（" + esc(e.note) + "）" : "");
        case "released": return "释放原柜位 " + esc(e.slotId) + " · " + esc(e.sliceId) + (e.note ? "（" + esc(e.note) + "）" : "");
        case "restored": return "复检重新登记 · " + esc(e.sliceId) + " · " + esc(e.slotId) + " · " + esc(e.temperature) + "℃/" + esc(e.humidity) + "% · 判定 " + esc(e.verdict) + "（" + esc(e.note) + "）";
        case "transfer_confirmed": return "转移确认 " + esc(e.transferId) + " · " + esc(e.sliceId);
        case "identity_changed": return "编号信息变更 · " + esc(e.note);
        case "delivered": return "样本已交付 · " + esc(e.sampleId);
        case "sample_created": return "创建样本 · " + esc(e.sampleId);
        default: return esc(e.type) + " · " + esc(e.refId || "");
      }
    }
    function renderEvents() {
      $("#events").innerHTML = view.events.length
        ? view.events.map(e => '<div class="ev"><b>'+dt(e.at)+'</b><div>'+eventText(e)+'</div></div>').join("")
        : '<div class="meta">暂无履历</div>';
    }

    function render() {
      renderStats(); renderSamples(); renderCabinets(); renderTransfers(); renderEvents();
    }
    async function load() {
      view = await api("/api/state");
      render();
    }

    function fields(container, keys) {
      const out = {};
      keys.forEach(k => { const el = container.querySelector('[data-f="'+k+'"]'); if (el) out[k] = el.value; });
      return out;
    }

    document.body.addEventListener("click", async ev => {
      const btn = ev.target.closest("button[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      try {
        if (act.startsWith("toggle-")) {
          const [sampleId, sliceId] = btn.dataset.ref.split("|");
          const key = act === "toggle-restore" ? "restore" : "transfer";
          const box = document.getElementById(key + "-" + btoa(unescape(encodeURIComponent(btn.dataset.ref))));
          box.classList.toggle("hidden");
          return;
        }
        const ref = btn.dataset.ref ? btn.dataset.ref.split("|") : [];
        const [sampleId, sliceId] = ref;
        const card = btn.closest(".slice") || btn.closest(".trf") || btn.closest(".card");
        if (act === "store") {
          const f = fields(card, ["slotId","temperature","humidity","custodian"]);
          await api("/api/samples/"+sampleId+"/slices/"+sliceId+"/storage", { method:"POST", body: JSON.stringify(f) });
        } else if (act === "restorage") {
          const f = fields(card, ["rSlotId","rTemperature","rHumidity","rCustodian"]);
          await api("/api/samples/"+sampleId+"/slices/"+sliceId+"/restorage", { method:"POST", body: JSON.stringify({ slotId: f.rSlotId || undefined, temperature: f.rTemperature, humidity: f.rHumidity, custodian: f.rCustodian }) });
        } else if (act === "transfer-request") {
          const f = fields(card, ["tSlotId","tTemperature","tHumidity","receiver","reason"]);
          await api("/api/samples/"+sampleId+"/slices/"+sliceId+"/transfers", { method:"POST", body: JSON.stringify({ toSlotId: f.tSlotId, temperature: f.tTemperature, humidity: f.tHumidity, receiver: f.receiver, reason: f.reason }) });
        } else if (act === "transfer-confirm") {
          await api("/api/samples/"+sampleId+"/slices/"+sliceId+"/transfers/"+btn.dataset.tid+"/confirm", { method:"POST", body:"{}" });
        } else if (act === "transfer-cancel") {
          if (!confirm("取消该转移？待确认记录将整体删除，新柜位预留随之释放。")) return;
          await api("/api/samples/"+sampleId+"/slices/"+sliceId+"/transfers/"+btn.dataset.tid+"/cancel", { method:"POST", body:"{}" });
        } else if (act === "deliver") {
          await api("/api/samples/"+btn.dataset.sid+"/deliver", { method:"POST", body:"{}" });
        } else if (act === "add-slice") {
          const sid = btn.dataset.sid;
          await api("/api/samples/"+sid+"/slices", { method:"POST", body: JSON.stringify({ id: document.querySelector('[data-new-slice="'+sid+'"]').value, method: document.querySelector('[data-method="'+sid+'"]').value || "未指定" }) });
        } else if (act === "log") {
          await api("/api/samples/"+sampleId+"/slices/"+sliceId+"/logs", { method:"POST", body: JSON.stringify({ step: document.querySelector('[data-step="'+btn.dataset.ref+'"]').value, note: document.querySelector('[data-note="'+btn.dataset.ref+'"]').value || "步骤完成" }) });
        } else if (act === "edit-sample") {
          const sid = btn.dataset.sid;
          const id = prompt("新样本编号（留空不变）", sid); if (id === null) return;
          const borehole = prompt("新钻孔编号（留空不变）", view.samples.find(s => s.id === sid).borehole); if (borehole === null) return;
          const coreBox = prompt("新岩芯箱号（留空不变）", view.samples.find(s => s.id === sid).coreBox); if (coreBox === null) return;
          await api("/api/samples/"+sid, { method:"PATCH", body: JSON.stringify({ id: id || undefined, borehole: borehole || undefined, coreBox: coreBox || undefined }) });
        } else if (act === "edit-slice") {
          const id = prompt("新切片编号（留空不变）", sliceId); if (!id || id === sliceId) return;
          await api("/api/samples/"+sampleId+"/slices/"+sliceId, { method:"PATCH", body: JSON.stringify({ id }) });
        }
        await load();
      } catch (e) { alert(e.message); }
    });

    document.querySelectorAll(".tabs button").forEach(btn => btn.onclick = () => {
      document.querySelectorAll(".tabs button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      ["lab","transfer","history"].forEach(name => $("#view-"+name).classList.toggle("hidden", name !== btn.dataset.tab));
    });

    $("#form").onsubmit = async ev => {
      ev.preventDefault();
      await api("/api/samples", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData($("#form")).entries())) });
      $("#form").reset(); await load();
    };
    $("#reload").onclick = load;
    load();
  </script>
</body>
</html>`;
}
