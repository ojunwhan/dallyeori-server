import jwt from 'jsonwebtoken';
import { randomInt, randomUUID } from 'crypto';

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return s;
}

/**
 * @param {{ uid: string, displayName: string, email: string, photoURL?: string, isNewUser?: boolean }} payload
 * isNewUser: true → 클라이언트에서 프로필 설정 필요, false → 기가입(로비로)
 */
export function signSessionToken(payload) {
  return jwt.sign(
    {
      uid: payload.uid,
      displayName: payload.displayName ?? '',
      email: payload.email ?? '',
      photoURL: payload.photoURL ?? '',
      ...(typeof payload.isNewUser === 'boolean' ? { isNewUser: payload.isNewUser } : {}),
    },
    secret(),
    { expiresIn: '7d' },
  );
}

/**
 * @param {string} token
 */
export function verifySessionToken(token) {
  return /** @type {jwt.JwtPayload & { uid: string, displayName?: string, email?: string, photoURL?: string, qrGuest?: boolean, qrMatchCode?: string, isNewUser?: boolean }} */ (
    jwt.verify(token, secret())
  );
}

/**
 * QR 스캔 게스트용 짧은 수명 JWT (같은 secret으로 검증)
 * @param {string} matchCode
 */
export function signQrGuestToken(matchCode) {
  const uid = `guest:${randomUUID()}`;
  const displayName = `게스트_${randomInt(100, 999)}`;
  return jwt.sign(
    {
      uid,
      displayName,
      email: '',
      photoURL: '',
      qrGuest: true,
      qrMatchCode: matchCode,
    },
    secret(),
    { expiresIn: '1h' },
  );
}
