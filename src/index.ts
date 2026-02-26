import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { PiAcpAgent } from './acp/agent.js'
import { startWsServer } from './server/ws.js'
// Terminal Auth entrypoint. The ACP client launches the agent with `--terminal-login`.
if (process.argv.includes('--terminal-login')) {
  const { spawnSync } = await import('node:child_process')
  const cmd = process.env.PI_ACP_PI_COMMAND ?? 'pi'
  const res = spawnSync(cmd, [], { stdio: 'inherit', env: process.env })

  if ((res as any).error && (res as any).error.code === 'ENOENT') {
    process.stderr.write(
      `pi-acp: could not start pi (command not found: ${cmd}). Install it via \`npm install -g @mariozechner/pi-coding-agent\` or ensure \`pi\` is on your PATH.\n`
    )
    process.exit(1)
  }

  process.exit(typeof res.status === 'number' ? res.status : 1)
}

if (process.argv.includes('--ws')) {
  const portFlag = process.argv.find(a => a.startsWith('--port='))
  const hostFlag = process.argv.find(a => a.startsWith('--host='))
  const port = Number.parseInt(portFlag?.split('=')[1] ?? process.env.PI_ACP_WS_PORT ?? '8765', 10)
  const host = hostFlag?.split('=')[1] ?? process.env.PI_ACP_WS_HOST ?? '127.0.0.1'

  const server = startWsServer({ host, port: Number.isFinite(port) ? port : 8765 })
  process.stderr.write(`pi-acp: ws server listening on ws://${host}:${Number.isFinite(port) ? port : 8765}\n`)

  const shutdown = () => {
    server.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.stdin.resume()
} else {
  const input = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>(resolve => {
        if ((process.stdout as any).destroyed || !process.stdout.writable) return resolve()

        try {
          process.stdout.write(chunk, err => {
            void err
            resolve()
          })
        } catch {
          // Common: ERR_STREAM_DESTROYED ("Cannot call write after a stream was destroyed").
          resolve()
        }
      })
    }
  })

  const output = new ReadableStream<Uint8Array>({
    start(controller) {
      process.stdin.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      process.stdin.on('end', () => controller.close())
      process.stdin.on('error', err => controller.error(err))
    }
  })

  const stream = ndJsonStream(input, output)

  new AgentSideConnection(conn => new PiAcpAgent(conn), stream)

  process.stdin.resume()
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))

  // Avoid crashing if the client closes stdout early.
  process.stdout.on('error', () => {
    try {
      process.exit(0)
    } catch {
      // ignore
    }
  })
}
