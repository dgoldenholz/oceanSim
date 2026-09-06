const SPEED_OF_SOUND = 343;
const EAR_SPAN_METERS = 0.175;
const WORLD_WIDTH_METERS = 36;
const WORLD_HEIGHT_METERS = 22.5;
const SAND_TOP = 0.70;
const SOURCE_DURATION_SECONDS = 2;
const GRAVITY = 9.81;
const WAVE_STOP_Y = 0.685;
const DEFAULT_WAVE_RATE_PER_MINUTE = 6;
const ALONGSHORE_WAVE_CHANCE = 0.12;
const EARLY_END_WAVE_CHANCE = 0.30;
const MAX_VISIBLE_WAVES = 7;
const FLYING_GULL_INTERVAL_MS = 10000;
const FLYING_GULL_MIN_SPEED_MPS = 7;
const FLYING_GULL_MAX_SPEED_MPS = 10;
const FLYING_GULL_MARGIN = 0.12;

const scene = document.getElementById("beach-scene");
const waveScene = document.getElementById("wave-scene");
const sourceLayer = document.getElementById("source-layer");
const waveLayer = document.getElementById("wave-layer");
const flyingGullLayer = document.getElementById("flying-gull-layer");
const listenerElement = document.getElementById("listener");
const waveListenerElement = document.getElementById("wave-listener");
const headingElement = listenerElement.querySelector(".listener-heading");
const waveHeadingElement = waveListenerElement.querySelector(".listener-heading");
const personElement = listenerElement.querySelector(".person");
const wavePersonElement = waveListenerElement.querySelector(".person");
const playButton = document.getElementById("play-button");
const playButtonLabel = playButton.querySelector("span");
const addWaveButton = document.getElementById("add-wave-button");
const removeButton = document.getElementById("remove-button");
const sourceCount = document.getElementById("source-count");
const waveCount = document.getElementById("wave-count");
const waveRateSlider = document.getElementById("wave-rate-slider");
const waveRateValue = document.getElementById("wave-rate-value");
const waveGenerationStatus = document.getElementById("wave-generation-status");
const acousticReadout = document.getElementById("acoustic-readout");
const waveReadout = document.getElementById("wave-readout");
const headingValue = document.getElementById("heading-value");
const waveHeadingValue = document.getElementById("wave-heading-value");
const waveformCaption = document.getElementById("waveform-caption");
const sourceWaveformMeta = document.getElementById("source-waveform-meta");
const leftWaveformMeta = document.getElementById("left-waveform-meta");
const rightWaveformMeta = document.getElementById("right-waveform-meta");
const waveformTimeEnd = document.getElementById("waveform-time-end");
const sourceWaveformPath = document.querySelector("#source-waveform .waveform-signal");
const leftWaveformPath = document.querySelector("#left-waveform .waveform-signal");
const rightWaveformPath = document.querySelector("#right-waveform .waveform-signal");
const dragGhost = document.getElementById("drag-ghost");
const toast = document.getElementById("toast");
const pageTabs = [...document.querySelectorAll(".page-tab")];
const pageViews = [...document.querySelectorAll(".page-view")];

const listener = {
  x: 0.5,
  y: 0.84,
  heading: 0,
};

const sources = [];
const waves = [];
const flyingGulls = [];
let selectedSourceId = null;
let selectedWaveId = null;
let sourceSequence = 0;
let waveSequence = 0;
let flyingGullSequence = 0;
let dragState = null;
let toastTimeout = null;
let audioContext = null;
const seagullSamplePromises = new Map();
let activePage = "sources";
let waveAudioEnabled = false;
let waveRatePerMinute = DEFAULT_WAVE_RATE_PER_MINUTE;
const activeWaveAudioNodes = new Set();
const activeSceneAudioNodes = new Set();
let scenePlaybackVersion = 0;
let scenePlaybackTimer = null;
let sceneAudioGraph = null;
let lastAnimationTime = performance.now();
let nextWaveAt = performance.now() + 60000 / DEFAULT_WAVE_RATE_PER_MINUTE;
let nextFlyingGullAt = null;
let waveformRenderFrame = null;
let waveformRenderVersion = 0;
let lastMovingWaveformUpdate = 0;

const ICONS = {
  bird: `
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <path d="M7 37c10-2 17-7 23-16 1 8 5 13 12 16 5 2 10 2 15 0-7 8-16 12-27 8-8-3-15-6-23-8Z" />
      <path d="m43 36 8-7-2 10" />
    </svg>`,
  gaussian: `
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <path class="axis" d="M7 50h50" />
      <path class="curve" d="M8 49c12 0 14-3 18-21 1-6 3-10 6-10s5 4 6 10c4 18 6 21 18 21" />
    </svg>`,
  wave: `
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <path d="M7 27c7-7 13-7 20 0s13 7 20 0" />
      <path d="M15 39c6-5 11-5 17 0s11 5 17 0" />
    </svg>`,
};

