// Kern-logica voor de buitenspel-inschatting. Geen DOM-afhankelijkheden,
// zodat dit los getest kan worden (zie test/offside.test.mjs).
//
// Idee in het kort:
//  - Lijnen die in het echt parallel aan de doellijn lopen (16-meterlijn,
//    5-meterlijn, maaibanen in het gras) snijden elkaar op de foto in één
//    "verdwijnpunt". De buitenspellijn door een speler loopt ook naar dat punt.
//  - Zonder referentielijnen nemen we aan dat de camera op lijn staat en de
//    buitenspellijn verticaal in beeld loopt (met extra onzekerheid).
//  - De afstand tussen aanvaller en buitenspellijn wordt via de lengte van een
//    speler (~1,80 m) omgerekend naar meters, en via een normale verdeling
//    omgezet naar een kans op buitenspel.

export const PLAYER_HEIGHT_M = 1.8;

/** Snijpunt van twee (oneindige) lijnen, of null als ze (bijna) parallel zijn. */
export function intersectLines(a, b) {
  const x1 = a.p1.x, y1 = a.p1.y, x2 = a.p2.x, y2 = a.p2.y;
  const x3 = b.p1.x, y3 = b.p1.y, x4 = b.p2.x, y4 = b.p2.y;
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  const lenA = Math.hypot(x2 - x1, y2 - y1);
  const lenB = Math.hypot(x4 - x3, y4 - y3);
  if (lenA === 0 || lenB === 0) return null;
  // sin(hoek tussen lijnen) te klein -> praktisch parallel
  if (Math.abs(den) / (lenA * lenB) < 1e-4) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
}

/**
 * Verdwijnpunt uit twee of meer referentielijnen (gemiddelde van alle
 * onderlinge snijpunten). Geeft null als dat niet te bepalen is; dan zijn de
 * lijnen in beeld parallel en gebruiken we hun gemeenschappelijke richting.
 */
export function vanishingPoint(lines) {
  const pts = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const p = intersectLines(lines[i], lines[j]);
      if (p) pts.push(p);
    }
  }
  if (!pts.length) return null;
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  };
}

/** Gemiddelde (genormaliseerde) richting van de referentielijnen, naar beneden gericht. */
export function meanDirection(lines) {
  let dx = 0, dy = 0;
  for (const l of lines) {
    let ux = l.p2.x - l.p1.x, uy = l.p2.y - l.p1.y;
    const len = Math.hypot(ux, uy);
    if (!len) continue;
    ux /= len; uy /= len;
    if (uy < 0 || (uy === 0 && ux < 0)) { ux = -ux; uy = -uy; }
    dx += ux; dy += uy;
  }
  const len = Math.hypot(dx, dy);
  return len ? { x: dx / len, y: dy / len } : { x: 0, y: 1 };
}

/**
 * Bouwt het perspectiefmodel: voor elk punt in beeld kunnen we de richting van
 * de "doellijn-parallelle" lijn door dat punt opvragen.
 */
export function buildPerspective(lines) {
  const valid = (lines || []).filter(l => l && l.p1 && l.p2);
  if (valid.length >= 2) {
    const vp = vanishingPoint(valid);
    if (vp) return { kind: 'vanishing', vp };
    return { kind: 'direction', dir: meanDirection(valid) };
  }
  if (valid.length === 1) return { kind: 'direction', dir: meanDirection(valid) };
  return { kind: 'vertical', dir: { x: 0, y: 1 } };
}

/** Eenheidsvector langs de buitenspellijn door punt p (naar beneden in beeld). */
export function lineDirectionAt(persp, p) {
  if (persp.kind === 'vanishing') {
    let dx = persp.vp.x - p.x, dy = persp.vp.y - p.y;
    const len = Math.hypot(dx, dy);
    if (!len) return { x: 0, y: 1 };
    dx /= len; dy /= len;
    if (dy < 0 || (dy === 0 && dx < 0)) { dx = -dx; dy = -dy; }
    return { x: dx, y: dy };
  }
  return persp.dir;
}

/**
 * Getekende loodrechte afstand (pixels) van punt q tot de buitenspellijn door
 * punt ref. Positief = q ligt dichter bij het doel dan ref.
 * direction: 'right' (aanval naar rechts in beeld) of 'left'.
 */
export function signedPixelDistance(persp, ref, q, direction) {
  const d = lineDirectionAt(persp, ref);
  // normaal op de lijn; kies hem zo dat hij naar het doel wijst
  let nx = -d.y, ny = d.x;
  const goalSign = direction === 'left' ? -1 : 1;
  if (Math.sign(nx || 1) !== goalSign) { nx = -nx; ny = -ny; }
  return (q.x - ref.x) * nx + (q.y - ref.y) * ny;
}

