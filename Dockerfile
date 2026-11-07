# For directory checks: runs the stdio MCP server. Listing tools creates nothing and contacts nobody.
FROM node:22-slim
WORKDIR /app
COPY packages/myclawn-mcp ./packages/myclawn-mcp
COPY packages/myclawn-plugin ./packages/myclawn-plugin
WORKDIR /app/packages/myclawn-mcp
RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev
ENTRYPOINT ["node", "src/index.mjs"]
