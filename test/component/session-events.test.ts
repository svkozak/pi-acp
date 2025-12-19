import test from "node:test";
import assert from "node:assert/strict";
import { PiAcpSession } from "../../src/acp/session.js";
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from "../helpers/fakes.js";

test("PiAcpSession: emits agent_message_chunk for text_delta", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
  });

  proc.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "hi" },
  });

  // allow async emit() to run
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(conn.updates.length, 1);
  assert.equal(conn.updates[0]!.sessionId, "s1");
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "hi" },
  });
});

test("PiAcpSession: emits tool_call + tool_call_update + completes", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
  });

  proc.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { cmd: "ls" } });
  proc.emit({ type: "tool_execution_update", toolCallId: "t1", partialResult: { content: [{ type: "text", text: "running" }] } });
  proc.emit({ type: "tool_execution_end", toolCallId: "t1", isError: false, result: { content: [{ type: "text", text: "done" }] } });

  await new Promise((r) => setTimeout(r, 0));

  assert.equal(conn.updates.length, 3);
  assert.equal(conn.updates[0]!.update.sessionUpdate, "tool_call");
  assert.equal((conn.updates[0]!.update as any).toolCallId, "t1");
  assert.equal((conn.updates[0]!.update as any).status, "in_progress");

  assert.equal(conn.updates[1]!.update.sessionUpdate, "tool_call_update");
  assert.equal((conn.updates[1]!.update as any).status, "in_progress");

  assert.equal(conn.updates[2]!.update.sessionUpdate, "tool_call_update");
  assert.equal((conn.updates[2]!.update as any).status, "completed");
});

test("PiAcpSession: prompt resolves end_turn on turn_end", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  const session = new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
  });

  const p = session.prompt("hello");
  proc.emit({ type: "turn_end" });
  const reason = await p;
  assert.equal(reason, "end_turn");
});

test("PiAcpSession: cancel flips stopReason to cancelled", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  const session = new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
  });

  const p = session.prompt("hello");
  await session.cancel();
  proc.emit({ type: "turn_end" });
  const reason = await p;

  assert.equal(proc.abortCount, 1);
  assert.equal(reason, "cancelled");
});

test("PiAcpSession: rejects concurrent prompt", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  const session = new PiAcpSession({
    sessionId: "s1",
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
  });

  const first = session.prompt("hello");
  await assert.rejects(() => session.prompt("again"), /invalid request/i);

  proc.emit({ type: "turn_end" });
  await first;
});
