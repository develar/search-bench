# accio stage timing kit (for a remote build host)

- `queries.jsonl` (not in the repository): agent queries as accio argv, one JSON object per line: `{"id", "kind", "argv"}`.
- `run.mjs <bin[,bin2]> <repo> <out.jsonl> [reps]`: runs every query with `ACCIO_TIMING=1 --format json`, one warm-up and `reps`
  timed runs. With two binaries (comma separated) it interleaves them per rep (A/B on the same load). It runs `<bin> index` first.
  It reads `queries.jsonl` from its own directory.
- `ab.sh <base-hash> [reps]`: builds the working tree and the base commit in a brd-host slot, then runs both binaries interleaved. Name the base by its hash: in a slot, HEAD is the snapshot commit that already holds the change.
- `analyze-timing.mjs <out.jsonl> [K]`: the stage split (candidates, scan, the rest), the slowest 25.
- `split-ab.mjs <ab.jsonl> <a.jsonl> <b.jsonl>` then `compare-timing.mjs <a.jsonl> <b.jsonl>`: before/after per query, and the
  correctness check (complete answers keep their hit count).

On the host: copy `run.mjs` and `queries.jsonl` into an untracked directory of your lease (for example `tmp-bench-<agent>/`),
then `brd-host run <host> --nice 0 --fetch tmp-bench-<agent>/out -- zsh -c 'mkdir -p tmp-bench-<agent>/out && ...'`. An empty `--fetch` directory does not reach the slot. Move an untracked bench directory out of the lease before `scripts/check.sh`. The repository on the host is `BENCH_REPO`, by default `$HOME/projects/idea-1`.
Remove the directory before `scripts/check.sh` (its guard rejects untracked paths without a group) and never commit it.
Run the analyzers locally with `bun studio/<script>`.
