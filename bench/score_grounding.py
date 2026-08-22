#!/usr/bin/env python3
"""MoltBench grounding metric v0 — deterministic, dependency-free.

Extracts numbers and multi-word proper entities from a model's report and
checks each appears in the wire bundle it was given. Crude and reproducible.

Usage: score_grounding.py bundles.json outputs.json
"""
import json
import re
import sys


def entities(text):
    ents = set(re.findall(
        r"\b\d[\d,.]*\s?(?:percent|%|billion|million|trillion|B|M|pts)?\b", text))
    ents |= set(re.findall(
        r"\b(?:[A-Z][a-zA-Z0-9'&.-]+(?:\s+[A-Z][a-zA-Z0-9'&.-]+)+)\b", text))
    out = set()
    for e in ents:
        e = e.strip()
        # v0.1: sentence-boundary mash ("GPT-5. TechCrunch") is two mentions,
        # not an entity; leading articles are prose, not provenance.
        if ". " in e or e.endswith("."):
            continue
        e = re.sub(r"^(?:The|An|A)\s+", "", e)
        if len(e) > 2:
            out.add(e)
    return out


def main(bundles_path, outputs_path):
    bundles = {b["id"]: b for b in json.load(open(bundles_path))}
    data = json.load(open(outputs_path))
    rows = []
    for r in data["results"]:
        bundle = bundles.get(r["id"])
        if not bundle:
            continue
        wire = bundle["wire"].lower()
        # Think-then-speak models emit "DESK NOTES: ... ON AIR: <report>";
        # only the broadcast is scored — private reasoning isn't on air.
        on_air = r["output"].split("ON AIR:")[-1] if "ON AIR:" in r["output"] else r["output"]
        # Instrument rule: silence is a failed bundle, not a vacuous pass.
        # Reasoning models that burn their token budget on hidden thinking
        # return empty content — that must score zero, never 100%.
        if len(on_air.strip()) < 40:
            rows.append((r["id"], 0.0, ["(empty output)"]))
            continue
        ents = entities(on_air)
        if not ents:
            rows.append((r["id"], 1.0, []))
            continue
        missing = sorted(e for e in ents if e.lower() not in wire)
        rows.append((r["id"], 1 - len(missing) / len(ents), missing))
    if not rows:
        print("no scorable outputs")
        return 1
    avg = sum(x[1] for x in rows) / len(rows)
    print(f"{data.get('model', outputs_path)}")
    print(f"  bundles scored : {len(rows)}")
    print(f"  grounding      : {avg:.1%}")
    for bid, s, missing in sorted(rows, key=lambda x: x[1])[:5]:
        print(f"  {bid:24s} {s:5.0%}  ungrounded: {', '.join(missing[:4])}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2]))
