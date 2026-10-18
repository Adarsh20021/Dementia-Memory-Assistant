"""
Recognition accuracy evaluation: False Accept Rate (FAR), False Reject Rate
(FRR), accuracy and Equal Error Rate across thresholds, using the SAME models
and preprocessing as the running service.

Dataset layout (one folder per person, any image names):

    eval_data/
      priya/      img1.jpg img2.jpg ...      <- enrolled people
      arjun/      ...
      _unknown_rahul/  ...                   <- folders starting with "_" are NEVER enrolled
      _unknown_sita/   ...                      (open-set impostors: strangers at the door)

Two protocols are reported:

1. Verification (pairwise): every image pair; same person = genuine, different
   person = impostor. Classic FAR/FRR/EER curve.
2. Identification (how the app works): for each enrolled person the first
   --enroll images form the gallery; the rest are probes. Strangers ("_" folders)
   are impostor probes. At each threshold:
      FRR  = genuine probes rejected (best score < t)
      FAR  = stranger probes accepted as someone (best score >= t)
      misID = genuine probes accepted as the WRONG person
      accuracy = correct decisions / all probes
   The app's two thresholds are also evaluated as bands (match / unsure / unknown).

Usage:
    python eval/evaluate.py --data eval_data --enroll 3
    python eval/evaluate.py --self-test        # synthetic smoke test from the sample photo

Outputs (in --out, default eval/results): verification.csv, identification.csv,
summary.json, far_frr.png
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from itertools import combinations
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import config  # noqa: E402
from app.engine import FaceEngine, decode_image  # noqa: E402

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
THRESHOLDS = np.round(np.arange(0.10, 0.86, 0.01), 2)


def load_dataset(data: Path, engine: FaceEngine):
    people: dict[str, list[np.ndarray]] = {}
    skipped = []
    for folder in sorted(p for p in data.iterdir() if p.is_dir()):
        embs = []
        for img_path in sorted(folder.iterdir()):
            if img_path.suffix.lower() not in IMAGE_EXT:
                continue
            img = decode_image(img_path.read_bytes())
            faces = engine.detect(img, config.DET_SCORE_MIN) if img is not None else []
            if not faces:
                skipped.append(str(img_path))
                continue
            emb, _ = engine.embed(img, faces[0])
            embs.append(emb)
        if embs:
            people[folder.name] = embs
    return people, skipped


def verification(people: dict[str, list[np.ndarray]]):
    genuine, impostor = [], []
    names = list(people)
    for n in names:
        for a, b in combinations(people[n], 2):
            genuine.append(float(a @ b))
    for n1, n2 in combinations(names, 2):
        for a in people[n1]:
            for b in people[n2]:
                impostor.append(float(a @ b))
    g, i = np.array(genuine), np.array(impostor)
    rows = []
    for t in THRESHOLDS:
        far = float((i >= t).mean()) if i.size else float("nan")
        frr = float((g < t).mean()) if g.size else float("nan")
        rows.append({"threshold": float(t), "FAR": far, "FRR": frr})
    return rows, g, i


def identification(people: dict[str, list[np.ndarray]], k: int):
    enrolled = {n: e for n, e in people.items() if not n.startswith("_") and len(e) > k}
    strangers = {n: e for n, e in people.items() if n.startswith("_")}
    gallery = {n: np.stack(e[:k]) for n, e in enrolled.items()}
    names = list(gallery)

    def best(emb):
        scores = [float((gallery[n] @ emb).max()) for n in names]
        j = int(np.argmax(scores))
        return names[j], scores[j]

    genuine = [(n, *best(e)) for n, embs in enrolled.items() for e in embs[k:]]
    impostor = [best(e)[1] for embs in strangers.values() for e in embs]
    # Also use enrolled people's images against a gallery WITHOUT them? Not needed: strangers cover open-set.

    rows = []
    for t in THRESHOLDS:
        g_reject = sum(1 for _, _, s in genuine if s < t)
        g_wrong = sum(1 for true, pred, s in genuine if s >= t and pred != true)
        g_right = sum(1 for true, pred, s in genuine if s >= t and pred == true)
        i_accept = sum(1 for s in impostor if s >= t)
        total = len(genuine) + len(impostor)
        rows.append(
            {
                "threshold": float(t),
                "FAR": i_accept / len(impostor) if impostor else float("nan"),
                "FRR": g_reject / len(genuine) if genuine else float("nan"),
                "misID": g_wrong / len(genuine) if genuine else float("nan"),
                "accuracy": (g_right + (len(impostor) - i_accept)) / total if total else float("nan"),
            }
        )
    return rows, genuine, impostor, names


def bands(genuine, impostor, match_t: float, unsure_t: float):
    """How the app's three outcomes would split for genuine visitors vs strangers."""

    def classify(s):
        return "match" if s >= match_t else "unsure" if s >= unsure_t else "unknown"

    g = {"match_correct": 0, "match_wrong_person": 0, "unsure": 0, "unknown": 0}
    for true, pred, s in genuine:
        c = classify(s)
        if c == "match":
            g["match_correct" if pred == true else "match_wrong_person"] += 1
        else:
            g[c] += 1
    i = {"match": 0, "unsure": 0, "unknown": 0}
    for s in impostor:
        i[classify(s)] += 1
    return {"genuine": g, "strangers": i}


def eer(rows):
    valid = [r for r in rows if not (np.isnan(r["FAR"]) or np.isnan(r["FRR"]))]
    if not valid:
        return None
    r = min(valid, key=lambda r: abs(r["FAR"] - r["FRR"]))
    return {"threshold": r["threshold"], "EER": (r["FAR"] + r["FRR"]) / 2}