const SOURCE_NAMES = {
  bird: "Seagull",
  gaussian: "Gaussian noise",
  wave: "Wave",
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizedHeading(degrees) {
  return ((degrees % 360) + 360) % 360;
}

function scenePoint(clientX, clientY) {
  const rect = scene.getBoundingClientRect();
  return {
    x: clamp((clientX - rect.left) / rect.width, 0.025, 0.975),
    y: clamp((clientY - rect.top) / rect.height, 0.035, 0.965),
    inside:
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom,
  };
}

function physicalPoint(point) {
  return {
    x: point.x * WORLD_WIDTH_METERS,
    y: (1 - point.y) * WORLD_HEIGHT_METERS,
  };
}

function getEarPositions() {
  const center = physicalPoint(listener);
  const radians = (listener.heading * Math.PI) / 180;
  const rightVector = {
    x: Math.cos(radians),
    y: -Math.sin(radians),
  };
  const halfSpan = EAR_SPAN_METERS / 2;

  return {
    left: {
      x: center.x - rightVector.x * halfSpan,
      y: center.y - rightVector.y * halfSpan,
    },
    right: {
      x: center.x + rightVector.x * halfSpan,
      y: center.y + rightVector.y * halfSpan,
    },
  };
}

function distanceBetween(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function getAcousticMetrics(source) {
  const sourcePosition = physicalPoint(source);
  const listenerPosition = physicalPoint(listener);
  const ears = getEarPositions();
  const leftDistance = distanceBetween(sourcePosition, ears.left);
  const rightDistance = distanceBetween(sourcePosition, ears.right);
  const centerDistance = distanceBetween(sourcePosition, listenerPosition);
  const leftDelay = leftDistance / SPEED_OF_SOUND;
  const rightDelay = rightDistance / SPEED_OF_SOUND;

  const dx = sourcePosition.x - listenerPosition.x;
  const dy = sourcePosition.y - listenerPosition.y;
  const sourceBearing = normalizedHeading((Math.atan2(dx, dy) * 180) / Math.PI);
  let relativeBearing = normalizedHeading(sourceBearing - listener.heading);
  if (relativeBearing > 180) relativeBearing -= 360;

  return {
    leftDistance,
    rightDistance,
    centerDistance,
    leftDelay,
    rightDelay,
    interauralDelay: rightDelay - leftDelay,
    relativeBearing,
  };
}

function relativeDirection(angle) {
  const magnitude = Math.abs(angle);
  if (magnitude < 4) return "ahead";
  if (magnitude > 176) return "behind";
  return `${Math.round(magnitude)}° ${angle < 0 ? "left" : "right"}`;
}

function updateListener() {
  [listenerElement, waveListenerElement].forEach((element) => {
    element.style.left = `${listener.x * 100}%`;
    element.style.top = `${listener.y * 100}%`;
    element.setAttribute(
      "aria-label",
      `Listener at ${normalizedHeading(listener.heading)} degrees, confined to the sand`,
    );
  });
  [headingElement, waveHeadingElement].forEach((element) => {
    element.style.transform = `rotate(${listener.heading}deg)`;
  });
  [personElement, wavePersonElement].forEach((element) => {
    element.style.transform = `rotate(${listener.heading}deg)`;
  });
  [headingValue, waveHeadingValue].forEach((element) => {
    element.textContent = `${normalizedHeading(listener.heading)}°`;
  });
  updateReadout();
  scheduleWaveformUpdate();
  updateWaveReadout();
}

function updateSourceCount() {
  const count = sources.length;
  sourceCount.textContent = count === 0 ? "No sources placed" : `${count} source${count === 1 ? "" : "s"} placed`;
}

function updateReadout() {
  const selected = sources.find((source) => source.id === selectedSourceId);
  removeButton.disabled = !selected;

  if (!selected) {
    acousticReadout.textContent =
      sources.length === 0
        ? "Place or select a source to inspect its stereo path."
        : "Select a source to inspect its distance and interaural timing.";
    return;
  }

  const metrics = getAcousticMetrics(selected);
  const deltaMs = Math.abs(metrics.interauralDelay * 1000);
  const firstEar = deltaMs < 0.005 ? "ears aligned" : `${metrics.interauralDelay > 0 ? "left" : "right"} ear first`;
  const motionDetail =
    selected.type === "wave"
      ? selected.status === "stopped"
        ? "at shore · "
        : `${(selected.speed || waveSpeedAt(selected.y)).toFixed(1)} m/s when released · `
      : "";
  acousticReadout.textContent = `${SOURCE_NAMES[selected.type]} ${String(selected.number).padStart(2, "0")} · ${motionDetail}${metrics.centerDistance.toFixed(2)} m · ${relativeDirection(metrics.relativeBearing)} · L ${(metrics.leftDelay * 1000).toFixed(2)} ms · R ${(metrics.rightDelay * 1000).toFixed(2)} ms · Δ ${deltaMs.toFixed(2)} ms (${firstEar})`;
}

function updateWaveReadout() {
  const selected = waves.find((wave) => wave.id === selectedWaveId);
  if (!selected) {
    waveReadout.textContent =
      waves.length === 0
        ? "Waiting for the first random wave…"
        : "Select a moving wave to inspect its speed and interaural timing.";
    return;
  }

  const metrics = getAcousticMetrics(selected);
  const deltaMs = Math.abs(metrics.interauralDelay * 1000);
  const firstEar = deltaMs < 0.005 ? "ears aligned" : `${metrics.interauralDelay > 0 ? "left" : "right"} ear first`;
  const motionLabel =
    selected.motionType === "alongshore"
      ? "alongshore"
      : selected.endY < WAVE_STOP_Y - 0.005
        ? "ending offshore"
        : "shoreward";
  const state = selected.status === "stopped" ? "at shore" : `${selected.speed.toFixed(1)} m/s ${motionLabel}`;
  waveReadout.textContent = `Wave ${String(selected.number).padStart(2, "0")} · ${state} · ${metrics.centerDistance.toFixed(2)} m · ${relativeDirection(metrics.relativeBearing)} · L ${(metrics.leftDelay * 1000).toFixed(2)} ms · R ${(metrics.rightDelay * 1000).toFixed(2)} ms · Δ ${deltaMs.toFixed(2)} ms (${firstEar})`;
}

function setSelected(id) {
  selectedSourceId = id;
  sourceLayer.querySelectorAll(".placed-source").forEach((element) => {
    element.classList.toggle("selected", element.dataset.id === id);
  });
  updateReadout();
  scheduleWaveformUpdate();
}

function addSource(type, x, y) {
  sourceSequence += 1;
  const source = {
    id: `source-${sourceSequence}`,
    number: sourceSequence,
    type,
    noiseSeed: sourceSequence * 104729 + 17,
    x: clamp(x, 0.035, 0.965),
    y: type === "wave" ? clamp(y, 0.045, WAVE_STOP_Y - 0.02) : clamp(y, 0.045, 0.955),
    speed: type === "wave" ? waveSpeedAt(y) : 0,
    status: type === "wave" ? "idle" : "stationary",
    element: null,
  };
  if (type === "wave") {
    source.speed = waveSpeedAt(source.y);
    source.motionType = "shoreward";
    source.directionX = 0;
    source.endX = source.x;
    source.endY = WAVE_STOP_Y;
    source.waveStartX = source.x;
    source.waveStartY = source.y;
    source.waveLifetimeDuration = waveTravelDuration(source.y);
    source.waveElapsedSeconds = 0;
  }
  sources.push(source);

  const element = document.createElement("button");
  element.type = "button";
  element.className = "placed-source";
  element.dataset.id = source.id;
  element.dataset.type = type;
  element.style.left = `${source.x * 100}%`;
  element.style.top = `${source.y * 100}%`;
  element.setAttribute("aria-label", `${SOURCE_NAMES[type]} ${source.number}. Drag to reposition.`);
  element.innerHTML = ICONS[type];
  element.addEventListener("pointerdown", (event) => beginPlacedSourceDrag(event, source.id));
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    setSelected(source.id);
  });
  source.element = element;
  sourceLayer.appendChild(element);

  setSelected(source.id);
  updateSourceCount();
  scene.focus({ preventScroll: true });
  return source;
}

function removeSource(id) {
  const index = sources.findIndex((source) => source.id === id);
  if (index === -1) return;
  const [removed] = sources.splice(index, 1);
  sourceLayer.querySelector(`[data-id="${removed.id}"]`)?.remove();
  if (selectedSourceId === removed.id) selectedSourceId = null;
  updateSourceCount();
  updateReadout();
  scheduleWaveformUpdate();
  return removed;
}

function removeSelected() {
  if (!selectedSourceId) return;
  const removed = removeSource(selectedSourceId);
  if (!removed) return;
  showToast(`${SOURCE_NAMES[removed.type]} removed`);
}

function defaultSourcePosition(type) {
  const offset = sources.length % 5;
  const side = offset % 2 === 0 ? 1 : -1;
  return {
    x: clamp(listener.x + side * (0.13 + offset * 0.018), 0.08, 0.92),
    y:
      type === "bird"
        ? Math.max(0.34, listener.y - 0.28 - offset * 0.025)
        : type === "wave"
          ? Math.max(0.18, listener.y - 0.42 - offset * 0.02)
          : Math.max(0.48, listener.y - 0.15),
  };
}

function beginPaletteDrag(event) {
  if (event.button !== 0) return;
  const tool = event.currentTarget;
  const type = tool.dataset.sourceType;
  dragState = {
    kind: "palette",
    type,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
  };
  tool.setPointerCapture(event.pointerId);
  dragGhost.innerHTML = ICONS[type];
  dragGhost.className = `drag-ghost ${type} visible`;
  moveGhost(event.clientX, event.clientY);
  document.body.style.userSelect = "none";
}

function beginPlacedSourceDrag(event, id) {
  if (event.button !== 0) return;
  event.stopPropagation();
  const source = sources.find((item) => item.id === id);
  if (!source) return;
  if (source.type === "wave" && source.status === "moving") {
    showToast("This wave is moving toward shore");
    return;
  }
  if (source.type === "wave") {
    source.status = "idle";
    source.element.classList.remove("at-shore");
  }
  setSelected(id);
  dragState = {
    kind: "source",
    source,
    element: event.currentTarget,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
  };
  event.currentTarget.setPointerCapture(event.pointerId);
  document.body.style.userSelect = "none";
}

