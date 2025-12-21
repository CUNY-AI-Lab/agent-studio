"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const node_test_1 = require("node:test");
const accumulator_1 = require("../../src/lib/streaming/accumulator");
(0, node_test_1.describe)('stream accumulator', () => {
    (0, node_test_1.it)('avoids double text when stream deltas are present', () => {
        const acc = (0, accumulator_1.createStreamAccumulator)();
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
        assert_1.default.equal(fullResponse, 'Hello');
        assert_1.default.equal(contentBlocks.length, 1);
        assert_1.default.equal(contentBlocks[0].type, 'text');
        assert_1.default.equal(contentBlocks[0].text, 'Hello');
    });
    (0, node_test_1.it)('groups tools between text sections and captures tool output', () => {
        var _a, _b, _c;
        const acc = (0, accumulator_1.createStreamAccumulator)();
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
        assert_1.default.equal(fullResponse, 'Hello done.');
        assert_1.default.equal(contentBlocks.length, 3);
        assert_1.default.equal(contentBlocks[0].type, 'text');
        assert_1.default.equal(contentBlocks[0].text, 'Hello ');
        assert_1.default.equal(contentBlocks[1].type, 'tools');
        assert_1.default.ok(contentBlocks[1].tools);
        assert_1.default.equal((_a = contentBlocks[1].tools) === null || _a === void 0 ? void 0 : _a.length, 1);
        assert_1.default.equal((_b = contentBlocks[1].tools) === null || _b === void 0 ? void 0 : _b[0].status, 'success');
        assert_1.default.equal((_c = contentBlocks[1].tools) === null || _c === void 0 ? void 0 : _c[0].output, 'ok\nnext');
        assert_1.default.equal(contentBlocks[2].type, 'text');
        assert_1.default.equal(contentBlocks[2].text, 'done.');
    });
    (0, node_test_1.it)('deduplicates tool_use events by id while updating input', () => {
        var _a, _b;
        const acc = (0, accumulator_1.createStreamAccumulator)();
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
        assert_1.default.equal(contentBlocks.length, 1);
        assert_1.default.equal(contentBlocks[0].type, 'tools');
        assert_1.default.ok(contentBlocks[0].tools);
        assert_1.default.equal((_a = contentBlocks[0].tools) === null || _a === void 0 ? void 0 : _a.length, 1);
        assert_1.default.deepEqual((_b = contentBlocks[0].tools) === null || _b === void 0 ? void 0 : _b[0].input, { path: 'file.txt' });
    });
});
