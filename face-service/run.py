"""
Start the face service.   python run.py

Binds to 127.0.0.1 by default so it is never reachable from other machines.
In Docker/Podman set FACE_HOST=0.0.0.0 (the compose file does not publish the port).
"""
import os

import uvicorn

if __name__ == "__main__":
    if not os.environ.get("FACE_SERVICE_SECRET"):
        # Load from the server's .env so one secret is shared by both services.
        env_path = os.path.join(os.path.dirname(__file__), "..", "server", ".env")
        if os.path.exists(env_path):
            for line in open(env_path, encoding="utf-8"):
                if line.startswith("FACE_SERVICE_SECRET="):
                    os.environ["FACE_SERVICE_SECRET"] = line.split("=", 1)[1].strip()
    uvicorn.run(
        "app.main:app",
        host=os.environ.get("FACE_HOST", "127.0.0.1"),
        port=int(os.environ.get("FACE_PORT", 8000)),
        log_level="warning",
        access_log=False,  # never log request bodies (images)
    )
