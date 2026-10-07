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
 *   - WS    /ws                      -> WebSocket 实时通道（**主通道**，浏览器
 *                                       优先用；save 成功后广播
 *                                       {type:"tasks-changed",sessionId,updatedAt,count}。
 *                                       WS 不占「同源 6 条 HTTP/1.1 连接」池位，
 *                                       多开客户端不会把发消息等请求挤到排队）
 *   - GET   /events                  -> text/event-stream（**备用通道**，保留给
 *                                       旧客户端；同一条广播的另一路出口）
 *
 * 安全：同源仅 fetch、不加 CORS 头；远程访问依赖 DSH 自身的登录鉴权放行。
 * 本 API 非 settings/credentials 类敏感接口，不适用 loopback-lock。
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";

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

/** 规范化任务列表：只保留 id/text/done/divider/color/createdAt/updatedAt，兜底默认值。 */
function normalizeTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks.map((t) => {
    const text = typeof t?.text === "string" ? t.text : "";
    return {
      id: typeof t?.id === "string" && t.id !== "" ? t.id : randomUUID(),
      text,
      done: t?.done === true,
      divider: t?.divider === true,
      color: typeof t?.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(t.color) ? t.color : null,
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
    // 分割线不是任务：不计入「未完成」（否则只剩分割线的会话会一直挂 🎯 徽章）
    sessions.push({ sessionId: sid, hasUnfinished: tasks.some((t) => !t.done && !t.divider) });
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

// ── 实时同步通道：save 成功后向所有已连接端广播 tasks-changed ──────────────
// 主通道 WebSocket（/dsh-session-todos/api/ws）：**WS 不占浏览器「同源最多 6 条
// HTTP/1.1 连接」的池位**，多开客户端（如两个 VS Code 侧栏）不会把池占满、
// 把别的请求（发消息等）挤到排队超时。实测：同页开 10 条 WS，POST 依旧秒回。
// 备用通道 SSE（/events）：保留给旧客户端，行为不变。
const sseClients = new Set();
const wsSockets = new Set();

/** WebSocket 服务端握手应答：base64(sha1(key + RFC6455 GUID))。 */
function wsAcceptKey(key) {
  return createHash("sha1")
    .update(`${String(key)}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

/** 服务端→客户端单向文本帧：不掩码、不分片，长度按 7/16/64 位编码。 */
function wsTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const n = payload.length;
  let header;
  if (n < 126) {
    header = Buffer.from([0x81, n]);
  } else if (n < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(n, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([header, payload]);
}

function broadcast(obj) {
  if (sseClients.size === 0 && wsSockets.size === 0) return;
  const json = JSON.stringify(obj);
  const line = `data: ${json}\n\n`;
  for (const res of [...sseClients]) {
    try { res.write(line); } catch { sseClients.delete(res); }
  }
  const frame = wsTextFrame(json);
  for (const socket of [...wsSockets]) {
    try { socket.write(frame); } catch { wsSockets.delete(socket); }
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
  // 诊断日志：同时走 ctx.logger 与 stdout（stdout 才进 systemd journal，便于取证）。
  const log = (msg) => {
    try {
      ctx.logger?.info(msg);
    } catch { /* 无 logger 时静默 */ }
    console.log("[dsh-session-todos]", msg);
  };
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: "/dsh-session-todos/api",
        handler: async (req, res) => {
          try {
            const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
            // SSE 事件流：GET /events（唯一非 POST 端点，备用通道）
            if (req.method === "GET" && pathname === "/dsh-session-todos/api/events") {
              // 连一条记一条（含来源 IP）：便于核查某个客户端到底走了哪条通道——
              // 这正是"两个侧栏把 HTTP 连接池占满"这类问题的取证入口。
              log(`SSE /events 已连接 ${req.socket?.remoteAddress ?? "?"}`);
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

  // ② WebSocket 实时通道（主通道）。与 ① 的 /events 并存，客户端优先用这条。
  // 宿主没有 registerUpgrade（旧版 DSH）时跳过：客户端会自动退避重连，不影响其余功能。
  if (typeof ctx.webServer.registerUpgrade !== "function") {
    return;
  }
  ctx.effect(
    () =>
      ctx.webServer.registerUpgrade({
        path: "/dsh-session-todos/api/ws",
        handler: (req, socket) => {
          const key = req.headers["sec-websocket-key"];
          if (typeof key !== "string" || key === "") {
            socket.destroy();
            return;
          }
          socket.write(
            "HTTP/1.1 101 Switching Protocols\r\n" +
              "Upgrade: websocket\r\n" +
              "Connection: Upgrade\r\n" +
              `Sec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n\r\n`
          );
          if (typeof socket.setNoDelay === "function") socket.setNoDelay(true);
          wsSockets.add(socket);
          // 连一条记一条（含来源 IP）：取证用，见 /events 分支同一注释。
          log(`WS /ws 已连接 ${socket.remoteAddress ?? "?"}`);
          const drop = () => {
            wsSockets.delete(socket);
          };
          socket.on("close", drop);
          socket.on("end", drop);
          socket.on("error", drop);
          // 浏览器→服务端方向本通道不用（只需广播）：不解析帧，断开靠 close/error 感知。
          socket.on("data", () => {});
          try {
            socket.write(wsTextFrame(JSON.stringify({ type: "hello" })));
          } catch {
            /* 握手后立刻断开，忽略 */
          }
        }
      }),
    "dsh-session-todos: WebSocket 实时通道"
  );
}
