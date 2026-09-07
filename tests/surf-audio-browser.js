// Load into a test browser with addScriptTag, then call runSurfAudioChecks().
window.runSurfAudioChecks = async function () {
  const assert = (condition, label) => { if (!condition) throw new Error(label); };
  const sampleRate = 48000;
  const observer = { x: 0, y: 1.7, z: 4, yaw: 0 };
  async function render(x, z, yaw = 0, copies = 1, limiter = false) {
    const audio = new SurfAudio();
    audio.context = new OfflineAudioContext(2, sampleRate * 10, sampleRate);
    if (limiter) {
      audio.volume = 1;
      audio.setupOutput();
    } else {
      audio.master = audio.context.createGain();
      audio.master.connect(audio.context.destination);
    }
    const event = { frontId: 5, index: 19, height: 1.3, energy: 20000,
      x, y: 0.325, z, segment: { z, height: 1.3 } };
    for (let i = 0; i < copies; i++) audio.createVoice(event, { ...observer, yaw }, 0);
    const buffer = await audio.context.startRendering();
    const channels = [buffer.getChannelData(0), buffer.getChannelData(1)];
    const stats = channels.map(samples => {
      let peak = 0, energy = 0, first = -1, dc = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = samples[i]; assert(Number.isFinite(v), 'Nonfinite audio sample');
        peak = Math.max(peak, Math.abs(v)); energy += v * v; dc += v;
        if (first < 0 && Math.abs(v) > 1e-7) first = i;
      }
      return { peak, rms: Math.sqrt(energy / samples.length), first, dc: dc / samples.length };
    });
    return { stats, channels, paths: SurfPhysics.earPaths({ x, y: 0.325, z }, { ...observer, yaw }) };
  }
  const front = await render(0, -12);
  assert(front.channels[0].every((v, i) => v === front.channels[1][i]), 'Centered source must match in both ears');
  const right = await render(12, -8);
  assert(right.stats[1].first < right.stats[0].first, 'Right-hand break must arrive at the right ear first');
  assert(right.stats[1].rms > right.stats[0].rms, 'Right-hand break must be brighter/louder at right ear');
  for (let side = 0; side < 2; side++) {
    const expected = right.paths[side].delay * sampleRate;
    assert(Math.abs(right.stats[side].first - expected) < 16, 'Onset differs from physical distance delay');
    assert(right.stats[side].peak < 1 && right.stats[side].rms > 0.001, 'Silent or clipped ear channel');
    assert(Math.abs(right.stats[side].dc) < 0.001, 'DC offset');
  }
  const turned = await render(12, -8, Math.PI);
  assert(right.channels[0].every((v, i) => Math.abs(v - turned.channels[1][i]) < 1e-6), 'Half-turn must exchange ear signals');
  const far = await render(0, -40);
  assert(far.stats[0].rms < front.stats[0].rms * 0.5, 'Distance must reduce sound pressure');
  assert(far.stats[0].first > front.stats[0].first, 'Farther sound must arrive later');
  const crowded = await render(0, 2, 0, 48, true);
  assert(crowded.stats.every(s => s.peak < 1), 'Worst-case 48-source mix clips');
  return { passed: true, front: front.stats, right: right.stats, physicalDelays: right.paths,
    far: far.stats, worstCase: crowded.stats };
};
