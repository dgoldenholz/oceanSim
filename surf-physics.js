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
    const shoreRelief = (0.035 * Math.sin(x * 0.27) + 0.025 * Math.sin(x * 0.73 + z * 0.8)) * Math.exp(-z * z / 32);
    return z * slope + bar + shoreRelief;
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
      const air = typeof wind === 'number' ? { x: 0, z: wind } : wind;
      const soundSpeed = 343 - (air.x * dx + air.z * dz) / Math.max(distance, 0.001);
      const facingEar = side * (dx * right.x + dz * right.z) / Math.max(distance, 0.001);
      const shadow = clamp(-facingEar, 0, 1);
      result.push({ distance, delay: distance / soundSpeed,
        gain: 1 / Math.max(1, distance),
        cutoff: 18000 / (1 + distance * 0.016 + 4 * shadow) });
    }
    return result;
  }

  class GustWind {
    constructor(seed) {
      this.random = random(seed);
      this.speed = 12; this.angle = 0; this.factor = 1;
      this.targetFactor = 1; this.targetAngle = 0; this.remaining = 0;
    }

    step(dt, mean) {
      this.remaining -= dt;
      if (this.remaining <= 0) {
        // Bounded Gaussian gust targets, held for a random 2 to 7 seconds.
        const normal = Math.sqrt(-2 * Math.log(Math.max(1e-9, this.random()))) * Math.cos(2 * Math.PI * this.random());
        this.targetFactor = clamp(1 + 0.19 * normal, 0.55, 1.45);
        this.targetAngle = (this.random() * 20 - 10) * Math.PI / 180;
        this.remaining = 2 + this.random() * 5;
      }
      const blend = 1 - Math.exp(-dt / 1.5);
      this.factor = mix(this.factor, this.targetFactor, blend);
      this.angle = mix(this.angle, this.targetAngle, blend);
      this.speed = mean * this.factor;
    }

    get vector() { return { x: this.speed * Math.sin(this.angle), z: this.speed * Math.cos(this.angle) }; }
  }

  // Shared depth and two horizontal momenta. Opposing flows meet in the flux solver.
  class SwashField {
    constructor({ nx = SEGMENTS, nz = 81, dx = DX, dz = 0.25, zMin = -8,
      bed = bedHeight, closed = false, friction = 0.035 } = {}) {
      Object.assign(this, { nx, nz, dx, dz, zMin, closed, friction });
      this.xMin = -(nx - 1) * dx / 2;
      const n = nx * nz;
      for (const name of ['h', 'qx', 'qz', 'bed', 'foam', 'wet', 'nextH', 'nextX', 'nextZ', 'nextFoam']) {
        this[name] = new Float64Array(n);
      }
      this.time = 0; this.collisionPower = 0; this.collisionCount = 0;
      for (let x = 0; x < nx; x++) for (let z = 0; z < nz; z++) {
        const k = x * nz + z;
        this.bed[k] = bed(this.xMin + x * dx, zMin + z * dz);
        this.h[k] = Math.max(0, -this.bed[k]);
      }
    }

    inject(row, height, speed, angle = 0) {
      for (let z = 0; z < this.nz; z++) {
        const position = this.zMin + z * this.dz;
        const added = height * Math.exp(-(((position + 6) / 0.8) ** 2));
        const k = row * this.nz + z;
        this.h[k] += added;
        this.qz[k] += added * speed * Math.cos(angle);
        this.qx[k] += added * speed * Math.sin(angle);
        this.foam[k] = Math.max(this.foam[k], added / Math.max(0.1, height) * 0.85);
      }
    }

    flux(a, b, axis, dt) {
      const ha = this.h[a], hb = this.h[b];
      if (ha < 1e-8 && hb < 1e-8) return;
      const qa = axis === 0 ? this.qx : this.qz;
      const qt = axis === 0 ? this.qz : this.qx;
      const nextN = axis === 0 ? this.nextX : this.nextZ;
      const nextT = axis === 0 ? this.nextZ : this.nextX;
      const scale = dt / (axis === 0 ? this.dx : this.dz);
      const ua = ha > 1e-6 ? qa[a] / ha : 0, ub = hb > 1e-6 ? qa[b] / hb : 0;
      const va = ha > 1e-6 ? qt[a] / ha : 0, vb = hb > 1e-6 ? qt[b] / hb : 0;
      const crest = Math.max(this.bed[a], this.bed[b]);
      const hA = Math.max(0, ha + this.bed[a] - crest);
      const hB = Math.max(0, hb + this.bed[b] - crest);
      const speed = Math.max(Math.abs(ua) + Math.sqrt(G * hA), Math.abs(ub) + Math.sqrt(G * hB));
      const mass = 0.5 * (hA * ua + hB * ub - speed * (hB - hA));
      const momentum = 0.5 * (hA * ua * ua + hB * ub * ub + G * 0.5 * (hA * hA + hB * hB) - speed * (hB * ub - hA * ua));
      const tangent = 0.5 * (hA * ua * va + hB * ub * vb - speed * (hB * vb - hA * va));
      this.nextH[a] -= scale * mass; this.nextH[b] += scale * mass;
      nextN[a] -= scale * (momentum + G * 0.5 * (ha * ha - hA * hA));
      nextN[b] += scale * (momentum + G * 0.5 * (hb * hb - hB * hB));
      nextT[a] -= scale * tangent; nextT[b] += scale * tangent;
      const foamFlux = mass * (mass >= 0 ? this.foam[a] : this.foam[b]);
      this.nextFoam[a] -= scale * foamFlux; this.nextFoam[b] += scale * foamFlux;
      if (axis === 1 && ua >= 0 && ub <= 0 && ua - ub > 0.3 && Math.min(hA, hB) > 0.015) {
        const power = Math.min(hA, hB) * (ua - ub) ** 3;
        this.collisionPower += power;
        const froth = Math.min(0.5, power * dt);
        this.nextFoam[a] += froth * ha; this.nextFoam[b] += froth * hb;
        this.collisionCount++;
      }
    }

    step(duration) {
      let remaining = duration;
      while (remaining > 1e-8) {
        let rate = 1;
        for (let k = 0; k < this.h.length; k++) if (this.h[k] > 1e-6) {
          const c = Math.sqrt(G * this.h[k]);
          rate = Math.max(rate, (Math.abs(this.qx[k] / this.h[k]) + c) / this.dx +
            (Math.abs(this.qz[k] / this.h[k]) + c) / this.dz);
        }
        const dt = Math.min(remaining, 0.38 / rate);
        remaining -= dt; this.time += dt;
        this.nextH.set(this.h); this.nextX.set(this.qx); this.nextZ.set(this.qz);
        for (let k = 0; k < this.h.length; k++) this.nextFoam[k] = this.foam[k] * this.h[k];
        this.collisionPower = 0;
        for (let x = 0; x < this.nx; x++) for (let z = 0; z < this.nz; z++) {
          const k = x * this.nz + z;
          if (x + 1 < this.nx) this.flux(k, k + this.nz, 0, dt);
          if (z + 1 < this.nz) this.flux(k, k + 1, 1, dt);
        }
        // Wall pressure closes unused faces. The offshore sponge below absorbs backwash.
        for (let x = 0; x < this.nx; x++) {
          const first = x * this.nz, last = first + this.nz - 1;
          this.nextZ[first] += dt / this.dz * G * this.h[first] ** 2 / 2;
          this.nextZ[last] -= dt / this.dz * G * this.h[last] ** 2 / 2;
        }
        for (let z = 0; z < this.nz; z++) {
          const last = (this.nx - 1) * this.nz + z;
          this.nextX[z] += dt / this.dx * G * this.h[z] ** 2 / 2;
          this.nextX[last] -= dt / this.dx * G * this.h[last] ** 2 / 2;
        }
        for (let k = 0; k < this.h.length; k++) {
          const h = Math.max(0, this.nextH[k]);
          const speed = Math.hypot(this.nextX[k], this.nextZ[k]) / Math.max(h, 0.001);
          const drag = 1 + dt * this.friction * speed / Math.max(0.04, h);
          this.h[k] = h;
          this.qx[k] = h > 0.0001 ? this.nextX[k] / drag : 0;
          this.qz[k] = h > 0.0001 ? this.nextZ[k] / drag : 0;
          this.foam[k] = clamp(this.nextFoam[k] / Math.max(h, 0.001), 0, 1) * Math.exp(-dt / 4.5);
          this.wet[k] = h > 0.003 ? 1 : this.wet[k] * Math.exp(-dt / 40);
          if (!this.closed && k % this.nz < 5) {
            const blend = 1 - Math.exp(-dt * (5 - k % this.nz) * 2);
            this.h[k] = mix(h, Math.max(0, -this.bed[k]), blend);
            this.qx[k] *= 1 - blend; this.qz[k] *= 1 - blend;
          }
        }
      }
    }

    stats() {
      let mass = 0, maxDepth = 0, uprush = 0, backwash = 0;
      for (let k = 0; k < this.h.length; k++) {
        mass += this.h[k] * this.dx * this.dz;
        maxDepth = Math.max(maxDepth, this.h[k]);
        if (this.bed[k] >= 0 && this.h[k] > 0.003) {
          if (this.qz[k] > 0.0001) uprush++;
          if (this.qz[k] < -0.0001) backwash++;
        }
      }
      return { mass, maxDepth, uprush, backwash, collisions: this.collisionCount };
    }
  }

  class Ocean {
    constructor(seed = 48231) {
      this.random = random(seed);
      this.wind = 12;
      this.gust = new GustWind(seed ^ 0x5f3759df);
      this.windOffset = { x: 0, z: 0 };
      this.swash = new SwashField();
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
      this.warming = true;
      for (let i = 0; i < 2400; i++) this.step(1 / 60);
      this.warming = false;
      this.events.length = 0;
      this.breakCount = 0;
    }

    spawn() {
      if (this.sea.height < 0.035 || this.fronts.length >= 18) return;
      const r = this.random;
      const period = this.sea.period * (0.82 + r() * 0.36);
      const height = this.sea.height * (0.65 + r() * 0.70);
      const phase = r() * Math.PI * 2;
      const angle = this.gust.angle;
      const front = { id: ++this.serial, period, height, phase, angle, segments: [], age: 0 };
      const offshore = dispersion(period, 8);
      for (let i = 0; i < SEGMENTS; i++) {
        const x = (i - (SEGMENTS - 1) / 2) * DX;
        const crestHeight = height * (0.76 + 0.20 * Math.cos(x * 0.085 + phase) +
          0.18 * Math.sin(x * 0.27 - phase));
        front.segments.push({ x, z: -125 - x * Math.tan(angle) + 1.8 * Math.sin(x * 0.043 + phase),
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
      this.gust.step(dt, this.wind);
      this.windOffset.x += this.gust.vector.x * dt;
      this.windOffset.z += this.gust.vector.z * dt;
      const targetSea = windSea(this.gust.speed, this.fetchKm);
      this.sea.height = mix(this.sea.height, targetSea.height, 1 - Math.exp(-dt / 9));
      this.sea.period = mix(this.sea.period, targetSea.period, 1 - Math.exp(-dt / 9));
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
          if (!s.runup) {
            const d = dispersion(front.period, h);
            s.c = d.c;
            s.width = Math.max(0.9, d.wavelength * 0.22);
            const left = oldZ[Math.max(0, i - 1)], right = oldZ[Math.min(SEGMENTS - 1, i + 1)];
            // Along-crest coupling prevents independent strips and bends fronts over the bar.
            s.z += (d.c / Math.cos(front.angle) + 0.30 * (left + right - 2 * oldZ[i])) * dt;
            if (!s.breaking) {
              const target = s.baseHeight * Math.sqrt(s.cg0 / Math.max(0.3, d.cg));
              const windGrowth = 1 + 0.025 * Math.max(0, this.gust.speed / d.c - 1);
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
          if (s.z >= -6 && !s.runup) {
            const height = clamp(s.height + 0.22 * (s.impactHeight || s.height), 0.008, 0.65);
            if (!this.warming || this.time > 30) this.swash.inject(i, height, Math.sqrt(G * (0.4 + height)), front.angle);
            this.events.push({ id: `wash:${front.id}:${i}`, kind: 'wash', frontId: front.id,
              index: i, x: s.x, y: 0.12, z: -6, height, energy: s.energy * 0.25, time: this.time });
            s.runup = { age: 0, done: false };
            s.z = -6;
          }
          if (s.runup) {
            s.runup.age += dt;
            s.runup.done = s.runup.age > 12;
          }
        }
      }
      this.fronts = this.fronts.filter(f => f.age < 90 && !f.segments.every(s => s.runup?.done));
      if (!this.warming || this.time > 30) this.swash.step(dt);
      for (let i = 0; i < SEGMENTS; i++) for (let j = 0; j < this.swash.nz; j++) {
        if (this.swash.h[i * this.swash.nz + j] > 0.004) {
          this.wetReach[i] = Math.max(this.wetReach[i], this.swash.zMin + j * this.swash.dz);
        }
      }
      // Event history is bounded even if nobody consumes it while audio is inactive.
      if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
    }

    takeEvents() { return this.events.splice(0); }

    stats() {
      const segments = this.fronts.flatMap(f => f.segments);
      return { time: this.time, height: this.sea.height, period: this.sea.period,
        fronts: this.fronts.length, breaking: segments.filter(s => s.breaking && s.breakAge < 2).length,
        swash: segments.filter(s => s.runup && !s.runup.done).length, breaks: this.breakCount,
        wind: this.gust.speed, windAngle: this.gust.angle * 180 / Math.PI,
        water: this.swash.stats() };
    }
  }

  const api = { G, RHO, DX, SEGMENTS, clamp, mix, random, bedHeight, terrainHeight, dispersion, windSea,
    breakingHeight, earPaths, GustWind, SwashField, Ocean };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SurfPhysics = api;
})(typeof window !== 'undefined' ? window : globalThis);