function moveGhost(clientX, clientY) {
  dragGhost.style.left = `${clientX}px`;
  dragGhost.style.top = `${clientY}px`;
}

function handlePointerMove(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const movement = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
  if (movement > 5) dragState.moved = true;
  const point = scenePoint(event.clientX, event.clientY);

  if (dragState.kind === "palette") {
    moveGhost(event.clientX, event.clientY);
    scene.classList.toggle("accepts-drop", point.inside);
    return;
  }

  if (dragState.kind === "source") {
    dragState.source.x = point.x;
    dragState.source.y =
      dragState.source.type === "wave" ? Math.min(point.y, WAVE_STOP_Y - 0.02) : point.y;
    if (dragState.source.type === "wave") {
      dragState.source.speed = waveSpeedAt(dragState.source.y);
      dragState.source.endX = dragState.source.x;
      dragState.source.endY = WAVE_STOP_Y;
      dragState.source.waveStartX = dragState.source.x;
      dragState.source.waveStartY = dragState.source.y;
      dragState.source.waveLifetimeDuration = waveTravelDuration(dragState.source.y);
      dragState.source.waveElapsedSeconds = 0;
    }
    dragState.element.style.left = `${point.x * 100}%`;
    dragState.element.style.top = `${dragState.source.y * 100}%`;
    updateReadout();
    scheduleWaveformUpdate();
  }
}

function endPointerDrag(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const completedDrag = dragState;
  const point = scenePoint(event.clientX, event.clientY);
  dragState = null;
  scene.classList.remove("accepts-drop");
  dragGhost.className = "drag-ghost";
  dragGhost.innerHTML = "";
  document.body.style.userSelect = "";

  if (completedDrag.kind === "palette") {
    if (point.inside) {
      addSource(completedDrag.type, point.x, point.y);
    } else if (!completedDrag.moved) {
      const fallback = defaultSourcePosition(completedDrag.type);
      addSource(completedDrag.type, fallback.x, fallback.y);
    }
  }
}

function moveListener(key) {
  const moveStep = 0.012;
  const radians = (listener.heading * Math.PI) / 180;
  const forward = { x: Math.sin(radians), y: -Math.cos(radians) };
  const right = { x: Math.cos(radians), y: Math.sin(radians) };
  let dx = 0;
  let dy = 0;

  if (key === "w" || key === "arrowup") {
    dx = forward.x * moveStep;
    dy = forward.y * moveStep;
  } else if (key === "s" || key === "arrowdown") {
    dx = -forward.x * moveStep;
    dy = -forward.y * moveStep;
  } else if (key === "a" || key === "arrowleft") {
    dx = -right.x * moveStep;
    dy = -right.y * moveStep;
  } else if (key === "d" || key === "arrowright") {
    dx = right.x * moveStep;
    dy = right.y * moveStep;
  }

  listener.x = clamp(listener.x + dx, 0.055, 0.945);
  listener.y = clamp(listener.y + dy, SAND_TOP + 0.055, 0.935);
  updateListener();
}

function handleKeyboard(event) {
  if (activePage === "surf") return;
  const tag = event.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  const key = event.key.toLowerCase();

  if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
    event.preventDefault();
    moveListener(key);
    return;
  }

  if (key === "q" || key === "e") {
    event.preventDefault();
    listener.heading = normalizedHeading(listener.heading + (key === "q" ? -15 : 15));
    updateListener();
    return;
  }

  if ((key === "delete" || key === "backspace") && selectedSourceId && activePage === "sources") {
    event.preventDefault();
    removeSelected();
  }
}

function seededNoise(seed) {
  let value = seed >>> 0;
  return () => {
    value = (1664525 * value + 1013904223) >>> 0;
    return (value / 4294967296) * 2 - 1;
  };
}

