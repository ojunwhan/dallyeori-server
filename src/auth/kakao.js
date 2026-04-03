import { Router } from 'express';
import axios from 'axios';
import { signSessionToken } from './session.js';

const router = Router();

function clientOrigin() {
  return process.env.CLIENT_ORIGIN || 'http://localhost:5173';
}

router.get('/kakao', (req, res) => {
  const clientId = process.env.KAKAO_CLIENT_ID;
  const redirectUri = process.env.KAKAO_CALLBACK_URL;
  if (!clientId || !redirectUri) {
    res.status(500).send('Kakao OAuth is not configured');
    return;
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
  });
  res.redirect(`https://kauth.kakao.com/oauth/authorize?${params.toString()}`);
});

router.get('/kakao/callback', async (req, res) => {
  const code = req.query.code;
  if (!code || typeof code !== 'string') {
    res.status(400).send('Missing code');
    return;
  }
  const clientId = process.env.KAKAO_CLIENT_ID;
  const clientSecret = process.env.KAKAO_CLIENT_SECRET;
  const redirectUri = process.env.KAKAO_CALLBACK_URL;
  if (!clientId || !clientSecret || !redirectUri) {
    res.status(500).send('Kakao OAuth is not configured');
    return;
  }
  console.log('[kakao/callback] token POST https://kauth.kakao.com/oauth/token params:', {
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: `${String(clientSecret).slice(0, 8)}...`,
    redirect_uri: redirectUri,
    code: `${code.slice(0, 12)}...`,
  });

  let accessToken;
  try {
    const tokenRes = await axios.post(
      'https://kauth.kakao.com/oauth/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    accessToken = tokenRes.data?.access_token;
    if (!accessToken) {
      console.error('[auth/kakao/callback] TOKEN: success HTTP but no access_token in body:', tokenRes.data);
      res.status(502).send('Token exchange failed');
      return;
    }
    console.log('[auth/kakao/callback] TOKEN: exchange OK (access_token received)');
  } catch (e) {
    const d = e?.response?.data;
    console.error('[auth/kakao/callback] TOKEN: exchange FAILED', {
      httpStatus: e?.response?.status,
      error: d?.error,
      error_description: d?.error_description,
      error_code: d?.error_code,
      raw: typeof d === 'object' ? JSON.stringify(d) : d,
      axiosMessage: e?.message,
    });
    res.status(502).send('Kakao login failed');
    return;
  }

  let k;
  try {
    const userRes = await axios.get('https://kapi.kakao.com/v2/user/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    k = userRes.data;
    console.log('[auth/kakao/callback] USER /me: OK, kakao user id:', k?.id);
  } catch (e) {
    const d = e?.response?.data;
    console.error('[auth/kakao/callback] USER /me: FAILED', {
      httpStatus: e?.response?.status,
      body: typeof d === 'object' ? JSON.stringify(d) : d,
      axiosMessage: e?.message,
    });
    res.status(502).send('Kakao login failed');
    return;
  }

  const id = k?.id;
  if (id == null) {
    console.error('[auth/kakao/callback] USER: missing id in /me payload:', JSON.stringify(k));
    res.status(502).send('Invalid Kakao user');
    return;
  }

  try {
    const acct = k.kakao_account ?? {};
    const prof = acct.profile ?? {};
    const jwtToken = signSessionToken({
      uid: `kakao:${id}`,
      displayName: prof.nickname ?? acct.name ?? '',
      email: acct.email ?? '',
      photoURL: prof.profile_image_url ?? prof.thumbnail_image_url ?? '',
    });
    const frag = `dallyeori_token=${encodeURIComponent(jwtToken)}`;
    res.redirect(`${clientOrigin()}/#${frag}`);
    console.log('[auth/kakao/callback] JWT issued, redirect to client');
  } catch (e) {
    console.error('[auth/kakao/callback] JWT/sign or redirect FAILED:', e?.message, e?.stack);
    res.status(502).send('Kakao login failed');
  }
});

export default router;
