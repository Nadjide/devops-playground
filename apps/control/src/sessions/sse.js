export const SSE_LIMITS = Object.freeze({ heartbeatMs: 15_000, maxBufferedBytes: 1024 * 1024 });

function frame(name, data, id) {
  return `${id ? `id: ${id}\n` : ''}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Stream domain events as SSE. A cursor from another epoch, or one already
 * evicted from bounded history, gets `snapshot.required` instead of a replay.
 * Reconnection never replays mutations: only recorded observations are sent.
 */
export function streamSessionEvents(req, res, runtime, limits = SSE_LIMITS) {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    }
  };
  const send = (text) => {
    if (closed) {
      return;
    }
    res.write(text);
    // Slow clients are disconnected instead of buffering without bound.
    if (res.writableLength > limits.maxBufferedBytes) {
      close();
    }
  };

  const session = runtime.getSession();
  const history = runtime.getEvents();
  const cursor = req.get('last-event-id') ?? (typeof req.query.lastEventId === 'string' ? req.query.lastEventId : null);
  if (cursor) {
    const match = /^(.+):(.+):(\d+)$/.exec(cursor);
    const sequence = match ? Number(match[3]) : NaN;
    const firstAvailable = history[0]?.sequence ?? session.lastEventSequence + 1;
    const replayable = match && match[1] === session.id && match[2] === session.eventEpoch &&
      sequence >= firstAvailable - 1 && sequence <= session.lastEventSequence;
    if (!replayable) {
      send(frame('snapshot.required', { reason: 'cursor-unavailable', revision: session.revision }));
    } else {
      for (const event of history) {
        if (event.sequence > sequence) {
          send(frame('domain', event, event.id));
        }
      }
    }
  } else {
    send(frame('ready', { sessionId: session.id, eventEpoch: session.eventEpoch, sequence: session.lastEventSequence }));
  }

  const unsubscribe = runtime.subscribe((event) => send(frame('domain', event, event.id)));
  const heartbeat = setInterval(() => send(': heartbeat\n\n'), limits.heartbeatMs);
  res.on('close', close);
  return close;
}
