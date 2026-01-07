"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const node_test_1 = require("node:test");
const sse_1 = require("../../src/lib/streaming/sse");
(0, node_test_1.describe)('sse parser', () => {
    (0, node_test_1.it)('buffers partial lines across chunks', () => {
        const part1 = 'data: {"type":"assistant","message":{"content":[{"type":"text","text":"Hel';
        const part2 = 'lo"}]}}\n\n';
        const first = (0, sse_1.parseSseEvents)('', part1);
        assert_1.default.equal(first.events.length, 0);
        assert_1.default.equal(first.rest, part1);
        const second = (0, sse_1.parseSseEvents)(first.rest, part2);
        assert_1.default.equal(second.events.length, 1);
        const event = second.events[0];
        assert_1.default.equal(event.type, 'assistant');
    });
    (0, node_test_1.it)('ignores comments and DONE markers', () => {
        const chunk = ': keepalive\n\ndata: [DONE]\n\n';
        const parsed = (0, sse_1.parseSseEvents)('', chunk);
        assert_1.default.equal(parsed.events.length, 0);
        assert_1.default.equal(parsed.rest, '');
    });
    (0, node_test_1.it)('parses multiple events in one chunk', () => {
        const chunk = [
            'data: {"type":"assistant","message":{"content":[{"type":"text","text":"Hi"}]}}',
            'data: {"type":"done"}',
            '',
        ].join('\n');
        const parsed = (0, sse_1.parseSseEvents)('', chunk);
        assert_1.default.equal(parsed.events.length, 2);
        const first = parsed.events[0];
        const second = parsed.events[1];
        assert_1.default.equal(first.type, 'assistant');
        assert_1.default.equal(second.type, 'done');
    });
});
