import assert from 'assert';
import { describe, it } from 'node:test';
import { parseSseEvents } from '../../src/lib/streaming/sse';

describe('sse parser', () => {
  it('buffers partial lines across chunks', () => {
    const part1 = 'data: {"type":"assistant","message":{"content":[{"type":"text","text":"Hel';
    const part2 = 'lo"}]}}\n\n';

    const first = parseSseEvents('', part1);
    assert.equal(first.events.length, 0);
    assert.equal(first.rest, part1);

    const second = parseSseEvents(first.rest, part2);
    assert.equal(second.events.length, 1);
    const event = second.events[0] as { type?: string };
    assert.equal(event.type, 'assistant');
  });

  it('ignores comments and DONE markers', () => {
    const chunk = ': keepalive\n\ndata: [DONE]\n\n';
    const parsed = parseSseEvents('', chunk);
    assert.equal(parsed.events.length, 0);
    assert.equal(parsed.rest, '');
  });

  it('parses multiple events in one chunk', () => {
    const chunk = [
      'data: {"type":"assistant","message":{"content":[{"type":"text","text":"Hi"}]}}',
      'data: {"type":"done"}',
      '',
    ].join('\n');

    const parsed = parseSseEvents('', chunk);
    assert.equal(parsed.events.length, 2);
    const first = parsed.events[0] as { type?: string };
    const second = parsed.events[1] as { type?: string };
    assert.equal(first.type, 'assistant');
    assert.equal(second.type, 'done');
  });
});
