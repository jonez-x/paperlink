// Dependency-free terminal UI: palette, logo, cards and keyboard-driven prompts.
import readline from 'node:readline';

const out = process.stderr.isTTY && !process.stdout.isTTY ? process.stderr : process.stdout;

const colorEnabled = Boolean(process.stdout.isTTY) && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb';
const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM || '');
function paint(hex, fallback256) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const open = truecolor ? '\x1b[38;2;' + r + ';' + g + ';' + b + 'm' : '\x1b[38;5;' + fallback256 + 'm';
  return text => colorEnabled ? open + text + '\x1b[39m' : String(text);
}
// Same warm palette as the browser UI.
export const c = {
  accent: paint('#ff7028', 208),
  yellow: paint('#ffb02e', 214),
  red: paint('#f34d2c', 203),
  muted: paint('#a09e94', 247),
  green: paint('#8fbf6a', 107),
  danger: paint('#df5429', 167),
  bold: text => colorEnabled ? '\x1b[1m' + text + '\x1b[22m' : String(text),
  inverse: text => colorEnabled ? '\x1b[7m' + text + '\x1b[27m' : '[' + text + ']'
};

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const visibleLength = text => [...String(text).replace(ANSI, '')].length;
const columns = () => out.columns || 80;
function truncate(text, width) {
  if (visibleLength(text) <= width) return text;
  let result = '', length = 0;
  for (const part of String(text).split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith('\x1b[')) { result += part; continue; }
    for (const char of part) { if (length >= width - 1) return result + '…\x1b[0m'; result += char; length++; }
  }
  return result;
}

// The pixel mark from the web header: yellow above, orange core, yellow right, red below.
export function banner(subtitle = 'handwriting, saved where you want it') {
  const px = color => colorEnabled ? color('██') : '##';
  return [
    '',
    '  ' + px(c.yellow),
    '  ' + px(c.accent) + px(c.yellow) + '   ' + c.bold('paper') + c.bold(c.accent('link')),
    '  ' + px(c.red) + '       ' + c.muted(subtitle),
    ''
  ].join('\n');
}

// A sheet of paper: rounded frame with an optional title tab.
export function card(lines, { title, tone = c.muted } = {}) {
  const width = Math.min(Math.max(...lines.map(visibleLength), title ? visibleLength(title) + 2 : 0, 30) + 2, columns() - 4);
  const top = title
    ? tone('╭─ ') + c.bold(title) + ' ' + tone('─'.repeat(Math.max(0, width - visibleLength(title) - 3)) + '╮')
    : tone('╭' + '─'.repeat(width) + '╮');
  const body = lines.map(line => {
    const text = truncate(line, width - 2);
    return tone('│') + ' ' + text + ' '.repeat(Math.max(0, width - 2 - visibleLength(text))) + ' ' + tone('│');
  });
  return [top, ...body, tone('╰' + '─'.repeat(width) + '╯')].map(line => '  ' + line).join('\n');
}

export const rule = (label = '') => '  ' + c.muted(label ? label + ' ' + '─'.repeat(Math.max(0, Math.min(columns() - 6, 56) - visibleLength(label) - 1)) : '─'.repeat(Math.min(columns() - 4, 56)));
export const indent = (text, by = '  ') => String(text).split('\n').map(line => by + line).join('\n');

export const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

// Core loop: render a block, redraw it in place on each key, collapse it to a summary line when done.
function prompt(render, onKey) {
  return new Promise(resolve => {
    const input = process.stdin;
    readline.emitKeypressEvents(input);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    out.write('\x1b[?25l');
    let drawn = 0;
    const clear = () => { if (drawn) out.write('\x1b[' + drawn + 'A'); out.write('\r\x1b[0J'); };
    const draw = () => {
      const lines = render().split('\n').map(line => truncate(line, columns() - 1));
      clear();
      out.write(lines.join('\n') + '\n');
      drawn = lines.length;
    };
    const finish = (value, summary) => {
      input.off('keypress', handler);
      input.setRawMode(wasRaw);
      input.pause();
      clear();
      if (summary) out.write(summary + '\n');
      out.write('\x1b[?25h');
      resolve(value);
    };
    const handler = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        finish(null);
        out.write(c.muted('  Cancelled.') + '\n');
        process.exit(130);
      }
      const result = onKey(text, key);
      if (result?.done) finish(result.value, result.summary);
      else draw();
    };
    input.on('keypress', handler);
    draw();
  });
}

const help = text => '  ' + c.muted(text);

