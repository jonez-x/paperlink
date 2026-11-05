// Ink shared by the server, the exports and the browser (served at /ink.js).
//
// A stroke is one string, so it is its own identity in operations, undo and
// sync. Tokens are separated by single spaces:
//   [#rrggbb] [w<width>] [h] M x y l 0.01 0 [L x y]…   line of constant width
//   [#rrggbb] [w<width>] [h] V x y p [x y p]…          pressure p (0–1) varies the width
//   [#rrggbb] [w<size>] T x y <URI-encoded text>        text, top left at x y
// Without a colour the theme's ink is used; without w the width is 3 (text 24).
// h marks a highlighter: translucent and drawn below the ink. Files from before
// styles hold only the first form without prefixes, which stays valid.

export const DEFAULT_WIDTH = 3;
export const DEFAULT_TEXT_SIZE = 24;
export const HIGHLIGHT_OPACITY = 0.35;
export const LINE_HEIGHT = 1.25;
const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const FORMAT = new RegExp(String.raw`^(#[0-9a-f]{6} )?(w${NUMBER} )?(?:(h )?(M [-+\d.eE ,]+ l 0\.01 0(?: L [-+\d.eE ,]+)*|V(?: ${NUMBER})+)|T (${NUMBER}) (${NUMBER}) (\S+))$`);
const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

// The parts of a stroke, or null when the string is not one.
export function parseStroke(stroke) {
  const match = typeof stroke === 'string' && stroke.length <= 1000000 && FORMAT.exec(stroke);
  if (!match) return null;
  const [, colorToken, widthToken, highlightToken, line, x, y, encoded] = match;
  const color = colorToken ? colorToken.trim() : null;
  if (encoded !== undefined) {
    let text;
    try { text = decodeURIComponent(encoded); } catch { return null; }
    const size = widthToken ? Number(widthToken.slice(1)) : DEFAULT_TEXT_SIZE;
    if (!text || text.length > 4000 || !(size >= 4 && size <= 400) || !Number.isFinite(+x) || !Number.isFinite(+y)) return null;
    return { kind: 'text', color, width: size, x: +x, y: +y, text };
  }
  const width = widthToken ? Number(widthToken.slice(1)) : DEFAULT_WIDTH;
  if (!(width >= 0.5 && width <= 200)) return null;
  const highlighter = Boolean(highlightToken);
  if (line.startsWith('V')) {
    const numbers = line.slice(2).split(' ').map(Number);
    if (numbers.length % 3) return null;
    const points = [];
    for (let i = 0; i < numbers.length; i += 3) {
      const [px, py, p] = numbers.slice(i, i + 3);
      if (!Number.isFinite(px) || !Number.isFinite(py) || !(p >= 0 && p <= 1)) return null;
      points.push({ x: px, y: py, p });
    }
    return { kind: 'pressure', color, width, highlighter, points };
  }
  // Older files may hold odd separators; keep whatever pairs of numbers there are.
  const numbers = line.replace(' l 0.01 0', '').split(/[\s,]+/).filter(token => token !== 'M' && token !== 'L').map(Number);
  const points = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    if (Number.isFinite(numbers[i]) && Number.isFinite(numbers[i + 1])) points.push({ x: numbers[i], y: numbers[i + 1] });
  }
  return { kind: 'line', color, width, highlighter, points };
}

export const validStroke = stroke => parseStroke(stroke) !== null;

export function formatStroke({ kind = 'line', color = null, width, highlighter = false, points = [], x, y, text }) {
  const standard = kind === 'text' ? DEFAULT_TEXT_SIZE : DEFAULT_WIDTH;
  const style = (color ? color + ' ' : '') + (width !== undefined && width !== standard ? 'w' + round(width) + ' ' : '');
  if (kind === 'text') return style + 'T ' + round(x) + ' ' + round(y) + ' ' + encodeURIComponent(text);
  const prefix = style + (highlighter ? 'h ' : '');
  if (kind === 'pressure') return prefix + 'V ' + points.map(point => round(point.x) + ' ' + round(point.y) + ' ' + round(point.p ?? 0.5, 3)).join(' ');
  const [first, ...rest] = points;
  return prefix + 'M ' + round(first.x) + ' ' + round(first.y) + ' l 0.01 0' + rest.map(point => ' L ' + round(point.x) + ' ' + round(point.y)).join('');
}

