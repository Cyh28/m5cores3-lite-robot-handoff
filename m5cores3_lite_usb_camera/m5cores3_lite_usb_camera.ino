#include <M5CoreS3.h>
#include <esp_camera.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

namespace {

constexpr uint32_t kSerialBaud = 115200;
constexpr uint32_t kUsbFrameIntervalMs = 180;  // Leave USB bandwidth for live PCM.
constexpr size_t kUsbTxBufferBytes = 64 * 1024;
constexpr size_t kMaxJpegBytes = 60 * 1024;
constexpr uint8_t kJpegQuality = 72;
constexpr uint32_t kAudioSampleRate = 16000;
constexpr size_t kAudioSamplesPerPacket = 320;  // 20 ms @ 16 kHz.
constexpr size_t kAudioRingPackets = 32;
constexpr size_t kAudioQueuePackets = 24;

struct __attribute__((packed)) UsbPacketHeader {
  char magic[4];
  uint32_t payload_bytes;
  uint32_t sequence;
  uint32_t captured_ms;
};

static_assert(sizeof(UsbPacketHeader) == 16, "USB packet header must be 16 bytes");

bool camera_ready = false;
uint32_t last_usb_frame_ms = 0;
uint32_t stats_started_ms = 0;
uint32_t preview_frames = 0;
uint32_t sent_frames = 0;
uint32_t dropped_frames = 0;
uint32_t encode_errors = 0;
uint32_t sequence = 0;
uint32_t audio_sequence = 0;
uint32_t audio_packets = 0;
uint32_t audio_drops = 0;
float preview_fps = 0.0f;
float usb_fps = 0.0f;
float audio_pps = 0.0f;
volatile float audio_level = 0.0f;
int16_t audio_ring[kAudioRingPackets][kAudioSamplesPerPacket] = {};
QueueHandle_t audio_ready_queue = nullptr;
TaskHandle_t audio_capture_task = nullptr;
volatile uint32_t audio_capture_drops = 0;

struct AudioReadyPacket {
  uint8_t ring_index;
  uint32_t captured_ms;
};

void draw_message(const char* title, const char* detail, uint16_t color) {
  CoreS3.Display.fillScreen(TFT_BLACK);
  CoreS3.Display.setTextDatum(middle_center);
  CoreS3.Display.setTextColor(color, TFT_BLACK);
  CoreS3.Display.setTextSize(2);
  CoreS3.Display.drawString(title, CoreS3.Display.width() / 2,
                            CoreS3.Display.height() / 2 - 18);
  CoreS3.Display.setTextSize(1);
  CoreS3.Display.setTextColor(TFT_WHITE, TFT_BLACK);
  CoreS3.Display.drawString(detail, CoreS3.Display.width() / 2,
                            CoreS3.Display.height() / 2 + 18);
}

void draw_status_bar() {
  constexpr int16_t kBarHeight = 24;
  const int16_t y = CoreS3.Display.height() - kBarHeight;
  CoreS3.Display.fillRect(0, y, CoreS3.Display.width(), kBarHeight, TFT_BLACK);
  CoreS3.Display.setTextDatum(middle_left);
  CoreS3.Display.setTextSize(1);
  CoreS3.Display.setTextColor(TFT_GREEN, TFT_BLACK);
  CoreS3.Display.setCursor(5, y + 7);
  CoreS3.Display.printf("VID %.1f  MIC %.0f/s %2.0f%%", usb_fps, audio_pps,
                        audio_level * 100.0f);
  CoreS3.Display.setTextDatum(middle_right);
  CoreS3.Display.setTextColor(dropped_frames ? TFT_YELLOW : TFT_CYAN, TFT_BLACK);
  CoreS3.Display.drawString(dropped_frames ? "USB waiting" : "USB live",
                            CoreS3.Display.width() - 5, y + kBarHeight / 2);
}

bool send_packet_nonblocking(const char magic[4], const uint8_t* payload,
                             size_t payload_bytes, uint32_t packet_sequence,
                             uint32_t captured_ms, size_t reserve_bytes = 0) {
  if (payload == nullptr || payload_bytes == 0 || !Serial) {
    return false;
  }

  const size_t packet_bytes = sizeof(UsbPacketHeader) + payload_bytes;
  if (Serial.availableForWrite() < static_cast<int>(packet_bytes + reserve_bytes)) {
    return false;
  }

  UsbPacketHeader header{{magic[0], magic[1], magic[2], magic[3]},
                         static_cast<uint32_t>(payload_bytes), packet_sequence,
                         captured_ms};
  const size_t header_written =
      Serial.write(reinterpret_cast<const uint8_t*>(&header), sizeof(header));
  const size_t payload_written = Serial.write(payload, payload_bytes);
  return header_written == sizeof(header) && payload_written == payload_bytes;
}

bool send_jpeg_nonblocking(const uint8_t* jpeg, size_t jpeg_bytes,
                           uint32_t captured_ms) {
  if (jpeg_bytes < 100 || jpeg_bytes > kMaxJpegBytes) return false;
  static constexpr char kMagic[4] = {'M', '5', 'C', 'M'};
  // Keep room for several microphone packets so video never starves audio.
  return send_packet_nonblocking(kMagic, jpeg, jpeg_bytes, ++sequence,
                                 captured_ms, 6 * (sizeof(UsbPacketHeader) +
                                                   kAudioSamplesPerPacket * sizeof(int16_t)));
}

void enhance_voice(int16_t* pcm) {
  // Lightweight speech front-end: remove rumble/DC, expand the noise floor,
  // then apply slow AGC and a soft limiter. State is kept across 20 ms frames.
  static float previous_input = 0.0f;
  static float previous_output = 0.0f;
  static float agc_gain = 1.0f;
  static float gate_gain = 1.0f;
  float filtered[kAudioSamplesPerPacket];
  double sum_squares = 0.0;
  for (size_t i = 0; i < kAudioSamplesPerPacket; ++i) {
    const float input = static_cast<float>(pcm[i]);
    const float output = input - previous_input + 0.969f * previous_output;
    previous_input = input;
    previous_output = output;
    filtered[i] = output;
    sum_squares += output * output;
  }
  const float rms = sqrtf(static_cast<float>(sum_squares / kAudioSamplesPerPacket));
  const float desired_gate = rms < 160.0f ? 0.12f
                             : rms < 500.0f ? 0.12f + (rms - 160.0f) / 340.0f * 0.88f
                                            : 1.0f;
  gate_gain += (desired_gate > gate_gain ? 0.30f : 0.08f) *
               (desired_gate - gate_gain);
  const float desired_agc = constrain(2500.0f / fmaxf(rms, 1.0f), 0.60f, 4.0f);
  agc_gain += (desired_agc < agc_gain ? 0.20f : 0.035f) *
              (desired_agc - agc_gain);
  const float gain = gate_gain * agc_gain;
  double enhanced_squares = 0.0;
  for (size_t i = 0; i < kAudioSamplesPerPacket; ++i) {
    float value = filtered[i] * gain;
    const float magnitude = fabsf(value);
    if (magnitude > 18000.0f) {
      value = copysignf(18000.0f + (magnitude - 18000.0f) * 0.25f, value);
    }
    value = constrain(value, -30000.0f, 30000.0f);
    pcm[i] = static_cast<int16_t>(value);
    enhanced_squares += value * value;
  }
  audio_level = sqrtf(static_cast<float>(enhanced_squares /
                                         kAudioSamplesPerPacket)) / 32768.0f;
}

void microphone_capture_loop(void*) {
  size_t write_index = 0;
  size_t submitted = 0;
  for (;;) {
    int16_t* destination = audio_ring[write_index];
    if (!CoreS3.Mic.record(destination, kAudioSamplesPerPacket,
                           kAudioSampleRate, false)) {
      vTaskDelay(pdMS_TO_TICKS(1));
      continue;
    }

    // The Mic class owns two asynchronous request slots. Acceptance of a new
    // request proves the buffer submitted two requests earlier is complete.
    if (submitted >= 2) {
      const size_t completed =
          (write_index + kAudioRingPackets - 2) % kAudioRingPackets;
      enhance_voice(audio_ring[completed]);
      AudioReadyPacket ready{static_cast<uint8_t>(completed), millis()};
      if (xQueueSend(audio_ready_queue, &ready, 0) != pdTRUE) {
        AudioReadyPacket discarded;
        xQueueReceive(audio_ready_queue, &discarded, 0);
        xQueueSend(audio_ready_queue, &ready, 0);
        ++audio_capture_drops;
      }
    }
    ++submitted;
    write_index = (write_index + 1) % kAudioRingPackets;
  }
}

void pump_audio_usb(size_t maximum_packets = 12) {
  if (audio_ready_queue == nullptr) return;
  for (size_t sent = 0; sent < maximum_packets; ++sent) {
    AudioReadyPacket ready;
    if (xQueuePeek(audio_ready_queue, &ready, 0) != pdTRUE) return;
    const int16_t* pcm = audio_ring[ready.ring_index];
    static constexpr char kMagic[4] = {'M', '5', 'A', 'U'};
    const uint32_t next_sequence = audio_sequence + 1;
    if (send_packet_nonblocking(
            kMagic, reinterpret_cast<const uint8_t*>(pcm),
            kAudioSamplesPerPacket * sizeof(int16_t), next_sequence,
            ready.captured_ms)) {
      xQueueReceive(audio_ready_queue, &ready, 0);
      audio_sequence = next_sequence;
      ++audio_packets;
    } else {
      return;
    }
  }
}

void update_statistics() {
  const uint32_t now = millis();
  const uint32_t elapsed = now - stats_started_ms;
  if (elapsed < 1000) return;

  preview_fps = preview_frames * 1000.0f / elapsed;
  usb_fps = sent_frames * 1000.0f / elapsed;
  audio_pps = audio_packets * 1000.0f / elapsed;
  preview_frames = 0;
  sent_frames = 0;
  audio_packets = 0;
  stats_started_ms = now;
}

}  // namespace