// Arrow-key menu. Choices: { label, value, hint?, disabled? } or { separator: 'Label' }.
export function select({ message, choices, initial = 0, initialValue, pageSize = 12, quiet = false, hint = '↑↓ move · enter select · esc back' }) {
  const isSeparator = choice => 'separator' in choice;
  const selectable = choices.map((choice, index) => !isSeparator(choice) && !choice.disabled ? index : -1).filter(index => index >= 0);
  if (!selectable.length) throw new Error('Nothing to select.');
  let cursor = initialValue === undefined ? initial : choices.findIndex(choice => choice.value === initialValue);
  if (!selectable.includes(cursor)) cursor = selectable[0];
  const move = step => {
    const position = selectable.indexOf(cursor);
    cursor = selectable[(position + step + selectable.length) % selectable.length];
  };
  return prompt(() => {
    const start = Math.max(0, Math.min(cursor - Math.floor(pageSize / 2), choices.length - pageSize));
    const visible = choices.slice(start, start + pageSize);
    const lines = ['  ' + c.accent('?') + ' ' + c.bold(message)];
    if (start > 0) lines.push(help('  ↑ more'));
    visible.forEach((choice, offset) => {
      const index = start + offset;
      if (isSeparator(choice)) return lines.push(choice.separator ? '    ' + c.muted(choice.separator) : '');
      const active = index === cursor;
      const label = choice.disabled ? c.muted(choice.label) : active ? c.accent(c.bold(choice.label)) : choice.label;
      lines.push('  ' + (active ? c.accent('›') : ' ') + ' ' + label + (choice.hint ? '  ' + c.muted(choice.hint) : ''));
    });
    if (start + pageSize < choices.length) lines.push(help('  ↓ more'));
    lines.push(help(hint));
    return lines.join('\n');
  }, (text, key) => {
    if (key.name === 'up' || key.name === 'k' && !key.ctrl) move(-1);
    else if (key.name === 'down' || key.name === 'j' && !key.ctrl || key.name === 'tab') move(1);
    else if (key.name === 'return') {
      const choice = choices[cursor];
      return { done: true, value: choice.value, summary: quiet ? '' : '  ' + c.green('✓') + ' ' + message + ' ' + c.muted('· ' + choice.label.replace(ANSI, '')) };
    } else if (key.name === 'escape' || key.name === 'q' || key.name === 'left') return { done: true, value: null };
  });
}

// Single-line text input with cursor movement, optional Tab completion and validation.
export function input({ message, initial = '', placeholder = '', validate, complete, hint = 'enter confirm · esc back' }) {
  let value = initial;
  let cursor = [...value].length;
  let error = '';
  const tabHint = complete ? ' · tab complete' : '';
  return prompt(() => {
    const chars = [...value];
    const shown = chars.length ? chars.slice(0, cursor).join('') + c.inverse(chars[cursor] || ' ') + chars.slice(cursor + 1).join('') : c.inverse(' ') + c.muted(placeholder);
    return ['  ' + c.accent('?') + ' ' + c.bold(message), '  ' + c.accent('›') + ' ' + shown,
      error ? '  ' + c.danger('✗ ' + error) : help(hint + tabHint)].join('\n');
  }, (text, key) => {
    error = '';
    const chars = [...value];
    if (key.name === 'return') {
      const problem = validate?.(value.trim());
      if (problem) { error = problem; return; }
      return { done: true, value: value.trim(), summary: '  ' + c.green('✓') + ' ' + message + ' ' + c.muted('· ' + (value.trim() || '—')) };
    }
    if (key.name === 'escape') return { done: true, value: null };
    if (key.name === 'backspace') { if (cursor > 0) { chars.splice(cursor - 1, 1); cursor--; } }
    else if (key.name === 'delete') chars.splice(cursor, 1);
    else if (key.name === 'left') cursor = Math.max(0, cursor - 1);
    else if (key.name === 'right') cursor = Math.min(chars.length, cursor + 1);
    else if (key.name === 'home' || (key.ctrl && key.name === 'a')) cursor = 0;
    else if (key.name === 'end' || (key.ctrl && key.name === 'e')) cursor = chars.length;
    else if (key.ctrl && key.name === 'u') { chars.splice(0, cursor); cursor = 0; }
    else if (key.name === 'tab' && complete) {
      const completed = complete(value);
      if (completed && completed !== value) { value = completed; cursor = [...value].length; }
      return;
    } else if (text && !key.ctrl && !key.meta && text >= ' ' && text !== '\x7f') { chars.splice(cursor, 0, ...text); cursor += [...text].length; }
    value = chars.join('');
  });
}

export async function confirm({ message, initial = true }) {
  const value = await select({ message, choices: [{ label: 'Yes', value: true }, { label: 'No', value: false }], initial: initial ? 0 : 1, hint: '↑↓ move · enter select' });
  return value === null ? null : value;
}

export function pause(message = 'Press any key to continue') {
  return prompt(() => help(message), () => ({ done: true, value: true }));
}

export const clearScreen = () => { if (isInteractive()) out.write('\x1b[2J\x1b[3J\x1b[H'); };
