export type Lang = "ar" | "he" | "en";

// Arabic written in Latin letters: digits standing for Arabic sounds inside words (3andkom, 7abibi, 2desh), or common words.
const ARABIZI_DIGIT_WORD = /\b[a-z]*[235789][a-z]+\b/i;
const ARABIZI_WORDS = /\b(shu|sho|shou|kif|keef|baddi|badde|bdi|3and\w*|mar7aba|ahlan|yalla|wen|wein|mnih|mni7|ktir|kteer|lesh|leesh|mish|mesh|shukran|habibi|inshallah|ya3ni|tayeb|tamam|adesh|addesh|2desh|hal2a|bukra|ma3|kam)\b/gi;

function looksLikeArabizi(text: string): boolean {
  return ARABIZI_DIGIT_WORD.test(text) || (text.match(ARABIZI_WORDS)?.length ?? 0) >= 2;
}

/**
 * Cheap script-based language detection. Arabic or Hebrew script wins over
 * Latin (customers paste Latin product names: "شو الفرق بين SkyLift Pro و Lite"),
 * mixed Arabic/Hebrew resolves to the dominant of the two, and Arabizi counts
 * as Arabic. Returns null when there is no signal (emoji, digits, order
 * numbers) so the caller keeps the previous language.
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
  if (ar + he >= 2 && (ar + he) * 4 >= ar + he + latin) return ar >= he ? "ar" : "he";
  if (latin >= 2) return looksLikeArabizi(text) ? "ar" : "en";
  if (ar + he >= 2) return ar >= he ? "ar" : "he";
  return null;
}


const BIDI_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// First line of a quoted earlier email: Gmail ("On ... wrote:" / "בתאריך ... מאת ...:"), Arabic, Outlook headers.
const QUOTE_START = [
  /^on\s.{5,250}\swrote:?$/i,
  /^בתאריך\s.{5,250}\s(מאת|כתב|כתבה)\s.*$/,
  /^في\s.{5,250}(كتب|كتبت)\b.*$/,
  /^-{2,}\s*(original message|forwarded message|הודעה מקורית)/i,
  /^_{5,}$/,
];

/**
 * Removes the quoted earlier email from a customer's reply ("On ... wrote:", "בתאריך ... מאת ...:",
 * Outlook "From:/Sent:" header blocks, "> ..." lines). Quoted text is ours (bilingual notification
 * emails), so it must not drive language detection or be read as something the customer wrote.
 * Keeps the original text when nothing else is left.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(BIDI_MARKS, "").trim();
    if (QUOTE_START.some((re) => re.test(line))) break;
    if (/^(from|מאת|من):\s*\S/i.test(line) && (/\b(sent|date):/i.test(line) || lines.slice(i + 1, i + 4).some((l) => /^(sent|date|נשלח|נשלחה):/i.test(l.replace(BIDI_MARKS, "").trim())))) break;
    if (line.startsWith(">")) continue;
    kept.push(lines[i]!);
  }
  const out = kept.join("\n").trim();
  return out || text.trim();
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
  t = t.replace(/^\s*[-*–—]\s+/gm, "• ");
  // The owner treats the long dash as unprofessional: number ranges get a hyphen, everything else a comma.
  t = t.replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2").replace(/\s*[—–]\s*/g, ", ").replace(/, ([,.:!?])/g, "$1");
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
