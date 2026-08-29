/**
 * dsh-session-todos — host half.
 *
 * 纯插件（外挂式）：在 webServer 上注册 /dsh-session-todos/api 前缀路由，
 * 任务列表以 JSON 文件持久化到服务器端 ~/.dsh/dsh-session-todos/<sessionId>.json，
 * 供跨端（任意设备登录同一 DSH）读同一份数据。不改 DSH 源码。
 *
 * RPC（均 POST /dsh-session-todos/api/<method>，JSON body，响应 {ok,value} |
 * {ok:false,error:{code,message}}，与 dsh-better-sidebar 约定一致）：
 *   - get     {sessionId}            -> { tasks }
 *   - save    {sessionId, tasks}     -> { ok, sessionId, count, updatedAt }
 *   - summary {}                     -> { sessions: [{ sessionId, hasUnfinished }] }
 *   - GET   /events                  -> text/event-stream（save 成功后广播
 *                                       {type:"tasks-changed",sessionId,updatedAt,count}，
 *                                       多端实时同步；浏览器 EventSource 自动重连）
 *
 * 安全：同源仅 fetch、不加 CORS 头；远程访问依赖 DSH 自身的登录鉴权放行。
 * 本 API 非 settings/credentials 类敏感接口，不适用 loopback-lock。
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export const name = "dsh-session-todos";
export const inject = ["webServer"];

const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME !== ""
  ? process.env.DSH_HOME
  : join(homedir(), ".dsh");
const TODO_ROOT = join(DSH_HOME, "dsh-session-todos");

/** 会话 id 仅作文件名（防路径穿越：非安全字符统一替换）。 */
function safeSegment(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_");
}
function fileFor(sessionId) {
  return join(TODO_ROOT, `${safeSegment(sessionId)}.json`);
}
function ensureDir() {
  mkdirSync(TODO_ROOT, { recursive: true });
}

/** 规范化任务列表：只保留 id/text/done/createdAt/updatedAt，兜底默认值。 */
function normalizeTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks.map((t) => {
    const text = typeof t?.text === "string" ? t.text : "";
    return {
      id: typeof t?.id === "string" && t.id !== "" ? t.id : randomUUID(),
      text,
      done: t?.done === true,
      createdAt: typeof t?.createdAt === "number" ? t.createdAt : Date.now(),
      updatedAt: Date.now()
    };
  });
}

/** 读取某会话的任务列表；无文件或解析失败回退 []（不清空文件）。 */
function readTasks(sessionId) {
  const file = fileFor(sessionId);
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(data.tasks) ? data.tasks : [];
  } catch {
    return [];
  }
}

/** 写入某会话的任务列表（原子语义：同步写文件）。返回规范化后的 payload。 */
function writeTasks(sessionId, tasks) {
  ensureDir();
  const file = fileFor(sessionId);
  const payload = {
    version: 1,
    sessionId,
    updatedAt: Date.now(),
    tasks: normalizeTasks(tasks)
  };
  writeFileSync(file, JSON.stringify(payload, null, 2));
  return payload;
}

/** 汇总所有会话的「是否有未完成任务」。 */
function buildSummary() {
  ensureDir();
  const sessions = [];
  for (const entry of readdirSync(TODO_ROOT)) {
    if (!entry.endsWith(".json")) continue;
    const sid = entry.slice(0, -5);
    const tasks = readTasks(sid);
    sessions.push({ sessionId: sid, hasUnfinished: tasks.some((t) => !t.done) });
  }
  return { sessions };
}

function writeJson(res, status, obj) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store"
  });
  res.end(body);
}
function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value });
}
function writeError(res, code, message, status = 400) {
  writeJson(res, status, { ok: false, error: { code, message } });
}

/** 读取请求 JSON body（上限 1MB）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// ── SSE 实时同步：save 成功后向所有已连接端广播 tasks-changed ─────────────
// 空闲成本≈0（事件驱动，无轮询）；每端一条 text/event-stream 长连接，
// 浏览器 EventSource 原生断线重连（retry 3000ms）。
const sseClients = new Set();
function broadcast(obj) {
  if (sseClients.size === 0) return;
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of [...sseClients]) {
    try { res.write(line); } catch { sseClients.delete(res); }
  }
}

const api = {
  async get({ sessionId }) {
    if (typeof sessionId !== "string" || sessionId === "") throw new Error("sessionId required");
    return { tasks: readTasks(sessionId) };
  },
  async save({ sessionId, tasks }) {
    if (typeof sessionId !== "string" || sessionId === "") throw new Error("sessionId required");
    const payload = writeTasks(sessionId, tasks);
    broadcast({ type: "tasks-changed", sessionId, updatedAt: payload.updatedAt, count: payload.tasks.length });
    return {
      ok: true,
      sessionId,
      count: payload.tasks.length,
      updatedAt: payload.updatedAt
    };
  },
  async summary() {
    return buildSummary();
  }
};

/** 会话 id 是否为安全文件名（用于路由层检测，可选项）。 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: "/dsh-session-todos/api",
        handler: async (req, res) => {
          try {
            const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
            // SSE 事件流：GET /events（唯一非 POST 端点）
            if (req.method === "GET" && pathname === "/dsh-session-todos/api/events") {
              res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-store",
                "x-accel-buffering": "no"
              });
              res.write("retry: 3000\n\n");
              res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
              sseClients.add(res);
              req.on("close", () => sseClients.delete(res));
              return;
            }
            if (req.method !== "POST") {
              writeError(res, "method-error", "method not allowed", 405);
              return;
            }
            const prefix = "/dsh-session-todos/api/";
            const method = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : void 0;
            if (!method || method.includes("/")) {
              writeError(res, "not-found", "unknown method", 404);
              return;
            }
            const handler = api[method];
            if (typeof handler !== "function") {
              writeError(res, "not-found", `unknown method "${method}"`, 404);
              return;
            }
            const payload = await readBody(req);
            const value = await handler(payload);
            writeOk(res, value);
          } catch (e) {
            writeError(res, "error", String(e?.message || e), 400);
          }
        }
      }),
    "dsh-session-todos: /dsh-session-todos/api routes"
  );
}
