@echo off
REM NeuroTrace Telemetry Server Startup Script for Windows

echo 🚀 Starting NeuroTrace Telemetry Service...

REM Check if Node.js is installed
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Node.js is not installed. Please install Node.js to run the telemetry service.
    pause
    exit /b 1
)

REM Navigate to the bin directory
cd /d "%~dp0"

REM Check if package.json exists
if not exist "package.json" (
    echo ❌ package.json not found. Make sure you're in the correct directory.
    pause
    exit /b 1
)

REM Install dependencies if node_modules doesn't exist
if not exist "node_modules" (
    echo 📦 Installing dependencies...
    npm install
    if %errorlevel% neq 0 (
        echo ❌ Failed to install dependencies.
        pause
        exit /b 1
    )
)

REM Create telemetry_data directory if it doesn't exist
if not exist "telemetry_data" mkdir telemetry_data

echo ✅ Dependencies installed successfully
echo 🌐 Starting server on http://localhost:3001
echo 📊 Health check: http://localhost:3001/api/health
echo 📈 Statistics: http://localhost:3001/api/stats
echo.
echo Press Ctrl+C to stop the server

REM Start the server
npm start

pause