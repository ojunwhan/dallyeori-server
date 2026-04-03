/**
 * 브라우저 기준 공개 오리진 (nginx / Cloudflare 뒤에서는 X-Forwarded-* 사용)
 * @param {import('express').Request} req
 * @returns {string}
 */
export function publicAppOrigin(req) {
  // Cloudflare CF-Visitor 헤더 우선 확인 (가장 정확)
  const cfVisitor = req.get('cf-visitor');
  let proto;
  if (cfVisitor) {
    try {
      const parsed = JSON.parse(cfVisitor);
      proto = parsed.scheme || 'https';
    } catch {
      proto = 'https';
    }
  } else {
    const xfProto = req.get('x-forwarded-proto');
    proto = (xfProto || req.protocol || 'http').split(',')[0].trim();
  }
  // localhost가 아니면 https 강제 (Cloudflare 뒤에서는 항상 https)
  const host = req.get('x-forwarded-host') || req.get('host') || '';
  if (host && !host.startsWith('localhost') && !host.startsWith('127.0.0.1')) {
    proto = 'https';
  }
  if (host) {
    return `${proto}://${host}`;
  }
  const raw = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
  return raw.split(',')[0].trim().replace(/\/$/, '');
}
