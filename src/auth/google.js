import { Router } from 'express';
import axios from 'axios';
import { signSessionToken } from './session.js';

const router = Router();

function clientOrigin() {
  return process.env.CLIENT_ORIGIN || 'http://localhost:5173';
}

router.get('/google', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_CALLBACK_URL;
  if (!clientId || !redirectUri) {
    res.status(500).send('Google OAuth is not configured');
    return;
  }
  console.log('[google auth] client_id:', clientId);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'consent',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

router.get('/google/callback', async (req, res) => {
  const code = req.query.code;
  if (!code || typeof code !== 'string') {
    res.status(400).send('Missing code');
    return;
  }
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_CALLBACK_URL;
  if (!clientId || !clientSecret || !redirectUri) {
    res.status(500).send('Google OAuth is not configured');
    return;
  }
  try {
    const tokenRes = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    const accessToken = tokenRes.data?.access_token;
    if (!accessToken) {
      res.status(502).send('Token exchange failed');
      return;
    }
    const userRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const u = userRes.data;
    const uid = String(u.id ?? u.sub ?? '');
    if (!uid) {
      res.status(502).send('Invalid userinfo');
      return;
    }
    const jwtToken = signSessionToken({
      uid: `google:${uid}`,
      displayName: u.name ?? u.given_name ?? '',
      email: u.email ?? '',
      photoURL: u.picture ?? '',
    });
    const frag = `dallyeori_token=${encodeURIComponent(jwtToken)}`;
    res.redirect(`${clientOrigin()}/#${frag}`);
  } catch (e) {
    console.error('[auth/google/callback]', e?.response?.data ?? e);
    res.status(502).send('Google login failed');
  }
});

export default router;
