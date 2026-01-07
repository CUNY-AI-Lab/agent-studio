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
const table_1 = require("../../src/lib/tools/ui/table");
(0, node_test_1.describe)('ui table tool', () => {
    const userId = (0, crypto_1.randomBytes)(16).toString('hex');
    const storage = (0, storage_1.createSandboxedStorage)(userId);
    const workspaceId = 'ws-table';
    (0, node_test_1.before)(async () => {
        const now = new Date().toISOString();
        await storage.setWorkspace(workspaceId, {
            id: workspaceId,
            name: 'Table Tools',
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
    (0, node_test_1.it)('requires columns for a new table', async () => {
        var _a, _b, _c;
        const updates = [];
        const tableTool = (0, table_1.createTableTool)({
            storage,
            workspaceId,
            emitPanelUpdates: (next) => updates.push(...next),
        });
        const result = await tableTool.handler({ id: 't1', title: 'Table 1' }, {});
        const text = (_c = (_b = (_a = result === null || result === void 0 ? void 0 : result.content) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.text) !== null && _c !== void 0 ? _c : '';
        assert_1.default.match(text, /Columns are required/);
        assert_1.default.equal(updates.length, 0);
        const table = await storage.getTable(workspaceId, 't1');
        assert_1.default.equal(table, null);
    });
    (0, node_test_1.it)('updates table panels when data changes', async () => {
        var _a, _b;
        const updates = [];
        await storage.addPanel(workspaceId, {
            id: 'table-t2',
            type: 'table',
            title: 'Table 2',
            tableId: 't2',
        });
        const tableTool = (0, table_1.createTableTool)({
            storage,
            workspaceId,
            emitPanelUpdates: (next) => updates.push(...next),
        });
        await tableTool.handler({
            id: 't2',
            title: 'Table 2',
            columns: [{ key: 'name', label: 'Name', type: 'text' }],
            data: [{ name: 'Ada' }],
        }, {});
        assert_1.default.equal(updates.length, 1);
        assert_1.default.equal(updates[0].action, 'update');
        assert_1.default.equal(updates[0].panel.id, 'table-t2');
        assert_1.default.equal((_b = (_a = updates[0].data) === null || _a === void 0 ? void 0 : _a.table) === null || _b === void 0 ? void 0 : _b.data.length, 1);
        const table = await storage.getTable(workspaceId, 't2');
        assert_1.default.ok(table);
        assert_1.default.equal(table === null || table === void 0 ? void 0 : table.data.length, 1);
    });
});
