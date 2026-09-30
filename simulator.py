#!/usr/bin/env python3
"""A dependency-free event capture and upload simulation for a sensing badge."""

import argparse
import base64
import collections
import glob
import hashlib
import io
import json
import math
import os
import re
import select
import struct
import sys
import termios
import threading
import time
import tty
import urllib.error
import urllib.parse
import urllib.request
import uuid
import wave
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
OUTBOX = ROOT / "outbox"
CLOUD = ROOT / "cloud_store"
MEDIA = {"frame.bmp": "image/bmp", "audio.wav": "audio/wav"}
ALLOWED_MEDIA = {
    "frame.bmp": "image/bmp", "frame.jpg": "image/jpeg",
    "audio.wav": "audio/wav", "audio.webm": "audio/webm",
    "audio.mp4": "audio/mp4", "audio.ogg": "audio/ogg",
}
ID_RE = re.compile(r"^[0-9a-f]{32}$")


class DeviceCameraBridge:
    """Read multiplexed JPEG and PCM packets from a CoreS3 USB CDC link."""

    CAMERA_MAGIC = b"M5CM"
    AUDIO_MAGIC = b"M5AU"
    MAGICS = (CAMERA_MAGIC, AUDIO_MAGIC)
    HEADER = struct.Struct("<4sIII")
    MAX_JPEG_BYTES = 200_000
    AUDIO_PACKET_BYTES = 320 * 2
    AUDIO_SAMPLE_RATE = 16_000

    def __init__(self):
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._jpeg = None
        self._sequence = 0
        self._captured_ms = 0
        self._received_at = 0.0
        self._audio = collections.deque(maxlen=300)
        self._audio_sequence = 0
        self._audio_received_at = 0.0
        self._port = None
        self._error = "等待 CoreS3 USB 音视频设备"

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="cores3-camera", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)

    def latest(self):
        with self._lock:
            return self._jpeg, self._sequence, self._captured_ms, self._received_at

    def status(self):
        with self._lock:
            age = time.monotonic() - self._received_at if self._received_at else None
            audio_age = time.monotonic() - self._audio_received_at if self._audio_received_at else None
            return {
                "connected": self._port is not None,
                "streaming": self._jpeg is not None and age is not None and age < 3,
                "audio_streaming": bool(self._audio) and audio_age is not None and audio_age < 3,
                "port": self._port,
                "sequence": self._sequence,
                "frame_age_ms": round(age * 1000) if age is not None else None,
                "audio_sequence": self._audio_sequence,
                "audio_age_ms": round(audio_age * 1000) if audio_age is not None else None,
                "audio_sample_rate": self.AUDIO_SAMPLE_RATE,
                "error": self._error,
            }

    def audio_since(self, sequence):
        """Return available PCM packets newer than sequence, capped for latency."""
        with self._lock:
            packets = [item for item in self._audio if item[0] > sequence]
            if len(packets) > 25:
                packets = packets[-25:]
            return packets

    def _set_connection(self, port=None, error=None):
        with self._lock:
            self._port = port
            self._error = error

    @staticmethod
    def _candidate_ports():
        configured = os.environ.get("M5_CAMERA_PORT", "").strip()
        if configured:
            return [configured]
        return sorted(glob.glob("/dev/cu.usbmodem*"))

    @staticmethod
    def _open_port(path):
        fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        tty.setraw(fd)
        attrs = termios.tcgetattr(fd)
        attrs[4] = termios.B115200
        attrs[5] = termios.B115200
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
        return fd

    def _publish(self, payload, sequence, captured_ms):
        if not (payload.startswith(b"\xff\xd8") and payload.endswith(b"\xff\xd9")):
            return
        with self._lock:
            self._jpeg = payload
            self._sequence = sequence
            self._captured_ms = captured_ms
            self._received_at = time.monotonic()
            self._error = None

    def _publish_audio(self, payload, sequence, captured_ms):
        if len(payload) != self.AUDIO_PACKET_BYTES:
            return
        with self._lock:
            self._audio.append((sequence, captured_ms, payload))
            self._audio_sequence = sequence
            self._audio_received_at = time.monotonic()
            self._error = None

    def _consume(self, buffer):
        while True:
            positions = [position for magic in self.MAGICS
                         if (position := buffer.find(magic)) >= 0]
            magic_at = min(positions) if positions else -1
            if magic_at < 0:
                if len(buffer) > len(self.CAMERA_MAGIC) - 1:
                    del buffer[:-(len(self.CAMERA_MAGIC) - 1)]
                return
            if magic_at:
                del buffer[:magic_at]
            if len(buffer) < self.HEADER.size:
                return
            magic, size, sequence, captured_ms = self.HEADER.unpack_from(buffer)
            valid_size = ((magic == self.CAMERA_MAGIC and 100 <= size <= self.MAX_JPEG_BYTES)
                          or (magic == self.AUDIO_MAGIC and size == self.AUDIO_PACKET_BYTES))
            if not valid_size:
                del buffer[0]
                continue
            packet_size = self.HEADER.size + size
            if len(buffer) < packet_size:
                return
            payload = bytes(buffer[self.HEADER.size:packet_size])
            del buffer[:packet_size]
            if magic == self.CAMERA_MAGIC:
                self._publish(payload, sequence, captured_ms)
            else:
                self._publish_audio(payload, sequence, captured_ms)

    def _run(self):
        while not self._stop.is_set():
            ports = self._candidate_ports()
            if not ports:
                self._set_connection(error="未找到 /dev/cu.usbmodem*；请连接 CoreS3")
                self._stop.wait(1)
                continue
            fd = None
            try:
                port = ports[0]
                fd = self._open_port(port)
                self._set_connection(port=port, error="已连接，等待音视频数据")
                buffer = bytearray()
                while not self._stop.is_set():
                    ready, _, _ = select.select([fd], [], [], 0.5)
                    if not ready:
                        continue
                    chunk = os.read(fd, 65_536)
                    if not chunk:
                        raise OSError("串口已断开")
                    buffer.extend(chunk)
                    self._consume(buffer)
                    if len(buffer) > self.MAX_JPEG_BYTES * 2:
                        del buffer[:-self.HEADER.size]
            except (OSError, termios.error) as exc:
                self._set_connection(error=f"USB 摄像头连接失败：{exc}")
                self._stop.wait(1)
            finally:
                if fd is not None:
                    try:
                        os.close(fd)
                    except OSError:
                        pass


