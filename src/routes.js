// 路由模块：HTTP 适配层，只负责取参、调存储、返回 JSON
import * as store from "./storage.js";
import { buildView } from "./decision.js";
import { buildPage } from "./page.js";

export function renderPage() {
  return buildPage(store.statuses, store.taskSteps);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

// ---- 样本与切片（读取经判定模块派生视图） ----
route("GET", /^\/api\/state$/, async (req, res, _, db) => sendJson(res, 200, buildView(db)));
route("GET", /^\/api\/samples$/, async (req, res, _, db) => sendJson(res, 200, db.samples));

route("POST", /^\/api\/samples$/, async (req, res) => {
  sendJson(res, 201, await store.createSample(await readBody(req)));
});

route("PATCH", /^\/api\/samples\/([^/]+)$/, async (req, res, m) => {
  sendJson(res, 200, await store.updateSampleIdentity(m[0], await readBody(req)));
});

route("POST", /^\/api\/samples\/([^/]+)\/slices$/, async (req, res, m) => {
  sendJson(res, 201, await store.addSlice(m[0], await readBody(req)));
});

route("PATCH", /^\/api\/samples\/([^/]+)\/slices\/([^/]+)$/, async (req, res, m) => {
  sendJson(res, 200, await store.updateSliceIdentity(m[0], m[1], await readBody(req)));
});

route("POST", /^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/logs$/, async (req, res, m) => {
  sendJson(res, 200, await store.addSliceLog(m[0], m[1], await readBody(req)));
});

// ---- 恒温柜位：入柜登记与复检登记 ----
route("POST", /^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/storage$/, async (req, res, m) => {
  sendJson(res, 201, await store.storeSlice(m[0], m[1], await readBody(req)));
});

route("POST", /^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/restorage$/, async (req, res, m) => {
  sendJson(res, 200, await store.restorageSlice(m[0], m[1], await readBody(req)));
});

// ---- 温漂转移台：申请（预留）/ 确认（原子落库）/ 取消（不留半截） ----
route("POST", /^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/transfers$/, async (req, res, m) => {
  sendJson(res, 201, await store.requestTransfer(m[0], m[1], await readBody(req)));
});

route("POST", /^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/transfers\/([^/]+)\/confirm$/, async (req, res, m) => {
  sendJson(res, 200, await store.confirmTransfer(m[0], m[1], m[2]));
});

route("POST", /^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/transfers\/([^/]+)\/cancel$/, async (req, res, m) => {
  sendJson(res, 200, await store.cancelTransfer(m[0], m[1], m[2]));
});

// ---- 交付：判定模块在写事务内把关，不可交付返回阻塞原因 ----
route("POST", /^\/api\/samples\/([^/]+)\/deliver$/, async (req, res, m) => {
  sendJson(res, 200, await store.deliverSample(m[0]));
});

export async function handleApi(req, res, url) {
  for (const item of routes) {
    if (item.method !== req.method) continue;
    const match = url.pathname.match(item.pattern);
    if (!match) continue;
    // GET 只读：直接加载快照；写操作由存储模块在串行队列内重读-修改-写回
    const db = req.method === "GET" ? await store.loadDb() : null;
    await item.handler(req, res, match.slice(1), db);
    return true;
  }
  return false;
}
