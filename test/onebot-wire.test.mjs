import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { OneBotClient } from '../src/onebot.mjs';

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  const head = Buffer.alloc(4);
  head[0] = 0x81; head[1] = 126; head.writeUInt16BE(body.length, 2);
  return Buffer.concat([head, body]);
}

function decodeClientFrame(buffer) {
  const n = buffer[1] & 0x7f;
  const length = n === 126 ? buffer.readUInt16BE(2) : n;
  const offset = n === 126 ? 4 : 2;
  const mask = buffer.subarray(offset, offset + 4);
  const body = buffer.subarray(offset + 4, offset + 4 + length);
  if (body.length !== length) return null;
  return JSON.parse(Buffer.from(body.map((byte, i) => byte ^ mask[i % 4])).toString());
}

test('OneBot 正向 WS 发送鉴权头、接收事件并对应 echo 回执', async t => {
  let socket;
  let auth;
  let action;
  const server = createServer();
  server.on('upgrade', (request, connection) => {
    socket = connection;
    auth = request.headers.authorization;
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    connection.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    connection.write(frame({ post_type: 'message', message_type: 'private', self_id: 987654321,
      user_id: 123456789, sender: { user_id: 123456789 }, message_id: 2, message: [{ type: 'text', data: { text: '测试' } }] }));
    connection.on('data', data => {
      const parsed = decodeClientFrame(data);
      if (!parsed?.action) return;
      action = parsed;
      const payload = parsed.action === 'get_login_info' ? { user_id: 987654321, nickname: 'test-bot' } : { message_id: 42 };
      connection.write(frame({ status: 'ok', retcode: 0, data: payload, echo: parsed.echo }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let received;
  const eventPromise = new Promise(resolve => { received = resolve; });
  const client = new OneBotClient({ onebotUrl: `ws://127.0.0.1:${server.address().port}/`, onebotToken: 'secret' }, received);
  t.after(async () => { client.stop(); socket?.destroy(); await new Promise(resolve => server.close(resolve)); });
  client.start();
  await client.waitOpen();
  const event = await eventPromise;
  const login = await client.call('get_login_info', {});
  assert.equal(login.user_id, 987654321);
  const receipt = await client.send({ sender: '123456789', isGroup: false }, '收到');
  assert.equal(auth, 'Bearer secret');
  assert.equal(event.message_id, 2);
  assert.equal(action.action, 'send_private_msg');
  assert.equal(action.params.user_id, 123456789);
  assert.equal(receipt.message_id, 42);
});
