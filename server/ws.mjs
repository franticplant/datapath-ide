// Minimal, dependency-free RFC 6455 WebSocket server/client (text, binary, fragmentation, ping/pong, close).
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { connect as netConnect } from 'node:net';

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_PAYLOAD = 8 * 1024 * 1024;
export const OPCODES = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

export class ProtocolError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function acceptKey(key) {
  return createHash('sha1').update(String(key) + WS_GUID).digest('base64');
}

// Serialize one frame. Clients must mask (RFC 6455 §5.3); servers must not.
export function encodeFrame(opcode, payload = Buffer.alloc(0), { fin = true, mask = false, rsv = 0 } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = data.length;
  const extra = length < 126 ? 0 : length <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + extra + (mask ? 4 : 0));
  header[0] = (fin ? 0x80 : 0) | ((rsv & 7) << 4) | (opcode & 0x0f);
  header[1] = (mask ? 0x80 : 0) | (extra === 0 ? length : extra === 2 ? 126 : 127);
  if (extra === 2) header.writeUInt16BE(length, 2);
  else if (extra === 8) header.writeBigUInt64BE(BigInt(length), 2);
  if (!mask) return Buffer.concat([header, data]);
  const key = randomBytes(4);
  key.copy(header, 2 + extra);
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) masked[i] = data[i] ^ key[i & 3];
  return Buffer.concat([header, masked]);
}

// Incremental frame parser: feed arbitrary chunks, receive complete frames.
export class FrameParser {
  constructor({ maxPayload = MAX_PAYLOAD, requireMask = true, forbidMask = false } = {}) {
    this.maxPayload = maxPayload;
    this.requireMask = requireMask;
    this.forbidMask = forbidMask;
    this.chunks = [];
    this.buffered = 0;
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    const frames = [];
    for (;;) {
      const frame = this.next();
      if (!frame) break;
      frames.push(frame);
    }
    return frames;
  }

  peek(n) {
    if (this.chunks.length > 1) { this.chunks = [Buffer.concat(this.chunks)]; }
    return this.chunks[0].subarray(0, n);
  }

  consume(n) {
    const buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = buf.subarray(0, n);
    const rest = buf.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.buffered -= n;
    return out;
  }

