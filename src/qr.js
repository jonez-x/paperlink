// Minimal QR code encoder (byte mode, error correction level M) for terminal
// pairing links. Follows ISO/IEC 18004; structure adapted from Project Nayuki's
// MIT-licensed QR Code generator. Kept dependency-free on purpose.

const ECC_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const FORMAT_BITS_M = 0;

function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}
const dataCodewords = version => Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK_M[version] * BLOCKS_M[version];

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}
function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    divisor.forEach((coefficient, i) => { result[i] ^= gfMultiply(coefficient, factor); });
  }
  return result;
}

function encodeData(bytes, version) {
  const bits = [];
  const append = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  append(0b0100, 4);
  append(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) append(byte, 8);
  const capacity = dataCodewords(version) * 8;
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - bits.length % 8) % 8);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; codewords.length < dataCodewords(version); pad ^= 0xec ^ 0x11) codewords.push(pad);
  return codewords;
}

function addEccAndInterleave(data, version) {
  const blocks = BLOCKS_M[version];
  const eccLength = ECC_PER_BLOCK_M[version];
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blocks - raw % blocks;
  const shortLength = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLength);
  const all = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const block = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
    k += block.length;
    const ecc = rsRemainder(block, divisor);
    if (i < shortBlocks) block.push(0);
    all.push(block.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < all[0].length; i++) {
    all.forEach((block, j) => { if (i !== shortLength - eccLength || j >= shortBlocks) result.push(block[i]); });
  }
  return result;
}

function alignmentPositions(version, size) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let position = size - 7; result.length < count; position -= step) result.splice(1, 0, position);
  return result;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => x * y % 2 + x * y % 3 === 0,
  (x, y) => (x * y % 2 + x * y % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0
];

class Matrix {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }
  setFunction(x, y, dark) { this.modules[y][x] = dark; this.reserved[y][x] = true; }
  drawFunctionPatterns() {
    const { size } = this;
    for (let i = 0; i < size; i++) { this.setFunction(6, i, i % 2 === 0); this.setFunction(i, 6, i % 2 === 0); }
    for (const [x, y] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        if (x + dx >= 0 && x + dx < size && y + dy >= 0 && y + dy < size) this.setFunction(x + dx, y + dy, distance !== 2 && distance !== 4);
      }
    }
    const positions = alignmentPositions(this.version, size);
    const last = positions.length - 1;
    positions.forEach((px, i) => positions.forEach((py, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.setFunction(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    this.drawFormatBits(0);
    if (this.version >= 7) {
      let remainder = this.version;
      for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
      const bits = this.version << 12 | remainder;
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) === 1;
        const a = size - 11 + i % 3, b = Math.floor(i / 3);
        this.setFunction(a, b, dark);
        this.setFunction(b, a, dark);
      }
    }
  }
  drawFormatBits(mask) {
    const data = FORMAT_BITS_M << 3 | mask;
    let remainder = data;
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = (data << 10 | remainder) ^ 0x5412;
    const bit = i => ((bits >>> i) & 1) === 1;
    const { size } = this;
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFunction(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFunction(8, size - 15 + i, bit(i));
    this.setFunction(8, size - 8, true);
  }
  drawCodewords(data) {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < size; vertical++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const y = ((right + 1) & 2) === 0 ? size - 1 - vertical : vertical;
          if (!this.reserved[y][x] && i < data.length * 8) {
            this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
            i++;
          }
        }
      }
    }
  }
  applyMask(mask) {
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) {
      if (!this.reserved[y][x] && MASKS[mask](x, y)) this.modules[y][x] = !this.modules[y][x];
    }
  }
  penalty() {
    const { size, modules } = this;
    let result = 0;
    const addHistory = (run, history) => { if (history[0] === 0) run += size; history.pop(); history.unshift(run); };
    const countPatterns = history => {
      const n = history[1];
      const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
      return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
    };
    for (const read of [(a, b) => modules[a][b], (a, b) => modules[b][a]]) {
      for (let a = 0; a < size; a++) {
        let color = false, run = 0;
        const history = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < size; b++) {
          if (read(a, b) === color) {
            run++;
            if (run === 5) result += 3;
            else if (run > 5) result++;
          } else {
            addHistory(run, history);
            if (!color) result += countPatterns(history) * 40;
            color = read(a, b);
            run = 1;
          }
        }
        if (color) { addHistory(run, history); run = 0; }
        addHistory(run + size, history);
        result += countPatterns(history) * 40;
      }
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const color = modules[y][x];
      if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) result += 3;
    }
    const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
    const total = size * size;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return result;
  }
}

// Returns a square boolean matrix (true = dark module) without quiet zone.
export function encodeQr(text, { mask } = {}) {
  const bytes = [...Buffer.from(text, 'utf8')];
  let version = 1;
  while (version <= 40 && 4 + (version < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(version) * 8) version++;
  if (version > 40) throw new Error('Text is too long for a QR code.');
  const matrix = new Matrix(version);
  matrix.drawFunctionPatterns();
  matrix.drawCodewords(addEccAndInterleave(encodeData(bytes, version), version));
  let chosen = mask;
  if (chosen === undefined) {
    let best = Infinity;
    for (let candidate = 0; candidate < 8; candidate++) {
      matrix.applyMask(candidate);
      matrix.drawFormatBits(candidate);
      const score = matrix.penalty();
      if (score < best) { best = score; chosen = candidate; }
      matrix.applyMask(candidate); // XOR again to undo.
    }
  }
  matrix.applyMask(chosen);
  matrix.drawFormatBits(chosen);
  return matrix.modules;
}

// Render with half-block characters and explicit black/white ANSI colors so the
// code scans on both light and dark terminal themes.
export function renderQr(text, margin = 2) {
  const modules = encodeQr(text);
  const size = modules.length;
  const dark = (x, y) => x >= 0 && y >= 0 && x < size && y < size && modules[y][x];
  const lines = [];
  for (let y = -margin; y < size + margin; y += 2) {
    let line = '';
    for (let x = -margin; x < size + margin; x++) {
      line += '\x1b[' + (dark(x, y) ? 30 : 97) + ';' + (dark(x, y + 1) ? 40 : 107) + 'm▀';
    }
    lines.push(line + '\x1b[0m');
  }
  return lines.join('\n');
}
