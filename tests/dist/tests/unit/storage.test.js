"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const crypto_1 = require("crypto");
const promises_1 = require("fs/promises");
const path_1 = __importDefault(require("path"));
const storage_1 = require("../../src/lib/storage");
const node_test_1 = require("node:test");
function randomUserId() {
    return (0, crypto_1.randomBytes)(16).toString('hex');
}
(0, node_test_1.describe)('storage sandbox', () => {
    const userId = randomUserId();
    const storage = (0, storage_1.createSandboxedStorage)(userId);
    const wsId = 'testws';
    (0, node_test_1.after)(async () => {
        // Cleanup user data directory
        await (0, promises_1.rm)(path_1.default.join(storage.basePath), { recursive: true, force: true }).catch(() => { });
    });
    (0, node_test_1.it)('prevents path traversal when writing files', async () => {
        await assert_1.default.rejects(storage.writeFile(wsId, '../hack.txt', 'nope'), /Path traversal detected/);
    });
    (0, node_test_1.it)('writes and reads a file inside workspace files directory', async () => {
        await storage.writeFile(wsId, 'hello.txt', 'world');
        const content = await storage.readFile(wsId, 'hello.txt');
        assert_1.default.equal(content, 'world');
    });
    (0, node_test_1.it)('lists files with metadata and sorts directories first', async () => {
        await storage.writeFile(wsId, 'a.txt', '1');
        await storage.writeFile(wsId, 'b.txt', '2');
        const files = await storage.listFiles(wsId);
        // Expect at least hello.txt, a.txt, b.txt
        const names = files.map(f => f.name);
        assert_1.default.ok(names.includes('hello.txt'));
        assert_1.default.ok(names.includes('a.txt'));
        assert_1.default.ok(names.includes('b.txt'));
    });
    (0, node_test_1.it)('tables round trip', async () => {
        await storage.setTable(wsId, 't1', {
            id: 't1',
            title: 'T1',
            columns: [
                { key: 'title', label: 'Title', type: 'text' },
                { key: 'year', label: 'Year', type: 'number' },
            ],
            data: [{ title: 'A', year: 2020 }],
        });
        const t = await storage.getTable(wsId, 't1');
        assert_1.default.ok(t);
        assert_1.default.equal(t === null || t === void 0 ? void 0 : t.data.length, 1);
    });
});
