import { afterEach, expect, test } from "bun:test";

import { NEW_CHAT_EVENT, requestNewChat } from "./nav";

const original = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
  if (original) Object.defineProperty(globalThis, "window", original);
  else delete (globalThis as { window?: unknown }).window;
});

test("requestNewChat announces a new chat on window", () => {
  const target = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  let heard = 0;
  target.addEventListener(NEW_CHAT_EVENT, () => heard++);

  requestNewChat();

  expect(heard).toBe(1);
});
