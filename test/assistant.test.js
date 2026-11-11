import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantCommand, parseAnswer, validAssistant } from '../src/assistant.js';

test('assistant presets: valid settings, commands and parsed answers', () => {
  for (const setting of [null, 'claude', 'codex', ['agent', '{prompt}']]) assert.ok(validAssistant(setting), JSON.stringify(setting));
  for (const setting of ['gpt', [], ['agent'], 'toString', ['codex'], ['claude']]) assert.ok(!validAssistant(setting), JSON.stringify(setting));

  const [command, args] = assistantCommand('codex', 'PROMPT', { schema: 's.json', answer: 'a.json', snapshot: 'p.png' });
  assert.equal(command, 'codex');
  assert.equal(args[1], 'PROMPT');
  assert.deepEqual(args.slice(-2), ['--image', 'p.png'], 'the image list comes last');
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');

  // Claude: only the snapshot and notes on this canvas and page.
  const request = { document: { id: 'abc', title: 'T', revision: 4, pages: [{ width: 900, height: 1200 }] }, page: 1, region: { x: 10, y: 20, width: 300, height: 100 }, question: '' };
  const [, claude] = assistantCommand('claude', 'PROMPT', { snapshot: '/state/run/selection.png' }, request);
  assert.deepEqual(claude.slice(claude.indexOf('--allowedTools') + 1, claude.indexOf('--allowedTools') + 3), ['Read(//state/run/selection.png)', 'Bash(paper annotate abc --page 1 --at *)']);
  assert.equal(claude[claude.indexOf('--tools') + 1], 'Read,Bash');
  assert.ok(claude.includes('--strict-mcp-config'));

  const page = { width: 900, height: 1200 };
  assert.deepEqual(parseAnswer('{"notes":[{"x":10.4,"y":20,"text":" ok "},{"x":"a","y":1,"text":"bad"}]}', page), [{ x: 10, y: 20, text: 'ok' }]);
  assert.throws(() => parseAnswer('not json', page), /JSON/);
  assert.throws(() => parseAnswer('{}', page), /no notes/);
  assert.deepEqual(parseAnswer('{"notes":[{"x":5,"y":5,"text":"a"}]}', { width: 20, height: 10 }), [{ x: 0, y: 0, text: 'a' }], 'tiny pages stay valid');
});
