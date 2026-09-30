"""Run two local facial-expression models on an already cropped face image.

The browser supplies a crop produced by MediaPipe. This module never writes face
images to disk; only public model weights are cached under the project folder.
"""

import io
import os
import threading
import time
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
MODEL_CACHE = ROOT / ".model-cache"
EMOTIEFF_MODEL = "enet_b0_8_best_afew"
EMOTIEFF_WEIGHTS = MODEL_CACHE / "emotiefflib" / (EMOTIEFF_MODEL + ".onnx")
EMOTIEFF_URL = (
    "https://github.com/sb-ai-lab/EmotiEffLib/blob/main/"
    "models/affectnet_emotions/onnx/" + EMOTIEFF_MODEL + ".onnx?raw=true"
)

# DeepFace supports this documented environment setting for its weight cache.
os.environ.setdefault("DEEPFACE_HOME", str(MODEL_CACHE))
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

_lock = threading.Lock()
_emotieff = None


def _get_emotieff():
    global _emotieff
    if _emotieff is not None:
        return _emotieff
    if not EMOTIEFF_WEIGHTS.exists():
        EMOTIEFF_WEIGHTS.parent.mkdir(parents=True, exist_ok=True)
        temporary = EMOTIEFF_WEIGHTS.with_suffix(".download")
        try:
            urllib.request.urlretrieve(EMOTIEFF_URL, temporary)
            if temporary.stat().st_size < 1_000_000:
                raise ValueError("下载的 EmotiEffLib 模型文件不完整")
            temporary.replace(EMOTIEFF_WEIGHTS)
        finally:
            temporary.unlink(missing_ok=True)

    from emotiefflib import facial_analysis

    # EmotiEffLib defaults to a cache in the user's home directory. Point this
    # one recognizer at the downloaded model inside the project instead.
    original = facial_analysis.get_model_path_onnx
    try:
        facial_analysis.get_model_path_onnx = lambda _name: str(EMOTIEFF_WEIGHTS)
        _emotieff = facial_analysis.EmotiEffLibRecognizer(
            engine="onnx", model_name=EMOTIEFF_MODEL
        )
    finally:
        facial_analysis.get_model_path_onnx = original
    return _emotieff


def _deepface_result(rgb):
    import cv2
    from deepface import DeepFace

    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    result = DeepFace.analyze(
        img_path=bgr,
        actions=["emotion"],
        detector_backend="skip",
        enforce_detection=False,
        align=False,
        silent=True,
    )[0]
    scores = {name: float(value) / 100 for name, value in result["emotion"].items()}
    return {"label": result["dominant_emotion"], "scores": scores}


def _emotieff_result(rgb):
    recognizer = _get_emotieff()
    labels, probabilities = recognizer.predict_emotions(rgb, logits=False)
    scores = {
        recognizer.idx_to_emotion_class[index]: float(value)
        for index, value in enumerate(probabilities[0])
    }
    return {"label": labels[0], "scores": scores}


def analyze_jpeg(jpeg):
    """Return independent model results; failures in one do not hide the other."""
    from PIL import Image
    import numpy as np

    image = Image.open(io.BytesIO(jpeg))
    if image.format != "JPEG" or image.width > 1024 or image.height > 1024:
        raise ValueError("只接受不超过 1024 × 1024 的 JPEG 人脸图片")
    rgb = np.asarray(image.convert("RGB"))
    results = {}
    # Keep TensorFlow and ONNX initialization/inference from racing across
    # concurrent HTTP requests. The browser also sends only one at a time.
    with _lock:
        for name, runner in (("deepface", _deepface_result), ("emotiefflib", _emotieff_result)):
            started = time.monotonic()
            try:
                value = runner(rgb)
                value["elapsed_ms"] = round((time.monotonic() - started) * 1000)
                value["ok"] = True
                results[name] = value
            except Exception as exc:
                results[name] = {"ok": False, "error": str(exc)}
    return {"models": results}
