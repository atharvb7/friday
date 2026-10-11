// Composio: third-party apps (Instagram first) through one API key. The user connects an account once via
// Composio's hosted OAuth link; Friday then calls the toolkit's tools by slug. Every action is classified up front:
// reads run freely, anything that talks to other people or publishes needs approval, deletes are 'deletion'.
// Unknown/unlisted actions are refused, so a new upstream tool never becomes callable by accident.
const BASE = 'https://backend.composio.dev/api/v3.1';

export const TOOLKITS = Object.freeze({
  instagram: {
    label: 'Instagram',
    note: 'Instagram Business or Creator account only (personal accounts are not supported by the Instagram API). DMs can only be answered within 24h of their last message; new threads cannot be started.',
    read: ['GET_USER_INFO', 'GET_USER_INSIGHTS', 'GET_IG_USER_MEDIA', 'GET_IG_MEDIA', 'GET_IG_MEDIA_CHILDREN', 'GET_IG_MEDIA_COMMENTS', 'GET_IG_COMMENT_REPLIES',
      'GET_IG_MEDIA_INSIGHTS', 'GET_IG_USER_STORIES', 'GET_IG_USER_LIVE_MEDIA', 'GET_IG_USER_CONTENT_PUBLISHING_LIMIT', 'LIST_ALL_CONVERSATIONS', 'LIST_ALL_MESSAGES',
      'GET_CONVERSATION', 'GET_PAGE_CONVERSATIONS', 'GET_MESSENGER_PROFILE', 'GET_MULTIPLE_NODES'],
    act: ['SEND_TEXT_MESSAGE', 'SEND_IMAGE', 'POST_IG_COMMENT_REPLIES', 'POST_IG_MEDIA_COMMENTS', 'POST_IG_USER_MENTIONS', 'MARK_SEEN', 'SET_MEDIA_COMMENT_ENABLED',
      'POST_IG_USER_MEDIA', 'POST_IG_USER_MEDIA_PUBLISH', 'CREATE_CAROUSEL_CONTAINER'],
    delete: ['DELETE_COMMENT'],
  },
});

export function classify(toolkit, action) {
  const t = TOOLKITS[toolkit];
  const a = String(action ?? '').toUpperCase().replace(new RegExp(`^${toolkit.toUpperCase()}_`), '');
  if (!t) return { error: 'unknown_toolkit' };
  if (t.read.includes(a)) return { action: a, slug: `${toolkit.toUpperCase()}_${a}`, kind: 'read' };
  if (t.act.includes(a)) return { action: a, slug: `${toolkit.toUpperCase()}_${a}`, kind: 'act' };
  if (t.delete.includes(a)) return { action: a, slug: `${toolkit.toUpperCase()}_${a}`, kind: 'delete' };
  return { error: `action_not_allowed: ${a}. Allowed reads: ${t.read.join(', ')}; actions (need approval): ${[...t.act, ...t.delete].join(', ')}` };
}

