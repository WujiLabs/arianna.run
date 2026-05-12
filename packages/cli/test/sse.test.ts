import { describe, it, expect } from "vitest";
import { readSSE } from "../src/sse.js";

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
}

describe("readSSE", () => {
  it("parses single event", async () => {
    const events = [];
    for await (const ev of readSSE(streamFrom(["data: hello\n\n"]))) {
      events.push(ev);
    }
    expect(events).toEqual([{ data: "hello" }]);
  });

  it("parses multiple events", async () => {
    const out: string[] = [];
    for await (const ev of readSSE(
      streamFrom(["data: a\n\ndata: b\n\ndata: c\n\n"]),
    )) {
      out.push(ev.data);
    }
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("stitches events split across chunks", async () => {
    const out: string[] = [];
    for await (const ev of readSSE(
      streamFrom(["data: hel", "lo wor", "ld\n\ndata: ", "next\n\n"]),
    )) {
      out.push(ev.data);
    }
    expect(out).toEqual(["hello world", "next"]);
  });

  it("ignores non-data lines", async () => {
    const out: string[] = [];
    for await (const ev of readSSE(
      streamFrom([": comment\n", "event: foo\n", "data: keep\n\n"]),
    )) {
      out.push(ev.data);
    }
    expect(out).toEqual(["keep"]);
  });

  it("handles CRLF", async () => {
    const out: string[] = [];
    for await (const ev of readSSE(streamFrom(["data: hi\r\n\r\n"]))) {
      out.push(ev.data);
    }
    expect(out).toEqual(["hi"]);
  });

  it("flushes a final line without trailing newline", async () => {
    const out: string[] = [];
    for await (const ev of readSSE(streamFrom(["data: tail"]))) {
      out.push(ev.data);
    }
    expect(out).toEqual(["tail"]);
  });
});