void setup() {
  Serial.setTxBufferSize(kUsbTxBufferBytes);
  Serial.setTxTimeoutMs(5);
  Serial.begin(kSerialBaud);

  auto cfg = M5.config();
  cfg.serial_baudrate = 0;  // Serial is a binary JPEG channel; never print text.
  cfg.clear_display = true;
  cfg.output_power = false;
  CoreS3.begin(cfg);

  CoreS3.Display.setRotation(1);
  CoreS3.Display.setBrightness(160);
  draw_message("USB camera starting", "Open http://127.0.0.1:8765/face",
               TFT_CYAN);

  camera_ready = CoreS3.Camera.begin();
  if (!camera_ready) {
    draw_message("Camera init failed", "GC0308 was not detected", TFT_RED);
    return;
  }

  sensor_t* sensor = esp_camera_sensor_get();
  if (sensor != nullptr) {
    sensor->set_framesize(sensor, FRAMESIZE_QVGA);
    sensor->set_pixformat(sensor, PIXFORMAT_RGB565);
  }
  // CoreS3's speaker and PDM microphone share audio resources. This firmware
  // only captures, so keep the speaker off and initialize the mic after the
  // camera has claimed its DMA resources.
  CoreS3.Speaker.end();
  auto mic_cfg = CoreS3.Mic.config();
  mic_cfg.sample_rate = kAudioSampleRate;
  mic_cfg.over_sampling = 2;
  mic_cfg.magnification = 16;
  CoreS3.Mic.config(mic_cfg);
  if (!CoreS3.Mic.begin()) {
    draw_message("Microphone failed", "Camera is ready; mic init failed", TFT_YELLOW);
  } else {
    audio_ready_queue = xQueueCreate(kAudioQueuePackets, sizeof(AudioReadyPacket));
    if (audio_ready_queue == nullptr ||
        xTaskCreatePinnedToCore(microphone_capture_loop, "mic-feed", 4096, nullptr,
                                3, &audio_capture_task, 0) != pdPASS) {
      draw_message("Microphone failed", "Could not start audio task", TFT_YELLOW);
      CoreS3.Mic.end();
    }
  }
  stats_started_ms = millis();
}