  next() {
    if (this.buffered < 2) return null;
    const head = this.peek(Math.min(this.buffered, 14));
    const fin = (head[0] & 0x80) !== 0;
    const rsv = (head[0] >> 4) & 7;
    const opcode = head[0] & 0x0f;
    const masked = (head[1] & 0x80) !== 0;
    let length = head[1] & 0x7f;
    let offset = 2;
    if (rsv) throw new ProtocolError(1002, 'Reserved bits set without a negotiated extension');
    if (![0x0, 0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode)) throw new ProtocolError(1002, `Unknown opcode ${opcode}`);
    const control = opcode >= 0x8;
    if (control && (!fin || length > 125)) throw new ProtocolError(1002, 'Control frames must be final and at most 125 bytes');
    if (this.requireMask && !masked) throw new ProtocolError(1002, 'Client frames must be masked');
    if (this.forbidMask && masked) throw new ProtocolError(1002, 'Server frames must not be masked');
    if (length === 126) {
      if (head.length < 4) return null;
      length = head.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (head.length < 10) return null;
      const big = head.readBigUInt64BE(2);
      if (big >> 63n) throw new ProtocolError(1002, 'Invalid 64-bit payload length');
      if (big > BigInt(this.maxPayload)) throw new ProtocolError(1009, 'Frame payload exceeds the size limit');
      length = Number(big);
      offset = 10;
    }
    if (length > this.maxPayload) throw new ProtocolError(1009, 'Frame payload exceeds the size limit');
    const maskOffset = offset;
    if (masked) offset += 4;
    if (this.buffered < offset + length) return null;
    const raw = this.consume(offset + length);
    const payload = Buffer.from(raw.subarray(offset));
    if (masked) {
      const key = raw.subarray(maskOffset, maskOffset + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
    }
    return { fin, opcode, payload };
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

// One WebSocket endpoint over a duplex socket. Events: message(data, isBinary), ping, pong, close(code, reason), error.
export class WebSocketConnection extends EventEmitter {
  constructor(socket, { role = 'server', maxPayload = MAX_PAYLOAD, head = null } = {}) {
    super();
    this.socket = socket;
    this.role = role;
    this.maxPayload = maxPayload;
    this.readyState = 1; // 0 connecting, 1 open, 2 closing, 3 closed
    this.parser = new FrameParser({ maxPayload, requireMask: role === 'server', forbidMask: role === 'client' });
    this.fragments = null; // { opcode, chunks, size }
    this.closeTimer = null;
    this.closeInfo = null;
    socket.setNoDelay?.(true);
    socket.on('data', chunk => this.onData(chunk));
    socket.on('error', error => { if (this.listenerCount('error')) this.emit('error', error); this.finish(1006, ''); });
    socket.on('close', () => this.finish(this.closeInfo?.code ?? 1006, this.closeInfo?.reason ?? ''));
    socket.on('end', () => { if (this.readyState < 3) socket.end(); });
    // Bytes that arrived with the handshake are replayed after the caller has attached its listeners.
    if (head?.length) setImmediate(() => this.onData(head));
  }

  onData(chunk) {
    if (this.readyState === 3) return;
    let frames;
    try { frames = this.parser.push(chunk); } catch (error) { this.fail(error.code || 1002, error.message); return; }
    for (const frame of frames) {
      if (this.readyState === 3) return;
      try { this.handleFrame(frame); } catch (error) { this.fail(error.code || 1002, error.message); return; }
    }
  }

  handleFrame({ fin, opcode, payload }) {
    if (opcode === OPCODES.close) {
      let code = 1005, reason = '';
      if (payload.length === 1) throw new ProtocolError(1002, 'Invalid close payload');
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        if (!validCloseCode(code)) throw new ProtocolError(1002, `Invalid close code ${code}`);
        try { reason = utf8.decode(payload.subarray(2)); } catch { throw new ProtocolError(1007, 'Close reason is not valid UTF-8'); }
      }
      this.closeInfo = { code, reason };
      if (this.readyState === 1) { this.readyState = 2; this.write(OPCODES.close, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0)); }
      this.socket.end();
      clearTimeout(this.closeTimer);
      this.closeTimer = setTimeout(() => this.socket.destroy(), 1000);
      this.closeTimer.unref?.();
      return;
    }
    if (opcode === OPCODES.ping) { if (this.readyState === 1) this.write(OPCODES.pong, payload); this.emit('ping', payload); return; }
    if (opcode === OPCODES.pong) { this.emit('pong', payload); return; }
    if (opcode === OPCODES.continuation) {
      if (!this.fragments) throw new ProtocolError(1002, 'Continuation frame without a started message');
      this.fragments.size += payload.length;
      if (this.fragments.size > this.maxPayload) throw new ProtocolError(1009, 'Message exceeds the size limit');
      this.fragments.chunks.push(payload);
      if (fin) { const { opcode: first, chunks } = this.fragments; this.fragments = null; this.deliver(first, Buffer.concat(chunks)); }
      return;
    }
    if (this.fragments) throw new ProtocolError(1002, 'New data frame inside a fragmented message');
    if (!fin) { this.fragments = { opcode, chunks: [payload], size: payload.length }; return; }
    this.deliver(opcode, payload);
  }

  deliver(opcode, payload) {
    if (this.readyState !== 1) return;
    if (opcode === OPCODES.text) {
      let text;
      try { text = utf8.decode(payload); } catch { throw new ProtocolError(1007, 'Text message is not valid UTF-8'); }
      this.emit('message', text, false);
    } else this.emit('message', payload, true);
  }

  write(opcode, payload, options = {}) {
    if (this.socket.destroyed || !this.socket.writable) return false;
    return this.socket.write(encodeFrame(opcode, payload, { ...options, mask: this.role === 'client' }));
  }

  send(data, { binary = typeof data !== 'string' } = {}) {
    if (this.readyState !== 1) return false;
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    if (payload.length > this.maxPayload) throw new RangeError('Message exceeds the size limit');
    return this.write(binary ? OPCODES.binary : OPCODES.text, payload);
  }

  sendJson(value) { return this.send(JSON.stringify(value)); }

  ping(payload = Buffer.alloc(0)) { return this.readyState === 1 && this.write(OPCODES.ping, payload); }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    const text = Buffer.from(String(reason), 'utf8').subarray(0, 123);
    const payload = Buffer.alloc(2 + text.length);
    payload.writeUInt16BE(code, 0);
    text.copy(payload, 2);
    this.closeInfo = { code, reason: String(reason) };
    this.write(OPCODES.close, payload);
    this.closeTimer = setTimeout(() => this.socket.destroy(), 1000);
    this.closeTimer.unref?.();
  }

