#!/bin/bash
# Build script for NeuroTrace Linux executable
# This script compiles neurotrace.py into a standalone binary
# Requires Python 3.11.x

echo "========================================"
echo "NeuroTrace Linux Build Script"
echo "========================================"
echo ""

# Try to find Python 3.11
PYTHON_CMD=""

if command -v python3.11 &> /dev/null; then
    PYTHON_CMD="python3.11"
    echo "✓ Found python3.11"
elif command -v python3 &> /dev/null; then
    PYTHON_VERSION=$(python3 --version 2>&1 | grep -oP '\d+\.\d+')
    if [[ "$PYTHON_VERSION" == "3.11" ]]; then
        PYTHON_CMD="python3"
        echo "✓ Found python3 (version 3.11)"
    else
        echo "⚠️ Warning: python3 is version $PYTHON_VERSION, not 3.11"
        echo "   Trying python3 anyway..."
        PYTHON_CMD="python3"
    fi
elif command -v python &> /dev/null; then
    PYTHON_VERSION=$(python --version 2>&1 | grep -oP '\d+\.\d+')
    if [[ "$PYTHON_VERSION" == "3.11" ]]; then
        PYTHON_CMD="python"
        echo "✓ Found python (version 3.11)"
    else
        echo "❌ ERROR: Python 3.11 not found"
        echo "   Please install Python 3.11.9 and try again"
        exit 1
    fi
else
    echo "❌ ERROR: No Python installation found"
    echo "   Please install Python 3.11.9 and try again"
    exit 1
fi

# Display Python version
echo "Checking Python version..."
$PYTHON_CMD --version
echo ""

# Check if PyInstaller is installed
echo "Checking PyInstaller..."
if ! $PYTHON_CMD -m pip show pyinstaller > /dev/null 2>&1; then
    echo "PyInstaller not found. Installing..."
    $PYTHON_CMD -m pip install pyinstaller
else
    echo "PyInstaller is installed"
fi
echo ""

# Check required dependencies
echo "Checking required dependencies..."
required_packages=("faiss-cpu" "onnxruntime" "transformers" "sqlcipher3-wheels" "numpy")
missing_packages=()

for package in "${required_packages[@]}"; do
    if $PYTHON_CMD -m pip show "$package" > /dev/null 2>&1; then
        echo "  ✓ Found: $package"
    else
        echo "  ✗ Missing: $package"
        missing_packages+=("$package")
    fi
done

if [ ${#missing_packages[@]} -ne 0 ]; then
    echo ""
    echo "Installing missing packages..."
    $PYTHON_CMD -m pip install -r requirements-backend.txt
    echo ""
fi

# Check if ONNX model exists
if [ ! -d "onnx_model" ]; then
    echo "ONNX model not found in compilation directory"
    # Try to link from ../bin/onnx_model if it exists
    if [ -d "../bin/onnx_model" ]; then
        echo "Linking from ../bin/onnx_model"
        ln -s ../bin/onnx_model onnx_model
    else
        echo "ERROR: onnx_model directory is required for release builds."
        echo "Place the reviewed ONNX model files in compilation/onnx_model before building."
        exit 1
    fi
    echo ""
else
    echo "✓ ONNX model found"
    echo ""
fi

# Clean previous build artifacts
echo "Cleaning previous build artifacts..."
rm -rf dist build neurotrace
echo "  Removed dist/, build/"
echo ""

# Build the executable
echo "Building executable with PyInstaller..."
echo "This may take several minutes..."
echo ""

$PYTHON_CMD -m PyInstaller --clean neurotrace.spec

if [ $? -eq 0 ]; then
    echo ""
    # Rename default folder to platform-specific name
    if [ -d "dist/neurotrace" ] && [ ! -d "dist/neurotrace-linux" ]; then
        echo "Renaming dist/neurotrace -> dist/neurotrace-linux"
        mv dist/neurotrace dist/neurotrace-linux
    fi
    
    # Note: ONNX model is automatically included in _internal/ by PyInstaller via neurotrace.spec
    # No manual copying needed
    
    echo "========================================"
    echo "Build completed successfully!"
    echo "========================================"
    echo ""
    
    if [ -f "dist/neurotrace-linux/neurotrace" ]; then
        exe_size=$(du -sh "dist/neurotrace-linux" | cut -f1)
        echo "Distribution location: dist/neurotrace-linux/"
        echo "Total size: $exe_size"
        echo ""
        echo "Testing executable..."
        chmod +x dist/neurotrace-linux/neurotrace
        echo "Executable is ready to use!"
    fi
else
    echo ""
    echo "========================================"
    echo "Build failed!"
    echo "========================================"
    echo "Please check the error messages above."
    exit 1
fi

echo ""
echo "Next steps:"
echo "1. The executable is located in: dist/neurotrace-linux/"
echo "2. Run it with: ./dist/neurotrace-linux/neurotrace"
echo "3. The TypeScript extension will automatically detect and use it"
echo "4. The ONNX model is embedded in: dist/neurotrace-linux/_internal/onnx_model/"
echo ""
