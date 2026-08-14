#!/usr/bin/env python3
"""Pepper's voice worker — JSONL over stdio, one request at a time.

Loads a Qwen3-TTS model once via mlx-audio, zero-shot conditioned on a
golden reference clip (voices/<identity>.wav), then renders text lines to
24kHz mono 16-bit WAV files on demand.

Protocol (mirrors src/brain: one JSON object per line, id echoed back):
  -> {"id":1,"op":"status"}
  <- {"id":1,"ok":true,"model":"...","identity":"bright-anchor"}
  -> {"id":2,"op":"tts","text":"...","out":"/abs/path.wav"}
  <- {"id":2,"ok":true,"dur":7.4}
  <- {"id":N,"ok":false,"error":"..."}   on any failure

Flags:
  --model <id> --ref <wav> --ref-text <str> [--identity <name>]
  --config <json>   alternative: {"model","ref","refText"|"ref_text","identity"}
  --warmup          load the model (predownloads weights), print one
                    {"ok":true,...} line, exit 0. No stdin loop.

stdlib + mlx_audio + numpy only. stdout carries protocol JSON exclusively
from this module; anything else a dependency prints is skipped by the
line-parser on the Node side.
"""

import argparse
import json
import os
import sys
import wave


def reply(obj):
    """One protocol line out, flushed — the Node side reads line-buffered."""
    try:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()
    except (BrokenPipeError, OSError):
        raise SystemExit(0)


def parse_args(argv):
    p = argparse.ArgumentParser(prog="worker.py", add_help=False)
    p.add_argument("--model", default="")
    p.add_argument("--ref", default="")
    p.add_argument("--ref-text", dest="ref_text", default="")
    p.add_argument("--identity", default="")
    p.add_argument("--config", default="")
    p.add_argument("--warmup", action="store_true")
    args = p.parse_args(argv)
    if args.config:
        try:
            with open(args.config, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except (OSError, ValueError):
            cfg = None
        if isinstance(cfg, dict):
            args.model = args.model or str(cfg.get("model") or "")
            args.ref = args.ref or str(cfg.get("ref") or "")
            args.ref_text = args.ref_text or str(
                cfg.get("refText") or cfg.get("ref_text") or ""
            )
            args.identity = args.identity or str(cfg.get("identity") or "")
    if not args.identity and args.ref:
        args.identity = os.path.splitext(os.path.basename(args.ref))[0]
    return args


def render(model, ref_audio, ref_text, text, out):
    """Generate speech for one line and atomically write a WAV. -> seconds."""
    import numpy as np

    parts = []
    rate = 24000
    results = model.generate(
        text=text, ref_audio=ref_audio, ref_text=ref_text, verbose=False
    )
    for seg in results:
        audio = getattr(seg, "audio", None)
        if audio is None:  # never truth-test an mlx array
            continue
        rate = int(getattr(seg, "sample_rate", None) or rate)
        arr = np.asarray(audio).astype(np.float32).reshape(-1)
        if arr.size:
            parts.append(arr)
    if not parts:
        raise RuntimeError("model produced no audio")
    pcm = np.concatenate(parts) if len(parts) > 1 else parts[0]
    pcm16 = (np.clip(pcm, -1.0, 1.0) * 32767.0).astype(np.int16)
    out_dir = os.path.dirname(out)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    # tmp + rename: the Node side treats an existing file as "already
    # rendered", so a half-written WAV must never land at the final path.
    tmp = out + ".tmp"
    try:
        with wave.open(tmp, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)  # 16-bit
            w.setframerate(rate)
            w.writeframes(pcm16.tobytes())
        os.replace(tmp, out)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    return pcm16.size / float(rate)


def serve(model, args):
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            reply({"id": None, "ok": False, "error": "invalid JSON"})
            continue
        if not isinstance(req, dict):
            reply({"id": None, "ok": False, "error": "request must be an object"})
            continue
        rid = req.get("id")
        op = req.get("op")
        try:
            if op == "status":
                reply({
                    "id": rid,
                    "ok": True,
                    "model": args.model,
                    "identity": args.identity,
                })
            elif op == "tts":
                text = str(req.get("text") or "").strip()
                out = str(req.get("out") or "")
                if not text:
                    reply({"id": rid, "ok": False, "error": "text required"})
                elif not out or not os.path.isabs(out):
                    reply({"id": rid, "ok": False,
                           "error": "out must be an absolute path"})
                else:
                    dur = render(model, args.ref, args.ref_text, text, out)
                    reply({"id": rid, "ok": True, "dur": round(dur, 2)})
            else:
                reply({"id": rid, "ok": False, "error": "unknown op: %r" % (op,)})
        except SystemExit:
            raise
        except BaseException as e:  # a failed line must never kill the loop
            reply({"id": rid, "ok": False, "error": str(e) or type(e).__name__})


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if not args.model:
        reply({"ok": False, "error": "--model required"})
        return 2
    if not args.warmup and (not args.ref or not os.path.isfile(args.ref)):
        reply({"ok": False, "error": "reference clip not found: %s" % args.ref})
        return 2
    try:
        from mlx_audio.tts.utils import load_model
        model = load_model(args.model)
    except BaseException as e:
        reply({"ok": False, "error": "model load failed: %s" % (str(e) or type(e).__name__)})
        return 1
    if args.warmup:
        reply({
            "ok": True,
            "model": args.model,
            "identity": args.identity,
            "python": sys.version.split()[0],
        })
        return 0
    serve(model, args)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (KeyboardInterrupt, BrokenPipeError):
        sys.exit(0)
