"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.filterTool = void 0;
const claude_agent_sdk_1 = require("@anthropic-ai/claude-agent-sdk");
const zod_1 = require("zod");
exports.filterTool = (0, claude_agent_sdk_1.tool)('filter', 'Filter an array of items by a condition. Returns items where the condition is true.', zod_1.z.object({
    data: zod_1.z.array(zod_1.z.any()).describe('Array of items to filter'),
    where: zod_1.z.string().describe('Condition: "field == value", "field > n", "field contains text"'),
}).shape, async ({ data, where }) => {
    // Parse condition
    const containsMatch = where.match(/(\w+)\s+contains\s+['"]?(.+?)['"]?$/i);
    if (containsMatch) {
        const [, field, value] = containsMatch;
        const filtered = data.filter((item) => String(item[field]).toLowerCase().includes(value.toLowerCase()));
        return {
            content: [{ type: 'text', text: JSON.stringify(filtered, null, 2) }],
        };
    }
    const opMatch = where.match(/(\w+)\s*(==|!=|>|<|>=|<=)\s*['"]?(.+?)['"]?$/);
    if (opMatch) {
        const [, field, op, value] = opMatch;
        const filtered = data.filter((item) => {
            const itemValue = item[field];
            const numValue = Number(value);
            const numItemValue = Number(itemValue);
            switch (op) {
                case '==':
                    return String(itemValue) === value;
                case '!=':
                    return String(itemValue) !== value;
                case '>':
                    return numItemValue > numValue;
                case '<':
                    return numItemValue < numValue;
                case '>=':
                    return numItemValue >= numValue;
                case '<=':
                    return numItemValue <= numValue;
                default:
                    return true;
            }
        });
        return {
            content: [{ type: 'text', text: JSON.stringify(filtered, null, 2) }],
        };
    }
    return {
        content: [{ type: 'text', text: 'Could not parse filter condition' }],
    };
});
