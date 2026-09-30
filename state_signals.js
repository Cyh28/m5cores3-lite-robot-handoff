// Observable webcam cues. These rules are exploratory and do not diagnose a mental state.
const WINDOW_MS = 30_000;
const STILL_MS = 15_000;

const mean = values => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
const span = values => values.length ? Math.max(...values) - Math.min(...values) : 0;

export class StateSignals {
  constructor() { this.reset(); }

  reset() { this.samples = []; }

  add(time, scores, landmarks) {
    const score = key => scores[key] || 0;
    const eyeClosed = (score("eyeBlinkLeft") + score("eyeBlinkRight")) / 2;
    const gazeX = (score("eyeLookInLeft") - score("eyeLookOutLeft")
      + score("eyeLookOutRight") - score("eyeLookInRight")) / 2;
    const gazeY = (score("eyeLookUpLeft") + score("eyeLookUpRight")
      - score("eyeLookDownLeft") - score("eyeLookDownRight")) / 2;
    const eyeA = landmarks[33], eyeB = landmarks[263], nose = landmarks[4];
    const eyeWidth = eyeA && eyeB ? Math.abs(eyeB.x - eyeA.x) : 0;
    const headX = nose && eyeWidth > .01 ? (nose.x - (eyeA.x + eyeB.x) / 2) / eyeWidth : 0;
    const activity = mean([
      score("mouthSmileLeft"), score("mouthSmileRight"), score("jawOpen"),
      score("browDownLeft"), score("browDownRight"), score("browInnerUp")
    ]);
    this.samples.push({ time, eyeClosed, gazeX, gazeY, headX, activity });
    this.samples = this.samples.filter(sample => sample.time >= time - WINDOW_MS - 500);
    return this.summary();
  }

  summary() {
    const samples = this.samples;
    if (!samples.length) return null;
    const now = samples.at(-1).time;
    const observedSeconds = (now - samples[0].time) / 1000;
    let closedMs = 0;
    let episodeMs = 0;
    let longestMs = 0;
    let longClosures = 0;
    let blinks = 0;
    for (let index = 1; index < samples.length; index++) {
      const previous = samples[index - 1];
      const current = samples[index];
      // A delayed tab or dropped tracking frame is missing data, not closed eyes.
      const delta = Math.min(current.time - previous.time, 250);
      if (delta <= 0) continue;
      if (previous.eyeClosed >= .65) {
        episodeMs += delta;
        closedMs += delta;
        longestMs = Math.max(longestMs, episodeMs);
      } else if (episodeMs) {
        if (episodeMs >= 500) longClosures++;
        else if (episodeMs >= 80) blinks++;
        episodeMs = 0;
      }
    }
    if (episodeMs >= 500) longClosures++;
    const closedPercent = observedSeconds > 0 ? Math.round(100 * closedMs / (observedSeconds * 1000)) : 0;
    const recent = samples.filter(sample => sample.time >= now - STILL_MS);
    const stillSeconds = recent.length ? (now - recent[0].time) / 1000 : 0;
    const gazeStable = stillSeconds >= 14.5 && recent.length >= 50
      && span(recent.map(s => s.gazeX)) < .18
      && span(recent.map(s => s.gazeY)) < .18
      && span(recent.map(s => s.headX)) < .12
      && mean(recent.map(s => s.activity)) < .25;
    const drowsyCue = observedSeconds >= 10 &&
      (longestMs >= 1500 || (closedPercent >= 20 && longClosures >= 2));
    return {
      observedSeconds: Math.round(observedSeconds),
      closedPercent: Math.min(100, closedPercent),
      longestClosureSeconds: +(longestMs / 1000).toFixed(1),
      longClosures,
      blinks,
      drowsyCue,
      gazeStable,
      stillSeconds: Math.round(stillSeconds),
      samples: samples.map(s => ({ time: s.time, eyeClosed: s.eyeClosed, activity: s.activity }))
    };
  }
}
