// 存储模块：JSON 文件持久化 + 业务编排。
// 所有变更串行执行并原子写盘（临时文件 rename）；柜位占用/预约双重校验，
// 任何校验失败都在写盘前抛出，不留半截记录。

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STATE,
  STATE_LABELS,
  latestReading,
  judgeReading,
  identityOf,
  changedIdentityFields,
  judgeAssignment,
  deliveryBlockers
} from "./rules.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_FILE || join(__dirname, "data", "core-slices.json");
const tmpPath = `${dbPath}.tmp`;

export const taskSteps = ["取样", "切割", "研磨", "染色", "观察"];
export const statuses = ["待切割", "制片中", "待观察", "已交付"];

const CABINET_SLOTS = Array.from({ length: 12 }, (_, i) => `HG-${String(i + 1).padStart(2, "0")}`);

const seed = {
  version: 2,
  seq: 0,
  samples: [
    {
      id: "CORE-001",
      project: "东岭铜矿薄片",
      borehole: "ZK-17",
      coreBox: "BX-09",
      depth: "128.4-128.8m",
      owner: "陆川",
      status: "制片中",
      delivery: "未交付",
      slices: [
        {
          id: "SL-001-A",
          method: "茜素红染色",
          observation: "",
          status: "研磨",
          logs: [
            { at: "2026-06-12T10:00:00.000Z", step: "取样", note: "截取含矿化条带位置" },
            { at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切" }
          ]
        }
      ]
    }
  ],
  slots: CABINET_SLOTS.map(id => ({ id, activeAssignmentId: null, pendingTransferId: null })),
  assignments: [],
  transfers: []
};

// 预置一条合规在柜记录，让种子样本处于可交付状态
seed.seq = 1;
seed.assignments.push({
  id: "AS-1",
  slotId: "HG-01",
  sampleId: "CORE-001",
  sliceId: "SL-001-A",
  identity: { sampleId: "CORE-001", borehole: "ZK-17", coreBox: "BX-09", sliceId: "SL-001-A" },
  state: "active",
  checkedInAt: "2026-06-13T12:00:00.000Z",
  keeper: "陆川",
  readings: [{ at: "2026-06-13T12:00:00.000Z", temp: 4.5, humidity: 45 }],
  closedAt: null,
  closeReason: null
});
seed.slots[0].activeAssignmentId = "AS-1";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function loadRaw() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await persist(seed);
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  return migrate(db);
}

function migrate(db) {
  if (!db.version) db.version = 1;
  if (!db.seq) db.seq = 0;
  if (!db.slots) {
    db.slots = CABINET_SLOTS.map(id => ({ id, activeAssignmentId: null, pendingTransferId: null }));
  } else {
    for (const slot of db.slots) {
      if (slot.pendingTransferId === undefined) slot.pendingTransferId = null;
    }
  }
  if (!db.assignments) db.assignments = [];
  if (!db.transfers) db.transfers = [];
  db.version = 2;
  return db;
}

async function persist(db) {
  await writeFile(tmpPath, JSON.stringify(db, null, 2));
  await rename(tmpPath, dbPath);
}

// 变更互斥：单进程内串行化所有写操作
let chain = Promise.resolve();
function mutate(work) {
  const run = chain.then(() => work());
  // 单个失败不影响后续请求排队
  chain = run.then(() => {}, () => {});
  return run;
}

function nextId(db, prefix) {
  db.seq += 1;
  return `${prefix}-${db.seq}`;
}

