// 存储模块：JSON 持久化、柜位/入柜/转移记录的写入与事务式变更
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VERDICT,
  judgeConditions,
  storageIdentity,
  isIdentityStale,
  activeStorageOf,
  pendingTransferOf,
  slotOccupant,
  sampleDeliveryBlockers
} from "./decision.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "..", "data", "core-slices.json");

const statuses = ["待切割", "制片中", "待观察", "已交付"];
const taskSteps = ["取样", "切割", "研磨", "染色", "观察"];

const DEFAULT_SLOTS = ["CG-01", "CG-02"]
  .flatMap(cabinet =>
    Array.from({ length: 12 }, (_, i) => `${cabinet}-${String(i + 1).padStart(2, "0")}`)
  )
  .map(id => ({ id, cabinet: id.slice(0, 5), enabled: true }));

function seed() {
  const at = "2026-06-14T08:00:00.000Z";
  const sample = {
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
  };
  return {
    version: 2,
    samples: [sample],
    slots: DEFAULT_SLOTS,
    storages: [
      {
        id: "STG-0001",
        sampleId: "CORE-001",
        sliceId: "SL-001-A",
        slotId: "CG-01-01",
        temperature: 4.2,
        humidity: 45,
        custodian: "陆川",
        verdict: VERDICT.OK,
        identity: storageIdentity(sample, sample.slices[0]),
        storedAt: at,
        releasedAt: null
      }
    ],
    transfers: [],
    events: [{ id: "EVT-0001", at, type: "stored", refId: "STG-0001" }]
  };
}

// 旧版数据迁移：补齐柜位、入柜、转移与履历，不臆造入柜记录
function migrate(raw) {
  const db = {
    version: 2,
    samples: raw.samples || [],
    slots: raw.slots || DEFAULT_SLOTS,
    storages: raw.storages || [],
    transfers: raw.transfers || [],
    events: raw.events || []
  };
  if (!Array.isArray(db.slots) || db.slots.length === 0) db.slots = DEFAULT_SLOTS;
  db.samples.forEach(sample => updateSampleStatus(db, sample));
  return db;
}

export async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed(), null, 2));
  }
  return migrate(JSON.parse(await readFile(dbPath, "utf8")));
}

let pending = Promise.resolve();
// 所有变更串行化：读完即算、算完即写，避免并发下柜位重复分配
function mutate(fn) {
  const run = pending.then(async () => {
    const db = await loadDb();
    const result = await fn(db);
    await writeFile(dbPath, JSON.stringify(db, null, 2));
    return result;
  });
  pending = run.catch(() => {});
  return run;
}

function now() {
  return new Date().toISOString();
}
let seq = 1;
function nextId(prefix) {
  const stamp = Date.now().toString(36).toUpperCase();
  return `${prefix}-${stamp}-${String(seq++).padStart(3, "0")}`;
}
function pushEvent(db, type, refId, extra = {}) {
  const event = { id: nextId("EVT"), at: now(), type, refId, ...extra };
  db.events.push(event);
  return event;
}

function findSample(db, sampleId) {
  return db.samples.find(item => item.id === sampleId) || null;
}
function findSlice(db, sampleId, sliceId) {
  const sample = findSample(db, sampleId);
  const slice = sample && sample.slices.find(item => item.id === sliceId);
  return { sample, slice };
}

function parseNumber(value, label) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw httpError(400, `${label}必须是数字`);
  }
  return n;
}

export function updateSampleStatus(db, sample) {
  const sliceStatuses = sample.slices.map(slice => slice.status);
  if (sliceStatuses.length && sliceStatuses.every(step => step === "观察")) {
    sample.status = "待观察";
  }
  if (sample.delivery === "已交付") {
    sample.status = "已交付";
  } else if (sliceStatuses.some(step => ["取样", "切割", "研磨", "染色"].includes(step))) {
    sample.status = "制片中";
  } else {
    sample.status = "待切割";
  }
}

// ---- 样本与切片 ----

export function createSample(input) {
  return mutate(db => {
    const sample = {
      id: `CORE-${Date.now()}`,
      project: input.project,
      borehole: input.borehole,
      coreBox: input.coreBox,
      depth: input.depth,
      owner: input.owner,
      status: "待切割",
      delivery: "未交付",
      slices: [
        {
          id: input.sliceId,
          method: input.method,
          observation: "",
          status: "取样",
          logs: [{ at: now(), step: "取样", note: "创建初始切片任务" }]
        }
      ]
    };
    updateSampleStatus(db, sample);
    db.samples.unshift(sample);
    pushEvent(db, "sample_created", sample.id, { sampleId: sample.id });
    return sample;
  });
}

