# M5CoreS3-Lite 项目交接说明

本仓库只包含 M5CoreS3-Lite 相关的摄像头、录音、USB 实时音视频网页、人脸追踪和表情分析原型，不包含其他机器人项目。

## 已完成状态

- 已在 M5CoreS3-Lite 实机上烧录并验证 320×240 JPEG 画面。
- Type-C 链路使用自定义二进制协议，同时传输 JPEG 视频和 16 kHz / 16-bit / 单声道 PCM。
- 麦克风采集与 JPEG 抓帧已用独立 FreeRTOS 任务和环形缓冲解耦。
- 固件已有去直流/高通、保守噪声门、AGC 和软限幅；网页有音频抖动缓冲。
- 测试时画面约 5 FPS，音频包约 49.8 包/秒，3 秒窗口覆盖约 101%，未观察到序号空洞。这些数值只是开发环境快照。
- 网页已接入 MediaPipe 人脸追踪、DeepFace 和 EmotiEffLib，可显示波形、实时监听和下载 WAV。

## 快速复现

1. 先烧录 `m5cores3_lite_selftest/m5cores3_lite_selftest.ino`，验证开发板。
2. 烧录 `m5cores3_lite_usb_camera/m5cores3_lite_usb_camera.ino`，保持 Type-C 数据线连接。
3. 在仓库根目录创建 Python 3.12 环境并启动服务：

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements-expression.txt
.venv/bin/python simulator.py server
```

4. 打开 `http://127.0.0.1:8765/face`，选择 **M5CoreS3-Lite（USB）** 并开始分析。
5. 在 `http://127.0.0.1:8765/device-camera/status` 检查串口、视频帧、音频包序号和延迟。

## 尚未完成

- 实时语音转文字尚未实现；交接前只完成了 sherpa-onnx streaming zipformer 的初步选型。
- 目前没有完整的 AEC 回声消除。实时监听时建议使用耳机。
- 页面和 HTTP API 只供本地原型验证；公网部署需要 TLS、身份验证和数据保留策略。
- 表情与状态输出只是模型线索，不能作为心理、医疗或注意力诊断。

## 未上传的本地数据

仓库明确排除以下隐私或可重建内容：

- `.venv/`、`.venv-asr/`、`__pycache__/`；
- `.model-cache/`、`.asr-models/` 与可重新下载的模型权重；
- `outbox/`、`cloud_store/` 中的录音、画面和测试人脸数据；
- 设备 Flash 备份、本地日志、运行缓存和密钥。

## 代码与安全提示

仓库不应提交 API Key、Wi-Fi 密码、真实人脸、录音或其他个人识别数据。对外再分发代码前，请由项目负责人确认版权归属和适用许可证。
