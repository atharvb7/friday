// Server-Sent Events over fetch streaming (clients send the Authorization
// header, so no secret ever appears in a URL).
const MAX_STREAMS = 20;
const HEARTBEAT_MS = 15_000;

export function openEventStream(req, res, bus, { heartbeatMs = HEARTBEAT_MS, filter = null } = {}) {
  if (bus.subscriberCount >= MAX_STREAMS) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end('{"error":"too_many_streams"}');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'keep-alive',
  });
  const write = (evt) => {
    if (filter && !filter(evt)) return;
    res.write(`id: ${evt.id}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
  };
  const last = Number(req.headers['last-event-id'] ?? 0) || 0;
  res.write(`retry: 3000\n\n`);
  for (const evt of bus.since(last)) write(evt);
  const unsubscribe = bus.subscribe(write);
  const hb = setInterval(() => res.write(': hb\n\n'), heartbeatMs);
  const close = () => { clearInterval(hb); unsubscribe(); };
  req.on('close', close);
  res.on('error', close);
}
