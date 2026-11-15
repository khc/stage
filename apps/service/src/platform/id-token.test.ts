import { expect, mock, test } from "bun:test";

import { createIdTokenAuthorization } from "./id-token";

const authReturning = (headers: Headers) => {
  const getRequestHeaders = mock(async () => headers);
  const getIdTokenClient = mock(async (_audience: string) => ({ getRequestHeaders }));
  return { auth: { getIdTokenClient } as never, getIdTokenClient, getRequestHeaders };
};

test("returns the Authorization header of an ID token client for the audience", async () => {
  const { auth, getIdTokenClient } = authReturning(new Headers({ authorization: "Bearer t" }));
  const authorization = createIdTokenAuthorization("https://extract.run.app", auth);
  expect(await authorization()).toBe("Bearer t");
  expect(getIdTokenClient).toHaveBeenCalledWith("https://extract.run.app");
});

test("makes the client once and asks it for headers on every call, so tokens refresh", async () => {
  const { auth, getIdTokenClient, getRequestHeaders } = authReturning(
    new Headers({ authorization: "Bearer t" }),
  );
  const authorization = createIdTokenAuthorization("https://x", auth);
  await authorization();
  await authorization();
  expect(getIdTokenClient).toHaveBeenCalledTimes(1);
  expect(getRequestHeaders).toHaveBeenCalledTimes(2);
});

test("fails clearly when the client returns no Authorization header", async () => {
  const { auth } = authReturning(new Headers());
  await expect(createIdTokenAuthorization("https://x", auth)()).rejects.toThrow(
    "no Authorization header",
  );
});
