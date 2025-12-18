"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sortTool = void 0;
const claude_agent_sdk_1 = require("@anthropic-ai/claude-agent-sdk");
const zod_1 = require("zod");
exports.sortTool = (0, claude_agent_sdk_1.tool)('sort', 'Sort an array of items by a field.', zod_1.z.object({
    data: zod_1.z.array(zod_1.z.any()).describe('Array of items to sort'),
    by: zod_1.z.string().describe('Field name to sort by'),
    order: zod_1.z.enum(['asc', 'desc']).default('asc').describe('Sort order'),
}).shape, async ({ data, by, order }) => {
    const sorted = [...data].sort((a, b) => {
        const aVal = a[by];
        const bVal = b[by];
        // Try numeric comparison first
        const aNum = Number(aVal);
        const bNum = Number(bVal);
        if (!isNaN(aNum) && !isNaN(bNum)) {
            return order === 'asc' ? aNum - bNum : bNum - aNum;
        }
        // Fall back to string comparison
        const aStr = String(aVal);
        const bStr = String(bVal);
        return order === 'asc' ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr);
    });
    return {
        content: [{ type: 'text', text: JSON.stringify(sorted, null, 2) }],
    };
});