function bytesFromDataUri(dataUri) {
  const encoded = dataUri.slice(dataUri.indexOf(",") + 1);
  const binary = window.atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function loadSeagullSamples(context) {
  if (seagullSamplePromises.has(context.sampleRate)) {
    return seagullSamplePromises.get(context.sampleRate);
  }
  const samplesPromise = (async () => {
    if (!window.SEAGULL_RECORDING_DATA_URI) {
      throw new Error("The bundled seagull recording is unavailable.");
    }
    const decoded = await context.decodeAudioData(bytesFromDataUri(window.SEAGULL_RECORDING_DATA_URI));
    const length = Math.floor(context.sampleRate * SOURCE_DURATION_SECONDS);
    const samples = new Float32Array(length);
    const channels = decoded.numberOfChannels;

    for (let channel = 0; channel < channels; channel += 1) {
      const channelData = decoded.getChannelData(channel);
      const copyLength = Math.min(length, channelData.length);
      for (let index = 0; index < copyLength; index += 1) {
        samples[index] += channelData[index] / channels;
      }
    }
    return samples;
  })();
  seagullSamplePromises.set(context.sampleRate, samplesPromise);
  return samplesPromise;
}

function buildGaussianNoiseSamples(sampleRate, seed) {
  const length = Math.floor(sampleRate * SOURCE_DURATION_SECONDS);
  const samples = new Float32Array(length);
  const random = seededNoise(seed);
  const center = SOURCE_DURATION_SECONDS / 2;
  const sigma = 0.33;

  for (let index = 0; index < length; index += 1) {
    const time = index / sampleRate;
    const gaussian = Math.exp(-0.5 * ((time - center) / sigma) ** 2);
    samples[index] = random() * gaussian * 0.68;
  }

  return samples;
}

function buildWaveformPath(samples, sampleRate, totalDuration, binCount = 720) {
  const midpoint = 36;
  const amplitudeScale = 31;
  const totalSampleCount = Math.ceil(totalDuration * sampleRate);
  let path = "";

  for (let bin = 0; bin < binCount; bin += 1) {
    const start = Math.floor((bin / binCount) * totalSampleCount);
    const end = Math.max(start + 1, Math.floor(((bin + 1) / binCount) * totalSampleCount));
    let minimum = 0;
    let maximum = 0;

    for (let index = start; index < end && index < samples.length; index += 1) {
      minimum = Math.min(minimum, samples[index]);
      maximum = Math.max(maximum, samples[index]);
    }

    const x = (bin / (binCount - 1)) * 1000;
    const top = midpoint - clamp(maximum, -1, 1) * amplitudeScale;
    const bottom = midpoint - clamp(minimum, -1, 1) * amplitudeScale;
    path += `M${x.toFixed(2)} ${top.toFixed(2)}V${bottom.toFixed(2)}`;
  }
  return path;
}

function resetWaveformFigure() {
  const baseline = "M0 36H1000";
  sourceWaveformPath.setAttribute("d", baseline);
  leftWaveformPath.setAttribute("d", baseline);
  rightWaveformPath.setAttribute("d", baseline);
  waveformCaption.textContent = "Select a source to compare its acoustic paths.";
  sourceWaveformMeta.textContent = "At emission";
  leftWaveformMeta.textContent = "Distance transform";
  rightWaveformMeta.textContent = "Distance transform";
  waveformTimeEnd.textContent = `${SOURCE_DURATION_SECONDS.toFixed(2)} s`;
}

function scheduleWaveformUpdate() {
  if (waveformRenderFrame !== null) return;
  waveformRenderFrame = window.requestAnimationFrame(() => {
    waveformRenderFrame = null;
    renderSourceWaveforms();
  });
}

async function renderSourceWaveforms() {
  const renderVersion = ++waveformRenderVersion;
  const selected = sources.find((source) => source.id === selectedSourceId);
  if (!selected) {
    resetWaveformFigure();
    return;
  }

  waveformCaption.textContent = `Preparing ${SOURCE_NAMES[selected.type].toLowerCase()} waveform…`;
  let sampleRate = audioContext?.sampleRate || 44100;
  let sourceSamples;
  let wavePreview = null;

  try {
    if (selected.type === "bird" || selected.type === "wave") {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("Web Audio is unavailable");
      audioContext ??= new AudioContextClass();
      sampleRate = audioContext.sampleRate;
      if (selected.type === "bird") {
        sourceSamples = await loadSeagullSamples(audioContext);
      } else {
        const startY = selected.waveStartY ?? selected.y;
        const lifetimeDuration =
          selected.waveLifetimeDuration || waveTravelDuration(startY);
        wavePreview = { startY, lifetimeDuration };
        sourceSamples = buildWaveNoiseSamples(
          sampleRate,
          selected.noiseSeed,
          lifetimeDuration,
          0,
          lifetimeDuration,
        );
      }
    } else {
      sourceSamples = buildGaussianNoiseSamples(sampleRate, selected.noiseSeed);
    }
  } catch (error) {
    console.error(error);
    if (renderVersion === waveformRenderVersion) {
      resetWaveformFigure();
      waveformCaption.textContent = "The source waveform could not be prepared.";
    }
    return;
  }

  if (renderVersion !== waveformRenderVersion || selected.id !== selectedSourceId) return;

  const metricsSource =
    selected.type === "wave" ? { ...selected, y: wavePreview.startY } : selected;
  const metrics = getAcousticMetrics(metricsSource);
  let totalDuration =
    SOURCE_DURATION_SECONDS + Math.max(metrics.leftDelay, metrics.rightDelay) + 0.012;
  let leftSamples;
  let rightSamples;
  const leftGain = distanceGain(metrics.leftDistance);
  const rightGain = distanceGain(metrics.rightDistance);

  if (selected.type === "wave") {
    const movingBuffer = buildMovingWaveSpatialBuffer(
      audioContext,
      selected,
      selected.noiseSeed,
      sourceSamples,
      {
        startY: wavePreview.startY,
        elapsedOffsetSeconds: 0,
        lifetimeDurationSeconds: wavePreview.lifetimeDuration,
        durationSeconds: wavePreview.lifetimeDuration,
      },
    );
    totalDuration = movingBuffer.duration;
    leftSamples = movingBuffer.getChannelData(0);
    rightSamples = movingBuffer.getChannelData(1);
  } else {
    const outputLength = Math.ceil(totalDuration * sampleRate);
    leftSamples = new Float32Array(outputLength);
    rightSamples = new Float32Array(outputLength);
    addDelayedSignal(leftSamples, sourceSamples, metrics.leftDelay * sampleRate, leftGain);
    addDelayedSignal(rightSamples, sourceSamples, metrics.rightDelay * sampleRate, rightGain);
  }

  sourceWaveformPath.setAttribute("d", buildWaveformPath(sourceSamples, sampleRate, totalDuration));
  leftWaveformPath.setAttribute("d", buildWaveformPath(leftSamples, sampleRate, totalDuration));
  rightWaveformPath.setAttribute("d", buildWaveformPath(rightSamples, sampleRate, totalDuration));

  const number = String(selected.number).padStart(2, "0");
  const deltaMs = Math.abs(metrics.interauralDelay * 1000);
  const wavePathLabel =
    selected.type === "wave"
      ? "full journey · "
      : "";
  waveformCaption.textContent = `${SOURCE_NAMES[selected.type]} ${number} · ${wavePathLabel}inter-ear offset ${deltaMs.toFixed(2)} ms`;
  sourceWaveformMeta.textContent =
    selected.type === "bird"
      ? "2.00 s · field recording"
      : selected.type === "wave"
        ? `${wavePreview.lifetimeDuration.toFixed(2)} s · full-life Gaussian surf`
        : "2.00 s · Gaussian envelope";
  const startPrefix = selected.type === "wave" ? "start " : "";
  leftWaveformMeta.textContent = `${startPrefix}${metrics.leftDistance.toFixed(2)} m · +${(metrics.leftDelay * 1000).toFixed(2)} ms · ${leftGain.toFixed(3)}×`;
  rightWaveformMeta.textContent = `${startPrefix}${metrics.rightDistance.toFixed(2)} m · +${(metrics.rightDelay * 1000).toFixed(2)} ms · ${rightGain.toFixed(3)}×`;
  waveformTimeEnd.textContent = `${totalDuration.toFixed(2)} s`;
}

function addDelayedSignal(target, signal, delaySamples, gain) {
  const wholeDelay = Math.floor(delaySamples);
  const fraction = delaySamples - wholeDelay;
  for (let index = 0; index < signal.length; index += 1) {
    const outputIndex = index + wholeDelay;
    if (outputIndex < target.length) {
      target[outputIndex] += signal[index] * gain * (1 - fraction);
    }
    if (outputIndex + 1 < target.length) {
      target[outputIndex + 1] += signal[index] * gain * fraction;
    }
  }
}

function distanceGain(distanceMeters) {
  // Free-field pressure falls approximately as 1/r, capped inside 1 m.
  return 1 / Math.max(1, distanceMeters);
}

function buildSpatialBuffer(context, source, recordedSeagullSamples) {
  const sampleRate = context.sampleRate;
  const metrics = getAcousticMetrics(source);
  const mono =
    source.type === "bird"
      ? recordedSeagullSamples
      : buildGaussianNoiseSamples(sampleRate, source.noiseSeed);
  const leftDelaySamples = metrics.leftDelay * sampleRate;
  const rightDelaySamples = metrics.rightDelay * sampleRate;
  const maximumDelay = Math.ceil(Math.max(leftDelaySamples, rightDelaySamples));
  const buffer = context.createBuffer(2, mono.length + maximumDelay + 2, sampleRate);

  addDelayedSignal(buffer.getChannelData(0), mono, leftDelaySamples, distanceGain(metrics.leftDistance));
  addDelayedSignal(buffer.getChannelData(1), mono, rightDelaySamples, distanceGain(metrics.rightDistance));
  return buffer;
}

async function playScene() {
  const playbackVersion = ++scenePlaybackVersion;
  if (sources.length === 0) {
    showToast("Place a seagull, Gaussian-noise, or wave source first");
    return;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    showToast("This browser does not support Web Audio");
    return;
  }

  audioContext ??= new AudioContextClass();
  if (audioContext.state === "suspended") await audioContext.resume();

  let recordedSeagullSamples = null;
  if (sources.some((source) => source.type === "bird")) {
    playButton.disabled = true;
    playButtonLabel.textContent = "Loading…";
    try {
      recordedSeagullSamples = await loadSeagullSamples(audioContext);
    } catch (error) {
      console.error(error);
      playButton.disabled = false;
      playButtonLabel.textContent = "Play scene";
      showToast("The seagull recording could not be decoded");
      return;
    }
  }

  if (activePage !== "sources" || playbackVersion !== scenePlaybackVersion) return;

  const compressor = audioContext.createDynamicsCompressor();
  compressor.threshold.value = -10;
  compressor.knee.value = 18;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.18;

  const masterGain = audioContext.createGain();
  masterGain.gain.value = Math.min(1.8, 1.2 / Math.sqrt(sources.length));
  compressor.connect(masterGain);
  masterGain.connect(audioContext.destination);
  sceneAudioGraph = [compressor, masterGain];

  const startTime = audioContext.currentTime + 0.035;
  let longestDuration = 0;
  sources.forEach((source) => {
    const node = audioContext.createBufferSource();
    if (source.type === "wave") {
      if (source.y < WAVE_STOP_Y) {
        source.status = "moving";
        source.speed = waveSpeedAt(source.y);
        source.motionType = "shoreward";
        source.directionX = 0;
        source.endX = source.x;
        source.endY = WAVE_STOP_Y;
        source.waveStartX = source.x;
        source.waveStartY = source.y;
        source.waveLifetimeDuration = waveTravelDuration(source.y);
        source.waveElapsedSeconds = 0;
        source.element.classList.remove("at-shore");
        source.element.classList.add("moving-to-shore");
      } else {
        source.waveStartY = source.y;
        source.waveLifetimeDuration = 0;
        source.waveElapsedSeconds = 0;
      }
      source.element.style.setProperty(
        "--wave-sound-duration",
        `${source.waveLifetimeDuration.toFixed(3)}s`,
      );
      node.buffer = buildMovingWaveSpatialBuffer(
        audioContext,
        source,
        source.noiseSeed,
        null,
        {
          startY: source.waveStartY,
          elapsedOffsetSeconds: 0,
          lifetimeDurationSeconds: source.waveLifetimeDuration,
          durationSeconds: source.waveLifetimeDuration,
        },
      );
    } else {
      node.buffer = buildSpatialBuffer(audioContext, source, recordedSeagullSamples);
    }
    node.connect(compressor);
    activeSceneAudioNodes.add(node);
    node.onended = () => { activeSceneAudioNodes.delete(node); node.disconnect(); };
    node.start(startTime);
    longestDuration = Math.max(longestDuration, node.buffer.duration);
  });

  playButton.disabled = true;
  playButtonLabel.textContent = "Playing…";
  sourceLayer.querySelectorAll(".placed-source").forEach((element) => {
    element.classList.remove("is-playing");
    void element.offsetWidth;
    element.classList.add("is-playing");
  });

  scenePlaybackTimer = window.setTimeout(() => {
    compressor.disconnect();
    masterGain.disconnect();
    sceneAudioGraph = null;
    playButton.disabled = false;
    playButtonLabel.textContent = "Play scene";
    sourceLayer.querySelectorAll(".placed-source").forEach((element) => {
      const source = sources.find((item) => item.id === element.dataset.id);
      if (source?.type !== "wave" || source.status !== "moving") {
        element.classList.remove("is-playing");
      }
    });
  }, (longestDuration + 0.08) * 1000);
}

function stopSceneAudio() {
  scenePlaybackVersion++;
  window.clearTimeout(scenePlaybackTimer);
  for (const node of activeSceneAudioNodes) {
    try { node.stop(); } catch { /* The source may have just finished. */ }
    node.disconnect();
  }
  activeSceneAudioNodes.clear();
  sceneAudioGraph?.forEach(node => node.disconnect());
  sceneAudioGraph = null;
  playButton.disabled = false;
  playButtonLabel.textContent = "Play scene";
  sourceLayer.querySelectorAll(".is-playing").forEach(el => el.classList.remove("is-playing"));
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function nextWaveDelayMs() {
  const averageDelay = 60000 / waveRatePerMinute;
  return averageDelay * randomBetween(0.82, 1.18);
}

function updateWaveRate() {
  waveRatePerMinute = Number(waveRateSlider.value);
  waveRateValue.textContent = `${waveRatePerMinute}/min`;
  waveGenerationStatus.textContent = `About ${waveRatePerMinute} waves/min · gull every 10 sec`;
  nextWaveAt = performance.now() + nextWaveDelayMs();
}

function waterDepthAt(normalizedY) {
  const offshoreFraction = clamp((WAVE_STOP_Y - normalizedY) / (WAVE_STOP_Y - 0.04), 0, 1);
  return 0.3 + 2.2 * offshoreFraction ** 0.92;
}

function waveSpeedAt(normalizedY) {
  return Math.sqrt(GRAVITY * waterDepthAt(normalizedY));
}

function waveTravelDuration(startY, endY = WAVE_STOP_Y) {
  const destinationY = clamp(endY, startY, WAVE_STOP_Y);
  let simulatedY = clamp(startY, 0.04, destinationY);
  let duration = 0;
  const maximumStepSeconds = 1 / 240;

  while (simulatedY < destinationY - 1e-7 && duration < 30) {
    const speed = waveSpeedAt(simulatedY);
    const remainingMeters = (destinationY - simulatedY) * WORLD_HEIGHT_METERS;
    const stepSeconds = Math.min(maximumStepSeconds, remainingMeters / speed);
    simulatedY += (speed * stepSeconds) / WORLD_HEIGHT_METERS;
    duration += stepSeconds;
  }

  return duration;
}

function waveTrajectoryDuration(wave, startX = wave.x, startY = wave.y) {
  if (wave.motionType === "alongshore") {
    return (
      Math.abs((wave.endX ?? startX) - startX) * WORLD_WIDTH_METERS /
      waveSpeedAt(startY)
    );
  }
  return waveTravelDuration(startY, wave.endY ?? WAVE_STOP_Y);
}

function advanceWaveTrajectory(wave, elapsedSeconds) {
  wave.speed = waveSpeedAt(wave.y);
  if (wave.motionType === "alongshore") {
    wave.x += (wave.directionX * wave.speed * elapsedSeconds) / WORLD_WIDTH_METERS;
    const finished = wave.directionX > 0 ? wave.x >= wave.endX : wave.x <= wave.endX;
    if (finished) wave.x = wave.endX;
    return finished;
  }

  const endY = wave.endY ?? WAVE_STOP_Y;
  wave.y += (wave.speed * elapsedSeconds) / WORLD_HEIGHT_METERS;
  if (wave.y >= endY) {
    wave.y = endY;
    return true;
  }
  return false;
}

function waveMotionDescription(wave) {
  if (wave.motionType === "alongshore") {
    return `moving ${wave.directionX > 0 ? "right" : "left"} alongshore`;
  }
  return wave.endY < WAVE_STOP_Y - 0.005 ? "moving toward an offshore endpoint" : "moving toward shore";
}

function waveAriaLabel(wave) {
  return `Wave ${wave.number}, ${waveMotionDescription(wave)} at ${wave.speed.toFixed(1)} meters per second`;
}

function updateWaveCount() {
  const moving = waves.filter((wave) => wave.status === "moving").length;
  const stopped = waves.length - moving;
  if (waves.length === 0) {
    waveCount.textContent = "Generating waves…";
  } else if (stopped > 0) {
    waveCount.textContent = `${moving} moving · ${stopped} at shore`;
  } else {
    waveCount.textContent = `${moving} wave${moving === 1 ? "" : "s"} moving`;
  }
}

function setSelectedWave(id) {
  selectedWaveId = id;
  waveLayer.querySelectorAll(".moving-wave").forEach((element) => {
    element.classList.toggle("selected", element.dataset.id === id);
  });
  updateWaveReadout();
}

function removeWave(id) {
  const index = waves.findIndex((wave) => wave.id === id);
  if (index === -1) return;
  const [removed] = waves.splice(index, 1);
  if (removed.audioNode) {
    try {
      removed.audioNode.stop();
    } catch {
      // The sound may already have reached the end of its lifecycle.
    }
  }
  removed.element.remove();
  if (selectedWaveId === id) selectedWaveId = null;
  updateWaveCount();
  updateWaveReadout();
}

function spawnWave(initialY = randomBetween(0.07, 0.34)) {
  if (waves.length >= MAX_VISIBLE_WAVES) {
    const oldestStopped = waves.find((wave) => wave.status === "stopped");
    if (oldestStopped) removeWave(oldestStopped.id);
    else return null;
  }

  waveSequence += 1;
  const y = clamp(initialY, 0.055, 0.56);
  const motionType = Math.random() < ALONGSHORE_WAVE_CHANCE ? "alongshore" : "shoreward";
  const directionX = Math.random() < 0.5 ? -1 : 1;
  const x = motionType === "alongshore"
    ? directionX > 0
      ? -0.035
      : 1.035
    : randomBetween(0.14, 0.86);
  const endsOffshore =
    motionType === "shoreward" &&
    y < WAVE_STOP_Y - 0.11 &&
    Math.random() < EARLY_END_WAVE_CHANCE;
  const endY = endsOffshore
    ? randomBetween(y + 0.075, WAVE_STOP_Y - 0.025)
    : WAVE_STOP_Y;
  const wave = {
    id: `wave-${waveSequence}`,
    number: waveSequence,
    x,
    y,
    width: motionType === "alongshore" ? randomBetween(0.08, 0.14) : randomBetween(0.14, 0.27),
    tilt: motionType === "alongshore" ? randomBetween(85, 95) : randomBetween(-4.5, 4.5),
    speed: 0,
    motionType,
    directionX,
    endX: motionType === "alongshore" ? (directionX > 0 ? 1.035 : -0.035) : x,
    endY: motionType === "alongshore" ? y : endY,
    status: "moving",
    stoppedAt: null,
    seed: Math.floor(Math.random() * 0xffffffff),
    waveStartX: x,
    waveStartY: null,
    waveLifetimeDuration: 0,
    waveElapsedSeconds: 0,
    envelopeStarted: false,
    audioNode: null,
    element: null,
  };
  wave.speed = waveSpeedAt(wave.y);
  wave.waveStartY = wave.y;
  wave.waveLifetimeDuration = waveTrajectoryDuration(wave);

  const element = document.createElement("button");
  element.type = "button";
  element.className = `moving-wave ${wave.motionType === "alongshore" ? "alongshore-wave" : ""}`.trim();
  element.dataset.id = wave.id;
  element.style.left = `${wave.x * 100}%`;
  element.style.top = `${wave.y * 100}%`;
  element.style.width = `${wave.width * 100}%`;
  element.style.setProperty("--wave-tilt", `${wave.tilt}deg`);
  element.setAttribute("aria-label", waveAriaLabel(wave));
  element.innerHTML = '<span class="wave-crest"></span><span class="wave-foam"></span>';
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    setSelectedWave(wave.id);
  });
  wave.element = element;
  waves.push(wave);
  waveLayer.appendChild(element);
  updateWaveCount();
  startWaveLifetimeAudio(wave);
  return wave;
}

