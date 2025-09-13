import { createTool } from "@mastra/core/tools";
import type { IMastraLogger } from "@mastra/core/logger";
import { z } from "zod";

const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";

export const perplexityTool = createTool({
  id: "perplexity-research-tool",
  description: `Use Perplexity AI to research and answer questions with access to real-time information from the web. This tool is perfect for finding current information, recent news, research papers, and factual answers to complex questions.`,
  inputSchema: z.object({
    query: z.string().describe("The research question or query to search for"),
    model: z.string().default("llama-3.1-sonar-small-128k-online").describe("The Perplexity model to use for research"),
  }),
  outputSchema: z.object({
    answer: z.string(),
    sources: z.array(z.string()).optional(),
    model_used: z.string(),
  }),
  execute: async ({ context: { query, model }, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔍 [Perplexity] Starting research with query:', { query, model });

    try {
      // Check if PERPLEXITY_API_KEY is available
      const apiKey = process.env.PERPLEXITY_API_KEY;
      if (!apiKey) {
        logger?.error('❌ [Perplexity] API key not found');
        throw new Error('Perplexity API key not configured. Please set PERPLEXITY_API_KEY environment variable.');
      }

      logger?.info('📝 [Perplexity] Making API request...');
      
      const response = await fetch(PERPLEXITY_API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: model,
          messages: [
            {
              role: "system",
              content: "You are a helpful research assistant. Provide comprehensive, accurate, and well-sourced answers to research questions. Include relevant sources when available."
            },
            {
              role: "user",
              content: query
            }
          ],
          max_tokens: 1000,
          temperature: 0.2,
          return_citations: true,
          return_images: false
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger?.error('❌ [Perplexity] API request failed:', { status: response.status, error: errorText });
        throw new Error(`Perplexity API request failed: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      logger?.info('📝 [Perplexity] API response received');

      const answer = data.choices?.[0]?.message?.content || "No answer received from Perplexity";
      const sources = data.citations || [];

      logger?.info('✅ [Perplexity] Research completed successfully');
      
      return {
        answer,
        sources,
        model_used: model,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error('❌ [Perplexity] Research failed:', { error: errorMessage });
      throw new Error(`Failed to research with Perplexity: ${errorMessage}`);
    }
  },
});