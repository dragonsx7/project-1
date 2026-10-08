const $ = (id) => document.getElementById(id);
let currentRecord = null;
let passportId = null;
let provider = null;
let walletAddress = '';
let authOrganization = null;

const today = new Date();
$('performedAt').value = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
$('create-button').disabled = true;
$('sign-button').disabled = true;

function setError(message = '') { $('form-error').textContent = message; }
function setAuthError(message = '') { $('auth-message').textContent = message; }
function getProvider() { return window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null); }

function showWallet() {
  if (!walletAddress) {
    $('wallet-button').textContent = getProvider() ? 'Войти через Phantom' : 'Установить Phantom';
    return;
  }
  $('wallet-button').textContent = `${walletAddress.slice(0, 4)}…${walletAddress.slice(-4)}`;
}

function updateOrganizationUI() {
  const ready = Boolean(authOrganization);
  $('org-panel').classList.toggle('hidden', ready);
  $('load-passport-panel').classList.toggle('hidden', !ready || authOrganization.role !== 'seller' || Boolean(passportId));
  $('create-button').disabled = !ready;
  $('create-button').querySelector('span').textContent = passportId
    ? (authOrganization?.role === 'seller' ? 'Добавить осмотр' : 'Добавить запись')
    : (authOrganization?.role === 'seller' ? 'Создать паспорт с осмотром' : 'Сохранить запись');
  $('sign-button').disabled = !ready || !currentRecord;
  $('logout-button').classList.toggle('hidden', !walletAddress);
  showWallet();

  if (!ready) {
    $('chain-caption').textContent = walletAddress
      ? 'Создайте профиль мастерской или продавца, чтобы добавлять записи.'
      : 'Подключите Phantom и создайте профиль организации.';
    return;
  }

  $('shop').value = authOrganization.name;
  $('shop').disabled = true;
  $('recordType').value = authOrganization.role === 'seller' ? 'inspection' : 'repair';
  $('recordType').disabled = true;
  $('recordType').dispatchEvent(new Event('change'));
  $('chain-caption').textContent = `Профиль: ${authOrganization.name}. Подписант — кошелёк организации.`;
}

async function loadAuth() {
  try {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
    const data = await response.json();
    walletAddress = data.authenticated ? data.wallet : '';
    authOrganization = data.authenticated ? data.organization : null;
  } catch {
    walletAddress = '';
    authOrganization = null;
  }
  updateOrganizationUI();
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  let data = {};
  try { data = await response.json(); } catch { /* show a useful generic message below */ }
  if (!response.ok) throw new Error(data.error || `Запрос завершился с кодом ${response.status}.`);
  return data;
}

function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function signIn() {
  provider = getProvider();
  if (!provider) {
    window.open('https://phantom.app/download', '_blank', 'noopener');
    throw new Error('Установите Phantom, затем нажмите «Войти через Phantom».');
  }
  const connection = await provider.connect();
  const address = connection.publicKey.toString();
  const challenge = await requestJson('/api/auth/challenge', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address })
  });
  const signed = await provider.signMessage(new TextEncoder().encode(challenge.message), 'utf8');
  const signature = signed.signature || signed;
  await requestJson('/api/auth/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, signature: toBase64(signature) })
  });
  await loadAuth();
}

loadAuth();

$('wallet-button').addEventListener('click', async () => {
  setAuthError();
  try { await signIn(); }
  catch (error) { setAuthError(error.message || 'Не удалось войти через кошелёк.'); }
});

$('logout-button').addEventListener('click', async () => {
  await requestJson('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  location.reload();
});

$('org-create').addEventListener('click', async () => {
  setAuthError();
  try {
    const result = await requestJson('/api/organizations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('orgName').value, role: $('orgRole').value })
    });
    authOrganization = result.organization;
    updateOrganizationUI();
  } catch (error) { setAuthError(error.message || 'Не удалось создать профиль организации.'); }
});

$('load-passport').addEventListener('click', async () => {
  $('load-message').textContent = '';
  const id = $('existingPassportId').value.trim().toLowerCase();
  if (!/^[a-f0-9]{12}$/.test(id)) { $('load-message').textContent = 'Введите 12 символов ID из QR-паспорта.'; return; }
  try {
    const record = await requestJson(`/api/passports/${id}`);
    passportId = record.id;
    currentRecord = null;
    $('model').value = record.model;
    $('model').disabled = true;
    $('preview-model').textContent = record.model;
    $('preview-repair').textContent = `${record.entries.length} записей в паспорте`;
    $('record-status').innerHTML = '<i></i> ПАСПОРТ ОТКРЫТ';
    $('record-status').classList.add('saved');
    $('create-button').querySelector('span').textContent = 'Добавить осмотр';
    $('sign-button').disabled = true;
    const link = new URL(`/p/${record.id}`, location.origin).href;
    $('passport-link').href = link;
    $('passport-link').textContent = `ID ${record.id} · Открыть паспорт ↗`;
    $('passport-link').classList.remove('hidden');
    renderQr(record.id);
    updateOrganizationUI();
    $('chain-caption').textContent = 'Паспорт загружен. Заполните результат осмотра и добавьте событие.';
  } catch (error) { $('load-message').textContent = error.message || 'Паспорт не найден.'; }
});

