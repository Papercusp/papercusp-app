"""Model-free monotonic/RAW-clock CUDA probe; extends the cuBLAS preflight.

Run under the qualified Nsight bundle with unshifted SQLite export. The TS
measurement guard binds exported API/kernel correlations to these call windows.
This fixture performs no model inference and does not qualify model acceptance.
"""
import ctypes as c
import hashlib
import json
import os
import pathlib
import sys
import threading
import time


def fingerprint(path):
    path = pathlib.Path(path).resolve()
    digest = hashlib.sha256()
    with path.open("rb") as data:
        for chunk in iter(lambda: data.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"path": str(path), "bytes": path.stat().st_size, "sha256": digest.hexdigest()}


def clocks():
    before = time.clock_gettime_ns(time.CLOCK_MONOTONIC)
    raw = time.clock_gettime_ns(time.CLOCK_MONOTONIC_RAW)
    after = time.clock_gettime_ns(time.CLOCK_MONOTONIC)
    return {"rawNs": str(raw), "monotonicBeforeNs": str(before), "monotonicAfterNs": str(after)}


cuda_path = pathlib.Path("/usr/lib/x86_64-linux-gnu/libcudart.so.12").resolve()
blas_path = pathlib.Path("/usr/lib/x86_64-linux-gnu/libcublas.so.12").resolve()
cuda = c.CDLL(str(cuda_path))
cuda.cudaSetDevice.argtypes = [c.c_int]
cuda.cudaMalloc.argtypes = [c.POINTER(c.c_void_p), c.c_size_t]
cuda.cudaMemcpy.argtypes = [c.c_void_p, c.c_void_p, c.c_size_t, c.c_int]
cuda.cudaFree.argtypes = [c.c_void_p]
cuda.cudaMemGetInfo.argtypes = [c.POINTER(c.c_size_t), c.POINTER(c.c_size_t)]
cuda.cudaGetErrorString.argtypes = [c.c_int]
cuda.cudaGetErrorString.restype = c.c_char_p


def cuda_ok(code, operation):
    if code:
        raise RuntimeError(operation + ": " + cuda.cudaGetErrorString(code).decode())


def blas_ok(code, operation):
    if code:
        raise RuntimeError(operation + ": cuBLAS status " + str(code))


cuda_ok(cuda.cudaSetDevice(0), "cudaSetDevice")
if len(sys.argv) == 3:
    if sys.argv[2] != "allocator-api-control":
        raise ValueError("unknown CUDA preflight mode")
    free, total = c.c_size_t(), c.c_size_t()
    cuda_ok(cuda.cudaMemGetInfo(c.byref(free), c.byref(total)), "cudaMemGetInfo")
    requested = total.value + 4096
    if not 0 < free.value <= total.value or c.c_size_t(requested).value != requested:
        raise RuntimeError("invalid CUDA allocation control capacity")
    pointer, failed_pointer = c.c_void_p(), c.c_void_p()
    cuda_ok(cuda.cudaMalloc(c.byref(pointer), 32), "cudaMalloc small control")
    try:
        before = clocks()
        print("PC_CUDA_ALLOCATION_CONTROL\tstart", flush=True)
        code = cuda.cudaMalloc(c.byref(failed_pointer), requested)
        print("PC_CUDA_ALLOCATION_CONTROL\tend", flush=True)
        after = clocks()
        # This must exceed TOTAL capacity, independent of concurrent users.
        # A successful allocation or a different failure never qualifies the tool.
        if code != 2 or failed_pointer.value:
            raise RuntimeError("impossible allocation did not return cudaErrorMemoryAllocation")
        receipt = {"formatVersion": 1, "workItem": "WI-10004540",
            "operation": "CUDA allocator API failure control", "modelInferencePerformed": False,
            "processId": os.getpid(), "nativeThreadId": threading.get_native_id(),
            "requestedBytes": requested, "freeBytes": free.value, "totalBytes": total.value,
            "returnCode": code, "error": cuda.cudaGetErrorString(code).decode(),
            "beforeClock": before, "afterClock": after, "smallAllocationBytes": 32,
            "source": fingerprint(__file__), "python": fingerprint(sys.executable),
            "cudaRuntime": fingerprint(cuda_path)}
        with pathlib.Path(sys.argv[1]).open("x") as out:
            json.dump(receipt, out, indent=2)
            out.write("\n")
        print("[cuda-allocation-preflight] EXPECTED FAILURE RETAINED", flush=True)
    finally:
        if failed_pointer.value:
            cuda_ok(cuda.cudaFree(failed_pointer), "cudaFree unexpected allocation")
        cuda_ok(cuda.cudaFree(pointer), "cudaFree small control")
    sys.exit(0)