// Radius at a pressure point: half the width at p = 0.5, thinner or wider around it.
const radiusAt = (stroke, point) => stroke.kind === 'pressure' ? stroke.width / 2 * (0.25 + 1.5 * point.p) : stroke.width / 2;

// Outline of a pressure stroke as a closed polygon with round ends.
export function outline(stroke) {
  const points = stroke.points;
  const radii = points.map((point, i) => {
    const near = points.slice(Math.max(0, i - 1), i + 2); // smooths jittery pressure
    return radiusAt(stroke, { p: near.reduce((sum, q) => sum + q.p, 0) / near.length });
  });
  const circle = (center, radius, from, steps, span) => Array.from({ length: steps }, (_, k) => {
    const angle = from - span * (k + 1) / (steps + 1);
    return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
  });
  const length = points.reduce((sum, q, i) => i ? sum + Math.hypot(q.x - points[i - 1].x, q.y - points[i - 1].y) : 0, 0);
  if (length < 0.05) return circle(points[0], radii[0], 0, 15, -2 * Math.PI);
  const left = [], right = [], angles = [];
  let normal = { x: 0, y: -1 };
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
    if (d > 1e-6) normal = { x: -dy / d, y: dx / d };
    left.push({ x: points[i].x + normal.x * radii[i], y: points[i].y + normal.y * radii[i] });
    right.push({ x: points[i].x - normal.x * radii[i], y: points[i].y - normal.y * radii[i] });
    angles.push(Math.atan2(normal.y, normal.x));
  }
  const last = points.length - 1;
  return [...left, ...circle(points[last], radii[last], angles[last], 7, Math.PI), ...right.reverse(), ...circle(points[0], radii[0], angles[0] + Math.PI, 7, Math.PI)];
}

// SVG path data: a centre line for lines (drawn with the width), an outline for pressure strokes (filled).
export function strokePath(stroke) {
  if (stroke.kind === 'pressure') return outline(stroke).map((point, i) => (i ? 'L ' : 'M ') + round(point.x) + ' ' + round(point.y)).join(' ') + ' Z';
  if (stroke.kind !== 'line' || !stroke.points.length) return '';
  const [first, ...rest] = stroke.points;
  return 'M ' + first.x + ' ' + first.y + ' l 0.01 0' + rest.map(point => ' L ' + point.x + ' ' + point.y).join('');
}

// Lines of a text stroke with their baselines; widths are estimated, so exports and previews need no font metrics.
export function textLines(stroke) {
  return stroke.text.split('\n').map((text, i) => ({ text, x: stroke.x, y: stroke.y + stroke.width * (0.9 + LINE_HEIGHT * i) }));
}

export function strokeBounds(stroke) {
  if (stroke.kind === 'text') {
    const lines = stroke.text.split('\n');
    return { minX: stroke.x, minY: stroke.y, maxX: stroke.x + Math.max(1, ...lines.map(line => line.length)) * stroke.width * 0.55, maxY: stroke.y + lines.length * stroke.width * LINE_HEIGHT };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of stroke.points) {
    const r = radiusAt(stroke, point);
    minX = Math.min(minX, point.x - r); maxX = Math.max(maxX, point.x + r);
    minY = Math.min(minY, point.y - r); maxY = Math.max(maxY, point.y + r);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function segmentDistance(point, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)) : 0;
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}

