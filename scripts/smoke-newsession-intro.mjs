import { spawn } from 'node:child_process'

const p = spawn('node', ['dist/index.js'], { stdio: ['pipe', 'pipe', 'inherit'] })

let buf = ''
let sid = null
let gotIntro = false

p.stdout.on('data', d => {
  buf += d.toString('utf8')
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx)
    buf = buf.slice(idx + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)

    if (msg.id === 2) {
      sid = msg.result?.sessionId
      console.log('session/new response _meta.piAcp.startupInfo present:', Boolean(msg.result?._meta?.piAcp?.startupInfo))
    }

    if (msg.method === 'session/update') {
      const up = msg.params?.update
      if (up?.sessionUpdate === 'agent_message_chunk' && up?.content?.type === 'text') {
        const t = String(up.content.text)
        if (t.includes('[Context]') && t.includes('[Skills]') && t.includes('[Extensions]')) {
          gotIntro = true
          console.log('OK: got intro via session/update (before any prompt)')
          p.kill('SIGTERM')
          process.exit(0)
        }
      }
    }
  }
})

function send(obj) {
  p.stdin.write(JSON.stringify(obj) + '\n')
}

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })
send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } })

setTimeout(() => {
  if (!gotIntro) {
    console.error('Did not receive intro before prompt. sessionId=', sid)
    p.kill('SIGTERM')
    process.exit(1)
  }
}, 1500)