function nowIso() {
  return new Date().toISOString();
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${label}不能为空`);
  return value.trim();
}

function requireNumber(value, label) {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) throw new HttpError(400, `${label}必须是数字`);
  return num;
}

function getSample(db, sampleId) {
  const sample = db.samples.find(item => item.id === sampleId);
  if (!sample) throw new HttpError(404, "样本不存在");
  return sample;
}

function getSlice(sample, sliceId) {
  const slice = sample.slices.find(item => item.id === sliceId);
  if (!slice) throw new HttpError(404, "切片不存在");
  return slice;
}

function getSlot(db, slotId) {
  const slot = db.slots.find(item => item.id === slotId);
  if (!slot) throw new HttpError(404, `柜位 ${slotId} 不存在`);
  return slot;
}

function getAssignment(db, id) {
  const assignment = db.assignments.find(item => item.id === id);
  if (!assignment) throw new HttpError(404, "柜位记录不存在");
  return assignment;
}

function activeAssignmentOf(db, sample, slice) {
  return db.assignments.find(
    item => item.sampleId === sample.id && item.sliceId === slice.id && item.state === "active"
  ) || null;
}

function pendingTransferOf(db, sample, slice) {
  return db.transfers.find(
    item => item.sampleId === sample.id && item.sliceId === slice.id && item.state === "pending"
  ) || null;
}

// 柜位不得重复分配：既不能已占用，也不能有待确认转移预约
function assertSlotFree(slot) {
  if (slot.activeAssignmentId) throw new HttpError(409, `柜位 ${slot.id} 已被占用`);
  if (slot.pendingTransferId) throw new HttpError(409, `柜位 ${slot.id} 已有待确认转移预约`);
}

function releaseSlot(db, slotId) {
  const slot = getSlot(db, slotId);
  slot.activeAssignmentId = null;
  slot.pendingTransferId = null;
}

function updateSampleStatus(sample) {
  const sliceStatuses = sample.slices.map(slice => slice.status);
  if (sample.delivery === "已交付") sample.status = "已交付";
  else if (sliceStatuses.length && sliceStatuses.every(step => step === "观察")) sample.status = "待观察";
  else if (sliceStatuses.some(step => ["取样", "切割", "研磨", "染色"].includes(step))) sample.status = "制片中";
  else sample.status = "待切割";
}

// 身份失效：关闭活动柜位记录、撤销尚未确认的转移预约，并写履历
function invalidateFor(db, sample, slice, reasons) {
  const assignment = activeAssignmentOf(db, sample, slice);
  if (assignment) {
    assignment.state = "invalid";
    assignment.closedAt = nowIso();
    assignment.closeReason = reasons.join("；");
    releaseSlot(db, assignment.slotId);
  }
  for (const transfer of db.transfers) {
    if (
      transfer.sampleId === sample.id &&
      transfer.sliceId === slice.id &&
      transfer.state === "pending"
    ) {
      transfer.state = "cancelled";
      transfer.finishedAt = nowIso();
      transfer.finishReason = "身份信息变更，转移自动撤销";
      const target = getSlot(db, transfer.toSlotId);
      if (target.pendingTransferId === transfer.id) target.pendingTransferId = null;
      const source = getSlot(db, transfer.fromSlotId);
      if (source.pendingTransferId === transfer.id) source.pendingTransferId = null;
    }
  }
}

function ensureUniqueSliceId(db, sliceId, exceptSampleId) {
  const dup = db.samples.some(
    sample => sample.id !== exceptSampleId && sample.slices.some(slice => slice.id === sliceId)
  );
  if (dup) throw new HttpError(409, `切片编号 ${sliceId} 已存在`);
}

/* ---------------- 视图：列表与履历统一从这里派生 ---------------- */

function buildStorageViews(db) {
  const bySlice = {};
  const slotViews = db.slots.map(slot => {
    let holder = null;
    if (slot.activeAssignmentId) {
      const a = db.assignments.find(item => item.id === slot.activeAssignmentId);
      if (a) holder = { sampleId: a.sampleId, sliceId: a.sliceId };
    }
    let pending = null;
    if (slot.pendingTransferId) {
      const t = db.transfers.find(item => item.id === slot.pendingTransferId);
      if (t && t.state === "pending") {
        pending = { id: t.id, sampleId: t.sampleId, sliceId: t.sliceId, direction: slot.id === t.toSlotId ? "in" : "out" };
      }
    }
    return {
      id: slot.id,
      free: !slot.activeAssignmentId,
      holder,
      pending,
      label: slot.activeAssignmentId ? "已占用" : pending ? "转移预约" : "空闲"
    };
  });

  for (const sample of db.samples) {
    for (const slice of sample.slices) {
      const active = activeAssignmentOf(db, sample, slice);
      const pending = pendingTransferOf(db, sample, slice);
      let state = STATE.NONE;
      let assignmentView = null;
      let reading = null;
      let reasons = [];

      if (active) {
        state = judgeAssignment(active, sample, slice);
        reading = latestReading(active);
        if (state === STATE.DRIFT) reasons = judgeReading(reading.temp, reading.humidity).reasons;
        if (state === STATE.INVALID) {
          reasons = changedIdentityFields(active, sample, slice)
            .map(diff => `${fieldLabel(diff.field)}：${diff.from} → ${diff.to}`);
        }
        assignmentView = {
          id: active.id,
          slotId: active.slotId,
          keeper: active.keeper,
          checkedInAt: active.checkedInAt,
          reading
        };
      } else {
        // 无活动柜位时，保留最近一次“失效”结论，直到重新登记
        const lastInvalid = db.assignments
          .filter(a => a.sampleId === sample.id
            && (a.sliceId === slice.id || a.identity?.sliceId === slice.id)
            && a.state === "invalid")
          .sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1))[0];
        if (lastInvalid) {
          state = STATE.INVALID;
          reasons = [lastInvalid.closeReason || "身份信息变更"];
        }
      }
      if (pending && state !== STATE.INVALID) state = STATE.MOVING;

      const events = buildHistory(db, sample, slice);
      bySlice[slice.id] = {
        state,
        stateLabel: STATE_LABELS[state],
        reasons,
        assignment: assignmentView,
        reading,
        pendingTransfer: pending
          ? {
              id: pending.id,
              fromSlotId: pending.fromSlotId,
              toSlotId: pending.toSlotId,
              reason: pending.reason,
              receiver: pending.receiver,
              fromKeeper: pending.fromKeeper,
              createdAt: pending.createdAt
            }
          : null,
        history: events
      };
    }
  }

  return { slots: slotViews, bySlice };
}

function fieldLabel(field) {
  return { sampleId: "样本编号", borehole: "钻孔", coreBox: "岩芯箱", sliceId: "切片编号" }[field] || field;
}

function buildHistory(db, sample, slice) {
  const events = [];
  const match = assignment => assignment.sampleId === sample.id
    && (assignment.sliceId === slice.id || assignment.identity?.sliceId === slice.id);

  for (const a of db.assignments.filter(match)) {
    events.push({
      at: a.checkedInAt,
      type: "checkin",
      label: "入柜登记",
      text: `${a.slotId} · 保管人 ${a.keeper} · ${formatReading(a.readings[0])}`,
      assignmentId: a.id
    });
    for (let i = 1; i < a.readings.length; i += 1) {
      const r = a.readings[i];
      const verdict = judgeReading(r.temp, r.humidity);
      events.push({
        at: r.at,
        type: "reading",
        label: verdict.compliant ? "温湿度复查" : "温漂预警",
        text: `${a.slotId} · ${formatReading(r)}${verdict.compliant ? "" : " · " + verdict.reasons.join("、")}`,
        assignmentId: a.id
      });
    }
    if (a.state === "invalid" && a.closedAt) {
      events.push({
        at: a.closedAt,
        type: "invalid",
        label: "柜位失效",
        text: `${a.slotId} · ${a.closeReason || "身份变更"} · 柜位释放`
      });
    }
  }

  const tMatch = t => t.sampleId === sample.id && (
    db.assignments.some(a => a.id === t.assignmentId && (a.sliceId === slice.id || a.identity?.sliceId === slice.id))
  );
  for (const t of db.transfers.filter(tMatch)) {
    events.push({
      at: t.createdAt,
      type: "transfer-create",
      label: "转移申请",
      text: `${t.fromSlotId} → ${t.toSlotId} · 接收人 ${t.receiver} · 原因：${t.reason}`
    });
    if (t.state === "confirmed") {
      events.push({
        at: t.finishedAt,
        type: "transfer-confirm",
        label: "转移确认",
        text: `${t.fromSlotId} → ${t.toSlotId} · 接收人 ${t.receiver} · ${formatReading(t.confirmedReading)}`
      });
    } else if (t.state === "cancelled") {
      events.push({
        at: t.finishedAt,
        type: "transfer-cancel",
        label: "转移撤销",
        text: `${t.fromSlotId} → ${t.toSlotId} · ${t.finishReason || "未确认"}`
      });
    }
  }

  return events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

function formatReading(r) {
  if (!r) return "无温湿度记录";
  return `${r.temp}℃ / ${r.humidity}%`;
}

export async function getState() {
  const db = await loadRaw();
  const storage = buildStorageViews(db);
  const blockersBySample = {};
  for (const sample of db.samples) {
    blockersBySample[sample.id] = deliveryBlockers(sample, storage.bySlice);
  }
  const summary = {
    slotsTotal: db.slots.length,
    slotsFree: db.slots.filter(s => !s.activeAssignmentId).length,
    slotsPending: db.slots.filter(s => !s.activeAssignmentId && s.pendingTransferId).length,
    slicesTotal: db.samples.reduce((n, s) => n + s.slices.length, 0),
    drifting: Object.values(storage.bySlice).filter(v => v.state === STATE.DRIFT).length,
    moving: Object.values(storage.bySlice).filter(v => v.state === STATE.MOVING).length,
    invalid: Object.values(storage.bySlice).filter(v => v.state === STATE.INVALID).length
  };
  return { samples: db.samples, slots: storage.slots, storage: storage.bySlice, blockers: blockersBySample, summary };
}

/* ---------------- 样本与切片（原有能力，接入失效规则） ---------------- */

export async function createSample(input) {
  return mutate(async () => {
    const db = await loadRaw();
    const project = requireText(input.project, "项目");
    const borehole = requireText(input.borehole, "钻孔编号");
    const coreBox = requireText(input.coreBox, "岩芯箱号");
    const depth = requireText(input.depth, "取样深度");
    const owner = requireText(input.owner, "负责人");
    const sliceId = requireText(input.sliceId, "初始切片编号");
    requireText(input.method, "染色方法");
    ensureUniqueSliceId(db, sliceId, null);
    const sample = {
      id: nextId(db, "CORE"),
      project, borehole, coreBox, depth, owner,
      status: "待切割",
      delivery: "未交付",
      slices: [{
        id: sliceId,
        method: input.method.trim(),
        observation: "",
        status: "取样",
        logs: [{ at: nowIso(), step: "取样", note: "创建初始切片任务" }]
      }]
    };
    updateSampleStatus(sample);
    db.samples.unshift(sample);
    await persist(db);
    return getState();
  });
}

export async function addSlice(sampleId, input) {
  return mutate(async () => {
    const db = await loadRaw();
    const sample = getSample(db, sampleId);
    const id = requireText(input.id, "切片编号");
    ensureUniqueSliceId(db, id, sample.id);
    sample.slices.push({
      id,
      method: (input.method || "未指定").trim() || "未指定",
      observation: "",
      status: "取样",
      logs: [{ at: nowIso(), step: "取样", note: "新增切片任务" }]
    });
    updateSampleStatus(sample);
    await persist(db);
    return getState();
  });
}

export async function logStep(sampleId, sliceId, input) {
  return mutate(async () => {
    const db = await loadRaw();
    const sample = getSample(db, sampleId);
    const slice = getSlice(sample, sliceId);
    const step = requireText(input.step, "步骤");
    if (!taskSteps.includes(step)) throw new HttpError(400, "未知制片步骤");
    const note = (input.note || "").trim() || (step === "观察" ? "观察完成" : "步骤完成");
    slice.status = step;
    if (step === "观察") slice.observation = note;
    slice.logs.push({ at: nowIso(), step, note });
    updateSampleStatus(sample);
    await persist(db);
    return getState();
  });
}

// 钻孔、岩芯箱、切片编号变更：相关柜位结论立即失效并释放柜位
export async function editSampleIdentity(sampleId, input) {
  return mutate(async () => {
    const db = await loadRaw();
    const sample = getSample(db, sampleId);
    const borehole = input.borehole === undefined ? sample.borehole : requireText(input.borehole, "钻孔编号");
    const coreBox = input.coreBox === undefined ? sample.coreBox : requireText(input.coreBox, "岩芯箱号");
    if (input.project !== undefined) sample.project = requireText(input.project, "项目");
    if (input.owner !== undefined) sample.owner = requireText(input.owner, "负责人");
    if (input.depth !== undefined) sample.depth = requireText(input.depth, "取样深度");

    const affected = sample.slices.filter(slice =>
      borehole !== sample.borehole || coreBox !== sample.coreBox);
    for (const slice of affected) {
      const reasons = [];
      if (borehole !== sample.borehole) reasons.push(`钻孔变更：${sample.borehole} → ${borehole}`);
      if (coreBox !== sample.coreBox) reasons.push(`岩芯箱变更：${sample.coreBox} → ${coreBox}`);
      invalidateFor(db, sample, slice, reasons);
    }
    sample.borehole = borehole;
    sample.coreBox = coreBox;
    await persist(db);
    return getState();
  });
}

export async function renameSlice(sampleId, sliceId, body) {
  return mutate(async () => {
    const db = await loadRaw();
    const sample = getSample(db, sampleId);
    const slice = getSlice(sample, sliceId);
    const newId = requireText(body.nextSliceId, "新切片编号");
    if (newId !== slice.id) ensureUniqueSliceId(db, newId, sample.id);
    invalidateFor(db, sample, slice, [`切片编号变更：${slice.id} → ${newId}`]);
    // 失效记录跟随新编号（身份快照保留旧号，作为失效依据），履历不断档
    for (const assignment of db.assignments) {
      if (assignment.sampleId === sample.id && assignment.identity?.sliceId === slice.id) {
        assignment.sliceId = newId;
      }
    }
    slice.id = newId;
    updateSampleStatus(sample);
    await persist(db);
    return getState();
  });
}

/* ---------------- 入柜、复查、转移 ---------------- */

export async function checkIn(sampleId, sliceId, body) {
  return mutate(async () => {
    const db = await loadRaw();
    const sample = getSample(db, sampleId);
    const slice = getSlice(sample, sliceId);
    const slotId = requireText(body.slotId, "柜位");
    const keeper = requireText(body.keeper, "保管人");
    const temp = requireNumber(body.temp, "温度");
    const humidity = requireNumber(body.humidity, "湿度");
    if (humidity < 0 || humidity > 100) throw new HttpError(400, "湿度需在 0~100% 之间");

    if (activeAssignmentOf(db, sample, slice)) throw new HttpError(409, "该切片已在柜，请先转移或释放原柜位");
    if (pendingTransferOf(db, sample, slice)) throw new HttpError(409, "该切片存在待确认转移");
    const slot = getSlot(db, slotId);
    assertSlotFree(slot);

    const id = nextId(db, "AS");
    const at = nowIso();
    // 不合规也允许登记，但直接进入待转移、不可交付
    const assignment = {
      id,
      slotId,
      sampleId: sample.id,
      sliceId: slice.id,
      identity: identityOf(sample, slice),
      state: "active",
      checkedInAt: at,
      keeper,
      readings: [{ at, temp, humidity }],
      closedAt: null,
      closeReason: null
    };
    db.assignments.push(assignment);
    slot.activeAssignmentId = id;
    await persist(db);
    return getState();
  });
}

export async function addReading(sampleId, sliceId, body) {
  return mutate(async () => {
    const db = await loadRaw();
    const sample = getSample(db, sampleId);
    const slice = getSlice(sample, sliceId);
    const assignment = activeAssignmentOf(db, sample, slice);
    if (!assignment) throw new HttpError(409, "该切片当前没有在柜记录");
    if (pendingTransferOf(db, sample, slice)) throw new HttpError(409, "转移待确认期间不能复查温湿度");
    const temp = requireNumber(body.temp, "温度");
    const humidity = requireNumber(body.humidity, "湿度");
    if (humidity < 0 || humidity > 100) throw new HttpError(400, "湿度需在 0~100% 之间");
    assignment.readings.push({ at: nowIso(), temp, humidity });
    await persist(db);
    return getState();
  });
}

export async function createTransfer(sampleId, sliceId, body) {
  return mutate(async () => {
    const db = await loadRaw();
    const sample = getSample(db, sampleId);
    const slice = getSlice(sample, sliceId);
    const toSlotId = requireText(body.toSlotId, "新柜位");
    const receiver = requireText(body.receiver, "接收人");
    const reason = requireText(body.reason, "转移原因");
    const temp = requireNumber(body.temp, "新柜位温度");
    const humidity = requireNumber(body.humidity, "新柜位湿度");
    if (humidity < 0 || humidity > 100) throw new HttpError(400, "湿度需在 0~100% 之间");

    const assignment = activeAssignmentOf(db, sample, slice);
    if (!assignment) throw new HttpError(409, "该切片当前没有在柜记录");
    if (pendingTransferOf(db, sample, slice)) throw new HttpError(409, "该切片已有待确认转移");
    if (toSlotId === assignment.slotId) throw new HttpError(400, "新柜位不能与原柜位相同");
    const source = getSlot(db, assignment.slotId);
    const target = getSlot(db, toSlotId);
    assertSlotFree(target);

    const id = nextId(db, "TR");
    db.transfers.push({
      id,
      assignmentId: assignment.id,
      sampleId: sample.id,
      sliceId: slice.id,
      fromSlotId: assignment.slotId,
      toSlotId,
      reason,
      fromKeeper: assignment.keeper,
      receiver,
      targetReading: { temp, humidity },
      confirmedReading: null,
      state: "pending",
      createdAt: nowIso(),
      finishedAt: null,
      finishReason: null
    });
    // 确认前：原柜位不释放，新柜位仅预约不可再分配
    source.pendingTransferId = id;
    target.pendingTransferId = id;
    await persist(db);
    return getState();
  });
}

export async function confirmTransfer(sampleId, sliceId, transferId, body) {
  return mutate(async () => {
    const db = await loadRaw();
    const sample = getSample(db, sampleId);
    const slice = getSlice(sample, sliceId);
    const transfer = db.transfers.find(t => t.id === transferId && t.state === "pending");
    if (!transfer || transfer.sampleId !== sample.id || transfer.sliceId !== slice.id) {
      throw new HttpError(404, "待确认转移不存在");
    }
    const keeper = requireText(body.keeper, "新保管人");
    const temp = requireNumber(body.temp, "确认温度");
    const humidity = requireNumber(body.humidity, "确认湿度");
    if (humidity < 0 || humidity > 100) throw new HttpError(400, "湿度需在 0~100% 之间");

    const assignment = getAssignment(db, transfer.assignmentId);
    if (assignment.state !== "active" || assignment.sampleId !== sample.id || assignment.sliceId !== slice.id) {
      throw new HttpError(409, "原柜位记录已失效，无法确认转移");
    }
    const target = getSlot(db, transfer.toSlotId);
    // 新柜位预约仍归本转移才允许落地
    if (target.activeAssignmentId || target.pendingTransferId !== transfer.id) {
      throw new HttpError(409, "新柜位已不可用");
    }

    // 全部校验通过后一次性落账：关旧记录、开新记录、释放/占用柜位
    const at = nowIso();
    assignment.state = "transferred";
    assignment.closedAt = at;
    assignment.closeReason = `转移至 ${transfer.toSlotId}：${transfer.reason}`;
    releaseSlot(db, transfer.fromSlotId);

    const newId = nextId(db, "AS");
    db.assignments.push({
      id: newId,
      slotId: transfer.toSlotId,
      sampleId: sample.id,
      sliceId: slice.id,
      identity: identityOf(sample, slice),
      state: "active",
      checkedInAt: at,
      keeper,
      readings: [{ at, temp, humidity }],
      closedAt: null,
      closeReason: null
    });
    target.pendingTransferId = null;
    target.activeAssignmentId = newId;

    transfer.state = "confirmed";
    transfer.finishedAt = at;
    transfer.finishReason = "接收确认";
    transfer.confirmedReading = { at, temp, humidity };

    await persist(db);
    return getState();
  });
}

export async function cancelTransfer(sampleId, sliceId, transferId, body) {
  return mutate(async () => {
    const db = await loadRaw();
    const sample = getSample(db, sampleId);
    const slice = getSlice(sample, sliceId);
    const transfer = db.transfers.find(t => t.id === transferId && t.state === "pending");
    if (!transfer || transfer.sampleId !== sample.id || transfer.sliceId !== slice.id) {
      throw new HttpError(404, "待确认转移不存在");
    }
    const reason = body && typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim()
      : "接收前取消";
    transfer.state = "cancelled";
    transfer.finishedAt = nowIso();
    transfer.finishReason = reason;
    for (const slotId of [transfer.fromSlotId, transfer.toSlotId]) {
      const slot = getSlot(db, slotId);
      if (slot.pendingTransferId === transfer.id) slot.pendingTransferId = null;
    }
    // 失败/取消不留半截记录：原柜位保持占用，新柜位恢复空闲
    await persist(db);
    return getState();
  });
}

export async function deliverSample(sampleId) {
  return mutate(async () => {
    const db = await loadRaw();
    const sample = getSample(db, sampleId);
    const preview = buildStorageViews(db);
    const blockers = deliveryBlockers(sample, preview.bySlice);
    if (blockers.length) throw new HttpError(409, `不可交付：${blockers.join("；")}`);
    sample.delivery = "已交付";
    updateSampleStatus(sample);
    await persist(db);
    return getState();
  });
}
