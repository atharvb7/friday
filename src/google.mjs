// Direct Gmail via the user's own Google Cloud OAuth client (free; no Composio). Friday runs the OAuth web flow
// itself: /oauth/google/callback on its tailnet HTTPS address. The refresh token lives in <data>/secrets/google.json
// (0600) and never reaches the model, the UI or logs. Scope: gmail.modify — read, label, draft, send, trash;
// it cannot permanently delete mail.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Buffer.from(String(s ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export class GoogleAuth {
  constructor({ clientId, clientSecret, publicUrl, dataDir, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    Object.assign(this, { clientId: clientId ?? '', clientSecret: clientSecret ?? '', fetchImpl, now });
    this.redirectUri = publicUrl ? `${String(publicUrl).replace(/\/+$/, '')}/oauth/google/callback` : '';
    this.file = join(dataDir, 'secrets', 'google.json');
    this.pending = new Map(); // state -> { verifier, expires }
    this.cache = null; // { access_token, expires_at }
  }
  get configured() { return Boolean(this.clientId && this.clientSecret && this.redirectUri); }
  #read() { try { return JSON.parse(readFileSync(this.file, 'utf8')); } catch { return null; } }
  #write(obj) { mkdirSync(join(this.file, '..'), { recursive: true, mode: 0o700 }); writeFileSync(this.file, JSON.stringify(obj), { mode: 0o600 }); try { chmodSync(this.file, 0o600); } catch { /* best effort */ } }
  get connected() { return Boolean(this.#read()?.refresh_token); }
  status() { const s = this.#read(); return { configured: this.configured, connected: Boolean(s?.refresh_token), email: s?.email ?? null, redirectUri: this.redirectUri || null }; }

  authUrl() {
    if (!this.configured) throw new Error('google_not_configured: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and FRIDAY_PUBLIC_URL in the server .env');
    for (const [k, v] of this.pending) if (v.expires < this.now()) this.pending.delete(k);
    const state = b64url(randomBytes(24)); const verifier = b64url(randomBytes(48));
    this.pending.set(state, { verifier, expires: this.now() + 10 * 60_000 });
    const q = new URLSearchParams({ client_id: this.clientId, redirect_uri: this.redirectUri, response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }

  // Unauthenticated browser redirect: only a fresh, single-use state minted by an authenticated owner is accepted.
  async callback({ code, state, error }) {
    const p = this.pending.get(String(state ?? '')); this.pending.delete(String(state ?? ''));
    if (!p || p.expires < this.now()) throw new Error('invalid_or_expired_state');
    if (error) throw new Error(`google_denied: ${String(error).slice(0, 80)}`);
    const tok = await this.#token({ grant_type: 'authorization_code', code: String(code ?? ''), redirect_uri: this.redirectUri, code_verifier: p.verifier });
    if (!tok.refresh_token) throw new Error('no_refresh_token: remove Friday from https://myaccount.google.com/permissions and connect again');
    this.cache = { access_token: tok.access_token, expires_at: this.now() + (tok.expires_in - 60) * 1000 };
    let email = null; try { email = (await this.api('GET', `${GMAIL}/profile`)).emailAddress ?? null; } catch { /* optional */ }
    this.#write({ refresh_token: tok.refresh_token, scope: tok.scope, email, connected_at: new Date(this.now()).toISOString() });
    return { email };
  }

  async #token(params) {
    const r = await this.fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...params }), signal: AbortSignal.timeout(20_000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (j.error === 'invalid_grant') { rmSync(this.file, { force: true }); this.cache = null; throw new Error('google_reauth_needed: the Google connection expired or was revoked — connect Gmail again in Settings'); }
      throw new Error(`google_token_${r.status}: ${String(j.error_description ?? j.error ?? '').slice(0, 160)}`);
    }
    return j;
  }

  async accessToken() {
    if (this.cache && this.cache.expires_at > this.now()) return this.cache.access_token;
    const s = this.#read(); if (!s?.refresh_token) throw new Error('gmail_not_connected: connect Gmail in Settings → Connected apps');
    const tok = await this.#token({ grant_type: 'refresh_token', refresh_token: s.refresh_token });
    this.cache = { access_token: tok.access_token, expires_at: this.now() + (tok.expires_in - 60) * 1000 };
    return tok.access_token;
  }

  async api(method, url, body = undefined) {
    const at = await this.accessToken();
    const r = await this.fetchImpl(url, { method, headers: { Authorization: `Bearer ${at}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
    const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`gmail_${r.status}: ${String(j?.error?.message ?? '').slice(0, 200)}`);
    return j;
  }

  async disconnect() {
    const s = this.#read();
    if (s?.refresh_token) await this.fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(s.refresh_token)}`, { method: 'POST' }).catch(() => {});
    rmSync(this.file, { force: true }); this.cache = null;
    return true;
  }
}

// ---------------------------------------------------------------- Gmail operations
function header(h, name) { return h?.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? null; }
function htmlToText(html) { return String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim(); }
function walkParts(part, out = { text: '', html: '', attachments: [] }) {
  if (!part) return out;
  if (part.filename && part.body?.attachmentId) out.attachments.push({ name: part.filename, mime: part.mimeType, size: part.body.size, attachment_id: part.body.attachmentId });
  else if (part.mimeType === 'text/plain' && part.body?.data && !out.text) out.text = fromB64url(part.body.data).toString('utf8');
  else if (part.mimeType === 'text/html' && part.body?.data && !out.html) out.html = fromB64url(part.body.data).toString('utf8');
  for (const p of part.parts ?? []) walkParts(p, out);
  return out;
}
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const cleanAddr = (s) => String(s ?? '').replace(/[\r\n]/g, ' ').trim();

export class Gmail {
  constructor({ google, files = null }) { Object.assign(this, { google, files }); }
  get ready() { return this.google.connected; }

  summary(m, { body = false, maxBody = 6000 } = {}) {
    const h = m.payload?.headers ?? [];
    const parts = walkParts(m.payload);
    const out = { id: m.id, thread_id: m.threadId, from: header(h, 'From'), to: header(h, 'To'), cc: header(h, 'Cc'), subject: header(h, 'Subject'), date: header(h, 'Date'), unread: (m.labelIds ?? []).includes('UNREAD'), labels: m.labelIds ?? [], snippet: m.snippet };
    if (parts.attachments.length) out.attachments = parts.attachments.map(({ name, mime, size, attachment_id }) => ({ name, mime, size, attachment_id }));
    if (body) out.body = (parts.text || htmlToText(parts.html)).slice(0, maxBody);
    return out;
  }

  async search({ query = 'in:inbox', max = 10 } = {}) {
    const list = await this.google.api('GET', `${GMAIL}/messages?${new URLSearchParams({ q: String(query), maxResults: String(Math.min(Math.max(1, Number(max) || 10), 25)) })}`);
    const ids = (list.messages ?? []).map((x) => x.id);
    const msgs = await Promise.all(ids.map((id) => this.google.api('GET', `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)));
    return { query, count: msgs.length, estimated_total: list.resultSizeEstimate ?? msgs.length, messages: msgs.map((m) => this.summary(m)) };
  }
  async open(id) { return this.summary(await this.google.api('GET', `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`), { body: true }); }
  async thread(id) { const t = await this.google.api('GET', `${GMAIL}/threads/${encodeURIComponent(id)}?format=full`); return { thread_id: t.id, messages: (t.messages ?? []).map((m) => this.summary(m, { body: true, maxBody: 3000 })) }; }
  async labels() { return { labels: ((await this.google.api('GET', `${GMAIL}/labels`)).labels ?? []).map((l) => ({ id: l.id, name: l.name, type: l.type })) }; }

  async #labelId(nameOrId) {
    const sys = { inbox: 'INBOX', unread: 'UNREAD', starred: 'STARRED', important: 'IMPORTANT', spam: 'SPAM' };
    if (sys[String(nameOrId).toLowerCase()]) return sys[String(nameOrId).toLowerCase()];
    const { labels } = await this.labels();
    return labels.find((l) => l.id === nameOrId || l.name.toLowerCase() === String(nameOrId).toLowerCase())?.id ?? null;
  }

  async organize({ op, ids = [], label = null, name = null }) {
    const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean).slice(0, 100);
    const mod = async (add, remove) => { await this.google.api('POST', `${GMAIL}/messages/batchModify`, { ids: list, addLabelIds: add, removeLabelIds: remove }); return { ok: true, op, count: list.length }; };
    if (op === 'create_label') return { label: await this.google.api('POST', `${GMAIL}/labels`, { name: String(name ?? label).slice(0, 100), labelListVisibility: 'labelShow', messageListVisibility: 'show' }) };
    if (!list.length) return { error: 'ids required' };
    if (op === 'mark_read') return mod([], ['UNREAD']);
    if (op === 'mark_unread') return mod(['UNREAD'], []);
    if (op === 'archive') return mod([], ['INBOX']);
    if (op === 'unarchive') return mod(['INBOX'], []);
    if (op === 'star') return mod(['STARRED'], []);
    if (op === 'unstar') return mod([], ['STARRED']);
    if (op === 'label' || op === 'unlabel') { const id = await this.#labelId(label); if (!id) return { error: `no label named ${label} (create_label first)` }; return op === 'label' ? mod([id], []) : mod([], [id]); }
    return { error: 'op must be mark_read, mark_unread, archive, unarchive, star, unstar, label, unlabel, create_label' };
  }

  // RFC 2822 message with optional chat-file attachments.
  async #mime({ to, cc, bcc, subject, body, attachments = [], inReplyTo = null, references = null }) {
    const boundary = `friday_${randomBytes(12).toString('hex')}`;
    const head = [`To: ${cleanAddr(to)}`, cc ? `Cc: ${cleanAddr(cc)}` : null, bcc ? `Bcc: ${cleanAddr(bcc)}` : null, `Subject: ${encodeHeader(cleanAddr(subject))}`, 'MIME-Version: 1.0',
      inReplyTo ? `In-Reply-To: ${inReplyTo}` : null, references ? `References: ${references}` : null].filter(Boolean);
    const text = Buffer.from(String(body ?? ''), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
    if (!attachments.length) return [...head, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', text].join('\r\n');
    const parts = [`--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', text];
    let total = 0;
    for (const fid of attachments) {
      const f = this.files?.resolve(fid); if (!f) throw new Error(`attachment not found: ${fid}`);
      const data = this.files.read(f.id); total += data.length; if (total > 20 * 1024 * 1024) throw new Error('attachments over 20 MB');
      parts.push(`--${boundary}`, `Content-Type: ${f.mime}; name="${encodeHeader(f.name)}"`, `Content-Disposition: attachment; filename="${encodeHeader(f.name)}"`, 'Content-Transfer-Encoding: base64', '', data.toString('base64').replace(/.{76}/g, '$&\r\n'));
    }
    parts.push(`--${boundary}--`);
    return [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts].join('\r\n');
  }

  async send({ to, cc = null, bcc = null, subject, body, attachments = [] }) {
    if (!to || !subject || !body) return { error: 'to, subject and body are required' };
    const raw = b64url(await this.#mime({ to, cc, bcc, subject, body, attachments }));
    const r = await this.google.api('POST', `${GMAIL}/messages/send`, { raw });
    return { sent: true, id: r.id, thread_id: r.threadId };
  }

  async #replyHeaders(messageId) {
    const m = await this.google.api('GET', `${GMAIL}/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Reply-To`);
    const h = m.payload?.headers ?? [];
    const mid = header(h, 'Message-ID'); const subj = header(h, 'Subject') ?? '';
    return { threadId: m.threadId, inReplyTo: mid, references: [header(h, 'References'), mid].filter(Boolean).join(' '), subject: /^re:/i.test(subj) ? subj : `Re: ${subj}`, replyTo: header(h, 'Reply-To') ?? header(h, 'From') };
  }

  async reply({ message_id, body, to = null, cc = null, attachments = [] }) {
    if (!message_id || !body) return { error: 'message_id and body are required' };
    const rh = await this.#replyHeaders(message_id);
    const raw = b64url(await this.#mime({ to: to ?? rh.replyTo, cc, subject: rh.subject, body, attachments, inReplyTo: rh.inReplyTo, references: rh.references }));
    const r = await this.google.api('POST', `${GMAIL}/messages/send`, { raw, threadId: rh.threadId });
    return { sent: true, id: r.id, thread_id: r.threadId };
  }

  async forward({ message_id, to, note = '' }) {
    const m = await this.open(message_id);
    const body = `${note ? `${note}\n\n` : ''}---------- Forwarded message ----------\nFrom: ${m.from}\nDate: ${m.date}\nSubject: ${m.subject}\nTo: ${m.to}\n\n${m.body ?? ''}`;
    return this.send({ to, subject: /^fwd?:/i.test(m.subject ?? '') ? m.subject : `Fwd: ${m.subject ?? ''}`, body });
  }

  async draft({ to, cc = null, bcc = null, subject, body, attachments = [], reply_to_message_id = null }) {
    let threadId; let extra = {};
    if (reply_to_message_id) { const rh = await this.#replyHeaders(reply_to_message_id); threadId = rh.threadId; extra = { inReplyTo: rh.inReplyTo, references: rh.references }; subject = subject ?? rh.subject; to = to ?? rh.replyTo; }
    const raw = b64url(await this.#mime({ to, cc, bcc, subject, body, attachments, ...extra }));
    const r = await this.google.api('POST', `${GMAIL}/drafts`, { message: { raw, ...(threadId ? { threadId } : {}) } });
    return { drafted: true, draft_id: r.id, note: 'Saved in Drafts — not sent.' };
  }
  async sendDraft({ draft_id }) { const r = await this.google.api('POST', `${GMAIL}/drafts/send`, { id: String(draft_id) }); return { sent: true, id: r.id, thread_id: r.threadId }; }
  async trash({ message_id = null, thread_id = null }) {
    if (thread_id) { await this.google.api('POST', `${GMAIL}/threads/${encodeURIComponent(thread_id)}/trash`); return { trashed: true, thread_id }; }
    if (message_id) { await this.google.api('POST', `${GMAIL}/messages/${encodeURIComponent(message_id)}/trash`); return { trashed: true, message_id }; }
    return { error: 'message_id or thread_id required' };
  }

  // Save an email attachment into the chat as a downloadable file.
  async attachment({ message_id, attachment_id, name, conversationId = null }) {
    const a = await this.google.api('GET', `${GMAIL}/messages/${encodeURIComponent(message_id)}/attachments/${encodeURIComponent(attachment_id)}`);
    const f = this.files.save({ name: name || 'attachment', data: fromB64url(a.data), source: 'email', conversationId });
    return { file: this.files.public(f), _attach: [f.id] };
  }
}