function removeFlyingGull(id) {
  const index = flyingGulls.findIndex((gull) => gull.id === id);
  if (index === -1) return;
  const [removed] = flyingGulls.splice(index, 1);
  removed.element.remove();
}

function clearFlyingGulls() {
  [...flyingGulls].forEach((gull) => removeFlyingGull(gull.id));
}

function flightDistanceToBoundary(x, y, heading) {
  const radians = (heading * Math.PI) / 180;
  const dx = Math.sin(radians);
  const dy = -Math.cos(radians);
  const distances = [];

  if (dx > 0.0001) distances.push(((1 - x) * WORLD_WIDTH_METERS) / dx);
  if (dx < -0.0001) distances.push((x * WORLD_WIDTH_METERS) / -dx);
  if (dy > 0.0001) distances.push(((1 - y) * WORLD_HEIGHT_METERS) / dy);
  if (dy < -0.0001) distances.push((y * WORLD_HEIGHT_METERS) / -dy);
  return Math.min(...distances);
}

function spawnFlyingGull() {
  flyingGullSequence += 1;
  const x = randomBetween(0.10, 0.90);
  const y = randomBetween(0.07, 0.64);
  const speed = randomBetween(FLYING_GULL_MIN_SPEED_MPS, FLYING_GULL_MAX_SPEED_MPS);
  let heading = x < 0.5 ? 90 : 270;
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const candidate = randomBetween(0, 360);
    if (flightDistanceToBoundary(x, y, candidate) >= speed * SOURCE_DURATION_SECONDS) {
      heading = candidate;
      break;
    }
  }
  const gull = {
    id: `flying-gull-${flyingGullSequence}`,
    number: flyingGullSequence,
    x,
    y,
    heading,
    speed,
    element: null,
  };

  const element = document.createElement("div");
  element.className = "flying-seagull";
  element.dataset.id = gull.id;
  element.style.left = `${gull.x * 100}%`;
  element.style.top = `${gull.y * 100}%`;
  element.style.setProperty("--gull-heading", `${gull.heading}deg`);
  element.setAttribute(
    "aria-label",
    `Seagull ${gull.number}, flying at heading ${Math.round(gull.heading)} degrees`,
  );
  element.innerHTML = `
    <span class="flying-gull-shadow" aria-hidden="true"></span>
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <path class="gull-wings" d="M31.5 30C24 21 15 17 5 18c7 4 12 9 16 17l10.5 3 10.5-3c4-8 9-13 16-17-10-1-19 3-26.5 12Z" />
      <path class="gull-body" d="M32 8c4 6 5 14 3.5 24L32 56l-3.5-24C27 22 28 14 32 8Z" />
      <path class="gull-beak" d="m32 6-3 6h6Z" />
    </svg>`;
  gull.element = element;
  flyingGulls.push(gull);
  flyingGullLayer.appendChild(element);
  playFlyingGullCall(gull);
  return gull;
}

