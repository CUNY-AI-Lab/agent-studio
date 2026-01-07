"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const node_test_1 = require("node:test");
const validation_1 = require("../../src/lib/upload/validation");
(0, node_test_1.describe)('upload validation', () => {
    (0, node_test_1.it)('sanitizes filenames by replacing unsafe chars and preserving extension', () => {
        const fn = (0, validation_1.sanitizeFilename)('../My File (Final).PDF');
        // Expect normalized lowercase extension and underscores
        assert_1.default.ok(fn.endsWith('.pdf'));
        assert_1.default.equal(fn.startsWith('..'), false);
        assert_1.default.match(fn, /^[A-Za-z0-9_-]+\.pdf$/);
    });
    (0, node_test_1.it)('limits base filename length to 100 chars', () => {
        const long = 'a'.repeat(150) + '.txt';
        const fn = (0, validation_1.sanitizeFilename)(long);
        const base = fn.slice(0, fn.lastIndexOf('.'));
        assert_1.default.ok(base.length <= 100);
        assert_1.default.ok(fn.endsWith('.txt'));
    });
    (0, node_test_1.it)('rejects disallowed extensions', () => {
        const res = (0, validation_1.isAllowedFile)({ name: 'evil.exe', type: 'application/octet-stream', size: 1 });
        assert_1.default.equal(res.allowed, false);
    });
    (0, node_test_1.it)('accepts allowed extension with empty or octet-stream mime', () => {
        const a = (0, validation_1.isAllowedFile)({ name: 'data.csv', type: '', size: 10 });
        const b = (0, validation_1.isAllowedFile)({ name: 'data.csv', type: 'application/octet-stream', size: 10 });
        assert_1.default.equal(a.allowed, true);
        assert_1.default.equal(b.allowed, true);
    });
    (0, node_test_1.it)('allows allowed mime even if not matching extension', () => {
        // Current policy: extension gating + mime whitelisting (not strict mapping)
        const res = (0, validation_1.isAllowedFile)({ name: 'report.pdf', type: 'image/png', size: 10 });
        assert_1.default.equal(res.allowed, true);
    });
});
