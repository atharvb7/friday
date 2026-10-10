// src/whatsapp.mjs — WhatsAppFlow: staged-only WhatsApp send via EFFECTS ledger.
//
// SAFETY / ToS (read before enabling):
// - Automating WhatsApp Web (consumer personal account) may violate WhatsApp
//   ToS and risks an account ban. Use a DEDICATED browser profile only (never
//   your everyday Chrome), log in MANUALLY once (scan QR in the headed profile,
//   session stays in data/browser-profiles/friday, dir 0700), no bulk or
//   unsolicited messaging, human-supervised single sends only.
// - Staging is NOT sending: stage() only validates recipient allowlist + file
//   and mints an approval token. Sending happens only in commit() after the
//   caller presents the SAME token + byte-identical exactArgs.
// - No live send yet: commit() resolves verified_failure with
//   'whatsapp_not_logged_in' unless BOTH FRIDAY_WHATSAPP_READY=1 AND a live
//   driver (RealBrowser launched, or an injected sender) is present. Set the
//   env var only after manual QR login is verified in the dedicated profile.
// - Rate limit: 1 send/minute per flow instance (throws rate_limited).
// - Crash safety: commit uses effects beginCommit->resolve; a crash between
//   them reopens as effect_unknown (see Effects constructor) and can NEVER be
//   blind-retried: beginCommit from effect_unknown throws, so a human must
//   inspect before any new effect is proposed. This module never re-sends on
//   its own (no blind-resend).
// - contacts.json lives in data/ (FRIDAY_DATA_DIR or ./data). Exact id match
//   only; any inexact/ambiguous input throws instead of guessing.

import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { existsSync, mkdirSync, chmodSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATA_DIR = resolve(HERE, '..', 'data');
export const CONTACTS_FILENAME = 'contacts.json';
export const EFFECT_KIND = 'whatsapp.send';
export const MAX_FILE_BYTES = 16 * 1024 * 1024; // 16MB WhatsApp attachment cap used here
export const MAX_CAPTION_LENGTH = 1024;
export const SEND_WINDOW_MS = 60_000; // 1 send/min
export const NOT_LOGGED_IN_ERROR = 'whatsapp_not_logged_in';

export function resolveDataDir(override) {
  const raw = override ?? process.env.FRIDAY_DATA_DIR ?? DEFAULT_DATA_DIR;
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) throw new TypeError('invalid data dir');
  return resolve(raw.trim());
}

export function loadContacts(dataDir) {
  const dir = resolveDataDir(dataDir);
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); } catch {}
  const path = join(dir, CONTACTS_FILENAME);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') throw new Error(`contacts_missing: create ${path}`);
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('contacts_invalid_json');
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.contacts;
  if (!Array.isArray(list) || list.length === 0) throw new Error('contacts_empty');
  for (const c of list) {
    if (!c || typeof c.id !== 'string' || !c.id.trim()) throw new Error('contacts_invalid_entry');
  }
  return { contacts: list, path };
}

// Exact id match only. Anything else -> throw (ambiguous candidates listed,
// never auto-picked).
export function resolveRecipient(contacts, recipientId) {
  if (typeof recipientId !== 'string' || !recipientId.trim()) throw new TypeError('recipientId required');
  const want = recipientId.trim();
  const exact = contacts.find((c) => c.id === want);
  if (exact) return exact;
  const lower = want.toLowerCase();
  const candidates = contacts.filter((c) => {
    const id = String(c.id);
    if (id.toLowerCase() === lower) return true;
    if (id.toLowerCase().includes(lower) || lower.includes(id.toLowerCase())) return true;
    if (typeof c.name === 'string' && c.name.toLowerCase().includes(lower)) return true;
    return false;
  });
  if (candidates.length > 0) {
    throw new Error(`ambiguous_recipient: ${candidates.map((c) => c.id).join(', ')}`);
  }
  throw new Error(`unknown_recipient: ${want}`);
}

function hashFile(absolutePath) {
  const data = readFileSync(absolutePath);
  return createHash('sha256').update(data).digest('hex');
}

export class WhatsAppFlow {
  constructor({ effects, taskId = null, dataDir = null, contactsPath = null, browser = null, sender = null, now = null } = {}) {
    if (!effects || typeof effects.propose !== 'function') throw new TypeError('effects ledger required');
    if (taskId !== null && (typeof taskId !== 'string' || !taskId.trim())) throw new TypeError('invalid taskId');
    if (contactsPath !== null && typeof contactsPath !== 'string') throw new TypeError('invalid contactsPath');
    if (browser !== null && typeof browser !== 'object') throw new TypeError('invalid browser driver');
    if (sender !== null && typeof sender !== 'function') throw new TypeError('sender must be a function');
    if (now !== null && typeof now !== 'function') throw new TypeError('now must be a function');
    this.effects = effects;
    this.taskId = taskId;
    this._dataDir = dataDir;
    this._contactsPath = contactsPath;
    this.browser = browser;
    this._sender = sender;
    this._now = now ?? Date.now;
    this._lastCommitAt = 0;
  }

  _contacts() {
    if (this._contactsPath) {
      const raw = readFileSync(this._contactsPath, 'utf8');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed?.contacts;
      if (!Array.isArray(list)) throw new Error('contacts_empty');
      return list;
    }
    return loadContacts(this._dataDir).contacts;
  }

  _taskId(opts) {
    const tid = opts?.taskId ?? this.taskId;
    if (typeof tid !== 'string' || !tid.trim()) {
      throw new Error('task_required: pass taskId to WhatsAppFlow or stage/commit opts');
    }
    return tid;
  }