void loop() {
  if (!camera_ready) {
    delay(1000);
    return;
  }

  pump_audio_usb();

  if (!CoreS3.Camera.get()) {
    ++dropped_frames;
    delay(5);
    return;
  }

  camera_fb_t* frame = CoreS3.Camera.fb;
  if (frame != nullptr && frame->format == PIXFORMAT_RGB565 &&
      frame->width == 320 && frame->height == 240) {
    CoreS3.Display.pushImage(0, 0, frame->width, frame->height,
                             reinterpret_cast<uint16_t*>(frame->buf));
    ++preview_frames;

    const uint32_t now = millis();
    if (now - last_usb_frame_ms >= kUsbFrameIntervalMs) {
      last_usb_frame_ms = now;
      uint8_t* jpeg = nullptr;
      size_t jpeg_bytes = 0;
      if (frame2jpg(frame, kJpegQuality, &jpeg, &jpeg_bytes) && jpeg != nullptr) {
        if (send_jpeg_nonblocking(jpeg, jpeg_bytes, now)) {
          ++sent_frames;
        } else {
          ++dropped_frames;
        }
        free(jpeg);
      } else {
        ++encode_errors;
      }
    }
  } else {
    ++dropped_frames;
  }

  CoreS3.Camera.free();
  pump_audio_usb();
  update_statistics();
  draw_status_bar();
  delay(1);
}