export class Composio {
  constructor({ apiKey, userId = 'friday-owner', settings, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    Object.assign(this, { apiKey: apiKey ?? '', userId, settings, fetchImpl, sleep });
  }
  get configured() { return Boolean(this.apiKey); }

  async #req(method, path, body) {
    if (!this.configured) throw new Error('composio_not_configured: add COMPOSIO_API_KEY to the server .env');
    const r = await this.fetchImpl(`${BASE}${path}`, { method, headers: { 'x-api-key': this.apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) throw new Error('composio_401: Composio rejected the API key. Use a PROJECT API key (Composio dashboard → Settings → Project Settings → API Keys, usually starts with ak_) in COMPOSIO_API_KEY.');
    if (!r.ok) throw new Error(`composio_${r.status}: ${String(j?.error?.message ?? j?.message ?? '').replaceAll(this.apiKey, '[redacted]').slice(0, 240)}`);
    return j;
  }

  // One Composio-managed auth config per toolkit, created on first use and remembered.
  async authConfigId(toolkit) {
    const saved = this.settings.get('composio_auth_configs', {});
    if (saved[toolkit]) return saved[toolkit];
    const list = await this.#req('GET', `/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}&is_composio_managed=true`);
    let id = list.items?.find((x) => x.toolkit?.slug === toolkit)?.id;
    if (!id) id = (await this.#req('POST', '/auth_configs', { toolkit: { slug: toolkit }, auth_config: { type: 'use_composio_managed_auth' } })).auth_config?.id;
    if (!id) throw new Error('composio_auth_config_failed');
    this.settings.set('composio_auth_configs', { ...saved, [toolkit]: id });
    return id;
  }

  async connectLink(toolkit) {
    if (!TOOLKITS[toolkit]) throw new TypeError('unknown toolkit');
    const r = await this.#req('POST', '/connected_accounts/link', { auth_config_id: await this.authConfigId(toolkit), user_id: this.userId });
    return { url: r.redirect_url, expires_at: r.expires_at, connected_account_id: r.connected_account_id };
  }

  async accounts(toolkit = null) {
    const q = new URLSearchParams({ user_ids: this.userId }); if (toolkit) q.set('toolkit_slugs', toolkit);
    const r = await this.#req('GET', `/connected_accounts?${q}`);
    return (r.items ?? []).map((a) => ({ id: a.id, toolkit: a.toolkit?.slug, status: a.status }));
  }

  async status() {
    if (!this.configured) return { configured: false, apps: Object.entries(TOOLKITS).map(([slug, t]) => ({ slug, label: t.label, connected: false })) };
    let accts = [];
    try { accts = await this.accounts(); } catch (e) { return { configured: true, error: e.message, apps: [] }; }
    return { configured: true, apps: Object.entries(TOOLKITS).map(([slug, t]) => ({ slug, label: t.label, note: t.note, connected: accts.some((a) => a.toolkit === slug && a.status === 'ACTIVE'), pending: accts.some((a) => a.toolkit === slug && ['INITIATED', 'INITIALIZING'].includes(a.status)) })) };
  }

  async schema(toolkit, action) {
    const c = classify(toolkit, action); if (c.error) return c;
    const r = await this.#req('GET', `/tools/${c.slug}`);
    return { action: c.action, kind: c.kind, description: String(r.description ?? '').slice(0, 800), input_parameters: r.input_parameters ?? {} };
  }

  async execute(toolkit, action, args = {}) {
    const c = classify(toolkit, action); if (c.error) return c;
    const r = await this.#req('POST', `/tools/execute/${c.slug}`, { user_id: this.userId, arguments: args ?? {} });
    if (!r.successful) {
      const err = String(r.error ?? 'failed');
      // Meta only lets a business account message someone who messaged IT within the last 24 hours.
      if (toolkit === 'instagram' && /2534022|outside of allowed window/i.test(err)) {
        return { error: 'instagram_24h_window', explain: "Instagram's API only allows replying to people who messaged this account in the last 24 hours, and it cannot start new conversations. This person hasn't messaged within 24h, so nothing was sent.", fallback: 'Offer to send it from the laptop instead (computer_task: open instagram.com/direct in the browser and send it like a person would — the user must be logged in to Instagram in Friday\'s browser), or wait until they message first.' };
      }
      return { error: err.slice(0, 500) };
    }
    const text = JSON.stringify(r.data ?? {});
    return text.length > 12_000 ? { data_truncated: text.slice(0, 12_000) } : { data: r.data };
  }

  // Instagram publishing is two-step (container -> wait until processed -> publish); done as ONE approved action.
  async instagramPublish({ image_url = null, video_url = null, caption = '', media_type = null }) {
    if (!image_url && !video_url) return { error: 'image_url or video_url (public https URL) required' };
    const me = await this.execute('instagram', 'GET_USER_INFO', {});
    const igUserId = me.data?.id ?? me.data?.data?.id;
    if (!igUserId) return { error: `could not read the Instagram account id: ${me.error ?? 'unknown'}` };
    const created = await this.execute('instagram', 'POST_IG_USER_MEDIA', { ig_user_id: igUserId, caption: String(caption).slice(0, 2200), ...(image_url ? { image_url } : { video_url, media_type: media_type ?? 'REELS' }) });
    const containerId = created.data?.id ?? created.data?.data?.id;
    if (!containerId) return { error: `creating the post failed: ${created.error ?? JSON.stringify(created).slice(0, 200)}` };
    for (let i = 0; i < 30; i++) { // videos take a while to process
      const st = await this.execute('instagram', 'GET_IG_MEDIA', { ig_media_id: containerId, fields: 'status_code' }).catch(() => ({}));
      const code = st.data?.status_code ?? st.data?.data?.status_code;
      if (!code || code === 'FINISHED') break;
      if (code === 'ERROR' || code === 'EXPIRED') return { error: `instagram could not process the media (${code})` };
      await this.sleep(5000);
    }
    const pub = await this.execute('instagram', 'POST_IG_USER_MEDIA_PUBLISH', { ig_user_id: igUserId, creation_id: containerId });
    return pub.error ? { error: `publish failed: ${pub.error}` } : { published: true, media_id: pub.data?.id ?? pub.data?.data?.id ?? null };
  }
}
