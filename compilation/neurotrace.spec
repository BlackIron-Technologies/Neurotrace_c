# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for NeuroTrace backend
Compiles neurotrace.py into a standalone executable for Windows
Includes all necessary dependencies: FAISS, ONNX Runtime, transformers, sqlcipher3
"""

import sys
import os
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

# Get the absolute path to the bin directory
bin_path = SPECPATH

block_cipher = None

# Collect all necessary hidden imports
hiddenimports = [
    # SQLCipher
    'sqlcipher3',
    'sqlcipher3.dbapi2',
    
    # Standard library modules that might be missed
    'sqlite3',
    'json',
    'struct',
    'uuid',
    'datetime',
    'pathlib',
    'sys',
    'os',
    
    # Main modules - ONNX Runtime instead of SentenceTransformer
    'onnxruntime',
    'transformers',
    'faiss',
]

# Collect submodules for complex libraries
hiddenimports += collect_submodules('faiss')
hiddenimports += collect_submodules('onnxruntime')
# Only collect essential transformers modules, not all
hiddenimports += [
    'transformers.models.auto',
    'transformers.tokenization_utils',
    'transformers.tokenization_utils_base',
    'transformers.models.bert',
]
hiddenimports += collect_submodules('tokenizers')
hiddenimports += collect_submodules('numpy')

# Additional specific imports that might be missed
hiddenimports += [
    'faiss.cpu',  # FAISS CPU implementation
    'numpy._core._exceptions',  # NumPy core exceptions
    'numpy._core._multiarray_umath',
    'numpy.core._multiarray_umath',
    'onnxruntime.capi._pybind_state',  # ONNX Runtime core
    'transformers.modeling_utils',  # Transformers modeling
    'transformers.tokenization_utils',  # Tokenizers
]

# Include the ONNX model directory
datas = [
    (os.path.join(bin_path, 'onnx_model'), 'onnx_model'),  # Bundle ONNX model files
]

print("Building open-source backend bundle")

a = Analysis(
    ['neurotrace.py'],
    pathex=[bin_path],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[bin_path],  # Use custom hooks from bin directory
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Exclude unnecessary packages to reduce size
        'matplotlib',
        'PIL',
        'tkinter',
        'pytest',
        'IPython',
        'notebook',
        'jupyter',
        'pandas',  # Not needed
        'scipy',   # Not needed
        'sklearn', # Not needed
        'torch',   # Not needed - using ONNX instead
        'triton',  # Not needed - PyTorch GPU compiler
        'tensorflow',  # Not needed
        'ml_dtypes',  # Not needed - JAX data types
        'jax',  # Not needed - Google's ML framework
        'hf_xet',  # Not needed - Hugging Face XetHub
        'safetensors',  # Not needed - only for loading PyTorch models
        'accelerate',  # Not needed - Hugging Face training lib
        'bitsandbytes',  # Not needed - quantization lib
        'pandas.tests',
        'scipy.tests',
        'sklearn.tests',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,  # Changed to onedir mode
    name='neurotrace',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,  # Keep console for debugging output
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,  # Add icon path here if you have one: icon='path/to/icon.ico'
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='neurotrace',
)
