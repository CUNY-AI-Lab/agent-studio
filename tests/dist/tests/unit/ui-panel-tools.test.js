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
const panel_1 = require("../../src/lib/tools/ui/panel");
(0, node_test_1.describe)('ui panel tools', () => {
    const userId = (0, crypto_1.randomBytes)(16).toString('hex');
    const storage = (0, storage_1.createSandboxedStorage)(userId);
    const workspaceId = 'ws-panels';
    const updates = [];
    const makeContext = () => ({
        storage,
        workspaceId,
        emitPanelUpdates: (next) => updates.push(...next),
    });
    (0, node_test_1.before)(async () => {
        const now = new Date().toISOString();
        await storage.setWorkspace(workspaceId, {
            id: workspaceId,
            name: 'Panel Tools',
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
    (0, node_test_1.it)('adds a panel and emits update', async () => {
        updates.length = 0;
        const addTool = (0, panel_1.createAddPanelTool)(makeContext());
        await addTool.handler({ id: 'panel-add', type: 'markdown', title: 'Notes' }, {});
        assert_1.default.equal(updates.length, 1);
        assert_1.default.equal(updates[0].action, 'add');
        assert_1.default.equal(updates[0].panel.id, 'panel-add');
        const state = await storage.getUIState(workspaceId);
        assert_1.default.ok(state.panels.some((panel) => panel.id === 'panel-add'));
    });
    (0, node_test_1.it)('updates a panel and emits update', async () => {
        updates.length = 0;
        await storage.addPanel(workspaceId, {
            id: 'panel-update',
            type: 'markdown',
            title: 'Old title',
        });
        const updateTool = (0, panel_1.createUpdatePanelTool)(makeContext());
        await updateTool.handler({ id: 'panel-update', title: 'New title' }, {});
        assert_1.default.equal(updates.length, 1);
        assert_1.default.equal(updates[0].action, 'update');
        assert_1.default.equal(updates[0].panel.title, 'New title');
        const state = await storage.getUIState(workspaceId);
        const panel = state.panels.find((item) => item.id === 'panel-update');
        assert_1.default.equal(panel === null || panel === void 0 ? void 0 : panel.title, 'New title');
    });
    (0, node_test_1.it)('removes a panel and emits update', async () => {
        updates.length = 0;
        await storage.addPanel(workspaceId, {
            id: 'panel-remove',
            type: 'markdown',
            title: 'Remove me',
        });
        const removeTool = (0, panel_1.createRemovePanelTool)(makeContext());
        await removeTool.handler({ id: 'panel-remove' }, {});
        assert_1.default.equal(updates.length, 1);
        assert_1.default.equal(updates[0].action, 'remove');
        assert_1.default.equal(updates[0].panel.id, 'panel-remove');
        const state = await storage.getUIState(workspaceId);
        assert_1.default.equal(state.panels.some((panel) => panel.id === 'panel-remove'), false);
    });
});
