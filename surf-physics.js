(function (root) {
  'use strict';
  const G = 9.81;
  const RHO = 1025;
  const DX = 4;
  const SEGMENTS = 41;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const mix = (a, b, t) => a + (b - a) * t;

  function random(seed) {
    let s = seed >>> 0;
    return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; };
  }

  function bedHeight(x, z) {
    const slope = z > 0 ? 0.085 : 0.065;
    const bar = z < 0 ? 0.30 * Math.exp(-(((z + 22) / 11) ** 2)) * Math.cos(x * 0.066) : 0;
    return z * slope + bar;
  }

  function terrainHeight(x, z) {
    const dune = z > 22 ? 0.7 * Math.sin(x * 0.055) ** 2 * Math.min(1, (z - 22) / 12) : 0;
    return bedHeight(x, z) + dune;
  }

  function dispersion(period, depth) {
    const omega = 2 * Math.PI / period;
    const h = Math.max(0.06, depth);
    let k = Math.max(omega * omega / G, omega / Math.sqrt(G * h));
    for (let i = 0; i < 7; i++) {
      const kh = k * h, th = Math.tanh(kh);
      k -= (G * k * th - omega * omega) / (G * (th + kh * (1 - th * th)));
    }
    const kh2 = 2 * k * h;
    const c = omega / k;
    const cg = c * 0.5 * (1 + (kh2 < 40 ? kh2 / Math.sinh(kh2) : 0));
    return { k, c, cg, wavelength: 2 * Math.PI / k };
  }

  // Fetch-limited SMB growth, using wind at 10 m above the water.
  function windSea(wind, fetchKm) {
    if (wind < 0.15) return { height: 0, period: 2 };
    const u = Math.max(0.1, wind);
    const fetch = G * fetchKm * 1000 / (u * u);
    return {
      height: 0.283 * u * u / G * Math.tanh(0.0125 * fetch ** 0.42),
      period: Math.max(1.6, 7.54 * u / G * Math.tanh(0.077 * fetch ** 0.25)),
    };
  }

  function breakingHeight(period, depth) {
    const d = dispersion(period, depth);
    return Math.min(0.78 * depth, 0.142 * d.wavelength * Math.tanh(d.k * depth));
  }

  // Direct paths through moving air; yaw zero looks toward negative z.
  function earPaths(source, observer, wind = 0) {
    const right = { x: Math.cos(observer.yaw), z: Math.sin(observer.yaw) };
    const result = [];
    for (const side of [-1, 1]) {
      const ear = { x: observer.x + right.x * side * 0.0875,
        y: observer.y, z: observer.z + right.z * side * 0.0875 };
      const dx = source.x - ear.x, dy = source.y - ear.y, dz = source.z - ear.z;
      const distance = Math.hypot(dx, dy, dz);
      const towardEarZ = -dz / Math.max(distance, 0.001);
      const soundSpeed = 343 + wind * towardEarZ;
      const facingEar = side * (dx * right.x + dz * right.z) / Math.max(distance, 0.001);
      const shadow = clamp(-facingEar, 0, 1);
      result.push({ distance, delay: distance / soundSpeed,
        gain: 1 / Math.max(1, distance),
        cutoff: 18000 / (1 + distance * 0.016 + 4 * shadow) });
    }
    return result;
  }

  class Ocean {
    constructor(seed = 48231) {
      this.random = random(seed);
      this.wind = 12;
      this.fetchKm = 35;
      this.time = 0;
      this.fronts = [];
      this.events = [];
      this.breakCount = 0;
      this.nextFront = 0;
      this.serial = 0;
      this.wetReach = new Float32Array(SEGMENTS);
      this.sea = windSea(this.wind, this.fetchKm);
      // Begin with an established sea under the selected wind.
      for (let i = 0; i < 2400; i++) this.step(1 / 60);
      this.events.length = 0;
      this.breakCount = 0;
    }

    spawn() {
      if (this.sea.height < 0.035 || this.fronts.length >= 18) return;
      const r = this.random;
      const period = this.sea.period * (0.82 + r() * 0.36);
      const height = this.sea.height * (0.65 + r() * 0.70);
      const phase = r() * Math.PI * 2;
      const front = { id: ++this.serial, period, height, phase, segments: [], age: 0 };
      const offshore = dispersion(period, 8);
      for (let i = 0; i < SEGMENTS; i++) {
        const x = (i - (SEGMENTS - 1) / 2) * DX;
        const crestHeight = height * (0.76 + 0.20 * Math.cos(x * 0.085 + phase) +
          0.18 * Math.sin(x * 0.27 - phase));
        front.segments.push({ x, z: -125 + 1.8 * Math.sin(x * 0.043 + phase),
          height: crestHeight,
          baseHeight: crestHeight,
          cg0: offshore.cg, c: offshore.c, width: offshore.wavelength * 0.24,
          breaking: false, breakAge: 0, triggerAt: Infinity, cause: '',
          foam: 0, energy: 0, runup: null, eventId: null });
      }
      this.fronts.push(front);
    }

    startBreak(front, segment, index, cause) {
      if (segment.breaking) return;
      segment.breaking = true;
      segment.cause = cause;
      segment.energy = RHO * G * segment.height * segment.height / 8 * DX * segment.width;
      segment.impactHeight = segment.height;
      segment.breakAge = 0;
      segment.eventId = `${front.id}:${index}`;
      this.breakCount++;
      this.events.push({ id: segment.eventId, frontId: front.id, index,
        x: segment.x, y: Math.max(0.12, segment.height * 0.30), z: segment.z,
        energy: segment.energy, height: segment.height, time: this.time, cause, segment });
      // Collapse travels into adjacent sections at the shallow-water celerity.
      const travelTime = DX / Math.sqrt(G * Math.max(0.2, -bedHeight(segment.x, segment.z)));
      for (const j of [index - 1, index + 1]) {
        const neighbor = front.segments[j];
        if (neighbor && !neighbor.breaking) {
          neighbor.triggerAt = Math.min(neighbor.triggerAt, this.time + travelTime);
        }
      }
    }

    step(dt) {
      dt = Math.min(dt, 1 / 30);
      this.time += dt;
      this.sea = windSea(this.wind, this.fetchKm);
      if (this.time >= this.nextFront) {
        this.spawn();
        this.nextFront = this.time + this.sea.period * (0.90 + this.random() * 0.20);
      }
      for (let i = 0; i < SEGMENTS; i++) this.wetReach[i] *= Math.exp(-dt / 45);
      for (const front of this.fronts) {
        front.age += dt;
        const oldZ = front.segments.map(s => s.z);
        for (let i = 0; i < SEGMENTS; i++) {
          const s = front.segments[i];
          const h = Math.max(0.07, -bedHeight(s.x, s.z));
          if (s.z < 0) {
            const d = dispersion(front.period, h);
            s.c = d.c;
            s.width = Math.max(0.9, d.wavelength * 0.22);
            const left = oldZ[Math.max(0, i - 1)], right = oldZ[Math.min(SEGMENTS - 1, i + 1)];
            // Along-crest coupling prevents independent strips and bends fronts over the bar.
            s.z += (d.c + 0.30 * (left + right - 2 * oldZ[i])) * dt;
            if (!s.breaking) {
              const target = s.baseHeight * Math.sqrt(s.cg0 / Math.max(0.3, d.cg));
              const windGrowth = 1 + 0.025 * Math.max(0, this.wind / d.c - 1);
              s.height += (target * windGrowth - s.height) * Math.min(1, dt * 3);
              if (s.height >= breakingHeight(front.period, h)) {
                this.startBreak(front, s, i, 'depth');
              } else if (this.time >= s.triggerAt && s.height > 0.45 * breakingHeight(front.period, h)) {
                this.startBreak(front, s, i, 'neighbor');
              }
            }
          }
          if (s.breaking) {
            s.breakAge += dt;
            s.foam = Math.min(1, s.breakAge * 4) * Math.exp(-s.breakAge / 10);
            // Dissipated energy feeds the bore; its height decreases toward the beach.
            s.height *= Math.exp(-dt * (0.12 + 0.15 / Math.sqrt(h)));
          }
          if (s.z >= -0.15 && !s.runup) {
            const v = Math.sqrt(G * Math.max(0.12, s.height)) * 1.65;
            s.runup = { z: 0, velocity: v, volume: Math.max(0.12, s.height) * s.width, age: 0 };
            s.z = 0;
          }
          if (s.runup) {
            const run = s.runup;
            run.age += dt;
            // Downslope gravity reverses uprush; bed friction removes kinetic energy.
            run.velocity += (-G * 0.085 - 0.10 * run.velocity * Math.abs(run.velocity)) * dt;
            run.z += run.velocity * dt;
            this.wetReach[i] = Math.max(this.wetReach[i], run.z);
            s.foam *= Math.exp(-dt * 0.18);
            if (run.z < -3) run.done = true;
          }
        }
      }
      this.fronts = this.fronts.filter(f => f.age < 90 && !f.segments.every(s => s.runup?.done));
      // Event history is bounded even if nobody consumes it while audio is inactive.
      if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
    }

    takeEvents() { return this.events.splice(0); }

    stats() {
      const segments = this.fronts.flatMap(f => f.segments);
      return { time: this.time, height: this.sea.height, period: this.sea.period,
        fronts: this.fronts.length, breaking: segments.filter(s => s.breaking && s.breakAge < 2).length,
        swash: segments.filter(s => s.runup && !s.runup.done).length, breaks: this.breakCount };
    }
  }

  const api = { G, RHO, DX, SEGMENTS, clamp, mix, random, bedHeight, terrainHeight, dispersion, windSea,
    breakingHeight, earPaths, Ocean };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SurfPhysics = api;
})(typeof window !== 'undefined' ? window : globalThis);