function animateFlyingGulls(elapsedSeconds) {
  [...flyingGulls].forEach((gull) => {
    const radians = (gull.heading * Math.PI) / 180;
    gull.x += (Math.sin(radians) * gull.speed * elapsedSeconds) / WORLD_WIDTH_METERS;
    gull.y -= (Math.cos(radians) * gull.speed * elapsedSeconds) / WORLD_HEIGHT_METERS;
    gull.element.style.left = `${gull.x * 100}%`;
    gull.element.style.top = `${gull.y * 100}%`;

    if (
      gull.x < -FLYING_GULL_MARGIN ||
      gull.x > 1 + FLYING_GULL_MARGIN ||
      gull.y < -FLYING_GULL_MARGIN ||
      gull.y > 1 + FLYING_GULL_MARGIN
    ) {
      removeFlyingGull(gull.id);
    }
  });
}

function animatePlacedWaveSources(now, elapsedSeconds) {
  let selectedWaveMoved = false;
  const completedWaveIds = [];
  sources.forEach((source) => {
    if (source.type !== "wave" || source.status !== "moving") return;
    const finished = advanceWaveTrajectory(source, elapsedSeconds);
    source.waveElapsedSeconds = Math.min(
      source.waveLifetimeDuration,
      source.waveElapsedSeconds + elapsedSeconds,
    );
    if (finished) {
      source.speed = 0;
      source.status = "stopped";
      source.waveElapsedSeconds = source.waveLifetimeDuration;
      source.element.classList.remove("moving-to-shore");
      source.element.classList.remove("is-playing");
      completedWaveIds.push(source.id);
    }
    source.element.style.top = `${source.y * 100}%`;
    if (selectedSourceId === source.id) selectedWaveMoved = true;
  });

  completedWaveIds.forEach((id) => removeSource(id));

  if (selectedWaveMoved && selectedSourceId) {
    updateReadout();
    if (now - lastMovingWaveformUpdate > 140) {
      lastMovingWaveformUpdate = now;
      scheduleWaveformUpdate();
    }
  }
}

