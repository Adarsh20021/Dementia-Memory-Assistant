FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY scripts ./scripts
RUN python scripts/download_models.py
COPY app ./app
COPY run.py .
RUN useradd --create-home appuser && chown -R appuser /app
USER appuser
ENV FACE_HOST=0.0.0.0
EXPOSE 8000
CMD ["python", "run.py"]