DEVICE_CAMERA = DeviceCameraBridge()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def make_image():
    """Build a small, valid 24-bit BMP without image libraries."""
    width, height = 320, 240
    row_stride = (width * 3 + 3) & ~3
    pixel_bytes = bytearray()
    for y in range(height):
        row = bytearray()
        for x in range(width):
            if 65 < x < 255 and 45 < y < 190:
                color = (80, 145, 220)  # BGR foreground rectangle
            else:
                color = (210, 230, 245)
            row.extend(color)
        row.extend(b"\0" * (row_stride - width * 3))
        pixel_bytes.extend(row)
    header = b"BM" + struct.pack("<IHHI", 54 + len(pixel_bytes), 0, 0, 54)
    header += struct.pack("<IiiHHIIiiII", 40, width, height, 1, 24, 0, len(pixel_bytes), 2835, 2835, 0, 0)
    return header + pixel_bytes


def make_audio():
    """Build a two-second WAV containing a tone, not spoken words."""
    sample_rate = 16000
    samples = bytearray()
    for index in range(sample_rate * 2):
        amplitude = int(3500 * math.sin(2 * math.pi * 440 * index / sample_rate))
        samples.extend(struct.pack("<h", amplitude))
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(samples)
    return output.getvalue()


def capture(args):
    event_id = uuid.uuid4().hex
    folder = OUTBOX / event_id
    blobs = {"frame.bmp": make_image(), "audio.wav": make_audio()}
    save_local_event(event_id, blobs, {name: MEDIA[name] for name in blobs},
                     datetime.now(timezone.utc).isoformat(),
                     {"scene": args.scene, "speech": args.speech}, "computer-simulator")
    print("已产生事件", event_id)
    print("本地目录", folder)


def save_local_event(event_id, blobs, content_types, captured_at, labels, device_id):
    folder = OUTBOX / event_id
    folder.mkdir(parents=True, exist_ok=False)
    for name, content in blobs.items():
        (folder / name).write_bytes(content)
    event = {
        "schema_version": 1,
        "event_id": event_id,
        "device_id": device_id,
        "captured_at": captured_at,
        "upload_state": "pending",
        "mock_labels": labels,
        "media": {name: {"content_type": content_types[name], "sha256": hashlib.sha256(content).hexdigest()}
                  for name, content in blobs.items()},
    }
    write_json(folder / "event.json", event)
    return event


