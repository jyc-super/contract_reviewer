import sys
import time

print(f"Python: {sys.version}")
print(f"Executable: {sys.executable}")
print("Starting torch import...")
sys.stdout.flush()

t = time.time()
import torch
elapsed = time.time() - t

print(f"torch {torch.__version__} imported in {elapsed:.2f}s")
print(f"torch file: {torch.__file__}")
sys.stdout.flush()
