import type { Db } from "../db/client.js";
import { repo, type Conversation, type Customer, type MessageRow } from "../db/repo.js";
import type { Logger } from "../logger.js";
import type { HandoffNotifier } from "../pipeline/handoff.js";
import type { ShopifyService } from "../shopify/service.js";
import type { Lang } from "../util/text.js";
import { ungroundedPrices } from "./guardrails.js";
import { businessClock, type KnowledgeService } from "./knowledge.js";
import { textOf, type ChatBlock, type ChatMessage, type LLMProvider } from "./llm.js";
import { businessLayer, CORE_RULES, dynamicContext, staffHoursText } from "./prompt.js";
import { executeTool, TOOL_SPECS, type ToolContext, type ToolExecution } from "./tools.js";

export interface AgentDeps {
  db: Db;
  llm: LLMProvider;
  shopify: ShopifyService;
  knowledge: KnowledgeService;
  notifier: HandoffNotifier;
  log: Logger;
  config: { model: string; effort: "low" | "medium" | "high" | "xhigh" | "max"; maxIterations: number; historyMessages: number };
}

export interface AgentResult {
  status: "succeeded" | "handoff" | "failed";
  reply: string | null;
  handedOff: boolean;
  iterations: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  toolCalls: ToolExecution[];
  flags: string[];
  error?: string;
}

/** Build provider-neutral history from stored messages (text only; old tool traffic is not replayed). */
export function buildHistory(rows: MessageRow[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const r of rows) {
    if (!r.body) continue;
    const role: ChatMessage["role"] = r.direction === "inbound" ? "user" : "assistant";
    const text = r.author === "human_agent" ? `[team member wrote] ${r.body}` : r.body;
    const last = out[out.length - 1];
    if (last && last.role === role) (last.content[0] as { type: "text"; text: string }).text += `\n${text}`;
    else out.push({ role, content: [{ type: "text", text }] });
  }
  // The API requires the first message to be from the user.
  while (out.length && out[0]!.role !== "user") out.shift();
  return out;
}

export async function runAgent(
  deps: AgentDeps,
  input: { customer: Customer; conversation: Conversation; pending: MessageRow[]; replyLanguage: Lang | null },
): Promise<AgentResult> {
  const { db, llm, knowledge, log } = deps;
  const settings = await knowledge.settings();
  const clock = businessClock(settings.businessHours);
  const [memories, historyRows, kbIndex] = await Promise.all([
    repo.getMemories(db, input.customer.id),
    repo.recentMessages(db, input.conversation.id, deps.config.historyMessages),
    knowledge.index(),
  ]);

  const systemStatic = `${CORE_RULES}\n\n${businessLayer({
    personaNotes: settings.personaNotes,
    knowledgeIndex: kbIndex,
    staffHoursText: staffHoursText(settings.businessHours?.days as Record<string, [string, string] | null> | undefined),
  })}`;

  const ctx: ToolContext = {
    db,
    shopify: deps.shopify,
    knowledge,
    notifier: deps.notifier,
    log,
    customer: input.customer,
    conversation: input.conversation,
    context: structuredClone(input.conversation.context ?? {}),
    state: { handedOff: false },
  };

  const messages = buildHistory(historyRows);
  if (messages.length === 0 || messages[messages.length - 1]!.role !== "user") {
    // Should not happen (pending inbound messages are part of history), but stay safe.
    const text = input.pending.map((p) => p.body).filter(Boolean).join("\n");
    messages.push({ role: "user", content: [{ type: "text", text: text || "(empty message)" }] });
  }

  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  const toolCalls: ToolExecution[] = [];
  const flags: string[] = [];
  let iterations = 0;
  let repairAttempted = false;

  const persistContext = () => repo.updateConversationContext(db, input.conversation.id, ctx.context);

  try {
    while (iterations < deps.config.maxIterations) {
      iterations++;
      const res = await llm.complete({
        model: deps.config.model,
        systemStatic,
        systemDynamic: dynamicContext({
          now: clock.local,
          staffAvailableNow: clock.staffAvailableNow,
          customer: input.customer,
          memories,
          conversation: { ...input.conversation, context: ctx.context },
          replyLanguage: input.replyLanguage,
        }),
        tools: TOOL_SPECS,
        messages,
        maxTokens: 8000,
        effort: deps.config.effort,
      });
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      usage.cacheReadTokens += res.usage.cacheReadTokens;

      if (res.stopReason === "refusal") {
        flags.push("model_refusal");
        break;
      }

      const toolUses = res.content.filter((b): b is Extract<ChatBlock, { type: "tool_use" }> => b.type === "tool_use");
      if (toolUses.length > 0 && res.stopReason !== "max_tokens") {
        messages.push({ role: "assistant", content: res.content, raw: res.raw });
        // Tools run in parallel; all results go back in ONE user message.
        const execs = await Promise.all(toolUses.map((tu) => executeTool(tu.name, tu.input, ctx)));
        const results: ChatBlock[] = execs.map((ex, i) => ({
          type: "tool_result",
          toolUseId: toolUses[i]!.id,
          content: JSON.stringify(ex.output),
          isError: !ex.success,
        }));
        for (const ex of execs) {
          toolCalls.push(ex);
          log.info(
            { event: "tool_call", conversationId: input.conversation.id, tool: ex.name, success: ex.success, latencyMs: ex.latencyMs, error: ex.error ?? undefined },
            "tool executed",
          );
        }
        messages.push({ role: "user", content: results });
        continue;
      }

      const reply = textOf(res);
      if (!reply) {
        flags.push("empty_reply");
        break;
      }

      // Guardrail: every quoted price must come from a tool result in this run.
      const bad = ungroundedPrices(reply, toolCalls.filter((t) => t.success).map((t) => t.output));
      if (bad.length > 0) {
        flags.push(`ungrounded_price:${bad.join(",")}`);
        log.warn({ event: "guardrail", conversationId: input.conversation.id, prices: bad }, "ungrounded price in draft reply");
        if (!repairAttempted) {
          repairAttempted = true;
          messages.push({ role: "assistant", content: res.content, raw: res.raw });
          messages.push({
            role: "user",
            content: [
              {
                type: "text",
                text: `[automatic check, not from the customer] Your draft quoted price(s) ${bad.join(", ")} that no tool returned in this turn. Call get_product/search_products to get the current price, or rewrite without the price. Reply with the corrected message for the customer only.`,
              },
            ],
          });
          continue;
        }
        break; // second failure -> safe fallback below
      }

      await persistContext();
      return {
        status: ctx.state.handedOff ? "handoff" : "succeeded",
        reply,
        handedOff: ctx.state.handedOff,
        iterations,
        usage,
        toolCalls,
        flags,
      };
    }

    if (iterations >= deps.config.maxIterations) flags.push("max_iterations");
    await persistContext();
    // No safe reply could be produced: fail closed (the pipeline hands off).
    return { status: "failed", reply: null, handedOff: ctx.state.handedOff, iterations, usage, toolCalls, flags, error: flags.join(";") || "no reply" };
  } catch (err) {
    await persistContext().catch(() => {});
    return {
      status: "failed",
      reply: null,
      handedOff: ctx.state.handedOff,
      iterations,
      usage,
      toolCalls,
      flags: [...flags, "exception"],
      error: (err as Error).message ?? String(err),
    };
  }
}
