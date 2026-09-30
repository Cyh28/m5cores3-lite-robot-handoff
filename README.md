# M5CoreS3-Lite USB 音视频与表情分析

> 交接状态：摄像头、16 kHz 麦克风、USB 音视频传输、网页人脸追踪、
> DeepFace 与 EmotiEffLib 表情分析已实现。实时语音转文字尚未完成，
> 详见仓库根目录的 `HANDOFF_ZH.md`。

这是一个独立的 M5CoreS3-Lite 开发与交接仓库，不包含其他机器人项目。它实现了从设备通过 Type-C 传输 JPEG 画面和 PCM 音频，再在电脑网页中预览、监听、录制、追踪人脸并运行两套表情模型的完整原型。

## 实时人脸追踪与表情观察

### 使用 M5CoreS3-Lite 摄像头（USB）

烧录 [`m5cores3_lite_usb_camera/m5cores3_lite_usb_camera.ino`](m5cores3_lite_usb_camera/m5cores3_lite_usb_camera.ino)，并保持 Type-C 数据线连接。启动本地服务：

```bash
cd m5cores3-lite-robot-handoff
./start_face_server.command
```

打开 <http://127.0.0.1:8765/face>，摄像头来源选择 **M5CoreS3-Lite（USB）**，再点击“开始实时分析”。服务会自动寻找 `/dev/cu.usbmodem*`，也可用环境变量指定端口：

```bash
M5_CAMERA_PORT=/dev/cu.usbmodem101 ./start_face_server.command
```

设备以二进制复用协议传输 320×240 JPEG 和 16 kHz / 16 位 / 单声道 PCM；麦克风由独立 FreeRTOS 任务连续采集，通过环形缓冲与摄像头/JPEG 解耦。固件对语音执行高通去直流、保守噪声门、AGC 和软限幅，网页端另有音频抖动缓冲。未运行网页服务时会丢弃待传数据，不会因 USB 缓冲阻塞摄像头预览。可在 <http://127.0.0.1:8765/device-camera/status> 查看串口、音视频序号和延迟。网页可显示麦克风波形、实时监听，也可主动录制并下载 WAV。监听默认静音以防止声学回授，建议戴耳机后再调高。MediaPipe 人脸追踪与动作/状态线索在浏览器运行；下方 DeepFace 与 EmotiEffLib 在本机 Python 环境中运行。

用 Python 3.12 建立独立环境并安装两个本地表情模型：

```bash
cd m5cores3-lite-robot-handoff
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements-expression.txt
.venv/bin/python simulator.py server
```

本项目已创建过 `.venv` 时，可直接双击 `start_face_server.command`，或运行 `./start_face_server.command`。请勿用 macOS 自带的 `/usr/bin/python3` 启动，它不包含两个模型的依赖。

打开 <http://127.0.0.1:8765/face>，点击“开始实时分析”并允许摄像头权限。页面会绘制人脸追踪框，显示嘴角上扬、眉部下压等动作系数；下方每隔约 1.5 秒更新 DeepFace 和 EmotiEffLib 对同一张脸的表情分类。新加的“状态线索”以约 10 帧/秒观察眼睛闭合、面部动作和视线变化，并显示最近 30 秒曲线。至少观察 10 秒后提示是否有持续闭眼等困倦线索；持续凝视只提示本人确认，不能据此判定发呆。点击“停止”即可释放摄像头并清空本次时间线。首次调用两个模型时会下载权重并初始化，可能需要等待一会儿。权重缓存位于 `.model-cache/`。

首次启动需要联网下载固定版本的 MediaPipe 浏览器程序、WASM 和人脸模型；MediaPipe 在本机浏览器推理。DeepFace 和 EmotiEffLib 在本机 Python 服务推理，网页只向 `127.0.0.1` 发送裁切后的临时 JPEG，不会保存这些临时帧或发到外部云端。状态时间线只放在当前浏览器页面的内存中，不会保存。选择 CoreS3 时音频直接来自设备 USB，不需要电脑麦克风权限；选择电脑摄像头时则会一并请求电脑麦克风。动作系数、状态线索和分类结果都不能单独证明一个人的心理状态。

## 仓库结构

- `m5cores3_lite_usb_camera/`：同时输出 JPEG 画面和 PCM 音频的主固件。
- `m5cores3_lite_camera/`：摄像头独立测试固件。
- `m5cores3_lite_selftest/`：开发板基础自检固件。
- `simulator.py`：本地 HTTP 服务、串口音视频解复用和表情模型 API。
- `face.html`、`face.js`、`state_signals.js`：实时画面、声音、人脸追踪和状态线索界面。
- `expression_models.py`：DeepFace 和 EmotiEffLib 本地推理封装。
- `HANDOFF_ZH.md`：已测状态、已知限制和接手顺序。

## 已知限制

- 实时语音转文字尚未完成。
- 当前只有基础语音增强，没有完整 AEC 回声消除。
- 表情和状态线索不能用作医疗、心理或注意力诊断。
- HTTP 服务只供本地开发，不应直接暴露到公网。
