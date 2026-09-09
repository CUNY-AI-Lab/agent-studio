import { getToolName, isToolUIPart, type UIMessage } from 'ai';

/** Labels describe SDK tool events, never inferred code behavior or arguments. */
function toolLabels(name: string) {
  switch (name) {
    case 'codemode': return { preparing: 'Preparing code…', running: 'Running code…' };
    case 'list_files': return { preparing: 'Preparing to list files…', running: 'Listing workspace files…' };
    case 'read_file': return { preparing: 'Preparing to read a file…', running: 'Reading a file…' };
    case 'write_file': return { preparing: 'Preparing a file…', running: 'Saving a file…' };
    case 'read_skill': return { preparing: 'Preparing to read instructions…', running: 'Reading instructions…' };
    case 'read_panel':
    case 'read_scoped_panels': return { preparing: 'Preparing to inspect tiles…', running: 'Inspecting tiles…' };
    case 'ui_show_file': return { preparing: 'Preparing a file display…', running: 'Displaying a file…' };
    case 'ui_download': return { preparing: 'Preparing a download…', running: 'Queuing a download…' };
    case 'ui_workspace': return { preparing: 'Preparing a workspace update…', running: 'Updating the workspace…' };
    case 'ui_markdown':
    case 'ui_detail':
    case 'ui_table':
    case 'ui_chart':
    case 'ui_cards': return { preparing: 'Preparing a tile…', running: 'Updating the canvas…' };
    default: return { preparing: 'Preparing tools…', running: 'Running tools…' };
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