export function addSlice(sampleId, input) {
  return mutate(db => {
    const sample = findSample(db, sampleId);
    if (!sample) throw httpError(404, "sample_not_found");
    if (sample.slices.some(item => item.id === input.id)) {
      throw httpError(409, "slice_id_duplicated");
    }
    sample.slices.push({
      id: input.id,
      method: input.method || "未指定",
      observation: "",
      status: "取样",
      logs: [{ at: now(), step: "取样", note: "新增切片任务" }]
    });
    updateSampleStatus(db, sample);
    return sample;
  });
}

export function addSliceLog(sampleId, sliceId, input) {
  return mutate(db => {
    const { sample, slice } = findSlice(db, sampleId, sliceId);
    if (!sample) throw httpError(404, "sample_not_found");
    if (!slice) throw httpError(404, "slice_not_found");
    slice.status = input.step;
    if (input.step === "观察") slice.observation = input.note || slice.observation;
    slice.logs.push({ at: now(), step: input.step, note: input.note || "" });
    updateSampleStatus(db, sample);
    return sample;
  });
}

// 编号信息变更（样本编号、钻孔、岩芯箱、切片编号）：同步引用，入柜快照保留旧值，柜位结论因此失效
export function updateSampleIdentity(sampleId, patch) {
  return mutate(db => {
    const sample = findSample(db, sampleId);
    if (!sample) throw httpError(404, "sample_not_found");
    const changes = {};
    for (const key of ["id", "borehole", "coreBox"]) {
      if (patch[key] !== undefined && String(patch[key]).trim() !== "" && patch[key] !== sample[key]) {
        changes[key] = { from: sample[key], to: String(patch[key]).trim() };
      }
    }
    if (Object.keys(changes).length === 0) return sample;
    const newId = changes.id ? changes.id.to : sampleId;
    if (changes.id && findSample(db, newId)) throw httpError(409, "sample_id_duplicated");

    const note = Object.entries(changes)
      .map(([key, c]) => `${identityLabel(key)} ${c.from} → ${c.to}`)
      .join("；");

    if (changes.borehole) sample.borehole = changes.borehole.to;
    if (changes.coreBox) sample.coreBox = changes.coreBox.to;
    if (changes.id) {
      sample.id = newId;
      for (const s of db.storages) if (s.sampleId === sampleId) s.sampleId = newId;
      for (const t of db.transfers) if (t.sampleId === sampleId) t.sampleId = newId;
      for (const e of db.events) if (e.sampleId === sampleId) e.sampleId = newId;
    }
    if (note) pushEvent(db, "identity_changed", newId, { sampleId: newId, note });
    return sample;
  });
}

export function updateSliceIdentity(sampleId, sliceId, patch) {
  return mutate(db => {
    const { sample, slice } = findSlice(db, sampleId, sliceId);
    if (!sample) throw httpError(404, "sample_not_found");
    if (!slice) throw httpError(404, "slice_not_found");
    const newId = patch.id !== undefined ? String(patch.id).trim() : "";
    if (!newId || newId === slice.id) return sample;
    if (sample.slices.some(item => item.id === newId)) {
      throw httpError(409, "slice_id_duplicated");
    }
    const oldId = slice.id;
    slice.id = newId;
    for (const s of db.storages) if (s.sampleId === sampleId && s.sliceId === oldId) s.sliceId = newId;
    for (const t of db.transfers) if (t.sampleId === sampleId && t.sliceId === oldId) t.sliceId = newId;
    pushEvent(db, "identity_changed", sampleId, {
      sampleId,
      note: `切片编号 ${oldId} → ${newId}`
    });
    return sample;
  });
}

function identityLabel(key) {
  return { id: "样本编号", borehole: "钻孔", coreBox: "岩芯箱" }[key] || key;
}

// ---- 入柜 ----

function readConditions(input) {
  const temperature = parseNumber(input.temperature, "温度");
  const humidity = parseNumber(input.humidity, "湿度");
  if (humidity < 0 || humidity > 100) throw httpError(400, "湿度应在0~100之间");
  const custodian = String(input.custodian || "").trim();
  if (!custodian) throw httpError(400, "保管人必填");
  return { temperature, humidity, custodian };
}

