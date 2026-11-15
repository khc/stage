import { Elysia } from "elysia";

const HEADER = "x-request-id";
// A caller's id is kept only when it is short and plain, so it is safe in headers and logs.
const VALID = /^[A-Za-z0-9._-]{1,128}$/;

const ids = new WeakMap<Request, string>();

// The id of a request: the caller's `x-request-id`, or a generated UUID.
export const requestIdOf = (request: Request) => ids.get(request);

// Gives every request an id and returns it in the `x-request-id` response header, on errors and
// unknown routes too. The error log and the request's trace span carry the same id.
export const requestId = () =>
  new Elysia({ name: "http.request-id" }).onRequest(({ request, set }) => {
    const incoming = request.headers.get(HEADER);
    const id = incoming && VALID.test(incoming) ? incoming : crypto.randomUUID();
    ids.set(request, id);
    set.headers[HEADER] = id;
  });
