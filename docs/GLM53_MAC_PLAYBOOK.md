# GLM-5.3-Flash on the studio Mac (M3 Ultra 512GB) — ops playbook

Produced by a three-lens research sweep + synthesis on 2026-08-27, the night
after the watchdog panic. Two corrections against our own ground truth:
we already run mlx-vlm 0.6.17 (item 1.2 is done), and this server ignores
request-level chat_template_kwargs — reasoning effort is pinned to low by
editing the checkpoint chat_template.jinja default instead (backup kept as
chat_template.jinja.orig). max_kv_size is applied live via
PATCH /v1/settings (POST/PUT return 405).

# GLM-5.3-Flash on M3 Ultra 512GB — Headless Survival & Speed Playbook

Context anchors: 2 tok/s decode today (clean-box parity is ~6.2 tok/s on the same chip — https://huggingface.co/Vontra/GLM-5.3-Flash-MLX-4bit-MTP), one `watchdog timeout: no checkins from watchdogd in 91 seconds` panic (compressor thrash starved watchdogd — man 8 watchdogd; https://eclecticlight.co/2025/02/19/how-to-deal-with-a-kernel-panic/), a 293GB-RSS hf downloader, and servers bloated to 117GB RSS. The deficit is software + memory pressure, not hardware: GLM-5 744B Q4 does 15.4 tok/s on this exact machine (https://x.com/awnihannun/status/2022007608811696158).

---

## 1. DO NOW — safe tonight over ssh, no root (ranked by expected gain)

**1.1 Kill the downloader and every stale server; run exactly ONE server.** Biggest single win, both stability and speed. The panic recipe was: wired model + 117GB of KV/prompt-cache bloat + 293GB downloader RSS → 14MB free → compressor thrash → watchdogd starved 91s → panic. Your 2 tok/s today is at least partly page-fault storm, not model speed. Never download while serving.
```
PGID=$(ps -o pgid= -p <downloader_or_supervisor_pid> | tr -d ' '); kill -TERM -- -"$PGID"; pgrep -g "$PGID"   # must print nothing
pkill -f mlx_vlm   # then relaunch ONE server with the section-3 line
```
Process-group kill, not single-PID kill — an in-flight child otherwise keeps running unsupervised. (Brief C; https://github.com/ollama/ollama/issues/16698 shows the KV-accumulation → tgTPS-collapse pattern.) Expected: 2 → ~5-6 tok/s just from removing pressure.

**1.2 Upgrade mlx-vlm to ≥0.6.17.** Your installed copy is 0.6.13; the glm5_next port (fused `gated_delta_update` decode kernel, chunked indexer) landed in 0.6.17 via PR #2030 (merged Aug 26). 0.6.14+ also adds `/v1/settings` live retuning and per-generator prefill overrides. https://github.com/Blaizzy/mlx-vlm/pull/2030 · https://github.com/Blaizzy/mlx-vlm/releases
```
uv pip install -U "mlx-vlm>=0.6.17" mlx mlx-metal
```

**1.3 Set `reasoning_effort: "low"` on every request (client side).** GLM-5.3 defaults to **max** effort and reasoning cannot be disabled; at max it emits ~75K output tokens per task (Z.ai) and was ~50% more verbose than median on Artificial Analysis (150M tokens). With your 1200-token completion cap, max-effort just truncates mid-reasoning — you pay full decode time for zero answers. Pass via `chat_template_kwargs`. This is the largest *wall-clock* lever available tonight. https://docs.z.ai/guides/llm/glm-5.3 · https://artificialanalysis.ai/models/glm-5-3-flash · https://unsloth.ai/docs/models/glm-5.3

**1.4 Relaunch with bounded memory (section 3 line).** `--max-kv-size` defaults to None = unbounded against an advertised 1M context — that, plus concurrent batches, is what grew your servers to 117GB (matches mlx-lm #883/#1390: growth is prompt/KV, not Metal buffer cache). Bound it. https://github.com/ml-explore/mlx-lm/issues/883 · https://github.com/ml-explore/mlx-lm/issues/1390

**1.5 Cap the Metal buffer cache via a 3-line wrapper.** Conflict resolution: community posts imply an env var; Brief A's `strings libmlx.dylib` audit is authoritative — **no `MLX_METAL_CACHE` env var exists**, only the `mx.set_cache_limit()` API, and the server exposes no flag. Trust the source audit. Wrapper is in section 3. https://ml-explore.github.io/mlx/build/html/python/memory_management.html

**1.6 Start a user-level memguard in tmux** (root LaunchDaemon version in section 2). Kills the sacrificial process before free memory collapses — pressure hits WARN well before the 14MB spiral:
```
tmux new -d -s memguard 'while :; do LVL=$(sysctl -n kern.memorystatus_vm_pressure_level); \
  [ "$LVL" -ge 4 ] && pkill -9 -f "hf download"; sleep 5; done'
```
(https://developer.apple.com/forums/thread/85474 · http://newosxbook.com/articles/MemoryPressure.html)

**1.7 Wrap the server in `caffeinate -dimsu`** — no-root substitute for pmset until the owner runs section 2. (https://github.com/anurmatov/mac-studio-server)

**1.8 Do NOT chase MTP tonight.** Conflict: drowzeys claims 26.4 tok/s with MTP+Dual-ANE; Vontra's own measured numbers show MTP is a *net loss* (6.22 → 5.00 tok/s) on validated builds, and mlx-vlm #2033 shows MTP + concurrency causes infinite same-token decode loops. Trust Vontra: first-party measurements, consistent with the upstream bug; drowzeys is an unverified third-party pack with a GoFundMe link. Watch draft PR #2044 instead. https://huggingface.co/Vontra/GLM-5.3-Flash-MLX-oQ4-MTP · https://github.com/Blaizzy/mlx-vlm/issues/2033 · https://github.com/Blaizzy/mlx-vlm/pulls?q=glm5

**1.9 Skip `--kv-bits` entirely for this workload.** Quantized KV only kicks in after `--quantized-kv-start` = 5000 tokens; your requests total ~3-3.5K tokens, so it literally never activates — and glm5_next's 34 KDA layers carry fixed recurrent state anyway (only 11 layers have conventional KV), plus day-0 hybrid-cache interaction is untested and `--kv-bits` has a history of silent context corruption (#1310). (Brief A source audit; https://github.com/Blaizzy/mlx-vlm/issues/1310)

---

## 2. NEEDS ROOT/USER — owner runs once

```
# Sleep/reliability (persist across reboots)
sudo pmset -a sleep 0 disksleep 0 displaysleep 0
sudo pmset -a disablesleep 1 powernap 0 standby 0 autopoweroff 0
sudo pmset -a autorestart 1
sudo systemsetup -setrestartfreeze on      # auto-reboot on freeze — the panic IS the recovery path
sudo mdutil -a -i off                      # stop Spotlight indexing 178-296GB of safetensors
```
(https://github.com/anurmatov/mac-studio-server · Brief C)

**iogpu.wired_limit_mb — conflict resolution.** Brief A says raise it (480000-499000, field-proven on 512GB: https://github.com/ml-explore/mlx-lm/issues/1332, https://gist.github.com/LocalAiCherry/6c769b529ebaebc6088449f63025676d); Brief C says on a box that just thrash-panicked, keep it at/below default so GPU wired memory can never push CPU-side free to zero. **Trust Brief C for your box today**: your panic was CPU-side memory starvation, and the default (0 → ~384GB, 75% of RAM) already fits a 178GB 4-bit model plus bounded KV with ~200GB to spare. Raising the limit only shrinks the safety margin that failed you. Decision rule:
- Running the 4-bit (~178GB): leave at default. Do nothing.
- Only if you move to the 6-bit (~296GB) *and* long contexts: `sudo sysctl iogpu.wired_limit_mb=458752` (448GB — Brief C's conservative value, not 499000), optionally `sudo sysctl iogpu.wired_lwm_mb=440000`. Resets at reboot; reapply via LaunchDaemon if adopted. (https://blog.peddals.com/en/fine-tune-vram-size-of-mac-for-llm/ · https://techobsessed.net/2023/12/increasing-ram-available-to-gpu-on-apple-silicon-macs-for-running-large-language-models/)

**Install memguard as a LaunchDaemon** (survives reboot + login-less boot): script at `/usr/local/bin/memguard.sh` and plist `/Library/LaunchDaemons/com.pepper.memguard.plist` exactly as in Brief C, then `sudo launchctl bootstrap system /Library/LaunchDaemons/com.pepper.memguard.plist`. (http://newosxbook.com/articles/MemoryPressure.html · https://searchfox.org/firefox-main/source/xpcom/base/AvailableMemoryWatcherMac.cpp) Test without allocating: `sudo memory_pressure -S -l critical -s 30`.

**Do NOT do:** `vm_compressor=2` boot-arg or `wdt=-1` watchdog disable — both require downgrading to Permissive Security via recovery, and `wdt=-1` converts a 2-minute auto-recovery panic into an indefinitely wedged headless machine needing a physical power cycle. (https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/arm/arm_init.c · https://support.apple.com/guide/security/contents-a-localpolicy-file-mac-apple-silicon-secc745a0845/web)

**Optional long-term:** replace the cron `@reboot` polling supervisor with a launchd job (`KeepAlive` + `ThrottleInterval`) so stop/disable/restart is `launchctl bootout|disable|kickstart` instead of PGID surgery. (https://blog.jan-ahrens.eu/2017/01/13/cron-is-dead-long-live-launchd.html)

---

## 3. SERVER LAUNCH LINE

`/Users/dalnk/pepper/wrapper.py`:
```python
import mlx.core as mx
mx.set_cache_limit(8 << 30)   # 8GB Metal buffer-cache cap; no env var exists for this
import sys
from mlx_vlm.server.cli import main
main()
```
Launch (tmux/nohup, mlx-vlm ≥ 0.6.17):
```
caffeinate -dimsu env MLX_METAL_FAST_SYNCH=1 APC_ENABLED=1 \
  python /Users/dalnk/pepper/wrapper.py \
  --model <GLM-5.3-Flash-MLX-4bit-path> \
  --port 8084 \
  --max-kv-size 16384 \
  --max-num-seqs 1 \
  --prefill-step-size 4096 \
  --log-progress-interval 0
```
Rationale, per flag:
- `--max-kv-size 16384`: ~2-3.5K prompt tokens + 1200 completion + margin; kills the unbounded-KV path behind the 117GB bloat. (Brief A source audit; https://github.com/ml-explore/mlx-lm/issues/1390)
- `--max-num-seqs 1`: bounds concurrent-batch peak memory and sidesteps the #2033 concurrency/starvation class entirely. (https://github.com/Blaizzy/mlx-vlm/issues/2033)
- `--prefill-step-size 4096`: makes your ~2-3.5K-token prompts a single prefill chunk → one sync barrier instead of two. Gain is modest *for your short prompts*; the 8192 advice in Brief A matters for long prompts. (https://github.com/chanunc/local-llm-mac-studio/blob/main/docs/servers/lm-studio/prefill-speed-technique.md)
- `MLX_METAL_FAST_SYNCH=1`: confirmed present in libmlx; used in GLM-5.2-on-512GB field notes. (https://gist.github.com/LocalAiCherry/6c769b529ebaebc6088449f63025676d)
- `APC_ENABLED=1`: prompt-cache across turns despite per-request `clear_cache()` (#999) — helps if your 7K-char prompts share a system-prompt prefix. (https://github.com/Blaizzy/mlx-vlm/issues/999)
- Deliberately absent: `--kv-bits` (never activates below 5000 tokens; see 1.9), `--draft-model`/MTP (net loss; see 1.8), vision flags (text-only — vision cache stays empty with no images).
- Client side: `reasoning_effort:"low"` via `chat_template_kwargs`; sampling temp 1.0 / top_p 0.95. (https://unsloth.ai/docs/models/glm-5.3)

Path from ~6 to 10+ tok/s is upstream, not config: mlx wheel > 0.32.2 containing the gated_delta SIMD-pack kernel (https://github.com/ml-explore/mlx/pulls?q=is%3Apr+delta+OR+kda+OR+ssm+kernel, PR #4409, merged Aug 26) and mlx-vlm #2044 (MTP) once #2033-class bugs are fixed. For output *quality*, note PipeNetwork's four numerical fixes (fp32 `A_log`/`dt_bias`/mHC params, ClampedSwiGLU, eps mismatches, fp32 router logits) are not yet upstream — parity 3.1e-1 vs 9e-7 — their runtime/quants are the current accuracy reference. (https://github.com/PipeNetwork/glm53-flash-mlx · https://github.com/Blaizzy/mlx-vlm/pull/2030)

---

## 4. DOWNLOAD HYGIENE — future big pulls

```
uv pip install -U "huggingface_hub" "hf-xet>=1.4.2"    # 1.4.2 scales buffers by active downloads
```
(https://github.com/huggingface/xet-core/releases)

Env for every big pull (add to the puller's profile; read at import time):
```
export HF_XET_NUM_CONCURRENT_RANGE_GETS=4              # default 16
export HF_XET_FIXED_DOWNLOAD_CONCURRENCY=4             # pins adaptive controller (max 64)
export HF_XET_DATA_MAX_CONCURRENT_FILE_DOWNLOADS=2     # default 8
export HF_XET_RECONSTRUCTION_DOWNLOAD_BUFFER_SIZE=1gb  # default 2gb
export HF_XET_RECONSTRUCTION_DOWNLOAD_BUFFER_PERFILE_SIZE=256mb
export HF_XET_RECONSTRUCTION_DOWNLOAD_BUFFER_LIMIT=2gb # default 8gb hard limit
export HF_XET_RECONSTRUCT_WRITE_SEQUENTIALLY=1         # your 293GB "RSS" was largely dirty file-backed pages from parallel direct writes
```
(https://huggingface.co/docs/huggingface_hub/en/package_reference/environment_variables · https://huggingface.co/docs/hub/en/xet/using-xet-storage)

Rules:
- **Kernel-enforced cap, always:** `zsh -c 'ulimit -v 33554432; hf download ...'` (32GB RLIMIT_AS; enforced on macOS, unlike RLIMIT_RSS). The kernel, not the guard, bounds the process. (Brief C)
- **Never** `HF_XET_HIGH_PERFORMANCE=1` on a box that also serves (raises buffers to 64GB, concurrency to 124). Nuclear fallback: `HF_HUB_DISABLE_XET=1` (plain HTTP path, small streaming buffers; `hf_transfer` is deprecated and no longer an alternative). (https://huggingface.co/docs/huggingface_hub/en/guides/download)
- **One storage layout** to avoid the double-copy: either always cache-mode then symlink (`SNAP=$(hf download org/repo); ln -s "$SNAP" /models/repo`) or always `--local-dir` — mixing the two downloads the repo twice. Reclaim strays: `hf cache scan` / `hf cache delete`. (https://huggingface.co/docs/huggingface_hub/en/guides/manage-cache · https://github.com/huggingface/huggingface_hub/issues/3390)
- **Never concurrently with inference.** That combination is your panic.

---

## 5. WATCH FOR — three failure signatures

**5.1 Compressor death-spiral (precursor to the 91s watchdog panic).** Pressure transitions WARN → CRITICAL minutes before free memory hits 14MB.
```
sysctl -n kern.memorystatus_vm_pressure_level    # 1=NORMAL 2=WARN 4=CRITICAL — act at 2, kill the downloader at 4
```
Corroborate with `memory_pressure | grep 'free percentage'` (alert ≤ 8%). Post-mortem check for a panic you slept through: `ls -t /Library/Logs/DiagnosticReports/ | head`. (https://developer.apple.com/forums/thread/85474 · man memory_pressure)

**5.2 Server KV/prompt-cache bloat (the 117GB pattern).**
```
ps -eo pid,rss,etime,command | grep '[m]lx' | awk '{printf "%d %.1fGB %s\n", $1, $2/1048576, $3}'
```
Alert when server RSS exceeds model size + 25GB (for the 178GB 4-bit: alert at ~200GB) — restart the server; with `--max-kv-size` + `--max-num-seqs 1` + the cache-limit wrapper this should no longer occur, so growth means a leak worth filing. (https://github.com/ml-explore/mlx-lm/issues/883 · https://github.com/ollama/ollama/issues/16698)

**5.3 Decode collapse / runaway generation (your 2 tok/s day; #2033's same-token infinite loop).** Timed canary every few minutes:
```
S=$(date +%s); N=$(curl -s localhost:8084/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Say OK."}],"max_tokens":64,"chat_template_kwargs":{"reasoning_effort":"low"}}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["usage"]["completion_tokens"])'); \
  echo "$(( N / ( $(date +%s) - S + 1) )) tok/s"
```
Alert below ~4 tok/s (healthy baseline ~6; https://huggingface.co/Vontra/GLM-5.3-Flash-MLX-4bit-MTP) — first suspect is concurrent memory pressure (check 5.1), second is a wedged decode loop (https://github.com/Blaizzy/mlx-vlm/issues/2033): restart the server.

---

**Conflict summary:** (a) wired-limit raise (A) vs cap (C) → C wins for your thrash-panicked box; raise only if the 6-bit quant moves in. (b) MTP 26.4 tok/s claim (drowzeys) vs MTP-is-slower (Vontra + issue #2033) → trust Vontra; unverified pack contradicting first-party measurements. (c) Buffer-cache env var (community lore) vs no-such-var (A's dylib strings audit) → trust the audit; use the wrapper. (d) kv-quant as a win (A, generic) vs irrelevant here → your ~3.5K-token requests never reach the 5000-token quantization start; skip it.