function animateWaves(now) {
  const elapsedSeconds = Math.min(0.06, (now - lastAnimationTime) / 1000);
  lastAnimationTime = now;

  if (!document.hidden) {
    animatePlacedWaveSources(now, elapsedSeconds);
    if (activePage === "waves") {
      [...waves].forEach((wave) => {
        if (wave.status === "moving") {
          const finished = advanceWaveTrajectory(wave, elapsedSeconds);
          wave.waveElapsedSeconds = Math.min(
            wave.waveLifetimeDuration,
            wave.waveElapsedSeconds + elapsedSeconds,
          );
          wave.element.style.left = `${wave.x * 100}%`;
          wave.element.style.top = `${wave.y * 100}%`;

          if (finished) {
            wave.speed = 0;
            wave.waveElapsedSeconds = wave.waveLifetimeDuration;
            const reachedShore =
              wave.motionType !== "alongshore" && wave.endY >= WAVE_STOP_Y - 0.005;
            if (reachedShore) {
              wave.status = "stopped";
              wave.stoppedAt = now;
              wave.element.classList.add("at-shore");
              wave.element.setAttribute("aria-label", `Wave ${wave.number}, stopped at shore`);
              updateWaveCount();
            } else {
              removeWave(wave.id);
            }
          } else {
            wave.element.setAttribute("aria-label", waveAriaLabel(wave));
          }
        } else if (now - wave.stoppedAt > 6500) {
          removeWave(wave.id);
        }
      });

      if (now >= nextWaveAt) {
        spawnWave();
        nextWaveAt = now + nextWaveDelayMs();
      }

      animateFlyingGulls(elapsedSeconds);
      if (nextFlyingGullAt !== null && now >= nextFlyingGullAt) {
        spawnFlyingGull();
        nextFlyingGullAt += FLYING_GULL_INTERVAL_MS;
      }
    }

    if (selectedWaveId) updateWaveReadout();
  }

  window.requestAnimationFrame(animateWaves);
}

function addSpatialSample(target, sample, delaySamples, gain, inputIndex) {
  const delayedIndex = inputIndex + delaySamples;
  const wholeIndex = Math.floor(delayedIndex);
  const fraction = delayedIndex - wholeIndex;
  if (wholeIndex < target.length) target[wholeIndex] += sample * gain * (1 - fraction);
  if (wholeIndex + 1 < target.length) target[wholeIndex + 1] += sample * gain * fraction;
}

function waveEnvelope(lifecycleProgress) {
  const progress = clamp(lifecycleProgress, 0, 1);
  const center = 0.5;
  const sigma = 0.22;
  const raw = Math.exp(-0.5 * ((progress - center) / sigma) ** 2);
  const edge = Math.exp(-0.5 * (center / sigma) ** 2);
  return clamp((raw - edge) / (1 - edge), 0, 1);
}

function buildWaveNoiseSamples(
  sampleRate,
  seed,
  durationSeconds,
  elapsedOffsetSeconds = 0,
  lifetimeDurationSeconds = durationSeconds,
) {
  const length = Math.max(1, Math.ceil(sampleRate * durationSeconds));
  const samples = new Float32Array(length);
  const random = seededNoise(seed);
  for (let index = 0; index < length; index += 1) {
    const fragmentProgress = length === 1 ? 1 : index / (length - 1);
    const lifecycleTime = elapsedOffsetSeconds + fragmentProgress * durationSeconds;
    const lifecycleProgress =
      lifetimeDurationSeconds > 0 ? lifecycleTime / lifetimeDurationSeconds : 1;
    samples[index] = random() * waveEnvelope(lifecycleProgress) * 0.72;
  }
  return samples;
}

function buildMovingWaveSpatialBuffer(
  context,
  wave,
  seed = (wave.seed ?? wave.noiseSeed ?? 0) + Date.now(),
  providedSamples = null,
  options = {},
) {
  const sampleRate = context.sampleRate;
  const startX = options.startX ?? wave.x;
  const startY = options.startY ?? wave.y;
  const simulatedWave = {
    x: startX,
    y: startY,
    motionType: options.motionType ?? wave.motionType ?? "shoreward",
    directionX: options.directionX ?? wave.directionX ?? 0,
    endX: options.endX ?? wave.endX ?? startX,
    endY: options.endY ?? wave.endY ?? WAVE_STOP_Y,
    speed: waveSpeedAt(startY),
  };
  const elapsedOffsetSeconds = options.elapsedOffsetSeconds ?? 0;
  const lifetimeDurationSeconds =
    options.lifetimeDurationSeconds ??
    waveTrajectoryDuration(simulatedWave, startX, startY) + elapsedOffsetSeconds;
  const durationSeconds =
    options.durationSeconds ?? Math.max(0, lifetimeDurationSeconds - elapsedOffsetSeconds);
  const sourceSamples =
    providedSamples ||
    buildWaveNoiseSamples(
      sampleRate,
      seed,
      durationSeconds,
      elapsedOffsetSeconds,
      lifetimeDurationSeconds,
    );
  const inputLength = sourceSamples.length;
  const maximumTravelDistance = Math.hypot(WORLD_WIDTH_METERS, WORLD_HEIGHT_METERS) + 1;
  const maximumDelaySamples = Math.ceil((maximumTravelDistance / SPEED_OF_SOUND) * sampleRate);
  const buffer = context.createBuffer(2, inputLength + maximumDelaySamples + 2, sampleRate);
  const leftChannel = buffer.getChannelData(0);
  const rightChannel = buffer.getChannelData(1);
  const ears = getEarPositions();

  for (let index = 0; index < inputLength; index += 1) {
    const sample = sourceSamples[index];
    const sourcePosition = physicalPoint(simulatedWave);
    const leftDistance = distanceBetween(sourcePosition, ears.left);
    const rightDistance = distanceBetween(sourcePosition, ears.right);

    addSpatialSample(
      leftChannel,
      sample,
      (leftDistance / SPEED_OF_SOUND) * sampleRate,
      distanceGain(leftDistance),
      index,
    );
    addSpatialSample(
      rightChannel,
      sample,
      (rightDistance / SPEED_OF_SOUND) * sampleRate,
      distanceGain(rightDistance),
      index,
    );

    advanceWaveTrajectory(simulatedWave, 1 / sampleRate);
  }

  return buffer;
}

