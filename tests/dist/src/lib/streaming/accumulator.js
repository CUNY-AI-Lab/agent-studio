"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStreamAccumulator = createStreamAccumulator;
function createStreamAccumulator() {
    let fullResponse = '';
    const contentBlocks = [];
    let currentTextBlock = '';
    const currentToolsGroup = [];
    const toolMap = new Map();
    const processedToolIds = new Set();
    let receivedStreamEvents = false;
    let finalized = false;
    const flushText = () => {
        if (currentTextBlock.trim()) {
            contentBlocks.push({ type: 'text', text: currentTextBlock });
            currentTextBlock = '';
        }
    };
    const flushTools = () => {
        if (currentToolsGroup.length > 0) {
            contentBlocks.push({ type: 'tools', tools: [...currentToolsGroup] });
            currentToolsGroup.length = 0;
        }
    };
    const flushToolsBeforeText = () => {
        if (currentToolsGroup.length > 0) {
            flushTools();
        }
    };
    const appendText = (text, fromStream = false) => {
        if (!text)
            return;
        flushToolsBeforeText();
        currentTextBlock += text;
        fullResponse += text;
        if (fromStream) {
            receivedStreamEvents = true;
        }
    };
    const handleToolUse = (toolId, toolName, toolInput) => {
        if (!toolId)
            return;
        const existingTool = toolMap.get(toolId);
        if (existingTool) {
            if (toolName) {
                existingTool.name = toolName;
            }
            if (toolInput !== undefined) {
                existingTool.input = toolInput;
            }
            return;
        }
        processedToolIds.add(toolId);
        flushText();
        receivedStreamEvents = false;
        const tool = {
            id: toolId,
            name: toolName || 'tool',
            input: toolInput,
            status: 'running',
        };
        toolMap.set(toolId, tool);
        currentToolsGroup.push(tool);
    };
    const handleToolResult = (toolId, isError, output) => {
        if (!toolId)
            return;
        const tool = toolMap.get(toolId);
        if (tool) {
            tool.status = isError ? 'error' : 'success';
            tool.output = output;
        }
    };
    const extractToolOutput = (content) => {
        if (Array.isArray(content)) {
            return content
                .filter((c) => (c === null || c === void 0 ? void 0 : c.type) === 'text' && typeof c.text === 'string')
                .map((c) => c.text)
                .join('\n');
        }
        if (typeof content === 'string') {
            return content;
        }
        return '';
    };
    const ingest = (event) => {
        var _a, _b, _c, _d, _e;
        if (!event || typeof event !== 'object')
            return;
        if (event.type === 'stream_event' && event.event) {
            const streamEvent = event.event;
            if (streamEvent.type === 'content_block_delta' && ((_a = streamEvent.delta) === null || _a === void 0 ? void 0 : _a.type) === 'text_delta') {
                appendText(streamEvent.delta.text || '', true);
            }
            else if (streamEvent.type === 'content_block_start' && ((_b = streamEvent.content_block) === null || _b === void 0 ? void 0 : _b.type) === 'text') {
                appendText(streamEvent.content_block.text || '', true);
            }
            else if (streamEvent.type === 'content_block_start' && ((_c = streamEvent.content_block) === null || _c === void 0 ? void 0 : _c.type) === 'tool_use') {
                handleToolUse(streamEvent.content_block.id, streamEvent.content_block.name, streamEvent.content_block.input);
            }
            return;
        }
        if (event.type === 'assistant' && ((_d = event.message) === null || _d === void 0 ? void 0 : _d.content)) {
            const skipText = receivedStreamEvents;
            for (const block of event.message.content) {
                if (block.type === 'tool_use') {
                    handleToolUse(block.id, block.name, block.input);
                }
                else if (!skipText && block.type === 'text' && typeof block.text === 'string') {
                    appendText(block.text);
                }
            }
            return;
        }
        if (event.type === 'user' && ((_e = event.message) === null || _e === void 0 ? void 0 : _e.content)) {
            for (const block of event.message.content) {
                if (block.type === 'tool_result') {
                    const output = extractToolOutput(block.content);
                    handleToolResult(block.tool_use_id, block.is_error, output);
                }
            }
        }
    };
    const finalize = () => {
        if (finalized) {
            return { fullResponse, contentBlocks };
        }
        finalized = true;
        flushText();
        flushTools();
        return { fullResponse, contentBlocks };
    };
    return { ingest, finalize };
}
