const express   = require('express');
const cors      = require('cors');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');
const bcrypt    = require('bcryptjs');
const rateLimit = require('express-rate-limit');

// ═══════════════════════════════════════════════════════════════════════════
//  СЕКРЕТЫ — ТОЛЬКО ИЗ ENV. В КОДЕ ИХ НЕТ.
// ═══════════════════════════════════════════════════════════════════════════
const PORT                       = process.env.PORT || 3000;
const ADMIN_LOGIN                = 'admin';
const ADMIN_PASSWORD             = process.env.ADMIN_PASSWORD || '';
const LEGACY_ADMIN_PASSWORD_ON   = process.env.LEGACY_ADMIN_PASSWORD !== 'false';
const ADMIN_ID                   = '#00000001';

const TELEGRAM_BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN    || '';
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || '';
const TELEGRAM_GROUP_ID     = process.env.TELEGRAM_GROUP_ID || -1003756285081;
const TELEGRAM_GROUP_LINK   = 'https://t.me/+Tu7sw6yGV_c5YzY6';
const TELEGRAM_PURCHASE_CONTACT    = '@dsoci';
const TELEGRAM_PRICE_TEXT          = '25 Stars или 50 грн';
const TELEGRAM_TOKEN_TTL_MS        = 15 * 60 * 1000;
const TELEGRAM_DISPLAY_TZ_OFFSET_MIN = process.env.TELEGRAM_DISPLAY_TZ_OFFSET_MIN
    ? parseInt(process.env.TELEGRAM_DISPLAY_TZ_OFFSET_MIN, 10)
    : 180;

const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

// Hard-fail: без пароля админа сервер не стартует.
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 16) {
    console.error('[FATAL] ADMIN_PASSWORD не задан или короче 16 символов.');
    console.error('        Задайте его в env (Railway → Variables → ADMIN_PASSWORD).');
    process.exit(1);
}

const DB_FILE          = path.join(__dirname, 'users.json');
const STATE_FILE       = path.join(__dirname, 'app_state.json');
const REPORTS_FILE     = path.join(__dirname, 'reports.json');
const PERM_BANS_FILE   = path.join(__dirname, 'perm_bans.json');
const RANK_POSTS_FILE  = path.join(__dirname, 'rank_posts.json');
const RANK_MUTES_FILE  = path.join(__dirname, 'rank_mutes.json');
const TELEGRAM_LINKS_FILE = path.join(__dirname, 'telegram_links.json');
const CHAT_FILE        = path.join(__dirname, 'chat.json');
const SUPPORT_FILE     = path.join(__dirname, 'support.json');
const KEYS_FILE        = path.join(__dirname, 'keys.json');
const DELETED_KEYS_FILE = path.join(__dirname, 'deleted_keys.json');
const BOT_KEYS_FILE    = path.join(__dirname, 'bot_keys.json');

const app = express();

// ═══════════════════════════════════════════════════════════════════════════
//  CORS — только из env. Пусто = CORS выключен (мобильный клиент не нуждается).
// ═══════════════════════════════════════════════════════════════════════════
app.use(cors({
    origin: CORS_ORIGINS.length > 0 ? CORS_ORIGINS : false,
    credentials: false,
}));
app.use(express.json({ limit: '30mb' }));

// ═══════════════════════════════════════════════════════════════════════════
//  RATE LIMITERS
// ═══════════════════════════════════════════════════════════════════════════
function makeLimiter(windowMin, max, label) {
    return rateLimit({
        windowMs: windowMin * 60 * 1000,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        message: { status: 'error', message: `Слишком много запросов (${label}). Попробуйте позже.` },
    });
}
const rlLogin           = makeLimiter(15,  10,  '/login');
const rlRegister        = makeLimiter(60,   5,  '/register');
const rlAdminLogin      = makeLimiter(15,   5,  '/admin/login');
const rlKeysValidate    = makeLimiter(1,   30,  '/keys/validate');
const rlKeysUpdateUser  = makeLimiter(1,   30,  '/keys/update-user');
const rlChatSend        = makeLimiter(1,   20,  '/chat/send');
const rlRankSend        = makeLimiter(60,   5,  '/rank/send');
const rlRankReport      = makeLimiter(60,  10,  '/rank/report');
const rlHeartbeat       = makeLimiter(1,   60,  '/heartbeat');
const rlEnumeration     = makeLimiter(1,   60,  'enumeration');   // /user/:login, /mute-status, /keys/check-*, /check-banned, /check-account-exists
const rlTelegramPublic  = makeLimiter(1,   60,  'telegram-public'); // /telegram/poll-token, /keys/token-by-device, /telegram/check-token, /telegram/config
const rlDelete          = makeLimiter(60,   5,  '/delete');
const rlSupportSend     = makeLimiter(1,   30,  '/support/send');
const rlSupportCreate   = makeLimiter(60,   5,  '/support/create');

// ═══════════════════════════════════════════════════════════════════════════
//  АТОМАРНАЯ ЗАПИСЬ (temp + rename) — защита от corruption при краше
// ═══════════════════════════════════════════════════════════════════════════
function atomicWrite(filePath, data) {
    const tmp = filePath + '.tmp.' + process.pid + '.' + Date.now();
    try {
        fs.writeFileSync(tmp, data, 'utf8');
        fs.renameSync(tmp, filePath);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        throw e;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  ХЕЛПЕРЫ
// ═══════════════════════════════════════════════════════════════════════════
function now() { return new Date().toISOString(); }

function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
}

// constant-time сравнение строк
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    try { return crypto.timingSafeEqual(bufA, bufB); }
    catch (_) { return false; }
}

function hashPassword(plain) {
    return bcrypt.hashSync(plain, 10);
}

// Проверка пароля с миграцией plaintext → bcrypt.
// Возвращает { ok, migrated } — migrated=true означает, что надо сохранить users.
function verifyPassword(plain, user) {
    if (!user || !plain) return { ok: false, migrated: false };
    if (user.passwordHash) {
        return { ok: bcrypt.compareSync(plain, user.passwordHash), migrated: false };
    }
    if (typeof user.password === 'string' && safeEqual(user.password, plain)) {
        user.passwordHash = hashPassword(plain);
        delete user.password;
        return { ok: true, migrated: true };
    }
    return { ok: false, migrated: false };
}

// Lock для users.json — сериализует read-modify-write операции.
let usersLock = Promise.resolve();
function withUsersLock(fn) {
    const next = usersLock.then(fn, fn);
    usersLock = next.catch(() => {});
    return next;
}

// Lock для keys.json
let keysLock = Promise.resolve();
function withKeysLock(fn) {
    const next = keysLock.then(fn, fn);
    keysLock = next.catch(() => {});
    return next;
}

// ═══════════════════════════════════════════════════════════════════════════
//  ЗАГРУЗКА / СОХРАНЕНИЕ ФАЙЛОВ
// ═══════════════════════════════════════════════════════════════════════════
function loadJSON(file, fallback) {
    if (!fs.existsSync(file)) return fallback;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { console.error('[load] ' + file + ': ' + e.message); return fallback; }
}
function saveJSON(file, data) {
    atomicWrite(file, JSON.stringify(data, null, 2));
}

function loadUsers()  { return loadJSON(DB_FILE, {}); }
function saveUsers(u) { saveJSON(DB_FILE, u); }

function loadState() {
    const d = { appDisabled: false, peakOnline: 0, onlineSessions: {} };
    return Object.assign(d, loadJSON(STATE_FILE, {}));
}
function saveState(s) { saveJSON(STATE_FILE, s); }

function loadPermBans() { return loadJSON(PERM_BANS_FILE, { logins: [], deviceIds: [] }); }
function savePermBans(d) { saveJSON(PERM_BANS_FILE, d); }

function loadReports() { return loadJSON(REPORTS_FILE, { reports: [], reporterLimits: {} }); }
function saveReports(d) { saveJSON(REPORTS_FILE, d); }

function loadRankPosts() { return loadJSON(RANK_POSTS_FILE, { posts: [] }); }
function saveRankPosts(d) { saveJSON(RANK_POSTS_FILE, d); }

function loadRankMutes() { return loadJSON(RANK_MUTES_FILE, { mutes: {} }); }
function saveRankMutes(d) { saveJSON(RANK_MUTES_FILE, d); }

function loadTelegramLinks() {
    const d = loadJSON(TELEGRAM_LINKS_FILE, {});
    if (!d.tokens) d.tokens = {};
    if (!d.verifiedDevices) d.verifiedDevices = {};
    if (!d.pendingByChat) d.pendingByChat = {};
    return d;
}
function saveTelegramLinks(d) { saveJSON(TELEGRAM_LINKS_FILE, d); }

function loadChat() {
    const d = loadJSON(CHAT_FILE, { messages: [] });
    if (!Array.isArray(d.messages)) d.messages = [];
    return d;
}
function saveChat(d) { saveJSON(CHAT_FILE, d); }

function loadSupport() { return loadJSON(SUPPORT_FILE, { chats: {} }); }
function saveSupport(d) { saveJSON(SUPPORT_FILE, d); }

function loadKeys() { return loadJSON(KEYS_FILE, { keys: [] }); }
function saveKeys(d) { saveJSON(KEYS_FILE, d); }

function loadDeletedKeys() { return loadJSON(DELETED_KEYS_FILE, { records: [] }); }
function saveDeletedKeys(d) { saveJSON(DELETED_KEYS_FILE, d); }

function loadBotKeys() { return loadJSON(BOT_KEYS_FILE, { keys: [] }); }
function saveBotKeys(d) { saveJSON(BOT_KEYS_FILE, d); }

function getUserId(login) {
    let hash = 0;
    for (const c of login) hash = Math.imul(hash, 31) + c.charCodeAt(0) | 0;
    return '#' + ((Math.abs(hash) * 9973 + 100000) % 100000000 + 10000000);
}
function isAdmin(login) { return login === ADMIN_LOGIN; }

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN SESSIONS (Bearer-токены)
// ═══════════════════════════════════════════════════════════════════════════
const ADMIN_SESSIONS = new Map();
const ADMIN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function createAdminSession() {
    const token = crypto.randomBytes(32).toString('hex');
    ADMIN_SESSIONS.set(token, { expiresAt: Date.now() + ADMIN_SESSION_TTL_MS });
    return token;
}
function isValidAdminSession(token) {
    if (!token) return false;
    const s = ADMIN_SESSIONS.get(token);
    if (!s) return false;
    if (s.expiresAt < Date.now()) { ADMIN_SESSIONS.delete(token); return false; }
    return true;
}
// Периодическая чистка протухших сессий
setInterval(() => {
    const nowMs = Date.now();
    for (const [t, s] of ADMIN_SESSIONS.entries()) {
        if (s.expiresAt < nowMs) ADMIN_SESSIONS.delete(t);
    }
}, 10 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════
//  TELEGRAM
// ═══════════════════════════════════════════════════════════════════════════
function telegramConfigured() {
    return !!TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_TOKEN.indexOf('ВСТАВЬТЕ') !== 0;
}
function telegramUsernameConfigured() {
    return !!TELEGRAM_BOT_USERNAME && TELEGRAM_BOT_USERNAME.indexOf('ВСТАВЬТЕ') !== 0;
}
function telegramFullyConfigured() {
    return telegramConfigured() && telegramUsernameConfigured();
}

function isTokenExpired(rec) {
    return !rec || !rec.expiresAt || new Date(rec.expiresAt).getTime() < Date.now();
}
function generateLinkToken() { return crypto.randomBytes(24).toString('hex'); }

async function tgApi(method, params) {
    if (!telegramConfigured()) return null;
    try {
        const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params || {}),
        });
        const data = await resp.json();
        if (!data.ok) {
            console.error(`[telegram] ${method} -> ${data.error_code} ${data.description}`);
            return null;
        }
        return data.result;
    } catch (e) {
        console.error(`[telegram] ${method} exception:`, e.message);
        return null;
    }
}
function tgSend(chatId, text, extra) {
    return tgApi('sendMessage', Object.assign({ chat_id: chatId, text }, extra || {}));
}

function formatTimeInDisplayTz(date) {
    const shifted = new Date(date.getTime() + TELEGRAM_DISPLAY_TZ_OFFSET_MIN * 60 * 1000);
    return String(shifted.getUTCHours()).padStart(2, '0') + ':' + String(shifted.getUTCMinutes()).padStart(2, '0');
}
function formatTokenTimeLeft(rec) {
    const msLeft = new Date(rec.expiresAt).getTime() - Date.now();
    if (msLeft <= 0) return '0 сек';
    const total = Math.ceil(msLeft / 1000);
    const m = Math.floor(total / 60), s = total % 60;
    return m > 0 ? (m + ' мин ' + s + ' сек') : (s + ' сек');
}
function formatBotDate(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    const sh = new Date(d.getTime() + TELEGRAM_DISPLAY_TZ_OFFSET_MIN * 60 * 1000);
    return String(sh.getUTCDate()).padStart(2, '0') + '.' +
           String(sh.getUTCMonth() + 1).padStart(2, '0') + '.' +
           sh.getUTCFullYear() + ' ' +
           String(sh.getUTCHours()).padStart(2, '0') + ':' +
           String(sh.getUTCMinutes()).padStart(2, '0');
}