export function storeSlice(sampleId, sliceId, input) {
  return mutate(db => {
    const { sample, slice } = findSlice(db, sampleId, sliceId);
    if (!sample) throw httpError(404, "sample_not_found");
    if (!slice) throw httpError(404, "slice_not_found");
    const slotId = String(input.slotId || "").trim();
    const slot = db.slots.find(item => item.id === slotId && item.enabled);
    if (!slot) throw httpError(400, "柜位不存在");
    if (slotOccupant(db, slotId)) throw httpError(409, "slot_occupied");
    if (activeStorageOf(db, sampleId, sliceId)) throw httpError(409, "already_stored");
    if (pendingTransferOf(db, sampleId, sliceId)) throw httpError(409, "transfer_pending");

    const { temperature, humidity, custodian } = readConditions(input);
    const verdict = judgeConditions(temperature, humidity);
    const storage = {
      id: nextId("STG"),
      sampleId,
      sliceId,
      slotId,
      temperature,
      humidity,
      custodian,
      verdict,
      identity: storageIdentity(sample, slice),
      storedAt: now(),
      releasedAt: null
    };
    db.storages.push(storage);
    pushEvent(db, "stored", storage.id, {
      sampleId,
      sliceId,
      slotId,
      temperature,
      humidity,
      custodian,
      verdict
    });
    return storage;
  });
}

// 重新登记（编号变化导致结论失效后刷新快照，或温湿度复检）；无待确认转移时才能复检
export function restorageSlice(sampleId, sliceId, input) {
  return mutate(db => {
    const { sample, slice } = findSlice(db, sampleId, sliceId);
    if (!sample) throw httpError(404, "sample_not_found");
    if (!slice) throw httpError(404, "slice_not_found");
    const storage = activeStorageOf(db, sampleId, sliceId);
    if (!storage) throw httpError(409, "not_stored");
    if (pendingTransferOf(db, sampleId, sliceId)) throw httpError(409, "transfer_pending");

    const { temperature, humidity, custodian } = readConditions(input);
    const slotId = input.slotId !== undefined ? String(input.slotId).trim() : storage.slotId;
    if (slotId !== storage.slotId) {
      const slot = db.slots.find(item => item.id === slotId && item.enabled);
      if (!slot) throw httpError(400, "柜位不存在");
      if (slotOccupant(db, slotId)) throw httpError(409, "slot_occupied");
    }
    const before = {
      slotId: storage.slotId,
      temperature: storage.temperature,
      humidity: storage.humidity,
      custodian: storage.custodian,
      verdict: storage.verdict
    };
    storage.slotId = slotId;
    storage.temperature = temperature;
    storage.humidity = humidity;
    storage.custodian = custodian;
    storage.verdict = judgeConditions(temperature, humidity);
    storage.identity = storageIdentity(sample, slice);
    pushEvent(db, "restored", storage.id, {
      sampleId,
      sliceId,
      slotId,
      temperature,
      humidity,
      custodian,
      verdict: storage.verdict,
      note: `复检更新（原柜位 ${before.slotId}、${before.temperature}℃、${before.humidity}%、${before.custodian}、${before.verdict}）`
    });
    return storage;
  });
}

// ---- 温漂转移：两阶段 ----

// 阶段一：登记新柜位、接收人、原因，仅预留新柜位；原柜位不释放、不写半截履历
export function requestTransfer(sampleId, sliceId, input) {
  return mutate(db => {
    const { sample, slice } = findSlice(db, sampleId, sliceId);
    if (!sample) throw httpError(404, "sample_not_found");
    if (!slice) throw httpError(404, "slice_not_found");
    const storage = activeStorageOf(db, sampleId, sliceId);
    if (!storage) throw httpError(409, "not_stored");
    if (isIdentityStale(storage, sample, slice)) throw httpError(409, "storage_stale");
    if (pendingTransferOf(db, sampleId, sliceId)) throw httpError(409, "transfer_pending");

    const toSlotId = String(input.toSlotId || "").trim();
    const toSlot = db.slots.find(item => item.id === toSlotId && item.enabled);
    if (!toSlot) throw httpError(400, "柜位不存在");
    if (toSlotId === storage.slotId) throw httpError(400, "新柜位不能与原柜位相同");
    if (slotOccupant(db, toSlotId)) throw httpError(409, "slot_occupied");

    const receiver = String(input.receiver || "").trim();
    const reason = String(input.reason || "").trim();
    if (!receiver) throw httpError(400, "接收人必填");
    if (!reason) throw httpError(400, "转移原因必填");
    const temperature = parseNumber(input.temperature, "新柜温度");
    const humidity = parseNumber(input.humidity, "新柜湿度");
    if (humidity < 0 || humidity > 100) throw httpError(400, "湿度应在0~100之间");

    const transfer = {
      id: nextId("TRF"),
      sampleId,
      sliceId,
      fromSlotId: storage.slotId,
      toSlotId,
      receiver,
      reason,
      temperature,
      humidity,
      verdict: judgeConditions(temperature, humidity),
      custodian: storage.custodian,
      identity: storageIdentity(sample, slice),
      status: "待确认",
      requestedAt: now(),
      confirmedAt: null
    };
    db.transfers.push(transfer);
    return transfer;
  });
}

