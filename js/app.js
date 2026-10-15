import { assessOffside, lineDirectionAt, buildPerspective } from './offside.js';

const $ = id => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const video = $('video');

const MAX_SIZE = 2400; // grotere beelden worden verkleind voor snelheid
const COLORS = { attacker: '#ff4d4d', defender: '#4da3ff', ball: '#ffd84d', line: '#d07bff' };

const TOOL_HELP = {
  attacker: 'Klik op het voorste lichaamsdeel van de aanvaller (voet/knie/hoofd, geen armen).',
  defender: 'Klik op het achterste lichaamsdeel van de verdediger(s). Meerdere mag: de app kiest de voorlaatste.',
  ball: 'Optioneel: klik op de bal op het moment van de pass.',
  line: 'Klik twee punten op een lijn die parallel loopt aan de doellijn (16-meter, 5-meter, maaibaan). Teken er minstens twee.',
  erase: 'Klik op een markering of lijn om hem te verwijderen.',
};

const state = {
  source: null,         // canvas met het huidige beeld
  attacker: null,
  defenders: [],
  ball: null,
  lines: [],
  pendingLine: null,    // {p1} terwijl je een lijn tekent
  hover: null,
  detections: [],       // [{x,y,w,h,score}]
  tool: 'attacker',
  direction: 'right',
  fromVideo: false,
  drag: null,           // {target}
};

// ---------- Laden van foto / video ----------

$('fileInput').addEventListener('change', e => loadFile(e.target.files[0]));

const upload = $('upload');
upload.addEventListener('dragover', e => { e.preventDefault(); upload.classList.add('drag'); });
upload.addEventListener('dragleave', () => upload.classList.remove('drag'));
upload.addEventListener('drop', e => {
  e.preventDefault();
  upload.classList.remove('drag');
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});

function loadFile(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  if (file.type.startsWith('video/')) {
    video.src = url;
    $('videoControls').hidden = false;
    setStatus('Video geladen. Spoel naar het moment van de pass en klik op "Gebruik dit frame".');
  } else {
    const img = new Image();
    img.onload = () => {
      $('videoControls').hidden = true;
      video.removeAttribute('src');
      setSource(img, img.naturalWidth, img.naturalHeight, false);
      URL.revokeObjectURL(url);
    };
    img.onerror = () => setStatus('Kon deze afbeelding niet openen.');
    img.src = url;
  }
}

const FRAME = 1 / 30;
$('stepBack').addEventListener('click', () => { video.pause(); video.currentTime = Math.max(0, video.currentTime - FRAME); });
$('stepFwd').addEventListener('click', () => { video.pause(); video.currentTime = Math.min(video.duration || 0, video.currentTime + FRAME); });
$('grabFrame').addEventListener('click', () => {
  if (!video.videoWidth) return setStatus('De video is nog niet klaar om een frame te pakken.');
  video.pause();
  setSource(video, video.videoWidth, video.videoHeight, true);
});

function setSource(el, w, h, fromVideo) {
  const scale = Math.min(1, MAX_SIZE / Math.max(w, h));
  const src = document.createElement('canvas');
  src.width = Math.round(w * scale);
  src.height = Math.round(h * scale);
  src.getContext('2d').drawImage(el, 0, 0, src.width, src.height);
  state.source = src;
  state.fromVideo = fromVideo;
  canvas.width = src.width;
  canvas.height = src.height;
  resetMarks();
  $('canvasWrap').hidden = false;
  setStatus(fromVideo
    ? `Frame op ${video.currentTime.toFixed(2)} s gebruikt. Markeer nu de spelers.`
    : 'Beeld geladen. Markeer nu de aanvaller en de verdediger(s).');
  render();
}

function resetMarks() {
  Object.assign(state, { attacker: null, defenders: [], ball: null, lines: [], pendingLine: null, detections: [] });
}

// ---------- Gereedschap en instellingen ----------