$('model').addEventListener('input', () => $('preview-model').textContent = $('model').value.trim() || 'Модель появится здесь');
$('category').addEventListener('change', () => $('preview-repair').textContent = $('category').value || 'Нет записей о ремонте');
$('recordType').addEventListener('change', () => {
  const inspection = $('recordType').value === 'inspection';
  $('shop-label').innerHTML = `${inspection ? 'Продавец / организация' : 'Мастерская'} <span class="required">*</span>`;
  $('summary-label').innerHTML = `${inspection ? 'Результат осмотра' : 'Что было сделано'} <span class="required">*</span>`;
  $('workSummary').placeholder = inspection ? 'Опишите состояние и результат проверки' : 'Кратко опишите выполненную работу';
  $('category').innerHTML = `<option value="">Выберите</option>${(inspection ? ['Внешний осмотр', 'Проверка функций', 'Диагностика', 'Другое'] : ['Замена экрана', 'Замена аккумулятора', 'Ремонт разъёма', 'Диагностика', 'Другое']).map((item) => `<option>${item}</option>`).join('')}`;
});

$('create-button').addEventListener('click', async () => {
  setError();
  if (!authOrganization) return setError('Сначала войдите и создайте профиль организации.');
  const payload = {
    type: authOrganization.role === 'seller' ? 'inspection' : 'repair',
    model: $('model').value,
    performedAt: $('performedAt').value,
    category: $('category').value,
    workSummary: $('workSummary').value,
    parts: $('parts').value
  };
  $('create-button').disabled = true;
  try {
    const url = passportId ? `/api/passports/${passportId}/entries` : '/api/passports';
    const data = await requestJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    passportId = data.id;
    currentRecord = { id: data.id, entryId: data.entryId, hash: data.hash };
    $('record-status').innerHTML = '<i></i> ОЖИДАЕТ ПОДПИСИ';
    $('record-status').classList.remove('verified');
    $('record-status').classList.add('saved');
    $('sign-button').disabled = false;
    $('sign-button').querySelector('span').textContent = '↗';
    const link = new URL(data.url, location.origin).href;
    const publicLink = $('passport-link');
    publicLink.href = link;
    publicLink.textContent = `ID ${data.id} · Открыть паспорт ↗`;
    publicLink.classList.remove('hidden');
    if (window.QRCode) renderQr(data.id);
    else $('qr-frame').innerHTML = '<div class="qr-placeholder"><small>QR-код появится<br>после загрузки библиотеки</small></div>';
    $('create-button').querySelector('span').textContent = authOrganization.role === 'seller' ? 'Добавить осмотр' : 'Добавить запись';
    $('model').disabled = true;
    $('preview-repair').textContent = `${$('category').value} · ${$('performedAt').value}`;
    $('chain-caption').textContent = 'Подпишите последнюю запись кошельком организации в Solana Devnet.';
  } catch (error) {
    setError(error.message || 'Не удалось сохранить запись.');
    if (error.message.includes('Войдите')) await loadAuth();
  } finally {
    $('create-button').disabled = !authOrganization;
  }
});

function renderQr(id) {
  if (!window.QRCode) return;
  const box = $('qr-frame');
  box.replaceChildren();
  new QRCode(box, { text: `${location.origin}/p/${id}`, width: 128, height: 128, colorDark: '#101315', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
}

$('sign-button').addEventListener('click', async () => {
  if (!currentRecord || !authOrganization) return;
  provider = getProvider();
  if (!provider) { $('chain-caption').textContent = 'Установите Phantom, чтобы подписать запись.'; window.open('https://phantom.app/download', '_blank', 'noopener'); return; }
  $('sign-button').disabled = true;
  $('chain-caption').textContent = 'Подготовьте транзакцию и подтвердите её в кошельке…';
  try {
    const connected = await provider.connect();
    if (connected.publicKey.toString() !== walletAddress) throw new Error('Активный кошелёк отличается от вошедшего. Выйдите и войдите нужным кошельком.');
    const { Connection, PublicKey, Transaction, TransactionInstruction } = await import('https://esm.sh/@solana/web3.js@1.98.4');
    const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
    const memo = `FIXPASS1:${currentRecord.id}:${currentRecord.entryId}:${currentRecord.hash}`;
    const transaction = new Transaction().add(new TransactionInstruction({
      keys: [{ pubkey: new PublicKey(walletAddress), isSigner: true, isWritable: false }],
      programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
      data: new TextEncoder().encode(memo)
    }));
    transaction.feePayer = new PublicKey(walletAddress);
    transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    const sent = await provider.signAndSendTransaction(transaction, { preflightCommitment: 'confirmed' });
    const signature = typeof sent === 'string' ? sent : sent.signature;
    if (!signature) throw new Error('Кошелёк не вернул подпись транзакции.');
    await connection.confirmTransaction(signature, 'confirmed');
    const verification = await requestJson(`/api/passports/${currentRecord.id}/entries/${currentRecord.entryId}/attestation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature, authority: walletAddress })
    });
    $('record-status').innerHTML = '<i></i> ПРОВЕРЕНО В DEVNET';
    $('record-status').classList.add('verified');
    $('chain-caption').textContent = verification.alreadyVerified ? 'Подпись уже была проверена в Devnet.' : 'Memo и подпись проверены сервером в Solana Devnet.';
    $('sign-button').querySelector('span').textContent = '✓';
    $('sign-button').disabled = true;
  } catch (error) {
    $('chain-caption').textContent = error?.message?.includes('User rejected') ? 'Подписание отменено в кошельке.' : (error?.message || 'Не удалось подтвердить запись. Проверьте сеть Devnet и баланс SOL.');
    $('sign-button').disabled = false;
  }
});
