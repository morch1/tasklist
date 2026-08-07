#!/bin/bash

echo "Running post-create.sh script..."

if [ -f requirements.txt ]; then 
    echo "Installing Python dependencies from requirements.txt..."
    python -m pip install -r requirements.txt
fi

if [ -f .env.example ] && [ ! -f .env ]; then
    echo "Creating .env file from .env.example..."
    cp .env.example .env
fi
