// Splits an interleaved A/B run into two files that compare-timing.mjs reads. Usage: bun split-ab.mjs <ab.jsonl> <a.jsonl> <b.jsonl>
import {readFileSync, writeFileSync} from 'node:fs'
const [inp, a, b] = process.argv.slice(2)
const rows = readFileSync(inp, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
writeFileSync(a, rows.map(r => JSON.stringify(r.id === 'meta' ? r : {...r, others: undefined})).join('\n') + '\n')
writeFileSync(b, rows.filter(r => r.id !== 'meta').map(r => JSON.stringify({...r, warm: r.others[0].warm, runs: r.others[0].runs, others: undefined})).join('\n') + '\n')
