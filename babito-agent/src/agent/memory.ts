import type { Db } from "../db/client.js";
import { repo, type Conversation } from "../db/repo.js";
import type { Logger } from "../logger.js";
import { textOf, type LLMProvider } from "./llm.js";

/**
 * Rolling conversation summary, produced by the cheap model. Keeps prompts
 * small for long chats: the agent sees the summary + the last N messages.
 * Runs after a reply is sent, never blocks the customer.
 */
export async function maybeSummarize(
  deps: { db: Db; llm: LLMProvider; log: Logger; fastModel: string; historyMessages: number },
  conversation: Conversation,
): Promise<void> {
  const { rows } = await deps.db.query<{ n: string }>(
    `select count(*)::text as n from messages where conversation_id = $1 and body is not null`,
    [conversation.id],
  );
  const total = Number(rows[0]?.n ?? 0);
  // Once the chat exceeds the window, refresh the summary every half-window of new messages.
  const summarized = conversation.context.summarized_count ?? 0;
  if (total <= deps.historyMessages || total - summarized < Math.ceil(deps.historyMessages / 2)) return;

  const older = await deps.db.query<{ direction: string; author: string; body: string }>(
    `select direction, author, body from messages where conversation_id = $1 and body is not null
     order by created_at desc offset $2 limit 60`,
    [conversation.id, deps.historyMessages],
  );
  if (older.rows.length === 0) return;
  const transcript = older.rows
    .reverse()
    .map((m) => `${m.direction === "inbound" ? "Customer" : m.author === "human_agent" ? "Staff" : "Assistant"}: ${m.body}`)
    .join("\n");

  try {
    const res = await deps.llm.complete({
      model: deps.fastModel,
      lightweight: true,
      maxTokens: 400,
      systemStatic:
        "Summarize this customer-service chat for the assistant's future context in <= 80 words, English. Keep: what the customer wants, products discussed, order numbers, open issues, preferences. Drop greetings. Never include phone numbers, emails, addresses or payment data. Do NOT include prices (they change).",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: `${conversation.summary ? `Previous summary: ${conversation.summary}\n\n` : ""}Transcript:\n${transcript}` }],
        },
      ],
    });
    const summary = textOf(res).slice(0, 800);
    if (summary) await repo.setConversationSummary(deps.db, conversation.id, summary, total);
  } catch (err) {
    deps.log.warn({ err: String(err), conversationId: conversation.id }, "summary failed");
  }
}
