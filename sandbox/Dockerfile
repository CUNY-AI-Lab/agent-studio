# Sandbox Manager Dockerfile
FROM python:3.12-slim

WORKDIR /app

# Install Docker CLI (for Docker-out-of-Docker)
RUN apt-get update && apt-get install -y \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the manager
COPY manager.py .

# Run the manager
CMD ["python", "manager.py"]
