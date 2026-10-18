import base64

import cv2
import numpy as np

from conftest import SECRET_HEADER, b64_jpeg


def embed(client, img):
    r = client.post("/v1/embed", json={"image": b64_jpeg(img)}, headers=SECRET_HEADER)
    assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------- security


def test_requires_shared_secret(client):
    assert client.get("/health").status_code == 401
    assert client.get("/health", headers={"X-Face-Secret": "wrong"}).status_code == 401
    r = client.get("/health", headers=SECRET_HEADER)
    assert r.status_code == 200 and r.json()["modelsLoaded"] is True


def test_embed_requires_secret(client, single_faces):
    assert client.post("/v1/embed", json={"image": b64_jpeg(single_faces[0])}).status_code == 401


# ---------------------------------------------------------------- enrollment quality


def test_good_photo_is_accepted_with_512d_embedding(client, single_faces):
    res = embed(client, single_faces[0])
    assert res["ok"] is True, res
    vec = np.frombuffer(base64.b64decode(res["embedding"]), dtype=np.float32)
    assert vec.shape == (512,)
    assert abs(np.linalg.norm(vec) - 1) < 1e-3


def test_group_photo_rejected_multiple_faces(client, group_img):
    res = embed(client, group_img)
    assert res["ok"] is False and res["code"] == "multiple_faces"
    assert "only this person" in res["message"]


def test_no_face(client):
    res = embed(client, np.full((400, 400, 3), 180, np.uint8))
    assert res["code"] == "no_face"


def test_blurry_photo_rejected(client, single_faces):
    res = embed(client, cv2.GaussianBlur(single_faces[0], (15, 15), 5))
    assert res["code"] == "too_blurry"


def test_small_face_rejected(client, single_faces):
    small = cv2.resize(single_faces[0], None, fx=0.45, fy=0.45, interpolation=cv2.INTER_AREA)
    canvas = np.full((480, 480, 3), 200, np.uint8)
    canvas[: small.shape[0], : small.shape[1]] = small
    assert embed(client, canvas)["code"] == "face_too_small"


def test_dark_photo_rejected(client, single_faces):
    dark = cv2.convertScaleAbs(single_faces[0], alpha=0.22, beta=0)
    assert embed(client, dark)["code"] in {"too_dark", "no_face"}


def test_unreadable_file(client):
    r = client.post(
        "/v1/embed", json={"image": base64.b64encode(b"not an image").decode()}, headers=SECRET_HEADER
    )
    assert r.json()["code"] == "unreadable"


def test_invalid_base64(client):
    r = client.post("/v1/embed", json={"image": "%%%"}, headers=SECRET_HEADER)
    assert r.status_code == 400


# ---------------------------------------------------------------- matching


def gallery(client, faces):
    return [{"id": f"p{i}", "embeddings": [embed(client, f)["embedding"]]} for i, f in enumerate(faces)]


def test_matches_the_right_person_only_among_candidates(client, single_faces):
    cands = gallery(client, single_faces[:4])
    # Probe: person 2, mirrored + slightly darker (different "photo").
    probe = cv2.convertScaleAbs(cv2.flip(single_faces[2], 1), alpha=0.85, beta=-10)
    r = client.post("/v1/analyze", json={"frames": [b64_jpeg(probe)], "candidates": cands}, headers=SECRET_HEADER)
    frame = r.json()["frames"][0]
    assert frame["faceFound"] is True
    assert frame["best"]["id"] == "p2"
    assert frame["best"]["score"] > 0.6
    assert frame["second"]["score"] < 0.35


def test_unenrolled_person_scores_low(client, single_faces):
    cands = gallery(client, single_faces[:3])
    r = client.post(
        "/v1/analyze", json={"frames": [b64_jpeg(single_faces[5])], "candidates": cands}, headers=SECRET_HEADER
    )
    assert r.json()["frames"][0]["best"]["score"] < 0.35


def test_analyze_reports_missing_face_per_frame(client, single_faces):
    cands = gallery(client, single_faces[:1])
    blank = np.full((300, 300, 3), 128, np.uint8)
    frames = [b64_jpeg(single_faces[0]), b64_jpeg(blank)]
    out = client.post("/v1/analyze", json={"frames": frames, "candidates": cands}, headers=SECRET_HEADER).json()
    assert out["frames"][0]["faceFound"] is True
    assert out["frames"][1]["faceFound"] is False


def test_analyze_without_candidates_returns_no_match(client, single_faces):
    out = client.post(
        "/v1/analyze", json={"frames": [b64_jpeg(single_faces[0])], "candidates": []}, headers=SECRET_HEADER
    ).json()
    assert out["frames"][0]["best"] is None


def test_rejects_bad_embedding_and_too_many_frames(client, single_faces):
    bad = base64.b64encode(np.zeros(10, np.float32).tobytes()).decode()
    r = client.post(
        "/v1/analyze",
        json={"frames": [b64_jpeg(single_faces[0])], "candidates": [{"id": "x", "embeddings": [bad]}]},
        headers=SECRET_HEADER,
    )
    assert r.status_code == 400
    r = client.post("/v1/analyze", json={"frames": ["a"] * 9, "candidates": []}, headers=SECRET_HEADER)
    assert r.status_code == 422


# ---------------------------------------------------------------- liveness signal


def test_flat_photo_keeps_constant_yaw_under_perspective(engine, single_faces):
    """
    A printed photo tilted in front of the camera is a flat plane: its yaw ratio
    barely changes. This is the property the liveness check (in Express) uses.
    """
    img = single_faces[0]
    h, w = img.shape[:2]
    base = engine.detect(img)[0].yaw_ratio
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = np.float32([[w * 0.12, h * 0.05], [w * 0.95, 0], [w, h], [w * 0.12, h * 0.95]])
    tilted = cv2.warpPerspective(img, cv2.getPerspectiveTransform(src, dst), (w, h))
    assert abs(engine.detect(tilted)[0].yaw_ratio - base) < 0.06
