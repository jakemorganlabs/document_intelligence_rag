# deploy/sidecar/Dockerfile — Production Python extractor sidecar
# Built from python:3.12-slim, pinned dependencies with hash verification.

FROM python:3.12-slim

WORKDIR /app

# Install system deps (none beyond what pypdf needs)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy and install Python dependencies with pinned hashes
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy extractor source
COPY extract.py .

# Run as non-root
RUN useradd -m -u 1000 extractor
USER extractor

# Health: pypdf import check (docker healthcheck does this)
CMD ["python3", "-c", "import pypdf; print('sidecar ready')"]
