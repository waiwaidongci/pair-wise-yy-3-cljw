// 端到端规则验证脚本：迁移旧数据 -> 全流程 API 验证
import { rm } from "node:fs/promises";

const BASE = "http://localhost:3027";
let failures = 0;

function check(name, cond, extra = "") {
  if (cond) console.log("PASS", name);
  else { failures += 1; console.log("FAIL", name, extra); }
}
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json();
  return { status: res.status, data };
}
function st(state, sliceId) { return state.storage[sliceId]; }

// 1) 全新种子启动（预置 AS-1 合规在柜 HG-01），使用独立临时库
const testDb = "/tmp/core-slices-test.json";
await rm(testDb, { force: true });
await rm(testDb + ".tmp", { force: true });

const server = (await import("child_process")).spawn("node", ["server.js"], {
  env: { ...process.env, PORT: "3027", DB_FILE: testDb }, stdio: ["ignore", "ignore", "inherit"]
});
await new Promise(r => setTimeout(r, 600));

try {
  let s = (await call("GET", "/api/state")).data;
  check("种子：HG-01 被占用", s.slots[0].free === false && s.slots[0].holder.sliceId === "SL-001-A");
  check("种子：SL-001-A 正常可交付", st(s, "SL-001-A").state === "ok" && (s.blockers["CORE-001"] || []).length === 0);

  // 2) 新建样本 + 第二切片
  const created = await call("POST", "/api/samples", {
    project: "北山金矿", borehole: "ZK-08", coreBox: "BX-02", depth: "52-54m",
    owner: "何舟", sliceId: "SL-010-A", method: "未染色"
  });
  check("创建样本 201", created.status === 201);
  const newId = created.data.samples[0].id; // 最新在最前
  const addB = await call("POST", `/api/samples/${newId}/slices`, { id: "SL-010-B", method: "未染色" });
  check("添加第二切片", addB.status === 201);

  // 3) 未入柜不可交付
  const deliverUnstored = await call("POST", `/api/samples/${newId}/deliver`, {});
  check("未入柜不可交付", deliverUnstored.status === 409 && /尚未入柜/.test(deliverUnstored.data.error), deliverUnstored.data.error);

  // 4) SL-010-A 合规入柜 HG-02
  const okCheckin = await call("POST", `/api/samples/${newId}/slices/SL-010-A/checkin`,
    { slotId: "HG-02", keeper: "何舟", temp: 5, humidity: 50 });
  check("合规入柜 201", okCheckin.status === 201);
  s = (await call("GET", "/api/state")).data;
  check("状态=正常", st(s, "SL-010-A").state === "ok");

  // 5) 柜位不得重复分配
  const dupSlot = await call("POST", `/api/samples/${newId}/slices/SL-010-B/checkin`,
    { slotId: "HG-02", keeper: "何舟", temp: 5, humidity: 50 });
  check("占用柜位拒绝再分配", dupSlot.status === 409 && /已被占用/.test(dupSlot.data.error), dupSlot.data.error);

  // 6) 边界：2℃ 与 8℃ 合规；8.1℃ 不合规；湿度 60 合规，60.1 不合规
  const b2 = await call("POST", `/api/samples/${newId}/slices/SL-010-B/checkin`,
    { slotId: "HG-03", keeper: "何舟", temp: 2, humidity: 60 });
  check("边界 2℃/60% 合规", b2.status === 201 && st(b2.data, "SL-010-B").state === "ok");
  const warm = await call("POST", `/api/samples/${newId}/slices/SL-010-B/readings`, { temp: 8.1, humidity: 60 });
  check("8.1℃ 进入待转移", warm.status === 200 && st(warm.data, "SL-010-B").state === "drift", JSON.stringify(st(warm.data, "SL-010-B")));
  const humid = await call("POST", `/api/samples/${newId}/slices/SL-010-B/readings`, { temp: 5, humidity: 60.1 });
  check("60.1% 仍待转移", st(humid.data, "SL-010-B").state === "drift");
  const deliverDrift = await call("POST", `/api/samples/${newId}/deliver`, {});
  check("待转移不可交付", deliverDrift.status === 409 && /待转移/.test(deliverDrift.data.error), deliverDrift.data.error);

  // 7) 转移申请：原柜位不释放，新柜位预约
  const tr = await call("POST", `/api/samples/${newId}/slices/SL-010-B/transfers`,
    { toSlotId: "HG-04", receiver: "方岩", reason: "恒温柜温度漂移", temp: 4.5, humidity: 48 });
  check("转移申请 201", tr.status === 201);
  s = tr.data;
  check("申请后状态=转移待确认", st(s, "SL-010-B").state === "moving");
  check("原柜位 HG-03 仍占用", s.slots.find(x => x.id === "HG-03").free === true ? false : true);
  check("新柜位 HG-04 被预约且不可分配", s.slots.find(x => x.id === "HG-04").free === true && !!s.slots.find(x => x.id === "HG-04").pending);
  const addC = await call("POST", `/api/samples/${newId}/slices`, { id: "SL-010-C", method: "未染色" });
  check("添加第三切片", addC.status === 201);
  const steal = await call("POST", `/api/samples/${newId}/slices/SL-010-C/checkin`, { slotId: "HG-04", keeper: "x", temp: 5, humidity: 50 });
  check("预约柜位拒绝他人入柜", steal.status === 409 && /预约/.test(steal.data.error), steal.data.error);

  // 8) 确认前原柜位不释放：交付仍被阻断
  const deliverMoving = await call("POST", `/api/samples/${newId}/deliver`, {});
  check("转移未确认不可交付", deliverMoving.status === 409 && /尚未确认/.test(deliverMoving.data.error), deliverMoving.data.error);

  // 9) 撤销：失败不留半截——原柜位仍占用，HG-04 恢复空闲
  const tid = st(s, "SL-010-B").pendingTransfer.id;
  const cancel = await call("POST", `/api/samples/${newId}/slices/SL-010-B/transfers/${tid}/cancel`, { reason: "接收人不在岗" });
  check("撤销转移 200", cancel.status === 200);
  s = cancel.data;
  check("撤销后回到待转移", st(s, "SL-010-B").state === "drift");
  check("撤销后 HG-04 完全空闲", (() => { const x = s.slots.find(z => z.id === "HG-04"); return x.free && !x.pending; })());
  const hg03 = s.slots.find(z => z.id === "HG-03");
  check("撤销后原柜位 HG-03 仍占用且无预约", hg03.free === false && hg03.pending === null);

  // 10) 重新申请并确认：新柜位（不合规读数仍可确认 -> 待转移）
  const tr2 = await call("POST", `/api/samples/${newId}/slices/SL-010-B/transfers`,
    { toSlotId: "HG-04", receiver: "方岩", reason: "恒温柜温度漂移", temp: 4.5, humidity: 48 });
  const tid2 = tr2.data.storage["SL-010-B"].pendingTransfer.id;
  const conf = await call("POST", `/api/samples/${newId}/slices/SL-010-B/transfers/${tid2}/confirm`,
    { keeper: "方岩", temp: 4.8, humidity: 46 });
  check("确认转移 200", conf.status === 201 || conf.status === 200);
  s = conf.data;
  check("确认后新柜位 HG-04 占用", s.slots.find(z => z.id === "HG-04").free === false);
  check("确认后原柜位 HG-03 释放空闲", (() => { const x = s.slots.find(z => z.id === "HG-03"); return x.free && !x.pending; })());
  check("确认后状态正常", st(s, "SL-010-B").state === "ok");

  // 11) 缺失必填项：不留半截（HG-04 已占用前提下；这里测温度非数字）
  const bad = await call("POST", `/api/samples/${newId}/slices/SL-010-A/transfers`,
    { toSlotId: "HG-05", receiver: "方岩", reason: "x", temp: "热", humidity: 40 });
  check("温度非数字 400", bad.status === 400);
  s = (await call("GET", "/api/state")).data;
  check("失败不留预约", s.slots.find(z => z.id === "HG-05").free === true && !s.slots.find(z => z.id === "HG-05").pending);

  // 12) 钻孔变更 -> 该样本全部切片失效、柜位释放、转移撤销
  const tr3 = await call("POST", `/api/samples/${newId}/slices/SL-010-A/transfers`,
    { toSlotId: "HG-06", receiver: "方岩", reason: "检修", temp: 4, humidity: 40 });
  check("检修转移申请", tr3.status === 201);
  const edit = await call("PATCH", `/api/samples/${newId}`, { borehole: "ZK-09", coreBox: "BX-02" });
  check("钻孔变更 200", edit.status === 200);
  s = edit.data;
  check("A 片失效", st(s, "SL-010-A").state === "invalid");
  check("B 片失效", st(s, "SL-010-B").state === "invalid");
  check("失效后 HG-02/HG-04/HG-06 全部释放", ["HG-02", "HG-04", "HG-06"].every(id => {
    const x = s.slots.find(z => z.id === id);
    return x.free && !x.pending;
  }));
  check("失效样本不可交付", (await call("POST", `/api/samples/${newId}/deliver`, {})).status === 409);

  // 13) 切片编号变更 -> 单切片失效，履历跟随新编号
  // 先让 A 重新入柜
  const recheck = await call("POST", `/api/samples/${newId}/slices/SL-010-A/checkin`,
    { slotId: "HG-02", keeper: "何舟", temp: 5, humidity: 50 });
  check("重新入柜", recheck.status === 201 && st(recheck.data, "SL-010-A").state === "ok");
  const rename = await call("PATCH", `/api/samples/${newId}/slices/SL-010-A`, { nextSliceId: "SL-010-A2" });
  check("改号 200", rename.status === 200);
  s = rename.data;
  check("改号后柜位失效", st(s, "SL-010-A2").state === "invalid");
  check("旧编号不再有视图", s.storage["SL-010-A"] === undefined);
  check("履历跟随新编号且含失效记录", st(s, "SL-010-A2").history.some(h => h.type === "invalid")
    && st(s, "SL-010-A2").history.some(h => h.type === "checkin"));
  check("HG-02 再次释放", s.slots.find(z => z.id === "HG-02").free === true);

  // 14) 全部重新合规入柜后可交付
  for (const [sid, slotId] of [["SL-010-A2", "HG-02"], ["SL-010-B", "HG-04"], ["SL-010-C", "HG-03"]]) {
    const r = await call("POST", `/api/samples/${newId}/slices/${sid}/checkin`,
      { slotId, keeper: "何舟", temp: 4, humidity: 40 });
    check(`重新入柜 ${sid}`, r.status === 201 && r.data.storage[sid].state === "ok");
  }
  const delivered = await call("POST", `/api/samples/${newId}/deliver`, {});
  check("全部合规后可交付", delivered.status === 200);

  // 15) 列表与履历重载一致：连续两次 GET 完全相同
  const g1 = await call("GET", "/api/state");
  const g2 = await call("GET", "/api/state");
  check("重载后状态一致", JSON.stringify(g1.data) === JSON.stringify(g2.data));
  check("履历包含入柜/复查/申请/撤销/确认/失效各类型", (() => {
    const types = new Set(g1.data.storage["SL-010-B"].history.map(h => h.type));
    return ["checkin", "reading", "transfer-create", "transfer-cancel", "transfer-confirm", "invalid"].every(t => types.has(t));
  })());

  // 16) 页面可打开
  const home = await fetch(BASE + "/");
  check("页面 200", home.status === 200);
} finally {
  server.kill();
  await rm(testDb, { force: true });
  await rm(testDb + ".tmp", { force: true });
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
