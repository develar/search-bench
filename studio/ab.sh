#!/bin/zsh
# Builds accio from the working tree and from a base commit, then runs both binaries interleaved.
# Usage: ab.sh <base-commit-hash> [reps=3]
# Name the base by its hash. In a brd-host slot, HEAD is the snapshot commit that already holds the change.
set -e
base=${1:?usage: ab.sh <base-commit-hash> [reps]}
reps=${2:-3}
mkdir -p tmp-search-bench/out
changed=(${(f)"$(git diff --name-only $base -- crates src Cargo.toml Cargo.lock)"})
(( ${#changed} )) || { echo "no change against $base"; exit 1 }
echo "== files that differ from $base: ${#changed}"
cargo build --release 2>&1 | tail -1
cp target/release/accio /tmp/sb-accio-new
saved=/tmp/sb-ab-saved; rm -rf $saved; mkdir -p $saved
for f in $changed; do
  if [[ -e $f ]]; then mkdir -p $saved/${f:h}; cp $f $saved/$f; fi
  if git cat-file -e $base:$f 2>/dev/null; then mkdir -p ${f:h}; git show $base:$f > $f; else rm -f $f; fi
done
cargo build --release 2>&1 | tail -1
cp target/release/accio /tmp/sb-accio-base
for f in $changed; do
  if [[ -e $saved/$f ]]; then cp $saved/$f $f; else rm -f $f; fi
done
uptime
bun tmp-search-bench/run.mjs /tmp/sb-accio-base,/tmp/sb-accio-new ${BENCH_REPO:-$HOME/projects/idea-1} tmp-search-bench/out/results-ab.jsonl $reps
uptime
