/**
 * 브라우저 기준 공개 오리진 (nginx / Cloudflare 뒤에서는 X-Forwarded-* 사용)
 * @param {import('express').Request} req
 * @returns {string}
 */
export function publicAppOrigin(req) {
  const xfProto = req.get('x-forwarded-proto');
  const proto = (xfProto || req.protocol || 'http').split(',')[0].trim();
  const host = req.get('x-forwarded-host') || req.get('host');
  if (host) {
    return `${proto}://${host}`;
  }
  const raw = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
  return raw.split(',')[0].trim().replace(/\/$/, '');
}
