// Find where a plain-text reply stops being new writing and starts quoting earlier messages.

const WROTE = /^On\s.+wrote:\s*$/i;
const ORIGINAL = /^\s*-{2,}\s*(Original Message|Ursprüngliche Nachricht|Message d'origine)\s*-{2,}/i;
const FROM = /^\s*(From|Von|De|Da):\s+\S/i;
const SENT = /^\s*(Sent|Date|Gesendet|Datum|Envoyé|Inviato):\s+\S/i;
const FORWARD = /forwarded message|begin forwarded message|weitergeleitete nachricht/i;

/** Returns {head, quoted} or null when there is nothing to fold away. */
export function splitQuotedText(text) {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n');
  let at = -1;
  for (let i = 0; i < lines.length && at < 0; i++) {
    const line = lines[i];
    if (ORIGINAL.test(line) || WROTE.test(line)) at = i;
    // "On … wrote:" wrapped onto a second line by the sender's mail program
    else if (/^On\s/.test(line) && /wrote:\s*$/i.test(lines[i + 1] || '') && line.length < 200) at = i;
    // Outlook-style header block
    else if (FROM.test(line) && lines.slice(i + 1, i + 4).some((l) => SENT.test(l))) at = /^[\s_-]*$/.test(lines[i - 1] ?? '') && /[_-]{5,}/.test(lines[i - 1] ?? '') ? i - 1 : i;
    // a block of ">" lines that runs to the end
    else if (line.startsWith('>') && lines.slice(i).every((l) => !l.trim() || l.startsWith('>'))) at = i;
  }
  if (at < 0) return null;
  // A forward's quoted part is the point of the message: leave it open.
  if (lines.slice(0, at + 1).some((l) => FORWARD.test(l))) return null;
  const head = lines.slice(0, at).join('\n').trimEnd();
  if (!head.trim()) return null;
  return { head, quoted: lines.slice(at).join('\n').trimEnd() };
}