  _validateFile(absolutePath) {
    if (typeof absolutePath !== 'string' || !absolutePath.trim() || absolutePath.includes('\0')) {
      throw new TypeError('file must be a non-empty absolute path string');
    }
    if (!isAbsolute(absolutePath)) throw new TypeError('file must be an absolute path');
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(absolutePath.trim()) && !absolutePath.startsWith('/')) {
      throw new TypeError('file must be a local path, not a URL');
    }
    let st;
    try {
      st = statSync(absolutePath);
    } catch {
      throw new Error('file_not_found');
    }
    if (!st.isFile()) throw new Error('not_a_file');
    if (st.size > MAX_FILE_BYTES) throw new Error(`file_too_large: ${st.size} > ${MAX_FILE_BYTES}`);
    const hash = hashFile(absolutePath);
    return { size: st.size, hash };
  }

  stage(recipientId, absolutePath, captionOrOpts, maybeOpts) {
    let caption = null;
    let opts = {};
    if (typeof captionOrOpts === 'object' && captionOrOpts !== null && !(captionOrOpts instanceof String)) {
      // stage(recipient, file, { caption, taskId })
      opts = captionOrOpts;
      caption = opts.caption ?? null;
    } else {
      caption = captionOrOpts ?? null;
      opts = maybeOpts ?? {};
    }
    if (caption !== null && caption !== undefined) {
      if (typeof caption !== 'string') throw new TypeError('caption must be a string');
      if (caption.length > MAX_CAPTION_LENGTH) throw new TypeError('caption_too_long');
    }
    const taskId = this._taskId(opts);
    const contact = resolveRecipient(this._contacts(), recipientId);
    const { size, hash } = this._validateFile(absolutePath);
    const exactArgs = {
      recipient: contact.id,
      file: resolve(absolutePath),
      size,
      hash,
      caption: caption ?? '',
    };
    const proposed = this.effects.propose(taskId, EFFECT_KIND, exactArgs);
    this.effects.stage(proposed.id, exactArgs);
    const { effect, token } = this.effects.requestApproval(proposed.id);
    // Staged only: sent:false. Caller must present token + identical exactArgs
    // to commit(); the token is single-use (see Effects.approve).
    return {
      staged: true,
      sent: false,
      effectId: effect.id,
      approvalToken: token,
      approvalExpiresAt: effect.approval_expires_at,
      preview: { recipient: contact.id, file: exactArgs.file, size, hash, caption: exactArgs.caption },
      exactArgs,
    };
  }

  async commit(effectId, token, exactArgs, opts = {}) {
    if (typeof effectId !== 'string' || !effectId) throw new TypeError('effectId required');
    if (typeof token !== 'string' || !token) throw new TypeError('approval token required');
    if (!exactArgs || typeof exactArgs !== 'object' || Array.isArray(exactArgs)) {
      throw new TypeError('exact arguments must be an object');
    }
    void this._taskId(opts); // validates task context when provided; ledger row owns task
    const now = this._now();
    if (now - this._lastCommitAt < SEND_WINDOW_MS) {
      throw new Error('rate_limited: 1 send/min; wait before retrying');
    }
    const current = this.effects.get(effectId);
    if (!current) throw new Error('effect not found');
    // Revalidate BEFORE approve so a changed recipient/file never consumes the
    // single-use approval: failed revalidation leaves awaiting_approval for
    // human inspection instead of committing.
    if (current.kind !== EFFECT_KIND) throw new Error('effect kind mismatch');
    resolveRecipient(this._contacts(), exactArgs.recipient);
    const { size, hash } = this._validateFile(exactArgs.file);
    if (size !== exactArgs.size || hash !== exactArgs.hash) {
      throw new Error('file_changed_since_stage');
    }
    this.effects.approve(effectId, token, exactArgs); // binds token + exact args
    this.effects.beginCommit(effectId, exactArgs);
    const liveReady = process.env.FRIDAY_WHATSAPP_READY === '1' && (this.browser?.launched === true || this._sender !== null);
    // Rate-limit window starts at commit attempt (after successful approval
    // binding), regardless of outcome — including not-logged-in.
    this._lastCommitAt = now;
    try {
      if (!liveReady) {
        return this.effects.resolve(effectId, 'verified_failure', {
          error: NOT_LOGGED_IN_ERROR,
          hint: 'manual QR login in dedicated profile required; set FRIDAY_WHATSAPP_READY=1 only after verified',
          staged: true,
          sent: false,
          recipient: exactArgs.recipient,
        });
      }
      if (this._sender) {
        const receipt = await this._sender(exactArgs);
        return this.effects.resolve(effectId, 'verified_success', {
          sent: true,
          recipient: exactArgs.recipient,
          ...(receipt && typeof receipt === 'object' ? receipt : {}),
        });
      }
      // READY + launched browser but no sender wired in this spike: refuse to
      // guess-click WhatsApp Web; human sends from the staged session instead.
      return this.effects.resolve(effectId, 'verified_failure', {
        error: 'whatsapp_send_not_implemented',
        hint: 'no auto-click sender wired; send manually from dedicated profile',
        staged: true,
        sent: false,
      });
    } catch (err) {
      // Sender threw mid-commit: verify before resolving; never blind-resend.
      // Resolve as verified_failure so the ledger shows observed outcome, and
      // surface the error. A crash before resolve stays effect_unknown.
      try {
        return this.effects.resolve(effectId, 'verified_failure', {
          error: err?.message ?? 'send_failed',
          staged: true,
          sent: false,
        });
      } catch {
        throw err;
      }
    }
  }

  status(effectId) {
    return this.effects.get(effectId);
  }
}

// Exists only so tests/health-checks can reference it without touching disk.
export function contactsPathFor(dataDir) {
  return join(resolveDataDir(dataDir), CONTACTS_FILENAME);
}

export function dataDirExists() {
  return existsSync(resolveDataDir(null));
}
