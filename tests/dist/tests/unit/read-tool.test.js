"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const crypto_1 = require("crypto");
const promises_1 = require("fs/promises");
const path_1 = __importDefault(require("path"));
const node_test_1 = require("node:test");
const storage_1 = require("../../src/lib/storage");
const read_1 = require("../../src/lib/tools/io/read");
(0, node_test_1.describe)('read tool', () => {
    const userId = (0, crypto_1.randomBytes)(16).toString('hex');
    const storage = (0, storage_1.createSandboxedStorage)(userId);
    const workspaceId = 'ws-read';
    (0, node_test_1.before)(async () => {
        const now = new Date().toISOString();
        await storage.setWorkspace(workspaceId, {
            id: workspaceId,
            name: 'Read Tools',
            description: '',
            createdAt: now,
            updatedAt: now,
            systemPrompt: '',
            tools: [],
        });
    });
    (0, node_test_1.after)(async () => {
        await (0, promises_1.rm)(path_1.default.join(storage.basePath), { recursive: true, force: true }).catch(() => { });
    });
    (0, node_test_1.it)('filters and limits table rows', async () => {
        var _a, _b, _c;
        await storage.setTable(workspaceId, 'people', {
            id: 'people',
            title: 'People',
            columns: [
                { key: 'name', label: 'Name', type: 'text' },
                { key: 'age', label: 'Age', type: 'number' },
            ],
            data: [
                { name: 'Ada', age: 28 },
                { name: 'Grace', age: 36 },
                { name: 'Linus', age: 32 },
            ],
        });
        const readTool = (0, read_1.createReadTool)({ storage, workspaceId });
        const result = await readTool.handler({
            from: 'table:people',
            where: 'age >= 30',
            limit: 1,
        }, {});
        const text = (_c = (_b = (_a = result === null || result === void 0 ? void 0 : result.content) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.text) !== null && _c !== void 0 ? _c : '[]';
        const data = JSON.parse(text);
        assert_1.default.equal(data.length, 1);
        assert_1.default.ok(data[0].age >= 30);
    });
    (0, node_test_1.it)('returns a not found message for missing files', async () => {
        var _a, _b, _c;
        const readTool = (0, read_1.createReadTool)({ storage, workspaceId });
        const result = await readTool.handler({ from: 'file:missing.txt' }, {});
        const text = (_c = (_b = (_a = result === null || result === void 0 ? void 0 : result.content) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.text) !== null && _c !== void 0 ? _c : '';
        assert_1.default.match(text, /File "missing.txt" not found/);
    });
});
