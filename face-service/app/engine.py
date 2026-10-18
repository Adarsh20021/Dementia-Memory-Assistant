"""
Face detection + embedding engine.

Uses InsightFace's pre-trained ONNX models directly through onnxruntime
(no compiled `insightface` package needed, so it installs cleanly on Windows):

  * SCRFD  (det_500m.onnx)  - face detection + 5 facial landmarks
  * ArcFace (w600k_mbf.onnx) - 512-d identity embedding (MobileFaceNet backbone)

Both come from the InsightFace "buffalo_s" model pack
(non-commercial research licence - fine for an academic prototype).

All images are processed in memory only. Nothing is written to disk.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

# ArcFace canonical landmark positions for a 112x112 aligned face.
ARCFACE_DST = np.array(
    [
        [38.2946, 51.6963],  # left eye
        [73.5318, 51.5014],  # right eye
        [56.0252, 71.7366],  # nose tip
        [41.5493, 92.3655],  # left mouth corner
        [70.7299, 92.2041],  # right mouth corner
    ],
    dtype=np.float32,
)


@dataclass
class Face:
    bbox: np.ndarray  # [x1, y1, x2, y2]
    score: float
    kps: np.ndarray  # (5, 2) landmarks

    @property
    def width(self) -> float:
        return float(self.bbox[2] - self.bbox[0])

    @property
    def height(self) -> float:
        return float(self.bbox[3] - self.bbox[1])

    @property
    def min_side(self) -> float:
        return min(self.width, self.height)

    @property
    def area(self) -> float:
        return self.width * self.height

    @property
    def yaw_ratio(self) -> float:
        """
        Horizontal nose offset from the eye midpoint, normalised by eye distance.
        ~0 for a frontal face; grows as the head turns. For a flat photo moved or
        tilted in front of the camera this ratio stays (almost) constant, which is
        what the liveness check relies on.
        """
        le, re, nose = self.kps[0], self.kps[1], self.kps[2]
        eye_dist = float(np.linalg.norm(re - le)) or 1.0
        return float((nose[0] - (le[0] + re[0]) / 2.0) / eye_dist)


def _session(path: Path) -> ort.InferenceSession:
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    return ort.InferenceSession(str(path), sess_options=opts, providers=["CPUExecutionProvider"])


def _nms(dets: np.ndarray, thresh: float) -> list[int]:
    x1, y1, x2, y2, scores = dets[:, 0], dets[:, 1], dets[:, 2], dets[:, 3], dets[:, 4]
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep: list[int] = []
    while order.size > 0:
        i = int(order[0])
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1 + 1)
        h = np.maximum(0.0, yy2 - yy1 + 1)
        inter = w * h
        ovr = inter / (areas[i] + areas[order[1:]] - inter)
        order = order[np.where(ovr <= thresh)[0] + 1]
    return keep


class SCRFD:
    """Minimal SCRFD decoder (strides 8/16/32, 2 anchors per location, with landmarks)."""

    STRIDES = (8, 16, 32)
    NUM_ANCHORS = 2

    def __init__(self, model_path: Path, input_size: int = 640, nms_thresh: float = 0.4):
        self.session = _session(model_path)
        self.input_name = self.session.get_inputs()[0].name
        self.output_names = [o.name for o in self.session.get_outputs()]
        if len(self.output_names) != 9:
            raise RuntimeError("Expected an SCRFD model with landmarks (9 outputs)")
        self.input_size = input_size
        self.nms_thresh = nms_thresh
        self._centers: dict[tuple[int, int, int], np.ndarray] = {}

    def _anchor_centers(self, h: int, w: int, stride: int) -> np.ndarray:
        key = (h, w, stride)
        if key not in self._centers:
            centers = np.stack(np.mgrid[:h, :w][::-1], axis=-1).astype(np.float32)
            centers = (centers * stride).reshape(-1, 2)
            centers = np.stack([centers] * self.NUM_ANCHORS, axis=1).reshape(-1, 2)
            self._centers[key] = centers
        return self._centers[key]

    def detect(self, img: np.ndarray, score_thresh: float = 0.5) -> list[Face]:
        size = self.input_size
        im_ratio = img.shape[0] / img.shape[1]
        if im_ratio > 1:
            new_h, new_w = size, int(size / im_ratio)
        else:
            new_w, new_h = size, int(size * im_ratio)
        scale = new_h / img.shape[0]
        resized = cv2.resize(img, (new_w, new_h))
        canvas = np.zeros((size, size, 3), dtype=np.uint8)
        canvas[:new_h, :new_w] = resized

        blob = cv2.dnn.blobFromImage(canvas, 1.0 / 128, (size, size), (127.5, 127.5, 127.5), swapRB=True)
        outs = self.session.run(self.output_names, {self.input_name: blob})
        # Some exports include a batch dimension.
        outs = [o[0] if o.ndim == 3 else o for o in outs]

        all_scores, all_boxes, all_kps = [], [], []
        fmc = len(self.STRIDES)
        for idx, stride in enumerate(self.STRIDES):
            scores = outs[idx].reshape(-1)
            box_preds = outs[idx + fmc] * stride
            kps_preds = outs[idx + fmc * 2] * stride
            h = w = size // stride
            centers = self._anchor_centers(h, w, stride)
            pos = np.where(scores >= score_thresh)[0]
            if pos.size == 0:
                continue
            c = centers[pos]
            b = box_preds[pos]
            boxes = np.stack([c[:, 0] - b[:, 0], c[:, 1] - b[:, 1], c[:, 0] + b[:, 2], c[:, 1] + b[:, 3]], axis=-1)
            k = kps_preds[pos]
            kps = np.stack([c[:, i % 2] + k[:, i] for i in range(10)], axis=-1).reshape(-1, 5, 2)
            all_scores.append(scores[pos])
            all_boxes.append(boxes)
            all_kps.append(kps)

        if not all_scores:
            return []
        scores = np.concatenate(all_scores)
        boxes = np.concatenate(all_boxes) / scale
        kpss = np.concatenate(all_kps) / scale
        dets = np.hstack([boxes, scores[:, None]]).astype(np.float32)
        keep = _nms(dets, self.nms_thresh)
        faces = [Face(bbox=boxes[i], score=float(scores[i]), kps=kpss[i]) for i in keep]
        faces.sort(key=lambda f: f.area, reverse=True)
        return faces


class ArcFace:
    def __init__(self, model_path: Path):
        self.session = _session(model_path)
        self.input_name = self.session.get_inputs()[0].name

    @staticmethod
    def align(img: np.ndarray, kps: np.ndarray) -> np.ndarray:
        matrix, _ = cv2.estimateAffinePartial2D(kps.astype(np.float32), ARCFACE_DST, method=cv2.LMEDS)
        return cv2.warpAffine(img, matrix, (112, 112), borderValue=0.0)

    def embed_aligned(self, aligned: np.ndarray) -> np.ndarray:
        blob = cv2.dnn.blobFromImage(aligned, 1.0 / 127.5, (112, 112), (127.5, 127.5, 127.5), swapRB=True)
        emb = self.session.run(None, {self.input_name: blob})[0][0].astype(np.float32)
        return emb / (np.linalg.norm(emb) + 1e-9)


class FaceEngine:
    def __init__(self, model_dir: Path, det_size: int = 640):
        det = model_dir / "det_500m.onnx"
        rec = model_dir / "w600k_mbf.onnx"
        missing = [p.name for p in (det, rec) if not p.exists()]
        if missing:
            raise FileNotFoundError(
                f"Missing model files {missing} in {model_dir}. Run: python scripts/download_models.py"
            )
        self.detector = SCRFD(det, input_size=det_size)
        self.recognizer = ArcFace(rec)

    def detect(self, img: np.ndarray, score_thresh: float = 0.5) -> list[Face]:
        return self.detector.detect(img, score_thresh)

    def embed(self, img: np.ndarray, face: Face) -> tuple[np.ndarray, np.ndarray]:
        """Returns (embedding, aligned 112x112 crop)."""
        aligned = ArcFace.align(img, face.kps)
        return self.recognizer.embed_aligned(aligned), aligned


def decode_image(data: bytes, max_side: int = 1280) -> np.ndarray | None:
    """Decodes JPEG/PNG/WebP bytes to a BGR array, downscaling very large images."""
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return None
    h, w = img.shape[:2]
    if max(h, w) > max_side:
        s = max_side / max(h, w)
        img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    return img
