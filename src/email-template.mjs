// Outreach email design: Friday writes the body as light text (paragraphs, **bold**, "### " headings, "- " bullets);
// this renders it into a clean, branded HTML email plus the plain-text alternative. Deliberately no images, no
// remote assets, no tracking pixels and no link wrapping: those push cold email into Promotions/spam. The
// signature and the opt-out footer are added here, so every email carries them exactly.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inline = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
const linkify = (s) => esc(s).replace(/\b((https?:\/\/)?(www\.)?linkedin\.com\/[^\s<]+|https?:\/\/[^\s<]+)/g, (m) => `<a href="${m.startsWith('http') ? m : `https://${m}`}" style="color:#5b21b6;text-decoration:none">${m}</a>`);

export const DEFAULT_BRAND = { name: 'Atharv Bhosale', title: 'Forward-deployed AI engineer · Agentic systems', accent: '#6d28d9' };

// Blocks: paragraph | heading | list. Lines starting "- " or "• " are bullets; "### " (or "## ") is a heading.
export function parseBody(body) {
  const blocks = []; let para = []; let list = null;
  const flush = () => { if (para.length) { blocks.push({ type: 'p', text: para.join(' ') }); para = []; } if (list) { blocks.push({ type: 'ul', items: list }); list = null; } };
  for (const raw of String(body ?? '').replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const h = /^#{2,3}\s+(.+)$/.exec(line);
    const b = /^[-•*]\s+(.+)$/.exec(line);
    if (h) { flush(); blocks.push({ type: 'h', text: h[1] }); }
    else if (b) { if (para.length) { blocks.push({ type: 'p', text: para.join(' ') }); para = []; } (list ??= []).push(b[1]); }
    else { if (list) { blocks.push({ type: 'ul', items: list }); list = null; } para.push(line); }
  }
  flush();
  return blocks;
}

export function plainText(body) {
  return parseBody(body).map((b) => (b.type === 'h' ? b.text.toUpperCase() : b.type === 'ul' ? b.items.map((i) => `- ${i.replace(/\*\*/g, '')}`).join('\n') : b.text.replace(/\*\*/g, ''))).join('\n\n');
}

// What Gmail's own composer produces: default font, paragraphs, no header bar, no colours, no rules.
function plainHtml({ body, signature, optOut }) {
  const parts = parseBody(body).map((x) => (x.type === 'ul' ? `<ul>${x.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>` : `<div>${inline(x.text)}</div><div><br></div>`)).join('');
  const sig = String(signature).split('\n').filter(Boolean).map((l) => linkify(l).replace(/ style="[^"]*"/, '')).join('<br>');
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><div dir="ltr">${parts}<div>${sig}</div>${optOut ? `<div><br></div><div>${esc(optOut).replace(/\n/g, '<br>')}</div>` : ''}</div></body></html>`;
}

export function renderEmail({ body, signature = '', optOut = '', brand = DEFAULT_BRAND, header = true, style = 'designed' }) {
  const b = { ...DEFAULT_BRAND, ...(brand ?? {}) };
  const text = [plainText(body), signature, optOut].filter(Boolean).join('\n\n');
  if (style === 'plain') return { text, html: plainHtml({ body, signature, optOut }) };
  const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const parts = parseBody(body).map((x) => {
    if (x.type === 'h') return `<p style="margin:22px 0 8px;font-size:15px;font-weight:700;color:#111827">${inline(x.text)}</p>`;
    if (x.type === 'ul') return `<ul style="margin:0 0 14px;padding-left:20px">${x.items.map((i) => `<li style="margin:0 0 6px">${inline(i)}</li>`).join('')}</ul>`;
    return `<p style="margin:0 0 14px">${inline(x.text)}</p>`;
  }).join('\n');
  const sigLines = String(signature).split('\n').filter(Boolean);
  const sig = sigLines.length ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px;border-top:1px solid #e5e7eb;padding-top:14px;width:100%"><tr><td style="font-size:13px;line-height:1.55;color:#4b5563">${sigLines.map((l, i) => (i === 0 ? `<strong style="color:#111827;font-size:14px">${esc(l)}</strong>` : linkify(l))).join('<br>')}</td></tr></table>` : '';
  const head = header ? `<tr><td style="border-top:4px solid ${esc(b.accent)};padding:18px 0 16px;border-bottom:1px solid #f1f1f4"><div style="font-size:16px;font-weight:700;color:#111827;letter-spacing:.2px">${esc(b.name)}</div><div style="font-size:12px;color:#6b7280;margin-top:2px">${esc(b.title)}</div></td></tr>` : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:0;background:#ffffff"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#ffffff"><tr><td align="left" style="padding:8px 12px">
<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;${font};font-size:14.5px;line-height:1.6;color:#1f2937">
${head}
<tr><td style="padding-top:${header ? 18 : 0}px">
${parts}
${sig}
${optOut ? `<p style="margin:18px 0 0;font-size:12px;color:#9ca3af">${esc(optOut)}</p>` : ''}
</td></tr></table></td></tr></table></body></html>`;
  return { text, html };
}
