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
function randomUserId() {
    return (0, crypto_1.randomBytes)(16).toString('hex');
}
(0, node_test_1.describe)('ui state updates', () => {
    const userId = randomUserId();
    const storage = (0, storage_1.createSandboxedStorage)(userId);
    (0, node_test_1.after)(async () => {
        await (0, promises_1.rm)(path_1.default.join(storage.basePath), { recursive: true, force: true }).catch(() => { });
    });
    (0, node_test_1.it)('preserves panels when updating viewport', async () => {
        var _a, _b;
        const wsId = 'ui-state-viewport';
        const now = new Date().toISOString();
        const workspace = {
            id: wsId,
            name: 'UI State Viewport',
            description: '',
            createdAt: now,
            updatedAt: now,
            systemPrompt: '',
            tools: [],
        };
        await storage.setWorkspace(wsId, workspace);
        await storage.setUIState(wsId, {
            panels: [
                { id: 'chat', type: 'chat', title: 'Chat' },
                { id: 'table-1', type: 'table', tableId: 't1', title: 'T1' },
            ],
            viewport: { x: 0, y: 0, zoom: 1 },
        });
        await storage.updateUIState(wsId, (state) => {
            state.viewport = { x: 10, y: 20, zoom: 1.2 };
            return state;
        });
        const state = await storage.getUIState(wsId);
        assert_1.default.equal(state.panels.length, 2);
        assert_1.default.equal((_a = state.viewport) === null || _a === void 0 ? void 0 : _a.x, 10);
        assert_1.default.equal((_b = state.viewport) === null || _b === void 0 ? void 0 : _b.y, 20);
    });
    (0, node_test_1.it)('serializes updateUIState with addPanel to avoid panel loss', async () => {
        var _a, _b;
        const wsId = 'ui-state-race';
        const now = new Date().toISOString();
        const workspace = {
            id: wsId,
            name: 'UI State Race',
            description: '',
            createdAt: now,
            updatedAt: now,
            systemPrompt: '',
            tools: [],
        };
        await storage.setWorkspace(wsId, workspace);
        await storage.setUIState(wsId, {
            panels: [{ id: 'chat', type: 'chat', title: 'Chat' }],
            viewport: { x: 0, y: 0, zoom: 1 },
        });
        let releaseGate;
        const gate = new Promise((resolve) => {
            releaseGate = () => resolve();
        });
        const updatePromise = storage.updateUIState(wsId, async (state) => {
            await gate;
            state.viewport = { x: 5, y: 6, zoom: 1.1 };
            return state;
        });
        const addPromise = storage.addPanel(wsId, {
            id: 'table-2',
            type: 'table',
            tableId: 't2',
            title: 'T2',
        });
        releaseGate();
        await Promise.all([updatePromise, addPromise]);
        const state = await storage.getUIState(wsId);
        assert_1.default.ok(state.panels.some((panel) => panel.id === 'table-2'));
        assert_1.default.equal((_a = state.viewport) === null || _a === void 0 ? void 0 : _a.x, 5);
        assert_1.default.equal((_b = state.viewport) === null || _b === void 0 ? void 0 : _b.y, 6);
    });
});
