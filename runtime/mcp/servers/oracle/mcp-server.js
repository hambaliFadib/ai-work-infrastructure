/**
 * Repository-owned Oracle MCP stdio entrypoint.
 * Startup only creates the MCP server and transport; it never connects to Oracle.
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema
} = require('@modelcontextprotocol/sdk/types.js');
const oracle = require('./server');

const TOOL_SCHEMAS = {
  oracle_health: {
    type: 'object',
    properties: { profile: { type: 'string' } },
    required: ['profile']
  },
  oracle_read: {
    type: 'object',
    properties: {
      profile: { type: 'string' }, schema: { type: 'string' }, table: { type: 'string' },
      columns: { type: 'array', items: { type: 'string' } }, where: { type: 'object' },
      order_by: { type: 'array' }, limit: { type: 'integer' }
    },
    required: ['profile', 'schema', 'table']
  },
  oracle_insert: { type: 'object', properties: { profile: { type: 'string' }, schema: { type: 'string' }, table: { type: 'string' }, values: { type: 'object' }, dry_run: { type: 'boolean' }, commit: { type: 'boolean' } }, required: ['profile', 'schema', 'table', 'values'] },
  oracle_update: { type: 'object', properties: { profile: { type: 'string' }, schema: { type: 'string' }, table: { type: 'string' }, set: { type: 'object' }, where: { type: 'object' }, dry_run: { type: 'boolean' }, commit: { type: 'boolean' } }, required: ['profile', 'schema', 'table', 'set', 'where'] },
  oracle_ddl: { type: 'object', properties: { profile: { type: 'string' }, action: { type: 'string' }, schema: { type: 'string' }, table: { type: 'string' }, column: { type: 'string' }, data_type: { type: 'string' }, dry_run: { type: 'boolean' } }, required: ['profile', 'action', 'schema', 'table'] }
};

function envConfig() {
  return {
    'oracle-dev': {
      user: process.env.ORACLE_USER,
      connection_string: process.env.ORACLE_CONNECTION_STRING,
      schema_allowlist: (process.env.ORACLE_SCHEMA_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean),
      max_rows: process.env.ORACLE_MAX_ROWS
    }
  };
}

function createServer() {
  const server = new Server(
    { name: 'oracle-mcp-server', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: oracle.TOOLS.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: TOOL_SCHEMAS[tool.name]
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const name = request.params.name;
    const args = request.params.arguments || {};
    const config = envConfig();
    const handlers = {
      oracle_health: oracle.handleOracleHealth,
      oracle_read: oracle.handleOracleRead,
      oracle_insert: oracle.handleOracleInsert,
      oracle_update: oracle.handleOracleUpdate,
      oracle_ddl: oracle.handleOracleDdl
    };
    if (!handlers[name]) {
      return { isError: true, content: [{ type: 'text', text: 'Unknown tool' }] };
    }
    const result = handlers[name](args, config);
    return {
      isError: result.ok === false,
      content: [{ type: 'text', text: JSON.stringify(result) }]
    };
  });

  return server;
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  main().catch(error => {
    console.error('MCP server startup failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { createServer, TOOL_SCHEMAS };