def sync(args):
    folders = sorted(OUTBOX.glob("*/event.json"))
    if not folders:
        print("没有待上传事件。先运行 capture。")
        return
    for event_file in folders:
        event = json.loads(event_file.read_text(encoding="utf-8"))
        if event["upload_state"] == "uploaded" and not args.retry_all:
            continue
        payload = {"event": event, "files": {}}
        for name in event["media"]:
            payload["files"][name] = base64.b64encode((event_file.parent / name).read_bytes()).decode("ascii")
        request = urllib.request.Request(
            args.url.rstrip("/") + "/events",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                receipt = json.load(response)
            if receipt.get("event_id") != event["event_id"]:
                raise ValueError("服务端返回的事件编号不一致")
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            print("上传失败，仍保存在本地：", event["event_id"], str(exc))
            continue
        event["upload_state"] = "uploaded"
        write_json(event_file, event)
        print("已上传", event["event_id"], "（" + receipt["result"] + "）")


def list_events(_args):
    files = sorted(OUTBOX.glob("*/event.json"))
    if not files:
        print("暂无事件。")
    for event_file in files:
        event = json.loads(event_file.read_text(encoding="utf-8"))
        print(event["captured_at"], event["upload_state"], event["event_id"], event["mock_labels"]["scene"])


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        if args and (str(args[0]).startswith("GET /device-camera.jpg")
                     or str(args[0]).startswith("GET /device-audio.pcm")):
            return
        super().log_message(format, *args)

    def send_json(self, status, value):
        body = json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        pages = {
            "/": ("capture.html", "text/html; charset=utf-8"),
            "/face": ("face.html", "text/html; charset=utf-8"),
            "/face.js": ("face.js", "text/javascript; charset=utf-8"),
            "/state_signals.js": ("state_signals.js", "text/javascript; charset=utf-8"),
        }
        if path in pages:
            filename, content_type = pages[path]
            body = (ROOT / filename).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/device-camera/status":
            self.send_json(200, DEVICE_CAMERA.status())
            return
        if path == "/device-camera.jpg":
            jpeg, sequence, captured_ms, received_at = DEVICE_CAMERA.latest()
            if jpeg is None or time.monotonic() - received_at > 3:
                self.send_json(503, {"error": "尚未收到 CoreS3 画面", **DEVICE_CAMERA.status()})
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("X-Frame-Sequence", str(sequence))
            self.send_header("X-Device-Millis", str(captured_ms))
            self.send_header("Content-Length", str(len(jpeg)))
            self.end_headers()
            self.wfile.write(jpeg)
            return
        if path == "/device-audio.pcm":
            try:
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                after = int(query.get("after", ["0"])[0])
            except (TypeError, ValueError):
                self.send_json(400, {"error": "invalid audio sequence"})
                return
            packets = DEVICE_CAMERA.audio_since(after)
            if not packets:
                status = DEVICE_CAMERA.status()
                if not status["audio_streaming"]:
                    self.send_json(503, {"error": "尚未收到 CoreS3 麦克风数据", **status})
                else:
                    self.send_response(204)
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                return
            first_sequence = packets[0][0]
            last_sequence = packets[-1][0]
            body = b"".join(item[2] for item in packets)
            self.send_response(200)
            self.send_header("Content-Type", "audio/L16; rate=16000; channels=1")
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("X-Audio-First-Sequence", str(first_sequence))
            self.send_header("X-Audio-Sequence", str(last_sequence))
            self.send_header("X-Audio-Packets", str(len(packets)))
            self.send_header("X-Audio-Sample-Rate", str(DEVICE_CAMERA.AUDIO_SAMPLE_RATE))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path != "/events":
            self.send_json(404, {"error": "not found"})
            return
        events = []
        for path in sorted(CLOUD.glob("*/analysis.json")):
            events.append(json.loads(path.read_text(encoding="utf-8")))
        self.send_json(200, {"events": events})

    def do_POST(self):
        if self.path == "/analyze-expression":
            size = int(self.headers.get("Content-Length", "0"))
            if self.headers.get("Content-Type", "").split(";", 1)[0] != "image/jpeg" or not 0 < size <= 500_000:
                self.send_json(413, {"error": "expected a JPEG crop below 500 KB"})
                return
            try:
                from expression_models import analyze_jpeg
                self.send_json(200, analyze_jpeg(self.rfile.read(size)))
            except (ImportError, ValueError, OSError) as exc:
                self.send_json(400, {"error": str(exc)})
            return
        if self.path not in ("/events", "/capture"):
            self.send_json(404, {"error": "not found"})
            return
        size = int(self.headers.get("Content-Length", "0"))
        if size < 1 or size > 10_000_000:
            self.send_json(413, {"error": "invalid payload size"})
            return
        try:
            payload = json.loads(self.rfile.read(size))
            if self.path == "/capture":
                files = payload["files"]
                if len(files) != 2 or len([n for n in files if n.startswith("frame.")]) != 1 or len([n for n in files if n.startswith("audio.")]) != 1:
                    raise ValueError("expected one image and one audio file")
                if any(name not in ALLOWED_MEDIA for name in files):
                    raise ValueError("unsupported media name")
                blobs = {name: base64.b64decode(value, validate=True) for name, value in files.items()}
                if any(not content for content in blobs.values()):
                    raise ValueError("empty media file")
                event_id = uuid.uuid4().hex
                event = save_local_event(
                    event_id, blobs, {name: ALLOWED_MEDIA[name] for name in blobs},
                    payload.get("captured_at") or datetime.now(timezone.utc).isoformat(),
                    {}, "computer-camera-mic")
                self.send_json(201, {"event_id": event["event_id"], "result": "saved_locally"})
                return
            event = payload["event"]
            event_id = event["event_id"]
            if not ID_RE.fullmatch(event_id):
                raise ValueError("invalid event id")
            names = set(event["media"])
            if len(names) != 2 or len([n for n in names if n.startswith("frame.")]) != 1 or len([n for n in names if n.startswith("audio.")]) != 1:
                raise ValueError("expected one image and one audio file")
            if any(name not in ALLOWED_MEDIA for name in names):
                raise ValueError("unsupported media name")
            blobs = {name: base64.b64decode(payload["files"][name], validate=True) for name in names}
            for name, content in blobs.items():
                if hashlib.sha256(content).hexdigest() != event["media"][name]["sha256"]:
                    raise ValueError("media checksum mismatch")
            folder = CLOUD / event_id
            if folder.exists():
                self.send_json(200, {"event_id": event_id, "result": "already_exists"})
                return
            folder.mkdir(parents=True)
            write_json(folder / "event.json", event)
            for name, content in blobs.items():
                (folder / name).write_bytes(content)
            analysis = {
                "event_id": event_id,
                "captured_at": event["captured_at"],
                "scene_description": "模拟理解结果：" + event.get("mock_labels", {}).get("scene", "尚未接入图像理解"),
                "transcript": "模拟转写结果：" + event.get("mock_labels", {}).get("speech", "尚未接入语音识别"),
                "is_mock": True,
            }
            write_json(folder / "analysis.json", analysis)
            self.send_json(201, {"event_id": event_id, "result": "created"})
        except (KeyError, ValueError, TypeError) as exc:
            self.send_json(400, {"error": str(exc)})


def server(args):
    CLOUD.mkdir(exist_ok=True)
    DEVICE_CAMERA.start()
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("本机采集页：http://127.0.0.1:" + str(args.port) + "/ ，按 Ctrl+C 停止", flush=True)
    print("CoreS3 USB 音视频状态：http://127.0.0.1:" + str(args.port) + "/device-camera/status", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n服务端已停止")
    finally:
        httpd.server_close()
        DEVICE_CAMERA.stop()


def main():
    parser = argparse.ArgumentParser(description="随身感知节点的电脑模拟器")
    sub = parser.add_subparsers(dest="command", required=True)
    cap = sub.add_parser("capture", help="模拟一次拍照与录音")
    cap.add_argument("--scene", default="室内场景")
    cap.add_argument("--speech", default="你好")
    cap.set_defaults(func=capture)
    upl = sub.add_parser("sync", help="补传本地事件")
    upl.add_argument("--url", default="http://127.0.0.1:8765")
    upl.add_argument("--retry-all", action="store_true", help="重新发送已上传事件，验证服务端去重")
    upl.set_defaults(func=sync)
    show = sub.add_parser("list", help="查看本地事件状态")
    show.set_defaults(func=list_events)
    srv = sub.add_parser("server", help="启动本机接收服务")
    srv.add_argument("--port", type=int, default=8765)
    srv.set_defaults(func=server)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
