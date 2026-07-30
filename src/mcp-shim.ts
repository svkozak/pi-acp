/**
 * MCP-over-ACP stdio shim.
 *
 * This is a tiny, dependency-free Node script that pi launches as a **stdio
 * MCP server** (via the pi-mcp-adapter extension). It bridges pi's stdio MCP
 * transport to a local IPC socket owned by pi-acp, which in turn routes the
 * messages over the ACP channel using the MCP-over-ACP protocol
 * (mcp/connect, mcp/message, mcp/disconnect).
 *
 * The shim is intentionally dumb: it pipes newline-delimited JSON-RPC bytes
 * bidirectionally between stdin/stdout (pi side) and the IPC socket (pi-acp
 * side). All ACP/MCP protocol logic lives in pi-acp.
 *
 * Configuration via environment variables:
 *   PI_ACP_MCP_SOCKET  Path to the unix socket / Windows named pipe to connect to.
 *
 * Lifecycle:
 *   1. pi (via pi-mcp-adapter) spawns this shim.
 *   2. The shim connects to the socket. pi-acp treats the accepted connection
 *      as a new MCP-over-ACP connection and sends `mcp/connect` to the client.
 *   3. Bytes are relayed in both directions.
 *   4. When either side closes, the shim exits. pi-acp sends `mcp/disconnect`.
 */
import { createConnection } from 'node:net'

const SOCKET_PATH = process.env.PI_ACP_MCP_SOCKET

if (!SOCKET_PATH) {
  process.stderr.write('pi-acp mcp-shim: PI_ACP_MCP_SOCKET is not set\n')
  process.exit(1)
}

function pipe(streamA: NodeJS.ReadableStream, streamB: NodeJS.WritableStream): void {
  streamA.on('data', (chunk: Buffer | string) => {
    try {
      streamB.write(chunk)
    } catch {
      // ignore write errors; teardown will follow on close
    }
  })
  streamA.on('end', teardown)
  streamA.on('error', teardown)
}

let teardownDone = false
function teardown(): void {
  if (teardownDone) return
  teardownDone = true
  try {
    process.stdin.destroy()
  } catch {
    // ignore
  }
  process.exit(0)
}

const socket = createConnection({ path: SOCKET_PATH }, () => {
  // Flow control: pause stdin until the socket is ready (already true here).
  process.stdin.resume()
})

socket.on('error', err => {
  process.stderr.write(`pi-acp mcp-shim: socket error: ${err?.message ?? err}\n`)
  teardown()
})

socket.on('close', teardown)

process.stdin.on('error', teardown)

// stdin (pi MCP client) -> socket (pi-acp)
pipe(process.stdin, socket)
// socket (pi-acp) -> stdout (pi MCP client)
pipe(socket as unknown as NodeJS.ReadableStream, process.stdout)
