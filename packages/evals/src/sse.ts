export type SseMessage = { event?: string; id?: string; data: string };

// A line ends at LF, CRLF or CR. A CR at the very end of the buffer may be half of a CRLF, so it waits for more.
const nextLine = (buffer: string): [line: string, rest: string] | undefined => {
  const end = buffer.search(/\r\n|\n|\r(?!$)/);
  if (end === -1) return undefined;
  const length = buffer.startsWith("\r\n", end) ? 2 : 1;
  return [buffer.slice(0, end), buffer.slice(end + length)];
};

// Server-Sent Events as messages: one per blank-line-terminated event. Comment lines are skipped, and
// an event the stream ends in the middle of is dropped. A `keepalive` event is yielded like any other.
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<SseMessage> {
  const decoder = new TextDecoder();
  let buffer = "";
  let message: Partial<SseMessage> = {};
  let dataLines: string[] = [];

  const field = (line: string) => {
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (name === "data") dataLines.push(value);
    else if (name === "event") message.event = value;
    else if (name === "id") message.id = value;
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let next = nextLine(buffer); next; next = nextLine(buffer)) {
      const [line, rest] = next;
      buffer = rest;
      if (line !== "") {
        field(line);
        continue;
      }
      if (dataLines.length || message.event || message.id)
        yield { ...message, data: dataLines.join("\n") };
      message = {};
      dataLines = [];
    }
  }
}