/** Standaard-normale cumulatieve verdeling. */
export function normalCdf(z) {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

export const CAMERA_SIGMA = {
  inline: 0.12,     // camera staat (vrijwel) op lijn
  slight: 0.35,     // licht schuin
  strong: 0.8,      // sterk schuin / vanaf de zijkant achter het doel
};

/**
 * Hoofdfunctie.
 * input = {
 *   attacker: {x,y,height?},          // voorste lichaamsdeel aanvaller (height = spelerlengte in px)
 *   defenders: [{x,y,height?}, ...],   // verdedigers (evt. incl. keeper)
 *   ball: {x,y} | null,
 *   refLines: [{p1,p2}, ...],          // lijnen parallel aan de doellijn
 *   direction: 'left' | 'right',       // aanvalsrichting in beeld
 *   camera: 'inline' | 'slight' | 'strong',
 *   imageHeight: number,
 *   fromVideo: boolean,                // frame uit video -> moment van de pass onzeker
 *   ownHalf: boolean,                  // aanvaller op eigen helft -> nooit buitenspel
 * }
 */
export function assessOffside(input) {
  const {
    attacker, defenders = [], ball = null, refLines = [],
    direction = 'right', camera = 'slight', imageHeight = 1000,
    fromVideo = false, ownHalf = false,
  } = input;

  if (!attacker) return { error: 'Markeer eerst de aanvaller.' };
  if (!defenders.length) return { error: 'Markeer minstens één verdediger (de voorlaatste).' };

  const persp = buildPerspective(refLines);
  const notes = [];

  // Sorteer verdedigers: wie het dichtst bij het eigen doel staat eerst.
  const anchor = defenders[0];
  const ranked = defenders
    .map(p => ({ p, depth: signedPixelDistance(persp, anchor, p, direction) }))
    .sort((a, b) => b.depth - a.depth);

  let secondLast;
  if (ranked.length >= 2) {
    secondLast = ranked[1].p;
    notes.push(`${ranked.length} verdedigers gemarkeerd: de voorlaatste wordt gebruikt.`);
  } else {
    secondLast = ranked[0].p;
    notes.push('Eén verdediger gemarkeerd: aangenomen dat dit de voorlaatste is (keeper staat erachter).');
  }

  let reference = secondLast;
  let referenceKind = 'defender';
  if (ball && signedPixelDistance(persp, secondLast, ball, direction) > 0) {
    reference = ball;
    referenceKind = 'ball';
    notes.push('De bal ligt dichter bij het doel dan de voorlaatste verdediger: de bal bepaalt de lijn.');
  }

  const distPx = signedPixelDistance(persp, reference, attacker, direction);

  // Schaal: pixels per meter via spelerlengte (bounding box van detectie).
  const heights = [attacker.height, secondLast.height].filter(h => h && h > 0);
  let pxPerM;
  let scaleKnown = true;
  if (heights.length) {
    pxPerM = heights.reduce((s, h) => s + h, 0) / heights.length / PLAYER_HEIGHT_M;
  } else {
    pxPerM = imageHeight / 9; // grove aanname: ~9 m verticaal zichtbaar rond de spelers
    scaleKnown = false;
    notes.push('Geen spelerlengte bekend (geen detectie): schaal grof geschat, extra onzekerheid.');
  }
  const distM = distPx / pxPerM;

  // Onzekerheid opbouwen (meters, kwadratisch opgeteld).
  const parts = [0.12]; // markeerfout: welk lichaamsdeel precies
  parts.push(CAMERA_SIGMA[camera] ?? CAMERA_SIGMA.slight);
  if (persp.kind === 'vertical' && camera !== 'inline') {
    parts.push(0.5);
    notes.push('Geen referentielijnen getekend: buitenspellijn verticaal aangenomen. Teken 2 lijnen parallel aan de doellijn voor een betere inschatting.');
  } else if (persp.kind === 'direction') {
    parts.push(0.2);
  }
  if (fromVideo) {
    parts.push(0.25);
    notes.push('Frame uit video: het exacte moment van de pass is onzeker.');
  }
  let sigma = Math.sqrt(parts.reduce((s, v) => s + v * v, 0));
  if (!scaleKnown) sigma *= 1.4;

  let probability = normalCdf(distM / sigma);
  if (ownHalf) {
    probability = 0;
    notes.push('Aanvaller op eigen helft: kan niet buitenspel staan.');
  }
  // Nooit 0% of 100% claimen, behalve bij een harde regel.
  if (!ownHalf) probability = Math.min(0.99, Math.max(0.01, probability));

  let verdict;
  if (probability >= 0.65) verdict = 'offside';
  else if (probability <= 0.35) verdict = 'onside';
  else verdict = 'doubt';

  return {
    probability,
    verdict,
    distanceM: distM,
    distancePx: distPx,
    sigmaM: sigma,
    reference,
    referenceKind,
    secondLast,
    perspective: persp,
    notes,
  };
}
