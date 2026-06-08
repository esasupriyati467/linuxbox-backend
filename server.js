/**
 * LinuxBox Sandbox — WebSocket PTY backend.
 *
 * - Verifikasi JWT Supabase (HS256 menggunakan SUPABASE_JWT_SECRET).
 * - Spawn 1 PTY per koneksi WebSocket.
 * - Workspace per user: /workspaces/<userId> (persisten via Railway Volume).
 * - Container image (Dockerfile) sudah berisi bash, python3, nodejs, npm, git.
 *
 * Pesan client -> server (JSON):
 *   { "type": "input",  "data": "ls\r" }
 *   { "type": "resize", "cols": 120, "rows": 32 }
 *
 * Pesan server -> client:
 *   string biasa = output PTY (sudah ANSI-encoded)
 *   JSON {type:"err",msg} = error fatal
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import { jwtVerify } from "jose";

const PORT = Number(process.env.PORT) || 8080;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim());
const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || "/workspaces";
const SHELL = process.env.SANDBOX_SHELL || "bash";
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS) || 30 * 60 * 1000;

if (!JWT_SECRET) {
  console.error("FATAL: SUPABASE_JWT_SECRET env var required.");
  process.exit(1);
}
const SECRET_KEY = new TextEncoder().encode(JWT_SECRET);

fs.mkdirSync(WORKSPACES_ROOT, { recursive: true });

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", async (req, socket, head) => {
  try {
    const origin = req.headers.origin || "";
    if (!ALLOWED_ORIGINS.includes("*") && !ALLOWED_ORIGINS.includes(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    if (!token) throw new Error("missing token");

    const { payload } = await jwtVerify(token, SECRET_KEY, { algorithms: ["HS256"] });
    const userId = payload.sub;
    if (!userId) throw new Error("invalid token: no sub");

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, { userId });
    });
  } catch (e) {
    console.warn("upgrade rejected:", e.message);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
  }
});

wss.on("connection", (ws, _req, ctx) => {
  const userId = ctx.userId;
  const cwd = path.join(WORKSPACES_ROOT, userId);
  fs.mkdirSync(cwd, { recursive: true });

  console.log(`[${userId}] connected, cwd=${cwd}`);

  let term;
  try {
    term = pty.spawn(SHELL, ["-l"], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env: {
        ...process.env,
        HOME: cwd,
        USER: "sandbox",
        LOGNAME: "sandbox",
        TERM: "xterm-256color",
        PS1: "\\[\\e[32m\\]sandbox@linuxbox\\[\\e[0m\\]:\\[\\e[34m\\]\\w\\[\\e[0m\\]$ ",
      },
    });
  } catch (e) {
    ws.send(JSON.stringify({ type: "err", msg: `spawn failed: ${e.message}` }));
    ws.close();
    return;
  }

  let idleTimer = resetIdle();
  function resetIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    return setTimeout(() => {
      ws.send(JSON.stringify({ type: "err", msg: "idle timeout" }));
      ws.close();
    }, IDLE_TIMEOUT_MS);
  }

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  term.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n[process exited with code ${exitCode}]\r\n`);
      ws.close();
    }
  });

  ws.on("message", (raw) => {
    idleTimer = resetIdle();
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "input" && typeof msg.data === "string") {
      term.write(msg.data);
    } else if (msg.type === "resize" && msg.cols && msg.rows) {
      try {
        term.resize(Math.max(2, msg.cols | 0), Math.max(2, msg.rows | 0));
      } catch {}
    }
  });

  ws.on("close", () => {
    clearTimeout(idleTimer);
    try { term.kill(); } catch {}
    console.log(`[${userId}] disconnected`);
  });
});

server.listen(PORT, () => {
  console.log(`LinuxBox Sandbox listening on :${PORT}`);
});