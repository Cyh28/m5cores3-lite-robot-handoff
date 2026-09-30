#include <M5Unified.h>

namespace {

uint32_t last_refresh_ms = 0;
uint16_t background_color = TFT_NAVY;

void draw_static_ui() {
  M5.Display.fillScreen(background_color);
  M5.Display.setTextColor(TFT_WHITE, background_color);
  M5.Display.setTextSize(2);
  M5.Display.setCursor(12, 12);
  M5.Display.println("M5CoreS3 Lite self-test");
  M5.Display.setTextSize(1);
  M5.Display.println("Touch screen to change color");
  M5.Display.drawFastHLine(8, 54, M5.Display.width() - 16, TFT_CYAN);
}

void print_serial_report() {
  Serial.printf(
      "SELFTEST board=%d cpu_mhz=%lu flash=%lu psram=%lu free_heap=%lu "
      "display=%ldx%ld touch=%s imu=%s battery_mv=%ld battery_pct=%ld\n",
      static_cast<int>(M5.getBoard()),
      static_cast<unsigned long>(ESP.getCpuFreqMHz()),
      static_cast<unsigned long>(ESP.getFlashChipSize()),
      static_cast<unsigned long>(ESP.getPsramSize()),
      static_cast<unsigned long>(ESP.getFreeHeap()),
      static_cast<long>(M5.Display.width()),
      static_cast<long>(M5.Display.height()),
      M5.Touch.isEnabled() ? "ok" : "missing",
      M5.Imu.isEnabled() ? "ok" : "missing",
      static_cast<long>(M5.Power.getBatteryVoltage()),
      static_cast<long>(M5.Power.getBatteryLevel()));
}

void draw_live_report() {
  const int16_t y = 66;
  M5.Display.fillRect(0, y, M5.Display.width(), M5.Display.height() - y,
                      background_color);
  M5.Display.setCursor(12, y);
  M5.Display.setTextColor(TFT_WHITE, background_color);
  M5.Display.setTextSize(2);

  M5.Display.printf("CPU: %lu MHz\n",
                    static_cast<unsigned long>(ESP.getCpuFreqMHz()));
  M5.Display.printf("Flash: %lu MB\n",
                    static_cast<unsigned long>(ESP.getFlashChipSize() / 1048576U));
  M5.Display.printf("PSRAM: %lu MB\n",
                    static_cast<unsigned long>(ESP.getPsramSize() / 1048576U));
  M5.Display.printf("Free heap: %lu KB\n",
                    static_cast<unsigned long>(ESP.getFreeHeap() / 1024U));
  M5.Display.printf("Touch: %s\n", M5.Touch.isEnabled() ? "PASS" : "N/A");
  M5.Display.printf("IMU: %s\n", M5.Imu.isEnabled() ? "PASS" : "N/A");

  if (M5.Imu.isEnabled()) {
    float ax = 0.0f;
    float ay = 0.0f;
    float az = 0.0f;
    M5.Imu.getAccel(&ax, &ay, &az);
    M5.Display.printf("Accel: %.2f %.2f %.2f\n", ax, ay, az);
  }

  M5.Display.printf("Battery: %ld%%  %ldmV\n",
                    static_cast<long>(M5.Power.getBatteryLevel()),
                    static_cast<long>(M5.Power.getBatteryVoltage()));
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(250);

  auto cfg = M5.config();
  cfg.serial_baudrate = 115200;
  cfg.clear_display = true;
  cfg.output_power = false;
  M5.begin(cfg);

  M5.Display.setRotation(1);
  M5.Display.setBrightness(128);
  draw_static_ui();
  draw_live_report();
  print_serial_report();
}

void loop() {
  M5.update();

  const auto touch = M5.Touch.getDetail();
  if (touch.wasClicked()) {
    static const uint16_t colors[] = {TFT_NAVY, TFT_DARKGREEN, TFT_MAROON,
                                      TFT_DARKGREY, TFT_BLACK};
    static size_t color_index = 0;
    color_index = (color_index + 1) % (sizeof(colors) / sizeof(colors[0]));
    background_color = colors[color_index];
    draw_static_ui();
    draw_live_report();
    Serial.printf("TOUCH x=%d y=%d\n", touch.x, touch.y);
  }

  const uint32_t now = millis();
  if (now - last_refresh_ms >= 1000) {
    last_refresh_ms = now;
    draw_live_report();
    print_serial_report();
  }

  delay(10);
}
