import { GoogleAuth } from "google-auth-library";

type IdTokenAuth = Pick<GoogleAuth, "getIdTokenClient">;

// The Authorization header for calling a Google-authenticated service (Cloud Run with IAM
// required) at `audience`, usually its URL. The credentials are the runtime's own: on Cloud Run
// the metadata server mints the ID token for the service account. The client is made once.
export const createIdTokenAuthorization = (
  audience: string,
  auth: IdTokenAuth = new GoogleAuth(),
) => {
  let client: ReturnType<IdTokenAuth["getIdTokenClient"]> | undefined;
  return async () => {
    client ??= auth.getIdTokenClient(audience);
    const header = (await (await client).getRequestHeaders()).get("authorization");
    if (!header) throw new Error("The ID token client returned no Authorization header");
    return header;
  };
};