document.querySelectorAll('.tool').forEach(btn => btn.addEventListener('click', () => setTool(btn.dataset.tool)));
function setTool(tool) {
  state.tool = tool;
  state.pendingLine = null;
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  $('toolHelp').textContent = TOOL_HELP[tool];
  render();
}
setTool('attacker');

document.querySelectorAll('.seg-btn').forEach(btn => btn.addEventListener('click', () => {
  state.direction = btn.dataset.dir;
  document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b === btn));
  render();
}));
$('camera').addEventListener('change', render);
$('ownHalf').addEventListener('change', render);
$('clearBtn').addEventListener('click', () => {
  const dets = state.detections;
  resetMarks();
  state.detections = dets;
  render();
});

// ---------- Interactie met het beeld ----------

function toImage(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * canvas.width / r.width,
    y: (e.clientY - r.top) * canvas.height / r.height,
  };
}
const pxScale = () => canvas.width / canvas.getBoundingClientRect().width;

function allMarkers() {
  const list = [];
  if (state.attacker) list.push({ kind: 'attacker', p: state.attacker });
  state.defenders.forEach(p => list.push({ kind: 'defender', p }));
  if (state.ball) list.push({ kind: 'ball', p: state.ball });
  state.lines.forEach(l => { list.push({ kind: 'linept', p: l.p1, line: l }); list.push({ kind: 'linept', p: l.p2, line: l }); });
  return list;
}

