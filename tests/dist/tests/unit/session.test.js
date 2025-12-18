"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const node_test_1 = require("node:test");
const session_1 = require("../../src/lib/session");
// Node 18+ built-in test runner compatibility
// Run with: node --test tests/dist/tests/**/*.test.js
(0, node_test_1.describe)('session.getUserDataPath', () => {
    (0, node_test_1.it)('returns a path for valid 32-hex session id', () => {
        const id = 'a'.repeat(32);
        const p = (0, session_1.getUserDataPath)(id);
        assert_1.default.ok(p.includes('/data/users/'));
    });
    (0, node_test_1.it)('throws for invalid session id length', () => {
        assert_1.default.throws(() => (0, session_1.getUserDataPath)('abc'), /Invalid session ID/);
    });
    (0, node_test_1.it)('throws for non-hex session id', () => {
        assert_1.default.throws(() => (0, session_1.getUserDataPath)('z'.repeat(32)), /Invalid session ID/);
    });
});