blas = c.CDLL(str(blas_path))
blas.cublasCreate_v2.argtypes = [c.POINTER(c.c_void_p)]
blas.cublasDestroy_v2.argtypes = [c.c_void_p]
blas.cublasSgemm_v2.argtypes = [c.c_void_p, c.c_int, c.c_int, c.c_int, c.c_int, c.c_int,
    c.POINTER(c.c_float), c.c_void_p, c.c_int, c.c_void_p, c.c_int,
    c.POINTER(c.c_float), c.c_void_p, c.c_int]
handle = c.c_void_p()
blas_ok(blas.cublasCreate_v2(c.byref(handle)), "cublasCreate")
buffers, operations = [], []
try:
    side, count = 64, 64 * 64
    byte_count = count * c.sizeof(c.c_float)
    host_input, host_output = (c.c_float * count)(*([1.0] * count)), (c.c_float * count)()
    for _ in range(3):
        pointer = c.c_void_p()
        cuda_ok(cuda.cudaMalloc(c.byref(pointer), byte_count), "cudaMalloc")
        buffers.append(pointer)
    for pointer in buffers[:2]:
        cuda_ok(cuda.cudaMemcpy(pointer, c.cast(host_input, c.c_void_p), byte_count, 1), "cudaMemcpy H2D")
    alpha, beta = c.c_float(1.0), c.c_float(0.0)
    for index in range(3):
        before = clocks()
        code = blas.cublasSgemm_v2(handle, 0, 0, side, side, side, c.byref(alpha),
            buffers[0], side, buffers[1], side, c.byref(beta), buffers[2], side)
        after = clocks()
        blas_ok(code, "cublasSgemm")
        operations.append({"runTag": "cuda-clock-preflight:" + str(index), "processId": os.getpid(),
            "nativeThreadId": threading.get_native_id(), "startRawNs": before["rawNs"],
            "endRawNs": after["rawNs"], "startMonotonicNs": before["monotonicAfterNs"],
            "endMonotonicNs": after["monotonicBeforeNs"], "beforeClock": before, "afterClock": after})
        cuda_ok(cuda.cudaDeviceSynchronize(), "cudaDeviceSynchronize")
        cuda_ok(cuda.cudaMemcpy(c.cast(host_output, c.c_void_p), buffers[2], byte_count, 2), "cudaMemcpy D2H")
        assert all(value == float(side) for value in host_output), "CUDA arithmetic output mismatch"
        time.sleep(0.05)
    receipt = {"formatVersion": 1, "workItem": "WI-10004540", "operation": "maintained cuBLAS SGEMM",
        "shape": [side, side, side], "operations": operations, "outputEquals64": True,
        "modelInferencePerformed": False, "source": fingerprint(__file__),
        "python": fingerprint(sys.executable), "cudaRuntime": fingerprint(cuda_path), "cublas": fingerprint(blas_path)}
    with pathlib.Path(sys.argv[1]).open("x") as out:
        json.dump(receipt, out, indent=2)
        out.write("\n")
    print("[cuda-clock-preflight] OPERATION COMPLETE", flush=True)
finally:
    for pointer in buffers:
        cuda_ok(cuda.cudaFree(pointer), "cudaFree")
    blas_ok(blas.cublasDestroy_v2(handle), "cublasDestroy")
