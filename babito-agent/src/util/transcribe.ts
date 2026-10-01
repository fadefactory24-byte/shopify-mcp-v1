/** Speech-to-text for staff voice notes. */
export interface Transcriber {
  transcribe(audio: ArrayBuffer, mime: string): Promise<string>;
}

/** Groq's hosted Whisper (OpenAI-compatible transcription endpoint; free tier: 2000 requests/day). */
export class GroqTranscriber implements Transcriber {
  constructor(private readonly opts: { apiKey: string; model: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {}

  async transcribe(audio: ArrayBuffer, mime: string): Promise<string> {
    const f = this.opts.fetchImpl ?? fetch;
    const base = mime.split(";")[0]!.trim() || "audio/ogg";
    const ext = base.split("/")[1]?.replace("mpeg", "mp3") || "ogg";
    const form = new FormData();
    form.append("file", new Blob([audio], { type: base }), `voice.${ext}`);
    form.append("model", this.opts.model);
    form.append("response_format", "json");
    // No language hint: staff mix spoken Arabic, Hebrew and English; Whisper detects it.
    const res = await f("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`transcription HTTP ${res.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text) as { text?: string };
    return (json.text ?? "").trim();
  }
}
