export function parseWav(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('请提供 WAV 音频。');
  let format, pcm;
  for (let p = 12; p + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', p, p + 4);
    const n = bytes.readUInt32LE(p + 4), start = p + 8;
    if (start + n > bytes.length) throw new Error('WAV 文件不完整。');
    if (name === 'fmt ') {
      if (n < 16) throw new Error('WAV 格式信息不完整。');
      format = [bytes.readUInt16LE(start), bytes.readUInt16LE(start + 2), bytes.readUInt32LE(start + 4), bytes.readUInt16LE(start + 14)];
    }
    if (name === 'data') pcm = bytes.subarray(start, start + n);
    p = start + n + (n % 2);
  }
  if (!format || format.join(',') !== '1,1,16000,16' || !pcm?.length || pcm.length % 2) throw new Error('音频须为 16kHz、单声道、PCM16 WAV。');
  const duration = pcm.length / 32000;
  if (duration > 60 || duration < 0.1) throw new Error('单个音频片段须为 0.1–60 秒。');
  return { wav: bytes, pcm, duration };
}

function words(text) {
  return String(text).normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) || [];
}

export function wordErrorRate(reference, hypothesis) {
  const a = words(reference), b = words(hypothesis);
  if (!a.length) return null;
  if (a.length > 2000 || b.length > 4000) throw new Error('参考文本或识别文本过长。');
  const cols = b.length + 1;
  const directions = new Uint8Array((a.length + 1) * cols);
  let prev = Uint16Array.from({ length: cols }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) directions[j] = 3;
  for (let i = 1; i <= a.length; i++) {
    const row = new Uint16Array(cols);
    row[0] = i; directions[i * cols] = 2;
    for (let j = 1; j <= b.length; j++) {
      const sub = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      const del = prev[j] + 1, ins = row[j - 1] + 1;
      row[j] = Math.min(sub, del, ins);
      directions[i * cols + j] = row[j] === sub ? 1 : row[j] === del ? 2 : 3;
    }
    prev = row;
  }
  let i = a.length, j = b.length, substitutions = 0, deletions = 0, insertions = 0;
  while (i || j) {
    const d = directions[i * cols + j];
    if (d === 1) { if (a[i - 1] !== b[j - 1]) substitutions++; i--; j--; }
    else if (d === 2) { deletions++; i--; }
    else { insertions++; j--; }
  }
  return { rate: (substitutions + deletions + insertions) / a.length, substitutions, deletions, insertions, referenceWords: a.length };
}
