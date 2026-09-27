export type Lang = "ar" | "he" | "en";

/**
 * Cheap script-based language detection. Mixed messages ("وين طلبي אחי")
 * resolve to the dominant script. Returns null when there is no signal
 * (emoji, digits, order numbers) so the caller keeps the previous language.
 */
export function detectLanguage(text: string): Lang | null {
  let ar = 0;
  let he = 0;
  let latin = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x0600 && c <= 0x06ff) || (c >= 0x0750 && c <= 0x077f) || (c >= 0xfb50 && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff)) ar++;
    else if (c >= 0x0590 && c <= 0x05ff) he++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
  }
  const total = ar + he + latin;
  if (total < 2) return null;
  if (ar >= he && ar >= latin) return "ar";
  if (he >= ar && he >= latin) return "he";
  return "en";
}

/**
 * WhatsApp renders *bold*, _italic_, ~strike~ and plain lists. Convert common
 * Markdown the model might emit into WhatsApp-friendly text.
 */
export function toWhatsAppText(input: string, maxChars = 1500): string {
  let t = input.trim();
  t = t.replace(/\*\*(.+?)\*\*/g, "*$1*"); // **bold** -> *bold*
  t = t.replace(/__(.+?)__/g, "_$1_");
  t = t.replace(/^#{1,6}\s+/gm, ""); // headings
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1: $2"); // [text](url)
  t = t.replace(/^\s*[-*]\s+/gm, "• ");
  t = t.replace(/\n{3,}/g, "\n\n");
  if (t.length > maxChars) {
    const cut = t.slice(0, maxChars);
    const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
    t = (lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak) : cut).trim();
  }
  return t;
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
