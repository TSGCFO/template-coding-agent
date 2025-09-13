import { createTool } from "@mastra/core/tools";
import type { IMastraLogger } from "@mastra/core/logger";
import { z } from "zod";
import { MCPClient } from "@mastra/mcp";

// Diagnostics (no secrets):
console.log('[Boot] Rube MCP client init');
console.log('[Boot] env.RUBE_MCP_URL present?', Boolean(process.env.RUBE_MCP_URL));
console.log('[Boot] env.RUBE_MCP_TOKEN length:', process.env.RUBE_MCP_TOKEN ? String(process.env.RUBE_MCP_TOKEN).length : 0);

/**
 * Rube MCP Client configuration.
 * Expect the following environment variables:
 *  RUBE_MCP_URL   - The SSE/HTTP URL shown in the Rube installation guide (do NOT commit).
 *  RUBE_MCP_TOKEN - The signed bearer token generated in the guide.
 */
export const rubeMcpClient = new MCPClient({
  id: 'rube-mcp-client',
  servers: {
    rube: {
      url: new URL(process.env.RUBE_MCP_URL || 'https://rube.app/mcp'),
      requestInit: {
        headers: {
          Authorization: `Bearer ${process.env.RUBE_MCP_TOKEN || ''}`,
        },
      },
    },
  },
});

// Keep the internal reference for backward compatibility with mcpTool
const mcp = rubeMcpClient;

/**
 * Helper to fetch dynamic toolsets for per-request usage.
 * Use when each user/session carries its own auth context.
 */
export async function getRubeToolsets() {
  return rubeMcpClient.getToolsets();
}

