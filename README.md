# search-bench

This benchmark compares the search of JetBrains MCP (through ij-proxy) with accio, by answer quality and speed.
It uses the real queries of the agents from the Claude Code session files. Bun runs every script. The scripts have no dependencies.

## Steps

| Step | Command | Output |
| --- | --- | --- |
| 1. Extract the search calls | `bun 1-extract.mjs` | `data/calls.jsonl` |
| 2. Report the history | `bun 2-history.mjs` | `report/history.md` |
| 3. Pick and translate the corpus | `bun 3-corpus.mjs --seed 7` | `data/corpus.jsonl` |
| 4. Run the corpus live | `bun 4-run.mjs` | `data/runs.jsonl`, `data/run-meta.json`, `data/snapshot/` |
| 5. Grade and report | `bun 5-grade.mjs` | `data/grades.jsonl`, `report/compare.md` |
| 6. Render the report | `bun 6-html.mjs [--pdf]` | `report/compare.html`, `report/compare-standalone.html`, `report/compare.pdf` |

Step 1 keeps a cache per session file in `data/extract-cache/`, so a second run reads only the changed files.
Step 1 leaves out the sessions in `data/exclude-sessions.txt` and the sessions that run in this folder.

## Step 4

- The IDE must have the checkout open and must not index. The checkout is `BENCH_REPO`, by default `~/projects/idea-1`.
- The run starts ij-proxy from `community/build/mcp-servers/ij-proxy/dist/` of that checkout, the way an agent does.
- The checkout must not change during the run. The run stores the files the grader reads in `data/snapshot/`, and it records the files that changed.
- Run it on a quiet machine. Each record holds the load average, and the report warns when it is high.
- Flags: `--max N`, `--kinds text,regex`, `--qid q001,q002`, `--resume` (skip the finished queries), `--reps 3`.

## Not in the repository

`data/`, `report/` and `studio/queries.jsonl` hold queries from private session files and copies of the files of the checkout. Step 1 makes them again from your own session files.

## Tests

`bun test` checks the parser of accio commands and answers, the globs, and the translation between the tools.
