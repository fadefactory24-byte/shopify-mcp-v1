import Anthropic from "@anthropic-ai/sdk";
import type { ChatBlock, ChatMessage, LLMProvider, LLMRequest, LLMResponse } from "./llm.js";

/**
 * Claude adapter.
 *  - Prompt caching: tools + static system prompt are cached (explicit breakpoint on the static block),
 *    plus top-level automatic caching for the conversation tail.
 *  - Adaptive thinking with configurable effort on the main model; thinking blocks
 *    are echoed back unchanged within a tool loop via `raw`.
 *  - Optional server-side refusal fallback ("fallbacks": "default").
 */
export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;

  constructor(private readonly opts: { apiKey: string; refusalFallback: boolean; timeoutMs?: number; fetchImpl?: typeof fetch; maxRetries?: number }) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      timeout: opts.timeoutMs ?? 60_000,
      maxRetries: opts.maxRetries ?? 2,
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: req.systemStatic, cache_control: { type: "ephemeral" } }];
    if (req.systemDynamic) system.push({ type: "text", text: req.systemDynamic });

    const supportsThinking = !req.lightweight && !/haiku/.test(req.model);
    const params: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      system,
      messages: req.messages.map(toAnthropicMessage),
      ...(req.tools?.length
        ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) }
        : {}),
      // Automatic caching of the growing message tail: tool-loop iterations and quick follow-ups re-read history at cache price.
      ...(!req.lightweight ? { cache_control: { type: "ephemeral" } } : {}),
      ...(supportsThinking ? { thinking: { type: "adaptive" } } : {}),
      ...(supportsThinking && req.effort ? { output_config: { effort: req.effort } } : {}),
    };
    const useFallback = this.opts.refusalFallback && !req.lightweight;
    if (useFallback) {
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }

    // Params include fields newer than the SDK typings (fallbacks), hence the cast.
    const res = (await this.client.beta.messages.create(params as any)) as Anthropic.Beta.BetaMessage;

    const content: ChatBlock[] = [];
    for (const block of res.content) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      else if (block.type === "tool_use") content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
    }
    const stop = res.stop_reason;
    return {
      content,
      stopReason: stop === "end_turn" || stop === "tool_use" || stop === "max_tokens" || stop === "refusal" ? stop : "other",
      usage: {
        inputTokens: res.usage.input_tokens ?? 0,
        outputTokens: res.usage.output_tokens ?? 0,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      },
      raw: res.content,
      model: res.model,
    };
  }
}

function toAnthropicMessage(m: ChatMessage): Anthropic.Beta.BetaMessageParam {
  if (m.role === "assistant" && m.raw) return { role: "assistant", content: m.raw as Anthropic.Beta.BetaContentBlockParam[] };
  return {
    role: m.role,
    content: m.content.map((b): Anthropic.Beta.BetaContentBlockParam => {
      switch (b.type) {
        case "text":
          return { type: "text", text: b.text };
        case "tool_use":
          return { type: "tool_use", id: b.id, name: b.name, input: b.input as Record<string, unknown> };
        case "tool_result":
          return { type: "tool_result", tool_use_id: b.toolUseId, content: b.content, is_error: b.isError };
      }
    }),
  };
}
