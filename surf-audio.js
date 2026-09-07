(function () {
  'use strict';
  const P = window.SurfPhysics;

  // Broadband turbulent pressure and low bubble-cloud modes, with a trailing wash.
  function crashSamples(sampleRate, event) {
    const wash = event.kind === 'wash';
    const duration = wash ? 8 : P.clamp(3.6 + Math.sqrt(event.height) * 1.8, 4, 7);
    const samples = new Float32Array(Math.ceil(duration * sampleRate));
    const rng = P.random(event.frontId * 7919 + event.index * 104729 + (wash ? 173 : 0));
    const clouds = Array.from({ length: 3 }, (_, index) => {
      const frequency = (65 + rng() * 85 + index * 85) / Math.sqrt(0.6 + event.height);
      const r = Math.exp(-Math.PI * (45 + rng() * 80) / sampleRate);
      return { a: 2 * r * Math.cos(2 * Math.PI * frequency / sampleRate), b: r * r,
        drive: 2 * (1 - r) * Math.sin(2 * Math.PI * frequency / sampleRate), y1: 0, y2: 0 };
    });
    let low = 0, mid = 0, air = 0, pink0 = 0, pink1 = 0, pink2 = 0;
    let flutter = 0, nextFlutter = 0;
    const a = 1 - Math.exp(-2 * Math.PI * 95 / sampleRate);
    const b = 1 - Math.exp(-2 * Math.PI * 1100 / sampleRate);
    const c = 1 - Math.exp(-2 * Math.PI * 6200 / sampleRate);
    const pinkRates = [18, 160, 1600].map(f => Math.exp(-2 * Math.PI * f / sampleRate));
    for (let i = 0; i < samples.length; i++) {
      const t = i / sampleRate, u = t / duration;
      const noise = rng() * 2 - 1;
      low += a * (noise - low);
      mid += b * (noise - mid);
      air += c * (noise - air);
      pink0 = pinkRates[0] * pink0 + (1 - pinkRates[0]) * noise;
      pink1 = pinkRates[1] * pink1 + (1 - pinkRates[1]) * noise;
      pink2 = pinkRates[2] * pink2 + (1 - pinkRates[2]) * noise;
      if (i % Math.floor(sampleRate * 0.06) === 0) nextFlutter = rng() * 2 - 1;
      flutter += (nextFlutter - flutter) * 25 / sampleRate;
      const attack = 1 - Math.exp(-t / (wash ? 0.35 : 0.11));
      const envelope = attack * Math.exp(-t / (duration * 0.65)) * (1 - u) ** 1.3;
      let cloud = 0;
      for (const mode of clouds) {
        const y = mode.a * mode.y1 - mode.b * mode.y2 + mode.drive * noise;
        mode.y2 = mode.y1; mode.y1 = y; cloud += y;
      }
      const roar = 1.7 * low + 2.6 * pink0 + 1.1 * pink1 + 0.40 * cloud;
      const fizz = (air - mid) * (wash ? 0.60 : 0.36) + 0.35 * pink2;
      const sound = ((wash ? 0.32 : 0.78) * roar + 0.55 * mid + fizz) *
        envelope * (0.84 + 0.16 * flutter);
      samples[i] = Math.tanh(sound * 1.7) * 0.8;
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
      clearTimeout(this.pauseTimer);
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
      clearTimeout(this.pauseTimer);
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

    pause() {
      this.enabled = false;
      this.peak = 0; this.earPeaks = [0, 0]; this.lastPaths = null;
      if (!this.context) return;
      const now = this.context.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(0, now, 0.007);
      // Preserve each source cursor and delay line, then resume the same sound.
      this.pauseTimer = setTimeout(() => { if (!this.enabled) this.context.suspend(); }, 35);
    }

    disposeVoice(voice) {
      voice.node.disconnect(); voice.merger.disconnect();
      for (const e of voice.ears) { e.delay.disconnect(); e.filter.disconnect(); e.gain.disconnect(); }
    }

    emit(event, observer, wind) {
      // One representative point per 12 m of connected crest, with that strip's energy.
      if (!this.enabled || this.context?.state !== 'running' || event.index % 3 !== 1 || this.voices.size >= 48) return;
      if (event.kind === 'wash' && [...this.voices].some(v => !v.ended && v.event.kind === 'wash' && v.event.index === event.index)) return;
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
        strength: P.clamp(Math.sqrt(event.energy * 3 / 12000), 0.06, 2.5),
        startedAt: c.currentTime, duration: buffer.duration, activity: 1 };
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
      const paths = P.earPaths(voice.position, observer, wind);
      voice.paths = paths;
      paths.forEach((path, i) => {
        const ear = voice.ears[i], now = this.context.currentTime;
        const values = [[ear.delay.delayTime, path.delay], [ear.gain.gain, path.gain * voice.strength * voice.activity],
          [ear.filter.frequency, path.cutoff]];
        for (const [param, value] of values) {
          if (initial) param.setValueAtTime(value, now);
          else param.setTargetAtTime(value, now, 0.018);
        }
      });
    }

    update(observer, wind, swash) {
      if (!this.enabled || !this.context) return;
      for (const voice of this.voices) {
        if (voice.cleanupAt <= this.context.currentTime) {
          this.disposeVoice(voice);
          this.voices.delete(voice);
        } else {
          if (swash && voice.event.kind === 'wash') {
            let weight = 0, zSum = 0, ySum = 0;
            for (let z = 10; z < swash.nz; z++) {
              const k = voice.event.index * swash.nz + z;
              const h = swash.h[k], speed = Math.abs(swash.qz[k]) / Math.max(0.01, h);
              const power = h * speed ** 3 * (0.2 + swash.foam[k]);
              weight += power; zSum += power * (swash.zMin + z * swash.dz);
              ySum += power * (swash.bed[k] + h + 0.04);
            }
            voice.activity = P.clamp(Math.sqrt(weight) * 0.55, 0, 1.6);
            if (weight > 0.001) {
              voice.position.z = P.mix(voice.position.z, zSum / weight, 0.08);
              voice.position.y = P.mix(voice.position.y, ySum / weight, 0.08);
            }
          }
          this.updateVoice(voice, observer, wind);
        }
      }
      this.earPeaks = this.analysers.map(analyser => {
        analyser.getFloatTimeDomainData(this.meter);
        return this.meter.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      });
      this.peak = Math.max(...this.earPeaks);
      this.lastPaths = this.audibleSources()[0]?.paths || null;
    }

    audibleSources() {
      if (!this.context || !this.enabled || this.muted) return [];
      return [...this.voices].map(v => {
        const age = this.context.currentTime - v.startedAt;
        const envelope = (1 - Math.exp(-age / 0.15)) * Math.exp(-age / (v.duration * 0.65)) * Math.max(0, 1 - age / v.duration) ** 1.3;
        return { ...v.position, kind: v.event.kind || 'break', paths: v.paths,
          score: v.strength * v.activity * (v.paths?.[0].gain || 0) * envelope };
      }).filter(v => v.score > 0.001).sort((a, b) => b.score - a.score).slice(0, 3);
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
