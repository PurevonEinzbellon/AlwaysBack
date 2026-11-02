const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });

export function formatReply(reply, style) {
  if (!style?.splitMessages) return { parts: [reply.slice(0, 3000)], truncated: reply.length > 3000 };
  const maxChars = Math.min(100, Math.max(1, Number(style.maxCharsPerMessage) || 20));
  const maxMessages = Math.min(20, Math.max(1, Number(style.maxMessages) || 8));
  const parts = [];
  let truncated = false;
  for (const rawLine of reply.replace(/\r/g, '').split(/\n+/)) {
    let line = rawLine.trim().replace(/^[\-*•]\s+/, '');
    if (!line) continue;
    if (/^[「“"].+[」”"]$/u.test(line)) line = line.slice(1, -1).trim();
    let chars = Array.from(segmenter.segment(line), item => item.segment);
    while (chars.length) {
      if (parts.length >= maxMessages) { truncated = true; break; }
      let count = Math.min(chars.length, maxChars);
      if (chars.length > maxChars) {
        for (let index = count - 1; index >= Math.ceil(maxChars / 2); index--) {
          if (/[，。！？、；：…\s]/u.test(chars[index])) { count = index + 1; break; }
        }
      }
      const part = chars.slice(0, count).join('').trim();
      if (part) parts.push(part);
      chars = chars.slice(count);
    }
    if (truncated) break;
  }
  if (!parts.length) throw new Error('模型未返回可发送文本');
  return { parts, truncated };
}
