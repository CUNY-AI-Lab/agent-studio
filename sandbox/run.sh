#!/bin/bash
# Run the sandbox manager locally (development)

set -e

cd "$(dirname "$0")"

# Create virtual environment if it doesn't exist
if [ ! -d ".venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv .venv
fi

# Activate and install dependencies
source .venv/bin/activate
pip install -q -r requirements.txt

# Run the manager
echo "Starting Sandbox Manager on http://localhost:8765"
python manager.py
