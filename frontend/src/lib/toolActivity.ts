import { getToolName, isToolUIPart, type UIMessage } from 'ai';

/** Labels describe SDK tool events, never inferred code behavior or arguments. */
function toolLabels(name: string) {
  switch (name) {
    case 'codemode': return { preparing: 'Preparing code…', running: 'Running code…', finished: 'Code run finished' };
    case 'list_files': return { preparing: 'Preparing to list files…', running: 'Listing workspace files…', finished: 'File listing finished' };
    case 'read_file': return { preparing: 'Preparing to read a file…', running: 'Reading a file…', finished: 'File read finished' };
    case 'write_file': return { preparing: 'Preparing a file…', running: 'Saving a file…', finished: 'File save finished' };
    case 'read_skill': return { preparing: 'Preparing to read instructions…', running: 'Reading instructions…', finished: 'Instructions read' };
    case 'read_panel':
    case 'read_scoped_panels': return { preparing: 'Preparing to inspect tiles…', running: 'Inspecting tiles…', finished: 'Tile inspection finished' };
    case 'ui_show_file': return { preparing: 'Preparing a file display…', running: 'Displaying a file…', finished: 'File display finished' };
    case 'ui_download': return { preparing: 'Preparing a download…', running: 'Queuing a download…', finished: 'Download queued' };
    case 'ui_workspace': return { preparing: 'Preparing a workspace update…', running: 'Updating the workspace…', finished: 'Workspace update finished' };
    case 'ui_markdown':
    case 'ui_detail':
    case 'ui_table':
    case 'ui_chart':
    case 'ui_cards': return { preparing: 'Preparing a tile…', running: 'Updating the canvas…', finished: 'Canvas update finished' };
    default: return { preparing: 'Preparing tools…', running: 'Running tools…', finished: 'Tool run finished' };
  }
}

export function currentToolActivity(message: UIMessage | undefined): string | null {
  if (message?.role !== 'assistant') return null;
  const tools = message.parts.filter(isToolUIPart);
  const running = [...tools].reverse().find((part) => part.state === 'input-available');
  if (running) return toolLabels(getToolName(running)).running;
  const preparing = [...tools].reverse().find((part) => part.state === 'input-streaming');
  return preparing ? toolLabels(getToolName(preparing)).preparing : null;
}

export function lastFinishedToolActivity(message: UIMessage): string | null {
  if (message.role !== 'assistant') return null;
  const finished = [...message.parts].reverse().filter(isToolUIPart).find((part) => part.state === 'output-available');
  return finished ? toolLabels(getToolName(finished)).finished : null;
}
