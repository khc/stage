# Cloud Run Job image for the ADK agent (src/agent/main.ts).
# Runtime configuration is supplied only via environment variables at execution
# time; nothing is baked in: AGENT_MESSAGE (required), AGENT_MODEL (optional),
# and the Gemini credentials.
FROM oven/bun:1.4.4-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/agent ./src/agent

USER bun
ENTRYPOINT ["bun", "src/agent/main.ts"]
