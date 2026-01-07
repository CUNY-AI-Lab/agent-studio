"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const node_test_1 = require("node:test");
const runtime_1 = require("../../src/lib/runtime");
(0, node_test_1.describe)('runtime.extractPanelUpdates', () => {
    (0, node_test_1.it)('extracts and strips panel updates from tool result', () => {
        const updates = [{ action: 'add', panel: { id: 'p1', type: 'table', tableId: 't1' } }];
        const payload = `Logs:\nHello\n\n__PANEL_UPDATES_START__${JSON.stringify(updates)}__PANEL_UPDATES_END__`;
        const { cleanResult, panelUpdates } = (0, runtime_1.extractPanelUpdates)(payload);
        assert_1.default.match(cleanResult, /Logs:\nHello/);
        assert_1.default.equal(Array.isArray(panelUpdates), true);
        assert_1.default.equal(panelUpdates.length, 1);
        assert_1.default.equal(panelUpdates[0].action, 'add');
    });
    (0, node_test_1.it)('returns original text when JSON is invalid', () => {
        const payload = `X __PANEL_UPDATES_START__not-json__PANEL_UPDATES_END__`;
        const { cleanResult, panelUpdates } = (0, runtime_1.extractPanelUpdates)(payload);
        assert_1.default.equal(cleanResult.includes('not-json'), true);
        assert_1.default.equal(panelUpdates.length, 0);
    });
});
