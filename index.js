const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const app      = express();
const PORT     = process.env.PORT || 3000;
const DB_FILE  = path.join(__dirname, 'users.json');
const STATE_FILE = path.join(__dirname, 'app_state.json');
const REPORTS_FILE = path.join(__dirname, 'reports.json');
const PERM_BANS_FILE = path.join(__dirname, 'perm_bans.json');
const RANK_POSTS_FILE = path.join(__dirname, 'rank_posts.json');
const RANK_MUTES_FILE = path.join(__dirname, 'rank_mutes.json');

app.use(cors());
app.use(express.json());

// ════════════════════════════════════════════════════════════════
//  TELEGRAM — настройки бота / приватной группы
//  Вставьте сюда токен вашего бота (из @BotFather) и его username
//  (без @, нужен для deep-link "Перейти в Telegram-бота").
//  Можно также задать через переменные окружения TELEGRAM_BOT_TOKEN /
//  TELEGRAM_BOT_USERNAME — это безопаснее, чем хранить токен в коде.
// ════════════════════════════════════════════════════════════════
const TELEGRAM_BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN    || '8606129255:AAHsJI_AGFUQ910I7WQTxLJwAexVieDkAjI';
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'oxide_clumsy_2026_bot';
const TELEGRAM_GROUP_ID = process.env.TELEGRAM_GROUP_ID || -1003756285081;
const TELEGRAM_GROUP_LINK = 'https://t.me/+Tu7sw6yGV_c5YzY6';
const TELEGRAM_PURCHASE_CONTACT    = '@oxide_clumsy_admin';
const TELEGRAM_PRICE_TEXT          = '100 Stars или 150 грн';
const TELEGRAM_TOKEN_TTL_MS        = 15 * 60 * 1000; // токен живёт 15 минут с момента выдачи
// Часовой пояс пользователей бота, используется только для отображения
// времени "до HH:MM" в сообщениях. Сервер обычно работает в UTC, а
// пользователи — в UTC+3 (Украина летом / большая часть года). Если сервер
// уже настроен в нужном поясе через переменную окружения TZ, можно явно
// выставить TELEGRAM_DISPLAY_TZ_OFFSET_MIN=0.
const TELEGRAM_DISPLAY_TZ_OFFSET_MIN = process.env.TELEGRAM_DISPLAY_TZ_OFFSET_MIN
    ? parseInt(process.env.TELEGRAM_DISPLAY_TZ_OFFSET_MIN, 10)
    : 180; // UTC+3
const TELEGRAM_LINKS_FILE          = path.join(__dirname, 'telegram_links.json');

function telegramConfigured() {
    return !!TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_TOKEN.indexOf('ВСТАВЬТЕ') !== 0;
}

// Username нужен отдельно от токена — он используется только для
// deep-link "https://t.me/<username>?start=...". Если токен бота уже
// вставлен, а username — ещё нет (или наоборот), считаем, что бот для
// клиента НЕ настроен, чтобы приложение не строило битую ссылку на
// telegram.org вместо реального чата с ботом (именно это и было багом).
function telegramUsernameConfigured() {
    return !!TELEGRAM_BOT_USERNAME && TELEGRAM_BOT_USERNAME.indexOf('ВСТАВЬТЕ') !== 0;
}

function telegramFullyConfigured() {
    return telegramConfigured() && telegramUsernameConfigured();
}

// ---- Admin credentials ----
const ADMIN_LOGIN    = 'admin';
const ADMIN_PASSWORD = 'Adm!nX9#kP2$mQ7@vL4&nR1^wT8*zY5';
const ADMIN_ID       = '#00000001';

// ---- helpers ----

