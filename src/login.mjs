// Owner sign-in for the public site: email + password (scrypt) and "Sign in with Google" (OpenID, allow-listed
// address only). Both end in the same revocable browser session as token sign-in, and both still ask for the
// authenticator code unless the owner explicitly trusts Google's own 2-step verification.
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const KEY = 'owner_login';
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const normEmail = (e) => String(e ?? '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export class OwnerLogin {
  constructor({ settings, google = null, publicUrl = null, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    Object.assign(this, { settings, google, fetchImpl, now });
    this.redirectUri = publicUrl ? `${String(publicUrl).replace(/\/+$/, '')}/oauth/google/login/callback` : null;
    this.states = new Map();   // google login state -> { verifier, expires }
    this.handoffs = new Map(); // one-time code -> { method, email, needsTotp, expires }
  }
  #cfg() { return this.settings.get(KEY, {}); }
  #save(patch) { this.settings.set(KEY, { ...this.#cfg(), ...patch }); }

  status() {
    const c = this.#cfg();
    return { email: c.email ?? null, password: Boolean(c.hash), googleEmail: c.googleEmail ?? c.email ?? null, googleSkipTotp: c.googleSkipTotp === true, google: this.googleReady() };
  }
  googleReady() { return Boolean(this.google?.clientId && this.google?.clientSecret && this.redirectUri); }

  setPassword(email, password) {
    const e = normEmail(email);
    if (!EMAIL_RE.test(e)) throw new TypeError('valid email required');
    const p = String(password ?? '');
    if (p.length < 10 || p.length > 200) throw new TypeError('password must be 10-200 characters');
    if (new Set(p).size < 5) throw new TypeError('password is too repetitive');
    const salt = randomBytes(16);
    const hash = scryptSync(p, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    this.#save({ email: e, salt: salt.toString('base64'), hash: hash.toString('base64'), set_at: new Date(this.now()).toISOString() });
    return this.status();
  }
  clearPassword() { const c = this.#cfg(); delete c.hash; delete c.salt; this.settings.set(KEY, c); return this.status(); }
  setGoogle({ email = undefined, skipTotp = undefined }) {
    const patch = {};
    if (email !== undefined) { const e = normEmail(email); if (e && !EMAIL_RE.test(e)) throw new TypeError('valid email required'); patch.googleEmail = e || null; }
    if (skipTotp !== undefined) patch.googleSkipTotp = skipTotp === true;
    this.#save(patch); return this.status();
  }

  // Constant-time-ish: always runs scrypt so a wrong email and a wrong password cost the same.
  checkPassword(email, password) {
    const c = this.#cfg();
    const salt = c.salt ? Buffer.from(c.salt, 'base64') : randomBytes(16);
    const got = scryptSync(String(password ?? ''), salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const want = c.hash ? Buffer.from(c.hash, 'base64') : randomBytes(64);
    return Boolean(c.hash) && normEmail(email) === c.email && timingSafeEqual(got, want);
  }

  // ---- Google (OpenID Connect, authorization code + PKCE) ----
  googleStart() {
    if (!this.googleReady()) throw new Error('google_login_not_configured');
    for (const [k, v] of this.states) if (v.expires < this.now()) this.states.delete(k);
    const state = b64url(randomBytes(24)); const verifier = b64url(randomBytes(48));
    this.states.set(state, { verifier, expires: this.now() + 10 * 60_000 });
    const q = new URLSearchParams({ client_id: this.google.clientId, redirect_uri: this.redirectUri, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account',
      code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }

  async googleFinish({ code, state, error }) {
    const st = this.states.get(String(state ?? '')); this.states.delete(String(state ?? ''));
    if (!st || st.expires < this.now()) throw new Error('expired — please try again');
    if (error) throw new Error('Google sign-in was cancelled');
    const r = await this.fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.google.clientId, client_secret: this.google.clientSecret, code: String(code ?? ''), redirect_uri: this.redirectUri, grant_type: 'authorization_code', code_verifier: st.verifier }), signal: AbortSignal.timeout(20_000) });
    const tok = await r.json().catch(() => ({}));
    if (!r.ok || !tok.access_token) throw new Error('Google did not complete the sign-in');
    const u = await this.fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(20_000) }).then((x) => x.json()).catch(() => ({}));
    const email = normEmail(u.email);
    const allowed = this.status().googleEmail;
    if (!email || u.email_verified !== true || !allowed || email !== allowed) throw new Error('This Google account is not allowed to sign in to Friday');
    return this.#handoff('google', email, !this.status().googleSkipTotp);
  }

  // A short-lived, single-use code the browser trades for a session (plus the authenticator code when required).
  #handoff(method, email, needsTotp) {
    for (const [k, v] of this.handoffs) if (v.expires < this.now()) this.handoffs.delete(k);
    const code = b64url(randomBytes(24));
    this.handoffs.set(code, { method, email, needsTotp, expires: this.now() + 3 * 60_000 });
    return { handoff: code, needsTotp };
  }
  peekHandoff(code) { const h = this.handoffs.get(String(code ?? '')); return h && h.expires >= this.now() ? h : null; }
  takeHandoff(code) { const h = this.peekHandoff(code); this.handoffs.delete(String(code ?? '')); return h; }
}
