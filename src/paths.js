import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** dallyeori-server/uploads — package 루트 기준 (process.cwd()와 무관) */
export const UPLOADS_ROOT = join(__dirname, '..', 'uploads');

export const UPLOADS_AVATARS_DIR = join(UPLOADS_ROOT, 'avatars');
