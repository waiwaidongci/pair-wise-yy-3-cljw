// 路由模块：HTTP 接口与页面。判定在 rules.js，持久化与编排在 store.js。

import http from "node:http";
import {
  taskSteps,
  statuses,
  getState,
  createSample,
  addSlice,
  logStep,
  editSampleIdentity,
  renameSlice,
  checkIn,
  addReading,
  confirmTransfer,
  cancelTransfer,
  createTransfer,
  deliverSample,
  HttpError
} from "./store.js";

const port = Number(process.env.PORT || 3025);

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>岩芯切片实验室 · 恒温柜位</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --ok:#3e7d45; --drift:#b07416; --moving:#2f6496; --invalid:#9a3a36; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:26px; } h2,h3 { margin:0 0 10px; }
    main { display:grid; grid-template-columns:390px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; }
    input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:56px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 13px; font-weight:700; cursor:pointer; }
    button.sub { background:#5b6b55; } button.danger { background:var(--invalid); }
    .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:22px; } .stat span { color:var(--muted); font-size:13px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(360px,1fr)); gap:12px; }
    .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 9px; font-size:12px; margin-right:6px; }
    .pill.ok { color:var(--ok); border-color:var(--ok); } .pill.drift { color:var(--drift); border-color:var(--drift); }
    .pill.moving { color:var(--moving); border-color:var(--moving); } .pill.invalid { color:var(--invalid); border-color:var(--invalid); }
    .pill.none { color:var(--muted); }
    .slice { border-top:1px solid var(--line); padding-top:10px; margin-top:10px; display:grid; gap:6px; }
    .cabinet { border:1px dashed var(--line); border-radius:8px; padding:10px; display:grid; gap:6px; background:#fafbf8; }
    .cabinet form { border:0; padding:0; background:transparent; }
    .row2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .slots { display:grid; grid-template-columns:repeat(auto-fill,minmax(130px,1fr)); gap:8px; margin-top:10px; }
    .slot { border:1px solid var(--line); border-radius:6px; padding:8px; font-size:12px; background:#fff; }
    .slot b { display:block; } .slot.free { border-color:var(--ok); }
    .slot.booked { border-color:var(--moving); } .slot.held { border-color:var(--drift); }
    .history { list-style:none; padding:0; margin:6px 0 0; display:grid; gap:4px; }
    .history li { font-size:12px; color:var(--muted); border-left:3px solid var(--line); padding-left:8px; }
    .blocker { color:var(--invalid); font-size:13px; }
    .inline { display:flex; gap:8px; align-items:end; } .inline > div { flex:1; }
    .btns { display:flex; gap:8px; flex-wrap:wrap; }
    @media (max-width:950px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .stats{grid-template-columns:1fr 1fr;} }
  </style>
</head>
<body>
  <header>
    <div><h1>岩芯切片实验室 · 恒温柜位</h1><div class="meta">2–8℃ / 湿度≤60% 合规；温漂待转移，未确认不释放原柜位</div></div>
    <button id="reload">刷新</button>
  </header>
  <main>
    <form id="form">
      <h2>创建岩芯样本</h2>
      <label>项目</label><input name="project" required>
      <label>钻孔编号</label><input name="borehole" required>
      <label>岩芯箱号</label><input name="coreBox" required>
      <label>取样深度</label><input name="depth" required>
      <label>负责人</label><input name="owner" required>
      <label>初始切片编号</label><input name="sliceId" required>
      <label>染色方法</label><input name="method" required>
      <button style="margin-top:12px">保存样本</button>
    </form>
    <section>
      <div class="stats" id="stats"></div>
      <div class="panel">
        <h2>恒温柜位</h2>
        <div class="meta" id="cabinet-summary"></div>
        <div class="slots" id="slots"></div>
      </div>
      <h2 style="margin:16px 0 10px">样本与切片</h2>
      <div class="grid" id="samples"></div>
    </section>
  </main>
  <script>
    const statuses = ${JSON.stringify(statuses)};
    const steps = ${JSON.stringify(taskSteps)};
    const form = document.querySelector("#form");
    const statsEl = document.querySelector("#stats");
    const slotsEl = document.querySelector("#slots");
    const samplesEl = document.querySelector("#samples");
    const cabinetSummary = document.querySelector("#cabinet-summary");
    let state = { samples: [], slots: [], storage: {}, blockers: {}, summary: {} };

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? Object.assign({}, options, { headers: { "Content-Type": "application/json" } }) : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
    function fmt(at) { return at ? new Date(at).toLocaleString("zh-CN", { hour12: false }) : ""; }
    function slotOptions(sampleId, sliceId, excludeId) {
      return state.slots.filter(s => s.free && !s.pending && s.id !== excludeId)
        .map(s => '<option value="' + s.id + '">' + s.id + "（空闲）</option>").join("");
    }
    function storageKey(sampleId, sliceId) { return sampleId + "|" + sliceId; }

    function storagePanel(sample, slice) {
      const st = state.storage[slice.id] || { state: "none", stateLabel: "未入柜", reasons: [], history: [] };
      const key = storageKey(sample.id, slice.id);
      let body = "";
      if (st.state === "none") {
        body =
          '<form data-action="checkin" data-key="' + key + '">' +
          '<label>入柜登记（柜位 / 保管人 / 温度℃ / 湿度%）</label>' +
          '<div class="row2"><select name="slotId" required>' + slotOptions(sample.id, slice.id) + '</select><input name="keeper" placeholder="保管人" required></div>' +
          '<div class="row2"><input name="temp" type="number" step="0.1" placeholder="温度 ℃" required><input name="humidity" type="number" step="0.1" placeholder="湿度 %" required></div>' +
          '<div class="btns"><button>入柜登记</button></div></form>';
      } else if (st.state === "invalid") {
        body = '<div class="blocker">柜位结论已失效：' + st.reasons.map(esc).join("；") + '</div>' +
          '<div class="meta">原柜位已释放，请重新登记入柜。</div>' +
          '<form data-action="checkin" data-key="' + key + '">' +
          '<label>重新入柜</label>' +
          '<div class="row2"><select name="slotId" required>' + slotOptions(sample.id, slice.id) + '</select><input name="keeper" placeholder="保管人" required></div>' +
          '<div class="row2"><input name="temp" type="number" step="0.1" placeholder="温度 ℃" required><input name="humidity" type="number" step="0.1" placeholder="湿度 %" required></div>' +
          '<button>重新登记</button></form>';
      } else if (st.state === "moving") {
        const t = st.pendingTransfer;
        body = '<div class="meta">转移待确认（原柜位 <b>' + esc(t.fromSlotId) + '</b> 未释放，新柜位 <b>' + esc(t.toSlotId) + '</b> 已预约）</div>' +
          '<div class="meta">接收人 ' + esc(t.receiver) + ' · 原因：' + esc(t.reason) + '</div>' +
          '<form data-action="transfer-confirm" data-key="' + key + '" data-tid="' + esc(t.id) + '">' +
          '<label>接收确认：新保管人与实测温湿度</label>' +
          '<div class="row2"><input name="keeper" value="' + esc(t.receiver) + '" required><input name="temp" type="number" step="0.1" value="' + (t.targetReading ? t.targetReading.temp : "") + '" placeholder="温度 ℃" required></div>' +
          '<div class="row2"><input name="humidity" type="number" step="0.1" value="' + (t.targetReading ? t.targetReading.humidity : "") + '" placeholder="湿度 %" required><span></span></div>' +
          '<div class="btns"><button>确认转移</button><button type="button" class="danger" data-action-x="transfer-cancel" data-tid="' + esc(t.id) + '">撤销转移</button></div></form>';
      } else {
        const a = st.assignment;
        const r = st.reading || {};
        body = '<div class="meta">柜位 <b>' + esc(a.slotId) + '</b> · 保管人 ' + esc(a.keeper) + ' · 入柜 ' + fmt(a.checkedInAt) + '</div>' +
          '<div class="meta">最新登记：' + esc(r.temp) + '℃ / ' + esc(r.humidity) + '%（' + fmt(r.at) + '）</div>' +
          (st.state === "drift" ? '<div class="blocker">' + st.reasons.map(esc).join("；") + '，不可交付，请登记温漂转移</div>' : "") +
          '<form data-action="reading" data-key="' + key + '"><label>温湿度复查</label>' +
          '<div class="row2"><input name="temp" type="number" step="0.1" placeholder="温度 ℃" required><input name="humidity" type="number" step="0.1" placeholder="湿度 %" required></div>' +
          '<button class="sub">提交复查</button></form>';
        const options = slotOptions(sample.id, slice.id, a.slotId);
        body += '<form data-action="transfer" data-key="' + key + '">' +
          '<label>' + (st.state === "drift" ? "温漂转移登记" : "转移登记（当前合规）") + '</label>' +
          '<div class="row2"><select name="toSlotId" required>' + options + '</select><input name="receiver" placeholder="接收人" required></div>' +
          '<input name="reason" placeholder="转移原因" required>' +
          '<div class="row2"><input name="temp" type="number" step="0.1" placeholder="新柜位温度 ℃" required><input name="humidity" type="number" step="0.1" placeholder="新柜位湿度 %" required></div>' +
          '<button>申请转移</button></form>';
      }
      body += '<ul class="history">' + (st.history || []).map(h =>
        '<li><b>' + esc(h.label) + '</b> · ' + esc(h.text) + ' <span class="meta">' + fmt(h.at) + '</span></li>').join("") + '</ul>';
      return '<div class="cabinet"><span class="pill ' + esc(st.state) + '">' + esc(st.stateLabel) + '</span>' + body + '</div>';
    }

    function render() {
      const s = state.summary || {};
      statsEl.innerHTML = statuses.map(name =>
        '<div class="stat"><span>' + name + '</span><strong>' + state.samples.filter(item => item.status === name).length + '</strong></div>').join("");
      cabinetSummary.textContent = "共 " + s.slotsTotal + 柜位，空闲 " + s.slotsFree + "，转移预约 " + (s.slotsPending || 0) +
        "；切片 " + s.slicesTotal + " 片，待转移 " + (s.drifting || 0) + "，转移中 " + (s.moving || 0) + "，失效 " + (s.invalid || 0);
      slotsEl.innerHTML = state.slots.map(slot => {
        const cls = slot.free ? (slot.pending ? "booked" : "free") : "held";
        const detail = slot.holder ? "占用：" + esc(slot.holder.sliceId) : slot.pending ? "预约：" + esc(slot.pending.sliceId) + (slot.pending.direction === "in" ? "（转入）" : "（转出）") : "空闲";
        return '<div class="slot ' + cls + '"><b>' + esc(slot.id) + '</b>' + detail + '</div>';
      }).join("");

      samplesEl.innerHTML = state.samples.map(sample => {
        const blockers = state.blockers[sample.id] || [];
        const head = '<h3>' + esc(sample.project) + '</h3>' +
          '<div><span class="pill">' + esc(sample.status) + '</span><span class="pill">' + esc(sample.delivery) + '</span></div>' +
          '<form class="inline" data-action="edit-sample" data-sid="' + esc(sample.id) + '">' +
          '<div><label>钻孔编号</label><input name="borehole" value="' + esc(sample.borehole) + '" required></div>' +
          '<div><label>岩芯箱号</label><input name="coreBox" value="' + esc(sample.coreBox) + '" required></div>' +
          '<button class="sub">保存身份</button></form>' +
          '<div class="meta">' + esc(sample.borehole) + " · " + esc(sample.coreBox) + " · " + esc(sample.depth) + " · " + esc(sample.owner) + '</div>';
        const slices = sample.slices.map(slice => {
          const key = storageKey(sample.id, slice.id);
          return '<div class="slice"><b>' + esc(slice.id) + '</b><div class="meta">' + esc(slice.method) + ' · 当前步骤 ' + esc(slice.status) + '</div>' +
            '<form class="inline" data-action="rename-slice" data-key="' + key + '"><div><label>切片编号变更（柜位结论将失效）</label><input name="nextSliceId" value="' + esc(slice.id) + '" required></div><button class="sub">改号</button></form>' +
            storagePanel(sample, slice) +
            '<form data-action="log" data-key="' + key + '"><label>制片步骤</label>' +
            '<div class="row2"><select name="step">' + steps.map(step => '<option' + (step === slice.status ? ' selected' : '') + '>' + step + '</option>').join("") + '</select><span></span></div>' +
            '<textarea name="note" placeholder="步骤备注或观察结果"></textarea><button class="sub">记录步骤</button></form>' +
            '</div>';
        }).join("");
        const add = '<form class="inline" data-action="add-slice" data-sid="' + esc(sample.id) + '">' +
          '<div><label>新增切片编号</label><input name="id" required></div>' +
          '<div><label>染色方法</label><input name="method" placeholder="未指定"></div>' +
          '<button>添加切片</button></form>';
        const deliver = blockers.length
          ? '<div class="blocker">不可交付：' + blockers.map(esc).join("；") + '</div><button class="danger" data-deliver="' + esc(sample.id) + '" disabled style="opacity:.5">标记交付（已锁定）</button>'
          : '<div class="meta">全部切片温湿度合规，可交付。</div><button data-deliver="' + esc(sample.id) + '">标记交付</button>';
        return '<article class="card">' + head + slices + add + deliver + '</article>';
      }).join("");
    }

    async function load() { state = await api("/api/state"); render(); }
    document.querySelector("#reload").onclick = load;
    form.onsubmit = async event => {
      event.preventDefault();
      try {
        await api("/api/samples", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        form.reset(); await load();
      } catch (e) { alert(e.message); }
    };

    function keyParts(key) {
      const parts = key.split("|");
      return { sampleId: parts[0], sliceId: parts[1] };
    }
    async function postFor(action, key, payload, tid) {
      const { sampleId, sliceId } = keyParts(key);
      let path;
      if (action === "checkin") path = "/api/samples/" + sampleId + "/slices/" + sliceId + "/checkin";
      else if (action === "reading") path = "/api/samples/" + sampleId + "/slices/" + sliceId + "/readings";
      else if (action === "transfer") path = "/api/samples/" + sampleId + "/slices/" + sliceId + "/transfers";
      else if (action === "transfer-confirm") path = "/api/samples/" + sampleId + "/slices/" + sliceId + "/transfers/" + tid + "/confirm";
      else if (action === "log") path = "/api/samples/" + sampleId + "/slices/" + sliceId + "/logs";
      else if (action === "rename-slice") path = "/api/samples/" + sampleId + "/slices/" + sliceId;
      const method = action === "rename-slice" ? "PATCH" : "POST";
      return api(path, { method, body: JSON.stringify(payload) });
    }

    samplesEl.addEventListener("submit", async event => {
      const targetForm = event.target;
      if (!targetForm.dataset.action) return;
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(targetForm).entries());
      try {
        if (targetForm.dataset.action === "add-slice") {
          await api("/api/samples/" + targetForm.dataset.sid + "/slices", { method: "POST", body: JSON.stringify(payload) });
        } else if (targetForm.dataset.action === "edit-sample") {
          await api("/api/samples/" + targetForm.dataset.sid, { method: "PATCH", body: JSON.stringify(payload) });
        } else {
          await postFor(targetForm.dataset.action, targetForm.dataset.key, payload, targetForm.dataset.tid);
        }
        await load();
      } catch (e) { alert(e.message); }
    });

    samplesEl.addEventListener("click", async event => {
      const btn = event.target.closest("button");
      if (!btn) return;
      try {
        if (btn.dataset.deliver) {
          if (btn.disabled) return;
          await api("/api/samples/" + btn.dataset.deliver + "/deliver", { method: "POST", body: "{}" });
          await load();
        } else if (btn.dataset.actionX === "transfer-cancel") {
          const holder = btn.closest("form");
          const { sampleId, sliceId } = keyParts(holder.dataset.key);
          const reason = window.prompt("撤销原因（可留空）", "");
          if (reason === null) return;
          await api("/api/samples/" + sampleId + "/slices/" + sliceId + "/transfers/" + btn.dataset.tid + "/cancel",
            { method: "POST", body: JSON.stringify({ reason: reason || "接收前取消" }) });
          await load();
        }
      } catch (e) { alert(e.message); }
    });

    load();
  </script>
</body>
</html>`;

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (req.method === "GET" && p === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && p === "/api/state") return sendJson(res, 200, await getState());
    if (req.method === "GET" && p === "/api/samples") return sendJson(res, 200, await getState());

    if (req.method === "POST" && p === "/api/samples") {
      return sendJson(res, 201, await createSample(await readBody(req)));
    }

    let m;
    if (req.method === "POST" && (m = p.match(/^\/api\/samples\/([^/]+)\/slices$/))) {
      return sendJson(res, 201, await addSlice(m[1], await readBody(req)));
    }
    if (req.method === "PATCH" && (m = p.match(/^\/api\/samples\/([^/]+)$/))) {
      return sendJson(res, 200, await editSampleIdentity(m[1], await readBody(req)));
    }
    if (req.method === "POST" && (m = p.match(/^\/api\/samples\/([^/]+)\/deliver$/))) {
      return sendJson(res, 200, await deliverSample(m[1]));
    }
    if (req.method === "PATCH" && (m = p.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)$/))) {
      return sendJson(res, 200, await renameSlice(m[1], m[2], await readBody(req)));
    }
    if (req.method === "POST" && (m = p.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/logs$/))) {
      return sendJson(res, 200, await logStep(m[1], m[2], await readBody(req)));
    }
    if (req.method === "POST" && (m = p.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/checkin$/))) {
      return sendJson(res, 201, await checkIn(m[1], m[2], await readBody(req)));
    }
    if (req.method === "POST" && (m = p.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/readings$/))) {
      return sendJson(res, 200, await addReading(m[1], m[2], await readBody(req)));
    }
    if (req.method === "POST" && (m = p.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/transfers$/))) {
      return sendJson(res, 201, await createTransfer(m[1], m[2], await readBody(req)));
    }
    if (req.method === "POST" && (m = p.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/transfers\/([^/]+)\/confirm$/))) {
      return sendJson(res, 200, await confirmTransfer(m[1], m[2], m[3], await readBody(req)));
    }
    if (req.method === "POST" && (m = p.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/transfers\/([^/]+)\/cancel$/))) {
      return sendJson(res, 200, await cancelTransfer(m[1], m[2], m[3], await readBody(req)));
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(error);
    sendJson(res, status, { error: error.message || "服务器错误" });
  }
});

server.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${port}`));
