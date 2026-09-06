(function () {
  'use strict';
  const P = window.SurfPhysics;

  // Turbulent pressure plus damped bubble oscillations, generated once per impact.
  function crashSamples(sampleRate, event) {
    const duration = P.clamp(1.4 + Math.sqrt(event.height) * 1.1, 1.4, 3.8);
    const samples = new Float32Array(Math.ceil(duration * sampleRate));
    const rng = P.random(event.frontId * 7919 + event.index * 104729);
    const bubbles = Array.from({ length: 22 }, () => {
      const radius = 0.002 + rng() * 0.020;
      return { time: 0.04 + rng() * duration * 0.75,
        frequency: 3.26 / radius, decay: 0.012 + rng() * 0.06, phase: rng() * 6.28 };
    });
    let low = 0, mid = 0;
    const a = 1 - Math.exp(-2 * Math.PI * 180 / sampleRate);
    const b = 1 - Math.exp(-2 * Math.PI * 1800 / sampleRate);
    for (let i = 0; i < samples.length; i++) {
      const t = i / sampleRate, u = t / duration;
      const noise = rng() * 2 - 1;
      low += a * (noise - low);
      mid += b * (noise - mid);
      const envelope = (1 - Math.exp(-t / 0.035)) * Math.exp(-t / (duration * 0.32)) * (1 - u) ** 2;
      let sound = (1.65 * low + 0.72 * mid + 0.26 * noise) * envelope;
      for (const bubble of bubbles) {
        const age = t - bubble.time;
        if (age > 0 && age < bubble.decay * 8) {
          sound += 0.028 * Math.sin(2 * Math.PI * bubble.frequency * age + bubble.phase) *
            Math.exp(-age / bubble.decay) * (1 - u) ** 2;
        }
      }
      samples[i] = sound;
    }
    samples[0] = 0;
    samples[samples.length - 1] = 0;
    return samples;
  }

  class SurfAudio {
    constructor() {
      this.context = null;
      this.voices = new Set();
      this.enabled = false;
      this.muted = false;
      this.volume = 0.55;
      this.started = 0;
      this.lastPaths = null;
      this.peak = 0;
      this.earPeaks = [0, 0];
    }

    async activate() {
      if (!this.context) {
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context) throw new Error('Web Audio is unavailable in this browser.');
        this.context = new Context();
        this.setupOutput();
      }
      this.enabled = true;
      await this.context.resume();
      this.setVolume(this.volume);
    }

    setupOutput() {
      const c = this.context;
      this.master = c.createGain();
      this.master.gain.value = this.volume;
      this.limiter = c.createDynamicsCompressor();
      this.limiter.threshold.value = -12;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.002;
      this.limiter.release.value = 0.12;
      // A compressor alone can overshoot during simultaneous nearby impacts.
      this.safety = c.createWaveShaper();
      this.safety.curve = Float32Array.from({ length: 4097 }, (_, i) =>
        0.95 * Math.tanh((i / 2048 - 1) / 0.95));
      this.safety.oversample = '4x';
      this.splitter = c.createChannelSplitter(2);
      this.analysers = [0, 1].map(side => {
        const analyser = c.createAnalyser();
        analyser.fftSize = 1024;
        this.splitter.connect(analyser, side);
        return analyser;
      });
      this.meter = new Float32Array(1024);
      this.master.connect(this.limiter).connect(this.safety).connect(c.destination);
      this.safety.connect(this.splitter);
    }

    setVolume(value) {
      this.volume = value;
      if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : value, this.context.currentTime, 0.035);
    }

    silence() {
      this.enabled = false;
      for (const voice of this.voices) {
        voice.node.onended = null;
        try { voice.node.stop(); } catch {}
        this.disposeVoice(voice);
      }
      this.voices.clear();
      this.peak = 0;
      this.earPeaks = [0, 0];
      this.lastPaths = null;
      if (this.context) this.context.suspend();
    }

    disposeVoice(voice) {
      voice.node.disconnect(); voice.merger.disconnect();
      for (const e of voice.ears) { e.delay.disconnect(); e.filter.disconnect(); e.gain.disconnect(); }
    }

    emit(event, observer, wind) {
      // One representative point per 12 m of connected crest, with that strip's energy.
      if (!this.enabled || this.context?.state !== 'running' || event.index % 3 !== 1 || this.voices.size >= 36) return;
      this.createVoice(event, observer, wind);
    }

    createVoice(event, observer, wind) {
      const c = this.context;
      const signal = crashSamples(c.sampleRate, event);
      const buffer = c.createBuffer(1, signal.length, c.sampleRate);
      buffer.copyToChannel(signal, 0);
      const node = c.createBufferSource();
      node.buffer = buffer;
      const merger = c.createChannelMerger(2);
      merger.connect(this.master);
      const voice = { node, merger, ears: [], event,
        position: { x: event.x, y: event.y, z: event.z },
        strength: P.clamp(Math.sqrt(event.energy * 3 / 12000), 0.06, 2.5) };
      for (let side = 0; side < 2; side++) {
        const delay = c.createDelay(2);
        const filter = c.createBiquadFilter();
        filter.type = 'lowpass'; filter.Q.value = 0.55;
        const gain = c.createGain();
        node.connect(delay).connect(filter).connect(gain).connect(merger, 0, side);
        voice.ears.push({ delay, filter, gain });
      }
      this.updateVoice(voice, observer, wind, true);
      this.voices.add(voice);
      this.started++;
      // Keep delay lines connected until the last emitted sample reaches the ears.
      node.onended = () => {
        voice.ended = true;
        voice.cleanupAt = c.currentTime + 0.8;
      };
      node.start();
      return voice;
    }

    updateVoice(voice, observer, wind, initial = false) {
      if (!voice.ended) {
        voice.position.z = voice.event.segment.z;
        voice.position.y = Math.max(0.1, voice.event.segment.height * 0.25);
      }
      const paths = P.earPaths(voice.position, observer, wind);
      this.lastPaths = paths;
      paths.forEach((path, i) => {
        const ear = voice.ears[i], now = this.context.currentTime;
        const values = [[ear.delay.delayTime, path.delay], [ear.gain.gain, path.gain * voice.strength],
          [ear.filter.frequency, path.cutoff]];
        for (const [param, value] of values) {
          if (initial) param.setValueAtTime(value, now);
          else param.setTargetAtTime(value, now, 0.018);
        }
      });
    }

    update(observer, wind) {
      if (!this.enabled || !this.context) return;
      for (const voice of this.voices) {
        if (voice.cleanupAt <= this.context.currentTime) {
          this.disposeVoice(voice);
          this.voices.delete(voice);
        } else this.updateVoice(voice, observer, wind);
      }
      this.earPeaks = this.analysers.map(analyser => {
        analyser.getFloatTimeDomainData(this.meter);
        return this.meter.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      });
      this.peak = Math.max(...this.earPeaks);
    }

    diagnostics() {
      return { state: this.context?.state || 'uninitialized', active: this.voices.size,
        started: this.started, peak: this.peak, earPeaks: this.earPeaks,
        paths: this.lastPaths, muted: this.muted };
    }
  }
  window.SurfAudio = SurfAudio;
  window.SurfCrashSamples = crashSamples;
})();
