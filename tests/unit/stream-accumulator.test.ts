import assert from 'assert';
import { describe, it } from 'node:test';
import { createStreamAccumulator } from '../../src/lib/streaming/accumulator';

describe('stream accumulator', () => {
  it('avoids double text when stream deltas are present', () => {
    const acc = createStreamAccumulator();
    acc.ingest({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hello' },
      },
    });
    acc.ingest({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello' }] },
    });

    const { fullResponse, contentBlocks } = acc.finalize();
    assert.equal(fullResponse, 'Hello');
    assert.equal(contentBlocks.length, 1);
    assert.equal(contentBlocks[0].type, 'text');
    assert.equal(contentBlocks[0].text, 'Hello');
  });

  it('groups tools between text sections and captures tool output', () => {
    const acc = createStreamAccumulator();
    acc.ingest({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hello ' },
      },
    });
    acc.ingest({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 't1', name: 'ui.table', input: { foo: 'bar' } },
      },
    });
    acc.ingest({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            is_error: false,
            content: [
              { type: 'text', text: 'ok' },
              { type: 'text', text: 'next' },
            ],
          },
        ],
      },
    });
    acc.ingest({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'done.' }] },
    });

    const { fullResponse, contentBlocks } = acc.finalize();
    assert.equal(fullResponse, 'Hello done.');
    assert.equal(contentBlocks.length, 3);
    assert.equal(contentBlocks[0].type, 'text');
    assert.equal(contentBlocks[0].text, 'Hello ');
    assert.equal(contentBlocks[1].type, 'tools');
    assert.ok(contentBlocks[1].tools);
    assert.equal(contentBlocks[1].tools?.length, 1);
    assert.equal(contentBlocks[1].tools?.[0].status, 'success');
    assert.equal(contentBlocks[1].tools?.[0].output, 'ok\nnext');
    assert.equal(contentBlocks[2].type, 'text');
    assert.equal(contentBlocks[2].text, 'done.');
  });

  it('deduplicates tool_use events by id while updating input', () => {
    const acc = createStreamAccumulator();
    acc.ingest({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 't1', name: 'read', input: {} },
      },
    });
    acc.ingest({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'file.txt' } }] },
    });

    const { contentBlocks } = acc.finalize();
    assert.equal(contentBlocks.length, 1);
    assert.equal(contentBlocks[0].type, 'tools');
    assert.ok(contentBlocks[0].tools);
    assert.equal(contentBlocks[0].tools?.length, 1);
    assert.deepEqual(contentBlocks[0].tools?.[0].input, { path: 'file.txt' });
  });
});
