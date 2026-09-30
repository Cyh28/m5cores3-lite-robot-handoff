import { StateSignals } from "./state_signals.js";

const PACKAGE_VERSION = "0.10.35";
const PACKAGE_ROOT = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${PACKAGE_VERSION}`;
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const $ = id => document.getElementById(id);
const video = $("video");
const deviceImage = $("device-image");
const cameraSource = $("camera-source");
const canvas = $("overlay");
const context = canvas.getContext("2d");
const audioCanvas = $("audio-wave");
const audioDraw = audioCanvas.getContext("2d");

const movements = [
  { id: "smile", label: "嘴角上扬", keys: ["mouthSmileLeft", "mouthSmileRight"], threshold: .36 },
  { id: "browDown", label: "眉部下压", keys: ["browDownLeft", "browDownRight"], threshold: .42 },
  { id: "browUp", label: "眉毛抬起", keys: ["browInnerUp", "browOuterUpLeft", "browOuterUpRight"], threshold: .34 },
  { id: "jawOpen", label: "张嘴", keys: ["jawOpen"], threshold: .35 },
  { id: "eyeBlink", label: "闭眼 / 眨眼", keys: ["eyeBlinkLeft", "eyeBlinkRight"], threshold: .50 },
  { id: "eyeWide", label: "眼睛睁大", keys: ["eyeWideLeft", "eyeWideRight"], threshold: .38 }
];

let landmarker = null;
let stream = null;
let inputMode = "computer";
let devicePollAbort = null;
let deviceObjectUrl = null;
let deviceFrameVersion = 0;
let lastDeviceSequence = null;
let running = false;
let animationId = 0;
let lastInferenceTime = 0;
let lastVideoTime = -1;
let smoothed = {};
let noFaceFrames = 0;
let modelBusy = false;
let modelAbort = null;
let lastModelTime = 0;
let faceVisible = false;
let audioContext = null;
let audioGain = null;
let audioSourceNode = null;
let audioAnalyser = null;
let audioPollAbort = null;
let audioSequence = 0;
let audioNextTime = 0;
let recordingAudio = false;
let recordedPcm = [];
let recordedSamples = 0;
const stateSignals = new StateSignals();
let lastStateRender = 0;

const expressionNames = {
  angry: "生气", anger: "生气", contempt: "轻蔑", disgust: "厌恶",
  fear: "恐惧", happy: "开心", happiness: "开心", neutral: "中性",
  sad: "悲伤", sadness: "悲伤", surprise: "惊讶"
};

function setStatus(message) { $("status").textContent = message; }
function setCameraState(message) { $("camera-state").textContent = message; }
function activeSource() { return inputMode === "cores3" ? deviceImage : video; }
function sourceWidth() { return inputMode === "cores3" ? deviceImage.naturalWidth : video.videoWidth; }
function sourceHeight() { return inputMode === "cores3" ? deviceImage.naturalHeight : video.videoHeight; }

function setAudioStatus(message) { $("audio-status").textContent = message; }

function renderAudioSamples(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  const rms = samples.length ? Math.sqrt(sum / samples.length) / 32768 : 0;
  const percent = Math.min(100, Math.round(rms * 420));
  $("audio-level").style.width = `${percent}%`;
  $("audio-level-value").textContent = `${percent}%`;
  audioDraw.fillStyle = "#102a30";
  audioDraw.fillRect(0, 0, audioCanvas.width, audioCanvas.height);
  audioDraw.strokeStyle = "#53e4bc";
  audioDraw.lineWidth = 2;
  audioDraw.beginPath();
  const middle = audioCanvas.height / 2;
  for (let x = 0; x < audioCanvas.width; x += 1) {
    const index = Math.min(samples.length - 1, Math.floor(x * samples.length / audioCanvas.width));
    const y = middle - (samples[index] || 0) / 32768 * middle * .9;
    if (x === 0) audioDraw.moveTo(x, y); else audioDraw.lineTo(x, y);
  }
  audioDraw.stroke();
}

function resetAudioDisplay(message = "尚未连接") {
  setAudioStatus(message);
  $("audio-level").style.width = "0%";
  $("audio-level-value").textContent = "—";
  renderAudioSamples(new Int16Array(320));
}

async function prepareAudio() {
  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContext({ latencyHint: "playback", sampleRate: 16000 });
    audioGain = audioContext.createGain();
    audioGain.gain.value = Number($("monitor-volume").value);
    audioGain.connect(audioContext.destination);
  }
  await audioContext.resume();
  audioNextTime = audioContext.currentTime + .14;
}

function schedulePcm(bytes, sampleRate, firstSequence, packetCount) {
  const view = new DataView(bytes);
  const samples = new Int16Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true);
  if (firstSequence > audioSequence + 1 || audioNextTime < audioContext.currentTime - .02 ||
      audioNextTime > audioContext.currentTime + .55) {
    audioNextTime = audioContext.currentTime + .14;
  }
  const buffer = audioContext.createBuffer(1, samples.length, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i += 1) channel[i] = samples[i] / 32768;
  const node = audioContext.createBufferSource();
  node.buffer = buffer;
  node.connect(audioGain);
  node.start(Math.max(audioContext.currentTime + .04, audioNextTime));
  audioNextTime = Math.max(audioContext.currentTime + .04, audioNextTime) + buffer.duration;
  audioSequence = firstSequence + packetCount - 1;
  renderAudioSamples(samples.subarray(Math.max(0, samples.length - 320)));
  setAudioStatus(`CoreS3 麦克风监听中 · ${sampleRate / 1000} kHz`);
  if (recordingAudio) {
    recordedPcm.push(samples);
    recordedSamples += samples.length;
    $("record-status").textContent = `录音中 · ${(recordedSamples / sampleRate).toFixed(1)} 秒`;
  }
}

async function pollDeviceAudio(controller) {
  while (running && inputMode === "cores3" && !controller.signal.aborted) {
    try {
      const response = await fetch(`/device-audio.pcm?after=${audioSequence}&t=${Date.now()}`,
        { cache: "no-store", signal: controller.signal });
      if (response.status === 204) {
        await new Promise(resolve => setTimeout(resolve, 25));
        continue;
      }
      if (!response.ok) {
        let detail = "CoreS3 麦克风尚未就绪";
        try { detail = (await response.json()).error || detail; } catch (_) { /* use default */ }
        throw new Error(detail);
      }
      const first = Number(response.headers.get("X-Audio-First-Sequence") || audioSequence + 1);
      const packets = Number(response.headers.get("X-Audio-Packets") || 1);
      const rate = Number(response.headers.get("X-Audio-Sample-Rate") || 16000);
      schedulePcm(await response.arrayBuffer(), rate, first, packets);
    } catch (error) {
      if (error.name === "AbortError") return;
      setAudioStatus("音频暂时中断，正在重试：" + error.message);
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
}

function drawComputerAudio() {
  if (!audioAnalyser) return;
  const samples = new Int16Array(audioAnalyser.fftSize);
  const floats = new Float32Array(audioAnalyser.fftSize);
  audioAnalyser.getFloatTimeDomainData(floats);
  for (let i = 0; i < floats.length; i += 1) samples[i] = floats[i] * 32767;
  renderAudioSamples(samples);
}

function wavBlob(chunks, totalSamples, sampleRate = 16000) {
  const output = new ArrayBuffer(44 + totalSamples * 2);
  const view = new DataView(output);
  const text = (offset, value) => { for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + totalSamples * 2, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, totalSamples * 2, true);
  let offset = 44;
  for (const chunk of chunks) for (const sample of chunk) { view.setInt16(offset, sample, true); offset += 2; }
  return new Blob([output], { type: "audio/wav" });
}

function beginAudioRecording() {
  if (!running || inputMode !== "cores3") return;
  recordedPcm = [];
  recordedSamples = 0;
  recordingAudio = true;
  $("record-audio").disabled = true;
  $("save-audio").disabled = false;
  $("record-status").textContent = "录音中 · 0.0 秒";
}

function finishAudioRecording(download = true) {
  const chunks = recordedPcm;
  const total = recordedSamples;
  recordingAudio = false;
  recordedPcm = [];
  recordedSamples = 0;
  $("save-audio").disabled = true;
  $("record-audio").disabled = !running || inputMode !== "cores3";
  if (download && total) {
    const url = URL.createObjectURL(wavBlob(chunks, total));
    const link = document.createElement("a");
    link.href = url;
    link.download = `cores3-${new Date().toISOString().replaceAll(":", "-")}.wav`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $("record-status").textContent = `已下载 ${(total / 16000).toFixed(1)} 秒 WAV`;
  } else {
    $("record-status").textContent = "未录音";
  }
}

async function fetchDeviceFrame(signal) {
  const response = await fetch(`/device-camera.jpg?t=${Date.now()}`, { cache: "no-store", signal });
  if (!response.ok) {
    let detail = "CoreS3 USB 画面尚未就绪";
    try { detail = (await response.json()).error || detail; } catch (_) { /* use default */ }
    throw new Error(detail);
  }
  const sequence = response.headers.get("X-Frame-Sequence");
  if (sequence && sequence === lastDeviceSequence) return false;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const previous = deviceObjectUrl;
  deviceImage.src = url;
  try {
    await deviceImage.decode();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  deviceObjectUrl = url;
  if (previous) URL.revokeObjectURL(previous);
  lastDeviceSequence = sequence;
  deviceFrameVersion += 1;
  return true;
}

async function pollDeviceFrames(controller) {
  while (running && !controller.signal.aborted) {
    try {
      await fetchDeviceFrame(controller.signal);
    } catch (error) {
      if (error.name === "AbortError") return;
      setStatus("CoreS3 画面暂时中断，正在重试：" + error.message);
      await new Promise(resolve => setTimeout(resolve, 500));
      continue;
    }
    // The USB bridge currently delivers about 5–8 unique frames/s. Polling a
    // little faster than that keeps latency low without issuing dozens of
    // duplicate localhost requests per second.
    await new Promise(resolve => setTimeout(resolve, 120));
  }
}

function renderMetricRows() {
  $("metrics").innerHTML = movements.map(item => `
    <div class="metric-row"><span>${item.label}</span><output id="value-${item.id}">—</output></div>
    <div class="track"><div id="bar-${item.id}"></div></div>
  `).join("");
}

function clearResults(message = "未检测到人脸") {
  $("face-state").textContent = message;
  $("expression").textContent = message === "等待摄像头" ? "尚未开始" : "暂无表情结果";
  $("expression-detail").textContent = message === "等待摄像头" ? "这里显示当前可观察到的面部动作。" : "请正对镜头，确认面部没有被遮挡。";
  $("chips").textContent = "";
  for (const item of movements) {
    $("value-" + item.id).textContent = "—";
    $("bar-" + item.id).style.width = "0%";
  }
  clearStateResults(message === "等待摄像头" ? "开始后观察约 15 秒" : "等待重新检测到人脸");
}

function clearStateResults(message) {
  $("drowsy-label").textContent = message;
  $("drowsy-detail").textContent = "参考持续闭眼和最近 30 秒闭眼占比。";
  $("gaze-label").textContent = message;
  $("gaze-detail").textContent = "参考最近 15 秒的视线与头部变化。";
  $("closure-value").textContent = "—";
  $("blink-value").textContent = "—";
  $("long-close-value").textContent = "—";
  $("timeline").textContent = "";
}

function renderState(summary) {
  if (!summary) return;
  $("closure-value").textContent = `${summary.closedPercent}%`;
  $("blink-value").textContent = `${summary.blinks} 次`;
  $("long-close-value").textContent = `${summary.longestClosureSeconds} 秒`;
  if (summary.observedSeconds < 10) {
    $("drowsy-label").textContent = `观察中 · ${summary.observedSeconds}/10 秒`;
    $("drowsy-detail").textContent = "先积累一小段连续画面，再判断闭眼线索。";
  } else if (summary.drowsyCue) {
    $("drowsy-label").textContent = "出现困倦线索";
    $("drowsy-detail").textContent = `最长连续闭眼 ${summary.longestClosureSeconds} 秒，最近 30 秒闭眼占比约 ${summary.closedPercent}%。也可能是主动闭眼或追踪误差。`;
  } else {
    $("drowsy-label").textContent = "未见明显困倦线索";
    $("drowsy-detail").textContent = "仅根据眼部画面判断；没有线索也不代表一定清醒。";
  }
  if (summary.stillSeconds < 15) {
    $("gaze-label").textContent = `观察中 · ${summary.stillSeconds}/15 秒`;
    $("gaze-detail").textContent = "持续观察视线和头部变化。";
  } else if (summary.gazeStable) {
    $("gaze-label").textContent = "持续凝视 · 请自行确认";
    $("gaze-detail").textContent = "视线、头部和面部动作变化较少；阅读、听讲或思考也会出现这种情况，无法据此确定发呆。";
  } else {
    $("gaze-label").textContent = "视线或头部有变化";
    $("gaze-detail").textContent = "未出现连续 15 秒的低动作片段。";
  }
  // The browser keeps this series in memory only; a new run starts a new timeline.
  const points = summary.samples;
  if (points.length < 2) return;
  const end = points.at(-1).time;
  const start = end - 30_000;
  const xy = key => points.map(point => {
    const x = Math.max(0, Math.min(100, (point.time - start) / 300));
    const y = 30 - Math.max(0, Math.min(1, point[key])) * 26;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  $("timeline").innerHTML = `<polyline class="eye-line" points="${xy("eyeClosed")}"/><polyline class="activity-line" points="${xy("activity")}"/>`;
}

async function loadModel() {
  if (landmarker) return landmarker;
  const { FaceLandmarker, FilesetResolver } = await import(`${PACKAGE_ROOT}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${PACKAGE_ROOT}/wasm`);
  const options = {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
    runningMode: "VIDEO",
    numFaces: 1,
    minFaceDetectionConfidence: .55,
    minFacePresenceConfidence: .55,
    minTrackingConfidence: .55,
    outputFaceBlendshapes: true
  };
  try {
    landmarker = await FaceLandmarker.createFromOptions(fileset, options);
  } catch (gpuError) {
    console.warn("GPU 初始化失败，改用 CPU", gpuError);
    options.baseOptions = { modelAssetPath: MODEL_URL, delegate: "CPU" };
    landmarker = await FaceLandmarker.createFromOptions(fileset, options);
  }
  return landmarker;
}

function drawFace(landmarks) {
  const width = sourceWidth();
  const height = sourceHeight();
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.clearRect(0, 0, width, height);
  if (!landmarks?.length) return;
  const xs = landmarks.map(point => point.x * width);
  const ys = landmarks.map(point => point.y * height);
  const left = Math.max(0, Math.min(...xs) - width * .025);
  const top = Math.max(0, Math.min(...ys) - height * .04);
  const right = Math.min(width, Math.max(...xs) + width * .025);
  const bottom = Math.min(height, Math.max(...ys) + height * .04);
  context.strokeStyle = "#5df0c5";
  context.lineWidth = Math.max(2, width / 400);
  context.strokeRect(left, top, right - left, bottom - top);

  // A few landmarks show tracking without obscuring the person's expression.
  context.fillStyle = "#5df0c5";
  for (const index of [4, 33, 61, 133, 152, 168, 263, 291, 362]) {
    const point = landmarks[index];
    if (!point) continue;
    context.beginPath();
    context.arc(point.x * width, point.y * height, Math.max(2, width / 450), 0, Math.PI * 2);
    context.fill();
  }
}

function renderExpressions(categories, landmarks, now) {
  const scores = Object.fromEntries(categories.map(item => [item.categoryName, item.score]));
  for (const [key, value] of Object.entries(scores)) {
    smoothed[key] = smoothed[key] === undefined ? value : smoothed[key] * .55 + value * .45;
  }
  const summary = stateSignals.add(now, scores, landmarks);
  if (now - lastStateRender >= 250) {
    renderState(summary);
    lastStateRender = now;
  }
  const evaluated = movements.map(item => {
    const score = item.keys.reduce((sum, key) => sum + (smoothed[key] || 0), 0) / item.keys.length;
    $("value-" + item.id).textContent = score.toFixed(2);
    $("bar-" + item.id).style.width = `${Math.round(score * 100)}%`;
    return { ...item, score };
  });
  const active = evaluated.filter(item => item.score >= item.threshold)
    .sort((a, b) => b.score / b.threshold - a.score / a.threshold);
  $("face-state").textContent = "检测到 1 张脸 · 实时追踪中";
  $("expression").textContent = active.length ? active[0].label : "未见明显面部动作";
  $("expression-detail").textContent = active.length
    ? "当前可见的面部动作，随画面实时更新。"
    : "这只表示所列动作未超过当前展示阈值。";
  const chips = $("chips");
  chips.textContent = "";
  active.forEach(item => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = item.label;
    chips.appendChild(chip);
  });
}

function modelName(label) { return expressionNames[String(label).toLowerCase()] || label; }

function clearModelResults(status = "尚未运行") {
  for (const name of ["deepface", "emotiefflib"]) {
    $(name + "-label").textContent = "等待人脸";
    $(name + "-status").textContent = status;
    $(name + "-status").className = "model-status";
    $(name + "-scores").textContent = "";
  }
}

function renderModel(name, result) {
  const label = $(name + "-label");
  const status = $(name + "-status");
  const scores = $(name + "-scores");
  if (!result?.ok) {
    label.textContent = "模型暂不可用";
    status.textContent = result?.error || "没有收到模型结果";
    status.className = "model-error";
    scores.textContent = "";
    return;
  }
  label.textContent = modelName(result.label) + "（模型预测）";
  status.textContent = `本次分析耗时 ${result.elapsed_ms} 毫秒`;
  status.className = "model-status";
  const top = Object.entries(result.scores || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
  scores.textContent = top.map(([key, value]) => `${modelName(key)} ${Math.round(value * 100)}%`).join(" · ");
}

async function analyzeFace(landmarks) {
  modelBusy = true;
  const controller = new AbortController();
  modelAbort = controller;
  for (const name of ["deepface", "emotiefflib"]) {
    if ($(name + "-label").textContent === "等待人脸") {
      $(name + "-label").textContent = "正在分析…";
      $(name + "-status").textContent = "首次运行可能需要下载模型";
    }
  }
  try {
    const source = activeSource();
    const width = sourceWidth();
    const height = sourceHeight();
    const xs = landmarks.map(point => point.x * width);
    const ys = landmarks.map(point => point.y * height);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const side = Math.min(Math.max(maxX - minX, maxY - minY) * 1.28, width, height);
    const sx = Math.max(0, Math.min(width - side, (minX + maxX - side) / 2));
    const sy = Math.max(0, Math.min(height - side, (minY + maxY - side) / 2));
    const crop = document.createElement("canvas");
    crop.width = 224;
    crop.height = 224;
    crop.getContext("2d").drawImage(source, sx, sy, side, side, 0, 0, 224, 224);
    const blob = await new Promise(resolve => crop.toBlob(resolve, "image/jpeg", .84));
    if (!blob) throw new Error("无法生成临时人脸画面");
    const response = await fetch("/analyze-expression", {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: blob,
      signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "本地分析服务失败");
    if (!running || !faceVisible) return;
    renderModel("deepface", data.models?.deepface);
    renderModel("emotiefflib", data.models?.emotiefflib);
  } catch (error) {
    if (error.name !== "AbortError" && running) {
      for (const name of ["deepface", "emotiefflib"]) renderModel(name, { ok: false, error: error.message });
    }
  } finally {
    if (modelAbort === controller) {
      modelBusy = false;
      modelAbort = null;
    }
  }
}

function loop(now) {
  if (!running) return;
  animationId = requestAnimationFrame(loop);
  if (inputMode === "computer") drawComputerAudio();
  const source = activeSource();
  const sourceReady = inputMode === "cores3"
    ? deviceImage.complete && deviceImage.naturalWidth > 0
    : video.readyState >= 2;
  const sourceFrame = inputMode === "cores3" ? deviceFrameVersion : video.currentTime;
  if (now - lastInferenceTime < 90 || !sourceReady || sourceFrame === lastVideoTime) return;
  lastInferenceTime = now;
  lastVideoTime = sourceFrame;
  try {
    const result = landmarker.detectForVideo(source, now);
    const face = result.faceLandmarks?.[0];
    if (face) {
      faceVisible = true;
      noFaceFrames = 0;
      drawFace(face);
      renderExpressions(result.faceBlendshapes?.[0]?.categories || [], face, now);
      if (!modelBusy && now - lastModelTime >= 1500) {
        lastModelTime = now;
        analyzeFace(face);
      }
    } else {
      drawFace(null);
      if (++noFaceFrames >= 3) {
        faceVisible = false;
        smoothed = {};
        stateSignals.reset();
        clearResults();
        if (!modelBusy) clearModelResults("等待重新检测到人脸");
      }
    }
  } catch (error) {
    stop();
    setStatus("分析失败：" + error.message);
  }
}

async function start() {
  $("start").disabled = true;
  inputMode = cameraSource.value;
  setStatus(inputMode === "cores3" ? "正在加载模型并连接 CoreS3 USB 画面……" : "正在加载模型并请求摄像头权限……");
  try {
    await prepareAudio();
    await loadModel();
    if (inputMode === "cores3") {
      video.hidden = true;
      deviceImage.hidden = false;
      lastDeviceSequence = null;
      deviceFrameVersion = 0;
      audioSequence = 0;
      devicePollAbort = new AbortController();
      audioPollAbort = new AbortController();
      await fetchDeviceFrame(devicePollAbort.signal);
    } else {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("请使用新版浏览器并通过 localhost 打开此页面");
      }
      deviceImage.hidden = true;
      video.hidden = false;
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 720 } },
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      });
      video.srcObject = stream;
      await video.play();
      audioAnalyser = audioContext.createAnalyser();
      audioAnalyser.fftSize = 512;
      audioSourceNode = audioContext.createMediaStreamSource(stream);
      audioSourceNode.connect(audioAnalyser);
    }
    running = true;
    lastInferenceTime = 0;
    lastVideoTime = -1;
    smoothed = {};
    stateSignals.reset();
    lastStateRender = 0;
    lastModelTime = 0;
    faceVisible = false;
    $("stage").classList.add("live");
    $("stop").disabled = false;
    cameraSource.disabled = true;
    setCameraState(inputMode === "cores3" ? "CoreS3 USB 实时分析中" : "电脑摄像头实时分析中");
    setStatus(inputMode === "cores3" ? "CoreS3 画面已连接，正实时追踪面部。" : "摄像头已打开，正实时追踪面部。");
    if (inputMode === "cores3") {
      setAudioStatus("正在连接 CoreS3 麦克风……");
      $("record-audio").disabled = false;
      void pollDeviceFrames(devicePollAbort);
      void pollDeviceAudio(audioPollAbort);
    } else {
      setAudioStatus("电脑麦克风电平监测中（不回放）");
    }
    animationId = requestAnimationFrame(loop);
  } catch (error) {
    stop();
    setStatus("启动失败：" + error.message + "。请检查网络和摄像头权限。");
  }
}

function stop() {
  if (recordingAudio) finishAudioRecording(true);
  running = false;
  faceVisible = false;
  modelAbort?.abort();
  modelAbort = null;
  modelBusy = false;
  stateSignals.reset();
  cancelAnimationFrame(animationId);
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  video.srcObject = null;
  audioSourceNode?.disconnect();
  audioSourceNode = null;
  audioAnalyser = null;
  devicePollAbort?.abort();
  devicePollAbort = null;
  audioPollAbort?.abort();
  audioPollAbort = null;
  audioContext?.close();
  audioContext = null;
  audioGain = null;
  if (deviceObjectUrl) URL.revokeObjectURL(deviceObjectUrl);
  deviceObjectUrl = null;
  deviceImage.removeAttribute("src");
  cameraSource.disabled = false;
  context.clearRect(0, 0, canvas.width, canvas.height);
  $("stage").classList.remove("live");
  $("start").disabled = false;
  $("stop").disabled = true;
  $("record-audio").disabled = true;
  $("save-audio").disabled = true;
  setCameraState("摄像头关闭");
  clearResults("等待摄像头");
  clearModelResults();
  resetAudioDisplay();
  setStatus("已停止。画面未保存。可随时重新开始。");
}

try {
  renderMetricRows();
  clearResults("等待摄像头");
  clearModelResults();
  $("start").addEventListener("click", start);
  $("stop").addEventListener("click", stop);
  $("record-audio").addEventListener("click", beginAudioRecording);
  $("save-audio").addEventListener("click", () => finishAudioRecording(true));
  $("monitor-volume").addEventListener("input", event => {
    if (audioGain) audioGain.gain.value = Number(event.target.value);
  });
  window.addEventListener("pagehide", stop);
  resetAudioDisplay();
  document.documentElement.dataset.faceReady = "yes";
} catch (error) {
  setStatus("页面初始化失败：" + error.message);
  console.error(error);
}
