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
const write_1 = require("../../src/lib/tools/io/write");
(0, node_test_1.describe)('write tool', () => {
    const userId = (0, crypto_1.randomBytes)(16).toString('hex');
    const storage = (0, storage_1.createSandboxedStorage)(userId);
    const workspaceId = 'ws-write';
    (0, node_test_1.before)(async () => {
        const now = new Date().toISOString();
        await storage.setWorkspace(workspaceId, {
            id: workspaceId,
            name: 'Write Tools',
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
    (0, node_test_1.it)('writes to tables and emits updates', async () => {
        var _a, _b, _c, _d;
        const updates = [];
        await storage.addPanel(workspaceId, {
            id: 'table-items',
            type: 'table',
            title: 'Items',
            tableId: 'items',
        });
        const writeTool = (0, write_1.createWriteTool)({
            storage,
            workspaceId,
            emitPanelUpdates: (next) => updates.push(...next),
        });
        await writeTool.handler({
            to: 'table:items',
            data: [{ name: 'Widget', qty: 2 }],
            mode: 'replace',
        }, {});
        assert_1.default.equal(updates.length, 1);
        assert_1.default.equal(updates[0].action, 'update');
        assert_1.default.equal(updates[0].panel.id, 'table-items');
        assert_1.default.equal((_b = (_a = updates[0].data) === null || _a === void 0 ? void 0 : _a.table) === null || _b === void 0 ? void 0 : _b.data.length, 1);
        assert_1.default.ok((_d = (_c = updates[0].data) === null || _c === void 0 ? void 0 : _c.table) === null || _d === void 0 ? void 0 : _d.columns.some((col) => col.key === 'name'));
        const table = await storage.getTable(workspaceId, 'items');
        assert_1.default.ok(table);
        assert_1.default.equal(table === null || table === void 0 ? void 0 : table.data.length, 1);
    });
    (0, node_test_1.it)('writes and appends to files', async () => {
        const writeTool = (0, write_1.createWriteTool)({ storage, workspaceId });
        await writeTool.handler({ to: 'file:notes.txt', data: 'Hello', mode: 'replace' }, {});
        await writeTool.handler({ to: 'file:notes.txt', data: 'World', mode: 'append' }, {});
        const content = await storage.readFile(workspaceId, 'notes.txt');
        assert_1.default.equal(content, 'HelloWorld');
    });
});