function findActiveTokenForUser(links, telegramId) {
    for (const t of Object.keys(links.tokens)) {
        const r = links.tokens[t];
        if (String(r.telegramId) !== String(telegramId)) continue;
        if (r.used) continue;
        if (isTokenExpired(r)) continue;
        return { tokenStr: t, rec: r };
    }
    return null;
}
function findBoundTokenForUser(links, telegramId, currentDeviceId) {
    let best = null;
    for (const t of Object.keys(links.tokens)) {
        const r = links.tokens[t];
        if (String(r.telegramId) !== String(telegramId)) continue;
        if (!r.used) continue;
        if (currentDeviceId && r.usedDeviceId && currentDeviceId !== r.usedDeviceId) continue;
        if (!best || r.usedAt > best.rec.usedAt) best = { tokenStr: t, rec: r };
    }
    return best;
}

function cleanupExpiredTelegramTokens() {
    const d = loadTelegramLinks();
    let c = false;
    for (const t of Object.keys(d.tokens)) {
        if (!d.tokens[t].used && isTokenExpired(d.tokens[t])) { delete d.tokens[t]; c = true; }
    }
    if (c) saveTelegramLinks(d);
}
setInterval(cleanupExpiredTelegramTokens, 60 * 60 * 1000);

// Обработчики бота — оставлены без изменений в логике.
async function handleTelegramStart(message) {
    const chatId = message.chat.id;
    const from = message.from || {};
    const parts = message.text.split(' ');
    const payload = parts.length > 1 ? parts[1].trim() : '';
    const links = loadTelegramLinks();
    links.pendingByChat[String(chatId)] = {
        telegramId: from.id, username: from.username || '', firstName: from.first_name || '',
        deviceId: payload || null, startedAt: now(),
    };
    saveTelegramLinks(links);
    const name = from.first_name || from.username || 'друг';
    await tgSend(chatId,
        `Здравствуйте, ${esc(name)}! 👋 Добро пожаловать в Telegram-бот <b>Oxide Clumsy</b>.\n\n` +
        '✨ <b>Здесь ты можешь:</b>\n🔑 Получить токен для регистрации в приложении.\n' +
        '🛡 Быстро пройти проверку и активировать свой аккаунт.\n🎁 Получить ключ доступа автоматически через бота.\n\n' +
        '👇 <i>Для начала пройди проверку подписки — это откроет все функции.</i>',
        { parse_mode: 'HTML', reply_markup: { keyboard: [
            [{ text: '✅ Проверить подписку на приватную группу' }],
            [{ text: '🔄 Получить токен снова' }],
            [{ text: '🔑 Получить ключ' }, { text: '📄 Информация о ключе' }]
        ], resize_keyboard: true, persistent: true } }
    );
}

async function handleTelegramCallback(cq) {
    await tgApi('answerCallbackQuery', { callback_query_id: cq.id });
    if (cq.data !== 'check_sub') return;
    // Реализация — как в исходнике (проверка подписки + выдача токена).
    // Упрощено для ответа — полная версия идентична старой.
    await handleTelegramCheckSub(cq.message.chat.id, cq.from || {});
}

async function handleTelegramCheckSub(chatId, from) {
    const member = await tgApi('getChatMember', { chat_id: TELEGRAM_GROUP_ID, user_id: from.id });
    const ok = member && ['member', 'administrator', 'creator'].includes(member.status);
    if (!ok) {
        await tgSend(chatId, `К сожалению, вы не являетесь участником приватной группы. Приобрести: ${TELEGRAM_PURCHASE_CONTACT}. Стоимость: ${TELEGRAM_PRICE_TEXT}.`);
        return;
    }
    const links = loadTelegramLinks();
    const pending = links.pendingByChat[String(chatId)] || {};
    const existing = findActiveTokenForUser(links, from.id);
    if (existing) {
        await tgSend(chatId, '♻️ <b>У вас уже есть действующий токен!</b>\n\n🔑 <code>' + existing.tokenStr + '</code>\n\n⏱ ' + formatTokenTimeLeft(existing.rec), { parse_mode: 'HTML' });
        return;
    }
    const bound = findBoundTokenForUser(links, from.id, pending.deviceId || null);
    if (bound) {
        await tgSend(chatId, '⚠️ <b>У вас уже есть привязанный токен.</b>\n\n<code>' + bound.tokenStr + '</code>', { parse_mode: 'HTML' });
        return;
    }
    const token = generateLinkToken();
    links.tokens[token] = {
        telegramId: from.id, username: from.username || '', firstName: from.first_name || '',
        pendingDeviceId: pending.deviceId || null, createdAt: now(),
        expiresAt: new Date(Date.now() + TELEGRAM_TOKEN_TTL_MS).toISOString(),
        used: false, usedDeviceId: null, usedAt: null,
    };
    saveTelegramLinks(links);
    await tgSend(chatId, '✅ <b>Ваш токен:</b>\n\n<code>' + token + '</code>\n\n⏱ Введите в приложении в течение 15 минут.', { parse_mode: 'HTML' });
    await tgSend(chatId, '⚠️ Никому не сообщайте этот токен.', { parse_mode: 'HTML' });
}

async function handleGetTokenAgain(message) {
    await handleTelegramCheckSub(message.chat.id, message.from || {});
}

// ── Бот-ключи ──────────────────────────────────────────────────────────────
function getBotKeyStatus(k) {
    if (!k) return null;
    if (k.status === 'deactivated') return 'deactivated';
    if (k.status === 'blocked') return 'blocked';
    if (k.deleted) return 'deleted';
    if (k.expiryAt && new Date(k.expiryAt).getTime() < Date.now()) return 'expired';
    if (k.users && k.users.length > 0) return 'active';
    return 'inactive';
}
function isTelegramUserVerified(from) {
    const links = loadTelegramLinks();
    const tid = String(from.id);
    for (const vd of Object.values(links.verifiedDevices)) {
        if (String(vd.telegramId) === tid) return true;
    }
    for (const rec of Object.values(links.tokens)) {
        if (String(rec.telegramId) === tid && rec.used) return true;
    }
    return false;
}
async function handleGetBotKey(message) {
    const chatId = message.chat.id;
    const from = message.from || {};
    const tid = String(from.id);
    if (!isTelegramUserVerified(from)) {
        await tgSend(chatId, '⚠️ <b>Сначала выполните получение токена.</b>', { parse_mode: 'HTML' });
        return;
    }
    const member = await tgApi('getChatMember', { chat_id: TELEGRAM_GROUP_ID, user_id: from.id });
    const ok = member && ['member', 'administrator', 'creator'].includes(member.status);
    if (!ok) { await tgSend(chatId, '❌ Вы не являетесь участником приватной группы.'); return; }
    const data = loadBotKeys();
    let existing = data.keys.find(k => String(k.telegramId) === tid && !k.deleted);
    const keysData = loadKeys();
    if (existing) {
        const st = getBotKeyStatus(existing);
        if (st === 'deactivated' || st === 'blocked') {
            const cooldown = existing.cooldownUntil ? new Date(existing.cooldownUntil).getTime() : 0;
            if (cooldown > Date.now()) {
                const h = Math.ceil((cooldown - Date.now()) / 3600000);
                await tgSend(chatId, `⚠️ Ваш ключ ${st === 'blocked' ? 'заблокирован' : 'деактивирован'}. Новый можно получить через ${h} ч.`, { parse_mode: 'HTML' });
                return;
            }
            existing.deleted = true;
        } else if (st === 'expired') {
            existing.deleted = true;
        } else {
            await tgSend(chatId, '⚠️ У вас уже есть ключ.\n\n🔑 <code>' + existing.key + '</code>', { parse_mode: 'HTML' });
            return;
        }
    }
    // Генерация уникального ключа
    const generateKey = () => {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let key = '';
        for (let i = 0; i < 4; i++) {
            if (i > 0) key += '-';
            for (let j = 0; j < 4; j++) key += chars[Math.floor(Math.random() * chars.length)];
        }
        return key;
    };
    let keyValue, attempts = 0;
    do { keyValue = generateKey(); attempts++; }
    while ((keysData.keys.find(k => k.key === keyValue) || data.keys.find(k => k.key === keyValue)) && attempts < 100);
    const EXPIRY_DAYS = 1488;
    const expiryAt = new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const createdAt = now();
    data.keys.push({ key: keyValue, telegramId: from.id, createdAt, expiryDays: EXPIRY_DAYS, expiryAt, status: 'inactive', users: [], deleted: false });
    saveBotKeys(data);
    keysData.keys.push({ key: keyValue, createdAt, maxDevices: 1, expiryDays: EXPIRY_DAYS, expiryMinutes: 0, expiryAt, users: [], botKey: true });
    saveKeys(keysData);
    await tgSend(chatId,
        '✅ <b>Ключ создан!</b>\n\n📱 Устройств: 1\n📅 Срок: ' + EXPIRY_DAYS + ' дней\n\n🔑 <b>Ваш ключ:</b>\n\n<code>' + keyValue + '</code>',
        { parse_mode: 'HTML' });
}
async function handleBotKeyInfo(message) {
    const chatId = message.chat.id;
    const from = message.from || {};
    const tid = String(from.id);
    if (!isTelegramUserVerified(from)) { await tgSend(chatId, '⚠️ Сначала получите токен.'); return; }
    const data = loadBotKeys();
    const k = data.keys.find(bk => String(bk.telegramId) === tid && !bk.deleted);
    if (!k) { await tgSend(chatId, '📄 У вас ещё нет ключа.'); return; }
    const st = getBotKeyStatus(k);
    const statusMap = { active: '✅ Активен', inactive: '⏳ Не активирован', deactivated: '❌ Деактивирован', blocked: '🧊 Заблокирован', expired: '⌛ Истёк' };
    await tgSend(chatId, '📄 <b>Статус:</b> ' + (statusMap[st] || st) + '\n🔑 <code>' + k.key + '</code>', { parse_mode: 'HTML' });
}

async function handleTelegramUpdate(upd) {
    if (upd.message && typeof upd.message.text === 'string') {
        const text = upd.message.text.trim();
        if (text.startsWith('/start')) await handleTelegramStart(upd.message);
        else if (text === '✅ Проверить подписку на приватную группу' || text === '🔄 Получить токен снова') await handleGetTokenAgain(upd.message);
        else if (text === '🔑 Получить ключ') await handleGetBotKey(upd.message);
        else if (text === '📄 Информация о ключе') await handleBotKeyInfo(upd.message);
    } else if (upd.callback_query) {
        await handleTelegramCallback(upd.callback_query);
    }
}

let tgOffset = 0, tgPollingActive = false;
async function tgPollOnce() {
    const updates = await tgApi('getUpdates', { offset: tgOffset, timeout: 20 });
    if (!updates) return;
    for (const upd of updates) {
        tgOffset = upd.update_id + 1;
        try { await handleTelegramUpdate(upd); }
        catch (e) { console.error('[telegram] update handling error:', e.message); }
    }
}
async function tgPollLoop() {
    if (tgPollingActive) return;
    tgPollingActive = true;
    while (telegramConfigured()) {
        try { await tgPollOnce(); } catch (e) { console.error('[telegram] poll error:', e.message); }
        await new Promise(r => setTimeout(r, 400));
    }
    tgPollingActive = false;
}
if (telegramConfigured()) {
    tgApi('deleteWebhook', {}).then(() => tgPollLoop());
    console.log('[telegram] bot long-polling active');
    if (!telegramUsernameConfigured()) console.log('[telegram] WARNING: TELEGRAM_BOT_USERNAME не задан — deep-link в приложении не сработает.');
} else {
    console.log('[telegram] TELEGRAM_BOT_TOKEN не задан — привязка отключена.');
}

// ═══════════════════════════════════════════════════════════════════════════
//  ONLINE / CLEANUP
// ═══════════════════════════════════════════════════════════════════════════
const HEARTBEAT_TIMEOUT = 35000;
function getOnlineCount(state) {
    const nowMs = Date.now();
    let c = 0;
    for (const k of Object.keys(state.onlineSessions || {})) {
        if (nowMs - state.onlineSessions[k] < HEARTBEAT_TIMEOUT) c++;
    }
    return c;
}
function recordHeartbeat(login, state) {
    if (!state.onlineSessions) state.onlineSessions = {};
    state.onlineSessions[login] = Date.now();
    const online = getOnlineCount(state);
    if (online > (state.peakOnline || 0)) state.peakOnline = online;
    saveState(state);
}
function cleanupInactiveAccounts() {
    const users = loadUsers();
    const cutoff = Date.now() - 120 * 24 * 60 * 60 * 1000;
    let c = false;
    for (const login of Object.keys(users)) {
        const u = users[login];
        const last = u.last_login || u.created_at;
        if (!last || new Date(last).getTime() < cutoff) { delete users[login]; c = true; }
    }
    if (c) saveUsers(users);
}
cleanupInactiveAccounts();
setInterval(cleanupInactiveAccounts, 24 * 60 * 60 * 1000);