function loadUsers() {
    if (!fs.existsSync(DB_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
    catch (e) { return {}; }
}

function saveUsers(users) {
    fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function loadState() {
    const defaults = {
        appDisabled: false,
        peakOnline: 0,
        onlineSessions: {}
    };
    if (!fs.existsSync(STATE_FILE)) return defaults;
    try {
        const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return Object.assign(defaults, s);
    } catch (e) { return defaults; }
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ---- Reports storage ----
// Permanent bans by login (survives account deletion/recreation)
function loadPermBans() {
    if (!fs.existsSync(PERM_BANS_FILE)) return { logins: [], deviceIds: [] };
    try { return JSON.parse(fs.readFileSync(PERM_BANS_FILE, 'utf8')); }
    catch (e) { return { logins: [], deviceIds: [] }; }
}

function savePermBans(data) {
    fs.writeFileSync(PERM_BANS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

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

function loadReports() {
    if (!fs.existsSync(REPORTS_FILE)) return { reports: [], reporterLimits: {} };
    try { return JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8')); }
    catch (e) { return { reports: [], reporterLimits: {} }; }
}

function saveReports(data) {
    fs.writeFileSync(REPORTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function now() {
    return new Date().toISOString();
}

// ---- Rank Share helpers ----
function loadRankPosts() {
    if (!fs.existsSync(RANK_POSTS_FILE)) return { posts: [] };
    try { return JSON.parse(fs.readFileSync(RANK_POSTS_FILE, 'utf8')); }
    catch (e) { return { posts: [] }; }
}

function saveRankPosts(data) {
    fs.writeFileSync(RANK_POSTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function loadRankMutes() {
    if (!fs.existsSync(RANK_MUTES_FILE)) return { mutes: {} };
    try { return JSON.parse(fs.readFileSync(RANK_MUTES_FILE, 'utf8')); }
    catch (e) { return { mutes: {} }; }
}

function saveRankMutes(data) {
    fs.writeFileSync(RANK_MUTES_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getUserId(login) {
    let hash = 0;
    for (const c of login) {
        hash = Math.imul(hash, 31) + c.charCodeAt(0) | 0;
    }
    return '#' + ((Math.abs(hash) * 9973 + 100000) % 100000000 + 10000000);
}

function isAdmin(login) {
    return login === ADMIN_LOGIN;
}

// Check if a device (by fingerprint/IP) has a permanent ban
function deviceHasPermBan(users, deviceId) {
    if (!deviceId) return false;
    for (const u of Object.values(users)) {
        if (u.deviceId === deviceId && u.ban && u.ban.until === 'permanent') {
            return true;
        }
    }
    return false;
}

// Ищет любой ДЕЙСТВУЮЩИЙ (временный или постоянный) бан среди всех аккаунтов,
// привязанных к этому deviceId. Используется чтобы не дать забаненному человеку
// зарегистрировать НОВЫЙ аккаунт с того же устройства, пока бан не истёк/не снят —
// независимо от того, под каким логином он был забанен.
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

// ---- Cleanup inactive accounts (every 24h) ----
const FOUR_MONTHS_MS = 120 * 24 * 60 * 60 * 1000;

function cleanupInactiveAccounts() {
    const users = loadUsers();
    const cutoff = Date.now() - FOUR_MONTHS_MS;
    let changed = false;

    for (const login of Object.keys(users)) {
        const user = users[login];
        const lastActivity = user.last_login || user.created_at;
        if (!lastActivity || new Date(lastActivity).getTime() < cutoff) {
            console.log(`[cleanup] Deleting inactive account: ${login}`);
            delete users[login];
            changed = true;
        }
    }

    if (changed) saveUsers(users);
}

cleanupInactiveAccounts();
setInterval(cleanupInactiveAccounts, 24 * 60 * 60 * 1000);

// Cleanup expired bans/mutes periodically
function cleanupExpiredPunishments() {
    const users = loadUsers();
    const nowMs = Date.now();
    let changed = false;

    for (const login of Object.keys(users)) {
        const user = users[login];
        // Unban only if TEMPORARY ban expired (permanent stays)
        if (user.ban && user.ban.until && user.ban.until !== 'permanent') {
            if (new Date(user.ban.until).getTime() < nowMs) {
                delete user.ban;
                changed = true;
                // ВАЖНО: ключ НЕ восстанавливаем здесь. По истечении срока бана
                // снимается только сама метка бана у пользователя (он снова
                // может, например, писать в чат/репорты), но замороженный
                // ключ (k.banFreeze) должен оставаться замороженным и
                // вернуться пользователю только после РУЧНОГО разбана
                // администратором через /admin/unban — это осознанное решение,
                // а не баг: истечение таймера само по себе не должно возвращать
                // доступ к ключу.
            }
        }
        // Unmute if mute expired
        if (user.mute && user.mute.until) {
            if (new Date(user.mute.until).getTime() < nowMs) {
                delete user.mute;
                changed = true;
            }
        }
    }

    if (changed) saveUsers(users);
}

setInterval(cleanupExpiredPunishments, 60 * 1000);

// ---- Online tracking ----
const HEARTBEAT_TIMEOUT = 35000;

function getOnlineCount(state) {
    const nowMs = Date.now();
    const sessions = state.onlineSessions || {};
    let count = 0;
    for (const k of Object.keys(sessions)) {
        if (nowMs - sessions[k] < HEARTBEAT_TIMEOUT) count++;
    }
    return count;
}

function recordHeartbeat(login, state) {
    if (!state.onlineSessions) state.onlineSessions = {};
    state.onlineSessions[login] = Date.now();
    const online = getOnlineCount(state);
    if (online > (state.peakOnline || 0)) {
        state.peakOnline = online;
    }
    saveState(state);
}

// ════════════════════════════════════════════════════════════════
//  TELEGRAM — хранилище токенов привязки / верифицированных устройств
// ════════════════════════════════════════════════════════════════
//
// Структура telegram_links.json:
//   tokens:          { "<token>": {
//                         telegramId, username, firstName,
//                         pendingDeviceId,   // deviceId из deep-link /start, если был
//                         createdAt, expiresAt,
//                         used, usedDeviceId, usedAt
//                     } }
//   verifiedDevices: { "<deviceId>": { telegramId, username, firstName, verifiedAt } }
//   pendingByChat:   { "<chatId>":   { telegramId, username, firstName, deviceId, startedAt } }
//                     — временное состояние диалога с ботом между /start и нажатием кнопки.

function loadTelegramLinks() {
    let data = { tokens: {}, verifiedDevices: {}, pendingByChat: {} };
    if (fs.existsSync(TELEGRAM_LINKS_FILE)) {
        try { data = JSON.parse(fs.readFileSync(TELEGRAM_LINKS_FILE, 'utf8')); }
        catch (e) { /* оставляем дефолт */ }
    }
    if (!data.tokens) data.tokens = {};
    if (!data.verifiedDevices) data.verifiedDevices = {};
    if (!data.pendingByChat) data.pendingByChat = {};
    return data;
}

function saveTelegramLinks(data) {
    fs.writeFileSync(TELEGRAM_LINKS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Криптографически случайный токен: 24 байта = 192 бита энтропии в hex-виде
// (48 символов). Подобрать или угадать такой токен перебором невозможно.
function generateLinkToken() {
    return crypto.randomBytes(24).toString('hex');
}

function isTokenExpired(rec) {
    if (!rec || !rec.expiresAt) return true;
    return new Date(rec.expiresAt).getTime() < Date.now();
}

// Раз в час подчищаем протухшие неиспользованные токены, чтобы файл не рос бесконечно.
function cleanupExpiredTelegramTokens() {
    const data = loadTelegramLinks();
    let changed = false;
    for (const t of Object.keys(data.tokens)) {
        const rec = data.tokens[t];
        if (!rec.used && isTokenExpired(rec)) {
            delete data.tokens[t];
            changed = true;
        }
    }
    if (changed) saveTelegramLinks(data);
}
setInterval(cleanupExpiredTelegramTokens, 60 * 60 * 1000);

// ---- низкоуровневый вызов Telegram Bot API ----
async function tgApi(method, params) {
    if (!telegramConfigured()) return null;
    try {
        const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params || {})
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

// ---- обработка /start ----
async function handleTelegramStart(message) {
    const chatId = message.chat.id;
    const from   = message.from || {};
    // Если пользователь пришёл по deep-link из приложения — в тексте будет
    // "/start <deviceId>". Это позволяет автоматически подхватить токен в
    // приложении без ручного копирования (но ручной ввод тоже работает).
    const parts   = message.text.split(' ');
    const payload = parts.length > 1 ? parts[1].trim() : '';

    const links = loadTelegramLinks();
    links.pendingByChat[String(chatId)] = {
        telegramId: from.id,
        username: from.username || '',
        firstName: from.first_name || '',
        deviceId: payload || null,
        startedAt: now()
    };
    saveTelegramLinks(links);

    const name = from.first_name || from.username || 'друг';
    // Раньше это были два отдельных сообщения: сначала приветствие с
    // inline-кнопкой, потом текст с описанием возможностей и persistent-
    // клавиатурой. Telegram не позволяет прикрепить inline_keyboard и
    // обычную (persistent) keyboard к одному и тому же сообщению, поэтому
    // вместо inline-кнопки используем persistent-клавиатуру с тем же
    // пунктом — это даёт ОДНО сообщение и обе кнопки доступны как и раньше
    // («Проверить подписку…» и «Получить токен снова» внизу экрана).
    await tgSend(chatId,
        `Здравствуйте, ${name}! 👋 Добро пожаловать в Telegram-бот <b>Oxide Clumsy</b>.\n\n` +
        '✨ <b>Здесь ты можешь:</b>\n' +
        '🔑 Получить токен для регистрации в приложении.\n' +
        '🛡 Быстро пройти проверку и активировать свой аккаунт.\n' +
        '🎁 Получить ключ доступа автоматически через бота.\n\n' +
        '👇 <i>Для начала пройди проверку подписки — это откроет все функции.</i>',
        {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: '✅ Проверить подписку на приватную группу' }],
                    [{ text: '🔄 Получить токен снова' }],
                    [{ text: '🔑 Получить ключ' }, { text: '📄 Информация о ключе' }]
                ],
                resize_keyboard: true,
                persistent: true
            }
        }
    );
}

// Ищет действующий (не использованный и не истёкший) токен для данного
// Telegram-пользователя. Возвращает { tokenStr, rec } или null.
function findActiveTokenForUser(links, telegramId) {
    for (const tokenStr of Object.keys(links.tokens)) {
        const rec = links.tokens[tokenStr];
        if (String(rec.telegramId) !== String(telegramId)) continue;
        if (rec.used)              continue;
        if (isTokenExpired(rec))   continue;
        return { tokenStr, rec };
    }
    return null;
}

// Ищет уже ИСПОЛЬЗОВАННЫЙ (привязанный к устройству) токен данного
// Telegram-пользователя — то есть случай, когда пользователь уже успешно
// ввёл токен в приложении и продолжает им пользоваться. В этом случае
// новый токен выдавать нельзя.
//
// currentDeviceId — deviceId текущего запроса, если он известен (пользователь
// пришёл по deep-link "/start <deviceId>" из приложения). Если он отличается
// от deviceId, на который привязан существующий токен, считаем, что человек
// переустановил приложение (новое устройство = новый Android ID) — тогда
// старая привязка не блокирует выдачу нового токена.
function findBoundTokenForUser(links, telegramId, currentDeviceId) {
    let best = null;
    for (const tokenStr of Object.keys(links.tokens)) {
        const rec = links.tokens[tokenStr];
        if (String(rec.telegramId) !== String(telegramId)) continue;
        if (!rec.used) continue;
        if (currentDeviceId && rec.usedDeviceId && currentDeviceId !== rec.usedDeviceId) continue;
        if (!best || rec.usedAt > best.rec.usedAt) {
            best = { tokenStr, rec };
        }
    }
    return best;
}

// Форматирует момент времени (Date) как "HH:MM" в часовом поясе пользователя
// (TELEGRAM_DISPLAY_TZ_OFFSET_MIN), а не в локальном поясе сервера. Это важно,
// потому что сервер может работать в UTC, а пользователи смотрят на часы в
// своём поясе — без этого время "до ..." в сообщениях не совпадает с реальным
// временем на устройстве пользователя.
function formatTimeInDisplayTz(date) {
    const shifted = new Date(date.getTime() + TELEGRAM_DISPLAY_TZ_OFFSET_MIN * 60 * 1000);
    const hh = String(shifted.getUTCHours()).padStart(2, '0');
    const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
    return hh + ':' + mm;
}

// Форматирует оставшееся время жизни токена в виде "MM:SS" или "X мин Y сек"
function formatTokenTimeLeft(rec) {
    const msLeft = new Date(rec.expiresAt).getTime() - Date.now();
    if (msLeft <= 0) return '0 сек';
    const totalSec = Math.ceil(msLeft / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    if (mins > 0) return mins + ' мин ' + secs + ' сек';
    return secs + ' сек';
}

// ---- обработка нажатия кнопки "Проверить подписку" ----
async function handleTelegramCallback(cq) {
    await tgApi('answerCallbackQuery', { callback_query_id: cq.id });
    if (cq.data !== 'check_sub') return;

    const chatId = cq.message.chat.id;
    const from   = cq.from || {};

    const member = await tgApi('getChatMember', { chat_id: TELEGRAM_GROUP_ID, user_id: from.id });
    const memberOk = member && ['member', 'administrator', 'creator'].indexOf(member.status) !== -1;

    if (!memberOk) {
        await tgSend(chatId,
            `К сожалению, вы не являетесь участником приватной группы. Это означает, что вы не приобретали Oxide Clumsy. ` +
            `Приобрести приложение можно у ${TELEGRAM_PURCHASE_CONTACT}. Текущая стоимость — ${TELEGRAM_PRICE_TEXT}.`
        );
        return;
    }

    const links   = loadTelegramLinks();
    const pending = links.pendingByChat[String(chatId)] || {};

    // Проверяем: может, у пользователя уже есть действующий токен?
    const existing = findActiveTokenForUser(links, from.id);
    if (existing) {
        const timeLeft = formatTokenTimeLeft(existing.rec);
        const expiresDate = new Date(existing.rec.expiresAt);
        const expiresHHMM = formatTimeInDisplayTz(expiresDate);
        await tgSend(chatId,
            '♻️ <b>У вас уже есть действующий токен!</b>\n\n' +
            '➖➖➖➖➖➖➖➖\n\n' +
            '🔑 <b>Ваш токен:</b>\n\n' +
            '<code>' + existing.tokenStr + '</code>\n\n' +
            '➖➖➖➖➖➖➖➖\n\n' +
            '⏱ Ещё действителен <b>' + timeLeft + '</b> (до ' + expiresHHMM + ').\n' +
            'Введите его в приложении. Новый токен можно получить только после истечения текущего.',
            { parse_mode: 'HTML' }
        );
        return;
    }

    // Проверяем: может, у пользователя уже есть ПРИВЯЗАННЫЙ (использованный)
    // токен, которым он сейчас пользуется в приложении? Если да — новый
    // токен не выдаём, пока он не истёк по таймауту или приложение не было
    // переустановлено (новый deviceId из deep-link).
    const bound = findBoundTokenForUser(links, from.id, pending.deviceId || null);
    if (bound) {
        await tgSend(chatId,
            '⚠️ <b>Упс!... Ошибочка.</b>\n\n' +
            'У вас уже есть привязанный токен.\n\n' +
            '➖➖➖➖➖➖➖➖\n\n' +
            '🔑 <b>Текущий токен:</b>\n\n' +
            '<code>' + bound.tokenStr + '</code>\n\n' +
            '➖➖➖➖➖➖➖➖\n\n' +
            'Вы не можете получить новый токен, пока используете уже активный токен.',
            { parse_mode: 'HTML' }
        );
        return;
    }

    const token   = generateLinkToken();

    links.tokens[token] = {
        telegramId: from.id,
        username: from.username || '',
        firstName: from.first_name || '',
        pendingDeviceId: pending.deviceId || null,
        createdAt: now(),
        expiresAt: new Date(Date.now() + TELEGRAM_TOKEN_TTL_MS).toISOString(),
        used: false,
        usedDeviceId: null,
        usedAt: null
    };
    saveTelegramLinks(links);

    const expiresDate = new Date(Date.now() + TELEGRAM_TOKEN_TTL_MS);
    const expiresHHMM = formatTimeInDisplayTz(expiresDate);

    await tgSend(chatId,
        '✅ <b>Успешно!</b> Вы являетесь участником приватной группы.\n\n' +
        '➖➖➖➖➖➖➖➖\n\n' +
        '🔑 <b>Ваш токен для привязки Telegram-бота к приложению:</b>\n\n' +
        '<code>' + token + '</code>\n\n' +
        '➖➖➖➖➖➖➖➖\n\n' +
        '⏱ Введите токен в приложении в течение <b>15 минут</b> (до ' + expiresHHMM + ').\n' +
        'Не успели? Нажмите кнопку <b>🔄 Получить токен снова</b> внизу экрана.',
        { parse_mode: 'HTML' }
    );

    await tgSend(chatId,
        '⚠️ <b>Никому не сообщайте этот токен.</b> Не передавайте его друзьям, знакомым или третьим лицам.',
        { parse_mode: 'HTML' }
    );
}

async function handleTelegramUpdate(upd) {
    if (upd.message && typeof upd.message.text === 'string') {
        const text = upd.message.text.trim();
        if (text.indexOf('/start') === 0) {
            await handleTelegramStart(upd.message);
        } else if (
            text === '✅ Проверить подписку на приватную группу' ||
            text === 'Проверить подписку на приватную группу' ||
            text === '🔄 Получить токен снова'
        ) {
            await handleGetTokenAgain(upd.message);
        } else if (text === '🔑 Получить ключ') {
            await handleGetBotKey(upd.message);
        } else if (text === '📄 Информация о ключе') {
            await handleBotKeyInfo(upd.message);
        }
    } else if (upd.callback_query) {
        await handleTelegramCallback(upd.callback_query);
    }
}

// Повторная выдача токена по кнопке "Получить токен снова".
// Логика: заново проверить подписку → выдать свежий токен.
async function handleGetTokenAgain(message) {
    const chatId = message.chat.id;
    const from   = message.from || {};

    await tgSend(chatId, '🔄 Проверяем вашу подписку…');

    const member = await tgApi('getChatMember', { chat_id: TELEGRAM_GROUP_ID, user_id: from.id });
    const memberOk = member && ['member', 'administrator', 'creator'].indexOf(member.status) !== -1;

    if (!memberOk) {
        await tgSend(chatId,
            `❌ К сожалению, вы не являетесь участником приватной группы.\n` +
            `Это означает, что вы не приобретали Oxide Clumsy.\n` +
            `Приобрести приложение можно у ${TELEGRAM_PURCHASE_CONTACT}. Текущая стоимость — ${TELEGRAM_PRICE_TEXT}.`
        );
        return;
    }

    const links2  = loadTelegramLinks();
    const pending = links2.pendingByChat[String(chatId)] || {};

    // Проверяем: есть ли уже действующий токен?
    const existing2 = findActiveTokenForUser(links2, from.id);
    if (existing2) {
        const timeLeft2 = formatTokenTimeLeft(existing2.rec);
        const expiresDate2 = new Date(existing2.rec.expiresAt);
        const expiresHHMM2 = formatTimeInDisplayTz(expiresDate2);
        await tgSend(chatId,
            '♻️ <b>У вас уже есть действующий токен!</b>\n\n' +
            '➖➖➖➖➖➖➖➖\n\n' +
            '🔑 <b>Ваш токен:</b>\n\n' +
            '<code>' + existing2.tokenStr + '</code>\n\n' +
            '➖➖➖➖➖➖➖➖\n\n' +
            '⏱ Ещё действителен <b>' + timeLeft2 + '</b> (до ' + expiresHHMM2 + ').\n' +
            'Введите его в приложении. Новый токен можно получить только после истечения текущего.',
            { parse_mode: 'HTML' }
        );
        return;
    }

    // Проверяем: может, у пользователя уже есть ПРИВЯЗАННЫЙ (использованный)
    // токен, которым он сейчас пользуется в приложении?
    const bound2 = findBoundTokenForUser(links2, from.id, pending.deviceId || null);
    if (bound2) {
        await tgSend(chatId,
            '⚠️ <b>Упс!... Ошибочка.</b>\n\n' +
            'У вас уже есть привязанный токен.\n\n' +
            '➖➖➖➖➖➖➖➖\n\n' +
            '🔑 <b>Текущий токен:</b>\n\n' +
            '<code>' + bound2.tokenStr + '</code>\n\n' +
            '➖➖➖➖➖➖➖➖\n\n' +
            'Вы не можете получить новый токен, пока используете уже активный токен.',
            { parse_mode: 'HTML' }
        );
        return;
    }

    const token   = generateLinkToken();

    links2.tokens[token] = {
        telegramId: from.id,
        username:   from.username  || '',
        firstName:  from.first_name || '',
        pendingDeviceId: pending.deviceId || null,
        createdAt:  now(),
        expiresAt:  new Date(Date.now() + TELEGRAM_TOKEN_TTL_MS).toISOString(),
        used:        false,
        usedDeviceId: null,
        usedAt:      null
    };
    saveTelegramLinks(links2);

    const expiresDate = new Date(Date.now() + TELEGRAM_TOKEN_TTL_MS);
    const expiresHHMM = formatTimeInDisplayTz(expiresDate);

    await tgSend(chatId,
        '✅ <b>Подписка подтверждена!</b> Вот ваш новый токен:\n\n' +
        '➖➖➖➖➖➖➖➖\n\n' +
        '🔑 <b>Токен для привязки приложения:</b>\n\n' +
        '<code>' + token + '</code>\n\n' +
        '➖➖➖➖➖➖➖➖\n\n' +
        '⏱ Введите токен в приложении в течение <b>15 минут</b> (до ' + expiresHHMM + ').',
        { parse_mode: 'HTML' }
    );

    await tgSend(chatId,
        '⚠️ <b>Никому не сообщайте этот токен.</b> Не передавайте его друзьям, знакомым или третьим лицам.',
        { parse_mode: 'HTML' }
    );
}

// ── Проверяет, прошёл ли пользователь верификацию (есть ли verifiedDevice) ──
function isTelegramUserVerified(chatId, from) {
    const links = loadTelegramLinks();
    // Проверяем по telegramId в verifiedDevices
    const tid = String(from.id);
    for (const vd of Object.values(links.verifiedDevices)) {
        if (String(vd.telegramId) === tid) return true;
    }
    // Или если у него есть использованный токен
    for (const rec of Object.values(links.tokens)) {
        if (String(rec.telegramId) === tid && rec.used) return true;
    }
    return false;
}

// ── Сообщение «сначала пройди верификацию» ──
async function sendNeedVerification(chatId) {
    await tgSend(chatId,
        '⚠️ <b>Сначала необходимо выполнить получение токена.</b>\n\n' +
        'Нажмите кнопку:\n\n' +
        '✅ <b>Проверить подписку на приватную группу</b>\n\n' +
        '<i>После успешной проверки станут доступны остальные функции.</i>',
        { parse_mode: 'HTML' }
    );
}

// ── 🔑 Получить ключ ──────────────────────────────────────────────────────────
async function handleGetBotKey(message) {
    const chatId = message.chat.id;
    const from   = message.from || {};
    const tid    = String(from.id);

    // Шаг 1: проверить верификацию
    if (!isTelegramUserVerified(chatId, from)) {
        await sendNeedVerification(chatId);
        return;
    }

    // Шаг 2: проверить подписку на группу
    const member = await tgApi('getChatMember', { chat_id: TELEGRAM_GROUP_ID, user_id: from.id });
    const memberOk = member && ['member', 'administrator', 'creator'].indexOf(member.status) !== -1;
    if (!memberOk) {
        await tgSend(chatId,
            '❌ <b>Вы не являетесь участником приватной группы.</b>\n\n' +
            `Приобрести приложение можно у ${TELEGRAM_PURCHASE_CONTACT}.\n` +
            `Текущая стоимость — ${TELEGRAM_PRICE_TEXT}.`,
            { parse_mode: 'HTML' }
        );
        return;
    }

    const data = loadBotKeys();
    const existing = data.keys.find(k => String(k.telegramId) === tid && !k.deleted);
    // Загружаем основную систему ключей сразу — понадобится и для пометки
    // "заменён новым ключом" ниже (случай бана), и для создания нового ключа.
    const keysData = loadKeys();

    if (existing) {
        const st = getBotKeyStatus(existing);

        // Ключ деактивирован или заблокирован — кулдаун 10 часов
        if (st === 'deactivated' || st === 'blocked') {
            const word = st === 'blocked' ? 'заблокирован' : 'деактивирован';
            const cooldownUntil = existing.cooldownUntil ? new Date(existing.cooldownUntil) : null;
            const nowMs = Date.now();
            if (cooldownUntil && cooldownUntil.getTime() > nowMs) {
                const msLeft = cooldownUntil.getTime() - nowMs;
                const hoursLeft = Math.ceil(msLeft / (60 * 60 * 1000));
                await tgSend(chatId,
                    `⚠️ <b>Ваш ключ был ${word}.</b>\n\n` +
                    '📄 <b>Причина:</b>\n' +
                    `<i>${existing.reason || 'Не указана'}</i>\n\n` +
                    `🕒 Получить новый ключ можно будет через <b>${hoursLeft} ч.</b>\n\n` +
                    '<i>До окончания этого времени создать новый ключ невозможно.</i>',
                    { parse_mode: 'HTML' }
                );
                return;
            }
            // Кулдаун прошёл — удаляем старый и создаём новый.
            // Примечание: если этот ключ был заморожен из-за бана (banFreeze),
            // отдельную пометку здесь ставить не нужно — restoreKeyAfterUnban
            // при последующем ручном разбане сам проверит, не появился ли у
            // пользователя тем временем другой активный ключ, и не восстановит
            // старый, если да.
            existing.deleted = true;
        } else if (st === 'expired') {
            // Срок истёк — удаляем и даём получить новый
            existing.deleted = true;
        } else {
            // Ключ активен/неактивен — новый не даём
            await tgSend(chatId,
                '⚠️ <b>У вас уже есть ключ.</b>\n\n' +
                '🔑 <b>Ваш ключ:</b>\n' +
                '<code>' + existing.key + '</code>\n\n' +
                '📊 <b>Статус:</b> ' + (st === 'active' ? '✅ Активен' : '⏳ Не активирован') + '\n\n' +
                '<i>Получить новый ключ можно только после истечения срока действия, ' +
                'деактивации или удаления текущего.</i>',
                { parse_mode: 'HTML' }
            );
            return;
        }
    }

    // Создаём новый бот-ключ
    let keyValue;
    let attempts = 0;
    do {
        keyValue = generateKey();
        attempts++;
    } while (
        (keysData.keys.find(k => k.key === keyValue) ||
         data.keys.find(k => k.key === keyValue)) && attempts < 100
    );

    const EXPIRY_DAYS = 1488;
    const expiryAt = new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const createdAt = now();

    const newBotKey = {
        key: keyValue,
        telegramId: from.id,
        createdAt,
        expiryDays: EXPIRY_DAYS,
        expiryAt,
        status: 'inactive',
        users: [],
        deleted: false
    };
    data.keys.push(newBotKey);
    saveBotKeys(data);

    // Также добавляем ключ в основную систему ключей чтобы он работал при входе
    const newMainKey = {
        key: keyValue,
        createdAt,
        maxDevices: 1,
        expiryDays: EXPIRY_DAYS,
        expiryMinutes: 0,
        expiryAt,
        users: [],
        botKey: true  // метка что ключ выдан ботом
    };
    keysData.keys.push(newMainKey);
    saveKeys(keysData);

    await tgSend(chatId,
        '✅ <b>Ключ успешно создан!</b>\n\n' +
        '➖➖➖➖➖➖➖➖\n\n' +
        '📱 <b>Устройств:</b> 1\n' +
        `📅 <b>Срок действия:</b> ${EXPIRY_DAYS} дней\n` +
        `🕒 <b>Создан:</b> ${formatBotDate(createdAt)}\n\n` +
        '➖➖➖➖➖➖➖➖\n\n' +
        '🔑 <b>Ваш ключ:</b>\n\n' +
        '<code>' + keyValue + '</code>\n\n' +
        '➖➖➖➖➖➖➖➖\n\n' +
        '<i>Введите ключ в приложении Oxide Clumsy для активации.</i>',
        { parse_mode: 'HTML' }
    );
}

// ── 📄 Информация о ключе ────────────────────────────────────────────────────
async function handleBotKeyInfo(message) {
    const chatId = message.chat.id;
    const from   = message.from || {};
    const tid    = String(from.id);

    if (!isTelegramUserVerified(chatId, from)) {
        await sendNeedVerification(chatId);
        return;
    }

    const data = loadBotKeys();
    const k = data.keys.find(bk => String(bk.telegramId) === tid && !bk.deleted);

    if (!k) {
        // Нет ключа или он был удалён
        const deleted = data.keys.find(bk => String(bk.telegramId) === tid && bk.deleted);
        if (deleted) {
            await tgSend(chatId,
                '🗑️ <b>Ваш ключ был удалён.</b>\n\n' +
                'Получите новый ключ, нажав кнопку <b>🔑 Получить ключ</b>.',
                { parse_mode: 'HTML' }
            );
        } else {
            await tgSend(chatId,
                '📄 <b>Информация о ключе</b>\n\n' +
                '❌ <b>У вас ещё нет ключа.</b>\n\n' +
                'Нажмите <b>🔑 Получить ключ</b> чтобы получить его автоматически.',
                { parse_mode: 'HTML' }
            );
        }
        return;
    }

    const st = getBotKeyStatus(k);

    // Статус текстом
    const statusMap = {
        'active': '✅ Активен',
        'inactive': '⏳ Не активирован',
        'deactivated': '❌ Деактивирован',
        'blocked': '🧊 Заблокирован',
        'expired': '⌛ Истёк'
    };
    const statusText = statusMap[st] || st;

    // Информация о пользователе
    let userInfo = '';
    if (k.users && k.users.length > 0) {
        const u = k.users[0];
        userInfo =
            '\n➖➖➖➖➖➖➖➖\n\n' +
            '👤 <b>Информация о пользователе:</b>\n\n' +
            (u.login   ? `🔹 Логин: <code>${u.login}</code>\n`  : '') +
            (u.device  ? `📱 Устройство: ${u.device}\n`        : '') +
            (u.loginAt ? `🕒 Вошёл: ${formatBotDate(u.loginAt)}\n` : '');
    } else {
        userInfo = '\n➖➖➖➖➖➖➖➖\n\n' +
            '👤 <b>Информация о пользователе:</b> нет.\n';
    }

    // Статус ключа (подробный) — показываем независимо от того, остался ли
    // в записи "снимок" пользователя (bk.users не очищается при деактивации/
    // бане администратором, только status), иначе текст ниже ключа не
    // появлялся для уже деактивированных/заблокированных ключей.
    let keyStatusDetail = '';
    if (st === 'deactivated') {
        keyStatusDetail = '\n❌ Ключ деактивирован, срок ключа истёк.';
    } else if (st === 'blocked') {
        keyStatusDetail = '\n🧊 Ключ заблокирован из-за бана пользователя.';
    } else if (st === 'expired') {
        keyStatusDetail = '\n⌛ Срок ключа истёк.';
    } else if (st === 'active' || st === 'inactive') {
        if (k.users && k.users.length === 0) {
            keyStatusDetail = '\n⚠️ Ещё никто не зашёл.';
        } else if (k.expiryAt) {
            const msLeft = new Date(k.expiryAt).getTime() - Date.now();
            if (msLeft > 0) {
                const daysLeft = Math.floor(msLeft / (24 * 60 * 60 * 1000));
                const hoursLeft = Math.floor((msLeft % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
                keyStatusDetail = `\n⏳ <b>Осталось:</b> ${daysLeft > 0 ? daysLeft + ' дн. ' : ''}${hoursLeft} ч.`;
            }
        }
    }

    await tgSend(chatId,
        '📄 <b>Информация о ключе</b>\n\n' +
        '➖➖➖➖➖➖➖➖\n\n' +
        `📊 <b>Статус:</b> ${statusText}\n` +
        '📱 <b>Устройств:</b> 1\n' +
        `📅 <b>Срок действия:</b> ${k.expiryDays || 1488} дней\n` +
        `🕒 <b>Создан:</b> ${formatBotDate(k.createdAt)}` +
        userInfo +
        '➖➖➖➖➖➖➖➖\n\n' +
        '🔑 <b>Ключ:</b>\n<code>' + k.key + '</code>' +
        keyStatusDetail,
        { parse_mode: 'HTML' }
    );
}

// ---- long polling getUpdates (без сторонних библиотек и без вебхука) ----
let tgOffset = 0;
let tgPollingActive = false;

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
        try { await tgPollOnce(); }
        catch (e) { console.error('[telegram] poll error:', e.message); }
        await new Promise(r => setTimeout(r, 400));
    }
    tgPollingActive = false;
}

if (telegramConfigured()) {
    tgApi('deleteWebhook', {}).then(() => tgPollLoop());
    console.log('[telegram] бот запущен, long-polling активен');
    if (!telegramUsernameConfigured()) {
        console.log('[telegram] ВНИМАНИЕ: TELEGRAM_BOT_USERNAME не задан (или оставлен плейсхолдером). ' +
                    'Бот будет работать, но кнопка "Перейти в Telegram-бота" в приложении не сможет ' +
                    'построить рабочую ссылку — клиент покажет "Бот ещё не настроен". Укажите username бота (без @).');
    }
} else {
    console.log('[telegram] TELEGRAM_BOT_TOKEN не задан — модуль привязки Telegram отключён ' +
                '(регистрация/вход будут работать БЕЗ проверки Telegram, пока токен не указан).');
}

// ---- routes ----

// POST /heartbeat
app.post('/heartbeat', (req, res) => {
    const { login } = req.body || {};
    if (!login) return res.json({ status: 'ok' });
    const state = loadState();
    recordHeartbeat(login, state);
    return res.json({ status: 'ok', appDisabled: state.appDisabled || false });
});

// POST /pre-check — быстрая проверка перед показом KeyInputDialog.
// Проверяет: бан устройства, перм-бан, занятость логина.
// Ключ НЕ трогается — это только валидация данных регистрации.
app.post('/pre-check', (req, res) => {
    const { login, deviceId } = req.body || {};
    if (!login) return res.status(400).json({ status: 'error', message: 'Нет логина' });

    if (login === ADMIN_LOGIN) {
        return res.status(409).json({ status: 'already_exists', message: 'Логин уже занят' });
    }

    if (isPermBanned(login, deviceId)) {
        return res.status(403).json({
            status: 'perm_banned',
            message: 'У вас постоянный бан. Регистрация новых аккаунтов недоступна.'
        });
    }

    cleanupExpiredPunishments();
    const users = loadUsers();
    const activeDeviceBan = findActiveBanByDevice(users, deviceId);
    if (activeDeviceBan) {
        return res.status(403).json({
            status: 'device_banned',
            ban: activeDeviceBan.ban,
            message: 'У вас есть активный бан. Создавать новые аккаунты запрещено.'
        });
    }

    if (users[login]) {
        const existingUser = users[login];
        if (existingUser && existingUser.ban) {
            return res.status(403).json({
                status: 'device_banned',
                ban: existingUser.ban,
                message: 'У вас есть активный бан. Создавать новые аккаунты запрещено.'
            });
        }
        return res.status(409).json({ status: 'already_exists', message: 'Логин уже занят' });
    }

    return res.json({ status: 'ok' });
});

// POST /register
app.post('/register', (req, res) => {
    const { login, password, deviceId } = req.body || {};

    if (!login || !password) {
        return res.status(400).json({ status: 'error', message: 'Заполните все поля' });
    }
    if (login === ADMIN_LOGIN) {
        return res.status(409).json({ status: 'already_exists', message: 'Логин уже занят' });
    }
    if (password.length < 4) {
        return res.status(400).json({ status: 'short_password', message: 'Пароль слишком короткий' });
    }

    // ── Telegram-гейт: регистрация без подтверждённой привязки Telegram
    // запрещена (если модуль Telegram включён — см. TELEGRAM_BOT_TOKEN).
    // Это серверная проверка "в глубину" — независимо от того, прошёл ли
    // клиент диалог привязки в приложении, сервер сам не даст создать
    // аккаунт с устройства, для которого нет записи в verifiedDevices.
    if (telegramConfigured()) {
        const tgLinks = loadTelegramLinks();
        if (!deviceId || !tgLinks.verifiedDevices[deviceId]) {
            return res.status(403).json({
                status: 'telegram_required',
                message: 'Сначала необходимо привязать Telegram-аккаунт.'
            });
        }
    }

    const users = loadUsers();

    // ── PERMANENT BAN CHECK ──────────────────────────────────────
    // Block if login or device is permanently banned (survives account deletion).
    // Это тоже попытка создать НОВЫЙ аккаунт — клиент покажет инлайн-подсказку
    // под полем логина (как и для device_banned), а не полноэкранный экран бана.
    if (isPermBanned(login, deviceId)) {
        return res.status(403).json({
            status: 'perm_banned',
            message: 'У вас постоянный бан. Регистрация новых аккаунтов недоступна.'
        });
    }

    // ── ACTIVE BAN CHECK (по устройству) ──────────────────────────
    // Если это устройство уже забанено (временно или навсегда) под ДРУГИМ
    // логином — не даём создать новый аккаунт, пока бан не истёк/не снят.
    // Используем отдельный статус device_banned (а не banned), чтобы клиент
    // показал инлайн-подсказку под полем логина регистрации, а не полноэкранный
    // экран бана (тот предназначен для попытки ВОЙТИ в уже забаненный аккаунт).
    cleanupExpiredPunishments();
    const usersForBanCheck = loadUsers();
    const activeDeviceBan = findActiveBanByDevice(usersForBanCheck, deviceId);
    if (activeDeviceBan) {
        return res.status(403).json({
            status: 'device_banned',
            ban: activeDeviceBan.ban,
            message: 'У вас есть активный бан, из-за которого вам запрещено создавать новые аккаунты. Вы можете только войти в существующий аккаунт или подождать окончания бана.'
        });
    }

    if (users[login]) {
        // Если аккаунт существует — сначала проверяем бан.
        // Это попытка "зарегистрировать" уже существующий логин — раз он
        // забанен, тоже подсказываем инлайн (а не полноэкранный бан), потому
        // что суть та же: создавать новый аккаунт нельзя, нужно просто войти.
        cleanupExpiredPunishments();
        const freshUsers = loadUsers();
        const existingUser = freshUsers[login];
        if (existingUser && existingUser.ban) {
            return res.status(403).json({
                status: 'device_banned',
                ban: existingUser.ban,
                message: 'У вас есть активный бан, из-за которого вам запрещено создавать новые аккаунты. Вы можете только войти в существующий аккаунт или подождать окончания бана.'
            });
        }
        return res.status(409).json({ status: 'already_exists', message: 'Логин уже занят' });
    }

    // ── KEY PRE-VALIDATION ─────────────────────────────────────────
    // Аккаунт создаётся только если ключ действителен.
    // Это предотвращает ситуацию когда пользователь жмёт "Отмена" после
    // ошибки ключа и логин остаётся занятым без рабочего ключа.
    const { key: regKey } = req.body || {};
    if (!regKey) {
        return res.status(400).json({ status: 'error', message: 'Ключ обязателен для регистрации' });
    }
    const deletedDataReg = loadDeletedKeys();
    if (deletedDataReg.records.find(r => r.key === regKey)) {
        return res.status(403).json({ status: 'key_deleted', message: 'Ключ был удалён администратором' });
    }
    evictExpiredKeyUsers();
    const keysDataReg = loadKeys();
    const regKeyEntry = keysDataReg.keys.find(e => e.key === regKey);
    if (!regKeyEntry) {
        return res.status(404).json({ status: 'key_not_found', message: 'Ключ не найден' });
    }
    if (getKeyStatus(regKeyEntry) === 'expired') {
        return res.status(403).json({ status: 'key_expired', message: 'Срок действия ключа истёк' });
    }
    if (getKeyStatus(regKeyEntry) === 'banned') {
        return res.status(403).json({ status: 'banned', message: 'Доступ к этому ключу заблокирован из-за бана пользователя.' });
    }
    if (regKeyEntry.deactivated) {
        return res.status(403).json({ status: 'deactivated', message: 'Ключ деактивирован администратором' });
    }
    if (deviceId && regKeyEntry.deactivatedUsers) {
        const deact = regKeyEntry.deactivatedUsers.find(u => u.bindId === deviceId);
        if (deact) {
            return res.status(403).json({ status: 'deactivated', message: deactivatedUserMessage(deact) });
        }
    }
    // ── END KEY PRE-VALIDATION ─────────────────────────────────────

    const timestamp = now();
    const tgInfoForUser = telegramConfigured()
        ? (loadTelegramLinks().verifiedDevices[deviceId] || null)
        : null;
    users[login] = {
        login,
        password,
        created_at: timestamp,
        last_login: timestamp,
        deviceId: deviceId || null,
        telegram: tgInfoForUser ? {
            id: tgInfoForUser.telegramId,
            username: tgInfoForUser.username,
            firstName: tgInfoForUser.firstName
        } : null
    };
    saveUsers(users);

    return res.json({ status: 'ok', message: 'Регистрация успешна', user_id: getUserId(login), created_at: timestamp });
});

// POST /login
app.post('/login', async (req, res) => {
    const { login, password, deviceId } = req.body || {};

    if (!login || !password) {
        return res.status(400).json({ status: 'error', message: 'Заполните все поля' });
    }

    // Admin login
    if (login === ADMIN_LOGIN) {
        if (password !== ADMIN_PASSWORD) {
            return res.status(401).json({ status: 'wrong_password', message: 'Неверный пароль' });
        }
        return res.json({
            status: 'ok',
            message: 'Успешный вход',
            login: ADMIN_LOGIN,
            created_at: '2024-01-01T00:00:00.000Z',
            last_login: now(),
            is_admin: true
        });
    }

    // ── Сначала проверяем учётные данные, потом Telegram ──────────────────
    // Порядок намеренно изменён: клиент обязан видеть ошибку «Неверный
    // пароль» / «Аккаунт не найден» / «Забанен» ДО того, как мы требуем
    // Telegram, чтобы диалог привязки не всплывал при неверных данных.

    const users = loadUsers();

    if (!users[login]) {
        return res.status(404).json({ error: 'ACCOUNT_NOT_FOUND', status: 'not_found', message: 'Аккаунт не найден' });
    }

    if (users[login].password !== password) {
        return res.status(401).json({ status: 'wrong_password', message: 'Неверный пароль' });
    }

    // Check ban
    cleanupExpiredPunishments();
    const freshUsers = loadUsers();
    const freshUser = freshUsers[login];

    // Check perm ban table first (catches recreated accounts)
    if (isPermBanned(login, null)) {
        return res.json({
            status: 'banned',
            ban: { until: 'permanent', reason: 'Перманентный бан' },
            login: login,
            user_id: getUserId(login),
            created_at: freshUser ? freshUser.created_at : ''
        });
    }

    if (freshUser && freshUser.ban) {
        return res.json({
            status: 'banned',
            ban: freshUser.ban,
            login: freshUser.login,
            user_id: getUserId(login),
            created_at: freshUser.created_at
        });
    }

    // ── Telegram-гейт: ПОСЛЕ проверки учётных данных ──────────────────────
    // Теперь telegram_required означает «данные верные, но нужна привязка»,
    // и клиент показывает диалог Telegram только тогда, когда уверен в этом.
    if (telegramConfigured()) {
        const tgLinks = loadTelegramLinks();
        if (!deviceId || !tgLinks.verifiedDevices[deviceId]) {
            return res.status(403).json({
                status: 'telegram_required',
                message: 'Сначала необходимо привязать Telegram-аккаунт.'
            });
        }
    }

    // При каждом входе делаем живой запрос к Telegram Bot API (getChat),
    // чтобы получить актуальные имя и юзернейм пользователя прямо сейчас.
    // Сравниваем с тем что было сохранено ранее — если изменилось,
    // записываем в историю. Это гарантирует что данные обновятся сразу
    // при входе, не дожидаясь фонового задания.
    const tgLinks = loadTelegramLinks();
    const tgInfo  = tgLinks.verifiedDevices[deviceId];
    let tgLastUsernameChange  = null;
    let tgLastFirstNameChange = null;

    if (telegramConfigured() && deviceId && tgInfo && tgInfo.telegramId) {
        try {
            const chatResult = await tgApi('getChat', { chat_id: tgInfo.telegramId });
            if (chatResult && chatResult.result) {
                const chat = chatResult.result;

                const newUsername  = chat.username   || '';
                const newFirstName = chat.first_name || '';
                const newId        = String(tgInfo.telegramId);
                const oldUsername  = tgInfo.username  || '';
                const oldFirstName = tgInfo.firstName || '';

                if (!tgInfo.usernameHistory)  tgInfo.usernameHistory  = [];
                if (!tgInfo.firstNameHistory) tgInfo.firstNameHistory = [];

                if (newUsername !== oldUsername) {
                    if (oldUsername !== '') {
                        tgInfo.usernameHistory.push({ old: oldUsername, new: newUsername, changedAt: now() });
                        tgLastUsernameChange = { old: oldUsername, new: newUsername };
                    }
                    tgInfo.username = newUsername;
                    saveTelegramLinks(tgLinks);
                } else {
                    // Не изменился — берём последнее изменение из истории если есть
                    const uh = tgInfo.usernameHistory || [];
                    if (uh.length > 0) tgLastUsernameChange = uh[uh.length - 1];
                }

                if (newFirstName !== oldFirstName) {
                    if (oldFirstName !== '') {
                        tgInfo.firstNameHistory.push({ old: oldFirstName, new: newFirstName, changedAt: now() });
                        tgLastFirstNameChange = { old: oldFirstName, new: newFirstName };
                    }
                    tgInfo.firstName = newFirstName;
                    saveTelegramLinks(tgLinks);
                } else {
                    const fh = tgInfo.firstNameHistory || [];
                    if (fh.length > 0) tgLastFirstNameChange = fh[fh.length - 1];
                }

                freshUsers[login].telegram = { id: newId, username: newUsername, firstName: newFirstName };
            }
        } catch (e) {
            console.error('[login] getChat error:', e.message);
            // Не блокируем вход при ошибке Telegram API
        }
    }

    // Если getChat не сработал — берём данные из файла + историю из него же
    if (!freshUsers[login].telegram && tgInfo) {
        freshUsers[login].telegram = {
            id: String(tgInfo.telegramId || ''),
            username: tgInfo.username || '',
            firstName: tgInfo.firstName || ''
        };
        const uh = tgInfo.usernameHistory  || [];
        const fh = tgInfo.firstNameHistory || [];
        if (!tgLastUsernameChange  && uh.length > 0) tgLastUsernameChange  = uh[uh.length - 1];
        if (!tgLastFirstNameChange && fh.length > 0) tgLastFirstNameChange = fh[fh.length - 1];
    }

    // Update last_login
    freshUsers[login].last_login = now();
    saveUsers(freshUsers);

    const tgData = freshUsers[login].telegram || {};
    return res.json({
        status: 'ok',
        message: 'Успешный вход',
        login: freshUsers[login].login,
        user_id: getUserId(login),
        created_at: freshUsers[login].created_at,
        last_login: freshUsers[login].last_login,
        tg_id:        tgData.id        || '',
        tg_username:  tgData.username  || '',
        tg_firstName: tgData.firstName || '',
        // Последние изменения — для отображения «старое → новое» на клиенте
        tg_prev_username:  tgLastUsernameChange  ? tgLastUsernameChange.old  : '',
        tg_prev_firstName: tgLastFirstNameChange ? tgLastFirstNameChange.old : '',
        telegram: tgData
    });
});

// GET /telegram/config — отдаёт клиенту данные, нужные для построения
// deep-link на бота, без необходимости хардкодить username бота в APK.
app.get('/telegram/config', (req, res) => {
    return res.json({
        status: 'ok',
        enabled: telegramConfigured(),
        botUsername: telegramFullyConfigured() ? TELEGRAM_BOT_USERNAME : ''
    });
});

// POST /telegram/poll-token — приложение опрашивает этот эндпоинт, пока
// показан экран "Успешно! Почти всё готово.", чтобы автоматически
// подставить токен в поле ввода, если пользователь перешёл в бота по
// deep-link (т.е. бот узнал deviceId из payload команды /start) и уже
// получил токен. Если токена ещё нет — found:false, поле просто остаётся
// пустым для ручного ввода.
app.post('/telegram/poll-token', (req, res) => {
    const { deviceId } = req.body || {};
    if (!deviceId) return res.status(400).json({ status: 'error' });

    const links = loadTelegramLinks();
    let foundToken = null;
    let foundCreatedAt = '';
    for (const t of Object.keys(links.tokens)) {
        const rec = links.tokens[t];
        if (rec.pendingDeviceId === deviceId && !rec.used && !isTokenExpired(rec)) {
            if (rec.createdAt > foundCreatedAt) {
                foundToken = t;
                foundCreatedAt = rec.createdAt;
            }
        }
    }
    return res.json({ status: 'ok', found: !!foundToken, token: foundToken || '' });
});

// POST /keys/token-by-device — возвращает уже существующий активный ключ
// (токен) для данного deviceId. Используется приложением как fallback после
// неудачного poll-token: покрывает сценарий переустановки приложения, когда
// ключ уже привязан к устройству и бот лишь показывает его повторно, но
// poll-token (который ищет только новые, ещё не использованные токены) его
// не находит. Без этого эндпоинта пользователь застревал на экране
// «Токен ещё не получен» и не мог войти без ручного копирования токена из бота.
app.post('/keys/token-by-device', (req, res) => {
    const { deviceId } = req.body || {};
    if (!deviceId) return res.json({ found: false });

    const links = loadTelegramLinks();

    // Ищем токен, который был использован именно с этого устройства.
    // Берём самый свежий (usedAt максимальный), если их несколько.
    let bestToken = null;
    let bestUsedAt = '';
    for (const tokenStr of Object.keys(links.tokens)) {
        const rec = links.tokens[tokenStr];
        if (!rec.used) continue;
        if (rec.usedDeviceId !== deviceId) continue;
        if (!bestToken || rec.usedAt > bestUsedAt) {
            bestToken = tokenStr;
            bestUsedAt = rec.usedAt;
        }
    }

    if (bestToken) {
        return res.json({ found: true, token: bestToken });
    }

    // Дополнительная проверка: может, ключ уже активен в системе ключей
    // (keys.json), но токен в telegram_links.json не найден (например, был
    // очищен при плановом housekeeping). Возвращаем сам ключ по deviceId.
    const keysData = loadKeys();
    for (const k of keysData.keys) {
        if (getKeyStatus(k) === 'expired') continue;
        const u = k.users.find(user => user.bindId === deviceId);
        if (u) {
            return res.json({ found: true, token: k.key });
        }
    }

    return res.json({ found: false });
});

// POST /telegram/check-token — финальная строгая проверка токена привязки.
//  • Токен должен существовать и быть не просрочен.
//  • Если уже использован — допускается ТОЛЬКО повторный запрос с того же
//    самого deviceId (идемпотентность при повторном нажатии "Проверить"),
//    с любого ДРУГОГО устройства токен считается недействительным.
//  • При первом успешном использовании токен навсегда привязывается к
//    этому deviceId, и это устройство помечается как verifiedDevices —
//    именно это поле проверяют /register и /login.
app.post('/telegram/check-token', (req, res) => {
    const { token, deviceId } = req.body || {};
    const cleanToken = (token || '').trim();

    if (!cleanToken) {
        return res.status(400).json({ status: 'error', message: 'Введите токен' });
    }
    if (!deviceId) {
        return res.status(400).json({ status: 'error', message: 'Не удалось определить устройство' });
    }

    const links = loadTelegramLinks();
    const rec = links.tokens[cleanToken];

    if (!rec) {
        return res.status(404).json({ status: 'error', message: 'Токен не найден. Проверьте, что вы скопировали его без ошибок.' });
    }
    if (isTokenExpired(rec) && !(rec.used && rec.usedDeviceId === deviceId)) {
        return res.status(403).json({ status: 'error', message: 'Токен истёк. Получите новый токен в Telegram-боте.' });
    }
    if (rec.used && rec.usedDeviceId !== deviceId) {
        return res.status(403).json({ status: 'error', message: 'Этот токен уже был использован на другом устройстве.' });
    }

    if (!rec.used) {
        rec.used = true;
        rec.usedDeviceId = deviceId;
        rec.usedAt = now();
        links.verifiedDevices[deviceId] = {
            telegramId: rec.telegramId,
            username: rec.username,
            firstName: rec.firstName,
            verifiedAt: now(),
            usernameHistory: [],
            firstNameHistory: []
        };
        saveTelegramLinks(links);
    } else {
        // Устройство уже верифицировано ранее — обновляем данные и
        // фиксируем историю изменений ника/юзернейма если они поменялись.
        const existing = links.verifiedDevices[deviceId];
        if (existing) {
            const changedAt = now();
            if (!existing.usernameHistory)  existing.usernameHistory  = [];
            if (!existing.firstNameHistory) existing.firstNameHistory = [];

            const newUsername  = rec.username   || '';
            const oldUsername  = existing.username  || '';
            if (newUsername !== oldUsername) {
                existing.usernameHistory.push({ old: oldUsername, new: newUsername, changedAt });
                existing.username = newUsername;
            }

            const newFirstName = rec.firstName  || '';
            const oldFirstName = existing.firstName || '';
            if (newFirstName !== oldFirstName) {
                existing.firstNameHistory.push({ old: oldFirstName, new: newFirstName, changedAt });
                existing.firstName = newFirstName;
            }

            existing.telegramId = rec.telegramId;
            existing.verifiedAt = changedAt;
            saveTelegramLinks(links);
        }
    }

    return res.json({
        status: 'ok',
        // Поля дублируются в корне — клиент (extractField) читает только
        // верхний уровень JSON, а не вложенные объекты типа telegram:{...}
        id:        rec.telegramId,
        username:  rec.username   || '',
        firstName: rec.firstName  || '',
        telegram: { id: rec.telegramId, username: rec.username, firstName: rec.firstName }
    });
});

// POST /profile
app.post('/profile', (req, res) => {
    const { login, password } = req.body || {};

    if (!login || !password) {
        return res.status(400).json({ status: 'error', message: 'Заполните все поля' });
    }

    if (login === ADMIN_LOGIN) {
        if (password !== ADMIN_PASSWORD) {
            return res.status(401).json({ status: 'wrong_password', message: 'Неверный пароль' });
        }
        return res.json({
            status: 'ok',
            login: ADMIN_LOGIN,
            created_at: '2024-01-01T00:00:00.000Z',
            last_login: now()
        });
    }

    const users = loadUsers();

    if (!users[login]) {
        return res.status(404).json({ error: 'ACCOUNT_NOT_FOUND', status: 'not_found', message: 'Аккаунт не найден' });
    }
    if (users[login].password !== password) {
        return res.status(401).json({ status: 'wrong_password', message: 'Неверный пароль' });
    }

    return res.json({
        status: 'ok',
        login: users[login].login,
        created_at: users[login].created_at,
        last_login: users[login].last_login,
        telegram: users[login].telegram || null
    });
});

// POST /delete
app.post('/delete', (req, res) => {
    const { login } = req.body || {};
    if (!login) return res.status(400).json({ status: 'error', message: 'Логин обязателен' });
    // Protect admin account
    if (login === ADMIN_LOGIN) return res.status(403).json({ status: 'error', message: 'Нельзя удалить аккаунт администратора' });

    const users = loadUsers();
    if (!users[login]) return res.status(404).json({ error: 'ACCOUNT_NOT_FOUND', status: 'not_found', message: 'Аккаунт не найден' });

    delete users[login];
    saveUsers(users);
    return res.json({ status: 'ok', message: 'Аккаунт удалён' });
});

// ---- CHAT ----

const chatMessages = [];
const MAX_CHAT_MESSAGES = 500;

// POST /chat/send
app.post('/chat/send', (req, res) => {
    const { login, text, messageId } = req.body || {};
    if (!login || !text || !text.trim()) {
        return res.status(400).json({ status: 'error', message: 'login и text обязательны' });
    }

    // Check mute (skip for admin)
    if (!isAdmin(login)) {
        const users = loadUsers();
        const user = users[login];
        if (user && user.mute) {
            const muteUntil = new Date(user.mute.until).getTime();
            if (muteUntil > Date.now()) {
                return res.status(403).json({
                    status: 'muted',
                    message: 'Вы в муте',
                    mute: user.mute
                });
            } else {
                // Auto-unmute
                delete users[login].mute;
                saveUsers(users);
            }
        }
    }

    const msg = {
        id: messageId || (Date.now() + '_' + Math.random().toString(36).substr(2, 6)),
        login: login.trim(),
        text: text.trim().substring(0, 500),
        timestamp: Date.now()
    };
    chatMessages.push(msg);
    if (chatMessages.length > MAX_CHAT_MESSAGES) {
        chatMessages.splice(0, chatMessages.length - MAX_CHAT_MESSAGES);
    }
    return res.json({ status: 'ok', message: msg });
});

// GET /chat/messages
app.get('/chat/messages', (req, res) => {
    const since = parseInt(req.query.since || '0', 10);
    let result;
    if (since === 0) {
        result = chatMessages.slice(-50);
    } else {
        result = chatMessages.filter(m => m.timestamp > since);
    }
    return res.json({ status: 'ok', messages: result });
});

// POST /admin/chat/delete-messages — удаление сообщений чата (только для админа)
app.post('/admin/chat/delete-messages', requireAdmin, (req, res) => {
    const { messageIds } = req.body || {};
    if (!Array.isArray(messageIds) || messageIds.length === 0) {
        return res.status(400).json({ status: 'error', message: 'messageIds обязателен' });
    }
    const idSet = new Set(messageIds);
    const before = chatMessages.length;
    chatMessages = chatMessages.filter(m => !idSet.has(m.id));
    const deleted = before - chatMessages.length;
    return res.json({ status: 'ok', deleted });
});

// GET /user/:login
app.get('/user/:login', (req, res) => {
    const { login } = req.params;

    if (login === ADMIN_LOGIN) {
        return res.json({
            status: 'ok',
            login: ADMIN_LOGIN,
            created_at: '2024-01-01T00:00:00.000Z',
            user_id: '000001',
            deleted: false,
            ban: null
        });
    }

    const users = loadUsers();
    if (!users[login]) {
        return res.json({ status: 'deleted', deleted: true, login });
    }

    const userObj = users[login];
    const banInfo = userObj.ban ? { until: userObj.ban.until, reason: userObj.ban.reason || '' } : null;
    return res.json({
        status: 'ok',
        login: userObj.login,
        created_at: userObj.created_at,
        user_id: getUserId(login),
        deleted: false,
        ban: banInfo
    });
});

// GET /mute-status/:login — check mute for current user
app.get('/mute-status/:login', (req, res) => {
    const { login } = req.params;
    if (isAdmin(login)) return res.json({ status: 'ok', muted: false });

    const users = loadUsers();
    const user = users[login];
    if (!user) return res.json({ status: 'ok', muted: false });

    if (user.mute) {
        const muteUntil = new Date(user.mute.until).getTime();
        if (muteUntil > Date.now()) {
            return res.json({ status: 'ok', muted: true, mute: user.mute });
        } else {
            delete users[login].mute;
            saveUsers(users);
        }
    }

    return res.json({ status: 'ok', muted: false });
});

// ── REPORTS ──────────────────────────────────────────────────────────────────

// POST /report — send a report on a message/comment
app.post('/report', (req, res) => {
    const { reporterLogin, targetLogin, messageText, messageId } = req.body || {};
    if (!reporterLogin || !targetLogin || !messageText) {
        return res.status(400).json({ status: 'error', message: 'Не все поля заполнены' });
    }
    if (reporterLogin === targetLogin) {
        return res.status(400).json({ status: 'error', message: 'Нельзя репортить себя' });
    }
    if (targetLogin === ADMIN_LOGIN) {
        return res.status(400).json({ status: 'error', message: 'Нельзя репортить администратора' });
    }

    const data = loadReports();
    const nowMs = Date.now();
    const LIMIT_WINDOW = 24 * 60 * 60 * 1000; // 24 hours
    const MAX_REPORTS = 3;

    if (!data.reporterLimits) data.reporterLimits = {};
    let limits = data.reporterLimits[reporterLogin] || { count: 0, reportedUsers: [], resetAt: 0 };

    // Reset if window expired
    if (nowMs > limits.resetAt) {
        limits = { count: 0, reportedUsers: [], resetAt: nowMs + LIMIT_WINDOW };
    }

    // Already reported this user?
    if (limits.reportedUsers.includes(targetLogin)) {
        return res.status(429).json({ status: 'already_reported', message: 'Вы уже репортили этого пользователя' });
    }

    // Limit: max 3 reports per 24h
    if (limits.count >= MAX_REPORTS) {
        return res.status(429).json({ status: 'limit_reached', message: 'Лимит репортов исчерпан. Сбросится через 24 часа.' });
    }

    // Add report
    limits.count++;
    limits.reportedUsers.push(targetLogin);
    data.reporterLimits[reporterLogin] = limits;

    data.reports.push({
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        reporterLogin,
        targetLogin,
        messageText,
        messageId: messageId || null,
        timestamp: nowMs,
        seen: false
    });

    saveReports(data);

    return res.json({ status: 'ok', message: 'Репорт отправлен' });
});

// POST /admin/reports — get all reports grouped by target
app.post('/admin/reports', requireAdmin, (req, res) => {
    const data = loadReports();
    const grouped = {};

    for (const r of data.reports) {
        if (!grouped[r.targetLogin]) {
            grouped[r.targetLogin] = { targetLogin: r.targetLogin, count: 0, reports: [] };
        }
        grouped[r.targetLogin].count++;
        grouped[r.targetLogin].reports.push(r);
    }

    // Sort by count descending
    const list = Object.values(grouped).sort((a, b) => b.count - a.count);

    // Get user info for each
    const users = loadUsers();
    for (const item of list) {
        const u = users[item.targetLogin];
        item.userId = u ? getUserId(item.targetLogin) : '—';
        item.createdAt = u ? u.created_at : null;
    }

    return res.json({ status: 'ok', users: list });
});

// POST /admin/reports/mark-seen — mark all reports as seen
app.post('/admin/reports/mark-seen', requireAdmin, (req, res) => {
    const data = loadReports();
    for (const r of data.reports) {
        r.seen = true;
    }
    saveReports(data);
    return res.json({ status: 'ok' });
});

// POST /admin/reports/dismiss — отклонить репорты (нет нарушения)
app.post('/admin/reports/dismiss', requireAdmin, (req, res) => {
    const { reportId, targetLogin } = req.body || {};
    const data = loadReports();
    if (reportId) {
        data.reports = data.reports.filter(r => r.id !== reportId);
    } else if (targetLogin) {
        data.reports = data.reports.filter(r => r.targetLogin !== targetLogin);
    } else {
        return res.status(400).json({ status: 'error', message: 'Укажите reportId или targetLogin' });
    }
    saveReports(data);
    return res.json({ status: 'ok', message: 'Репорт(ы) отклонены' });
});

// POST /admin/reports/unseen-count — get count of unseen reports
app.post('/admin/reports/unseen-count', requireAdmin, (req, res) => {
    const data = loadReports();
    const count = data.reports.filter(r => !r.seen).length;
    return res.json({ status: 'ok', count });
});

// ---- ADMIN ROUTES ----

function requireAdmin(req, res, next) {
    const { adminLogin, adminPassword } = req.body || {};
    if (adminLogin === ADMIN_LOGIN && adminPassword === ADMIN_PASSWORD) {
        return next();
    }
    return res.status(403).json({ status: 'forbidden', message: 'Нет доступа' });
}

// POST /admin/stats
app.post('/admin/stats', requireAdmin, (req, res) => {
    const users = loadUsers();
    const state = loadState();
    const online = getOnlineCount(state);
    if (online > (state.peakOnline || 0)) {
        state.peakOnline = online;
        saveState(state);
    }

    // Count unseen reports
    const reportData = loadReports();
    const unseenReports = reportData.reports.filter(r => !r.seen).length;

    return res.json({
        status: 'ok',
        online,
        peakOnline: state.peakOnline || 0,
        totalAccounts: Object.keys(users).length,
        appDisabled: state.appDisabled || false,
        unseenReports
    });
});

// POST /admin/disable-app
app.post('/admin/disable-app', requireAdmin, (req, res) => {
    const { disabled } = req.body || {};
    const state = loadState();
    state.appDisabled = !!disabled;
    saveState(state);
    return res.json({ status: 'ok', appDisabled: state.appDisabled });
});

// GET /app-status
app.get('/app-status', (req, res) => {
    const state = loadState();
    return res.json({ appDisabled: state.appDisabled || false });
});

// POST /admin/ban
app.post('/admin/ban', requireAdmin, (req, res) => {
    const { targetLogin, targetId, days, reason } = req.body || {};
    if (!targetLogin) return res.status(400).json({ status: 'error', message: 'Укажите логин' });
    if (targetLogin === ADMIN_LOGIN) return res.status(400).json({ status: 'error', message: 'Нельзя забанить администратора' });

    const users = loadUsers();
    if (!users[targetLogin]) return res.status(404).json({ status: 'error', message: 'Пользователь не найден' });

    const banUntil = days === 'permanent' ? 'permanent'
        : new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    // ── ПОСЛЕДСТВИЯ ДЛЯ СИСТЕМЫ КЛЮЧЕЙ ──────────────────────────────
    // Закрываем дыру: раньше забаненный мог просто выйти и зайти под другим
    // аккаунтом с тем же ключом. Теперь баним сам ключ-слот этого устройства.
    const banReasonText = (reason || '').substring(0, 30);
    const keyInfo = applyBanToKey(targetLogin, banReasonText);

    users[targetLogin].ban = {
        until: banUntil,
        reason: banReasonText,
        by: ADMIN_LOGIN,
        at: now(),
        keyInfo: keyInfo // { key, maxDevices } или null, если ключ не был привязан
    };
    saveUsers(users);

    // Автоматически удаляем все репорты на этого пользователя
    const rDataBan = loadReports();
    rDataBan.reports = rDataBan.reports.filter(r => r.targetLogin !== targetLogin);
    saveReports(rDataBan);

    // Удаляем все посты пользователя из раздела Звания при бане
    const rankDataBan = loadRankPosts();
    const rankBefore = rankDataBan.posts.length;
    rankDataBan.posts = rankDataBan.posts.filter(p => p.login !== targetLogin);
    if (rankDataBan.posts.length < rankBefore) saveRankPosts(rankDataBan);

    // If permanent, record in perm_bans so it survives account deletion/recreation
    if (banUntil === 'permanent') {
        const deviceId = users[targetLogin] ? users[targetLogin].deviceId : null;
        addPermBan(targetLogin, deviceId);
    }

    return res.json({ status: 'ok', message: 'Бан применён' });
});

// Определяет Telegram chat_id пользователя для уведомлений (например, при
// разбане). Раньше здесь ошибочно использовался tgLinks.verifiedDevices[bindId]
// напрямую как ID (это объект вида {telegramId, username, ...}, а не сам ID) —
// из-за этого уведомления вообще не уходили. К тому же для ключей, выданных
// БОТОМ, устройство пользователя чаще всего никогда не проходит отдельную
// процедуру "Привязка Telegram" (тот диалог — для другой цели), поэтому
// verifiedDevices для них обычно пуст. У бот-ключей telegramId уже известен
// напрямую из bot_keys.json — его и используем в первую очередь.
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

// POST /admin/unban
app.post('/admin/unban', requireAdmin, (req, res) => {
    const { targetLogin } = req.body || {};
    if (!targetLogin) return res.status(400).json({ status: 'error', message: 'Укажите логин' });

    const users = loadUsers();
    if (!users[targetLogin]) return res.status(404).json({ status: 'error', message: 'Пользователь не найден' });
    delete users[targetLogin].ban;
    saveUsers(users);
    // Also remove from permanent ban table
    removePermBan(targetLogin);

    // Захватываем данные для уведомления ДО восстановления ключа —
    // restoreKeyAfterUnban обнуляет banFreeze.
    let notifyKeyValue = null, notifyIsBotKey = false, notifyBindId = null;
    for (const k of loadKeys().keys) {
        if (keyBanFreezeMatchesLogin(k, targetLogin)) {
            notifyKeyValue = k.key;
            notifyIsBotKey = !!k.botKey;
            notifyBindId = k.banFreeze.bindId;
            break;
        }
    }

    // Восстанавливаем замороженный ключ (если ключ был на 1 устройство,
    // оставалось больше 30 минут на момент блокировки, и пользователь не
    // успел обзавестись другим активным ключом, пока ждал разбана).
    const restoreResult = restoreKeyAfterUnban(targetLogin);

    // Уведомляем пользователя в Telegram о разбане — текст зависит от того,
    // вернулся ли его старый ключ на самом деле.
    if (notifyKeyValue) {
        const telegramId = findTelegramIdForKey(notifyKeyValue, notifyIsBotKey, notifyBindId);
        if (telegramId) {
            let unbanMsg = null;
            if (restoreResult === 'restored') {
                unbanMsg = '🔓 <b>Вы разблокированы!</b>\n\nВаш ключ снова активен.';
            } else if (restoreResult === 'superseded') {
                unbanMsg = '🔓 <b>Вы разблокированы!</b>\n\n' +
                    'Ваш старый ключ всё ещё не активен, так как у вас уже есть активный ключ.';
            } else if (restoreResult === 'too_little_time') {
                unbanMsg = '🔓 <b>Вы разблокированы!</b>\n\n' +
                    'К сожалению, срок действия вашего старого ключа истёк за время блокировки — восстановить его нельзя.';
            }
            if (unbanMsg) tgSend(telegramId, unbanMsg, { parse_mode: 'HTML' });
        }
    }

    return res.json({ status: 'ok', message: 'Бан снят' });
});

// POST /admin/mute
app.post('/admin/mute', requireAdmin, (req, res) => {
    const { targetLogin, hours, reason } = req.body || {};
    if (!targetLogin) return res.status(400).json({ status: 'error', message: 'Укажите логин' });
    if (targetLogin === ADMIN_LOGIN) return res.status(400).json({ status: 'error', message: 'Нельзя замутить администратора' });

    const users = loadUsers();
    if (!users[targetLogin]) return res.status(404).json({ status: 'error', message: 'Пользователь не найден' });

    const muteUntil = new Date(Date.now() + Math.min(hours, 125) * 60 * 60 * 1000).toISOString();
    users[targetLogin].mute = {
        until: muteUntil,
        hours: Math.min(hours, 125),
        reason: (reason || '').substring(0, 30),
        by: ADMIN_LOGIN,
        at: now()
    };
    saveUsers(users);

    // Автоматически удаляем все репорты на этого пользователя
    const rDataMute = loadReports();
    rDataMute.reports = rDataMute.reports.filter(r => r.targetLogin !== targetLogin);
    saveReports(rDataMute);
    return res.json({ status: 'ok', message: 'Мут применён' });
});

// POST /admin/unmute
app.post('/admin/unmute', requireAdmin, (req, res) => {
    const { targetLogin } = req.body || {};
    if (!targetLogin) return res.status(400).json({ status: 'error', message: 'Укажите логин' });

    const users = loadUsers();
    if (!users[targetLogin]) return res.status(404).json({ status: 'error', message: 'Пользователь не найден' });
    delete users[targetLogin].mute;
    saveUsers(users);
    return res.json({ status: 'ok', message: 'Мут снят' });
});

// POST /admin/banned-list — list banned users
app.post('/admin/banned-list', requireAdmin, (req, res) => {
    const users = loadUsers();
    const list = [];
    for (const [login, user] of Object.entries(users)) {
        if (user.ban) {
            list.push({
                login,
                user_id: getUserId(login),
                created_at: user.created_at,
                ban: user.ban
            });
        }
    }
    return res.json({ status: 'ok', users: list });
});

// POST /admin/muted-list — list muted users
app.post('/admin/muted-list', requireAdmin, (req, res) => {
    const users = loadUsers();
    const list = [];
    const nowMs = Date.now();
    for (const [login, user] of Object.entries(users)) {
        if (user.mute && new Date(user.mute.until).getTime() > nowMs) {
            list.push({
                login,
                user_id: getUserId(login),
                created_at: user.created_at,
                mute: user.mute
            });
        }
    }
    return res.json({ status: 'ok', users: list });
});

const SUPPORT_FILE = path.join(__dirname, 'support.json');

function loadSupport() {
    if (!fs.existsSync(SUPPORT_FILE)) return { chats: {} };
    try { return JSON.parse(fs.readFileSync(SUPPORT_FILE, 'utf8')); }
    catch (e) { return { chats: {} }; }
}

function saveSupport(data) {
    fs.writeFileSync(SUPPORT_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function genChatId() {
    return 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
}

// ── SUPPORT CHAT ROUTES ─────────────────────────────────────────────────────

// POST /support/chat/create — user creates a new support chat
app.post('/support/chat/create', (req, res) => {
    const { login, password, chatName } = req.body || {};
    if (!login || !password || !chatName) {
        return res.status(400).json({ status: 'error', message: 'Не все поля заполнены' });
    }

    // Allow admin to create chat too
    const isAdminUser = (login === ADMIN_LOGIN && password === ADMIN_PASSWORD);
    if (!isAdminUser) {
        const users = loadUsers();
        if (!users[login] || users[login].password !== password) {
            return res.status(401).json({ status: 'error', message: 'Неверные данные' });
        }

        const data = loadSupport();
        // Check cooldown (3 hours after cancellation)
        const cooldownUntil = users[login].supportCooldownUntil;
        if (cooldownUntil && Date.now() < cooldownUntil) {
            return res.status(429).json({ status: 'cooldown', cooldownUntil });
        }
    }

    const data = loadSupport();
    const chatId = genChatId();
    const nowMs = Date.now();

    // FIX BUG 1: searching starts as FALSE — only set to true after user sends first message
    data.chats[chatId] = {
        id: chatId,
        name: chatName.substring(0, 20),
        userLogin: login,
        createdAt: new Date(nowMs).toISOString(),
        messages: [],
        archived: false,
        searching: false,
        adminJoined: false,
        adminLogin: null,
        waitingSince: null
    };

    // Bot welcome message
    data.chats[chatId].messages.push({
        id: 'bot_' + nowMs,
        sender: 'bot',
        senderLogin: 'Бот',
        text: 'Приветствую, ' + login + '!\n\nЭто онлайн помощь.\nНе пишите спам или бессмысленные сообщения, иначе можете получить мут.\n\nОпишите проблему с которой вы столкнулись при использовании приложения и мы найдём свободного администратора.',
        timestamp: nowMs
    });

    saveSupport(data);
    return res.json({ status: 'ok', chatId });
});

// POST /support/chats — get list of user's chats
app.post('/support/chats', (req, res) => {
    const { login, password } = req.body || {};
    if (!login || !password) return res.status(400).json({ status: 'error' });
    const isAdminUser = (login === ADMIN_LOGIN && password === ADMIN_PASSWORD);
    if (!isAdminUser) {
        const usersCheck = loadUsers();
        if (!usersCheck[login] || usersCheck[login].password !== password) {
            return res.status(401).json({ status: 'error' });
        }
    }
    const users = loadUsers();
    const data = loadSupport();
    const cooldownUntil = (users[login] && users[login].supportCooldownUntil) || 0;
    const chats = [];

    for (const chat of Object.values(data.chats)) {
        if (chat.userLogin !== login) continue;
        const msgs = chat.messages || [];
        const lastUserMsg = msgs.filter(m => m.sender === 'user' || m.sender === 'admin').slice(-1)[0];
        chats.push({
            id: chat.id,
            name: chat.name,
            archived: chat.archived,
            searching: chat.searching && !chat.adminJoined && !chat.archived,
            lastMessage: lastUserMsg ? lastUserMsg.text : ''
        });
    }

    // Sort: newest first
    chats.sort((a, b) => {
        const ca = data.chats[a.id];
        const cb = data.chats[b.id];
        return (cb ? new Date(cb.createdAt).getTime() : 0) - (ca ? new Date(ca.createdAt).getTime() : 0);
    });

    return res.json({ status: 'ok', chats, cooldownUntil });
});

// POST /support/chat/messages — user polls messages
app.post('/support/chat/messages', (req, res) => {
    const { login, password, chatId, since } = req.body || {};
    if (!login || !password || !chatId) return res.status(400).json({ status: 'error' });
    const isAdminPoll = (login === ADMIN_LOGIN && password === ADMIN_PASSWORD);
    if (!isAdminPoll) {
        const users = loadUsers();
        if (!users[login] || users[login].password !== password) {
            return res.status(401).json({ status: 'error' });
        }
    }

    const data = loadSupport();
    const chat = data.chats[chatId];
    const isAdminUser2 = (login === ADMIN_LOGIN && password === ADMIN_PASSWORD);
    if (!chat || (chat.userLogin !== login && !isAdminUser2)) return res.status(404).json({ status: 'error' });

    const sinceMs = parseInt(since || '0', 10);
    const messages = (chat.messages || []).filter(m => m.timestamp > sinceMs);

    return res.json({
        status: 'ok',
        messages,
        archived: chat.archived,
        searching: chat.searching && !chat.adminJoined && !chat.archived,
        adminJoined: chat.adminJoined
    });
});

// POST /support/chat/send — user sends message
app.post('/support/chat/send', (req, res) => {
    const { login, password, chatId, text } = req.body || {};
    if (!login || !password || !chatId || !text) return res.status(400).json({ status: 'error' });
    const isAdminSend = (login === ADMIN_LOGIN && password === ADMIN_PASSWORD);
    const users = loadUsers();
    if (!isAdminSend) {
        if (!users[login] || users[login].password !== password) {
            return res.status(401).json({ status: 'error' });
        }
    }
    const data = loadSupport();
    const chat = data.chats[chatId];
    if (!chat || (chat.userLogin !== login && !isAdminSend)) return res.status(404).json({ status: 'error' });
    if (chat.archived) return res.status(403).json({ status: 'archived' });

    // NOTE: mute does NOT apply to support chat — only to regular chat (/chat/send)
    // Support chat is a separate channel for users to contact admins about issues

    const nowMs = Date.now();
    const msg = {
        id: 'msg_' + nowMs + '_' + Math.random().toString(36).substr(2, 4),
        sender: 'user',
        senderLogin: login,
        text: text.substring(0, 1000),
        timestamp: nowMs
    };

    chat.messages.push(msg);

    // If this is the first user message, enter searching state
    const userMsgCount = chat.messages.filter(m => m.sender === 'user').length;
    if (userMsgCount === 1) {
        chat.searching = true;
        chat.waitingSince = nowMs;
        // Store problem description
        chat.problem = text.substring(0, 500);
    }

    saveSupport(data);
    return res.json({ status: 'ok', ok: true });
});

// POST /support/admin/queue — admin gets list of waiting users
app.post('/support/admin/queue', requireAdmin, (req, res) => {
    const data = loadSupport();
    const nowMs = Date.now();
    const queue = [];

    for (const chat of Object.values(data.chats)) {
        if (chat.archived) continue;
        // Has user message and no admin yet
        const hasUserMsg = (chat.messages || []).some(m => m.sender === 'user');
        if (!hasUserMsg) continue;

        const users = loadUsers();
        const u = users[chat.userLogin] || {};
        queue.push({
            chatId: chat.id,
            login: chat.userLogin,
            userId: getUserId(chat.userLogin),
            createdAt: u.created_at || '',
            waitMs: nowMs - (chat.waitingSince || nowMs),
            problem: chat.problem || '',
            adminJoined: chat.adminJoined
        });
    }

    // Sort: longest wait first
    queue.sort((a, b) => b.waitMs - a.waitMs);
    return res.json({ status: 'ok', queue });
});

// POST /support/admin/join — admin opens chat (does NOT mark as found yet)
// adminJoined is only set to true when admin sends first message (in /admin/send)
app.post('/support/admin/join', requireAdmin, (req, res) => {
    const { chatId } = req.body || {};
    const data = loadSupport();
    const chat = data.chats[chatId];
    if (!chat) return res.status(404).json({ status: 'error' });
    // Just record that admin is viewing — do not change adminJoined/searching yet
    chat.adminLogin = ADMIN_LOGIN;
    saveSupport(data);
    return res.json({ status: 'ok' });
});

// POST /support/admin/messages — admin polls messages
app.post('/support/admin/messages', requireAdmin, (req, res) => {
    const { chatId, since } = req.body || {};
    const data = loadSupport();
    const chat = data.chats[chatId];
    if (!chat) return res.status(404).json({ status: 'error' });

    const sinceMs = parseInt(since || '0', 10);
    const messages = (chat.messages || []).filter(m => m.timestamp > sinceMs);
    return res.json({ status: 'ok', messages, archived: chat.archived });
});

// POST /support/admin/send — admin sends message
app.post('/support/admin/send', requireAdmin, (req, res) => {
    const { chatId, text } = req.body || {};
    if (!chatId || !text) return res.status(400).json({ status: 'error' });

    const data = loadSupport();
    const chat = data.chats[chatId];
    if (!chat) return res.status(404).json({ status: 'error' });
    if (chat.archived) return res.status(403).json({ status: 'archived' });

    const nowMs = Date.now();
    const msg = {
        id: 'admin_' + nowMs,
        sender: 'admin',
        senderLogin: ADMIN_LOGIN,
        text: text.substring(0, 1000),
        timestamp: nowMs
    };
    chat.messages.push(msg);
    chat.adminJoined = true;
    chat.searching = false;
    saveSupport(data);
    return res.json({ status: 'ok', ok: true });
});

// POST /support/admin/finish — admin closes chat
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

// POST /support/admin/cancel — admin cancels help request
app.post('/support/admin/cancel', requireAdmin, (req, res) => {
    const { chatId, userLogin } = req.body || {};
    const data = loadSupport();
    const chat = data.chats[chatId];
    if (!chat) return res.status(404).json({ status: 'error' });

    const nowMs = Date.now();

    // Send cancellation message to user
    chat.messages.push({
        id: 'cancel_' + nowMs,
        sender: 'bot',
        senderLogin: 'Бот',
        text: 'Ваш запрос отменён администратором.\nСоздайте новый чат через 3 часа',
        timestamp: nowMs
    });
    chat.archived = true;
    chat.searching = false;
    saveSupport(data);

    // Apply 3-hour cooldown to user
    const users = loadUsers();
    const login = userLogin || chat.userLogin;
    if (users[login]) {
        users[login].supportCooldownUntil = nowMs + 3 * 60 * 60 * 1000;
        saveUsers(users);
    }

    return res.json({ status: 'ok' });
});

// POST /support/user/check-new — user polls: did admin send a new message?
// Returns new admin messages since `since` timestamp for all user's chats
app.post('/support/user/check-new', (req, res) => {
    const { login, password, since } = req.body || {};
    if (!login || !password) return res.status(400).json({ status: 'error' });
    const users = loadUsers();
    if (!users[login] || users[login].password !== password) {
        return res.status(401).json({ status: 'error' });
    }
    const data = loadSupport();
    const sinceMs = parseInt(since || '0', 10);
    let newAdminMsg = null;
    for (const chat of Object.values(data.chats)) {
        if (chat.userLogin !== login || chat.archived) continue;
        const msgs = (chat.messages || []).filter(m => m.sender === 'admin' && m.timestamp > sinceMs);
        if (msgs.length > 0) {
            newAdminMsg = { chatId: chat.id, chatName: chat.name, text: msgs[msgs.length-1].text, timestamp: msgs[msgs.length-1].timestamp };
            break;
        }
    }
    return res.json({ status: 'ok', newAdminMsg });
});

// POST /support/admin/check-new — admin polls: did any user send a new message?
app.post('/support/admin/check-new', requireAdmin, (req, res) => {
    const { since } = req.body || {};
    const data = loadSupport();
    const sinceMs = parseInt(since || '0', 10);
    let newUserMsg = null;
    for (const chat of Object.values(data.chats)) {
        if (chat.archived) continue;
        const msgs = (chat.messages || []).filter(m => m.sender === 'user' && m.timestamp > sinceMs);
        if (msgs.length > 0) {
            newUserMsg = { chatId: chat.id, userLogin: chat.userLogin, text: msgs[msgs.length-1].text, timestamp: msgs[msgs.length-1].timestamp };
            break;
        }
    }
    return res.json({ status: 'ok', newUserMsg });
});

// ========================================
// RANK SHARE — Поделитесь вашим максимальным званием
// ========================================

// POST /rank/send — отправка поста с фото
app.post('/rank/send', (req, res) => {
    const { login, createdAt, description, images } = req.body;
    
    if (!login || !createdAt) {
        return res.status(400).json({ error: 'Missing login or createdAt' });
    }
    
    if (!images || !Array.isArray(images) || images.length === 0 || images.length > 3) {
        return res.status(400).json({ error: 'Invalid images (1-3 required)' });
    }
    
    // Проверка мута
    const mutesData = loadRankMutes();
    const userKey = `${login}:${createdAt}`;
    if (mutesData.mutes[userKey]) {
        return res.status(403).json({ error: 'You are muted in this section' });
    }
    
    const data = loadRankPosts();
    
    const post = {
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        login,
        createdAt,
        description: description || '',
        images: images.slice(0, 3), // base64 массив
        timestamp: Date.now(),
        createdDate: now()
    };
    
    data.posts.unshift(post);
    
    // Храним максимум 200 постов
    if (data.posts.length > 200) {
        data.posts = data.posts.slice(0, 200);
    }
    
    saveRankPosts(data);
    
    return res.json({ status: 'ok', postId: post.id });
});

// GET /rank/posts?since=<timestamp> — получение постов
app.get('/rank/posts', (req, res) => {
    const since = parseInt(req.query.since || '0', 10);
    const data = loadRankPosts();
    
    const newPosts = data.posts.filter(p => p.timestamp > since);
    
    // Возвращаем только последние 50 постов при первой загрузке
    if (since === 0) {
        return res.json(data.posts.slice(0, 50));
    }
    
    return res.json(newPosts);
});

// GET /rank/mute-status — проверка статуса мута
app.get('/rank/mute-status', (req, res) => {
    const { login, createdAt } = req.query;
    
    if (!login || !createdAt) {
        return res.status(400).json({ error: 'Missing login or createdAt' });
    }
    
    const mutesData = loadRankMutes();
    const userKey = `${login}:${createdAt}`;
    const muteInfo = mutesData.mutes[userKey];
    
    if (muteInfo) {
        return res.json({
            muted: true,
            reason: muteInfo.reason || 'Нарушение правил',
            mutedAt: muteInfo.mutedAt,
            mutedBy: muteInfo.mutedBy || 'admin'
        });
    }
    
    return res.json({ muted: false });
});

// POST /rank/mute — выдача мута (только для админа)
app.post('/rank/mute', requireAdmin, (req, res) => {
    const { login, createdAt, reason } = req.body;
    
    if (!login || !createdAt) {
        return res.status(400).json({ error: 'Missing login or createdAt' });
    }
    
    const mutesData = loadRankMutes();
    const userKey = `${login}:${createdAt}`;
    
    mutesData.mutes[userKey] = {
        login,
        createdAt,
        reason: reason || 'Нарушение правил раздела',
        mutedAt: now(),
        mutedBy: 'admin'
    };
    
    saveRankMutes(mutesData);
    
    return res.json({ status: 'ok', message: 'User muted in rank section' });
});

// POST /rank/unmute — снятие мута (только для админа)
app.post('/rank/unmute', requireAdmin, (req, res) => {
    const { login, createdAt } = req.body;
    
    if (!login || !createdAt) {
        return res.status(400).json({ error: 'Missing login or createdAt' });
    }
    
    const mutesData = loadRankMutes();
    const userKey = `${login}:${createdAt}`;
    
    if (mutesData.mutes[userKey]) {
        delete mutesData.mutes[userKey];
        saveRankMutes(mutesData);
        return res.json({ status: 'ok', message: 'User unmuted' });
    }
    
    return res.json({ status: 'ok', message: 'User was not muted' });
});

// DELETE /rank/post/:postId — удаление поста (только для админа)
app.delete('/rank/post/:postId', requireAdmin, (req, res) => {
    const { postId } = req.params;
    const data = loadRankPosts();
    
    const initialLength = data.posts.length;
    data.posts = data.posts.filter(p => p.id !== postId);
    
    if (data.posts.length < initialLength) {
        saveRankPosts(data);
        return res.json({ status: 'ok', message: 'Post deleted' });
    }
    
    return res.status(404).json({ error: 'Post not found' });
});

// POST /admin/rank/delete-posts — массовое удаление постов (только для админа)
app.post('/admin/rank/delete-posts', requireAdmin, (req, res) => {
    const { postIds } = req.body || {};
    if (!Array.isArray(postIds) || postIds.length === 0) {
        return res.status(400).json({ status: 'error', message: 'postIds обязателен' });
    }
    const idSet = new Set(postIds);
    const data = loadRankPosts();
    const before = data.posts.length;
    data.posts = data.posts.filter(p => !idSet.has(p.id));
    const deleted = before - data.posts.length;
    saveRankPosts(data);
    return res.json({ status: 'ok', deleted });
});

// POST /rank/report — репорт на фото-пост
app.post('/rank/report', (req, res) => {
    const { reporterLogin, targetLogin, postId, description, imageBase64 } = req.body || {};
    if (!reporterLogin || !targetLogin || !postId) {
        return res.status(400).json({ status: 'error', message: 'Не все поля заполнены' });
    }
    if (reporterLogin === targetLogin) {
        return res.status(400).json({ status: 'error', message: 'Нельзя репортить себя' });
    }
    if (targetLogin === ADMIN_LOGIN) {
        return res.status(400).json({ status: 'error', message: 'Нельзя репортить администратора' });
    }

    const data = loadReports();
    const nowMs = Date.now();
    const LIMIT_WINDOW = 24 * 60 * 60 * 1000;
    const MAX_REPORTS = 5; // чуть выше лимит для фото-репортов

    if (!data.reporterLimits) data.reporterLimits = {};
    let limits = data.reporterLimits[reporterLogin] || { count: 0, reportedUsers: [], resetAt: 0 };
    if (nowMs > limits.resetAt) {
        limits = { count: 0, reportedUsers: [], resetAt: nowMs + LIMIT_WINDOW };
    }

    const reportKey = 'rank_' + targetLogin + '_' + postId;
    if (limits.reportedUsers.includes(reportKey)) {
        return res.status(429).json({ status: 'already_reported', message: 'Вы уже репортили этот пост' });
    }
    if (limits.count >= MAX_REPORTS) {
        return res.status(429).json({ status: 'limit_reached', message: 'Лимит репортов исчерпан' });
    }

    limits.count++;
    limits.reportedUsers.push(reportKey);
    data.reporterLimits[reporterLogin] = limits;

    data.reports.push({
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        type: 'rank_photo',
        reporterLogin,
        targetLogin,
        postId,
        messageText: '[Фото] ' + (description || ''),
        imageBase64: imageBase64 || null,
        timestamp: nowMs,
        seen: false
    });

    saveReports(data);
    return res.json({ status: 'ok', message: 'Репорт отправлен' });
});

// POST /admin/rank/mute-from-report — выдать мут в разделе Звания из репорта
app.post('/admin/rank/mute-from-report', requireAdmin, (req, res) => {
    const { login, createdAt, reason } = req.body || {};
    if (!login) return res.status(400).json({ status: 'error', message: 'Укажите логин' });

    const users = loadUsers();
    const user = users[login];
    const userCreatedAt = createdAt || (user ? user.createdAt : '');

    const mutesData = loadRankMutes();
    const userKey = `${login}:${userCreatedAt}`;
    mutesData.mutes[userKey] = {
        login,
        createdAt: userCreatedAt,
        reason: reason || 'Нарушение правил раздела',
        mutedAt: now(),
        mutedBy: 'admin'
    };
    saveRankMutes(mutesData);
    return res.json({ status: 'ok', message: 'Мут в разделе Звания выдан' });
});


// ═══════════════════════════════════════════════════════════════
//  KEY SYSTEM
// ═══════════════════════════════════════════════════════════════

const KEYS_FILE = path.join(__dirname, 'keys.json');
const DELETED_KEYS_FILE = path.join(__dirname, 'deleted_keys.json');
const BOT_KEYS_FILE = path.join(__dirname, 'bot_keys.json');

// ---- Бот-ключи: ключи, выданные Telegram-ботом автоматически ----
// Структура: { keys: [{ key, telegramId, createdAt, expiryDays, expiryAt,
//   status: 'active'|'deactivated'|'blocked', deactivatedAt, reason,
//   cooldownUntil, users: [...] }] }
function loadBotKeys() {
    if (!fs.existsSync(BOT_KEYS_FILE)) return { keys: [] };
    try { return JSON.parse(fs.readFileSync(BOT_KEYS_FILE, 'utf8')); }
    catch (e) { return { keys: [] }; }
}

function saveBotKeys(data) {
    fs.writeFileSync(BOT_KEYS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Синхронизирует статус записи в bot_keys.json при действиях админа над
// соответствующим ключом в основной системе (keys.json) — деактивация,
// бан, разбан. Без этого статус в Telegram-боте и в разделе «Ключи,
// созданные ботом» не совпадает с реальным состоянием ключа, а бот
// продолжает считать деактивированный/забаненный ключ активным и не
// пускает пользователя получить новый (кулдаун так и не включается).
function syncBotKeyStatus(keyValue, status, reason) {
    if (!keyValue) return;
    const botData = loadBotKeys();
    const bk = botData.keys.find(k => k.key === keyValue);
    if (!bk) return;
    bk.status = status;
    if (status === 'deactivated' || status === 'blocked') {
        bk.deactivatedAt = now();
        bk.reason = reason || (status === 'blocked' ? 'Заблокирован администратором' : 'Деактивирован администратором');
        bk.cooldownUntil = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString();
    } else {
        // Восстановление (разбан) — снимаем метки деактивации/блокировки
        bk.deactivatedAt = null;
        bk.reason = '';
        bk.cooldownUntil = null;
    }
    saveBotKeys(botData);
}

// Ищет бот-ключ по telegramId. Возвращает запись или null.
function findBotKeyByTelegramId(telegramId) {
    const data = loadBotKeys();
    const tid = String(telegramId);
    return data.keys.find(k => String(k.telegramId) === tid) || null;
}

// Статус бот-ключа с учётом срока действия
function getBotKeyStatus(k) {
    if (!k) return null;
    if (k.status === 'deactivated') return 'deactivated';
    if (k.status === 'blocked') return 'blocked';
    if (k.deleted) return 'deleted';
    const nowMs = Date.now();
    if (k.expiryAt && new Date(k.expiryAt).getTime() < nowMs) return 'expired';
    if (k.users && k.users.length > 0) return 'active';
    return 'inactive';
}

// Форматирует дату как "DD.MM.YYYY HH:MM" в часовом поясе бота
function formatBotDate(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    const shifted = new Date(d.getTime() + TELEGRAM_DISPLAY_TZ_OFFSET_MIN * 60 * 1000);
    const dd = String(shifted.getUTCDate()).padStart(2, '0');
    const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = shifted.getUTCFullYear();
    const hh = String(shifted.getUTCHours()).padStart(2, '0');
    const min = String(shifted.getUTCMinutes()).padStart(2, '0');
    return dd + '.' + mm + '.' + yyyy + ' ' + hh + ':' + min;
}

function loadKeys() {
    if (!fs.existsSync(KEYS_FILE)) return { keys: [] };
    try { return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); }
    catch (e) { return { keys: [] }; }
}

function saveKeys(data) {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ---- Удалённые ключи: храним отдельно, чтобы знать кого выкинуть
// и чтобы при повторном вводе того же ключа показать "ключ удалён".
// records: [{ key, reason, deletedAt, users: [{login, userId, bindId}] }]
function loadDeletedKeys() {
    if (!fs.existsSync(DELETED_KEYS_FILE)) return { records: [] };
    try { return JSON.parse(fs.readFileSync(DELETED_KEYS_FILE, 'utf8')); }
    catch (e) { return { records: [] }; }
}

function saveDeletedKeys(data) {
    fs.writeFileSync(DELETED_KEYS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Убирает пользователя (по deviceId и/или login) из всех записей об удалённых ключах.
// Вызывается, когда пользователь успешно активировал НОВЫЙ ключ — иначе старое
// уведомление "ключ был удалён" продолжало бы всплывать в heartbeat вечно,
// даже после того как человек уже пользуется новым, не удалённым ключом.
function clearDeletedKeyMark(deviceId, login) {
    const deletedData = loadDeletedKeys();
    let changed = false;
    for (const rec of deletedData.records) {
        const before = rec.users.length;
        rec.users = rec.users.filter(u =>
            !((deviceId && u.bindId === deviceId) || (login && u.login === login))
        );
        if (rec.users.length !== before) changed = true;
    }
    if (changed) saveDeletedKeys(deletedData);
}

// Снимает метку деактивации с устройства (по deviceId) на всех ключах.
// Вызывается когда пользователь успешно привязался к новому ключу — это значит
// он уже прошёл через окно деактивации, нажал "Хорошо" и вошёл/зарегистрировался
// заново. Старая деактивация на предыдущем ключе больше не должна его блокировать.
function clearDeactivationMark(deviceId, login) {
    if (!deviceId && !login) return;
    const data = loadKeys();
    let changed = false;
    for (const k of data.keys) {
        if (!k.deactivatedUsers) continue;
        const before = k.deactivatedUsers.length;
        k.deactivatedUsers = k.deactivatedUsers.filter(u =>
            !((deviceId && u.bindId === deviceId) || (login && u.login === login))
        );
        if (k.deactivatedUsers.length !== before) changed = true;
    }
    if (changed) saveKeys(data);
}

function generateKey() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let key = '';
    for (let i = 0; i < 4; i++) {
        if (i > 0) key += '-';
        for (let j = 0; j < 4; j++) {
            key += chars[Math.floor(Math.random() * chars.length)];
        }
    }
    return key;
}

// Текст сообщения для пользователя, отключённого от ключа.
// Если отключение произошло из-за бана (viaBan: true) — говорим "заблокирован",
// если это была ручная деактивация конкретного пользователя админом
// (/admin/keys/deactivate-user) — говорим "деактивирован".
function deactivatedUserMessage(entry) {
    const word = entry && entry.viaBan ? 'заблокирован' : 'деактивирован';
    return 'Ваш ключ ' + word + ' администратором.\n\nПричина: ' + (entry ? entry.reason : '');
}

function getKeyStatus(k) {
    // Ключ заморожен из-за бана пользователя (актуально только для ключей на
    // 1 устройство — см. applyBanToKey). Пока banFreeze не снят (разбан/протух),
    // ключ считается заблокированным, даже если по времени он ещё не истёк.
    if (k.banFreeze) return 'banned';
    const nowMs = Date.now();
    if (k.expiryAt && k.expiryAt !== 'forever' && new Date(k.expiryAt).getTime() < nowMs) {
        return 'expired';
    }
    if (k.deactivated && k.users.length === 0) return 'deactivated';
    if (k.users.length > 0) return 'active';
    return 'inactive';
}

// Порог: если на момент блокировки пользователя у ключа оставалось 30 минут
// или меньше, ключ не подлежит восстановлению после разбана.
const BAN_RESTORE_THRESHOLD_MS = 30 * 60 * 1000;

// Находит ключ, к которому СЕЙЧАС привязан (через активный логин на устройстве)
// указанный аккаунт. Возвращает { key, userIndex } или null.
// Проверяет, относится ли заморозка ключа (banFreeze) к данному логину —
// либо напрямую (это и был активный логин на момент бана), либо через
// accountsHistory (targetLogin — старый логин с того же устройства/ключа).
// Используется и при поиске ключа для бана, и при разбане — чтобы оба
// действия были симметричны независимо от того, какой именно логин (старый
// или текущий) администратор укажет.
function keyBanFreezeMatchesLogin(k, login) {
    if (!k.banFreeze || !login) return false;
    if (k.banFreeze.login === login) return true;
    return Array.isArray(k.banFreeze.accountsHistory) &&
        k.banFreeze.accountsHistory.some(h => h.login === login);
}

function findKeyBoundToLogin(keysData, login) {
    if (!login) return null;
    // Сначала — точное совпадение с ТЕКУЩИМ активным логином на ключе.
    for (const k of keysData.keys) {
        const idx = k.users.findIndex(u => u.login === login);
        if (idx >= 0) return { key: k, userIndex: idx };
    }
    // Если не нашли — возможно, targetLogin это СТАРЫЙ логин, под которым
    // раньше заходили с этого же устройства/ключа (accountsHistory), а сейчас
    // с того же устройства уже зашли под ДРУГИМ логином. Бан должен
    // относиться к устройству/ключу, а не к конкретной строке логина —
    // иначе бан тривиально обходится пересозданием аккаунта на том же
    // устройстве с тем же ключом (ключ продолжает работать как ни в чём
    // не бывало). Замораживаем ключ через его ТЕКУЩЕГО активного пользователя.
    for (const k of keysData.keys) {
        const idx = k.users.findIndex(u =>
            Array.isArray(u.accountsHistory) && u.accountsHistory.some(h => h.login === login)
        );
        if (idx >= 0) return { key: k, userIndex: idx };
    }
    return null;
}

// Применяет последствия бана к системе ключей.
//  - Ключ на 1 устройство  → замораживается целиком (сохраняем остаток срока),
//    статус ключа становится "banned", карточка пропадает из активных.
//  - Ключ на 2+ устройств (а также "без ограничений", maxDevices === 0) →
//    деактивируется НАВСЕГДА только этот конкретный пользователь, остальные
//    продолжают пользоваться ключом как обычно.
// Возвращает { key, maxDevices } для передачи клиенту, либо null если у
// пользователя не было активного ключа.
function applyBanToKey(targetLogin, reasonText) {
    const keysData = loadKeys();
    const found = findKeyBoundToLogin(keysData, targetLogin);
    if (!found) return null;

    const k = found.key;
    const boundUser = k.users[found.userIndex];
    const status = getKeyStatus(k);
    // Ключ уже истёк/заморожен — банить тут уже нечего.
    if (status === 'expired' || status === 'banned') return null;

    const reason = (reasonText || '').substring(0, 30);
    let resultKeyInfo;

    if (k.maxDevices === 1) {
        // ── Заморозка ключа на 1 устройство ──
        let remainingMs;
        if (!k.expiryAt || k.expiryAt === 'forever') {
            remainingMs = -1; // маркер "ключ навсегда"
        } else {
            remainingMs = new Date(k.expiryAt).getTime() - Date.now();
            if (remainingMs < 0) remainingMs = 0;
        }

        k.users.splice(found.userIndex, 1);
        k.banFreeze = {
            bindId: boundUser.bindId || '',
            device: boundUser.device || 'Android',
            loginAt: boundUser.loginAt || '',
            login: boundUser.login || targetLogin,
            userId: boundUser.userId || '',
            accountsHistory: boundUser.accountsHistory || [],
            remainingMs: remainingMs,
            reason: reason,
            frozenAt: now()
        };
        resultKeyInfo = { key: k.key, maxDevices: 1 };
        if (k.botKey) syncBotKeyStatus(k.key, 'blocked', reason);
    } else {
        // ── Перманентная деактивация одного пользователя на ключе 2+ устройств ──
        // Сохраняем полный снимок данных пользователя (как и в banFreeze для
        // ключей на 1 устройство), чтобы админка могла показать всю информацию
        // о заблокированном пользователе, а не только его логин.
        if (!k.deactivatedUsers) k.deactivatedUsers = [];
        k.deactivatedUsers.push({
            login: boundUser.login || targetLogin,
            userId: boundUser.userId || '',
            bindId: boundUser.bindId || '',
            device: boundUser.device || 'Android',
            loginAt: boundUser.loginAt || '',
            accountsHistory: boundUser.accountsHistory || [],
            reason: reason || 'Блокировка аккаунта администратором',
            deactivatedAt: now(),
            notified: false,
            viaBan: true
        });
        k.users.splice(found.userIndex, 1);
        // ВАЖНО: НЕ выставляем k.deactivated = true здесь. Бан пользователя —
        // это не админская деактивация ключа. Если после бана у ключа
        // не осталось активных пользователей, статус должен стать "inactive"
        // ("Не активен"), а не "deactivated" ("Деактивирован"), чтобы ключ
        // оставался полностью рабочим и ждал входа других пользователей.
        resultKeyInfo = { key: k.key, maxDevices: k.maxDevices };
        // Бот-ключи всегда maxDevices===1, так что сюда попасть в теории не
        // должны, но на всякий случай синхронизируем и здесь.
        if (k.botKey && k.users.length === 0) syncBotKeyStatus(k.key, 'blocked', reason);
    }

    saveKeys(keysData);
    return resultKeyInfo;
}

// Откатывает заморозку ключа после снятия бана (вручную администратором).
// Если на момент блокировки у ключа оставалось ≤30 минут — ключ не
// восстанавливается. Если пользователь тем временем ЛЮБЫМ способом обзавёлся
// другим активным ключом (получил новый через бота по истечении кулдауна,
// либо администратор вручную выдал/создал ему ключ на другой аккаунт) —
// старый замороженный ключ тоже не восстанавливается, чтобы у пользователя
// не оказалось два рабочих ключа одновременно. Проверяем это динамически
// прямо здесь, а не заранее выставленным флагом — так учитываются ВСЕ пути
// получения нового ключа, а не только выдача через бота.
// Возвращает: 'restored' | 'too_little_time' | 'superseded' | 'not_found'.
function restoreKeyAfterUnban(targetLogin) {
    if (!targetLogin) return 'not_found';
    const keysData = loadKeys();
    let changed = false;
    let result = 'not_found';
    const nowMs = Date.now();

    for (const k of keysData.keys) {
        if (!keyBanFreezeMatchesLogin(k, targetLogin)) continue;

        const hasOtherActiveKey = keysData.keys.some(k2 =>
            k2 !== k &&
            !k2.deleted &&
            !k2.deactivated &&
            !k2.banFreeze &&
            (!k2.expiryAt || k2.expiryAt === 'forever' || new Date(k2.expiryAt).getTime() > nowMs) &&
            Array.isArray(k2.users) &&
            k2.users.some(u => u.login === targetLogin)
        );

        if (hasOtherActiveKey) {
            k.banFreeze = null;
            changed = true;
            result = 'superseded';
            break;
        }

        const remainingMs = k.banFreeze.remainingMs;
        if (remainingMs !== -1 && remainingMs <= BAN_RESTORE_THRESHOLD_MS) {
            // Слишком мало оставалось — ключ не восстанавливаем, переводим
            // его в терминальное состояние "истёк".
            k.expiryAt = now();
            k.banFreeze = null;
            // Снимаем метку "blocked" в bot_keys.json — реальный статус теперь
            // определится по истёкшему сроку (getBotKeyStatus сам это увидит).
            if (k.botKey) syncBotKeyStatus(k.key, 'expired', '');
            result = 'too_little_time';
        } else {
            k.users.push({
                bindId: k.banFreeze.bindId,
                device: k.banFreeze.device || 'Android',
                loginAt: k.banFreeze.loginAt,
                login: k.banFreeze.login,
                userId: k.banFreeze.userId,
                accountsHistory: k.banFreeze.accountsHistory || []
            });
            k.expiryAt = remainingMs === -1 ? 'forever' : new Date(Date.now() + remainingMs).toISOString();
            k.deactivated = false;
            k.banFreeze = null;
            if (k.botKey) syncBotKeyStatus(k.key, 'active', '');
            result = 'restored';
        }
        changed = true;
        break; // один логин может быть привязан только к одному ключу
    }

    if (changed) saveKeys(keysData);
    return result;
}

function evictExpiredKeyUsers() {
    const data = loadKeys();
    let changed = false;
    for (const k of data.keys) {
        const status = getKeyStatus(k);
        if (status === 'expired' && k.users.length > 0) {
            if (!k.expiredUsers) k.expiredUsers = [];
            for (const u of k.users) {
                const already = k.expiredUsers.find(e => e.login === u.login || e.bindId === u.bindId);
                if (!already) k.expiredUsers.push(u);
            }
            k.users = [];
            changed = true;
        }
    }
    if (changed) saveKeys(data);
}

setInterval(evictExpiredKeyUsers, 60 * 1000);
evictExpiredKeyUsers();

// POST /admin/keys/create
app.post('/admin/keys/create', requireAdmin, (req, res) => {
    const { maxDevices, expiryDays, expiryMinutes } = req.body || {};

    const data = loadKeys();
    let keyValue;
    let attempts = 0;
    do {
        keyValue = generateKey();
        attempts++;
    } while (data.keys.find(k => k.key === keyValue) && attempts < 100);

    const newKey = {
        key: keyValue,
        createdAt: now(),
        maxDevices: maxDevices || 0,
        expiryDays: expiryDays || 0,
        expiryMinutes: expiryMinutes || 0,
        expiryAt: null,
        users: []
    };

    data.keys.push(newKey);
    saveKeys(data);
    return res.json({ status: 'ok', key: keyValue });
});

// POST /admin/keys/list
app.post('/admin/keys/list', requireAdmin, (req, res) => {
    evictExpiredKeyUsers();
    cleanupExpiredPunishments();
    const data = loadKeys();
    const users = loadUsers();
    const tgLinks = loadTelegramLinks();

    // Ключи, выданные ботом, хранятся и здесь (с флагом botKey: true) —
    // это нужно только для валидации входа. В разделе Key System (админ)
    // они не должны отображаться — для них есть отдельный раздел
    // «Ключи, созданные ботом» (/admin/bot/keys/list).
    data.keys = data.keys.filter(k => !k.botKey);

    // Собираем множество забаненных логинов для быстрой проверки статуса
    const bannedSet = new Set();
    for (const [login, u] of Object.entries(users)) {
        if (u.ban) bannedSet.add(login);
    }

    // Вспомогательная функция: возвращает объект с Telegram-данными для
    // указанного bindId (deviceId). Включает текущие ник/юзернейм и
    // последнее изменение каждого (если менялось) — для отображения
    // «старое → новое» в карточке ключа и профиле пользователя.
    function getTelegramInfo(bindId) {
        if (!bindId) return null;
        const tg = tgLinks.verifiedDevices[bindId];
        if (!tg) return null;

        function lastChange(history) {
            if (!history || history.length === 0) return null;
            return history[history.length - 1]; // { old, new, changedAt }
        }

        return {
            id:        tg.telegramId || '',
            username:  tg.username   || '',
            firstName: tg.firstName  || '',
            verifiedAt: tg.verifiedAt || '',
            lastUsernameChange:  lastChange(tg.usernameHistory),
            lastFirstNameChange: lastChange(tg.firstNameHistory)
        };
    }

    const result = data.keys.map(k => ({
        key: k.key,
        status: getKeyStatus(k),
        maxDevices: k.maxDevices,
        expiryDays: k.expiryDays,
        expiryMinutes: k.expiryMinutes || 0,
        createdAt: k.createdAt,
        expiryAt: k.expiryAt,
        usersCount: k.users.length,
        // Для каждого устройства добавляем флаг isBanned для текущего активного логина,
        // обогащаем accountsHistory статусом бана, и добавляем Telegram-данные.
        users: k.users.map(u => ({
            ...u,
            isBanned: u.login ? bannedSet.has(u.login) : false,
            telegram: getTelegramInfo(u.bindId),
            accountsHistory: (u.accountsHistory || []).map(h => ({
                ...h,
                isBanned: bannedSet.has(h.login),
                isActive: h.login === u.login
            }))
        })),
        // Пользователь, из-за бана которого ключ (рассчитанный на 1 устройство)
        // был полностью заморожен. null, если такой заморозки нет.
        bannedUser: k.banFreeze ? {
            bindId: k.banFreeze.bindId,
            device: k.banFreeze.device,
            loginAt: k.banFreeze.loginAt,
            login: k.banFreeze.login,
            userId: k.banFreeze.userId,
            accountsHistory: k.banFreeze.accountsHistory || [],
            reason: k.banFreeze.reason,
            frozenAt: k.banFreeze.frozenAt,
            restorable: k.banFreeze.remainingMs === -1 || k.banFreeze.remainingMs > BAN_RESTORE_THRESHOLD_MS,
            telegram: getTelegramInfo(k.banFreeze.bindId)
        } : null,
        // Пользователи, навсегда отключённые от ключа (вручную админом или
        // автоматически через бан — см. viaBan) на ключах с 2+ устройств.
        deactivatedUsers: (k.deactivatedUsers || []).map(u => ({
            login: u.login || '',
            userId: u.userId || '',
            bindId: u.bindId || '',
            device: u.device || '',
            loginAt: u.loginAt || '',
            accountsHistory: (u.accountsHistory || []).map(h => ({
                ...h,
                isBanned: bannedSet.has(h.login),
                isActive: h.login === u.login
            })),
            reason: u.reason || '',
            deactivatedAt: u.deactivatedAt || '',
            viaBan: !!u.viaBan,
            telegram: getTelegramInfo(u.bindId)
        }))
    }));
    return res.json({ status: 'ok', keys: result });
});

// POST /admin/keys/delete
app.post('/admin/keys/delete', requireAdmin, (req, res) => {
    const { key, reason } = req.body || {};
    if (!key) return res.status(400).json({ status: 'error', message: 'Укажите ключ' });
    // reason необязателен — если не указан, пользователи увидят окно без строки "Причина"

    const data = loadKeys();
    const idx = data.keys.findIndex(k => k.key === key);
    if (idx < 0) return res.status(404).json({ status: 'error', message: 'Ключ не найден' });

    const removedKey = data.keys[idx];

    // Собираем всех пользователей этого ключа (активных и уже деактивированных),
    // чтобы выкинуть с аккаунтов абсолютно всех, кто был привязан к ключу.
    const affectedUsers = [];
    for (const u of (removedKey.users || [])) {
        affectedUsers.push({ login: u.login || '', userId: u.userId || '', bindId: u.bindId || '' });
    }
    for (const u of (removedKey.deactivatedUsers || [])) {
        affectedUsers.push({ login: u.login || '', userId: u.userId || '', bindId: u.bindId || '' });
    }

    // Сохраняем запись об удалении: причина + кого выкинуть + сам ключ
    // (чтобы при попытке ввести этот же ключ показать "ключ удалён").
    const deletedData = loadDeletedKeys();
    deletedData.records.push({
        key: removedKey.key,
        reason: reason.trim(),
        deletedAt: now(),
        users: affectedUsers
    });
    saveDeletedKeys(deletedData);

    data.keys.splice(idx, 1);
    saveKeys(data);
    return res.json({ status: 'ok', message: 'Ключ удалён', affectedCount: affectedUsers.length });
});

// POST /admin/keys/deactivate-user — деактивировать ключ для конкретного пользователя
app.post('/admin/keys/deactivate-user', requireAdmin, (req, res) => {
    const { userLogin, userId, reason } = req.body || {};
    if (!userLogin && !userId) {
        return res.status(400).json({ status: 'error', message: 'Укажите логин или ID пользователя' });
    }
    if (!reason) {
        return res.status(400).json({ status: 'error', message: 'Укажите причину деактивации' });
    }

    const data = loadKeys();
    let found = false;

    for (const k of data.keys) {
        // Find user in this key's users array
        const userIdx = k.users.findIndex(u =>
            (userLogin && u.login === userLogin) ||
            (userId && u.userId === userId)
        );
        if (userIdx >= 0) {
            found = true;
            const removedUser = k.users[userIdx];

            // Add to deactivated list on this key
            if (!k.deactivatedUsers) k.deactivatedUsers = [];
            k.deactivatedUsers.push({
                login: removedUser.login || userLogin || '',
                userId: removedUser.userId || userId || '',
                bindId: removedUser.bindId || '',
                device: removedUser.device || 'Android',
                loginAt: removedUser.loginAt || '',
                accountsHistory: removedUser.accountsHistory || [],
                reason: reason,
                deactivatedAt: new Date().toISOString(),
                notified: false   // false = пользователь ещё не видел окно деактивации
            });

            // Remove from active users
            k.users.splice(userIdx, 1);

            // Статус "Деактивирован" для ВСЕГО ключа должен ставиться только если
            // ключ рассчитан ровно на 1 устройство — тогда деактивация единственного
            // пользователя действительно "убивает" ключ навсегда. Если ключ
            // рассчитан на 2+ устройств (или без ограничений, maxDevices === 0),
            // деактивация одного пользователя не должна влиять на статус всего
            // ключа — он остаётся активным и ждёт вход остальных пользователей,
            // даже если временно k.users опустел (последний по времени активный
            // пользователь был как раз тем, кого деактивировали).
            if (k.users.length === 0 && k.maxDevices === 1) {
                k.deactivated = true;
                // Если это бот-ключ — синхронизируем деактивацию в bot_keys.json,
                // иначе бот и раздел «Ключи, созданные ботом» продолжат считать
                // ключ активным и не включат кулдаун на получение нового.
                if (k.botKey) syncBotKeyStatus(k.key, 'deactivated', reason);
            }

            break; // deactivate only one user per request
        }
    }

    if (!found) {
        return res.status(404).json({ status: 'error', message: 'Пользователь не найден ни в одном ключе' });
    }

    saveKeys(data);
    return res.json({ status: 'ok', message: 'Пользователь деактивирован' });
});

// POST /keys/validate
app.post('/keys/validate', (req, res) => {
    const { key, deviceId } = req.body || {};
    if (!key) return res.status(400).json({ status: 'error', message: 'Введите ключ' });

    // Проверяем — не был ли этот ключ удалён администратором ранее.
    // Такой ключ больше нельзя использовать повторно.
    const deletedData = loadDeletedKeys();
    const deletedRec = deletedData.records.find(r => r.key === key);
    if (deletedRec) {
        return res.status(403).json({
            status: 'key_deleted',
            message: 'Ключ был удалён администратором. Можете ввести только новый ключ.'
        });
    }

    evictExpiredKeyUsers();
    const data = loadKeys();
    const k = data.keys.find(entry => entry.key === key);

    if (!k) return res.status(404).json({ status: 'error', message: 'Ключ не найден' });

    const status = getKeyStatus(k);
    if (status === 'expired') {
        return res.status(403).json({ status: 'error', message: 'Срок действия ключа истёк' });
    }
    if (status === 'banned') {
        return res.status(403).json({
            status: 'banned',
            message: 'Доступ к этому ключу заблокирован из-за бана пользователя.'
        });
    }
    if (status === 'deactivated') {
        // Ключ деактивирован администратором целиком (актуально для ключей на
        // 1 устройство — после деактивации единственного пользователя k.users
        // пуст, и без этой проверки СОВЕРШЕННО НОВОЕ устройство могло бы
        // привязаться к уже деактивированному ключу, создав пустую запись
        // без логина — устройство ниже просто получит сообщение об отказе.
        return res.status(403).json({
            status: 'deactivated',
            message: 'Ключ деактивирован администратором'
        });
    }

    if (deviceId) {
        // Проверяем — этот deviceId уже привязан к этому ключу (повторный вход)
        const existingUser = k.users.find(u => u.bindId === deviceId);
        if (existingUser) {
            // Проверяем — не деактивирован ли этот пользователь
            if (k.deactivatedUsers) {
                const deactivated = k.deactivatedUsers.find(u => u.bindId === deviceId);
                if (deactivated) {
                    return res.status(403).json({
                        status: 'deactivated',
                        message: deactivatedUserMessage(deactivated)
                    });
                }
            }
            // Это действующий ключ — снимаем возможную старую отметку
            // "ключ был удалён" и "деактивирован" на всякий случай.
            clearDeactivationMark(deviceId, existingUser.login || null);
            clearDeletedKeyMark(deviceId, existingUser.login || null);
            return res.json({ status: 'ok', message: 'Ключ действителен' });
        }

        // Проверяем — не был ли этот deviceId деактивирован на этом ключе
        if (k.deactivatedUsers) {
            const deactivated = k.deactivatedUsers.find(u => u.bindId === deviceId);
            if (deactivated) {
                return res.status(403).json({
                    status: 'deactivated',
                    message: deactivatedUserMessage(deactivated)
                });
            }
        }

        // Проверяем — есть ли у этого устройства уже активный ключ (любой другой)
        const activeKeyForDevice = data.keys.find(otherKey => {
            if (otherKey.key === key) return false;
            if (getKeyStatus(otherKey) === 'expired') return false;
            return otherKey.users.some(u => u.bindId === deviceId);
        });
        if (activeKeyForDevice) {
            return res.status(403).json({
                status: 'already_has_key',
                message: 'У вас уже есть активный ключ'
            });
        }

        if (k.maxDevices > 0 && k.users.length >= k.maxDevices) {
            return res.status(403).json({ status: 'error', message: 'Достигнут лимит устройств для этого ключа' });
        }
        const newUser = {
            bindId: deviceId,
            device: 'Android',
            loginAt: now(),
            login: '',
            userId: '',
            // История всех аккаунтов (логинов), когда-либо созданных/использованных
            // ЭТИМ устройством на ЭТОМ конкретном ключе. Лимит — максимум 3 разных
            // логина на пару (ключ + устройство). Новый ключ на том же устройстве
            // начинает свой собственный отдельный счётчик.
            accountsHistory: []
        };
        k.users.push(newUser);
        if (!k.expiryAt) {
            let durationMs = 0;
            if (k.expiryMinutes && k.expiryMinutes > 0) {
                durationMs = k.expiryMinutes * 60 * 1000;
            } else if (k.expiryDays && k.expiryDays > 0) {
                durationMs = k.expiryDays * 24 * 3600 * 1000;
            }
            k.expiryAt = durationMs > 0
                ? new Date(Date.now() + durationMs).toISOString()
                : 'forever';
        }
        saveKeys(data);

        // Пользователь успешно привязался к новому ключу — снимаем старую
        // метку деактивации (если она была на предыдущем ключе) и метку удаления.
        clearDeactivationMark(deviceId, null);
        clearDeletedKeyMark(deviceId, null);
    }

    return res.json({ status: 'ok', message: 'Ключ активирован' });
});

// POST /keys/check-deactivated — проверка деактивации пользователя (используется в heartbeat)
app.post('/keys/check-deactivated', (req, res) => {
    const { login, deviceId } = req.body || {};
    if (!login && !deviceId) return res.status(400).json({ status: 'error' });

    const data = loadKeys();
    for (const k of data.keys) {
        if (!k.deactivatedUsers) continue;
        const deactivated = k.deactivatedUsers.find(u =>
            (login && u.login === login) ||
            (deviceId && u.bindId === deviceId)
        );
        if (!deactivated) continue;

        // Выкидываем только если пользователь ещё не видел окно деактивации.
        // Как только он нажмёт "Хорошо" — клиент вызовет /keys/deactivated-ack
        // и выставит notified: true, после чего heartbeat его больше не трогает.
        if (deactivated.notified === true) continue;

        return res.json({
            status: 'deactivated',
            reason: deactivated.reason,
            viaBan: !!deactivated.viaBan,
            message: deactivatedUserMessage(deactivated)
        });
    }
    return res.json({ status: 'ok' });
});

// POST /keys/deactivated-ack — пользователь подтвердил получение уведомления о деактивации
// (нажал "Хорошо" в окне). После этого heartbeat перестаёт его выкидывать,
// но попытка снова войти с тем же ключом всё равно будет заблокирована в /keys/validate.
app.post('/keys/deactivated-ack', (req, res) => {
    const { login, deviceId } = req.body || {};
    if (!login && !deviceId) return res.status(400).json({ status: 'error' });

    const data = loadKeys();
    let changed = false;
    for (const k of data.keys) {
        if (!k.deactivatedUsers) continue;
        const deactivated = k.deactivatedUsers.find(u =>
            (login && u.login === login) ||
            (deviceId && u.bindId === deviceId)
        );
        if (deactivated && !deactivated.notified) {
            deactivated.notified = true;
            changed = true;
        }
    }
    if (changed) saveKeys(data);
    return res.json({ status: 'ok' });
});

// POST /keys/check-deleted — проверка удаления ключа (используется в heartbeat).
// Если ключ пользователя был удалён администратором — выкидываем с аккаунта ВСЕХ,
// кто был привязан к этому ключу, независимо от того, онлайн они или офлайн
// (офлайн-пользователи получат этот ответ при следующем заходе/heartbeat).
app.post('/keys/check-deleted', (req, res) => {
    const { login, deviceId } = req.body || {};
    if (!login && !deviceId) return res.status(400).json({ status: 'error' });

    const deletedData = loadDeletedKeys();
    for (const rec of deletedData.records) {
        const match = rec.users.find(u =>
            (login && u.login === login) ||
            (deviceId && u.bindId === deviceId)
        );
        if (match) {
            return res.json({
                status: 'key_deleted',
                reason: rec.reason,
                message: 'Ключ был удалён администратором.\n\nПричина: ' + rec.reason
            });
        }
    }
    return res.json({ status: 'ok' });
});

// POST /keys/check-expired — проверка истечения срока ключа (используется в heartbeat).
// Если expiryAt ключа уже прошёл — выкидываем пользователя с аккаунта.
app.post('/keys/check-expired', (req, res) => {
    const { login, deviceId } = req.body || {};
    if (!login && !deviceId) return res.status(400).json({ status: 'error' });

    const data = loadKeys();
    for (const k of data.keys) {
        if (getKeyStatus(k) !== 'expired') continue;
        const allUsers = (k.users || []).concat(k.expiredUsers || []);
        const match = allUsers.find(u =>
            (login && u.login === login) ||
            (deviceId && u.bindId === deviceId)
        );
        if (match) {
            return res.json({ status: 'key_expired' });
        }
    }
    return res.json({ status: 'ok' });
});

// POST /check-account-exists — проверка наличия аккаунта в системе.
// Используется при автологине по сохранённой сессии (например, после
// удаления и переустановки приложения / восстановления из бэкапа), чтобы
// понять — существует ли этот логин ещё в базе пользователей сервера.
app.post('/check-account-exists', (req, res) => {
    const { login } = req.body || {};
    if (!login) return res.status(400).json({ status: 'error' });

    if (login === ADMIN_LOGIN) {
        return res.json({ status: 'ok', exists: true });
    }

    const users = loadUsers();
    return res.json({ status: 'ok', exists: !!users[login] });
});

// POST /keys/check-membership — проверка того, привязан ли сейчас этот
// логин/устройство хотя бы к одному действующему ключу. Используется при
// автологине, чтобы отличить ситуацию "ключ реально удалён/деактивирован
// администратором" (для которой есть отдельные окна с причиной) от ситуации
// "по этому аккаунту в принципе нет ни одного ключа" (например, рассинхрон
// данных после обновления сервера) — во втором случае просто разлогиниваем
// без показа диалога с причиной.
app.post('/keys/check-membership', (req, res) => {
    const { login, deviceId } = req.body || {};
    if (!login && !deviceId) return res.status(400).json({ status: 'error' });

    const data = loadKeys();
    for (const k of data.keys) {
        const match = (k.users || []).find(u =>
            (login && u.login === login) ||
            (deviceId && u.bindId === deviceId)
        );
        if (match) {
            return res.json({ status: 'ok', hasKey: true });
        }
    }
    return res.json({ status: 'ok', hasKey: false });
});

// POST /check-banned — проверка бана аккаунта (используется в heartbeat и
// при автологине по сохранённой сессии). Покрывает оба сценария из задачи:
//  1) пользователь онлайн в момент бана — heartbeat поймает это в течение
//     ближайшего тика и выкинет его с показом окна о бане;
//  2) пользователь был offline, когда его забанили — при следующем заходе
//     (даже по сохранённой локальной сессии) сервер также вернёт банен,
//     и его не пустят внутрь приложения.
app.post('/check-banned', (req, res) => {
    const { login, deviceId } = req.body || {};
    if (!login && !deviceId) return res.status(400).json({ status: 'error' });

    // Перманентный бан переживает удаление/пересоздание аккаунта
    if (isPermBanned(login, deviceId)) {
        return res.json({
            status: 'banned',
            selfBanned: true,
            ban: { until: 'permanent', reason: 'Перманентный бан' },
            user_id: login ? getUserId(login) : ''
        });
    }

    cleanupExpiredPunishments();
    const users = loadUsers();
    const user = login ? users[login] : null;

    if (user && user.ban) {
        return res.json({ status: 'banned', selfBanned: true, ban: user.ban, user_id: getUserId(login) });
    }

    // Пользователь под ТЕКУЩИМ логином сам не забанен, но ключ, которым он
    // пользуется, мог быть заморожен из-за бана СТАРОГО логина с этого же
    // устройства (см. keyBanFreezeMatchesLogin / findKeyBoundToLogin) —
    // например, человек перерегистрировался под новым именем на том же
    // ключе. В таком случае ключ всё равно не работает, и об этом нужно
    // сообщить, используя данные бана исходного (забаненного) логина, но
    // помечая ответ как selfBanned:false — клиент покажет другое, более
    // краткое уведомление вместо полноэкранного BannedActivity.
    if (login) {
        const keysData = loadKeys();
        for (const k of keysData.keys) {
            if (keyBanFreezeMatchesLogin(k, login) && k.banFreeze.login !== login) {
                const originalBan = (users[k.banFreeze.login] && users[k.banFreeze.login].ban)
                    ? users[k.banFreeze.login].ban
                    : { until: 'permanent', reason: k.banFreeze.reason || '', keyInfo: { key: k.key, maxDevices: k.maxDevices || 1 } };
                return res.json({
                    status: 'banned',
                    selfBanned: false,
                    bannedLogin: k.banFreeze.login,
                    bannedUserId: (users[k.banFreeze.login] && users[k.banFreeze.login].userId) || '',
                    ban: originalBan,
                    user_id: getUserId(login)
                });
            }
        }
    }

    // Запасной путь — ищем по deviceId, на случай если login ещё не известен
    if (!user && deviceId) {
        const activeBan = findActiveBanByDevice(users, deviceId);
        if (activeBan) {
            return res.json({
                status: 'banned',
                selfBanned: true,
                ban: activeBan.ban,
                user_id: activeBan.login ? getUserId(activeBan.login) : ''
            });
        }
    }

    return res.json({ status: 'ok' });
});

// POST /keys/update-user
app.post('/keys/update-user', (req, res) => {
    const { key, deviceId, login, userId } = req.body || {};
    if (!key || !deviceId) return res.status(400).json({ status: 'error' });

    const data = loadKeys();
    const k = data.keys.find(entry => entry.key === key);
    if (!k) return res.status(404).json({ status: 'error' });

    const user = k.users.find(u => u.bindId === deviceId);
    if (user) {
        const prevLogin = user.login;

        // Обновляем текущий логин/userId (текущий активный аккаунт на этом устройстве)
        if (login) user.login = login;
        if (userId) user.userId = userId;

        // Ведём историю всех аккаунтов, когда-либо использовавших этот ключ
        // на этом конкретном устройстве. Если логин изменился (пользователь вышел
        // и зашёл/зарегистрировал другой аккаунт) — добавляем запись в историю.
        if (!user.accountsHistory) user.accountsHistory = [];
        if (login && login.trim()) {
            const exists = user.accountsHistory.find(h => h.login === login);
            if (!exists) {
                user.accountsHistory.push({
                    login:    login,
                    userId:   userId || '',
                    firstAt:  now(),
                    device:   user.device || 'Android',
                    bindId:   user.bindId || deviceId,
                });
            } else {
                // Обновляем userId если он поменялся (например, при восстановлении)
                if (userId && !exists.userId) exists.userId = userId;
            }
        }

        saveKeys(data);
    }

    // Логин пользователя на этом ключе теперь известен — снимаем возможные
    // старые метки "ключ был удалён" и "деактивирован" от предыдущих ключей.
    clearDeactivationMark(deviceId, login || null);
    clearDeletedKeyMark(deviceId, login || null);

    // Если это бот-ключ — синхронизируем данные пользователя в bot_keys.json.
    // ВАЖНО: accountsHistory (история всех логинов, когда-либо заходивших с
    // этого устройства на этот ключ) раньше сюда не копировалась — из-за
    // этого в разделе «Ключи, созданные ботом» кнопка "Все аккаунты, где
    // использовался этот ключ" никогда не появлялась, даже если реально
    // заходили с нескольких аккаунтов. `user` — тот же объект из основной
    // системы (keys.json), который мы только что обновили выше.
    if (k.botKey) {
        const botData = loadBotKeys();
        const bk = botData.keys.find(bkEntry => bkEntry.key === key);
        if (bk) {
            bk.status = 'active';
            if (!bk.users) bk.users = [];
            const bkUser = bk.users.find(u => u.bindId === deviceId);
            const accountsHistorySnapshot = (user && user.accountsHistory) ? user.accountsHistory : [];
            if (!bkUser) {
                bk.users.push({
                    login:   login || '',
                    userId:  userId || '',
                    device:  (k.users.find(u => u.bindId === deviceId) || {}).device || 'Android',
                    bindId:  deviceId,
                    loginAt: now(),
                    accountsHistory: accountsHistorySnapshot
                });
            } else {
                if (login)  bkUser.login  = login;
                if (userId) bkUser.userId = userId;
                bkUser.accountsHistory = accountsHistorySnapshot;
            }
            saveBotKeys(botData);
        }
    }

    return res.json({ status: 'ok' });
});

// ══════════════════════════════════════════════════════════════
//  БОТ-КЛЮЧИ: эндпоинты для приложения
// ══════════════════════════════════════════════════════════════

// POST /bot/keys/list — список бот-ключей для конкретного telegramId
// (используется в разделе «Ключи, созданные ботом» в приложении).
// Идентифицируем пользователя по его токену привязки (deviceId → telegramId).
app.post('/bot/keys/list', (req, res) => {
    const { login, password, deviceId } = req.body || {};
    if (!login || !password || !deviceId) return res.json({ status: 'error', keys: [] });

    // Проверяем логин/пароль
    const users = loadUsers();
    const u = users[login];
    if (!u || u.password !== password) return res.json({ status: 'error', keys: [] });

    // Находим telegramId по deviceId
    const tgLinks = loadTelegramLinks();
    const vd = tgLinks.verifiedDevices[deviceId];
    if (!vd || !vd.telegramId) return res.json({ status: 'ok', keys: [] });

    const telegramId = String(vd.telegramId);
    const data = loadBotKeys();
    const result = data.keys
        .filter(k => String(k.telegramId) === telegramId && !k.deleted)
        .map(k => ({
            key: k.key,
            status: getBotKeyStatus(k),
            maxDevices: 1,
            expiryDays: k.expiryDays || 1488,
            createdAt: k.createdAt,
            expiryAt: k.expiryAt,
            users: k.users || [],
            deactivatedAt: k.deactivatedAt || null,
            reason: k.reason || ''
        }));

    return res.json({ status: 'ok', keys: result });
});

// POST /bot/keys/deactivate — деактивация бот-ключа пользователем
app.post('/bot/keys/deactivate', (req, res) => {
    const { login, password, deviceId, key } = req.body || {};
    if (!login || !password || !deviceId || !key) return res.json({ status: 'error' });

    const users = loadUsers();
    const u = users[login];
    if (!u || u.password !== password) return res.json({ status: 'error' });

    const tgLinks = loadTelegramLinks();
    const vd = tgLinks.verifiedDevices[deviceId];
    if (!vd || !vd.telegramId) return res.json({ status: 'error', message: 'Telegram не привязан' });

    const data = loadBotKeys();
    const k = data.keys.find(bk => bk.key === key && String(bk.telegramId) === String(vd.telegramId));
    if (!k) return res.json({ status: 'error', message: 'Ключ не найден' });

    k.status = 'deactivated';
    k.deactivatedAt = now();
    k.reason = 'Деактивирован пользователем';
    k.cooldownUntil = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString(); // 10 часов
    saveBotKeys(data);

    // Также деактивируем этот ключ в основной системе ключей если он там есть
    const keysData = loadKeys();
    const mainKey = keysData.keys.find(mk => mk.key === key);
    if (mainKey) {
        mainKey.deactivated = true;
        saveKeys(keysData);
    }

    return res.json({ status: 'ok' });
});

// POST /admin/bot/keys/list — список всех бот-ключей для администратора
app.post('/admin/bot/keys/list', requireAdmin, (req, res) => {
    const data = loadBotKeys();
    const tgLinks = loadTelegramLinks();

    // Тот же набор забаненных логинов, что и в /admin/keys/list — нужен,
    // чтобы подсветить в истории аккаунтов бот-ключа именно тот аккаунт,
    // из-за которого ключ был заблокирован (а не просто "текущий активный").
    const usersData = loadUsers();
    const bannedSet = new Set();
    for (const [login, u] of Object.entries(usersData)) {
        if (u.ban) bannedSet.add(login);
    }

    const result = data.keys.filter(k => !k.deleted).map(k => {
        // Добавляем TG-данные автора ключа
        let tgInfo = null;
        const tid = String(k.telegramId);
        for (const [did, vd] of Object.entries(tgLinks.verifiedDevices)) {
            if (String(vd.telegramId) === tid) {
                tgInfo = { id: tid, username: vd.username || '', firstName: vd.firstName || '' };
                break;
            }
        }
        return {
            key: k.key,
            telegramId: k.telegramId,
            telegram: tgInfo,
            status: getBotKeyStatus(k),
            maxDevices: 1,
            expiryDays: k.expiryDays || 1488,
            createdAt: k.createdAt,
            expiryAt: k.expiryAt,
            // users здесь — "снимок" последнего известного пользователя ключа.
            // Он НЕ очищается при деактивации/бане (в отличие от keys.json),
            // поэтому карточка бот-ключа может показать, кто именно им
            // пользовался, даже когда ключ уже заблокирован.
            users: (k.users || []).map(u => ({
                ...u,
                isBanned: u.login ? bannedSet.has(u.login) : false,
                accountsHistory: (u.accountsHistory || []).map(h => ({
                    ...h,
                    isBanned: bannedSet.has(h.login),
                    isActive: h.login === u.login
                }))
            })),
            deactivatedAt: k.deactivatedAt || null,
            reason: k.reason || '',
            cooldownUntil: k.cooldownUntil || null
        };
    });

    return res.json({ status: 'ok', keys: result });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`ClumsyVPN auth server running on port ${PORT} (0.0.0.0)`);
});
