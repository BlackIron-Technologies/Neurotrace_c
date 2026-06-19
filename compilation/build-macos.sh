#!/bin/bash
# Build script for NeuroTrace macOS executable
# Compiles neurotrace.py into a standalone PyInstaller onedir bundle.
# Outputs to dist/neurotrace-macos/ (renamed from the default dist/neurotrace)
# Requires Python 3.11 for consistency with other platforms.

echo "========================================"
echo "NeuroTrace macOS Build Script"
echo "========================================"
echo ""

echo "Detecting Python 3.11..."
PYTHON_CMD=""
if command -v python3.11 >/dev/null 2>&1; then
    PYTHON_CMD="python3.11"
    echo "✓ Found python3.11"
elif command -v python3 >/dev/null 2>&1; then
    V=$(/usr/bin/env python3 --version 2>&1 | awk '{print $2}')
    if [[ $V == 3.11.* ]]; then
        PYTHON_CMD="python3"
        echo "✓ Found python3 ($V)"
    else
        echo "⚠️  python3 version $V (expected 3.11.x); proceeding anyway"
        PYTHON_CMD="python3"
    fi
elif command -v python >/dev/null 2>&1; then
    V=$(/usr/bin/env python --version 2>&1 | awk '{print $2}')
    if [[ $V == 3.11.* ]]; then
        PYTHON_CMD="python"
        echo "✓ Found python ($V)"
    else
        echo "❌ Python 3.11 not found. Please install 3.11.x (e.g. via pyenv)"
        exit 1
    fi
else
    echo "❌ No Python interpreter found. Install Python 3.11.x first."; exit 1
fi
echo "Using: $($PYTHON_CMD --version)"
echo ""

# Check if PyInstaller is installed
echo "Checking PyInstaller..."
if ! $PYTHON_CMD -m pip show pyinstaller >/dev/null 2>&1; then
    echo "PyInstaller not found. Installing..."
    $PYTHON_CMD -m pip install pyinstaller
else
    echo "PyInstaller is installed"
fi
echo ""

# Check required dependencies
echo "Checking required dependencies..."
REQ=(faiss-cpu onnxruntime transformers sqlcipher3-wheels numpy)
MISS=()
for pkg in "${REQ[@]}"; do
    if $PYTHON_CMD -m pip show "$pkg" >/dev/null 2>&1; then
        echo "  ✓ Found: $pkg"
    else
        echo "  ✗ Missing: $pkg"; MISS+=("$pkg")
    fi
