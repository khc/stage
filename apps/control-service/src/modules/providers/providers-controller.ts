import { Elysia, t } from "elysia";

import { doc, errors } from "../../http/openapi";
import { ProvidersModel } from "./providers-model";
import type { ProvidersService } from "./providers-service";

const tag = "Providers";
const providerNotFound = {
  description: "No such provider (`provider_not_found`).",
  schema: errors.invalid.schema,
};

export const providersController = (providersService: ProvidersService) =>
  new Elysia({ prefix: "/providers" })
    .get("", async () => ({ providers: await providersService.list() }), {
      ...doc(tag, "List configured model providers", {
        200: {
          description: "The configured providers (without raw API keys).",
          schema: t.Object({ providers: t.Array(ProvidersModel.provider) }),
        },
        502: errors.dependency,
      }),
    })
    .get(
      "/:providerId",
      async ({ params, status }) =>
        (await providersService.get(params.providerId.toLowerCase())) ??
        status(404, { error: "provider_not_found" }),
      {
        params: ProvidersModel.params,
        ...doc(tag, "Get a configured provider", {
          200: { description: "The provider summary.", schema: ProvidersModel.provider },
          400: errors.invalid,
          404: providerNotFound,
          502: errors.dependency,
        }),
      },
    )
    .post(
      "/models",
      async ({ body, status }) => {
        const result = await providersService.fetchModels(body);
        if (result.status === "ok") return { models: result.models };
        if (result.status === "provider_not_found")
          return status(404, { error: "provider_not_found" });
        return status(400, { error: result.status });
      },
      {
        body: ProvidersModel.fetchModelsBody,
        ...doc(tag, "Fetch available models from a provider API", {
          200: { description: "Available model identifiers.", schema: ProvidersModel.modelsResponse },
          400: {
            description:
              "Invalid input, `invalid_base_url`, `invalid_api_key`, or `api_key_required`.",
            schema: errors.invalid.schema,
          },
          404: providerNotFound,
          502: errors.dependency,
        }),
      },
    )
    .post(
      "",
      async ({ body, status }) => {
        const result = await providersService.create(body);
        if (result.status !== "created") return status(400, { error: result.status });
        return status(201, result.provider);
      },
      {
        body: ProvidersModel.createBody,
        ...doc(tag, "Create a model provider", {
          201: { description: "The created provider.", schema: ProvidersModel.provider },
          400: {
            description: "Invalid input or `baseUrl` (`invalid_base_url`).",
            schema: errors.invalid.schema,
          },
          502: errors.dependency,
        }),
      },
    )
    .patch(
      "/:providerId",
      async ({ params, body, status }) => {
        const result = await providersService.update(params.providerId.toLowerCase(), body);
        if (result.status === "updated") return result.provider;
        if (result.status === "not_found") return status(404, { error: "provider_not_found" });
        return status(400, { error: result.status });
      },
      {
        params: ProvidersModel.params,
        body: ProvidersModel.updateBody,
        ...doc(tag, "Update a model provider", {
          200: { description: "The updated provider.", schema: ProvidersModel.provider },
          400: {
            description: "Invalid input or `baseUrl` (`invalid_base_url`).",
            schema: errors.invalid.schema,
          },
          404: providerNotFound,
          502: errors.dependency,
        }),
      },
    )
    .delete(
      "/:providerId",
      async ({ params, status }) =>
        (await providersService.delete(params.providerId.toLowerCase()))
          ? status(204, undefined)
          : status(404, { error: "provider_not_found" }),
      {
        params: ProvidersModel.params,
        ...doc(tag, "Delete a model provider", {
          204: "Deleted.",
          400: errors.invalid,
          404: providerNotFound,
          502: errors.dependency,
        }),
      },
    );
