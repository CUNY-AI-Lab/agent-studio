"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.messageTool = void 0;
const claude_agent_sdk_1 = require("@anthropic-ai/claude-agent-sdk");
const zod_1 = require("zod");
exports.messageTool = (0, claude_agent_sdk_1.tool)('ui_message', 'Display a message to the user.', zod_1.z.object({
    text: zod_1.z.string().describe('Message text to display'),
    type: zod_1.z.enum(['info', 'success', 'warning', 'error']).default('info'),
}).shape, async ({ text, type }) => {
    // In a real implementation, this would emit an event to the UI
    // For now, we just return the message
    return {
        content: [
            {
                type: 'text',
                text: `[${type.toUpperCase()}] ${text}`,
            },
        ],
    };
});
