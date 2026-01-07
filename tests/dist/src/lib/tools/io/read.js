"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createReadTool = void 0;
const claude_agent_sdk_1 = require("@anthropic-ai/claude-agent-sdk");
const zod_1 = require("zod");
const pdf_parse_1 = require("pdf-parse");
// Python venv path - computed lazily to avoid Turbopack static analysis
function getPythonBin() {
    const venv = process.env.PYTHON_VENV_PATH || `${process.cwd()}/.venv`;
    return `${venv}/bin/python3`;
}
const createReadTool = (ctx) => (0, claude_agent_sdk_1.tool)('read', 'Read data from a source. Sources can be: "table:name" for tables, "file:path" for files.', zod_1.z.object({
    from: zod_1.z.string().describe('Source: "table:name" or "file:path"'),
    where: zod_1.z.string().optional().describe('Filter condition (for tables): "field == value"'),
    limit: zod_1.z.number().optional().describe('Maximum items to return'),
}).shape, async ({ from, where, limit }) => {
    const [type, name] = from.split(':');
    if (type === 'table') {
        const table = await ctx.storage.getTable(ctx.workspaceId, name);
        if (!table) {
            return {
                content: [{ type: 'text', text: `Table "${name}" not found` }],
            };
        }
        let data = table.data;
        // Simple filter parsing
        if (where) {
            const match = where.match(/(\w+)\s*(==|!=|>=|<=|>|<)\s*(.+)/);
            if (match) {
                const [, field, op, value] = match;
                const parsedValue = value.replace(/['"]/g, '');
                data = data.filter((row) => {
                    const rowValue = row[field];
                    switch (op) {
                        case '==': return String(rowValue) === parsedValue;
                        case '!=': return String(rowValue) !== parsedValue;
                        case '>': return Number(rowValue) > Number(parsedValue);
                        case '<': return Number(rowValue) < Number(parsedValue);
                        case '>=': return Number(rowValue) >= Number(parsedValue);
                        case '<=': return Number(rowValue) <= Number(parsedValue);
                        default: return true;
                    }
                });
            }
        }
        if (limit) {
            data = data.slice(0, limit);
        }
        return {
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
    }
    if (type === 'file') {
        const ext = name.toLowerCase().split('.').pop();
        // Parse PDFs using pdf-parse v2
        if (ext === 'pdf') {
            const buffer = await ctx.storage.readFileBuffer(ctx.workspaceId, name);
            if (!buffer) {
                return {
                    content: [{ type: 'text', text: `PDF file not found: ${name}` }],
                };
            }
            try {
                const parser = new pdf_parse_1.PDFParse({ data: buffer });
                const result = await parser.getText();
                return {
                    content: [{ type: 'text', text: result.text }],
                };
            }
            catch (err) {
                return {
                    content: [{ type: 'text', text: `Error parsing PDF: ${err instanceof Error ? err.message : String(err)}` }],
                };
            }
        }
        // Excel files need Python via Bash
        if (['xlsx', 'xls'].includes(ext || '')) {
            return {
                content: [{ type: 'text', text: `[Excel file: ${name}]\nExcel files cannot be read as text. Use the Bash tool to run Python:\n\n${getPythonBin()} -c "\nimport pandas as pd\ndf = pd.read_excel('path/to/${name}')\nprint(df.to_string())\n"` }],
            };
        }
        const content = await ctx.storage.readFile(ctx.workspaceId, name);
        if (content === null) {
            return {
                content: [{ type: 'text', text: `File "${name}" not found` }],
            };
        }
        return {
            content: [{ type: 'text', text: content }],
        };
    }
    return {
        content: [{ type: 'text', text: `Unknown source type: ${type}` }],
    };
});
exports.createReadTool = createReadTool;