// This tool provides access to external MCP (Model Context Protocol) servers
// allowing the agent to use third-party tools and resources
export const mcpTool = createTool({
  id: "mcp-integration-tool",
  description: `Access third-party tools and resources via Model Context Protocol (MCP) from rube.app.
  
  TOOL USAGE:
  1. Use action="list_tools" to discover available tools with their descriptions and schemas
  2. Execute tools with action="execute_tool" using the tool's ID (e.g., "RUBE_SEARCH_TOOLS")
  3. Provide tool_arguments as a JSON string matching the tool's inputSchema
  
  RESOURCE USAGE:
  1. Use action="list_resources" to discover available resources with their URIs and descriptions
  2. Use action="get_resource" with a resource_uri to fetch resource content
  3. Resources provide authoritative context and data - always cite URIs when referencing them
  
  PROMPT USAGE:
  1. Use action="list_prompts" to discover available prompt templates
  2. Use action="get_prompt" with prompt_name and arguments to fetch formatted prompts
  
  The MCP server provides capabilities for planning, searching, remote execution, resource access, and connection management. Always explore available tools and resources before making assumptions about arguments or capabilities.`,
  inputSchema: z.object({
    action: z.enum(["list_tools", "execute_tool", "list_resources", "get_resource", "list_prompts", "get_prompt"]).describe("The MCP action to perform"),
    server_name: z.string().optional().describe("Name of the MCP server (if targeting specific server)"),
    tool_name: z.string().optional().describe("Name of the tool to execute (for execute_tool action)"),
    tool_arguments: z.string().optional().describe("Arguments to pass to the tool (as JSON string)"),
    resource_uri: z.string().optional().describe("URI of the resource to retrieve"),
    prompt_name: z.string().optional().describe("Name of the prompt template to retrieve"),
    prompt_arguments: z.string().optional().describe("Arguments for the prompt template (as JSON string)"),
    max_bytes: z.number().optional().describe("Maximum bytes to read from resource (default: 100000)"),
    as_text: z.boolean().optional().describe("Whether to return resource as text (default: true for text MIME types)"),
  }),
  outputSchema: z.object({
    action: z.string(),
    data: z.any(),
    message: z.string(),
  }),
  execute: async ({ context: { action, server_name, tool_name, tool_arguments, resource_uri, prompt_name, prompt_arguments, max_bytes, as_text }, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔌 [MCP] Starting MCP operation:', { action, server_name, tool_name });

    try {
      switch (action) {
        case "list_tools": {
          logger?.info('📝 [MCP] Listing available tools...');
          try {
            const toolMap = await mcp.getTools();
            logger?.info('📊 [MCP] Raw tools response:', { toolMapKeys: Object.keys(toolMap) });
            
            // Parse the flat map of tools from Rube server
            const toolsList = Object.entries(toolMap).map(([fullKey, tool]: [string, any]) => {
              // Only include actual tool objects, not properties
              if (typeof tool === 'object' && tool !== null && typeof tool.execute === 'function') {
                return {
                  fullKey,
                  id: tool?.id || fullKey,
                  server: fullKey.split('_')[0] || 'Rube',
                  description: tool?.description || "No description available",
                  inputSchema: tool?.inputSchema,
                  outputSchema: tool?.outputSchema,
                };
              }
              return null;
            }).filter(Boolean);

            logger?.info('✅ [MCP] Parsed tools:', { toolCount: toolsList.length, tools: toolsList.map(t => t?.id || t?.fullKey) });

            return {
              action,
              data: toolsList,
              message: `Found ${toolsList.length} available MCP tools`,
            };
          } catch (error) {
            // If no servers are configured, return empty list
            return {
              action,
              data: [],
              message: "No MCP servers configured. Tools will be available once MCP servers are set up.",
            };
          }
        }

        case "execute_tool": {
          if (!tool_name) {
            throw new Error("Tool name is required for execute_tool action");
          }

          logger?.info('📝 [MCP] Executing tool...', { tool_name, tool_arguments });
          
          try {
            const toolMap = await mcp.getTools();
            
            // Find the tool by key or ID in the flat map
            const entry = Object.entries(toolMap).find(([key, tool]: [string, any]) => 
              key === tool_name || tool?.id === tool_name
            );
            
            if (!entry) {
              logger?.error('❌ [MCP] Tool not found:', { tool_name, availableKeys: Object.keys(toolMap) });
              throw new Error(`Tool '${tool_name}' not found. Available tools: ${Object.keys(toolMap).filter(k => typeof toolMap[k]?.execute === 'function').join(', ')}`);
            }

            const [fullKey, foundTool] = entry;
            
            if (typeof foundTool?.execute !== 'function') {
              throw new Error(`Tool '${fullKey}' is not executable (missing execute function)`);
            }
            
            logger?.info('🎯 [MCP] Found tool:', { fullKey, toolId: foundTool?.id, hasExecute: typeof foundTool?.execute === 'function' });

            // Parse tool arguments from JSON string
            let parsedArguments = {};
            if (tool_arguments) {
              try {
                parsedArguments = JSON.parse(tool_arguments);
              } catch (e) {
                throw new Error(`Invalid JSON format for tool_arguments: ${tool_arguments}`);
              }
            }

            // Execute the tool
            logger?.info('🚀 [MCP] Executing with arguments:', { parsedArguments });
            const result = await foundTool.execute({
              context: parsedArguments,
              mastra,
            });
            
            logger?.info('✅ [MCP] Tool execution successful:', { fullKey, resultKeys: Object.keys(result || {}) });

            return {
              action,
              data: {
                tool_name: foundTool?.id || fullKey,
                fullKey,
                result,
              },
              message: `Successfully executed tool '${foundTool?.id || fullKey}'`,
            };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to execute MCP tool: ${errorMessage}`);
          }
        }

        case "list_resources": {
          logger?.info('📝 [MCP] Listing available resources...');
          
          try {
            const resources = await mcp.getResources();
            
            const resourcesList = Object.entries(resources).flatMap(([serverName, serverResources]) =>
              serverResources.map(resource => ({
                server: serverName,
                uri: resource.uri,
                name: resource.name,
                description: resource.description || "No description available",
                mimeType: resource.mimeType,
              }))
            );

            return {
              action,
              data: resourcesList,
              message: `Found ${resourcesList.length} available MCP resources across ${Object.keys(resources).length} servers`,
            };
          } catch (error) {
            return {
              action,
              data: [],
              message: "No MCP servers configured or no resources available.",
            };
          }
        }

        case "get_resource": {
          if (!resource_uri) {
            throw new Error("Resource URI is required for get_resource action");
          }

          logger?.info('📖 [MCP] Getting resource content...', { resource_uri });
          
          try {
            // First, list all resources to find which server has this URI
            const resources = await mcp.getResources();
            let targetServer: string | null = null;
            let resourceInfo: any = null;
            
            // Find the server that has this resource
            for (const [serverName, serverResources] of Object.entries(resources)) {
              const found = serverResources.find((r: any) => r.uri === resource_uri);
              if (found) {
                targetServer = serverName;
                resourceInfo = found;
                break;
              }
            }
            
            if (!targetServer || !resourceInfo) {
              throw new Error(`Resource '${resource_uri}' not found. Use list_resources to see available resources.`);
            }
            
            logger?.info('🎯 [MCP] Found resource on server:', { server: targetServer, name: resourceInfo.name });
            
            // Use the resources.read method to fetch content
            const result = await (mcp as any).resources.read(targetServer, resource_uri);
            
            // Extract content from the result
            let content = '';
            let isBinary = false;
            const maxSize = max_bytes || 100000; // Default 100KB limit
            
            if (result?.contents && Array.isArray(result.contents)) {
              for (const item of result.contents) {
                if (item.text) {
                  content += item.text;
                } else if (item.blob) {
                  // Handle binary data
                  isBinary = true;
                  content = item.blob; // Base64 encoded
                  break;
                }
              }
            } else if (typeof result === 'string') {
              content = result;
            } else if (result?.text) {
              content = result.text;
            } else if (result?.data) {
              content = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
            }
            
            // Truncate if too large
            let truncated = false;
            if (!isBinary && content.length > maxSize) {
              content = content.substring(0, maxSize);
              truncated = true;
            }
            
            logger?.info('✅ [MCP] Resource retrieved successfully:', { 
              uri: resource_uri, 
              size: content.length, 
              truncated,
              isBinary 
            });
            
            return {
              action,
              data: {
                uri: resource_uri,
                server: targetServer,
                name: resourceInfo.name,
                description: resourceInfo.description,
                mimeType: resourceInfo.mimeType,
                content: isBinary ? content : content,
                isBinary,
                truncated,
                size: content.length,
              },
              message: `Successfully retrieved resource '${resourceInfo.name}' from server '${targetServer}'${truncated ? ' (truncated)' : ''}`,
            };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger?.error('❌ [MCP] Failed to get resource:', { error: errorMessage, resource_uri });
            throw new Error(`Failed to get MCP resource: ${errorMessage}`);
          }
        }

        case "list_prompts": {
          logger?.info('📝 [MCP] Listing available prompts...');
          
          try {
            // Check if the MCP client has a prompts namespace
            const mcpWithPrompts = mcp as any;
            if (!mcpWithPrompts.prompts || typeof mcpWithPrompts.prompts.list !== 'function') {
              return {
                action,
                data: [],
                message: "Prompts are not supported by the current MCP server configuration.",
              };
            }
            
            const prompts = await mcpWithPrompts.prompts.list();
            
            const promptsList = Object.entries(prompts).flatMap(([serverName, serverPrompts]) =>
              (Array.isArray(serverPrompts) ? serverPrompts : []).map((prompt: any) => ({
                server: serverName,
                name: prompt.name,
                description: prompt.description || "No description available",
                arguments: prompt.arguments || [],
              }))
            );

            logger?.info('✅ [MCP] Found prompts:', { count: promptsList.length });

            return {
              action,
              data: promptsList,
              message: `Found ${promptsList.length} available MCP prompts`,
            };
          } catch (error) {
            logger?.info('ℹ️ [MCP] Prompts not available:', { error: error instanceof Error ? error.message : String(error) });
            return {
              action,
              data: [],
              message: "No prompts available from MCP servers.",
            };
          }
        }

        case "get_prompt": {
          if (!prompt_name) {
            throw new Error("Prompt name is required for get_prompt action");
          }

          logger?.info('📝 [MCP] Getting prompt...', { prompt_name, prompt_arguments });
          
          try {
            const mcpWithPrompts = mcp as any;
            if (!mcpWithPrompts.prompts || typeof mcpWithPrompts.prompts.get !== 'function') {
              throw new Error("Prompts are not supported by the current MCP server configuration.");
            }
            
            // Parse prompt arguments if provided
            let parsedArgs = {};
            if (prompt_arguments) {
              try {
                parsedArgs = JSON.parse(prompt_arguments);
              } catch (e) {
                throw new Error(`Invalid JSON format for prompt_arguments: ${prompt_arguments}`);
              }
            }
            
            // Verify the prompt exists and get its details
            const prompts = await mcpWithPrompts.prompts.list();
            let promptInfo: any = null;
            let serverName: string = "";
            
            // Find the prompt and its details
            for (const [server, serverPrompts] of Object.entries(prompts)) {
              if (Array.isArray(serverPrompts)) {
                const found = serverPrompts.find((p: any) => p.name === prompt_name);
                if (found) {
                  promptInfo = found;
                  serverName = server;
                  logger?.info('🎯 [MCP] Found prompt:', { server: serverName, prompt_name, description: found.description });
                  break;
                }
              }
            }
            
            if (!promptInfo) {
              throw new Error(`Prompt '${prompt_name}' not found. Use list_prompts to see available prompts.`);
            }
            
            // Note: The prompts.get API has a known limitation with the current MCP client library
            // As a workaround, we return the prompt information with instructions
            logger?.info('ℹ️ [MCP] Note: Direct prompt execution not available, returning prompt template info');
            
            return {
              action,
              data: {
                name: prompt_name,
                server: serverName,
                description: promptInfo.description,
                arguments: promptInfo.arguments || [],
                providedArguments: parsedArgs,
                note: "Direct prompt execution is currently limited. Use the prompt description and arguments to construct your request manually.",
                instructions: `To use this prompt: ${promptInfo.description}. ${promptInfo.arguments?.length ? `Required arguments: ${JSON.stringify(promptInfo.arguments)}` : 'No arguments required.'}`,
              },
              message: `Retrieved prompt template '${prompt_name}' (execution via API currently limited)`,
            };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            
            // If it's the known API limitation error, provide a more helpful message
            if (errorMessage.includes("Server configuration not found")) {
              logger?.info('ℹ️ [MCP] Known limitation with prompts.get API, listing prompt info instead');
              
              try {
                const prompts = await (mcp as any).prompts.list();
                for (const [server, serverPrompts] of Object.entries(prompts)) {
                  if (Array.isArray(serverPrompts)) {
                    const found = serverPrompts.find((p: any) => p.name === prompt_name);
                    if (found) {
                      return {
                        action,
                        data: {
                          name: prompt_name,
                          server,
                          description: found.description,
                          arguments: found.arguments || [],
                          note: "The MCP client library has a known limitation with the prompts.get API. Use list_prompts to see available prompts and their descriptions.",
                        },
                        message: `Prompt template '${prompt_name}' found but direct execution is not available due to API limitations`,
                      };
                    }
                  }
                }
              } catch (fallbackError) {
                // If fallback also fails, throw original error
              }
            }
            
            logger?.error('❌ [MCP] Failed to get prompt:', { error: errorMessage, prompt_name });
            throw new Error(`Failed to get MCP prompt: ${errorMessage}`);
          }
        }

        default:
          throw new Error(`Unknown MCP action: ${action}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error('❌ [MCP] Operation failed:', { error: errorMessage, action });
      throw new Error(`MCP operation failed: ${errorMessage}`);
    }
  },
});