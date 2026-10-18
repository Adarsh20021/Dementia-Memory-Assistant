"""
Enrollment photo quality checks. Each failure has a stable code and a
plain-language message the caregiver UI can show directly.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from . import config
from .engine import Face

MESSAGES = {
    "unreadable": "This file is not a readable photo. Please use a JPG or PNG image.",
    "no_face": "No face was found. Make sure the face is clearly visible and well lit.",
    "multiple_faces": "More than one face is in this photo. Please use a photo with only this person.",
    "face_too_small": "The face is too small. Move closer to the camera or use a closer photo.",
    "too_blurry": "The photo is blurry. Hold the camera still or use a sharper photo.",
    "too_dark": "The photo is too dark. Please use more light.",
    "too_bright": "The photo is too bright. Avoid strong light behind or on the face.",
    "face_turned": "The face is turned too far to the side. Please look more towards the camera.",
}


@dataclass
class QualityResult:
    ok: bool
    code: str | None
    metrics: dict

    @property
    def message(self) -> str | None:
        return MESSAGES.get(self.code) if self.code else None


def blur_score(aligned_bgr: np.ndarray) -> float:
    """Variance of the Laplacian on the aligned face: low = blurry."""
    gray = cv2.cvtColor(aligned_bgr, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def brightness(aligned_bgr: np.ndarray) -> float:
    return float(cv2.cvtColor(aligned_bgr, cv2.COLOR_BGR2GRAY).mean())


def significant_faces(faces: list[Face]) -> list[Face]:
    """Ignore tiny background detections relative to the main face."""
    if not faces:
        return []
    main = faces[0]  # sorted by area, largest first
    return [f for f in faces if f.area >= main.area * config.SECOND_FACE_AREA_RATIO]


def check_enrollment(faces: list[Face], aligned: np.ndarray | None) -> QualityResult:
    faces = significant_faces(faces)
    if not faces:
        return QualityResult(False, "no_face", {"faceCount": 0})
    if len(faces) > 1:
        return QualityResult(False, "multiple_faces", {"faceCount": len(faces)})

    face = faces[0]
    metrics = {
        "faceCount": 1,
        "faceSizePx": round(face.min_side, 1),
        "detScore": round(face.score, 3),
        "yaw": round(face.yaw_ratio, 3),
    }
    if face.min_side < config.ENROLL_MIN_FACE_PX:
        return QualityResult(False, "face_too_small", metrics)
    if abs(face.yaw_ratio) > config.ENROLL_MAX_YAW:
        return QualityResult(False, "face_turned", metrics)

    assert aligned is not None
    metrics["blur"] = round(blur_score(aligned), 1)
    metrics["brightness"] = round(brightness(aligned), 1)
    # Lighting first: a dark image also has low contrast, which would otherwise
    # be misreported as "blurry".
    if metrics["brightness"] < config.ENROLL_BRIGHTNESS_MIN:
        return QualityResult(False, "too_dark", metrics)
    if metrics["brightness"] > config.ENROLL_BRIGHTNESS_MAX:
        return QualityResult(False, "too_bright", metrics)
    if metrics["blur"] < config.ENROLL_BLUR_MIN:
        return QualityResult(False, "too_blurry", metrics)
    return QualityResult(True, None, metrics)
