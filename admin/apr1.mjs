// Apache MD5 加密实现（$apr1$）
import crypto from 'node:crypto';
const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function to64(v, n) { let s=''; while(--n>=0){ s+=ITOA64[v&0x3f]; v>>>=6; } return s; }
export function md5crypt(password, salt) {
  const pw = Buffer.from(password, 'utf8');
  const ctx = crypto.createHash('md5');
  ctx.update(pw); ctx.update('$apr1$'); ctx.update(salt);
  const ctx1 = crypto.createHash('md5');
  ctx1.update(pw); ctx1.update(salt); ctx1.update(pw);
  const final0 = ctx1.digest();
  for (let pl = pw.length; pl > 0; pl -= 16) ctx.update(final0.subarray(0, pl > 16 ? 16 : pl));
  // 二进制长度位
  for (let i = pw.length; i; i >>= 1) {
    if (i & 1) ctx.update(Buffer.from([0])); else ctx.update(pw.subarray(0,1));
  }
  let final = ctx.digest();
  for (let i = 0; i < 1000; i++) {
    const c = crypto.createHash('md5');
    if (i & 1) c.update(pw); else c.update(final);
    if (i % 3) c.update(salt);
    if (i % 7) c.update(pw);
    if (i & 1) c.update(final); else c.update(pw);
    final = c.digest();
  }
  let out = '';
  const f = final;
  const mix = (a,b,c,n) => to64((f[a]<<16)|(f[b]<<8)|f[c], n);
  out += mix(0,6,12,4); out += mix(1,7,13,4); out += mix(2,8,14,4);
  out += mix(3,9,15,4); out += mix(4,10,5,4); out += to64(f[11],2);
  return out;
}
