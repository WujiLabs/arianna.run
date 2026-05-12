// Tiny line-buffered SSE consumer. The vessel emits `data: <json>\n\n` events,
// and the sidecar emits the same shape on /events. We don't need event-name
// dispatch or retry-after — just give back the raw `data:` payloads.
//
// Reading is async-iterable so callers can await each event without buffering
// the whole stream. Cross-chunk lines are stitched correctly by holding the
// trailing partial line in `buffer` between reads.
//
// An optional AbortSignal cancels the underlying reader so callers like
// runEvents can break out of an open stream when their idle timer fires.

export interface SSEEvent {
  data: string;
}

export async function* readSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const onAbort = () => {
    reader.cancel().catch(() => { /* already cancelled */ });
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
      reader.releaseLock();
      return;
    }
    signal.addEventListener("abort", onAbort);
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.length > 0) {
          const ev = parseLine(buffer);
          if (ev) yield ev;
        }
        return;
      }
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const ev = parseLine(line);
        if (ev) yield ev;
        newlineIndex = buffer.indexOf("\n");
      }
    }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Reader was already cancelled — releaseLock can throw on a detached
      // reader. Safe to swallow; the underlying stream is already torn down.
    }
  }
}

function parseLine(rawLine: string): SSEEvent | null {
  // Strip trailing CR for CRLF servers.
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (line.length === 0) return null;
  if (!line.startsWith("data: ")) return null;
  return { data: line.slice("data: ".length) };
}