// 阶段二：确认后一次性释放原柜位、建立新入柜记录；任一步失败则整体不落库（无半截记录）
export function confirmTransfer(sampleId, sliceId, transferId) {
  return mutate(db => {
    const { sample, slice } = findSlice(db, sampleId, sliceId);
    if (!sample) throw httpError(404, "sample_not_found");
    if (!slice) throw httpError(404, "slice_not_found");
    const transfer = db.transfers.find(
      t => t.id === transferId && t.sampleId === sampleId && t.sliceId === sliceId
    );
    if (!transfer || transfer.status !== "待确认") throw httpError(404, "transfer_not_found");
    const storage = activeStorageOf(db, sampleId, sliceId);
    if (!storage || storage.slotId !== transfer.fromSlotId) {
      throw httpError(409, "source_changed");
    }
    if (isIdentityStale(storage, sample, slice)) throw httpError(409, "storage_stale");
    if (
      db.transfers.some(
        t => t.id !== transfer.id && t.status === "待确认" && t.toSlotId === transfer.toSlotId
      ) ||
      db.storages.some(s => !s.releasedAt && s.slotId === transfer.toSlotId)
    ) {
      throw httpError(409, "slot_occupied");
    }

    const at = now();
    storage.releasedAt = at;
    const nextStorage = {
      id: nextId("STG"),
      sampleId,
      sliceId,
      slotId: transfer.toSlotId,
      temperature: transfer.temperature,
      humidity: transfer.humidity,
      custodian: transfer.receiver,
      verdict: transfer.verdict,
      identity: storageIdentity(sample, slice),
      storedAt: at,
      releasedAt: null
    };
    db.storages.push(nextStorage);
    transfer.status = "已确认";
    transfer.confirmedAt = at;
    pushEvent(db, "released", storage.id, {
      sampleId,
      sliceId,
      slotId: transfer.fromSlotId,
      transferId: transfer.id,
      note: `转移确认，原柜位 ${transfer.fromSlotId} 释放`
    });
    pushEvent(db, "stored", nextStorage.id, {
      sampleId,
      sliceId,
      slotId: transfer.toSlotId,
      temperature: transfer.temperature,
      humidity: transfer.humidity,
      custodian: transfer.receiver,
      verdict: transfer.verdict,
      transferId: transfer.id,
      note: `由 ${transfer.fromSlotId} 转入：${transfer.reason}`
    });
    pushEvent(db, "transfer_confirmed", transfer.id, {
      sampleId,
      sliceId,
      transferId: transfer.id
    });
    return { transfer, storage: nextStorage };
  });
}

// 取消/失败：待确认记录整体删除，新柜位预留释放，不留下任何半截记录
export function cancelTransfer(sampleId, sliceId, transferId) {
  return mutate(db => {
    const transfer = db.transfers.find(
      t => t.id === transferId && t.sampleId === sampleId && t.sliceId === sliceId
    );
    if (!transfer || transfer.status !== "待确认") throw httpError(404, "transfer_not_found");
    db.transfers = db.transfers.filter(t => t.id !== transferId);
    return { cancelled: transferId };
  });
}

// ---- 交付：判定模块在同一写事务内把关，不可交付则不写任何数据 ----
export function deliverSample(sampleId) {
  return mutate(db => {
    const sample = findSample(db, sampleId);
    if (!sample) throw httpError(404, "sample_not_found");
    const blockers = sampleDeliveryBlockers(db, sample);
    if (blockers.length) {
      const err = httpError(409, "not_deliverable");
      err.blockers = blockers;
      throw err;
    }
    sample.delivery = "已交付";
    updateSampleStatus(db, sample);
    pushEvent(db, "delivered", sample.id, { sampleId });
    return sample;
  });
}

function httpError(code, error) {
  const err = new Error(error);
  err.code = code;
  return err;
}

export { statuses, taskSteps, findSample, findSlice };
