"""Face-service settings, all overridable with environment variables."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _float(name: str, default: float) -> float:
    return float(os.environ.get(name, default))


SECRET = os.environ.get("FACE_SERVICE_SECRET", "")
MODEL_DIR = Path(os.environ.get("FACE_MODEL_DIR", BASE_DIR / "models"))
DET_SIZE = int(os.environ.get("FACE_DET_SIZE", 640))

# Detection confidence below which a detection is ignored.
DET_SCORE_MIN = _float("FACE_DET_SCORE_MIN", 0.5)

# Enrollment quality thresholds (tuned on sample images; see README).
ENROLL_MIN_FACE_PX = _float("FACE_ENROLL_MIN_FACE_PX", 80)  # shortest side of the face box
ENROLL_BLUR_MIN = _float("FACE_ENROLL_BLUR_MIN", 50)  # Laplacian variance on the aligned face
ENROLL_BRIGHTNESS_MIN = _float("FACE_ENROLL_BRIGHTNESS_MIN", 40)
ENROLL_BRIGHTNESS_MAX = _float("FACE_ENROLL_BRIGHTNESS_MAX", 220)
ENROLL_MAX_YAW = _float("FACE_ENROLL_MAX_YAW", 0.6)  # |yaw ratio|; beyond this the face is side-on
# A second face counts if it is at least this fraction of the main face's area.
SECOND_FACE_AREA_RATIO = _float("FACE_SECOND_FACE_AREA_RATIO", 0.15)

# Recognition: faces smaller than this are ignored in camera frames.
RECOG_MIN_FACE_PX = _float("FACE_RECOG_MIN_FACE_PX", 48)

MAX_IMAGE_BYTES = int(os.environ.get("FACE_MAX_IMAGE_BYTES", 6 * 1024 * 1024))
MAX_FRAMES = int(os.environ.get("FACE_MAX_FRAMES", 8))
