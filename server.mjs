import { createServer } from 'node:http';
import { createHash, randomBytes, createPublicKey, verify as verifySignature } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { appendEvent, closeStorage, createOrganization, createPassport, getEvent, getPassport, organizationByWallet, saveAttestation } from './src/storage.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = resolve(root, 'public');
const dataDir = join(root, 'data');
const port = Number(process.env.PORT || 4173);
const DEVNET_RPC = 'https://api.devnet.solana.com';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const challenges = new Map();
const sessions = new Map();
const writeWindows = new Map();
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;

await mkdir(dataDir, { recursive: true });

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 20_000) throw new Error('Слишком большой запрос');
  }
  try { return JSON.parse(body || '{}'); }
  catch { throw new Error('Некорректный JSON в запросе'); }
}

function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[<>]/g, '').trim().slice(0, max);
}

function requestWallet(req) {
  const cookie = req.headers.cookie || '';
  const token = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('fixpass_session='))?.slice('fixpass_session='.length);
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session.wallet;
}

function sameOrigin(req) {
  if (!req.headers.origin) return false;
  try { return new URL(req.headers.origin).host === req.headers.host; }
  catch { return false; }
}

function withinWriteLimit(req) {
  const now = Date.now();
  const ip = req.socket.remoteAddress || 'unknown';
  const window = writeWindows.get(ip);
  if (!window || window.expiresAt <= now) {
    writeWindows.set(ip, { count: 1, expiresAt: now + 60_000 });
    if (writeWindows.size > 500) {
      for (const [key, value] of writeWindows) if (value.expiresAt <= now) writeWindows.delete(key);
    }
    return true;
  }
  window.count += 1;
  return window.count <= 60;
}

function validPublicKey(value) {
  try { return typeof value === 'string' && base58Decode(value).length === 32; }
  catch { return false; }
}

function verifyWalletMessage(address, message, signatureBase64) {
  try {
    const signature = Buffer.from(signatureBase64, 'base64');
    if (signature.length !== 64 || signature.toString('base64') !== signatureBase64) return false;
    const derPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const publicKey = createPublicKey({ key: Buffer.concat([derPrefix, base58Decode(address)]), format: 'der', type: 'spki' });
    return verifySignature(null, Buffer.from(message, 'utf8'), publicKey, signature);
  } catch { return false; }
}

function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function base58Decode(value) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error('Некорректный base58');
    number = number * 58n + BigInt(digit);
  }
  const bytes = [];
  while (number > 0n) { bytes.unshift(Number(number & 255n)); number >>= 8n; }
  for (const character of value) { if (character !== '1') break; bytes.unshift(0); }
  return Buffer.from(bytes);
}

function makeEvent(passportId, deviceModel, body, link, organization) {
  const type = body.type === 'inspection' ? 'inspection' : body.type === 'repair' ? 'repair' : '';
  const performedAt = clean(body.performedAt, 10);
  const category = clean(body.category, 40);
  const workSummary = clean(body.workSummary, 240);
  const parts = clean(body.parts, 180);
  const expectedType = organization.role === 'seller' ? 'inspection' : 'repair';
  const allowedCategories = type === 'inspection'
    ? ['Внешний осмотр', 'Проверка функций', 'Диагностика', 'Другое']
    : ['Замена экрана', 'Замена аккумулятора', 'Ремонт разъёма', 'Диагностика', 'Другое'];
  if (!type || type !== expectedType || !isDate(performedAt) || !category || !workSummary) {
    throw new Error('Тип события не соответствует профилю организации или не заполнены обязательные поля.');
  }
  if (!allowedCategories.includes(category)) throw new Error('Выберите категорию из списка.');
  const entryId = randomBytes(5).toString('hex');
  const salt = randomBytes(32).toString('hex');
  const schemaVersion = 1;
  const sequence = link.sequence;
  const previousHash = link.hash;
  const createdAt = new Date().toISOString();
  const payload = {
    schemaVersion, passportId, deviceModel, entryId, sequence, type,
    organizationId: organization.id,
    shop: organization.name,
    organizationRole: organization.role,
    organizationWallet: organization.wallet,
    performedAt, category, workSummary, parts, previousHash, salt
  };
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return { ...payload, hash, createdAt, attestation: null };
}

