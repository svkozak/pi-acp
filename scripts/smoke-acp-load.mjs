// Smoke test for ACP session/load in pi-acp
//
// Runs:
// 1) initialize
// 2) session/new
// 3) session/prompt
// 4) new process: session/load for the created sessionId

import { spawn } from "node:child_process";

function spawnAgent() {
  const proc = spawn("node", ["dist/index.js"], { stdio: ["pipe", "pipe", "inherit"] });
  proc.stdout.setEncoding("utf-8");

  let buffer = "";
  const listeners = [];

  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      for (const l of listeners) l(msg);
    }
  });

  return {
    proc,
    send(obj) {
      proc.stdin.write(JSON.stringify(obj) + "\n");
    },
    onMessage(cb) {
      listeners.push(cb);
    },
    kill() {
      proc.kill("SIGTERM");
    },
  };
}

async function createAndPrompt() {
  const a = spawnAgent();

  return await new Promise((resolve, reject) => {
    let sessionId = null;

    a.onMessage((msg) => {
      if (msg?.id === 2 && msg?.result?.sessionId) {
        sessionId = msg.result.sessionId;
        a.send({
          jsonrpc: "2.0",
          id: 3,
          method: "session/prompt",
          params: { sessionId, prompt: [{ type: "text", text: "Hello" }] },
        });
      }

      if (msg?.id === 3) {
        a.kill();
        if (!sessionId) reject(new Error("No sessionId"));
        else resolve(sessionId);
      }
    });

    a.proc.on("error", reject);

    a.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    a.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });

    // If the agent exits before we complete, fail.
    a.proc.on("exit", (code) => {
      if (sessionId) return;
      reject(new Error(`agent exited early with code ${code}`));
    });
  });
}

async function loadAndCountReplay(sessionId) {
  const a = spawnAgent();

  return await new Promise((resolve, reject) => {
    let updates = 0;

    a.onMessage((msg) => {
      if (msg?.method === "session/update") updates++;

      if (msg?.id === 2) {
        if (msg?.result !== null) {
          reject(new Error("Expected session/load result to be null"));
          return;
        }
        a.kill();
        resolve(updates);
      }
    });

    a.proc.on("error", reject);

    a.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    a.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/load",
      params: { sessionId, cwd: process.cwd(), mcpServers: [] },
    });
  });
}

const sessionId = await createAndPrompt();
const replayUpdates = await loadAndCountReplay(sessionId);
if (replayUpdates === 0) throw new Error("Expected session/load to replay updates");
console.log("OK session/load smoke:", { sessionId, replayUpdates });
