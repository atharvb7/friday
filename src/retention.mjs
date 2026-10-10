// Keeps SQLite from growing forever. The audit hash chain is never pruned (its integrity is the point).
export const RETENTION_DAYS = { events: 90, notifications: 60, model_calls: 90, proactive_log: 30, rule_fires: 30, approvals: 90, chats: 365 };

export function prune(db, now = Date.now()) {
  const cut = (days) => new Date(now - days * 86400_000).toISOString();
  const out = {};
  const run = (name, sql, ...p) => { try { out[name] = db.prepare(sql).run(...p).changes; } catch { out[name] = 0; } };
  run('events', "DELETE FROM events WHERE created_at < ? AND task_id IN (SELECT id FROM tasks WHERE status IN ('completed','failed','cancelled'))", cut(RETENTION_DAYS.events));
  run('notifications', 'DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?', cut(RETENTION_DAYS.notifications));
  run('model_calls', 'DELETE FROM model_calls WHERE ts < ?', cut(RETENTION_DAYS.model_calls));
  run('proactive_log', 'DELETE FROM proactive_log WHERE ts < ?', cut(RETENTION_DAYS.proactive_log));
  run('rule_fires', 'DELETE FROM rule_fires WHERE ts < ?', cut(RETENTION_DAYS.rule_fires));
  run('approvals', "DELETE FROM approvals WHERE status != 'pending' AND created_at < ?", cut(RETENTION_DAYS.approvals));
  run('messages', 'DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE updated_at < ?)', cut(RETENTION_DAYS.chats));
  run('conversations', 'DELETE FROM conversations WHERE updated_at < ?', cut(RETENTION_DAYS.chats));
  return out;
}
