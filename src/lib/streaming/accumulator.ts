import type { ContentBlock, ToolExecution } from '../storage';

type StreamContentBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: Array<{ type?: string; text?: string }> | string;
};

type StreamEvent = {
  type?: string;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
    content_block?: StreamContentBlock;
  };
  message?: { content?: StreamContentBlock[] };
  [key: string]: unknown;
};

export interface StreamAccumulatorState {
  fullResponse: string;
  contentBlocks: ContentBlock[];
}

export function createStreamAccumulator() {
  let fullResponse = '';
  const contentBlocks: ContentBlock[] = [];
  let currentTextBlock = '';
  const currentToolsGroup: ToolExecution[] = [];
  const toolMap = new Map<string, ToolExecution>();
  const processedToolIds = new Set<string>();
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

  const appendText = (text: string, fromStream = false) => {
    if (!text) return;
    flushToolsBeforeText();
    currentTextBlock += text;
    fullResponse += text;
    if (fromStream) {
      receivedStreamEvents = true;
    }
  };

  const handleToolUse = (toolId?: string, toolName?: string, toolInput?: unknown) => {
    if (!toolId) return;
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

    const tool: ToolExecution = {
      id: toolId,
      name: toolName || 'tool',
      input: toolInput,
      status: 'running',
    };
    toolMap.set(toolId, tool);
    currentToolsGroup.push(tool);
  };

  const handleToolResult = (toolId?: string, isError?: boolean, output?: string) => {
    if (!toolId) return;
    const tool = toolMap.get(toolId);
    if (tool) {
      tool.status = isError ? 'error' : 'success';
      tool.output = output;
    }
  };

  const extractToolOutput = (content: unknown): string => {
    if (Array.isArray(content)) {
      return content
        .filter((c: { type?: string; text?: string }) => c?.type === 'text' && typeof c.text === 'string')
        .map((c: { text: string }) => c.text)
        .join('\n');
    }
    if (typeof content === 'string') {
      return content;
    }
    return '';
  };

  const ingest = (event: StreamEvent) => {
    if (!event || typeof event !== 'object') return;

    if (event.type === 'stream_event' && event.event) {
      const streamEvent = event.event;
      if (streamEvent.type === 'content_block_delta' && streamEvent.delta?.type === 'text_delta') {
        appendText(streamEvent.delta.text || '', true);
      } else if (streamEvent.type === 'content_block_start' && streamEvent.content_block?.type === 'text') {
        appendText(streamEvent.content_block.text || '', true);
      } else if (streamEvent.type === 'content_block_start' && streamEvent.content_block?.type === 'tool_use') {
        handleToolUse(
          streamEvent.content_block.id,
          streamEvent.content_block.name,
          streamEvent.content_block.input
        );
      }
      return;
    }

    if (event.type === 'assistant' && event.message?.content) {
      const skipText = receivedStreamEvents;
      for (const block of event.message.content) {
        if (block.type === 'tool_use') {
          handleToolUse(block.id, block.name, block.input);
        } else if (!skipText && block.type === 'text' && typeof block.text === 'string') {
          appendText(block.text);
        }
      }
      return;
    }

    if (event.type === 'user' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_result') {
          const output = extractToolOutput(block.content);
          handleToolResult(block.tool_use_id, block.is_error, output);
        }
      }
    }
  };

  const finalize = (): StreamAccumulatorState => {
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
