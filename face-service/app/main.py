"""
Face recognition microservice (FastAPI). INTERNAL ONLY.

  GET  /health          model status
  POST /v1/embed        one enrollment photo -> quality checks -> embedding
  POST /v1/analyze      camera frames + one patient's candidate embeddings
                        -> per-frame best match, cosine score and head-pose signal

The service is stateless: it never stores images or embeddings. Express owns
the (encrypted) embeddings and sends only the current patient's candidates
with each request, so a match can only ever be against that patient's people.
The thresholding / "N of M frames" decision is made in Express.

Every request must carry the X-Face-Secret header. By default the service
binds to 127.0.0.1 only (see run.py).
"""
from __future__ import annotations

import base64
import binascii
import hmac
import time
from contextlib import asynccontextmanager

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from . import config
from .engine import FaceEngine, decode_image
from .quality import check_enrollment, MESSAGES

engine: FaceEngine | None = None
load_error: str | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global engine, load_error
    try:
        engine = FaceEngine(config.MODEL_DIR, det_size=config.DET_SIZE)
    except Exception as exc:  # keep running so /health can report the problem
        load_error = str(exc)
    yield


app = FastAPI(title="Face Service", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


def require_secret(x_face_secret: str = Header(default="")) -> None:
    """Constant-time shared-secret check. An unset secret rejects everything."""
    if not config.SECRET or not hmac.compare_digest(x_face_secret.encode(), config.SECRET.encode()):
        raise HTTPException(status_code=401, detail="unauthorized")


def get_engine() -> FaceEngine:
    if engine is None:
        raise HTTPException(status_code=503, detail=f"models not loaded: {load_error}")
    return engine


def _b64_bytes(value: str, limit: int) -> bytes:
    try:
        data = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="invalid base64")
    if len(data) > limit:
        raise HTTPException(status_code=413, detail="image too large")
    return data


def _b64_vec(value: str) -> np.ndarray:
    vec = np.frombuffer(_b64_bytes(value, 64 * 1024), dtype=np.float32)
    if vec.size != 512:
        raise HTTPException(status_code=400, detail="embedding must be 512 float32 values")
    return vec


# ---------------------------------------------------------------- models


class EmbedRequest(BaseModel):
    image: str = Field(..., description="base64 JPEG/PNG/WebP")


class Candidate(BaseModel):
    id: str
    embeddings: list[str] = Field(..., min_length=1, max_length=20)


class AnalyzeRequest(BaseModel):
    frames: list[str] = Field(..., min_length=1, max_length=config.MAX_FRAMES)
    candidates: list[Candidate] = Field(default_factory=list, max_length=200)


# ---------------------------------------------------------------- routes


@app.get("/health", dependencies=[Depends(require_secret)])
def health() -> dict:
    return {"status": "ok" if engine else "degraded", "modelsLoaded": engine is not None, "error": load_error}


@app.post("/v1/embed", dependencies=[Depends(require_secret)])
def embed(req: EmbedRequest, eng: FaceEngine = Depends(get_engine)) -> dict:
    started = time.perf_counter()
    img = decode_image(_b64_bytes(req.image, config.MAX_IMAGE_BYTES))
    if img is None:
        return {"ok": False, "code": "unreadable", "message": MESSAGES["unreadable"]}

    faces = eng.detect(img, config.DET_SCORE_MIN)
    aligned = None
    embedding = None
    if faces:
        embedding, aligned = eng.embed(img, faces[0])
    quality = check_enrollment(faces, aligned)
    result: dict = {
        "ok": quality.ok,
        "code": quality.code,
        "message": quality.message,
        "metrics": quality.metrics,
        "ms": round((time.perf_counter() - started) * 1000, 1),
    }
    if quality.ok and embedding is not None:
        result["embedding"] = base64.b64encode(embedding.astype(np.float32).tobytes()).decode()
    return result


@app.post("/v1/analyze", dependencies=[Depends(require_secret)])
def analyze(req: AnalyzeRequest, eng: FaceEngine = Depends(get_engine)) -> dict:
    started = time.perf_counter()

    # Stack each candidate's embeddings once: (num_embeddings, 512) + owner index.
    ids: list[str] = []
    owners: list[int] = []
    vecs: list[np.ndarray] = []
    for ci, cand in enumerate(req.candidates):
        ids.append(cand.id)
        for e in cand.embeddings:
            vecs.append(_b64_vec(e))
            owners.append(ci)
    gallery = np.stack(vecs) if vecs else np.zeros((0, 512), dtype=np.float32)
    owner_arr = np.array(owners, dtype=np.int64)

    frames_out = []
    for frame_b64 in req.frames:
        img = decode_image(_b64_bytes(frame_b64, config.MAX_IMAGE_BYTES), max_side=960)
        if img is None:
            frames_out.append({"faceFound": False, "faceCount": 0, "error": "unreadable"})
            continue
        faces = [f for f in eng.detect(img, config.DET_SCORE_MIN) if f.min_side >= config.RECOG_MIN_FACE_PX]
        if not faces:
            frames_out.append({"faceFound": False, "faceCount": 0})
            continue
        face = faces[0]  # largest face = the person in front of the camera
        emb, _ = eng.embed(img, face)
        out: dict = {
            "faceFound": True,
            "faceCount": len(faces),
            "faceSizePx": round(face.min_side, 1),
            "yaw": round(face.yaw_ratio, 4),
            "best": None,
            "second": None,
        }
        if gallery.shape[0]:
            sims = gallery @ emb
            # Best score per candidate (max over that person's enrolled embeddings).
            per_person = np.full(len(ids), -1.0, dtype=np.float32)
            np.maximum.at(per_person, owner_arr, sims)
            order = np.argsort(per_person)[::-1]
            out["best"] = {"id": ids[order[0]], "score": round(float(per_person[order[0]]), 4)}
            if len(order) > 1:
                out["second"] = {"id": ids[order[1]], "score": round(float(per_person[order[1]]), 4)}
        frames_out.append(out)

    return {"frames": frames_out, "ms": round((time.perf_counter() - started) * 1000, 1)}