def write_csv(path: Path, rows):
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)


def plot(path: Path, ver_rows, id_rows, match_t, unsure_t):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(1, 2, figsize=(12, 4.5))
    for ax, rows, title in [(axes[0], ver_rows, "Verification (pairs)"), (axes[1], id_rows, "Identification (app)")]:
        t = [r["threshold"] for r in rows]
        ax.plot(t, [r["FAR"] for r in rows], label="FAR", color="#a12222")
        ax.plot(t, [r["FRR"] for r in rows], label="FRR", color="#1f5f8b")
        if "accuracy" in rows[0]:
            ax.plot(t, [r["accuracy"] for r in rows], label="accuracy", color="#1d6b3a", linestyle="--")
        ax.axvline(match_t, color="#555", linestyle=":", label=f"MATCH {match_t}")
        ax.axvline(unsure_t, color="#999", linestyle=":", label=f"UNSURE {unsure_t}")
        ax.set_title(title)
        ax.set_xlabel("cosine similarity threshold")
        ax.set_ylim(-0.02, 1.02)
        ax.grid(alpha=0.3)
        ax.legend()
    fig.tight_layout()
    fig.savefig(path, dpi=130)


def make_self_test_dataset(engine: FaceEngine, out: Path) -> Path:
    """6 identities from the sample photo, each with 6 synthetic variations. Smoke test only."""
    img = decode_image((ROOT / "tests/data/group.jpg").read_bytes())
    faces = engine.detect(img)
    rng = np.random.default_rng(0)
    for idx, f in enumerate(faces):
        x1, y1, x2, y2 = [int(v) for v in f.bbox]
        w, h = x2 - x1, y2 - y1
        crop = img[max(0, y1 - h // 2) : y2 + h // 2, max(0, x1 - w // 2) : x2 + w // 2]
        name = f"person{idx}" if idx < 4 else f"_stranger{idx}"
        d = out / name
        d.mkdir(parents=True, exist_ok=True)
        for j in range(6):
            v = crop.copy()
            if j % 2:
                v = cv2.flip(v, 1)
            v = cv2.convertScaleAbs(v, alpha=float(rng.uniform(0.7, 1.2)), beta=float(rng.uniform(-25, 25)))
            angle = float(rng.uniform(-12, 12))
            m = cv2.getRotationMatrix2D((v.shape[1] / 2, v.shape[0] / 2), angle, float(rng.uniform(0.9, 1.1)))
            v = cv2.warpAffine(v, m, (v.shape[1], v.shape[0]), borderMode=cv2.BORDER_REFLECT)
            if j == 5:
                v = cv2.GaussianBlur(v, (5, 5), 1.2)
            cv2.imwrite(str(d / f"{j}.jpg"), v)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, help="labelled folder (see layout above)")
    ap.add_argument("--enroll", type=int, default=3, help="gallery images per person (default 3)")
    ap.add_argument("--match", type=float, default=0.5, help="MATCH_THRESHOLD to evaluate (default 0.5)")
    ap.add_argument("--unsure", type=float, default=0.35, help="UNSURE_THRESHOLD to evaluate (default 0.35)")
    ap.add_argument("--out", type=Path, default=ROOT / "eval/results")
    ap.add_argument("--self-test", action="store_true", help="run on a synthetic dataset built from the sample photo")
    args = ap.parse_args()

    engine = FaceEngine(config.MODEL_DIR)
    args.out.mkdir(parents=True, exist_ok=True)
    data = args.data
    if args.self_test:
        data = make_self_test_dataset(engine, args.out / "self_test_data")
    if not data or not data.exists():
        ap.error("--data folder is required (or use --self-test)")

    people, skipped = load_dataset(data, engine)
    if len(people) < 2:
        print("Need at least 2 people with detectable faces.", file=sys.stderr)
        return 1

    ver_rows, g, i = verification(people)
    id_rows, genuine, impostor, enrolled = identification(people, args.enroll)
    write_csv(args.out / "verification.csv", ver_rows)
    write_csv(args.out / "identification.csv", id_rows)
    plot(args.out / "far_frr.png", ver_rows, id_rows, args.match, args.unsure)

    at = lambda rows, t: next(r for r in rows if abs(r["threshold"] - t) < 1e-6)  # noqa: E731
    summary = {
        "dataset": str(data),
        "selfTest": args.self_test,
        "people": {n: len(e) for n, e in people.items()},
        "skippedNoFace": skipped,
        "enrolledPeople": enrolled,
        "galleryPerPerson": args.enroll,
        "verification": {
            "genuinePairs": int(g.size),
            "impostorPairs": int(i.size),
            "genuineMean": float(g.mean()) if g.size else None,
            "impostorMean": float(i.mean()) if i.size else None,
            "impostorMax": float(i.max()) if i.size else None,
            "EER": eer(ver_rows),
            "atMatchThreshold": at(ver_rows, args.match),
        },
        "identification": {
            "genuineProbes": len(genuine),
            "strangerProbes": len(impostor),
            "EER": eer(id_rows),
            "atMatchThreshold": at(id_rows, args.match),
            "atUnsureThreshold": at(id_rows, args.unsure),
            "appBands": bands(genuine, impostor, args.match, args.unsure),
        },
    }
    (args.out / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary["verification"], indent=2))
    print(json.dumps(summary["identification"], indent=2))
    print(f"\nWrote results to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
