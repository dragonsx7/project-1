const content = document.getElementById('passport-content');
const id = location.pathname.split('/').filter(Boolean).at(-1);
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function decodeBase58(value) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number = 0n;
  for (const char of value) { const digit = alphabet.indexOf(char); if (digit < 0) throw new Error('Некорректные данные транзакции'); number = number * 58n + BigInt(digit); }
  const bytes = [];
  while (number > 0n) { bytes.unshift(Number(number & 255n)); number >>= 8n; }
  for (const char of value) { if (char !== '1') break; bytes.unshift(0); }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

async function calculateHash(passportId, entry) {
  const canonical = JSON.stringify({ schemaVersion: entry.schemaVersion, passportId, deviceModel: entry.deviceModel, entryId: entry.entryId, sequence: entry.sequence, type: entry.type, organizationId: entry.organizationId, shop: entry.shop, organizationRole: entry.organizationRole, organizationWallet: entry.organizationWallet, performedAt: entry.performedAt, category: entry.category, workSummary: entry.workSummary, parts: entry.parts, previousHash: entry.previousHash, salt: entry.salt });
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function checkOnChain(passportId, entry) {
  if (!entry.attestation) return { ok: false, reason: 'Нет транзакции в Devnet' };
  try {
    const response = await fetch('https://api.devnet.solana.com', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [entry.attestation.signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 0 }] }) });
    const { result } = await response.json();
    if (!result || result.meta?.err) return { ok: false, reason: 'Транзакция не найдена или завершилась ошибкой' };
    const keys = result.transaction.message.accountKeys;
    const required = result.transaction.message.header.numRequiredSignatures;
    const authorityIndex = keys.indexOf(entry.attestation.authority);
    const signer = authorityIndex >= 0 && authorityIndex < required && entry.attestation.authority === entry.organizationWallet;
    const expected = `FIXPASS1:${passportId}:${entry.entryId}:${entry.hash}`;
    const memoExists = result.transaction.message.instructions.some((ix) => keys[ix.programIdIndex] === MEMO_PROGRAM && decodeBase58(ix.data) === expected && ix.accounts.includes(authorityIndex));
    if (!signer || !memoExists) return { ok: false, reason: 'Подпись или хеш не совпадают с паспортом' };
    return { ok: true, reason: 'Хеш и подпись кошелька найдены в Solana Devnet' };
  } catch { return { ok: false, reason: 'Не удалось связаться с Solana Devnet. Повторите проверку позже.' }; }
}

async function render() {
  if (!/^[a-f0-9]{12}$/.test(id || '')) throw new Error('Некорректная ссылка на паспорт.');
  const response = await fetch(`/api/passports/${id}`);
  const record = await response.json();
  if (!response.ok) throw new Error(record.error || 'Паспорт не найден.');
  const checkedEntries = await Promise.all(record.entries.map(async (entry, index) => {
    const expectedPreviousHash = index === 0 ? null : record.entries[index - 1].hash;
    const sequenceMatches = entry.deviceModel === record.model && entry.sequence === index + 1 && entry.previousHash === expectedPreviousHash;
    const hashMatches = sequenceMatches && await calculateHash(record.id, entry) === entry.hash;
    const onChain = hashMatches ? await checkOnChain(record.id, entry) : { ok: false, reason: 'Хеш или последовательность записи не совпадает' };
    return { entry, hashMatches, onChain };
  }));
  const verifiedCount = checkedEntries.filter((item) => item.hashMatches && item.onChain.ok).length;
  const allVerified = verifiedCount === checkedEntries.length;
  const reason = allVerified ? 'Хеши и подписи всех записей найдены в Solana Devnet' : `${verifiedCount} из ${checkedEntries.length} записей проверены в Solana Devnet`;
  const entryMarkup = checkedEntries.slice().reverse().map(({ entry, hashMatches, onChain }) => {
    const stamp = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${entry.performedAt}T12:00:00`));
    const verified = hashMatches && onChain.ok;
    const signer = entry.attestation?.authority || '';
    return `<article class="history-entry"><div class="timeline"><span class="timeline-dot ${verified ? 'checked' : ''}"></span><span class="timeline-line"></span></div><div class="entry-content"><div class="entry-topline"><span class="entry-date">${escapeHtml(stamp)} · №${String(entry.sequence).padStart(2, '0')}</span><span class="entry-badge ${verified ? 'signed' : 'unsigned'}">${verified ? '✓ ПОДПИСАНО' : 'ОЖИДАЕТ ПРОВЕРКИ'}</span></div><h3>${escapeHtml(entry.category)}</h3><p>${escapeHtml(entry.workSummary)}</p>${entry.parts ? `<div class="parts-line"><span>Детали</span><b>${escapeHtml(entry.parts)}</b></div>` : ''}<div class="issuer-line"><span class="issuer-avatar">${escapeHtml(entry.shop.slice(0, 1).toUpperCase())}</span><div><span>${entry.type === 'inspection' ? 'Осмотр добавил продавец' : 'Запись добавила мастерская'}</span><b>${escapeHtml(entry.shop)}</b></div></div>${signer ? `<div class="signer-line" title="${escapeHtml(signer)}">Кошелёк подписанта: ${escapeHtml(`${signer.slice(0, 5)}…${signer.slice(-5)}`)}</div>` : ''}${entry.attestation ? `<a class="entry-tx" href="https://explorer.solana.com/tx/${encodeURIComponent(entry.attestation.signature)}?cluster=devnet" target="_blank" rel="noreferrer">Открыть транзакцию ↗</a>` : ''}</div></article>`;
  }).join('');
  content.innerHTML = `
    <div class="passport-hero"><div class="hero-icon">F</div><div><div class="eyebrow">ПАСПОРТ УСТРОЙСТВА <span>•</span> #${escapeHtml(record.id.slice(0, 6).toUpperCase())}</div><h1>${escapeHtml(record.model)}</h1><p>Сервисная история · ID <code class="passport-id">${escapeHtml(record.id)}</code></p></div></div>
    <section class="verification-banner ${allVerified ? 'is-verified' : 'is-unverified'}"><span class="verification-symbol">${allVerified ? '✓' : '!'}</span><div><strong>${allVerified ? 'Подписи проверены в Solana Devnet' : 'Есть записи без подтверждения'}</strong><p>${escapeHtml(reason)}</p></div><span class="verification-network">DEVNET</span></section>
    <section class="history-card"><div class="history-header"><div><div class="eyebrow">ХРОНОЛОГИЯ ОБСЛУЖИВАНИЯ</div><h2>${allVerified ? 'История подтверждена' : 'История устройства'}</h2></div><span class="record-count">${String(record.entries.length).padStart(2, '0')} ЗАПИСЕЙ</span></div>
      ${entryMarkup}
    </section>
    <section class="integrity-card"><div><span class="integrity-icon">⌑</span><div><strong>Контроль целостности</strong><p>Описание хранится вне блокчейна. В Solana записаны случайные ID, хеши и подписи кошельков. Это подтверждает автора кошелька и целостность записи, но не её правдивость и не полноту истории.</p></div></div><button id="verify-again" class="verify-button">Проверить снова ↻</button></section>
    <p class="disclaimer">Организация указана автором записи. FixPass пока не проводит независимую проверку мастерских и продавцов.</p>`;
  document.getElementById('verify-again').addEventListener('click', () => location.reload());
}

render().catch((error) => { content.innerHTML = `<div class="error-state"><span>404</span><h1>Паспорт недоступен</h1><p>${escapeHtml(error.message)}</p><a href="/">Вернуться в FixPass</a></div>`; });