async function verifyOnChain(event, signature, authority) {
  try {
    if (base58Decode(signature).length !== 64 || base58Decode(authority).length !== 32) {
      return { ok: false, status: 400, error: 'Формат подписи или адреса кошелька неверен.' };
    }
  } catch {
    return { ok: false, status: 400, error: 'Формат подписи или адреса кошелька неверен.' };
  }

  let response;
  try {
    response = await fetch(DEVNET_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getTransaction',
        params: [signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 0 }]
      })
    });
  } catch {
    return { ok: false, status: 503, error: 'Solana Devnet временно недоступен. Повторите позже.' };
  }
  if (!response.ok) return { ok: false, status: 503, error: 'RPC Devnet отклонил запрос. Повторите позже.' };

  let rpc;
  try { rpc = await response.json(); }
  catch { return { ok: false, status: 503, error: 'RPC Devnet вернул некорректный ответ.' }; }
  if (rpc.error) return { ok: false, status: 503, error: 'RPC Devnet не смог проверить транзакцию.' };
  const result = rpc.result;
  if (!result) return { ok: false, status: 409, error: 'Транзакция пока не найдена в Devnet.' };
  if (result.meta?.err) return { ok: false, status: 422, error: 'Транзакция завершилась ошибкой в Devnet.' };

  const message = result.transaction?.message;
  if (!message || !Array.isArray(message.accountKeys) || !Array.isArray(message.instructions)) {
    return { ok: false, status: 422, error: 'Не удалось разобрать Memo-транзакцию.' };
  }
  const keys = message.accountKeys;
  const authorityIndex = keys.indexOf(authority);
  const signer = authorityIndex >= 0 && authorityIndex < message.header.numRequiredSignatures;
  const memo = `FIXPASS1:${event.passportId}:${event.entryId}:${event.hash}`;
  const memoMatches = message.instructions.some((instruction) => {
    if (keys[instruction.programIdIndex] !== MEMO_PROGRAM || !instruction.accounts.includes(authorityIndex)) return false;
    try { return base58Decode(instruction.data).toString('utf8') === memo; }
    catch { return false; }
  });
  if (!signer || !memoMatches) return { ok: false, status: 422, error: 'Подписант или содержимое Memo не совпадают с записью.' };
  return { ok: true, blockTime: result.blockTime ?? null };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Запрос отклонён: источник не совпадает с адресом приложения.' });
      if (!withinWriteLimit(req)) return json(res, 429, { error: 'Слишком много запросов. Подождите минуту и повторите.' });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/challenge') {
      const body = await readBody(req);
      const address = clean(body.address, 60);
      if (!validPublicKey(address)) return json(res, 400, { error: 'Адрес Solana указан неверно.' });
      const nonce = randomBytes(24).toString('hex');
      const issuedAt = new Date().toISOString();
      const origin = `http://${req.headers.host}`;
      const message = `FixPass wallet login\nOrigin: ${origin}\nWallet: ${address}\nNonce: ${nonce}\nIssued At: ${issuedAt}\nThis signature does not approve a transaction or spend funds.`;
      challenges.set(address, { message, expiresAt: Date.now() + 5 * 60 * 1000 });
      return json(res, 200, { message });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/session') {
      const body = await readBody(req);
      const address = clean(body.address, 60);
      const signature = clean(body.signature, 120);
      const challenge = challenges.get(address);
      challenges.delete(address);
      if (!challenge || challenge.expiresAt <= Date.now() || !verifyWalletMessage(address, challenge.message, signature)) {
        return json(res, 401, { error: 'Подпись не прошла проверку. Подключите кошелёк ещё раз.' });
      }
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, { wallet: address, expiresAt: Date.now() + SESSION_TTL_MS });
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `fixpass_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
      return json(res, 200, { ok: true, wallet: address });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const wallet = requestWallet(req);
      for (const [token, session] of sessions) if (session.wallet === wallet) sessions.delete(token);
      res.setHeader('Set-Cookie', 'fixpass_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      const wallet = requestWallet(req);
      if (!wallet) return json(res, 200, { authenticated: false });
      const organization = organizationByWallet(wallet);
      return json(res, 200, { authenticated: true, wallet, organization });
    }

    if (req.method === 'POST' && url.pathname === '/api/organizations') {
      const wallet = requestWallet(req);
      if (!wallet) return json(res, 401, { error: 'Сначала войдите через Solana-кошелёк.' });
      if (organizationByWallet(wallet)) return json(res, 409, { error: 'Для этого кошелька уже создан профиль организации.' });
      const body = await readBody(req);
      const name = clean(body.name, 70);
      const role = body.role === 'seller' ? 'seller' : body.role === 'shop' ? 'shop' : '';
      if (!name || !role) return json(res, 400, { error: 'Укажите название организации и её роль.' });
      const organization = { id: randomBytes(6).toString('hex'), name, role, wallet, createdAt: new Date().toISOString() };
      try { createOrganization(organization); }
      catch { return json(res, 409, { error: 'Не удалось создать профиль организации для этого кошелька.' }); }
      return json(res, 201, { organization });
    }

    if (req.method === 'POST' && url.pathname === '/api/passports') {
      const wallet = requestWallet(req);
      const organization = wallet ? organizationByWallet(wallet) : null;
      if (!organization) return json(res, 401, { error: 'Войдите и создайте профиль мастерской или продавца.' });
      const body = await readBody(req);
      const model = clean(body.model, 70);
      if (!model) return json(res, 400, { error: 'Укажите модель устройства.' });
      const id = randomBytes(6).toString('hex');
      const passport = { id, model, createdAt: new Date().toISOString() };
      const event = makeEvent(id, model, body, { sequence: 1, hash: null }, organization);
      createPassport(passport, event);
      return json(res, 201, { id, entryId: event.entryId, hash: event.hash, url: `/p/${id}` });
    }

    const appendMatch = url.pathname.match(/^\/api\/passports\/([a-f0-9]{12})\/entries$/);
    if (req.method === 'POST' && appendMatch) {
      const wallet = requestWallet(req);
      const organization = wallet ? organizationByWallet(wallet) : null;
      if (!organization) return json(res, 401, { error: 'Войдите и создайте профиль мастерской или продавца.' });
      const id = appendMatch[1];
      const body = await readBody(req);
      const event = appendEvent(id, (link, model) => makeEvent(id, model, body, link, organization));
      if (!event) return json(res, 404, { error: 'Паспорт не найден.' });
      return json(res, 201, { id, entryId: event.entryId, hash: event.hash, url: `/p/${id}` });
    }

    const attestationMatch = url.pathname.match(/^\/api\/passports\/([a-f0-9]{12})\/entries\/([a-f0-9]{10})\/attestation$/);
    if (req.method === 'POST' && attestationMatch) {
      const [, passportId, entryId] = attestationMatch;
      const sessionWallet = requestWallet(req);
      if (!sessionWallet) return json(res, 401, { error: 'Войдите через кошелёк организации.' });
      const record = getPassport(passportId);
      const event = getEvent(entryId);
      if (!record || !event || event.passportId !== passportId) return json(res, 404, { error: 'Паспорт или запись не найдены.' });
      const body = await readBody(req);
      const signature = clean(body.signature, 100);
      const authority = clean(body.authority, 60);
      if (event.organizationWallet !== sessionWallet) return json(res, 403, { error: 'Подписать событие может только кошелёк организации, добавившей запись.' });
      if (authority !== sessionWallet) return json(res, 403, { error: 'Подписант транзакции должен совпадать с вошедшим кошельком.' });
      if (event.attestation) {
        if (event.attestation.signature === signature && event.attestation.authority === authority) return json(res, 200, { ok: true, alreadyVerified: true });
        return json(res, 409, { error: 'Для записи уже сохранена другая подтверждённая транзакция.' });
      }
      const verification = await verifyOnChain(event, signature, authority);
      if (!verification.ok) return json(res, verification.status, { error: verification.error });
      try {
        saveAttestation({ eventId, signature, authority, verifiedAt: new Date().toISOString(), blockTime: verification.blockTime });
      } catch {
        return json(res, 409, { error: 'Транзакция уже связана с другой записью.' });
      }
      return json(res, 201, { ok: true, blockTime: verification.blockTime });
    }

    const publicMatch = url.pathname.match(/^\/api\/passports\/([a-f0-9]{12})$/);
    if (req.method === 'GET' && publicMatch) {
      const record = getPassport(publicMatch[1]);
      if (!record) return json(res, 404, { error: 'Паспорт не найден.' });
      return json(res, 200, record);
    }

    let file = url.pathname === '/' ? 'index.html' : url.pathname.startsWith('/p/') ? 'passport.html' : url.pathname.slice(1);
    file = normalize(file).replace(/^([.][.][/\\])+/, '');
    const path = resolve(publicDir, file);
    const escaped = relative(publicDir, path);
    if (escaped.startsWith(`..${sep}`) || escaped === '..' || !existsSync(path)) return json(res, 404, { error: 'Страница не найдена.' });
    const contentType = types[extname(path)];
    if (!contentType) return json(res, 404, { error: 'Страница не найдена.' });
    res.writeHead(200, {
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com https://esm.sh; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://api.devnet.solana.com https://esm.sh; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    });
    res.end(await readFile(path));
  } catch (error) {
    const status = error.message?.includes('append-only') || error.message?.includes('immutable') ? 409 : 400;
    json(res, status, { error: error?.message || 'Не удалось обработать запрос.' });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`FixPass открыт: http://127.0.0.1:${port}`);
  const addresses = Object.values(networkInterfaces()).flat().filter((item) => item && item.family === 'IPv4' && !item.internal).map((item) => item.address);
  if (addresses.length) console.log(`Для QR на телефоне в той же сети откройте: http://${addresses[0]}:${port}`);
});

function shutdown() {
  server.close(() => { closeStorage(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
