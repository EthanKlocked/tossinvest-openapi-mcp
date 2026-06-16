#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { TossInvestClient } from './tossClient.js';
import { executeTool, toolDefinitions } from './tools.js';
import { redactSensitive } from './redaction.js';

const config = loadConfig();
const client = new TossInvestClient(config);
const server = new McpServer({ name: 'tossinvest-mcp-server', version: '0.1.0' });

for (const tool of toolDefinitions) {
  server.tool(tool.name, tool.description, tool.schema, async (args) => {
    try {
      const result = await executeTool(tool.name, args as Record<string, unknown>, { client, config });
      return { content: [{ type: 'text', text: JSON.stringify(redactSensitive(result), null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(redactSensitive({ error: message }), null, 2) }] };
    }
  });
}

await server.connect(new StdioServerTransport());
