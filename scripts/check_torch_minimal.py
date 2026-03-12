"""
Minimal torch import diagnostic - tests import stages one by one.
Run with: .venv/Scripts/python.exe scripts/check_torch_minimal.py
"""
import sys
import time
import os

print(f"Python {sys.version}")
print(f"PID: {os.getpid()}")
sys.stdout.flush()

# Test 1: Can we load torch._C directly?
print("\n[1] Testing ctypes DLL load of torch_cpu.dll...")
sys.stdout.flush()
t = time.time()
try:
    import ctypes
    dll_path = os.path.join(os.path.dirname(sys.executable), '..', 'Lib', 'site-packages', 'torch', 'lib', 'torch_cpu.dll')
    dll_path = os.path.abspath(dll_path)
    print(f"    Loading: {dll_path}")
    sys.stdout.flush()
    lib = ctypes.CDLL(dll_path)
    print(f"    torch_cpu.dll loaded in {time.time()-t:.2f}s")
except Exception as e:
    print(f"    FAILED in {time.time()-t:.2f}s: {e}")
sys.stdout.flush()

# Test 2: libiomp5md.dll
print("\n[2] Testing ctypes DLL load of libiomp5md.dll...")
sys.stdout.flush()
t = time.time()
try:
    import ctypes
    dll_path = os.path.join(os.path.dirname(sys.executable), '..', 'Lib', 'site-packages', 'torch', 'lib', 'libiomp5md.dll')
    dll_path = os.path.abspath(dll_path)
    print(f"    Loading: {dll_path}")
    sys.stdout.flush()
    lib = ctypes.CDLL(dll_path)
    print(f"    libiomp5md.dll loaded in {time.time()-t:.2f}s")
except Exception as e:
    print(f"    FAILED in {time.time()-t:.2f}s: {e}")
sys.stdout.flush()

# Test 3: import torch._C
print("\n[3] Testing: import torch._C ...")
sys.stdout.flush()
t = time.time()
try:
    import torch._C
    print(f"    torch._C imported in {time.time()-t:.2f}s")
except Exception as e:
    print(f"    FAILED in {time.time()-t:.2f}s: {e}")
sys.stdout.flush()

print("\nDone.")
