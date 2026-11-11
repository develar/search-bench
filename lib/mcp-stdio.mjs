// A minimal MCP client over the stdio of ij-proxy: newline-delimited JSON-RPC.

export class McpStdio {
  constructor({command, cwd, env}) {
    this.proc = Bun.spawn(command, {cwd, env: {...process.env, ...env}, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'})
    this.nextId = 1
    this.pending = new Map()
    this.stderr = ''
    this.#readLoop()
    this.#readErr()
  }

  async #readLoop() {
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of this.proc.stdout) {
      buf += decoder.decode(chunk, {stream: true})
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        }
        catch {
          continue
        }
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          clearTimeout(p.timer)
          p.resolve({msg, at: performance.now()})
        }
      }
    }
    for (const p of this.pending.values()) p.reject(new Error(`ij-proxy exited: ${this.stderr.slice(-500)}`))
  }

  async #readErr() {
    const decoder = new TextDecoder()
    for await (const chunk of this.proc.stderr) {
      this.stderr = (this.stderr + decoder.decode(chunk)).slice(-20000)
    }
  }

  #send(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + '\n')
    this.proc.stdin.flush()
  }

  request(method, params, timeoutMs = 60000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(Object.assign(new Error(`timeout after ${timeoutMs} ms: ${method}`), {timeout: true}))
      }, timeoutMs)
      const start = performance.now()
      this.pending.set(id, {
        timer,
        reject,
        resolve: ({msg, at}) => resolve({...msg, ms: at - start}),
      })
      this.#send({jsonrpc: '2.0', id, method, params})
    })
  }

  async initialize() {
    const r = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: {name: 'search-bench', version: '1'},
    }, 30000)
    this.#send({jsonrpc: '2.0', method: 'notifications/initialized'})
    return r.result
  }

  async listTools() {
    return (await this.request('tools/list', {})).result.tools
  }

  // Returns {ms, isError, text, structured}.
  async call(name, args, timeoutMs) {
    const r = await this.request('tools/call', {name, arguments: args}, timeoutMs)
    if (r.error) return {ms: r.ms, isError: true, text: JSON.stringify(r.error), structured: null}
    const res = r.result ?? {}
    const text = (res.content ?? []).map(c => c.text ?? '').join('')
    return {ms: r.ms, isError: !!res.isError, text, structured: res.structuredContent ?? null}
  }

  close() {
    try {
      this.proc.stdin.end()
    }
    catch {}
    this.proc.kill()
  }
}
