"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pickTool = void 0;
const claude_agent_sdk_1 = require("@anthropic-ai/claude-agent-sdk");
const zod_1 = require("zod");
exports.pickTool = (0, claude_agent_sdk_1.tool)('pick', 'Select specific fields from each item in an array.', zod_1.z.object({
    data: zod_1.z.array(zod_1.z.any()).describe('Array of items'),
    fields: zod_1.z.array(zod_1.z.string()).describe('Field names to keep'),
}).shape, async ({ data, fields }) => {
    const picked = data.map((item) => {
        const result = {};
        for (const field of fields) {
            if (field in item) {
                result[field] = item[field];
            }
        }
        return result;
    });
    return {
        content: [{ type: 'text', text: JSON.stringify(picked, null, 2) }],
    };
});
