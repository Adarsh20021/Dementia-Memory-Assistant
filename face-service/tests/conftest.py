import base64
import os
from pathlib import Path

import cv2
import numpy as np
import pytest

os.environ.setdefault("FACE_SERVICE_SECRET", "test-secret-test-secret")

from fastapi.testclient import TestClient  # noqa: E402

from app.engine import FaceEngine, decode_image  # noqa: E402
from app.main import app  # noqa: E402
from app import config  # noqa: E402

DATA = Path(__file__).parent / "data"
SECRET_HEADER = {"X-Face-Secret": os.environ["FACE_SERVICE_SECRET"]}


@pytest.fixture(scope="session")
def engine() -> FaceEngine:
    return FaceEngine(config.MODEL_DIR)


@pytest.fixture(scope="session")
def group_img() -> np.ndarray:
    """Sample photo with 6 different people (from the InsightFace repository)."""
    return decode_image((DATA / "group.jpg").read_bytes())


@pytest.fixture(scope="session")
def single_faces(engine, group_img) -> list[np.ndarray]:
    """Crops of each person in the group photo, each containing exactly one face."""
    crops = []
    for f in engine.detect(group_img):
        x1, y1, x2, y2 = [int(v) for v in f.bbox]
        w, h = x2 - x1, y2 - y1
        crop = group_img[max(0, y1 - h // 2) : y2 + h // 2, max(0, x1 - w // 2) : x2 + w // 2]
        crops.append(np.ascontiguousarray(crop))
    return crops


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c


def b64_jpeg(img: np.ndarray) -> str:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    assert ok
    return base64.b64encode(buf.tobytes()).decode()
