import { Elysia } from "elysia";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Refuses a state-changing request that a browser marks as cross-site (Fetch Metadata,
// `Sec-Fetch-Site`), so another web page cannot start jobs through the user's browser.
// Requests without the header (curl, the agent jobs, the UI's proxy) pass.
export const rejectCrossSite = () =>
  new Elysia({ name: "reject-cross-site" }).onBeforeHandle(
    { as: "global" },
    ({ request, status }) => {
      if (
        !SAFE_METHODS.has(request.method) &&
        request.headers.get("sec-fetch-site") === "cross-site"
      )
        return status(403, { error: "cross_site_request" });
    },
  );