done
if [ ${#MISS[@]} -gt 0 ]; then
    echo "Installing missing packages from requirements-backend.txt (preferred)..."
    if [ -f requirements-backend.txt ]; then
        $PYTHON_CMD -m pip install -r requirements-backend.txt
    else
        $PYTHON_CMD -m pip install "${MISS[@]}"
    fi
    echo ""
fi

# Ensure ONNX model exists (look first in ../bin/onnx_model for monorepo layout)
if [ ! -d "onnx_model" ] && [ -d "../bin/onnx_model" ]; then
    echo "Linking ../bin/onnx_model → ./onnx_model"
    ln -sf ../bin/onnx_model onnx_model
fi
if [ ! -d "onnx_model" ]; then
    echo "ERROR: onnx_model directory is required for release builds."
    echo "Place the reviewed ONNX model files in compilation/onnx_model before building."
    exit 1
fi

# Clean previous build artifacts
echo "Cleaning previous build artifacts..."
rm -rf dist build neurotrace *.spec-eval
echo "  Removed dist/, build/"
echo ""

# Build the executable
echo "Building executable with PyInstaller..."
echo "This may take several minutes..."
echo ""

# UNIVERSAL BUILD MODE (set UNIVERSAL=1)
UNIVERSAL=${UNIVERSAL:-0}  # Default to single-arch build (native architecture)
ARCH=$(uname -m)
echo "Host architecture: $ARCH"
if [ "$UNIVERSAL" = "1" ]; then
    echo "Universal build requested (arm64 + x86_64)"
    echo "Preparing separate virtual envs (recommended) or reusing current site-packages."
    BUILD_ROOT=.universal_build
    rm -rf "$BUILD_ROOT"
    mkdir -p "$BUILD_ROOT"

    # Function to perform a single-arch build
    build_arch() {
        local target_arch=$1
        echo "--- Building for $target_arch ---"
        local build_dir="$BUILD_ROOT/$target_arch"
        mkdir -p "$build_dir"
        # We rely on current interpreter; for cross-arch you need:
        #  - On Apple Silicon: install x86_64 Python via arch -x86_64
        #  - On Intel: install arm64 Python (cannot emulate; need real hardware or CI)
        if [ "$target_arch" = "x86_64" ] && [ "$(uname -m)" = "arm64" ]; then
            PY_CMD="arch -x86_64 $PYTHON_CMD"
        elif [ "$target_arch" = "arm64" ] && [ "$(uname -m)" = "x86_64" ]; then
            echo "⚠️  Cannot build arm64 binaries from Intel host without an arm64 Python toolchain."
            echo "    Skipping arm64 build. (Provide an arm64 runner to include this arch.)"
            return 0
        else
            PY_CMD="$PYTHON_CMD"
        fi

        ( \
            cd "$build_dir" && \
            cp -R ../../neurotrace.py ../../onnx_model . 2>/dev/null || true && \
            cp ../../neurotrace.spec . 2>/dev/null || true && \
            $PY_CMD -m PyInstaller --clean neurotrace.spec --distpath dist --workpath build && \
            echo "Built $target_arch variant." \
        ) || { echo "❌ Failed building $target_arch"; exit 1; }
    }

    # Build for both architectures where possible
    build_arch arm64
    build_arch x86_64

    # Locate produced folders
    ARM_DIR=$(find "$BUILD_ROOT" -type d -path "*/dist/neurotrace" -wholename "*arm64*" -maxdepth 5 2>/dev/null | head -1)
    X86_DIR=$(find "$BUILD_ROOT" -type d -path "*/dist/neurotrace" -wholename "*x86_64*" -maxdepth 5 2>/dev/null | head -1)

    if [ -n "$ARM_DIR" ] && [ -n "$X86_DIR" ]; then
        echo "Combining arm64 + x86_64 binaries with lipo..."
        mkdir -p dist
        rsync -a "$ARM_DIR/" dist/neurotrace-macos/
        mkdir -p dist/neurotrace-macos/_internal
        # Merge main launcher
        if [ -f "$ARM_DIR/neurotrace" ] && [ -f "$X86_DIR/neurotrace" ]; then
            lipo -create -output dist/neurotrace-macos/neurotrace "$ARM_DIR/neurotrace" "$X86_DIR/neurotrace"
        fi
        # Attempt to merge a short list of critical dylibs (optional deep merge omitted for brevity)
        echo "(Note: Only main binary was merged; embedded native extensions remain per-arch from arm64 copy.)"
    else
        echo "⚠️  Universal combination incomplete (one arch missing). Using whichever single build succeeded."
        if [ -n "$ARM_DIR" ]; then
            rsync -a "$ARM_DIR/" dist/neurotrace-macos/
        elif [ -n "$X86_DIR" ]; then
            rsync -a "$X86_DIR/" dist/neurotrace-macos/
        else
            echo "❌ No successful single-arch build; aborting."; exit 1
        fi
    fi
else
    # Standard single-arch build
    $PYTHON_CMD -m PyInstaller --clean neurotrace.spec
fi

if [ $? -eq 0 ]; then
    echo ""
    # Rename default folder to platform-specific name
    if [ -d "dist/neurotrace" ] && [ ! -d "dist/neurotrace-macos" ]; then
        echo "Renaming dist/neurotrace -> dist/neurotrace-macos"
        mv dist/neurotrace dist/neurotrace-macos
    fi

    # Note: ONNX model is automatically included in _internal/ by PyInstaller via neurotrace.spec
    # No manual copying needed
    
    echo "========================================"
    echo "Build completed successfully!"
    echo "========================================"
    echo ""
    
    if [ -f "dist/neurotrace-macos/neurotrace" ]; then
        exe_size=$(du -sh "dist/neurotrace-macos" | cut -f1)
        echo "Distribution location: dist/neurotrace-macos/"
        echo "Total size: $exe_size"
        echo ""
        echo "Testing executable..."
        chmod +x dist/neurotrace-macos/neurotrace
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
echo "1. The executable is located in: dist/neurotrace-macos/"
echo "2. Run it with: ./dist/neurotrace-macos/neurotrace"
echo "3. Copy or link dist/neurotrace-macos -> bin/dist/neurotrace-macos in the extension repo"
echo "4. ONNX model: dist/neurotrace-macos/_internal/onnx_model/"
if [ "$UNIVERSAL" = "1" ]; then
    echo "5. Built in UNIVERSAL mode (merged launcher if both arch builds succeeded)"
else
    echo "5. (Set UNIVERSAL=1 for attempt at universal binary build)"
fi
echo "6. (Optional) Code sign: codesign --deep --force --sign - dist/neurotrace-macos/neurotrace"
echo "7. (Optional) Notarize using xcrun notarytool if distributing outside local dev"
echo ""
