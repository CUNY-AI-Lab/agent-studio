# Chat stream framing

Agent Studio's chat Worker consumes the `@cloudflare/ai-chat` SSE response
through the AI SDK `parseJsonEventStream` primitive. The primitive uses the
maintained EventSource parser, so the transport accepts arbitrary byte chunks
and split UTF-8 code points.

The wire contract is standard SSE:

- `\n`, `\r`, and `\r\n` terminate lines.
- Consecutive `data:` lines join with a newline. One optional U+0020 after
  `data:` is removed; other spacing follows the EventSource parser.
- A blank line dispatches an event. An unterminated tail at source close is not
  dispatched.
- `data: [DONE]` is an ignored sentinel, not a stream terminator. The parser
  continues to consume later events and the chat loop completes only when the
  parsed stream reaches EOF (or an abort/error path is taken).

Invalid JSON or schema-invalid UI chunks are skipped individually, preserving
the prior transport behavior that ignored malformed lines while allowing later
valid chunks and terminal events to complete the turn. A source read or parser
failure still propagates. An explicit `error` UI chunk keeps the existing error
terminal behavior.

The parser has no application-added event-size cap. The existing
`chatStreamStallTimeoutMs` watchdog still measures inactivity between reads,
and abort cancellation is forwarded to the underlying reader.
