// Streams the lines of a big file without loading it whole.
export async function* lines(path) {
  const decoder = new TextDecoder()
  let rest = ''
  for await (const chunk of Bun.file(path).stream()) {
    rest += decoder.decode(chunk, {stream: true})
    let start = 0
    let nl
    while ((nl = rest.indexOf('\n', start)) !== -1) {
      yield rest.slice(start, nl)
      start = nl + 1
    }
    rest = rest.slice(start)
  }
  rest += decoder.decode()
  if (rest.length > 0) yield rest
}

export async function readJsonl(path) {
  const out = []
  if (!(await Bun.file(path).exists())) return out
  for await (const line of lines(path)) {
    if (line.trim()) out.push(JSON.parse(line))
  }
  return out
}

export function toJsonl(records) {
  return records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '')
}
