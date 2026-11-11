import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantCommand, parseAnswer, validAssistant } from '../src/assistant.js';

test('assistant presets: valid settings, commands and parsed answers', () => {
  for (const setting of [null, 'claude', 'codex', ['agent', '{prompt}']]) assert.ok(validAssistant(setting), JSON.stringify(setting));
  for (const setting of ['gpt', [], ['agent'], 'toString']) assert.ok(!validAssistant(setting), JSON.stringify(setting));

  const [command, args] = assistantCommand('codex', 'PROMPT', { schema: 's.json', answer: 'a.json', snapshot: 'p.png' });
  assert.equal(command, 'codex');
  assert.equal(args[1], 'PROMPT');
  assert.deepEqual(args.slice(-2), ['--image', 'p.png'], 'the image list comes last');
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');

  const page = { width: 900, height: 1200 };
  assert.deepEqual(parseAnswer('{"notes":[{"x":10.4,"y":20,"text":" ok "},{"x":"a","y":1,"text":"bad"}]}', page), [{ x: 10, y: 20, text: 'ok' }]);
  assert.throws(() => parseAnswer('not json', page), /JSON/);
  assert.throws(() => parseAnswer('{}', page), /no notes/);
});