// Distance from a point to the drawn edge of a stroke (0 or less: on the ink).
export function strokeDistance(stroke, point) {
  if (stroke.kind === 'text') {
    const box = strokeBounds(stroke);
    return Math.hypot(Math.max(box.minX - point.x, 0, point.x - box.maxX), Math.max(box.minY - point.y, 0, point.y - box.maxY));
  }
  const points = stroke.points;
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[Math.min(i + 1, points.length - 1)];
    best = Math.min(best, segmentDistance(point, a, b) - Math.max(radiusAt(stroke, a), radiusAt(stroke, b)));
  }
  return best;
}

// Whether an eraser of `radius` moved from `from` to `to` touches the stroke.
export function touches(stroke, from, to, radius) {
  const box = strokeBounds(stroke);
  if (!box || Math.max(from.x, to.x) < box.minX - radius || Math.min(from.x, to.x) > box.maxX + radius ||
      Math.max(from.y, to.y) < box.minY - radius || Math.min(from.y, to.y) > box.maxY + radius) return false;
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / radius));
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    if (strokeDistance(stroke, { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }) <= radius) return true;
  }
  return false;
}

// Erases only the part of a stroke under the eraser. Returns the remaining
// pieces as stroke strings, or null if the eraser misses it. Text goes whole.
export function eraseFrom(stroke, from, to, radius) {
  if (!touches(stroke, from, to, radius)) return null;
  if (stroke.kind === 'text' || stroke.points.length < 2) return [];
  // Long segments (shapes) are split up first, so the eraser cuts where it is.
  const step = Math.max(radius / 2, 0.5), dense = [stroke.points[0]];
  for (let i = 1; i < stroke.points.length; i++) {
    const a = stroke.points[i - 1], b = stroke.points[i];
    const parts = Math.min(500, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 1; k <= parts; k++) dense.push({ x: a.x + (b.x - a.x) * k / parts, y: a.y + (b.y - a.y) * k / parts, ...(a.p !== undefined && { p: a.p + (b.p - a.p) * k / parts }) });
  }
  const pieces = [];
  let run = [];
  for (const point of dense) {
    if (segmentDistance(point, from, to) <= radius + radiusAt(stroke, point) * 0.5) { if (run.length) pieces.push(run); run = []; }
    else run.push(point);
  }
  if (run.length) pieces.push(run);
  return pieces.filter(piece => piece.length > 1).map(points => formatStroke({ ...stroke, points }));
}

export function translateStroke(stroke, dx, dy) {
  if (stroke.kind === 'text') return formatStroke({ ...stroke, x: stroke.x + dx, y: stroke.y + dy });
  return formatStroke({ ...stroke, points: stroke.points.map(point => ({ ...point, x: point.x + dx, y: point.y + dy })) });
}

export const restyleStroke = (stroke, changes) => formatStroke({ ...stroke, ...changes });

function insidePolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// A lasso takes strokes with most of their points inside it, and text whose middle is inside.
export function inLasso(stroke, polygon) {
  if (polygon.length < 3) return false;
  if (stroke.kind === 'text') {
    const box = strokeBounds(stroke);
    return insidePolygon({ x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }, polygon);
  }
  const points = stroke.points;
  return points.length > 0 && points.filter(point => insidePolygon(point, polygon)).length * 2 >= points.length;
}

// Points of a shape dragged from a to b; drawn like any other line.
export function shapePoints(shape, a, b) {
  if (shape === 'rectangle') return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a];
  if (shape === 'ellipse') {
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
    return Array.from({ length: 65 }, (_, i) => ({ x: cx + rx * Math.cos(i / 32 * Math.PI), y: cy + ry * Math.sin(i / 32 * Math.PI) }));
  }
  if (shape === 'arrow') {
    const angle = Math.atan2(b.y - a.y, b.x - a.x), head = Math.min(28, Math.hypot(b.x - a.x, b.y - a.y) / 3);
    const wing = side => ({ x: b.x - head * Math.cos(angle + side * 0.45), y: b.y - head * Math.sin(angle + side * 0.45) });
    return [a, b, wing(1), b, wing(-1)];
  }
  return [a, b];
}
