import { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { Stream } from '@agentclientprotocol/sdk'
import { WebSocketServer, type WebSocket } from 'ws'
import { PiAcpAgent } from '../acp/agent.js'

function wsToStream(ws: WebSocket): Stream {
  const readable = new ReadableStream<any>({
    start(controller) {
      ws.on('message', data => {
        try {
          const text = typeof data === 'string' ? data : data.toString('utf-8')
          const msg = JSON.parse(text)
          controller.enqueue(msg)
        } catch {
          // Ignore malformed frames.
        }
      })

      ws.on('close', () => controller.close())
      ws.on('error', err => controller.error(err))
    }
  })

  const writable = new WritableStream<any>({
    write(msg) {
      if (ws.readyState !== ws.OPEN) return
      ws.send(JSON.stringify(msg))
    },
    close() {
      try {
        ws.close()
      } catch {
        // ignore
      }
    }
  })

  return { readable, writable }
}

export function startWsServer(opts: { host: string; port: number }) {
  const wss = new WebSocketServer({ host: opts.host, port: opts.port })

  wss.on('connection', ws => {
    const stream = wsToStream(ws)
    new AgentSideConnection(conn => new PiAcpAgent(conn), stream)
  })

  return wss
}

