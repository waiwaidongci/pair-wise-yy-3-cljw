// 判定模块：恒温柜位规则、身份指纹、交付准入。纯函数，不接触存储与 HTTP。

export const TEMP_MIN = 2;
export const TEMP_MAX = 8;
export const HUMIDITY_MAX = 60;

// 身份字段：任一字段变化，柜位结论即失效
export const IDENTITY_FIELDS = ["sampleId", "borehole", "coreBox", "sliceId"];

export const STATE = {
  NONE: "none",       // 未入柜
  OK: "ok",           // 在柜且温湿度合规
  DRIFT: "drift",     // 温漂/湿漂，待转移
  INVALID: "invalid", // 身份变更，结论失效
  MOVING: "moving"    // 转移待确认
};

export const STATE_LABELS = {
  [STATE.NONE]: "未入柜",
  [STATE.OK]: "正常",
  [STATE.DRIFT]: "待转移",
  [STATE.INVALID]: "已失效",
  [STATE.MOVING]: "转移待确认"
};

export function latestReading(assignment) {
  return assignment.readings[assignment.readings.length - 1] || null;
}

// 判定一次温湿度登记是否合规。温度闭区间 2~8℃；湿度“超过 60%”即 >60 不合格。
export function judgeReading(temp, humidity) {
  const reasons = [];
  if (typeof temp !== "number" || !Number.isFinite(temp)) {
    reasons.push("温度必须是数字");
  } else if (temp < TEMP_MIN || temp > TEMP_MAX) {
    reasons.push(`温度 ${temp}℃ 不在 ${TEMP_MIN}~${TEMP_MAX}℃ 区间`);
  }
  if (typeof humidity !== "number" || !Number.isFinite(humidity)) {
    reasons.push("湿度必须是数字百分比");
  } else if (humidity > HUMIDITY_MAX) {
    reasons.push(`湿度 ${humidity}% 超过 ${HUMIDITY_MAX}%`);
  }
  return { compliant: reasons.length === 0, reasons };
}

export function identityOf(sample, slice) {
  return {
    sampleId: sample.id,
    borehole: sample.borehole,
    coreBox: sample.coreBox,
    sliceId: slice.id
  };
}

export function identityMismatch(assignment, sample, slice) {
  const current = identityOf(sample, slice);
  const snap = assignment.identity || {};
  return IDENTITY_FIELDS.some(field => snap[field] !== current[field]);
}

export function changedIdentityFields(assignment, sample, slice) {
  const current = identityOf(sample, slice);
  const snap = assignment.identity || {};
  return IDENTITY_FIELDS.filter(field => snap[field] !== current[field])
    .map(field => ({ field, from: snap[field], to: current[field] }));
}

// 活动柜位记录的判定：先看身份指纹，再看最新一次温湿度
export function judgeAssignment(assignment, sample, slice) {
  if (assignment.state !== "active") return assignment.state === "invalid" ? STATE.INVALID : STATE.NONE;
  if (identityMismatch(assignment, sample, slice)) return STATE.INVALID;
  const reading = latestReading(assignment);
  const verdict = judgeReading(reading ? reading.temp : NaN, reading ? reading.humidity : NaN);
  return verdict.compliant ? STATE.OK : STATE.DRIFT;
}

// 样本交付准入：每片都必须在合规柜位上，待转移/未入柜/失效/转移中途一律不可交付
export function deliveryBlockers(sample, storageBySliceId) {
  const blockers = [];
  for (const slice of sample.slices) {
    const view = storageBySliceId[slice.id];
    if (!view || view.state === STATE.NONE) {
      blockers.push(`${slice.id} 尚未入柜登记`);
    } else if (view.state === STATE.DRIFT) {
      blockers.push(`${slice.id} 处于待转移（${(view.reasons || []).join("、") || "温湿度不合规"}）`);
    } else if (view.state === STATE.INVALID) {
      blockers.push(`${slice.id} 柜位结论因身份变更失效，须重新登记`);
    } else if (view.state === STATE.MOVING) {
      blockers.push(`${slice.id} 转移尚未确认`);
    }
  }
  return blockers;
}
