const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../surf-physics.js');
global.window = { SurfPhysics: P };
require('../surf-audio.js');

const close = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test('dispersion solves finite-depth gravity waves and both limiting cases', () => {
  for (const period of [1.6, 4, 9]) for (const depth of [0.07, 0.5, 2, 8, 200]) {
    const d = P.dispersion(period, depth);
    close(P.G * d.k * Math.tanh(d.k * depth), (2 * Math.PI / period) ** 2);
    assert.ok(d.cg > 0 && d.cg <= d.c);
  }
  close(P.dispersion(8, 0.07).c / Math.sqrt(P.G * 0.07), 1, 0.002);
  close(P.dispersion(4, 200).cg / P.dispersion(4, 200).c, 0.5);
});

test('wind and fetch increase offshore height and period, calm creates no waves', () => {
  assert.equal(P.windSea(0, 35).height, 0);
  const low = P.windSea(6, 10), high = P.windSea(12, 35);
  assert.ok(high.height > low.height && high.period > low.period);
  assert.ok(P.windSea(12, 60).height > high.height);
  assert.ok(high.height > 1.2 && high.height < 1.4);
  assert.ok(high.period > 4.4 && high.period < 4.7);
});

test('ear paths are symmetric in front and swap after a half turn', () => {
  const observer = { x: 0, y: 1.7, z: 8, yaw: 0 };
  const front = P.earPaths({ x: 0, y: 0.4, z: -20 }, observer);
  close(front[0].delay, front[1].delay);
  const source = { x: 20, y: 0.4, z: -20 };
  const ears = P.earPaths(source, observer);
  assert.ok(ears[1].delay < ears[0].delay);
  assert.ok(ears[1].gain > ears[0].gain && ears[1].cutoff > ears[0].cutoff);
  assert.ok(Math.abs(ears[0].delay - ears[1].delay) <= 0.175 / 343);
  const rotated = P.earPaths(source, { ...observer, yaw: Math.PI });
  close(ears[0].delay, rotated[1].delay);
  close(ears[0].cutoff, rotated[1].cutoff);
  assert.ok(P.earPaths(source, observer, 12)[0].delay < ears[0].delay);
});

test('connected crests break once per section, then run up and recede', () => {
  const ocean = new P.Ocean();
  const ids = new Set();
  let neighbor = 0, uprush = false, backwash = false;
  for (let tick = 0; tick < 3600; tick++) {
    ocean.step(1 / 60);
    for (const event of ocean.takeEvents()) {
      assert.ok(!ids.has(event.id), `Repeated impact ${event.id}`);
      ids.add(event.id);
      assert.ok(event.energy > 0 && event.height > 0);
      assert.ok(event.z < 0);
      if (event.cause === 'neighbor') neighbor++;
    }
    for (const f of ocean.fronts) for (const s of f.segments) {
      assert.ok(Number.isFinite(s.z) && Number.isFinite(s.height) && s.height >= 0);
    }
    const water = ocean.swash.stats();
    uprush ||= water.uprush > 0;
    backwash ||= water.backwash > 0;
  }
  assert.ok(ids.size > 100);
  assert.ok(neighbor > 0, 'Break collapse must reach neighbors');
  assert.ok(uprush && backwash);
  assert.ok(Math.max(...ocean.wetReach) > 0);
  assert.ok(ocean.fronts.length <= 18);
  assert.ok(ocean.swash.collisionCount > 0);
});

test('gusts are repeatable, variable, smooth, and bounded to ±10 degrees', () => {
  const a = new P.GustWind(174), b = new P.GustWind(174);
  let min = 100, max = 0, left = false, right = false, previous = 0;
  for (let i = 0; i < 18000; i++) {
    a.step(1 / 60, 12); b.step(1 / 60, 12);
    close(a.speed, b.speed); close(a.angle, b.angle);
    assert.ok(Math.abs(a.angle) <= Math.PI / 18);
    assert.ok(Math.abs(a.angle - previous) < 0.005);
    min = Math.min(min, a.speed); max = Math.max(max, a.speed);
    left ||= a.angle < -0.04; right ||= a.angle > 0.04;
    previous = a.angle;
  }
  assert.ok(max - min > 4 && left && right);
  a.step(1 / 60, 0); assert.equal(a.speed, 0);
});

test('hydrostatic reconstruction preserves still water over the uneven beach', () => {
  const f = new P.SwashField({ closed: true });
  const mass = f.stats().mass;
  for (let i = 0; i < 180; i++) f.step(1 / 60);
  close(f.stats().mass, mass, 1e-7);
  assert.ok(f.qx.every(q => Math.abs(q) < 1e-9));
  assert.ok(f.qz.every(q => Math.abs(q) < 1e-9));
});

test('opposing swash flows build a bore and alter both momenta without losing water', () => {
  const f = new P.SwashField({ nx: 3, nz: 81, zMin: -10, bed: () => -0.2, closed: true, friction: 0 });
  for (let x = 0; x < f.nx; x++) for (let z = 0; z < f.nz; z++) {
    f.qz[x * f.nz + z] = z < 40 ? 0.2 : z > 40 ? -0.2 : 0;
  }
  const mass = f.stats().mass;
  for (let i = 0; i < 60; i++) f.step(1 / 60);
  close(f.stats().mass, mass, 1e-7);
  const center = f.nz + 40;
  assert.ok(f.h[center] > 0.30, 'Collision must raise the water surface');
  assert.ok(f.qz[center - 1] < 0.2 && f.qz[center + 1] > -0.2, 'Both flows must react');
  close(f.h[center - 1], f.h[center + 1], 1e-9);
  assert.ok(f.collisionCount > 0);
  assert.ok(f.h.every(h => Number.isFinite(h) && h >= 0));
});

test('extreme winds stay finite, and calm lets the existing sea drain away', () => {
  const ocean = new P.Ocean(102);
  ocean.wind = 18; ocean.fetchKm = 60;
  for (let i = 0; i < 3600; i++) ocean.step(1 / 30);
  for (const f of ocean.fronts) for (const s of f.segments) {
    assert.ok(Number.isFinite(s.height) && Number.isFinite(s.z));
  }
  assert.ok(ocean.events.length <= 400 && ocean.fronts.length <= 18);
  assert.ok(ocean.swash.h.every(h => Number.isFinite(h) && h >= 0));
  assert.ok(ocean.swash.qx.every(Number.isFinite) && ocean.swash.qz.every(Number.isFinite));
  ocean.wind = 0;
  for (let i = 0; i < 3000; i++) ocean.step(1 / 30);
  assert.equal(ocean.fronts.length, 0);
});

test('synthesized impact is deterministic, finite, quiet at both ends, and decays', () => {
  for (const sampleRate of [24000, 44100, 48000]) {
    const event = { frontId: 5, index: 19, height: 1.3 };
    const a = window.SurfCrashSamples(sampleRate, event);
    const b = window.SurfCrashSamples(sampleRate, event);
    assert.deepEqual(a, b);
    assert.equal(a[0], 0); assert.equal(a[a.length - 1], 0);
    let peak = 0, firstEnergy = 0, tailEnergy = 0;
    for (let i = 0; i < a.length; i++) {
      assert.ok(Number.isFinite(a[i])); peak = Math.max(peak, Math.abs(a[i]));
      if (i < a.length / 3) firstEnergy += a[i] ** 2;
      if (i > a.length * 2 / 3) tailEnergy += a[i] ** 2;
    }
    assert.ok(peak > 0.05 && peak < 1);
    assert.ok(firstEnergy > tailEnergy * 10);
  }
});
