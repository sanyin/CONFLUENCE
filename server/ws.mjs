/**
 * 一个刚好够用的 WebSocket 服务端实现（RFC 6455 子集）。
 * 只支持文本帧、ping/pong、分片与关闭，足以支撑实时世界状态推送。
 * 这样整个项目可以做到「零 npm 依赖」。
 */
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 4 * 1024 * 1024;

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, data]);
}

function parseFrames(onFrame) {
  let buf = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = 0;

  return function push(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) {
          throw new Error('ws: frame too large');
        }
        len = Number(big);
        offset = 10;
      }

      if (len > MAX_PAYLOAD) throw new Error('ws: frame too large');

      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + len) return;

      let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = buf.subarray(offset, offset + 4);
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i += 1) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      } else {
        payload = Buffer.from(payload);
      }
      buf = buf.subarray(offset + maskLen + len);

      if (opcode === 0x8) {
        onFrame({ type: 'close' });
        return;
      }
      if (opcode === 0x9) {
        onFrame({ type: 'ping', payload });
        continue;
      }
      if (opcode === 0xa) {
        onFrame({ type: 'pong' });
        continue;
      }
      if (opcode === 0x2) {
        continue; // 忽略二进制帧
      }
      if (opcode === 0x0) {
        fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(fragments);
          fragments = [];
          onFrame({ type: 'text', text: full.toString('utf8'), opcode: fragmentOpcode });
        }
        continue;
      }
      // 0x1 text（可能被分片）
      if (!fin) {
        fragmentOpcode = opcode;
        fragments = [payload];
        continue;
      }
      onFrame({ type: 'text', text: payload.toString('utf8'), opcode });
    }
  };
}

export function createHub() {
  const clients = new Set();

  function attach(server, onClient) {
    server.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
        socket.destroy();
        return;
      }
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.setNoDelay(true);

      const client = {
        id: crypto.randomUUID(),
        alive: true,
        send(obj) {
          if (!client.alive || socket.destroyed) return false;
          try {
            socket.write(encodeFrame(JSON.stringify(obj)));
            return true;
          } catch {
            client.alive = false;
            return false;
          }
        },
        close() {
          if (!client.alive) return;
          client.alive = false;
          try {
            socket.write(encodeFrame(Buffer.alloc(0), 0x8));
          } catch {
            /* noop */
          }
          socket.end();
        },
      };

      const push = parseFrames((frame) => {
        if (frame.type === 'close') {
          client.alive = false;
          clients.delete(client);
          socket.end();
          return;
        }
        if (frame.type === 'ping') {
          try {
            socket.write(encodeFrame(frame.payload, 0xa));
          } catch {
            /* noop */
          }
          return;
        }
        if (frame.type === 'text') {
          let data;
          try {
            data = JSON.parse(frame.text);
          } catch {
            return;
          }
          onClient?.(client, data);
        }
      });

      socket.on('data', (chunk) => {
        try {
          push(chunk);
        } catch {
          client.alive = false;
          clients.delete(client);
          socket.destroy();
        }
      });
      socket.on('error', () => {
        client.alive = false;
        clients.delete(client);
      });
      socket.on('close', () => {
        client.alive = false;
        clients.delete(client);
      });

      clients.add(client);
      onClient?.(client, { type: 'hello' });
    });

    const heartbeat = setInterval(() => {
      for (const client of [...clients]) {
        // 只有真正写失败时才剔除，避免把健康连接误删
        if (!client.send({ type: 'ping', t: Date.now() })) clients.delete(client);
      }
    }, 25000);
    if (heartbeat.unref) heartbeat.unref();
  }

  function broadcast(obj) {
    for (const client of clients) client.send(obj);
  }

  return { attach, broadcast, get size() { return clients.size; } };
}
