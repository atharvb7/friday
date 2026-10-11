// The owner's personal details that forms ask for (name, phone, email, address). Stored locally in the
// settings table. The computer agent never sees these values: it writes {{profile.phone}} placeholders and the
// loop substitutes them just before typing; page contents and traces are scrubbed so values don't leak back.
export const PROFILE_FIELDS = Object.freeze(['name', 'phone', 'email', 'address']);

const VALIDATORS = {
  name: (v) => (v.length >= 1 && v.length <= 80 ? v : null),
  phone: (v) => { const d = v.replace(/[^\d+]/g, ''); return /^\+?\d{7,15}$/.test(d) ? d : null; },
  email: (v) => (/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(v) ? v : null),
  address: (v) => (v.length >= 5 && v.length <= 300 ? v : null),
};

export class Profile {
  constructor({ settings }) { this.settings = settings; }

  all() {
    const stored = this.settings.get('profile', {});
    return { name: stored.name ?? this.settings.get('user_name', null), phone: stored.phone ?? null, email: stored.email ?? null, address: stored.address ?? null };
  }

  set(field, value) {
    if (!PROFILE_FIELDS.includes(field)) throw new TypeError(`unknown field (allowed: ${PROFILE_FIELDS.join(', ')})`);
    const clean = VALIDATORS[field](String(value ?? '').trim());
    if (clean === null) throw new TypeError(`invalid ${field}`);
    const stored = this.settings.get('profile', {});
    this.settings.set('profile', { ...stored, [field]: clean });
    if (field === 'name') this.settings.set('user_name', clean);
    return clean;
  }

  clear(field) { const s = this.settings.get('profile', {}); delete s[field]; this.settings.set('profile', s); }

  // What the model may know: which fields exist, never the values.
  knownFields() { const a = this.all(); return Object.fromEntries(PROFILE_FIELDS.map((f) => [f, a[f] ? 'known' : 'unknown'])); }

  // {{profile.phone}} -> value. Returns { text, missing:[fields] }.
  substitute(text) {
    const a = this.all(); const missing = [];
    const out = String(text).replace(/\{\{\s*profile\.(name|phone|email|address)\s*\}\}/g, (m, f) => { if (!a[f]) { missing.push(f); return m; } return a[f]; });
    return { text: out, missing };
  }

  // Replace real values with their placeholders (applied to anything the model or logs could see).
  redact(text) {
    let out = String(text ?? ''); const a = this.all();
    for (const f of PROFILE_FIELDS) { const v = a[f]; if (v && v.length >= 4) out = out.split(v).join(`{{profile.${f}}}`); }
    const digits = a.phone ? a.phone.replace(/^\+/, '') : null;
    if (digits && digits.length >= 7) out = out.split(digits).join('{{profile.phone}}');
    return out;
  }
}
