import { spawn } from 'node:child_process'

const agent = spawn('node', ['dist/index.js'], { stdio: ['pipe', 'pipe', 'inherit'] })

let buf = ''
agent.stdout.on('data', d => {
  buf += d.toString('utf8')
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx)
    buf = buf.slice(idx + 1)
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      if (msg.method === 'session/update') {
        const up = msg.params?.update
        if (up?.sessionUpdate === 'agent_message_chunk' && up?.content?.type === 'text') {
          const t = String(up.content.text)
          if (t.includes('[Context]') && t.includes('[Skills]') && t.includes('[Extensions]')) {
            console.log('OK: got startup info in agent_message_chunk')
            agent.kill('SIGTERM')
            process.exit(0)
          }
        }
      }
    } catch {
      // ignore
    }
  }
})

function send(obj) {
  agent.stdin.write(JSON.stringify(obj) + '\n')
}

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })
send({
  jsonrpc: '2.0',
  id: 2,
  method: 'session/new',
  params: { cwd: process.cwd(), mcpServers: [] }
})

// Trigger first prompt so startup info flushes in the first turn
setTimeout(() => {
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'session/prompt',
    params: { sessionId: 'dummy', prompt: [{ type: 'text', text: 'hi' }] }
  })
}, 200)

// Replace dummy session id once we see session/new response
agent.stdout.on('data', d => {
  const s = d.toString('utf8')
  const m = s.match(/"id":2,[^\n]*"result":\{[^\}]*"sessionId":"([^"]+)"/)
  if (m) {
    const sid = m[1]
    // resend prompt with real session id
    send({
      jsonrpc: '2.0',
      id: 4,
      method: 'session/prompt',
      params: { sessionId: sid, prompt: [{ type: 'text', text: 'hi' }] }
    })
  }
})

setTimeout(() => {
  console.error('FAIL: did not observe startup info')
  agent.kill('SIGTERM')
  process.exit(1)
}, 5000)
