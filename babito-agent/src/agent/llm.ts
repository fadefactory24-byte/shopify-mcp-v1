/**
 * Provider-neutral LLM interface. The agent loop only talks to this, so
 * swapping Claude for another provider means writing one adapter file.
 */
export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export interface ChatMessage {
  role: "user" | "assistant";
  content: ChatBlock[];
  /**
   * Provider-native assistant content, echoed back unchanged inside a tool loop
   * (e.g. Claude thinking blocks must be passed back as-is).
   */
  raw?: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LLMRequest {
  model: string;
  /** Stable instructions — cached by providers that support prompt caching. */
  systemStatic: string;
  /** Per-request context (time, customer, conversation state). Not cached. */
  systemDynamic?: string;
  tools?: ToolSpec[];
  messages: ChatMessage[];
  maxTokens: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Lightweight calls (summaries) skip thinking/effort settings. */
  lightweight?: boolean;
}

export interface LLMResponse {
  content: ChatBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  raw?: unknown;
  model: string;
}

export interface LLMProvider {
  complete(req: LLMRequest): Promise<LLMResponse>;
}

export function textOf(res: { content: ChatBlock[] }): string {
  return res.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
