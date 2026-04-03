import jwt from 'jsonwebtoken';

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return s;
}

/**
 * @param {{ uid: string, displayName: string, email: string, photoURL?: string }} payload
 */
export function signSessionToken(payload) {
  return jwt.sign(
    {
      uid: payload.uid,
      displayName: payload.displayName ?? '',
      email: payload.email ?? '',
      photoURL: payload.photoURL ?? '',
    },
    secret(),
    { expiresIn: '7d' },
  );
}

/**
 * @param {string} token
 */
export function verifySessionToken(token) {
  return /** @type {jwt.JwtPayload & { uid: string, displayName?: string, email?: string, photoURL?: string }} */ (
    jwt.verify(token, secret())
  );
}
