"""
CPU latency benchmark for the recognition step (what one "Who is this?" costs
in the face service): decode + detect + align + embed + match, for N frames.

    python eval/benchmark.py --frames 5 --runs 30

Prints median / p95 in milliseconds. Run it on the laptop you will demo on.
"""
from __future__ import annotations

import argparse
import base64
import os
import sys
import time
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("FACE_SERVICE_SECRET", "benchmark-secret-123456")

from fastapi.testclient import TestClient  # noqa: E402

from app.engine import FaceEngine, decode_image  # noqa: E402
from app import config  # noqa: E402
from app.main import app  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", type=int, default=5)
    ap.add_argument("--runs", type=int, default=30)
    ap.add_argument("--people", type=int, default=10, help="candidate people, 5 embeddings each")
    args = ap.parse_args()

    engine = FaceEngine(config.MODEL_DIR)
    img = decode_image((ROOT / "tests/data/group.jpg").read_bytes())
    face = engine.detect(img)[0]
    x1, y1, x2, y2 = [int(v) for v in face.bbox]
    w, h = x2 - x1, y2 - y1
    crop = img[max(0, y1 - h) : y2 + h, max(0, x1 - w) : x2 + w]
    frame = cv2.resize(crop, (640, 480))
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
    frame_b64 = base64.b64encode(buf.tobytes()).decode()

    rng = np.random.default_rng(1)
    cands = []
    for p in range(args.people):
        embs = []
        for _ in range(5):
            v = rng.normal(size=512).astype(np.float32)
            v /= np.linalg.norm(v)
            embs.append(base64.b64encode(v.tobytes()).decode())
        cands.append({"id": f"p{p}", "embeddings": embs})

    body = {"frames": [frame_b64] * args.frames, "candidates": cands}
    headers = {"X-Face-Secret": os.environ["FACE_SERVICE_SECRET"]}
    times = []
    with TestClient(app) as client:
        client.post("/v1/analyze", json=body, headers=headers)  # warm-up
        for _ in range(args.runs):
            t = time.perf_counter()
            r = client.post("/v1/analyze", json=body, headers=headers)
            times.append((time.perf_counter() - t) * 1000)
            assert r.status_code == 200
    arr = np.array(times)
    print(
        f"{args.frames} frames x 640x480, {args.people} candidates: "
        f"median {np.median(arr):.0f} ms, p95 {np.percentile(arr, 95):.0f} ms, "
        f"per frame ~{np.median(arr) / args.frames:.0f} ms (CPU: {os.cpu_count()} threads)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
