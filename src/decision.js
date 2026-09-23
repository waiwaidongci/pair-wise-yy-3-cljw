// 判定模块：温湿度判定、柜位结论失效判定、可交付判定（纯函数，不做持久化）

export const TEMP_MIN = 2;
export const TEMP_MAX = 8;
export const HUMIDITY_LIMIT = 60;

export const VERDICT = { OK: "合格", DRIFT: "待转移" };
export const SLICE_STATE = {
  NOT_STORED: "未入柜",
  OK: "合格",
  DRIFT: "待转移",
  STALE: "结论失效",
  TRANSFERRING: "转移待确认"
};

// 温度须在 2~8℃（含边界），湿度不得超过 60%；入参已经过数字校验
export function judgeConditions(temperature, humidity) {
  return temperature >= TEMP_MIN && temperature <= TEMP_MAX && humidity <= HUMIDITY_LIMIT
    ? VERDICT.OK
    : VERDICT.DRIFT;
}

// 入柜时的编号信息快照：样本编号、钻孔、岩芯箱、切片编号
export function storageIdentity(sample, slice) {
  return {
    sampleId: sample.id,
    borehole: sample.borehole,
    coreBox: sample.coreBox,
    sliceId: slice.id
  };
}

// 任一项编号信息变化，柜位结论即失效
export function isIdentityStale(storage, sample, slice) {
  const snap = storage.identity || {};
  const now = storageIdentity(sample, slice);
  return (
    snap.sampleId !== now.sampleId ||
    snap.borehole !== now.borehole ||
    snap.coreBox !== now.coreBox ||
    snap.sliceId !== now.sliceId
  );
}

export function activeStorageOf(db, sampleId, sliceId) {
  return (
    db.storages.find(
      s => s.sampleId === sampleId && s.sliceId === sliceId && !s.releasedAt
    ) || null
  );
}

export function pendingTransferOf(db, sampleId, sliceId) {
  return (
    db.transfers.find(
      t =>
        t.sampleId === sampleId &&
        t.sliceId === sliceId &&
        t.status === "待确认"
    ) || null
  );
}

// 柜位占用：要么有在柜记录，要么被待确认的转移预留；确认前原柜位也保持占用
export function slotOccupant(db, slotId) {
  const storage = db.storages.find(s => s.slotId === slotId && !s.releasedAt);
  if (storage) return { kind: "storage", ref: storage };
  const transfer = db.transfers.find(
    t => t.status === "待确认" && t.toSlotId === slotId
  );
  if (transfer) return { kind: "reserved", ref: transfer };
  return null;
}

export function describeSlice(db, sample, slice) {
  const storage = activeStorageOf(db, sample.id, slice.id);
  const transfer = pendingTransferOf(db, sample.id, slice.id);
  let state = SLICE_STATE.NOT_STORED;
  let stale = false;
  if (transfer) {
    state = SLICE_STATE.TRANSFERRING;
  } else if (storage) {
    stale = isIdentityStale(storage, sample, slice);
    if (stale) state = SLICE_STATE.STALE;
    else state = storage.verdict === VERDICT.OK ? SLICE_STATE.OK : SLICE_STATE.DRIFT;
  }
  return { state, stale, storage, transfer };
}

// 样本可交付的全部阻塞原因；为空才可交付
export function sampleDeliveryBlockers(db, sample) {
  const blockers = [];
  for (const slice of sample.slices) {
    const { state } = describeSlice(db, sample, slice);
    if (state === SLICE_STATE.NOT_STORED) {
      blockers.push({ sliceId: slice.id, reason: "未入柜" });
    } else if (state === SLICE_STATE.STALE) {
      blockers.push({ sliceId: slice.id, reason: "柜位结论失效，需重新登记" });
    } else if (state === SLICE_STATE.DRIFT) {
      blockers.push({ sliceId: slice.id, reason: "温漂待转移" });
    } else if (state === SLICE_STATE.TRANSFERRING) {
      blockers.push({ sliceId: slice.id, reason: "转移尚未确认" });
    }
  }
  return blockers;
}

// 列表、柜位台、履历共用同一份服务端派生视图，保证重载一致
export function buildView(db) {
  const samples = db.samples.map(sample => ({
    ...sample,
    deliveryBlockers: sampleDeliveryBlockers(db, sample),
    slices: sample.slices.map(slice => ({
      ...slice,
      ...describeSlice(db, sample, slice)
    }))
  }));
  const slots = db.slots.map(slot => {
    const occ = slotOccupant(db, slot.id);
    if (!occ) return { ...slot, occupant: null };
    const r = occ.ref;
    return {
      ...slot,
      occupant: {
        kind: occ.kind,
        sampleId: r.sampleId,
        sliceId: r.sliceId,
        verdict: occ.kind === "storage" ? r.verdict : null,
        refId: r.id
      }
    };
  });
  const events = [...db.events].sort((a, b) => b.at.localeCompare(a.at));
  const transfers = [...db.transfers].sort((a, b) =>
    b.requestedAt.localeCompare(a.requestedAt)
  );
  return { samples, slots, storages: db.storages, transfers, events };
}