function nearestMarker(pt, radius) {
  let best = null, bestD = radius;
  for (const m of allMarkers()) {
    const d = Math.hypot(m.p.x - pt.x, m.p.y - pt.y);
    if (d < bestD) { best = m; bestD = d; }
  }
  return best;
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Kleinste gedetecteerde speler waar het punt in valt (voor de schaal). */
function playerHeightAt(pt) {
  const pad = 0.1;
  const hits = state.detections.filter(d =>
    pt.x >= d.x - d.w * pad && pt.x <= d.x + d.w * (1 + pad) &&
    pt.y >= d.y - d.h * pad && pt.y <= d.y + d.h * (1 + pad));
  if (!hits.length) return undefined;
  hits.sort((a, b) => a.w * a.h - b.w * b.h);
  return hits[0].h;
}

function makePlayerPoint(pt) {
  return { x: pt.x, y: pt.y, height: playerHeightAt(pt) };
}

canvas.addEventListener('pointerdown', e => {
  if (!state.source) return;
  const pt = toImage(e);
  const radius = 16 * pxScale();

  if (state.tool === 'erase') {
    eraseAt(pt, radius);
    return render();
  }

  if (state.tool !== 'line') {
    const hit = nearestMarker(pt, radius);
    if (hit) {
      state.drag = hit;
      canvas.setPointerCapture(e.pointerId);
      return;
    }
  }

  switch (state.tool) {
    case 'attacker': state.attacker = makePlayerPoint(pt); break;
    case 'defender': state.defenders.push(makePlayerPoint(pt)); break;
    case 'ball': state.ball = { x: pt.x, y: pt.y }; break;
    case 'line':
      if (!state.pendingLine) state.pendingLine = { p1: pt };
      else {
        const p1 = state.pendingLine.p1;
        if (Math.hypot(p1.x - pt.x, p1.y - pt.y) > 10 * pxScale()) state.lines.push({ p1, p2: pt });
        state.pendingLine = null;
      }
      break;
  }
  render();
});

canvas.addEventListener('pointermove', e => {
  if (!state.source) return;
  const pt = toImage(e);
  if (state.drag) {
    state.drag.p.x = pt.x;
    state.drag.p.y = pt.y;
    if (state.drag.kind === 'attacker' || state.drag.kind === 'defender') state.drag.p.height = playerHeightAt(pt);
    render();
  } else if (state.pendingLine) {
    state.hover = pt;
    render();
  }
});

const endDrag = () => { state.drag = null; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

function eraseAt(pt, radius) {
  const hit = nearestMarker(pt, radius);
  if (hit) {
    if (hit.kind === 'attacker') state.attacker = null;
    else if (hit.kind === 'ball') state.ball = null;
    else if (hit.kind === 'defender') state.defenders = state.defenders.filter(p => p !== hit.p);
    else if (hit.kind === 'linept') state.lines = state.lines.filter(l => l !== hit.line);
    return;
  }
  const line = state.lines.find(l => distToSegment(pt, l.p1, l.p2) < radius);
  if (line) state.lines = state.lines.filter(l => l !== line);
}

// ---------- AI-spelerdetectie (COCO-SSD via TensorFlow.js) ----------

let modelPromise = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Kon ${src} niet laden`));
    document.head.appendChild(s);
  });
}
function loadModel() {
  modelPromise ??= (async () => {
    await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
    await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js');
    return window.cocoSsd.load({ base: 'lite_mobilenet_v2' });
  })().catch(err => { modelPromise = null; throw err; });
  return modelPromise;
}

$('detectBtn').addEventListener('click', async () => {
  if (!state.source) return setStatus('Laad eerst een foto of video-frame.');
  const btn = $('detectBtn');
  btn.disabled = true;
  setStatus('AI-model laden en spelers zoeken…');
  try {
    const model = await loadModel();
    const preds = await model.detect(state.source, 40, 0.35);
    state.detections = preds
      .filter(p => p.class === 'person')
      .map(p => ({ x: p.bbox[0], y: p.bbox[1], w: p.bbox[2], h: p.bbox[3], score: p.score }));
    // Bestaande markeringen krijgen alsnog een schaal
    if (state.attacker) state.attacker.height = playerHeightAt(state.attacker);
    state.defenders.forEach(d => { d.height = playerHeightAt(d); });
    setStatus(state.detections.length
      ? `${state.detections.length} speler(s) gevonden. Klik binnen een kader om die speler te markeren.`
      : 'Geen spelers gevonden. Je kunt gewoon handmatig markeren.');
  } catch (err) {
    setStatus(`Detectie mislukt: ${err.message}. Handmatig markeren werkt wel.`);
  } finally {
    btn.disabled = false;
    render();
  }
});

// ---------- Tekenen ----------

/** Lijn door p met richting d, over het hele beeld. */
function drawInfiniteLine(p, d, color, width, dash) {
  const L = (canvas.width + canvas.height) * 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash || []);
  ctx.beginPath();
  ctx.moveTo(p.x - d.x * L, p.y - d.y * L);
  ctx.lineTo(p.x + d.x * L, p.y + d.y * L);
  ctx.stroke();
  ctx.restore();
}

function drawMarker(p, color, label, s) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 7 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (label) {
    ctx.font = `600 ${13 * s}px system-ui, sans-serif`;
    ctx.lineWidth = 3 * s;
    ctx.strokeText(label, p.x + 10 * s, p.y - 10 * s);
    ctx.fillText(label, p.x + 10 * s, p.y - 10 * s);
  }
  ctx.restore();
}

function render() {
  const result = computeResult();
  if (!state.source) return;
  const s = pxScale();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.source, 0, 0);

  // Detecties
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.55)';
  ctx.lineWidth = 1.5 * s;
  ctx.setLineDash([4 * s, 4 * s]);
  state.detections.forEach(d => ctx.strokeRect(d.x, d.y, d.w, d.h));
  ctx.restore();

  // Referentielijnen
  state.lines.forEach(l => {
    ctx.save();
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 3 * s;
    ctx.beginPath();
    ctx.moveTo(l.p1.x, l.p1.y);
    ctx.lineTo(l.p2.x, l.p2.y);
    ctx.stroke();
    ctx.restore();
    drawMarker(l.p1, COLORS.line, '', s * 0.7);
    drawMarker(l.p2, COLORS.line, '', s * 0.7);
  });
  if (state.pendingLine) {
    drawMarker(state.pendingLine.p1, COLORS.line, '', s * 0.7);
    if (state.hover) {
      ctx.save();
      ctx.strokeStyle = COLORS.line;
      ctx.setLineDash([6 * s, 6 * s]);
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.moveTo(state.pendingLine.p1.x, state.pendingLine.p1.y);
      ctx.lineTo(state.hover.x, state.hover.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Buitenspellijnen
  const persp = buildPerspective(state.lines);
  if (result && !result.error) {
    const ref = result.reference;
    drawInfiniteLine(ref, lineDirectionAt(persp, ref), result.referenceKind === 'ball' ? COLORS.ball : COLORS.defender, 3 * s);
    drawInfiniteLine(state.attacker, lineDirectionAt(persp, state.attacker), COLORS.attacker, 2 * s, [10 * s, 6 * s]);
  }

  // Markeringen
  state.defenders.forEach(p => {
    const isRef = result && !result.error && result.secondLast === p;
    drawMarker(p, COLORS.defender, isRef ? 'voorlaatste' : '', s);
  });
  if (state.ball) drawMarker(state.ball, COLORS.ball, 'bal', s);
  if (state.attacker) drawMarker(state.attacker, COLORS.attacker, 'aanvaller', s);

  // Aanvalsrichting
  ctx.save();
  ctx.font = `700 ${22 * s}px system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.strokeStyle = 'rgba(0,0,0,.7)';
  ctx.lineWidth = 4 * s;
  const arrow = state.direction === 'right' ? 'aanval →' : '← aanval';
  const tx = state.direction === 'right' ? canvas.width - ctx.measureText(arrow).width - 12 * s : 12 * s;
  ctx.strokeText(arrow, tx, 30 * s);
  ctx.fillText(arrow, tx, 30 * s);
  ctx.restore();
}

// ---------- Uitslag ----------

function computeResult() {
  const result = state.attacker || state.defenders.length ? assessOffside({
    attacker: state.attacker,
    defenders: state.defenders,
    ball: state.ball,
    refLines: state.lines,
    direction: state.direction,
    camera: $('camera').value,
    imageHeight: canvas.height,
    fromVideo: state.fromVideo,
    ownHalf: $('ownHalf').checked,
  }) : null;
  showResult(result);
  return result;
}

function showResult(r) {
  const pct = $('pct'), verdict = $('verdict'), detail = $('detail'), notes = $('notes');
  const gauge = document.querySelector('.gauge');
  pct.className = 'pct';
  verdict.className = 'verdict';
  notes.innerHTML = '';
  if (!r || r.error) {
    pct.textContent = '–';
    verdict.textContent = r?.error || 'Markeer een aanvaller en minstens één verdediger.';
    detail.textContent = '';
    gauge.classList.remove('has-value');
    return;
  }
  const p = Math.round(r.probability * 100);
  pct.textContent = `${p}%`;
  pct.classList.add(r.verdict);
  verdict.classList.add(r.verdict);
  verdict.textContent = {
    offside: 'Buitenspel',
    onside: 'Geen buitenspel',
    doubt: 'Twijfelgeval',
  }[r.verdict];
  gauge.classList.add('has-value');
  $('gaugeFill').style.left = `${p}%`;

  const cm = Math.abs(r.distanceM * 100);
  const who = r.referenceKind === 'ball' ? 'de bal' : 'de voorlaatste verdediger';
  detail.textContent = cm < 5
    ? `Aanvaller staat vrijwel gelijk met ${who} (marge ± ${Math.round(r.sigmaM * 100)} cm).`
    : `Aanvaller staat ca. ${Math.round(cm)} cm ${r.distanceM > 0 ? 'vóór' : 'achter'} ${who} (marge ± ${Math.round(r.sigmaM * 100)} cm).`;
  r.notes.forEach(n => {
    const li = document.createElement('li');
    li.textContent = n;
    notes.appendChild(li);
  });
}

function setStatus(msg) { $('status').textContent = msg; }

window.addEventListener('resize', render);
render();
