"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSseEvents = parseSseEvents;
function parseSseEvents(buffer, chunk) {
    const fullChunk = buffer + chunk;
    const lines = fullChunk.split('\n');
    let rest = '';
    if (!fullChunk.endsWith('\n')) {
        rest = lines.pop() || '';
    }
    const events = [];
    for (const line of lines) {
        if (!line.startsWith('data: '))
            continue;
        const data = line.slice(6);
        if (!data || data === '[DONE]')
            continue;
        try {
            events.push(JSON.parse(data));
        }
        catch {
            // Ignore malformed JSON for this line.
        }
    }
    return { events, rest };
}
