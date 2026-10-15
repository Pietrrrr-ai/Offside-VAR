import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  intersectLines, buildPerspective, signedPixelDistance, assessOffside, normalCdf,
} from '../js/offside.js';

const line = (x1, y1, x2, y2) => ({ p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } });

test('snijpunt van twee lijnen', () => {
  const p = intersectLines(line(0, 0, 10, 10), line(0, 10, 10, 0));
  assert.ok(Math.abs(p.x - 5) < 1e-9 && Math.abs(p.y - 5) < 1e-9);
  assert.equal(intersectLines(line(0, 0, 10, 0), line(0, 5, 10, 5)), null);
});

test('normalCdf', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 1e-3);
});

test('zonder referentielijnen: verticale lijn, richting telt', () => {
  const persp = buildPerspective([]);
  const ref = { x: 100, y: 100 };
  assert.ok(signedPixelDistance(persp, ref, { x: 150, y: 300 }, 'right') > 0);
  assert.ok(signedPixelDistance(persp, ref, { x: 150, y: 300 }, 'left') < 0);
});

test('verdwijnpunt: punt op dezelfde perspectieflijn staat "gelijk"', () => {
  // Twee lijnen die elkaar snijden in (500, -1000)
  const persp = buildPerspective([line(400, 0, 300, 1000), line(600, 0, 700, 1000)]);
  assert.equal(persp.kind, 'vanishing');
  assert.ok(Math.abs(persp.vp.x - 500) < 1e-6 && Math.abs(persp.vp.y + 1000) < 1e-6);
  // Punten op de lijn door (500,-1000) en (300,1000): x = 500 - 0.1*(y+1000)
  const ref = { x: 400, y: 0 };
  const same = { x: 300, y: 1000 };
  assert.ok(Math.abs(signedPixelDistance(persp, ref, same, 'right')) < 1e-6);
  // Terwijl hij zonder perspectief duidelijk "achter" zou staan
  assert.ok(signedPixelDistance(buildPerspective([]), ref, same, 'right') < -50);
});

test('duidelijk buitenspel en duidelijk geen buitenspel', () => {
  const base = { defenders: [{ x: 500, y: 400, height: 180 }], camera: 'inline', direction: 'right' };
  const off = assessOffside({ ...base, attacker: { x: 700, y: 400, height: 180 } });
  assert.equal(off.verdict, 'offside');
  assert.ok(off.probability > 0.95);
  assert.ok(Math.abs(off.distanceM - 2) < 1e-9);

  const on = assessOffside({ ...base, attacker: { x: 300, y: 400, height: 180 } });
  assert.equal(on.verdict, 'onside');
  assert.ok(on.probability < 0.05);

  const level = assessOffside({ ...base, attacker: { x: 500, y: 400, height: 180 } });
  assert.ok(Math.abs(level.probability - 0.5) < 0.01);
  assert.equal(level.verdict, 'doubt');
});

test('schuine camera geeft minder zekerheid bij hetzelfde verschil', () => {
  const base = {
    attacker: { x: 560, y: 400, height: 180 },
    defenders: [{ x: 500, y: 400, height: 180 }],
  };
  const inline = assessOffside({ ...base, camera: 'inline' });
  const strong = assessOffside({ ...base, camera: 'strong' });
  assert.ok(inline.probability > strong.probability);
  assert.ok(strong.probability > 0.5);
});

test('voorlaatste verdediger wordt gekozen, niet de keeper', () => {
  const r = assessOffside({
    attacker: { x: 650, y: 400, height: 180 },
    defenders: [{ x: 900, y: 400 }, { x: 600, y: 400, height: 180 }, { x: 300, y: 400 }],
    camera: 'inline',
  });
  assert.equal(r.secondLast.x, 600);
  assert.equal(r.verdict, 'offside');
});

test('aanval naar links', () => {
  const r = assessOffside({
    attacker: { x: 300, y: 400, height: 180 },
    defenders: [{ x: 500, y: 400, height: 180 }, { x: 100, y: 400 }],
    direction: 'left', camera: 'inline',
  });
  assert.equal(r.secondLast.x, 500);
  assert.equal(r.verdict, 'offside');
});

test('bal voorbij de verdediger bepaalt de lijn', () => {
  const r = assessOffside({
    attacker: { x: 650, y: 400, height: 180 },
    defenders: [{ x: 500, y: 400, height: 180 }],
    ball: { x: 700, y: 420 },
    camera: 'inline',
  });
  assert.equal(r.referenceKind, 'ball');
  assert.equal(r.verdict, 'onside');
});

test('eigen helft is nooit buitenspel', () => {
  const r = assessOffside({
    attacker: { x: 900, y: 400, height: 180 },
    defenders: [{ x: 500, y: 400, height: 180 }],
    ownHalf: true,
  });
  assert.equal(r.probability, 0);
  assert.equal(r.verdict, 'onside');
});

test('foutmeldingen bij ontbrekende markeringen', () => {
  assert.ok(assessOffside({ defenders: [{ x: 1, y: 1 }] }).error);
  assert.ok(assessOffside({ attacker: { x: 1, y: 1 }, defenders: [] }).error);
});