function buildMovingSeagullSpatialBuffer(context, gull, seagullSamples) {
  const sampleRate = context.sampleRate;
  const maximumTravelDistance = Math.hypot(WORLD_WIDTH_METERS, WORLD_HEIGHT_METERS) + 1;
  const maximumDelaySamples = Math.ceil((maximumTravelDistance / SPEED_OF_SOUND) * sampleRate);
  const buffer = context.createBuffer(
    2,
    seagullSamples.length + maximumDelaySamples + 2,
    sampleRate,
  );
  const leftChannel = buffer.getChannelData(0);
  const rightChannel = buffer.getChannelData(1);
  const ears = getEarPositions();
  const radians = (gull.heading * Math.PI) / 180;
  let simulatedX = gull.x;
  let simulatedY = gull.y;

  for (let index = 0; index < seagullSamples.length; index += 1) {
    const sourcePosition = physicalPoint({ x: simulatedX, y: simulatedY });
    const leftDistance = distanceBetween(sourcePosition, ears.left);
    const rightDistance = distanceBetween(sourcePosition, ears.right);
    const sample = seagullSamples[index];

    addSpatialSample(
      leftChannel,
      sample,
      (leftDistance / SPEED_OF_SOUND) * sampleRate,
      distanceGain(leftDistance),
      index,
    );
    addSpatialSample(
      rightChannel,
      sample,
      (rightDistance / SPEED_OF_SOUND) * sampleRate,
      distanceGain(rightDistance),
      index,
    );

    simulatedX += Math.sin(radians) * gull.speed / (WORLD_WIDTH_METERS * sampleRate);
    simulatedY -= Math.cos(radians) * gull.speed / (WORLD_HEIGHT_METERS * sampleRate);
  }

  return buffer;
}

async function playFlyingGullCall(gull) {
  if (!waveAudioEnabled || activePage !== "waves" || !audioContext) return;

  try {
    const seagullSamples = await loadSeagullSamples(audioContext);
    if (!flyingGulls.some((item) => item.id === gull.id) || activePage !== "waves") return;

    const compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.knee.value = 18;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.18;

    const gullGain = audioContext.createGain();
    gullGain.gain.value = 1.25;
    compressor.connect(gullGain);
    gullGain.connect(audioContext.destination);

    const node = audioContext.createBufferSource();
    node.buffer = buildMovingSeagullSpatialBuffer(audioContext, gull, seagullSamples);
    node.connect(compressor);
    node.addEventListener("ended", () => {
      activeWaveAudioNodes.delete(node);
      gull.element?.classList.remove("is-calling");
      compressor.disconnect();
      gullGain.disconnect();
    });
    activeWaveAudioNodes.add(node);
    gull.element.classList.add("is-calling");
    node.start(audioContext.currentTime + 0.02);
  } catch (error) {
    console.error("The flying seagull call could not be played.", error);
  }
}

function startWaveLifetimeAudio(wave) {
  if (
    !waveAudioEnabled ||
    activePage !== "waves" ||
    !audioContext ||
    wave.status !== "moving" ||
    wave.audioNode ||
    wave.envelopeStarted
  ) {
    return;
  }

  const elapsedOffsetSeconds = wave.waveElapsedSeconds || 0;
  const remainingDuration = Math.max(
    0,
    wave.waveLifetimeDuration - elapsedOffsetSeconds,
  );
  if (remainingDuration <= 0) return;

  const compressor = audioContext.createDynamicsCompressor();
  compressor.threshold.value = -12;
  compressor.knee.value = 20;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.2;

  const masterGain = audioContext.createGain();
  masterGain.gain.value = 1.2;
  compressor.connect(masterGain);
  masterGain.connect(audioContext.destination);

  const node = audioContext.createBufferSource();
  node.buffer = buildMovingWaveSpatialBuffer(
    audioContext,
    wave,
    wave.seed + Math.floor(elapsedOffsetSeconds * 1000),
    null,
    {
      startY: wave.y,
      elapsedOffsetSeconds,
      lifetimeDurationSeconds: wave.waveLifetimeDuration,
      durationSeconds: remainingDuration,
    },
  );
  node.connect(compressor);
  node.addEventListener("ended", () => {
    activeWaveAudioNodes.delete(node);
    if (wave.audioNode === node) wave.audioNode = null;
    wave.element?.classList.remove("is-sounding");
    compressor.disconnect();
    masterGain.disconnect();
  });
  wave.envelopeStarted = true;
  wave.audioNode = node;
  activeWaveAudioNodes.add(node);
  wave.element.style.setProperty("--wave-sound-duration", `${remainingDuration.toFixed(3)}s`);
  wave.element.classList.add("is-sounding");
  node.start(audioContext.currentTime + 0.02);
}

async function enableWaveAudio() {
  if (waveAudioEnabled) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    showToast("This browser does not support Web Audio");
    return;
  }

  waveAudioEnabled = true;
  audioContext ??= new AudioContextClass();
  if (audioContext.state === "suspended") await audioContext.resume();
  if (waveAudioEnabled && activePage === "waves") {
    waves.forEach((wave) => startWaveLifetimeAudio(wave));
  }
}

function disableWaveAudio() {
  waveAudioEnabled = false;
  activeWaveAudioNodes.forEach((node) => {
    try {
      node.stop();
    } catch {
      // A node that has already ended needs no further cleanup.
    }
  });
  activeWaveAudioNodes.clear();
  waves.forEach((wave) => {
    wave.audioNode = null;
  });
  waveLayer.querySelectorAll(".moving-wave").forEach((element) => element.classList.remove("is-sounding"));
}

function setActivePage(page) {
  if (page !== "sources") stopSceneAudio();
  activePage = page;
  document.querySelector(".app-shell").dataset.page = page;
  pageViews.forEach((view) => {
    view.hidden = view.id !== `${page}-page`;
  });
  pageTabs.forEach((tab) => {
    const isActive = tab.dataset.page === page;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });
  if (page === "waves") {
    if (waves.length === 0) spawnWave();
    nextWaveAt = performance.now() + nextWaveDelayMs();
    nextFlyingGullAt = performance.now() + FLYING_GULL_INTERVAL_MS;
    waveScene.focus({ preventScroll: true });
    enableWaveAudio();
  } else {
    nextFlyingGullAt = null;
    clearFlyingGulls();
    disableWaveAudio();
    if (page === "sources") scene.focus({ preventScroll: true });
  }
  window.Surf3D?.setActive(page === "surf");
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.remove("visible"), 2200);
}

document.querySelectorAll(".source-tool").forEach((tool) => {
  tool.addEventListener("pointerdown", beginPaletteDrag);
});

document.addEventListener("pointermove", handlePointerMove);
document.addEventListener("pointerup", endPointerDrag);
document.addEventListener("pointercancel", endPointerDrag);
document.addEventListener("keydown", handleKeyboard);
playButton.addEventListener("click", playScene);
waveRateSlider.addEventListener("input", updateWaveRate);
addWaveButton.addEventListener("click", () => {
  const wave = spawnWave();
  if (wave) {
    setSelectedWave(wave.id);
    showToast(`Wave ${String(wave.number).padStart(2, "0")} added offshore`);
  } else {
    showToast("The wave field is currently full");
  }
});
removeButton.addEventListener("click", removeSelected);
pageTabs.forEach((tab) => {
  tab.addEventListener("click", () => setActivePage(tab.dataset.page));
});
scene.addEventListener("pointerdown", (event) => {
  if (event.target === scene || event.target.closest(".water, .sand, .shoreline")) {
    setSelected(null);
    scene.focus({ preventScroll: true });
  }
});
waveScene.addEventListener("pointerdown", (event) => {
  if (event.target === waveScene || event.target.closest(".water, .sand, .shoreline")) {
    setSelectedWave(null);
    waveScene.focus({ preventScroll: true });
  }
});

window.addEventListener("blur", () => {
  if (!dragState) return;
  dragState = null;
  scene.classList.remove("accepts-drop");
  dragGhost.className = "drag-ghost";
  document.body.style.userSelect = "";
});

updateListener();
updateSourceCount();
updateWaveRate();
spawnWave(0.18);
updateWaveCount();
window.requestAnimationFrame(animateWaves);
