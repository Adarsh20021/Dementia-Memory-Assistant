"""
Downloads the InsightFace "buffalo_s" model pack (~120 MB) and keeps only the
two models this service uses:

  det_500m.onnx   SCRFD face detector (with 5 landmarks)
  w600k_mbf.onnx  ArcFace recogniser (MobileFaceNet, 512-d)

Licence: InsightFace pre-trained models are for non-commercial research use.

    python scripts/download_models.py
"""
import io
import sys
import urllib.request
import zipfile
from pathlib import Path

URL = "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_s.zip"
WANTED = {"det_500m.onnx", "w600k_mbf.onnx"}
DEST = Path(__file__).resolve().parent.parent / "models"


def main() -> int:
    DEST.mkdir(exist_ok=True)
    if all((DEST / n).exists() for n in WANTED):
        print(f"Models already present in {DEST}")
        return 0
    print(f"Downloading {URL} ...")
    with urllib.request.urlopen(URL, timeout=300) as resp:
        data = resp.read()
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for member in zf.namelist():
            name = Path(member).name
            if name in WANTED:
                (DEST / name).write_bytes(zf.read(member))
                print(f"  saved {name}")
    missing = [n for n in WANTED if not (DEST / n).exists()]
    if missing:
        print(f"Missing after download: {missing}", file=sys.stderr)
        return 1
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