  fail(code, reason) {
    if (this.readyState === 3) return;
    this.close(code, reason);
    this.socket.end();
  }

  terminate() { this.socket.destroy(); }

  finish(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    clearTimeout(this.closeTimer);
    if (!this.socket.destroyed) this.socket.destroy();
    this.emit('close', code, reason);
  }
}

function validCloseCode(code) {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

export function rejectUpgrade(socket, status, message) {
  const body = `${message}\n`;
  try {
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  } catch { socket.destroy(); }
}

// Complete the server side of the opening handshake. Returns a WebSocketConnection, or null after rejecting.
export function acceptWebSocket(req, socket, head, { maxPayload = MAX_PAYLOAD } = {}) {
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  const connection = String(req.headers.connection || '').toLowerCase();
  const key = req.headers['sec-websocket-key'];
  if (req.method !== 'GET' || upgrade !== 'websocket' || !connection.split(/\s*,\s*/).includes('upgrade')) { rejectUpgrade(socket, 400, 'Bad Request'); return null; }
  if (req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return null;
  }
  if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) { rejectUpgrade(socket, 400, 'Bad Request'); return null; }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '', '',
  ].join('\r\n'));
  return new WebSocketConnection(socket, { role: 'server', maxPayload, head });
}

// Small client used by tests and tools: connectWebSocket('ws://host:port/path?q', { headers }).
export function connectWebSocket(url, { headers = {}, maxPayload = MAX_PAYLOAD, timeoutMs = 5000 } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'ws:') return Promise.reject(new Error('Only ws:// URLs are supported'));
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: target.hostname, port: Number(target.port) || 80 });
    const key = randomBytes(16).toString('base64');
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('WebSocket handshake timed out')); }, timeoutMs);
    const fail = error => { clearTimeout(timer); socket.destroy(); reject(error); };
    socket.once('error', fail);
    socket.on('connect', () => {
      const lines = [
        `GET ${target.pathname}${target.search} HTTP/1.1`,
        `Host: ${target.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        '', '',
      ];
      socket.write(lines.join('\r\n'));
    });
    const onData = chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      clearTimeout(timer);
      const head = buffered.subarray(0, end).toString('latin1');
      const rest = buffered.subarray(end + 4);
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]);
      if (status !== 101) {
        const error = new Error(`Unexpected server response: ${status}`);
        error.status = status;
        error.body = rest.toString('utf8');
        socket.destroy();
        reject(error);
        return;
      }
      const accept = /\r\nsec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
      if (accept !== acceptKey(key)) { fail(new Error('Invalid Sec-WebSocket-Accept')); return; }
      socket.off('error', fail);
      resolve(new WebSocketConnection(socket, { role: 'client', maxPayload, head: rest }));
    };
    socket.on('data', onData);
  });
}
