import { loadConfig } from '../src/config.mjs';
import { OneBotClient, normalizeEvent } from '../src/onebot.mjs';
import { resolveImages } from '../src/image.mjs';
import { Model } from '../src/model.mjs';

const config = loadConfig();
const client = new OneBotClient(config, () => {});
try {
  client.start();
  await client.waitOpen();
  const result = await client.call('get_friend_msg_history', { user_id: Number(config.ownerQq), count: 30 });
  const candidates = (result?.messages ?? []).map(entry => normalizeEvent({ ...entry,
    post_type: 'message', message_type: 'private', self_id: Number(config.botQq) }, config))
    .filter(entry => entry?.images.length);
  const recent = candidates.at(-1);
  if (!recent) {
    console.log(JSON.stringify({ found: false, note: '最近 30 条私聊中未找到授权用户发送的图片' }));
  } else {
    const images = await resolveImages(recent.images, client);
    const answer = await new Model(config).complete('你是图片通路检测器。根据图片说出可见内容，不要猜测看不见的细节。',
      [{ type: 'text', text: '这张图片里能看到什么？请用一句话回答。' }, ...images]);
    console.log(JSON.stringify({ found: true, images: images.length, modelAccepted: true, answer }));
  }
} finally { client.stop(); }
