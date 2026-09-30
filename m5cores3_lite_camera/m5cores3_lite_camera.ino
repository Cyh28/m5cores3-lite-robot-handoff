#include <M5CoreS3.h>
#include <esp_camera.h>

namespace {

constexpr uint32_t kSerialBaud = 115200;
constexpr uint32_t kStatsIntervalMs = 1000;

uint32_t stats_started_ms = 0;
uint32_t frames_in_interval = 0;
uint32_t total_frames = 0;
uint32_t capture_errors = 0;
float frames_per_second = 0.0f;
bool camera_ready = false;

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
  constexpr int16_t kBarHeight = 22;
  const int16_t y = CoreS3.Display.height() - kBarHeight;

  CoreS3.Display.fillRect(0, y, CoreS3.Display.width(), kBarHeight,
                          TFT_BLACK);
  CoreS3.Display.setTextDatum(middle_left);
  CoreS3.Display.setTextSize(1);
  CoreS3.Display.setTextColor(TFT_GREEN, TFT_BLACK);
  CoreS3.Display.setCursor(6, y + 6);
  CoreS3.Display.printf("LIVE  %.1f FPS", frames_per_second);

  CoreS3.Display.setTextDatum(middle_right);
  CoreS3.Display.setTextColor(TFT_WHITE, TFT_BLACK);
  CoreS3.Display.drawString("GC0308 320x240", CoreS3.Display.width() - 6,
                            y + kBarHeight / 2);
}

void update_statistics() {
  ++frames_in_interval;
  ++total_frames;

  const uint32_t now = millis();
  const uint32_t elapsed = now - stats_started_ms;
  if (elapsed < kStatsIntervalMs) {
    return;
  }

  frames_per_second = frames_in_interval * 1000.0f / elapsed;
  Serial.printf("CAMERA status=ok fps=%.1f frames=%lu errors=%lu heap=%lu\n",
                frames_per_second,
                static_cast<unsigned long>(total_frames),
                static_cast<unsigned long>(capture_errors),
                static_cast<unsigned long>(ESP.getFreeHeap()));
  stats_started_ms = now;
  frames_in_interval = 0;
}

}  // namespace

void setup() {
  Serial.begin(kSerialBaud);
  delay(250);

  auto cfg = M5.config();
  cfg.serial_baudrate = kSerialBaud;
  cfg.clear_display = true;
  cfg.output_power = false;
  CoreS3.begin(cfg);

  CoreS3.Display.setRotation(1);
  CoreS3.Display.setBrightness(160);
  draw_message("Starting camera...", "GC0308 / QVGA / RGB565", TFT_CYAN);

  camera_ready = CoreS3.Camera.begin();
  if (!camera_ready) {
    Serial.println("CAMERA status=error reason=init_failed");
    draw_message("Camera init failed", "Check that this is CoreS3-Lite",
                 TFT_RED);
    return;
  }

  sensor_t* sensor = esp_camera_sensor_get();
  if (sensor != nullptr) {
    sensor->set_framesize(sensor, FRAMESIZE_QVGA);
    sensor->set_pixformat(sensor, PIXFORMAT_RGB565);
  }

  Serial.printf("CAMERA status=ready display=%ldx%ld psram=%lu\n",
                static_cast<long>(CoreS3.Display.width()),
                static_cast<long>(CoreS3.Display.height()),
                static_cast<unsigned long>(ESP.getPsramSize()));
  stats_started_ms = millis();
}

void loop() {
  if (!camera_ready) {
    delay(1000);
    return;
  }

  if (!CoreS3.Camera.get()) {
    ++capture_errors;
    Serial.printf("CAMERA status=warning reason=frame_failed errors=%lu\n",
                  static_cast<unsigned long>(capture_errors));
    delay(10);
    return;
  }

  camera_fb_t* frame = CoreS3.Camera.fb;
  if (frame != nullptr && frame->format == PIXFORMAT_RGB565 &&
      frame->width == 320 && frame->height == 240) {
    CoreS3.Display.pushImage(0, 0, frame->width, frame->height,
                             reinterpret_cast<uint16_t*>(frame->buf));
    update_statistics();
    draw_status_bar();
  } else {
    ++capture_errors;
    Serial.printf(
        "CAMERA status=warning reason=unexpected_frame width=%lu height=%lu "
        "format=%d errors=%lu\n",
        frame == nullptr ? 0UL : static_cast<unsigned long>(frame->width),
        frame == nullptr ? 0UL : static_cast<unsigned long>(frame->height),
        frame == nullptr ? -1 : static_cast<int>(frame->format),
        static_cast<unsigned long>(capture_errors));
  }

  CoreS3.Camera.free();
  delay(1);
}
