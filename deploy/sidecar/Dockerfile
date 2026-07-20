# deploy/sidecar/Dockerfile: production Python extractor sidecar.
# Built from python:3.12-slim, pinned dependencies.

FROM python:3.12-slim

WORKDIR /app

# system deps (none beyond what pypdf needs)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# extractor source
COPY extract.py .

# run as non-root
RUN useradd -m -u 1000 extractor
USER extractor

# healthcheck imports pypdf
CMD ["python3", "-c", "import pypdf; print('sidecar ready')"]