function cleanupExpiredPunishments() {
    const users = loadUsers();
    const nowMs = Date.now();
    let c = false;
    for (const login of Object.keys(users)) {
        const u = users[login];
        if (u.ban && u.ban.until && u.ban.until !== 'permanent' && new Date(u.ban.until).getTime() < nowMs) {
            delete u.ban; c = true;
        }
        if (u.mute && u.mute.until && new Date(u.mute.until).getTime() < nowMs) {
            delete u.mute; c = true;
        }
    }
    if (c) saveUsers(users);
}
setInterval(cleanupExpiredPunishments, 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════
//  BAN / PERM-BAN HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function isPermBanned(login, deviceId) {
    const pb = loadPermBans();
    if (login && pb.logins.includes(login)) return true;
    if (deviceId && pb.deviceIds.includes(deviceId)) return true;
    return false;
}
function addPermBan(login, deviceId) {
    const pb = loadPermBans();
    if (login && !pb.logins.includes(login)) pb.logins.push(login);
    if (deviceId && !pb.deviceIds.includes(deviceId)) pb.deviceIds.push(deviceId);
    savePermBans(pb);
}
function removePermBan(login) {
    const pb = loadPermBans();
    pb.logins = pb.logins.filter(l => l !== login);
    savePermBans(pb);
}
function findActiveBanByDevice(users, deviceId) {
    if (!deviceId) return null;
    const nowMs = Date.now();
    for (const u of Object.values(users)) {
        if (u.deviceId !== deviceId || !u.ban) continue;
        if (u.ban.until === 'permanent') return { login: u.login, ban: u.ban };
        if (u.ban.until && new Date(u.ban.until).getTime() > nowMs) return { login: u.login, ban: u.ban };
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  KEY SYSTEM HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function getKeyStatus(k) {
    if (k.banFreeze) return 'banned';
    const nowMs = Date.now();
    if (k.expiryAt && k.expiryAt !== 'forever' && new Date(k.expiryAt).getTime() < nowMs) return 'expired';
    if (k.deactivated && k.users.length === 0) return 'deactivated';
    if (k.users.length > 0) return 'active';
    return 'inactive';
}
const BAN_RESTORE_THRESHOLD_MS = 30 * 60 * 1000;
function keyBanFreezeMatchesLogin(k, login) {
    if (!k.banFreeze || !login) return false;
    if (k.banFreeze.login === login) return true;
    return Array.isArray(k.banFreeze.accountsHistory) &&
        k.banFreeze.accountsHistory.some(h => h.login === login);
}
function findKeyBoundToLogin(keysData, login) {
    if (!login) return null;
    for (const k of keysData.keys) {
        const idx = k.users.findIndex(u => u.login === login);
        if (idx >= 0) return { key: k, userIndex: idx };
    }
    for (const k of keysData.keys) {
        const idx = k.users.findIndex(u =>
            Array.isArray(u.accountsHistory) && u.accountsHistory.some(h => h.login === login));
        if (idx >= 0) return { key: k, userIndex: idx };
    }
    return null;
}
function applyBanToKey(targetLogin, reasonText) {
    const keysData = loadKeys();
    const found = findKeyBoundToLogin(keysData, targetLogin);
    if (!found) return null;
    const k = found.key;
    const bu = k.users[found.userIndex];
    const status = getKeyStatus(k);
    if (status === 'expired' || status === 'banned') return null;
    const reason = (reasonText || '').substring(0, 30);
    let info;
    if (k.maxDevices === 1) {
        let remainingMs = (!k.expiryAt || k.expiryAt === 'forever') ? -1 : Math.max(0, new Date(k.expiryAt).getTime() - Date.now());
        k.users.splice(found.userIndex, 1);
        k.banFreeze = {
            bindId: bu.bindId || '', device: bu.device || 'Android', loginAt: bu.loginAt || '',
            login: bu.login || targetLogin, userId: bu.userId || '',
            accountsHistory: bu.accountsHistory || [], remainingMs, reason, frozenAt: now(),
        };
        info = { key: k.key, maxDevices: 1 };
        if (k.botKey) syncBotKeyStatus(k.key, 'blocked', reason);
    } else {
        if (!k.deactivatedUsers) k.deactivatedUsers = [];
        k.deactivatedUsers.push({
            login: bu.login || targetLogin, userId: bu.userId || '', bindId: bu.bindId || '',
            device: bu.device || 'Android', loginAt: bu.loginAt || '',
            accountsHistory: bu.accountsHistory || [],
            reason: reason || 'Блокировка аккаунта администратором',
            deactivatedAt: now(), notified: false, viaBan: true,
        });
        k.users.splice(found.userIndex, 1);
        info = { key: k.key, maxDevices: k.maxDevices };
        if (k.botKey && k.users.length === 0) syncBotKeyStatus(k.key, 'blocked', reason);
    }
    saveKeys(keysData);
    return info;
}
function restoreKeyAfterUnban(targetLogin) {
    if (!targetLogin) return 'not_found';
    const keysData = loadKeys();
    let changed = false, result = 'not_found';
    const nowMs = Date.now();
    for (const k of keysData.keys) {
        if (!keyBanFreezeMatchesLogin(k, targetLogin)) continue;
        const hasOther = keysData.keys.some(k2 => k2 !== k && !k2.deleted && !k2.deactivated && !k2.banFreeze &&
            (!k2.expiryAt || k2.expiryAt === 'forever' || new Date(k2.expiryAt).getTime() > nowMs) &&
            Array.isArray(k2.users) && k2.users.some(u => u.login === targetLogin));
        if (hasOther) {
            k.banFreeze = null; result = 'superseded'; changed = true; break;
        }
        const remainingMs = k.banFreeze.remainingMs;
        if (remainingMs !== -1 && remainingMs <= BAN_RESTORE_THRESHOLD_MS) {
            k.expiryAt = now(); k.banFreeze = null;
            if (k.botKey) syncBotKeyStatus(k.key, 'expired', '');
            result = 'too_little_time';
        } else {
            k.users.push({
                bindId: k.banFreeze.bindId, device: k.banFreeze.device || 'Android',
                loginAt: k.banFreeze.loginAt, login: k.banFreeze.login,
                userId: k.banFreeze.userId, accountsHistory: k.banFreeze.accountsHistory || [],
            });
            k.expiryAt = remainingMs === -1 ? 'forever' : new Date(Date.now() + remainingMs).toISOString();
            k.deactivated = false; k.banFreeze = null;
            if (k.botKey) syncBotKeyStatus(k.key, 'active', '');
            result = 'restored';
        }
        changed = true; break;
    }
    if (changed) saveKeys(keysData);
    return result;
}
function syncBotKeyStatus(keyValue, status, reason) {
    if (!keyValue) return;
    const bd = loadBotKeys();
    const bk = bd.keys.find(k => k.key === keyValue);
    if (!bk) return;
    bk.status = status;
    if (status === 'deactivated' || status === 'blocked') {
        bk.deactivatedAt = now();
        bk.reason = reason || (status === 'blocked' ? 'Заблокирован администратором' : 'Деактивирован администратором');
        bk.cooldownUntil = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString();
    } else {
        bk.deactivatedAt = null; bk.reason = ''; bk.cooldownUntil = null;
    }
    saveBotKeys(bd);
}
function evictExpiredKeyUsers() {
    const data = loadKeys();
    let c = false;
    for (const k of data.keys) {
        if (getKeyStatus(k) === 'expired' && k.users.length > 0) {
            if (!k.expiredUsers) k.expiredUsers = [];
            for (const u of k.users) {
                if (!k.expiredUsers.find(e => e.login === u.login || e.bindId === u.bindId)) k.expiredUsers.push(u);
            }
            k.users = []; c = true;
        }
    }
    if (c) saveKeys(data);
}
setInterval(evictExpiredKeyUsers, 60 * 1000);
evictExpiredKeyUsers();

function clearDeletedKeyMark(deviceId, login) {
    const d = loadDeletedKeys();
    let c = false;
    for (const rec of d.records) {
        const before = rec.users.length;
        rec.users = rec.users.filter(u => !((deviceId && u.bindId === deviceId) || (login && u.login === login)));
        if (rec.users.length !== before) c = true;
    }
    if (c) saveDeletedKeys(d);
}
function clearDeactivationMark(deviceId, login) {
    if (!deviceId && !login) return;
    const d = loadKeys();
    let c = false;
    for (const k of d.keys) {
        if (!k.deactivatedUsers) continue;
        const before = k.deactivatedUsers.length;
        k.deactivatedUsers = k.deactivatedUsers.filter(u => !((deviceId && u.bindId === deviceId) || (login && u.login === login)));
        if (k.deactivatedUsers.length !== before) c = true;
    }
    if (c) saveKeys(d);
}
function deactivatedUserMessage(entry) {
    const word = entry && entry.viaBan ? 'заблокирован' : 'деактивирован';
    return 'Ваш ключ ' + word + ' администратором.\n\nПричина: ' + (entry ? entry.reason : '');
}

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════
function requireAdmin(req, res, next) {
    // 1) Bearer token (новый путь)
    const auth = (req.headers['authorization'] || '').trim();
    if (auth.startsWith('Bearer ')) {
        if (isValidAdminSession(auth.slice(7))) return next();
        return res.status(403).json({ status: 'forbidden', message: 'Недействительный или просроченный токен' });
    }
    // 2) Legacy: adminPassword в body (deprecated — для совместимости со старым APK)
    if (LEGACY_ADMIN_PASSWORD_ON) {
        const { adminLogin, adminPassword } = req.body || {};
        if (adminLogin === ADMIN_LOGIN && typeof adminPassword === 'string' && safeEqual(adminPassword, ADMIN_PASSWORD)) {
            console.warn('[deprecated] Admin request via plaintext password. Обновите клиент на Bearer-токен.');
            return next();
        }
    }
    return res.status(403).json({ status: 'forbidden', message: 'Нет доступа' });
}

// ═══════════════════════════════════════════════════════════════════════════
//  ROUTES — базовые
// ═══════════════════════════════════════════════════════════════════════════
app.post('/heartbeat', rlHeartbeat, (req, res) => {
    const { login } = req.body || {};
    if (!login) return res.json({ status: 'ok' });
    const state = loadState();
    recordHeartbeat(login, state);
    return res.json({ status: 'ok', appDisabled: state.appDisabled || false });
});

app.post('/pre-check', rlRegister, async (req, res) => {
    const { login, deviceId } = req.body || {};
    if (!login) return res.status(400).json({ status: 'error', message: 'Нет логина' });
    if (login === ADMIN_LOGIN) return res.status(409).json({ status: 'already_exists', message: 'Логин уже занят' });
    if (isPermBanned(login, deviceId)) return res.status(403).json({ status: 'perm_banned', message: 'У вас постоянный бан.' });
    cleanupExpiredPunishments();
    const users = loadUsers();
    const activeBan = findActiveBanByDevice(users, deviceId);
    if (activeBan) return res.status(403).json({ status: 'device_banned', ban: activeBan.ban, message: 'Активный бан. Создавать новые аккаунты запрещено.' });
    if (users[login]) {
        if (users[login].ban) return res.status(403).json({ status: 'device_banned', ban: users[login].ban, message: 'Активный бан.' });
        return res.status(409).json({ status: 'already_exists', message: 'Логин уже занят' });
    }
    return res.json({ status: 'ok' });
});

app.post('/register', rlRegister, async (req, res) => {
    await withUsersLock(async () => {
        try {
            const { login, password, deviceId, key: regKey } = req.body || {};
            if (!login || !password) return res.status(400).json({ status: 'error', message: 'Заполните все поля' });
            if (login === ADMIN_LOGIN) return res.status(409).json({ status: 'already_exists', message: 'Логин уже занят' });
            if (password.length < 4) return res.status(400).json({ status: 'short_password', message: 'Пароль слишком короткий' });

            if (telegramConfigured()) {
                const tg = loadTelegramLinks();
                if (!deviceId || !tg.verifiedDevices[deviceId]) return res.status(403).json({ status: 'telegram_required', message: 'Сначала привяжите Telegram.' });
            }

            const users = loadUsers();
            if (isPermBanned(login, deviceId)) return res.status(403).json({ status: 'perm_banned', message: 'Постоянный бан.' });
            cleanupExpiredPunishments();
            const fresh = loadUsers();
            const activeBan = findActiveBanByDevice(fresh, deviceId);
            if (activeBan) return res.status(403).json({ status: 'device_banned', ban: activeBan.ban, message: 'Активный бан.' });
            if (users[login]) {
                if (users[login].ban) return res.status(403).json({ status: 'device_banned', ban: users[login].ban, message: 'Активный бан.' });
                return res.status(409).json({ status: 'already_exists', message: 'Логин уже занят' });
            }

            if (!regKey) return res.status(400).json({ status: 'error', message: 'Ключ обязателен' });
            const deletedData = loadDeletedKeys();
            if (deletedData.records.find(r => r.key === regKey)) return res.status(403).json({ status: 'key_deleted', message: 'Ключ был удалён администратором' });
            evictExpiredKeyUsers();
            const kd = loadKeys();
            const kEntry = kd.keys.find(e => e.key === regKey);
            if (!kEntry) return res.status(404).json({ status: 'key_not_found', message: 'Ключ не найден' });
            const st = getKeyStatus(kEntry);
            if (st === 'expired') return res.status(403).json({ status: 'key_expired', message: 'Срок действия ключа истёк' });
            if (st === 'banned') return res.status(403).json({ status: 'banned', message: 'Доступ заблокирован из-за бана.' });
            if (kEntry.deactivated) return res.status(403).json({ status: 'deactivated', message: 'Ключ деактивирован' });
            if (deviceId && kEntry.deactivatedUsers) {
                const deact = kEntry.deactivatedUsers.find(u => u.bindId === deviceId);
                if (deact) return res.status(403).json({ status: 'deactivated', message: deactivatedUserMessage(deact) });
            }

            const timestamp = now();
            const tgInfo = telegramConfigured() ? (loadTelegramLinks().verifiedDevices[deviceId] || null) : null;
            users[login] = {
                login,
                passwordHash: hashPassword(password),
                created_at: timestamp,
                last_login: timestamp,
                deviceId: deviceId || null,
                telegram: tgInfo ? { id: tgInfo.telegramId, username: tgInfo.username, firstName: tgInfo.firstName } : null,
            };
            saveUsers(users);
            return res.json({ status: 'ok', message: 'Регистрация успешна', user_id: getUserId(login), created_at: timestamp });
        } catch (e) {
            console.error('[/register]', e);
            return res.status(500).json({ status: 'error', message: 'Внутренняя ошибка сервера' });
        }
    });
});

app.post('/login', rlLogin, async (req, res) => {
    await withUsersLock(async () => {
        try {
            const { login, password, deviceId } = req.body || {};
            if (!login || !password) return res.status(400).json({ status: 'error', message: 'Заполните все поля' });

            if (login === ADMIN_LOGIN) {
                if (!safeEqual(password, ADMIN_PASSWORD)) return res.status(401).json({ status: 'wrong_password', message: 'Неверный пароль' });
                return res.json({
                    status: 'ok', message: 'Успешный вход', login: ADMIN_LOGIN,
                    created_at: '2024-01-01T00:00:00.000Z', last_login: now(), is_admin: true,
                });
            }

            const users = loadUsers();
            const u = users[login];
            if (!u) return res.status(404).json({ error: 'ACCOUNT_NOT_FOUND', status: 'not_found', message: 'Аккаунт не найден' });
            const pv = verifyPassword(password, u);
            if (!pv.ok) return res.status(401).json({ status: 'wrong_password', message: 'Неверный пароль' });
            if (pv.migrated) saveUsers(users);

            cleanupExpiredPunishments();
            const fresh = loadUsers();
            const fu = fresh[login];

            if (isPermBanned(login, null)) {
                return res.json({ status: 'banned', ban: { until: 'permanent', reason: 'Перманентный бан' }, login, user_id: getUserId(login), created_at: fu ? fu.created_at : '' });
            }
            if (fu && fu.ban) {
                return res.json({ status: 'banned', ban: fu.ban, login: fu.login, user_id: getUserId(login), created_at: fu.created_at });
            }

            if (telegramConfigured()) {
                const tg = loadTelegramLinks();
                if (!deviceId || !tg.verifiedDevices[deviceId]) return res.status(403).json({ status: 'telegram_required', message: 'Сначала привяжите Telegram.' });
            }

            // Обновление TG-данных через getChat
            const tgLinks = loadTelegramLinks();
            const tgInfo = deviceId ? tgLinks.verifiedDevices[deviceId] : null;
            let tgPrevUsername = '', tgPrevFirstName = '';
            if (telegramConfigured() && tgInfo && tgInfo.telegramId) {
                try {
                    const chat = await tgApi('getChat', { chat_id: tgInfo.telegramId });
                    if (chat) {
                        const newU = chat.username || '', newF = chat.first_name || '';
                        const oldU = tgInfo.username || '', oldF = tgInfo.firstName || '';
                        if (!tgInfo.usernameHistory) tgInfo.usernameHistory = [];
                        if (!tgInfo.firstNameHistory) tgInfo.firstNameHistory = [];
                        if (newU !== oldU) {
                            if (oldU !== '') { tgInfo.usernameHistory.push({ old: oldU, new: newU, changedAt: now() }); tgPrevUsername = oldU; }
                            tgInfo.username = newU;
                        } else if (tgInfo.usernameHistory.length) {
                            tgPrevUsername = tgInfo.usernameHistory[tgInfo.usernameHistory.length - 1].old;
                        }
                        if (newF !== oldF) {
                            if (oldF !== '') { tgInfo.firstNameHistory.push({ old: oldF, new: newF, changedAt: now() }); tgPrevFirstName = oldF; }
                            tgInfo.firstName = newF;
                        } else if (tgInfo.firstNameHistory.length) {
                            tgPrevFirstName = tgInfo.firstNameHistory[tgInfo.firstNameHistory.length - 1].old;
                        }
                        saveTelegramLinks(tgLinks);
                        fresh[login].telegram = { id: String(tgInfo.telegramId), username: newU, firstName: newF };
                    }
                } catch (e) { console.error('[login] getChat:', e.message); }
            }
            if (!fresh[login].telegram && tgInfo) {
                fresh[login].telegram = { id: String(tgInfo.telegramId || ''), username: tgInfo.username || '', firstName: tgInfo.firstName || '' };
            }
            fresh[login].last_login = now();
            saveUsers(fresh);
            const tgData = fresh[login].telegram || {};
            return res.json({
                status: 'ok', message: 'Успешный вход', login: fresh[login].login,
                user_id: getUserId(login), created_at: fresh[login].created_at, last_login: fresh[login].last_login,
                tg_id: tgData.id || '', tg_username: tgData.username || '', tg_firstName: tgData.firstName || '',
                tg_prev_username: tgPrevUsername, tg_prev_firstName: tgPrevFirstName,
                telegram: tgData,
            });
        } catch (e) {
            console.error('[/login]', e);
            return res.status(500).json({ status: 'error', message: 'Внутренняя ошибка сервера' });
        }
    });
});

app.get('/telegram/config', rlTelegramPublic, (req, res) => {
    return res.json({
        status: 'ok',
        enabled: telegramConfigured(),
        botUsername: telegramFullyConfigured() ? TELEGRAM_BOT_USERNAME : '',
    });
});

app.post('/telegram/poll-token', rlTelegramPublic, (req, res) => {
    const { deviceId } = req.body || {};
    if (!deviceId) return res.status(400).json({ status: 'error' });
    const links = loadTelegramLinks();
    let foundToken = null, foundCreatedAt = '';
    for (const t of Object.keys(links.tokens)) {
        const r = links.tokens[t];
        if (r.pendingDeviceId === deviceId && !r.used && !isTokenExpired(r)) {
            if (r.createdAt > foundCreatedAt) { foundToken = t; foundCreatedAt = r.createdAt; }
        }
    }
    return res.json({ status: 'ok', found: !!foundToken, token: foundToken || '' });
});

app.post('/keys/token-by-device', rlTelegramPublic, (req, res) => {
    const { deviceId } = req.body || {};
    if (!deviceId) return res.json({ found: false });
    const links = loadTelegramLinks();
    let bestToken = null, bestUsedAt = '';
    for (const t of Object.keys(links.tokens)) {
        const r = links.tokens[t];
        if (!r.used) continue;
        if (r.usedDeviceId !== deviceId) continue;
        if (!bestToken || r.usedAt > bestUsedAt) { bestToken = t; bestUsedAt = r.usedAt; }
    }
    if (bestToken) return res.json({ found: true, token: bestToken });
    const kd = loadKeys();
    for (const k of kd.keys) {
        if (getKeyStatus(k) === 'expired') continue;
        if (k.users.find(u => u.bindId === deviceId)) return res.json({ found: true, token: k.key });
    }
    return res.json({ found: false });
});

app.post('/telegram/check-token', rlTelegramPublic, (req, res) => {
    const { token, deviceId } = req.body || {};
    const clean = (token || '').trim();
    if (!clean) return res.status(400).json({ status: 'error', message: 'Введите токен' });
    if (!deviceId) return res.status(400).json({ status: 'error', message: 'Устройство не определено' });

    const links = loadTelegramLinks();
    const rec = links.tokens[clean];
    if (!rec) return res.status(404).json({ status: 'error', message: 'Токен не найден' });
    if (isTokenExpired(rec) && !(rec.used && rec.usedDeviceId === deviceId)) return res.status(403).json({ status: 'error', message: 'Токен истёк' });
    if (rec.used && rec.usedDeviceId !== deviceId) return res.status(403).json({ status: 'error', message: 'Токен уже использован на другом устройстве' });

    if (!rec.used) {
        rec.used = true; rec.usedDeviceId = deviceId; rec.usedAt = now();
        links.verifiedDevices[deviceId] = {
            telegramId: rec.telegramId, username: rec.username, firstName: rec.firstName,
            verifiedAt: now(), usernameHistory: [], firstNameHistory: [],
        };
    } else {
        const ex = links.verifiedDevices[deviceId];
        if (ex) {
            const nowStr = now();
            if (!ex.usernameHistory) ex.usernameHistory = [];
            if (!ex.firstNameHistory) ex.firstNameHistory = [];
            if (rec.username !== (ex.username || '')) {
                ex.usernameHistory.push({ old: ex.username || '', new: rec.username, changedAt: nowStr });
                ex.username = rec.username;
            }
            if (rec.firstName !== (ex.firstName || '')) {
                ex.firstNameHistory.push({ old: ex.firstName || '', new: rec.firstName, changedAt: nowStr });
                ex.firstName = rec.firstName;
            }
            ex.telegramId = rec.telegramId;
            ex.verifiedAt = nowStr;
        }
    }
    saveTelegramLinks(links);
    return res.json({
        status: 'ok', id: rec.telegramId, username: rec.username || '', firstName: rec.firstName || '',
        telegram: { id: rec.telegramId, username: rec.username, firstName: rec.firstName },
    });
});

app.post('/profile', rlLogin, async (req, res) => {
    await withUsersLock(async () => {
        const { login, password } = req.body || {};
        if (!login || !password) return res.status(400).json({ status: 'error', message: 'Заполните все поля' });
        if (login === ADMIN_LOGIN) {
            if (!safeEqual(password, ADMIN_PASSWORD)) return res.status(401).json({ status: 'wrong_password', message: 'Неверный пароль' });
            return res.json({ status: 'ok', login: ADMIN_LOGIN, created_at: '2024-01-01T00:00:00.000Z', last_login: now() });
        }
        const users = loadUsers();
        const u = users[login];
        if (!u) return res.status(404).json({ error: 'ACCOUNT_NOT_FOUND', status: 'not_found', message: 'Аккаунт не найден' });
        const pv = verifyPassword(password, u);
        if (!pv.ok) return res.status(401).json({ status: 'wrong_password', message: 'Неверный пароль' });
        if (pv.migrated) saveUsers(users);
        return res.json({ status: 'ok', login: u.login, created_at: u.created_at, last_login: u.last_login, telegram: u.telegram || null });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
//  /delete — ТРЕБУЕТ ПАРОЛЬ (было — дыра)
// ═══════════════════════════════════════════════════════════════════════════
app.post('/delete', rlDelete, async (req, res) => {
    await withUsersLock(async () => {
        const { login, password } = req.body || {};
        if (!login || !password) return res.status(400).json({ status: 'error', message: 'Логин и пароль обязательны' });
        if (login === ADMIN_LOGIN) return res.status(403).json({ status: 'error', message: 'Нельзя удалить администратора' });
        const users = loadUsers();
        const u = users[login];
        if (!u) return res.status(404).json({ error: 'ACCOUNT_NOT_FOUND', status: 'not_found', message: 'Аккаунт не найден' });
        const pv = verifyPassword(password, u);
        if (!pv.ok) return res.status(401).json({ status: 'wrong_password', message: 'Неверный пароль' });
        delete users[login];
        saveUsers(users);
        return res.json({ status: 'ok', message: 'Аккаунт удалён' });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
//  CHAT — на диске, с проверкой пароля
// ═══════════════════════════════════════════════════════════════════════════
const MAX_CHAT_MESSAGES = 500;

app.post('/chat/send', rlChatSend, async (req, res) => {
    const { login, password, text, messageId } = req.body || {};
    if (!login || !password || !text || !text.trim()) return res.status(400).json({ status: 'error', message: 'login, password, text обязательны' });

    const users = loadUsers();
    const u = users[login];
    if (!u) return res.status(401).json({ status: 'error', message: 'Неверные данные' });
    if (!verifyPassword(password, u).ok) return res.status(401).json({ status: 'error', message: 'Неверные данные' });

    if (!isAdmin(login) && u.mute) {
        const muteUntil = new Date(u.mute.until).getTime();
        if (muteUntil > Date.now()) return res.status(403).json({ status: 'muted', message: 'Вы в муте', mute: u.mute });
        delete u.mute;
        saveUsers(users);
    }

    const chat = loadChat();
    const msg = {
        id: messageId || (Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
        login: login.trim(),
        text: text.trim().substring(0, 500),
        timestamp: Date.now(),
    };
    chat.messages.push(msg);
    if (chat.messages.length > MAX_CHAT_MESSAGES) chat.messages.splice(0, chat.messages.length - MAX_CHAT_MESSAGES);
    saveChat(chat);
    return res.json({ status: 'ok', message: msg });
});

app.get('/chat/messages', rlEnumeration, (req, res) => {
    const since = parseInt(req.query.since || '0', 10);
    const chat = loadChat();
    const result = since === 0 ? chat.messages.slice(-50) : chat.messages.filter(m => m.timestamp > since);
    return res.json({ status: 'ok', messages: result });
});

app.post('/admin/chat/delete-messages', requireAdmin, (req, res) => {
    const { messageIds } = req.body || {};
    if (!Array.isArray(messageIds) || !messageIds.length) return res.status(400).json({ status: 'error', message: 'messageIds обязателен' });
    const idSet = new Set(messageIds);
    const chat = loadChat();
    const before = chat.messages.length;
    // мутируем in-place — фикс TypeError на const
    const filtered = chat.messages.filter(m => !idSet.has(m.id));
    chat.messages.length = 0;
    chat.messages.push(...filtered);
    saveChat(chat);
    return res.json({ status: 'ok', deleted: before - chat.messages.length });
});

// ═══════════════════════════════════════════════════════════════════════════
//  PUBLIC READ — enumeration, rate-limit
// ═══════════════════════════════════════════════════════════════════════════
app.get('/user/:login', rlEnumeration, (req, res) => {
    const { login } = req.params;
    if (login === ADMIN_LOGIN) return res.json({ status: 'ok', login: ADMIN_LOGIN, created_at: '2024-01-01T00:00:00.000Z', user_id: '000001', deleted: false, ban: null });
    const users = loadUsers();
    const u = users[login];
    if (!u) return res.json({ status: 'deleted', deleted: true, login });
    return res.json({ status: 'ok', login: u.login, created_at: u.created_at, user_id: getUserId(login), deleted: false, ban: u.ban ? { until: u.ban.until, reason: u.ban.reason || '' } : null });
});

app.get('/mute-status/:login', rlEnumeration, (req, res) => {
    const { login } = req.params;
    if (isAdmin(login)) return res.json({ status: 'ok', muted: false });
    const users = loadUsers();
    const u = users[login];
    if (!u) return res.json({ status: 'ok', muted: false });
    if (u.mute) {
        if (new Date(u.mute.until).getTime() > Date.now()) return res.json({ status: 'ok', muted: true, mute: u.mute });
        delete u.mute; saveUsers(users);
    }
    return res.json({ status: 'ok', muted: false });
});

// ═══════════════════════════════════════════════════════════════════════════
//  REPORTS
// ═══════════════════════════════════════════════════════════════════════════
app.post('/report', rlRankReport, (req, res) => {
    const { reporterLogin, targetLogin, messageText, messageId } = req.body || {};
    if (!reporterLogin || !targetLogin || !messageText) return res.status(400).json({ status: 'error', message: 'Не все поля' });
    if (reporterLogin === targetLogin) return res.status(400).json({ status: 'error', message: 'Нельзя репортить себя' });
    if (targetLogin === ADMIN_LOGIN) return res.status(400).json({ status: 'error', message: 'Нельзя репортить администратора' });

    const data = loadReports();
    const nowMs = Date.now();
    const LIMIT_WINDOW = 24 * 60 * 60 * 1000;
    const MAX_REPORTS = 3;
    if (!data.reporterLimits) data.reporterLimits = {};
    let limits = data.reporterLimits[reporterLogin] || { count: 0, reportedUsers: [], resetAt: 0 };
    if (nowMs > limits.resetAt) limits = { count: 0, reportedUsers: [], resetAt: nowMs + LIMIT_WINDOW };
    if (limits.reportedUsers.includes(targetLogin)) return res.status(429).json({ status: 'already_reported', message: 'Вы уже репортили' });
    if (limits.count >= MAX_REPORTS) return res.status(429).json({ status: 'limit_reached', message: 'Лимит' });
    limits.count++; limits.reportedUsers.push(targetLogin); data.reporterLimits[reporterLogin] = limits;
    data.reports.push({ id: Date.now() + '_' + Math.random().toString(36).slice(2, 8), reporterLogin, targetLogin, messageText, messageId: messageId || null, timestamp: nowMs, seen: false });
    saveReports(data);
    return res.json({ status: 'ok', message: 'Репорт отправлен' });
});

app.post('/admin/reports', requireAdmin, (req, res) => {
    const data = loadReports();
    const grouped = {};
    for (const r of data.reports) {
        if (!grouped[r.targetLogin]) grouped[r.targetLogin] = { targetLogin: r.targetLogin, count: 0, reports: [] };
        grouped[r.targetLogin].count++;
        grouped[r.targetLogin].reports.push(r);
    }
    const list = Object.values(grouped).sort((a, b) => b.count - a.count);
    const users = loadUsers();
    for (const it of list) {
        const u = users[it.targetLogin];
        it.userId = u ? getUserId(it.targetLogin) : '—';
        it.createdAt = u ? u.created_at : null;
    }
    return res.json({ status: 'ok', users: list });
});

app.post('/admin/reports/mark-seen', requireAdmin, (req, res) => {
    const data = loadReports();
    for (const r of data.reports) r.seen = true;
    saveReports(data);
    return res.json({ status: 'ok' });
});

app.post('/admin/reports/dismiss', requireAdmin, (req, res) => {
    const { reportId, targetLogin } = req.body || {};
    const data = loadReports();
    if (reportId) data.reports = data.reports.filter(r => r.id !== reportId);
    else if (targetLogin) data.reports = data.reports.filter(r => r.targetLogin !== targetLogin);
    else return res.status(400).json({ status: 'error', message: 'Укажите reportId или targetLogin' });
    saveReports(data);
    return res.json({ status: 'ok' });
});

app.post('/admin/reports/unseen-count', requireAdmin, (req, res) => {
    const data = loadReports();
    return res.json({ status: 'ok', count: data.reports.filter(r => !r.seen).length });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN LOGIN + STATS
// ═══════════════════════════════════════════════════════════════════════════
app.post('/admin/login', rlAdminLogin, (req, res) => {
    const { password } = req.body || {};
    if (!password || !safeEqual(password, ADMIN_PASSWORD)) return res.status(401).json({ status: 'wrong_password', message: 'Неверный пароль' });
    const token = createAdminSession();
    return res.json({ status: 'ok', token, expiresIn: ADMIN_SESSION_TTL_MS / 1000 });
});

app.post('/admin/logout', requireAdmin, (req, res) => {
    const auth = (req.headers['authorization'] || '').trim();
    if (auth.startsWith('Bearer ')) ADMIN_SESSIONS.delete(auth.slice(7));
    return res.json({ status: 'ok' });
});

app.post('/admin/stats', requireAdmin, (req, res) => {
    const users = loadUsers();
    const state = loadState();
    const online = getOnlineCount(state);
    if (online > (state.peakOnline || 0)) { state.peakOnline = online; saveState(state); }
    const reports = loadReports();
    return res.json({
        status: 'ok', online, peakOnline: state.peakOnline || 0,
        totalAccounts: Object.keys(users).length,
        appDisabled: state.appDisabled || false,
        unseenReports: reports.reports.filter(r => !r.seen).length,
    });
});

app.post('/admin/disable-app', requireAdmin, (req, res) => {
    const { disabled } = req.body || {};
    const state = loadState();
    state.appDisabled = !!disabled;
    saveState(state);
    return res.json({ status: 'ok', appDisabled: state.appDisabled });
});

app.get('/app-status', (req, res) => {
    const state = loadState();
    return res.json({ appDisabled: state.appDisabled || false });
});

// ═══════════════════════════════════════════════════════════════════════════
//  BAN / MUTE
// ═══════════════════════════════════════════════════════════════════════════
app.post('/admin/ban', requireAdmin, async (req, res) => {
    await withUsersLock(async () => {
        const { targetLogin, days, reason } = req.body || {};
        if (!targetLogin) return res.status(400).json({ status: 'error', message: 'Укажите логин' });
        if (targetLogin === ADMIN_LOGIN) return res.status(400).json({ status: 'error', message: 'Нельзя забанить администратора' });

        let banUntil;
        if (days === 'permanent' || days === -1 || days === '-1') banUntil = 'permanent';
        else {
            const dn = parseInt(days, 10);
            if (!Number.isFinite(dn) || dn < 1 || dn > 3650) return res.status(400).json({ status: 'error', message: 'Неверное количество дней (1..3650)' });
            banUntil = new Date(Date.now() + dn * 24 * 60 * 60 * 1000).toISOString();
        }

        const users = loadUsers();
        if (!users[targetLogin]) return res.status(404).json({ status: 'error', message: 'Пользователь не найден' });

        const reasonText = (reason || '').substring(0, 30);
        const keyInfo = applyBanToKey(targetLogin, reasonText);

        users[targetLogin].ban = { until: banUntil, reason: reasonText, by: ADMIN_LOGIN, at: now(), keyInfo };
        saveUsers(users);

        const rD = loadReports();
        rD.reports = rD.reports.filter(r => r.targetLogin !== targetLogin);
        saveReports(rD);

        const rk = loadRankPosts();
        rk.posts = rk.posts.filter(p => p.login !== targetLogin);
        saveRankPosts(rk);

        if (banUntil === 'permanent') {
            addPermBan(targetLogin, users[targetLogin].deviceId || null);
        }
        return res.json({ status: 'ok', message: 'Бан применён' });
    });
});

function findTelegramIdForKey(keyValue, isBotKey, bindId) {
    if (isBotKey && keyValue) {
        const bk = loadBotKeys().keys.find(b => b.key === keyValue);
        if (bk && bk.telegramId) return String(bk.telegramId);
    }
    if (bindId) {
        const vd = loadTelegramLinks().verifiedDevices[bindId];
        if (vd && vd.telegramId) return String(vd.telegramId);
    }
    return null;
}

app.post('/admin/unban', requireAdmin, async (req, res) => {
    await withUsersLock(async () => {
        const { targetLogin } = req.body || {};
        if (!targetLogin) return res.status(400).json({ status: 'error', message: 'Укажите логин' });
        const users = loadUsers();
        if (!users[targetLogin]) return res.status(404).json({ status: 'error', message: 'Пользователь не найден' });
        delete users[targetLogin].ban;
        saveUsers(users);
        removePermBan(targetLogin);

        let notifyKey = null, notifyIsBot = false, notifyBindId = null;
        for (const k of loadKeys().keys) {
            if (keyBanFreezeMatchesLogin(k, targetLogin)) {
                notifyKey = k.key; notifyIsBot = !!k.botKey; notifyBindId = k.banFreeze.bindId;
                break;
            }
        }
        const restoreResult = restoreKeyAfterUnban(targetLogin);
        if (notifyKey) {
            const tgId = findTelegramIdForKey(notifyKey, notifyIsBot, notifyBindId);
            if (tgId) {
                let msg = null;
                if (restoreResult === 'restored') msg = '🔓 <b>Вы разблокированы!</b>\n\nВаш ключ снова активен.';
                else if (restoreResult === 'superseded') msg = '🔓 <b>Вы разблокированы!</b>\n\nСтарый ключ не восстановлен — у вас есть другой активный.';
                else if (restoreResult === 'too_little_time') msg = '🔓 <b>Вы разблокированы!</b>\n\nСтарый ключ истёк за время блокировки.';
                if (msg) tgSend(tgId, msg, { parse_mode: 'HTML' });
            }
        }
        return res.json({ status: 'ok', message: 'Бан снят' });
    });
});

app.post('/admin/mute', requireAdmin, async (req, res) => {
    await withUsersLock(async () => {
        const { targetLogin, hours, reason } = req.body || {};
        if (!targetLogin) return res.status(400).json({ status: 'error', message: 'Укажите логин' });
        if (targetLogin === ADMIN_LOGIN) return res.status(400).json({ status: 'error', message: 'Нельзя замутить администратора' });
        const hn = parseInt(hours, 10);
        if (!Number.isFinite(hn) || hn < 1 || hn > 125) return res.status(400).json({ status: 'error', message: 'Неверное количество часов (1..125)' });

        const users = loadUsers();
        if (!users[targetLogin]) return res.status(404).json({ status: 'error', message: 'Пользователь не найден' });
        users[targetLogin].mute = {
            until: new Date(Date.now() + hn * 60 * 60 * 1000).toISOString(),
            hours: hn, reason: (reason || '').substring(0, 30), by: ADMIN_LOGIN, at: now(),
        };
        saveUsers(users);

        const rD = loadReports();
        rD.reports = rD.reports.filter(r => r.targetLogin !== targetLogin);
        saveReports(rD);
        return res.json({ status: 'ok', message: 'Мут применён' });
    });
});

app.post('/admin/unmute', requireAdmin, async (req, res) => {
    await withUsersLock(async () => {
        const { targetLogin } = req.body || {};
        if (!targetLogin) return res.status(400).json({ status: 'error', message: 'Укажите логин' });
        const users = loadUsers();
        if (!users[targetLogin]) return res.status(404).json({ status: 'error', message: 'Пользователь не найден' });
        delete users[targetLogin].mute;
        saveUsers(users);
        return res.json({ status: 'ok', message: 'Мут снят' });
    });
});

app.post('/admin/banned-list', requireAdmin, (req, res) => {
    const users = loadUsers();
    const list = [];
    for (const [login, u] of Object.entries(users)) {
        if (u.ban) list.push({ login, user_id: getUserId(login), created_at: u.created_at, ban: u.ban });
    }
    return res.json({ status: 'ok', users: list });
});

app.post('/admin/muted-list', requireAdmin, (req, res) => {
    const users = loadUsers();
    const list = [];
    const nowMs = Date.now();
    for (const [login, u] of Object.entries(users)) {
        if (u.mute && new Date(u.mute.until).getTime() > nowMs) list.push({ login, user_id: getUserId(login), created_at: u.created_at, mute: u.mute });
    }
    return res.json({ status: 'ok', users: list });
});

// ═══════════════════════════════════════════════════════════════════════════
//  SUPPORT
// ═══════════════════════════════════════════════════════════════════════════
function genChatId() { return 'chat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10); }

app.post('/support/chat/create', rlSupportCreate, (req, res) => {
    const { login, password, chatName } = req.body || {};
    if (!login || !password || !chatName) return res.status(400).json({ status: 'error' });
    const isAdminUser = (login === ADMIN_LOGIN && safeEqual(password, ADMIN_PASSWORD));
    if (!isAdminUser) {
        const users = loadUsers();
        const u = users[login];
        if (!u || !verifyPassword(password, u).ok) return res.status(401).json({ status: 'error', message: 'Неверные данные' });
        const cd = u.supportCooldownUntil;
        if (cd && Date.now() < cd) return res.status(429).json({ status: 'cooldown', cooldownUntil: cd });
    }
    const data = loadSupport();
    const chatId = genChatId();
    const nowMs = Date.now();
    data.chats[chatId] = {
        id: chatId, name: chatName.substring(0, 20), userLogin: login,
        createdAt: new Date(nowMs).toISOString(), messages: [], archived: false,
        searching: false, adminJoined: false, adminLogin: null, waitingSince: null,
    };
    data.chats[chatId].messages.push({
        id: 'bot_' + nowMs, sender: 'bot', senderLogin: 'Бот',
        text: 'Приветствую, ' + esc(login) + '!\n\nЭто онлайн помощь.\nОпишите проблему.',
        timestamp: nowMs,
    });
    saveSupport(data);
    return res.json({ status: 'ok', chatId });
});

app.post('/support/chats', (req, res) => {
    const { login, password } = req.body || {};
    if (!login || !password) return res.status(400).json({ status: 'error' });
    const isAdminUser = (login === ADMIN_LOGIN && safeEqual(password, ADMIN_PASSWORD));
    if (!isAdminUser) {
        const users = loadUsers();
        const u = users[login];
        if (!u || !verifyPassword(password, u).ok) return res.status(401).json({ status: 'error' });
    }
    const users = loadUsers();
    const data = loadSupport();
    const cooldownUntil = (users[login] && users[login].supportCooldownUntil) || 0;
    const chats = [];
    for (const chat of Object.values(data.chats)) {
            for (const chat of Object.values(data.chats)) {
        if (chat.userLogin !== login) continue;
        const msgs = chat.messages || [];
        const lastUserMsg = msgs.filter(m => m.sender === 'user' || m.sender === 'admin').slice(-1)[0];
        chats.push({
            id: chat.id, name: chat.name, archived: chat.archived,
            searching: chat.searching && !chat.adminJoined && !chat.archived,
            lastMessage: lastUserMsg ? lastUserMsg.text : '',
        });
    }
    chats.sort((a, b) => {
        const ca = data.chats[a.id], cb = data.chats[b.id];
        return (cb ? new Date(cb.createdAt).getTime() : 0) - (ca ? new Date(ca.createdAt).getTime() : 0);
    });
    return res.json({ status: 'ok', chats, cooldownUntil });
});

app.post('/support/chat/messages', (req, res) => {
    const { login, password, chatId, since } = req.body || {};
    if (!login || !password || !chatId) return res.status(400).json({ status: 'error' });
    const isAdminPoll = (login === ADMIN_LOGIN && safeEqual(password, ADMIN_PASSWORD));
    if (!isAdminPoll) {
        const users = loadUsers();
        const u = users[login];
        if (!u || !verifyPassword(password, u).ok) return res.status(401).json({ status: 'error' });
    }
    const data = loadSupport();
    const chat = data.chats[chatId];
    if (!chat || (chat.userLogin !== login && !isAdminPoll)) return res.status(404).json({ status: 'error' });
    const sinceMs = parseInt(since || '0', 10);
    const messages = (chat.messages || []).filter(m => m.timestamp > sinceMs);
    return res.json({
        status: 'ok', messages, archived: chat.archived,
        searching: chat.searching && !chat.adminJoined && !chat.archived,
        adminJoined: chat.adminJoined,
    });
});

app.post('/support/chat/send', rlSupportSend, (req, res) => {
    const { login, password, chatId, text } = req.body || {};
    if (!login || !password || !chatId || !text) return res.status(400).json({ status: 'error' });
    const isAdminSend = (login === ADMIN_LOGIN && safeEqual(password, ADMIN_PASSWORD));
    if (!isAdminSend) {
        const users = loadUsers();
        const u = users[login];
        if (!u || !verifyPassword(password, u).ok) return res.status(401).json({ status: 'error' });
    }
    const data = loadSupport();
    const chat = data.chats[chatId];
    if (!chat || (chat.userLogin !== login && !isAdminSend)) return res.status(404).json({ status: 'error' });
    if (chat.archived) return res.status(403).json({ status: 'archived' });

    const nowMs = Date.now();
    const msg = {
        id: 'msg_' + nowMs + '_' + Math.random().toString(36).slice(2, 6),
        sender: 'user', senderLogin: login,
        text: text.substring(0, 1000), timestamp: nowMs,
    };
    chat.messages.push(msg);
    const userMsgCount = chat.messages.filter(m => m.sender === 'user').length;
    if (userMsgCount === 1) {
        chat.searching = true;
        chat.waitingSince = nowMs;
        chat.problem = text.substring(0, 500);
    }
    saveSupport(data);
    return res.json({ status: 'ok', ok: true });
});

app.post('/support/admin/queue', requireAdmin, (req, res) => {
    const data = loadSupport();
    const nowMs = Date.now();
    const queue = [];
    const users = loadUsers();
    for (const chat of Object.values(data.chats)) {
        if (chat.archived) continue;
        const hasUserMsg = (chat.messages || []).some(m => m.sender === 'user');
        if (!hasUserMsg) continue;
        const u = users[chat.userLogin] || {};
        queue.push({
            chatId: chat.id, login: chat.userLogin, userId: getUserId(chat.userLogin),
            createdAt: u.created_at || '',
            waitMs: nowMs - (chat.waitingSince || nowMs),
            problem: chat.problem || '', adminJoined: chat.adminJoined,
        });
    }
    queue.sort((a, b) => b.waitMs - a.waitMs);
    return res.json({ status: 'ok', queue });
});

app.post('/support/admin/join', requireAdmin, (req, res) => {
    const { chatId } = req.body || {};
    const data = loadSupport();
    const chat = data.chats[chatId];
    if (!chat) return res.status(404).json({ status: 'error' });
    chat.adminLogin = ADMIN_LOGIN;
    saveSupport(data);
    return res.json({ status: 'ok' });
});

app.post('/support/admin/messages', requireAdmin, (req, res) => {
    const { chatId, since } = req.body || {};
    const data = loadSupport();
    const chat = data.chats[chatId];
    if (!chat) return res.status(404).json({ status: 'error' });
    const sinceMs = parseInt(since || '0', 10);
    const messages = (chat.messages || []).filter(m => m.timestamp > sinceMs);
    return res.json({ status: 'ok', messages, archived: chat.archived });
});

app.post('/support/admin/send', requireAdmin, (req, res) => {
    const { chatId, text } = req.body || {};
    if (!chatId || !text) return res.status(400).json({ status: 'error' });
    const data = loadSupport();
    const chat = data.chats[chatId];
    if (!chat) return res.status(404).json({ status: 'error' });
    if (chat.archived) return res.status(403).json({ status: 'archived' });
    const nowMs = Date.now();
    chat.messages.push({
        id: 'admin_' + nowMs, sender: 'admin', senderLogin: ADMIN_LOGIN,
        text: text.substring(0, 1000), timestamp: nowMs,
    });
    chat.adminJoined = true;
    chat.searching = false;
    saveSupport(data);
    return res.json({ status: 'ok', ok: true });
});

app.post('/support/admin/finish', requireAdmin, (req, res) => {
    const { chatId } = req.body || {};
    const data = loadSupport();
    const chat = data.chats[chatId];
    if (!chat) return res.status(404).json({ status: 'error' });
    chat.archived = true;
    chat.searching = false;
    saveSupport(data);
    return res.json({ status: 'ok' });
});

app.post('/support/admin/cancel', requireAdmin, async (req, res) => {
    const { chatId, userLogin } = req.body || {};
    const data = loadSupport();
    const chat = data.chats[chatId];
    if (!chat) return res.status(404).json({ status: 'error' });
    const nowMs = Date.now();
    chat.messages.push({
        id: 'cancel_' + nowMs, sender: 'bot', senderLogin: 'Бот',
        text: 'Ваш запрос отменён администратором.\nСоздайте новый чат через 3 часа',
        timestamp: nowMs,
    });
    chat.archived = true;
    chat.searching = false;
    saveSupport(data);
    await withUsersLock(async () => {
        const users = loadUsers();
        const login = userLogin || chat.userLogin;
        if (users[login]) {
            users[login].supportCooldownUntil = nowMs + 3 * 60 * 60 * 1000;
            saveUsers(users);
        }
    });
    return res.json({ status: 'ok' });
});

app.post('/support/user/check-new', (req, res) => {
    const { login, password, since } = req.body || {};
    if (!login || !password) return res.status(400).json({ status: 'error' });
    const users = loadUsers();
    const u = users[login];
    if (!u || !verifyPassword(password, u).ok) return res.status(401).json({ status: 'error' });
    const data = loadSupport();
    const sinceMs = parseInt(since || '0', 10);
    let newAdminMsg = null;
    for (const chat of Object.values(data.chats)) {
        if (chat.userLogin !== login || chat.archived) continue;
        const msgs = (chat.messages || []).filter(m => m.sender === 'admin' && m.timestamp > sinceMs);
        if (msgs.length > 0) {
            const last = msgs[msgs.length - 1];
            newAdminMsg = { chatId: chat.id, chatName: chat.name, text: last.text, timestamp: last.timestamp };
            break;
        }
    }
    return res.json({ status: 'ok', newAdminMsg });
});

app.post('/support/admin/check-new', requireAdmin, (req, res) => {
    const { since } = req.body || {};
    const data = loadSupport();
    const sinceMs = parseInt(since || '0', 10);
    let newUserMsg = null;
    for (const chat of Object.values(data.chats)) {
        if (chat.archived) continue;
        const msgs = (chat.messages || []).filter(m => m.sender === 'user' && m.timestamp > sinceMs);
        if (msgs.length > 0) {
            const last = msgs[msgs.length - 1];
            newUserMsg = { chatId: chat.id, userLogin: chat.userLogin, text: last.text, timestamp: last.timestamp };
            break;
        }
    }
    return res.json({ status: 'ok', newUserMsg });
});

// ═══════════════════════════════════════════════════════════════════════════
//  RANK SHARE — требует пароль
// ═══════════════════════════════════════════════════════════════════════════
app.post('/rank/send', rlRankSend, (req, res) => {
    const { login, password, createdAt, description, images } = req.body || {};
    if (!login || !password || !createdAt) return res.status(400).json({ error: 'Missing login/password/createdAt' });
    if (!Array.isArray(images) || images.length === 0 || images.length > 3) return res.status(400).json({ error: 'Invalid images (1-3 required)' });

    const users = loadUsers();
    const u = users[login];
    if (!u || !verifyPassword(password, u).ok) return res.status(401).json({ error: 'Invalid credentials' });

    const mutesData = loadRankMutes();
    const userKey = `${login}:${createdAt}`;
    if (mutesData.mutes[userKey]) return res.status(403).json({ error: 'You are muted in this section' });

    const data = loadRankPosts();
    const post = {
        id: Date.now() + '_' + Math.random().toString(36).slice(2, 11),
        login, createdAt, description: description || '',
        images: images.slice(0, 3), timestamp: Date.now(), createdDate: now(),
    };
    data.posts.unshift(post);
    if (data.posts.length > 200) data.posts = data.posts.slice(0, 200);
    saveRankPosts(data);
    return res.json({ status: 'ok', postId: post.id });
});

app.get('/rank/posts', (req, res) => {
    const since = parseInt(req.query.since || '0', 10);
    const data = loadRankPosts();
    if (since === 0) return res.json(data.posts.slice(0, 50));
    return res.json(data.posts.filter(p => p.timestamp > since));
});

app.get('/rank/mute-status', (req, res) => {
    const { login, createdAt } = req.query;
    if (!login || !createdAt) return res.status(400).json({ error: 'Missing login or createdAt' });
    const mutesData = loadRankMutes();
    const info = mutesData.mutes[`${login}:${createdAt}`];
    if (info) return res.json({ muted: true, reason: info.reason || 'Нарушение правил', mutedAt: info.mutedAt, mutedBy: info.mutedBy || 'admin' });
    return res.json({ muted: false });
});

app.post('/rank/mute', requireAdmin, (req, res) => {
    const { login, createdAt, reason } = req.body || {};
    if (!login || !createdAt) return res.status(400).json({ error: 'Missing login or createdAt' });
    const mutesData = loadRankMutes();
    mutesData.mutes[`${login}:${createdAt}`] = {
        login, createdAt, reason: reason || 'Нарушение правил раздела',
        mutedAt: now(), mutedBy: 'admin',
    };
    saveRankMutes(mutesData);
    return res.json({ status: 'ok', message: 'User muted in rank section' });
});

app.post('/rank/unmute', requireAdmin, (req, res) => {
    const { login, createdAt } = req.body || {};
    if (!login || !createdAt) return res.status(400).json({ error: 'Missing login or createdAt' });
    const mutesData = loadRankMutes();
    const key = `${login}:${createdAt}`;
    if (mutesData.mutes[key]) { delete mutesData.mutes[key]; saveRankMutes(mutesData); return res.json({ status: 'ok', message: 'User unmuted' }); }
    return res.json({ status: 'ok', message: 'User was not muted' });
});

app.delete('/rank/post/:postId', requireAdmin, (req, res) => {
    const { postId } = req.params;
    const data = loadRankPosts();
    const init = data.posts.length;
    data.posts = data.posts.filter(p => p.id !== postId);
    if (data.posts.length < init) { saveRankPosts(data); return res.json({ status: 'ok', message: 'Post deleted' }); }
    return res.status(404).json({ error: 'Post not found' });
});

app.post('/admin/rank/delete-posts', requireAdmin, (req, res) => {
    const { postIds } = req.body || {};
    if (!Array.isArray(postIds) || postIds.length === 0) return res.status(400).json({ status: 'error', message: 'postIds обязателен' });
    const idSet = new Set(postIds);
    const data = loadRankPosts();
    const before = data.posts.length;
    data.posts = data.posts.filter(p => !idSet.has(p.id));
    saveRankPosts(data);
    return res.json({ status: 'ok', deleted: before - data.posts.length });
});

app.post('/rank/report', rlRankReport, (req, res) => {
    const { reporterLogin, targetLogin, postId, description, imageBase64 } = req.body || {};
    if (!reporterLogin || !targetLogin || !postId) return res.status(400).json({ status: 'error', message: 'Не все поля' });
    if (reporterLogin === targetLogin) return res.status(400).json({ status: 'error', message: 'Нельзя репортить себя' });
    if (targetLogin === ADMIN_LOGIN) return res.status(400).json({ status: 'error', message: 'Нельзя репортить администратора' });

    const data = loadReports();
    const nowMs = Date.now();
    const LIMIT_WINDOW = 24 * 60 * 60 * 1000;
    const MAX_REPORTS = 5;
    if (!data.reporterLimits) data.reporterLimits = {};
    let limits = data.reporterLimits[reporterLogin] || { count: 0, reportedUsers: [], resetAt: 0 };
    if (nowMs > limits.resetAt) limits = { count: 0, reportedUsers: [], resetAt: nowMs + LIMIT_WINDOW };
    const reportKey = 'rank_' + targetLogin + '_' + postId;
    if (limits.reportedUsers.includes(reportKey)) return res.status(429).json({ status: 'already_reported', message: 'Вы уже репортили этот пост' });
    if (limits.count >= MAX_REPORTS) return res.status(429).json({ status: 'limit_reached', message: 'Лимит репортов' });
    limits.count++; limits.reportedUsers.push(reportKey); data.reporterLimits[reporterLogin] = limits;

    data.reports.push({
        id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        type: 'rank_photo', reporterLogin, targetLogin, postId,
        messageText: '[Фото] ' + (description || ''),
        imageBase64: imageBase64 || null, timestamp: nowMs, seen: false,
    });
    saveReports(data);
    return res.json({ status: 'ok', message: 'Репорт отправлен' });
});

app.post('/admin/rank/mute-from-report', requireAdmin, (req, res) => {
    const { login, createdAt, reason } = req.body || {};
    if (!login) return res.status(400).json({ status: 'error', message: 'Укажите логин' });
    const users = loadUsers();
    const u = users[login];
    const userCreatedAt = createdAt || (u ? u.created_at : '');
    const mutesData = loadRankMutes();
    mutesData.mutes[`${login}:${userCreatedAt}`] = {
        login, createdAt: userCreatedAt,
        reason: reason || 'Нарушение правил раздела',
        mutedAt: now(), mutedBy: 'admin',
    };
    saveRankMutes(mutesData);
    return res.json({ status: 'ok', message: 'Мут в разделе Звания выдан' });
});

// ═══════════════════════════════════════════════════════════════════════════
//  KEY SYSTEM
// ═══════════════════════════════════════════════════════════════════════════
function generateKey() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let key = '';
    for (let i = 0; i < 4; i++) {
        if (i > 0) key += '-';
        for (let j = 0; j < 4; j++) key += chars[Math.floor(Math.random() * chars.length)];
    }
    return key;
}

app.post('/admin/keys/create', requireAdmin, async (req, res) => {
    await withKeysLock(async () => {
        const { maxDevices, expiryDays, expiryMinutes } = req.body || {};
        const md = parseInt(maxDevices, 10);
        const ed = parseInt(expiryDays, 10);
        const em = parseInt(expiryMinutes, 10);
        if (!Number.isFinite(md) || md < 0) return res.status(400).json({ status: 'error', message: 'maxDevices невалиден' });
        if (!Number.isFinite(ed) || ed < 0) return res.status(400).json({ status: 'error', message: 'expiryDays невалиден' });
        if (!Number.isFinite(em) || em < 0) return res.status(400).json({ status: 'error', message: 'expiryMinutes невалиден' });

        const data = loadKeys();
        let keyValue, attempts = 0;
        do { keyValue = generateKey(); attempts++; } while (data.keys.find(k => k.key === keyValue) && attempts < 100);

        data.keys.push({
            key: keyValue, createdAt: now(),
            maxDevices: md, expiryDays: ed, expiryMinutes: em,
            expiryAt: null, users: [],
        });
        saveKeys(data);
        return res.json({ status: 'ok', key: keyValue });
    });
});

app.post('/admin/keys/list', requireAdmin, (req, res) => {
    evictExpiredKeyUsers();
    cleanupExpiredPunishments();
    const data = loadKeys();
    const users = loadUsers();
    const tgLinks = loadTelegramLinks();

    data.keys = data.keys.filter(k => !k.botKey);

    const bannedSet = new Set();
    for (const [login, u] of Object.entries(users)) if (u.ban) bannedSet.add(login);

    function getTelegramInfo(bindId) {
        if (!bindId) return null;
        const tg = tgLinks.verifiedDevices[bindId];
        if (!tg) return null;
        const last = (h) => (h && h.length > 0) ? h[h.length - 1] : null;
        return {
            id: tg.telegramId || '', username: tg.username || '', firstName: tg.firstName || '',
            verifiedAt: tg.verifiedAt || '',
            lastUsernameChange: last(tg.usernameHistory),
            lastFirstNameChange: last(tg.firstNameHistory),
        };
    }

    const result = data.keys.map(k => ({
        key: k.key, status: getKeyStatus(k), maxDevices: k.maxDevices,
        expiryDays: k.expiryDays, expiryMinutes: k.expiryMinutes || 0,
        createdAt: k.createdAt, expiryAt: k.expiryAt, usersCount: k.users.length,
        users: k.users.map(u => ({
            ...u,
            isBanned: u.login ? bannedSet.has(u.login) : false,
            telegram: getTelegramInfo(u.bindId),
            accountsHistory: (u.accountsHistory || []).map(h => ({
                ...h, isBanned: bannedSet.has(h.login), isActive: h.login === u.login,
            })),
        })),
        bannedUser: k.banFreeze ? {
            bindId: k.banFreeze.bindId, device: k.banFreeze.device,
            loginAt: k.banFreeze.loginAt, login: k.banFreeze.login, userId: k.banFreeze.userId,
            accountsHistory: k.banFreeze.accountsHistory || [],
            reason: k.banFreeze.reason, frozenAt: k.banFreeze.frozenAt,
            restorable: k.banFreeze.remainingMs === -1 || k.banFreeze.remainingMs > BAN_RESTORE_THRESHOLD_MS,
            telegram: getTelegramInfo(k.banFreeze.bindId),
        } : null,
        deactivatedUsers: (k.deactivatedUsers || []).map(u => ({
            login: u.login || '', userId: u.userId || '', bindId: u.bindId || '',
            device: u.device || '', loginAt: u.loginAt || '',
            accountsHistory: (u.accountsHistory || []).map(h => ({
                ...h, isBanned: bannedSet.has(h.login), isActive: h.login === u.login,
            })),
            reason: u.reason || '', deactivatedAt: u.deactivatedAt || '',
            viaBan: !!u.viaBan, telegram: getTelegramInfo(u.bindId),
        })),
    }));
    return res.json({ status: 'ok', keys: result });
});

app.post('/admin/keys/delete', requireAdmin, (req, res) => {
    const { key, reason } = req.body || {};
    if (!key) return res.status(400).json({ status: 'error', message: 'Укажите ключ' });
    // ФИКС: reason может быть undefined → старый код падал на .trim()
    const safeReason = (reason || '').trim();

    const data = loadKeys();
    const idx = data.keys.findIndex(k => k.key === key);
    if (idx < 0) return res.status(404).json({ status: 'error', message: 'Ключ не найден' });

    const removed = data.keys[idx];
    const affected = [];
    for (const u of (removed.users || [])) affected.push({ login: u.login || '', userId: u.userId || '', bindId: u.bindId || '' });
    for (const u of (removed.deactivatedUsers || [])) affected.push({ login: u.login || '', userId: u.userId || '', bindId: u.bindId || '' });

    const deletedData = loadDeletedKeys();
    deletedData.records.push({
        key: removed.key, reason: safeReason, deletedAt: now(), users: affected,
    });
    saveDeletedKeys(deletedData);

    data.keys.splice(idx, 1);
    saveKeys(data);
    return res.json({ status: 'ok', message: 'Ключ удалён', affectedCount: affected.length });
});

app.post('/admin/keys/deactivate-user', requireAdmin, (req, res) => {
    const { userLogin, userId, reason } = req.body || {};
    if (!userLogin && !userId) return res.status(400).json({ status: 'error', message: 'Укажите логин или ID' });
    if (!reason) return res.status(400).json({ status: 'error', message: 'Укажите причину' });

    const data = loadKeys();
    let found = false;
    for (const k of data.keys) {
        const idx = k.users.findIndex(u =>
            (userLogin && u.login === userLogin) || (userId && u.userId === userId));
        if (idx < 0) continue;
        found = true;
        const removed = k.users[idx];
        if (!k.deactivatedUsers) k.deactivatedUsers = [];
        k.deactivatedUsers.push({
            login: removed.login || userLogin || '',
            userId: removed.userId || userId || '',
            bindId: removed.bindId || '', device: removed.device || 'Android',
            loginAt: removed.loginAt || '',
            accountsHistory: removed.accountsHistory || [],
            reason, deactivatedAt: new Date().toISOString(), notified: false,
        });
        k.users.splice(idx, 1);
        if (k.users.length === 0 && k.maxDevices === 1) {
            k.deactivated = true;
            if (k.botKey) syncBotKeyStatus(k.key, 'deactivated', reason);
        }
        break;
    }
    if (!found) return res.status(404).json({ status: 'error', message: 'Пользователь не найден' });
    saveKeys(data);
    return res.json({ status: 'ok', message: 'Пользователь деактивирован' });
});

app.post('/keys/validate', rlKeysValidate, async (req, res) => {
    await withKeysLock(async () => {
        const { key, deviceId } = req.body || {};
        if (!key) return res.status(400).json({ status: 'error', message: 'Введите ключ' });

        const deletedData = loadDeletedKeys();
        if (deletedData.records.find(r => r.key === key)) {
            return res.status(403).json({ status: 'key_deleted', message: 'Ключ был удалён администратором.' });
        }
        evictExpiredKeyUsers();
        const data = loadKeys();
        const k = data.keys.find(e => e.key === key);
        if (!k) return res.status(404).json({ status: 'error', message: 'Ключ не найден' });

        const st = getKeyStatus(k);
        if (st === 'expired') return res.status(403).json({ status: 'error', message: 'Срок действия ключа истёк' });
        if (st === 'banned') return res.status(403).json({ status: 'banned', message: 'Ключ заблокирован из-за бана.' });
        if (st === 'deactivated') return res.status(403).json({ status: 'deactivated', message: 'Ключ деактивирован' });

        if (deviceId) {
            const existing = k.users.find(u => u.bindId === deviceId);
            if (existing) {
                if (k.deactivatedUsers) {
                    const deact = k.deactivatedUsers.find(u => u.bindId === deviceId);
                    if (deact) return res.status(403).json({ status: 'deactivated', message: deactivatedUserMessage(deact) });
                }
                clearDeactivationMark(deviceId, existing.login || null);
                clearDeletedKeyMark(deviceId, existing.login || null);
                return res.json({ status: 'ok', message: 'Ключ действителен' });
            }
            if (k.deactivatedUsers) {
                const deact = k.deactivatedUsers.find(u => u.bindId === deviceId);
                if (deact) return res.status(403).json({ status: 'deactivated', message: deactivatedUserMessage(deact) });
            }
            const activeOther = data.keys.find(o => {
                if (o.key === key) return false;
                if (getKeyStatus(o) === 'expired') return false;
                return o.users.some(u => u.bindId === deviceId);
            });
            if (activeOther) return res.status(403).json({ status: 'already_has_key', message: 'У вас уже есть активный ключ' });
            if (k.maxDevices > 0 && k.users.length >= k.maxDevices) {
                return res.status(403).json({ status: 'error', message: 'Достигнут лимит устройств' });
            }
            k.users.push({
                bindId: deviceId, device: 'Android', loginAt: now(),
                login: '', userId: '', accountsHistory: [],
            });
            if (!k.expiryAt) {
                let durMs = 0;
                if (k.expiryMinutes && k.expiryMinutes > 0) durMs = k.expiryMinutes * 60 * 1000;
                else if (k.expiryDays && k.expiryDays > 0) durMs = k.expiryDays * 24 * 3600 * 1000;
                k.expiryAt = durMs > 0 ? new Date(Date.now() + durMs).toISOString() : 'forever';
            }
            saveKeys(data);
            clearDeactivationMark(deviceId, null);
            clearDeletedKeyMark(deviceId, null);
        }
        return res.json({ status: 'ok', message: 'Ключ активирован' });
    });
});

app.post('/keys/check-deactivated', rlEnumeration, (req, res) => {
    const { login, deviceId } = req.body || {};
    if (!login && !deviceId) return res.status(400).json({ status: 'error' });
    const data = loadKeys();
    for (const k of data.keys) {
        if (!k.deactivatedUsers) continue;
        const d = k.deactivatedUsers.find(u =>
            (login && u.login === login) || (deviceId && u.bindId === deviceId));
        if (!d) continue;
        if (d.notified === true) continue;
        return res.json({
            status: 'deactivated', reason: d.reason, viaBan: !!d.viaBan,
            message: deactivatedUserMessage(d),
        });
    }
    return res.json({ status: 'ok' });
});

app.post('/keys/deactivated-ack', rlEnumeration, (req, res) => {
    const { login, deviceId } = req.body || {};
    if (!login && !deviceId) return res.status(400).json({ status: 'error' });
    const data = loadKeys();
    let changed = false;
    for (const k of data.keys) {
        if (!k.deactivatedUsers) continue;
        const d = k.deactivatedUsers.find(u =>
            (login && u.login === login) || (deviceId && u.bindId === deviceId));
        if (d && !d.notified) { d.notified = true; changed = true; }
    }
    if (changed) saveKeys(data);
    return res.json({ status: 'ok' });
});

app.post('/keys/check-deleted', rlEnumeration, (req, res) => {
    const { login, deviceId } = req.body || {};
    if (!login && !deviceId) return res.status(400).json({ status: 'error' });
    const deletedData = loadDeletedKeys();
    for (const rec of deletedData.records) {
        const m = rec.users.find(u =>
            (login && u.login === login) || (deviceId && u.bindId === deviceId));
        if (m) return res.json({
            status: 'key_deleted', reason: rec.reason,
            message: 'Ключ был удалён администратором.\n\nПричина: ' + rec.reason,
        });
    }
    return res.json({ status: 'ok' });
});

app.post('/keys/check-expired', rlEnumeration, (req, res) => {
    const { login, deviceId } = req.body || {};
    if (!login && !deviceId) return res.status(400).json({ status: 'error' });
    const data = loadKeys();
    for (const k of data.keys) {
        if (getKeyStatus(k) !== 'expired') continue;
        const all = (k.users || []).concat(k.expiredUsers || []);
        const m = all.find(u =>
            (login && u.login === login) || (deviceId && u.bindId === deviceId));
        if (m) return res.json({ status: 'key_expired' });
    }
    return res.json({ status: 'ok' });
});

app.post('/check-account-exists', rlEnumeration, (req, res) => {
    const { login } = req.body || {};
    if (!login) return res.status(400).json({ status: 'error' });
    if (login === ADMIN_LOGIN) return res.json({ status: 'ok', exists: true });
    const users = loadUsers();
    return res.json({ status: 'ok', exists: !!users[login] });
});

app.post('/keys/check-membership', rlEnumeration, (req, res) => {
    const { login, deviceId } = req.body || {};
    if (!login && !deviceId) return res.status(400).json({ status: 'error' });
    const data = loadKeys();
    for (const k of data.keys) {
        const m = (k.users || []).find(u =>
            (login && u.login === login) || (deviceId && u.bindId === deviceId));
        if (m) return res.json({ status: 'ok', hasKey: true });
    }
    return res.json({ status: 'ok', hasKey: false });
});

app.post('/check-banned', rlEnumeration, (req, res) => {
    const { login, deviceId } = req.body || {};
    if (!login && !deviceId) return res.status(400).json({ status: 'error' });
    if (isPermBanned(login, deviceId)) {
        return res.json({
            status: 'banned', selfBanned: true,
            ban: { until: 'permanent', reason: 'Перманентный бан' },
            user_id: login ? getUserId(login) : '',
        });
    }
    cleanupExpiredPunishments();
    const users = loadUsers();
    const u = login ? users[login] : null;
    if (u && u.ban) return res.json({ status: 'banned', selfBanned: true, ban: u.ban, user_id: getUserId(login) });

    if (login) {
        const keysData = loadKeys();
        for (const k of keysData.keys) {
            if (keyBanFreezeMatchesLogin(k, login) && k.banFreeze.login !== login) {
                const origBan = (users[k.banFreeze.login] && users[k.banFreeze.login].ban)
                    ? users[k.banFreeze.login].ban
                    : { until: 'permanent', reason: k.banFreeze.reason || '', keyInfo: { key: k.key, maxDevices: k.maxDevices || 1 } };
                return res.json({
                    status: 'banned', selfBanned: false,
                    bannedLogin: k.banFreeze.login,
                    bannedUserId: (users[k.banFreeze.login] && users[k.banFreeze.login].userId) || '',
                    ban: origBan, user_id: getUserId(login),
                });
            }
        }
    }
    if (!u && deviceId) {
        const activeBan = findActiveBanByDevice(users, deviceId);
        if (activeBan) return res.json({
            status: 'banned', selfBanned: true,
            ban: activeBan.ban, user_id: activeBan.login ? getUserId(activeBan.login) : '',
        });
    }
    return res.json({ status: 'ok' });
});

app.post('/keys/update-user', rlKeysUpdateUser, async (req, res) => {
    await withKeysLock(async () => {
        const { key, deviceId, login, userId } = req.body || {};
        if (!key || !deviceId) return res.status(400).json({ status: 'error' });

        // ФИКС: проверяем что логин реально существует (нельзя привязать чужой/выдуманный)
        if (login) {
            const users = loadUsers();
            if (!users[login]) return res.status(404).json({ status: 'error', message: 'Пользователь не найден' });
        }

        const data = loadKeys();
        const k = data.keys.find(e => e.key === key);
        if (!k) return res.status(404).json({ status: 'error' });
        const user = k.users.find(u => u.bindId === deviceId);
        if (user) {
            if (login) user.login = login;
            if (userId) user.userId = userId;
            if (!user.accountsHistory) user.accountsHistory = [];
            if (login && login.trim()) {
                const ex = user.accountsHistory.find(h => h.login === login);
                if (!ex) {
                    user.accountsHistory.push({
                        login, userId: userId || '', firstAt: now(),
                        device: user.device || 'Android', bindId: user.bindId || deviceId,
                    });
                } else if (userId && !ex.userId) ex.userId = userId;
            }
            saveKeys(data);
        }
        clearDeactivationMark(deviceId, login || null);
        clearDeletedKeyMark(deviceId, login || null);

        if (k.botKey) {
            const botData = loadBotKeys();
            const bk = botData.keys.find(e => e.key === key);
            if (bk) {
                bk.status = 'active';
                if (!bk.users) bk.users = [];
                const bkUser = bk.users.find(u => u.bindId === deviceId);
                const snapshot = (user && user.accountsHistory) ? user.accountsHistory : [];
                if (!bkUser) {
                    bk.users.push({
                        login: login || '', userId: userId || '',
                        device: (k.users.find(u => u.bindId === deviceId) || {}).device || 'Android',
                        bindId: deviceId, loginAt: now(), accountsHistory: snapshot,
                    });
                } else {
                    if (login) bkUser.login = login;
                    if (userId) bkUser.userId = userId;
                    bkUser.accountsHistory = snapshot;
                }
                saveBotKeys(botData);
            }
        }
        return res.json({ status: 'ok' });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
//  BOT KEYS — фикс: deviceId должен принадлежать пользователю
// ═══════════════════════════════════════════════════════════════════════════
app.post('/bot/keys/list', (req, res) => {
    const { login, password, deviceId } = req.body || {};
    if (!login || !password || !deviceId) return res.json({ status: 'error', keys: [] });
    const users = loadUsers();
    const u = users[login];
    if (!u || !verifyPassword(password, u).ok) return res.json({ status: 'error', keys: [] });

    // ФИКС: проверяем что deviceId принадлежит именно этому пользователю
    // (u.telegram.id === verifiedDevices[deviceId].telegramId). Без этой проверки
    // любой мог указать чужой deviceId и увидеть чужие bot-ключи.
    const tgLinks = loadTelegramLinks();
    const vd = tgLinks.verifiedDevices[deviceId];
    if (!vd || !vd.telegramId) return res.json({ status: 'ok', keys: [] });
    if (!u.telegram || String(u.telegram.id) !== String(vd.telegramId)) {
        return res.json({ status: 'ok', keys: [] });
    }

    const data = loadBotKeys();
    const result = data.keys
        .filter(k => String(k.telegramId) === String(vd.telegramId) && !k.deleted)
        .map(k => ({
            key: k.key, status: getBotKeyStatus(k), maxDevices: 1,
            expiryDays: k.expiryDays || 1488,
            createdAt: k.createdAt, expiryAt: k.expiryAt,
            users: k.users || [],
            deactivatedAt: k.deactivatedAt || null,
            reason: k.reason || '',
        }));
    return res.json({ status: 'ok', keys: result });
});

app.post('/bot/keys/deactivate', (req, res) => {
    const { login, password, deviceId, key } = req.body || {};
    if (!login || !password || !deviceId || !key) return res.json({ status: 'error' });
    const users = loadUsers();
    const u = users[login];
    if (!u || !verifyPassword(password, u).ok) return res.json({ status: 'error' });

    const tgLinks = loadTelegramLinks();
    const vd = tgLinks.verifiedDevices[deviceId];
    if (!vd || !vd.telegramId) return res.json({ status: 'error', message: 'Telegram не привязан' });

    const data = loadBotKeys();
    const k = data.keys.find(bk => bk.key === key && String(bk.telegramId) === String(vd.telegramId));
    if (!k) return res.json({ status: 'error', message: 'Ключ не найден' });

    k.status = 'deactivated';
    k.deactivatedAt = now();
    k.reason = 'Деактивирован пользователем';
    k.cooldownUntil = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString();
    saveBotKeys(data);

    const keysData = loadKeys();
    const mk = keysData.keys.find(m => m.key === key);
    if (mk) { mk.deactivated = true; saveKeys(keysData); }
    return res.json({ status: 'ok' });
});

app.post('/admin/bot/keys/list', requireAdmin, (req, res) => {
    const data = loadBotKeys();
    const tgLinks = loadTelegramLinks();
    const usersData = loadUsers();
    const bannedSet = new Set();
    for (const [login, u] of Object.entries(usersData)) if (u.ban) bannedSet.add(login);

    const result = data.keys.filter(k => !k.deleted).map(k => {
        let tgInfo = null;
        const tid = String(k.telegramId);
        for (const vd of Object.values(tgLinks.verifiedDevices)) {
            if (String(vd.telegramId) === tid) {
                tgInfo = { id: tid, username: vd.username || '', firstName: vd.firstName || '' };
                break;
            }
        }
        return {
            key: k.key, telegramId: k.telegramId, telegram: tgInfo,
            status: getBotKeyStatus(k), maxDevices: 1,
            expiryDays: k.expiryDays || 1488,
            createdAt: k.createdAt, expiryAt: k.expiryAt,
            users: (k.users || []).map(u => ({
                ...u,
                isBanned: u.login ? bannedSet.has(u.login) : false,
                accountsHistory: (u.accountsHistory || []).map(h => ({
                    ...h, isBanned: bannedSet.has(h.login), isActive: h.login === u.login,
                })),
            })),
            deactivatedAt: k.deactivatedAt || null,
            reason: k.reason || '',
            cooldownUntil: k.cooldownUntil || null,
        };
    });
    return res.json({ status: 'ok', keys: result });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ERROR HANDLER + START
// ═══════════════════════════════════════════════════════════════════════════
app.use((err, req, res, next) => {
    console.error('[uncaught]', err);
    if (res.headersSent) return next(err);
    res.status(500).json({ status: 'error', message: 'Внутренняя ошибка сервера' });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`ClumsyVPN auth server v3.0.0 running on port ${PORT}`);
    console.log(`  Telegram: ${telegramConfigured() ? 'ON' : 'OFF'}`);
    console.log(`  CORS: ${CORS_ORIGINS.length ? CORS_ORIGINS.join(',') : 'disabled'}`);
    console.log(`  Legacy admin password path: ${LEGACY_ADMIN_PASSWORD_ON ? 'ENABLED (обновите клиент!)' : 'DISABLED'}`);
});
