import { readFile, stat } from 'node:fs/promises';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 4;

function imageMime(bytes) {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.subarray(0, 6).toString() === 'GIF87a' || bytes.subarray(0, 6).toString() === 'GIF89a') return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new Error('图片格式不受支持（仅 JPEG、PNG、GIF、WebP）');
}

export async function resolveImages(images, transport) {
  if (images.length > MAX_IMAGES) throw new Error(`一次最多处理 ${MAX_IMAGES} 张图片`);
  const result = [];
  for (const image of images) {
    if (typeof image.file !== 'string' || !image.file || image.file.length > 512) throw new Error('图片缺少有效文件标识');
    if (image.fileSize && Number(image.fileSize) > MAX_IMAGE_BYTES) throw new Error('图片超过 8 MiB 限制');
    const data = await transport.call('get_image', { file: image.file });
    let bytes;
    if (typeof data?.base64 === 'string' && data.base64.length <= MAX_IMAGE_BYTES * 4 / 3 + 16) {
      bytes = Buffer.from(data.base64, 'base64');
    } else if (typeof data?.file === 'string' && data.file) {
      const info = await stat(data.file);
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error('图片超过 8 MiB 限制');
      bytes = await readFile(data.file);
    } else throw new Error('OneBot 未返回可读取的图片文件');
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error('图片为空或超过 8 MiB 限制');
    const mime = imageMime(bytes);
    result.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } });
  }
  return result;
}
