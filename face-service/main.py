"""Compatibility entry point: `uvicorn main:app` still works. Prefer `python run.py` (binds to 127.0.0.1)."""
from app.main import app  # noqa: F401
