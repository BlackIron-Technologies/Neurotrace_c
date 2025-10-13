#!/bin/bash

# NeuroTrace Telemetry Server Startup Script

echo "🚀 Starting NeuroTrace Telemetry Service..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js to run the telemetry service."
    exit 1
fi

# Navigate to the bin directory
cd "$(dirname "$0")"

# Check if package.json exists
if [ ! -f "package.json" ]; then
    echo "❌ package.json not found. Make sure you're in the correct directory."
    exit 1
fi

# Install dependencies if node_modules doesn't exist
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        echo "❌ Failed to install dependencies."
        exit 1
    fi
fi

# Create telemetry_data directory if it doesn't exist
mkdir -p telemetry_data

echo "✅ Dependencies installed successfully"
echo "🌐 Starting server on http://localhost:3001"
echo "📊 Health check: http://localhost:3001/api/health"
echo "📈 Statistics: http://localhost:3001/api/stats"
echo ""
echo "Press Ctrl+C to stop the server"

# Start the server
npm start