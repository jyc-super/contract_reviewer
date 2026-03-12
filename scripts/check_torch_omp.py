"""
Test torch._C import with OMP thread count forced to 1.
This bypasses libiomp5md thread pool initialization deadlocks.
"""
import sys
import os
import time

# Force OMP to single thread BEFORE any torch import
os.environ['OMP_NUM_THREADS'] = '1'
os.environ['MKL_NUM_THREADS'] = '1'
os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['NUMEXPR_NUM_THREADS'] = '1'
os.environ['KMP_DUPLICATE_LIB_OK'] = 'TRUE'
os.environ['KMP_INIT_AT_FORK'] = 'FALSE'

print(f"Python {sys.version}")
print(f"PID: {os.getpid()}")
print("OMP_NUM_THREADS=1, KMP_DUPLICATE_LIB_OK=TRUE set")
sys.stdout.flush()

print("\nImporting torch._C with OMP restricted to 1 thread...")
sys.stdout.flush()
t = time.time()
try:
    import torch._C
    print(f"torch._C imported in {time.time()-t:.2f}s")
    sys.stdout.flush()

    print("\nNow importing full torch...")
    sys.stdout.flush()
    t2 = time.time()
    import torch
    print(f"torch {torch.__version__} imported in {time.time()-t2:.2f}s")
    sys.stdout.flush()
except Exception as e:
    print(f"FAILED in {time.time()-t:.2f}s: {e}")
    sys.stdout.flush()
