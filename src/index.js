require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { google } = require('googleapis');
const multer = require('multer');
const { Readable } = require('stream');
const axios = require('axios');
const cheerio = require('cheerio');
const { Document, Packer, Paragraph, TextRun } = require('docx');
const medicalController = require('./MedicalController');
const { validateUserChatMessage } = require('./chatValidation');
const { translateBatch } = require('./services/translationExecutionService');

const upload = multer({ storage: multer.memoryStorage() });

// Trends Cache (30 min)
const trendsCacheByCategory = new Map();
const CACHE_TTL = 30 * 60 * 1000;
const MAX_TRENDS = 12;
const MEDICAL_CONTEXT_CACHE_TTL = 20 * 60 * 1000;
const CONTENT_NOTES_MAX_LENGTH = 2000;
const MEDICAL_CATEGORIES = [
    'Dermatologia',
    'Cirurgia Plástica',
    'Nutrologia',
    'Endocrinologia',
    'Vascular',
    'Cardiologia',
    'Ginecologia',
    'Odontologia',
    'Psiquiatria',
    'Ortopedia',
    'Tricologia',
    'Medicina Integrativa',
    'Estética Médica'
];
const medicalContextCache = new Map();
const conversationContextCache = new Map();
let doctorsContentNotesColumnPromise = null;

const app = express();
const TOOL_DEFINITIONS = [
    { slug: 'gerador-qr', name: 'Gerador de QR Code', shortName: 'QR Code' },
    { slug: 'gerador-whatsapp', name: 'Gerador de link WhatsApp', shortName: 'WhatsApp' },
    { slug: 'color-picker', name: 'Color Picker', shortName: 'Cores' },
    { slug: 'correcao-texto', name: 'Correcao de Texto', shortName: 'Texto' }
];
const SESSION_COOKIE_NAME = 'planejador.sid';
const GOOGLE_AUTH_SCOPES = [
    'profile',
    'email',
    'https://www.googleapis.com/auth/documents',
    // `drive.file` only allows writes to files created/opened by the same OAuth app.
    // Feedback files can be pre-existing, synced from Drive, or edited by other teammates.
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/gmail.send'
];
const USER_SELECT_COLUMNS = `
    id,
    google_id,
    email,
    display_name,
    avatar_url,
    refresh_token,
    created_at,
    updated_at
`;

class GoogleReauthRequiredError extends Error {
    constructor(message, code = 'reauth_required') {
        super(message);
        this.name = 'GoogleReauthRequiredError';
        this.code = code;
    }
}

function resolveSqliteDbPath() {
    const fallbackPath = path.join(__dirname, '../database/metadata.db');
    const configuredPath = String(process.env.DATABASE_URL || fallbackPath).trim();

    if (!configuredPath) return fallbackPath;

    if (/^file:/i.test(configuredPath)) {
        try {
            return decodeURIComponent(new URL(configuredPath).pathname);
        } catch (error) {
            console.warn('[SQLite] DATABASE_URL em formato file: invalido. Usando valor bruto.');
        }
    }

    return configuredPath;
}

function ensureDirectoryForFile(filePath) {
    const targetDirectory = path.dirname(filePath);
    if (!fs.existsSync(targetDirectory)) {
        fs.mkdirSync(targetDirectory, { recursive: true });
    }
}

function normalizeContentNotes(value, options = {}) {
    const normalized = String(value || '').trim();
    if (normalized.length <= CONTENT_NOTES_MAX_LENGTH) return normalized;

    if (options.truncate) {
        return normalized.slice(0, CONTENT_NOTES_MAX_LENGTH).trim();
    }

    const error = new Error(`As observações devem ter no máximo ${CONTENT_NOTES_MAX_LENGTH} caracteres.`);
    error.statusCode = 400;
    throw error;
}

function normalizeComparableText(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeMedicalCategory(value) {
    const normalizedValue = normalizeComparableText(value);
    if (!normalizedValue || normalizedValue === 'todas' || normalizedValue === 'todos') return '';

    return MEDICAL_CATEGORIES.find((category) => normalizeComparableText(category) === normalizedValue) || '';
}

function filterTrendsByMedicalCategory(trends, category) {
    const normalizedCategory = normalizeMedicalCategory(category);
    if (!normalizedCategory) return trends;

    return (Array.isArray(trends) ? trends : []).filter(
        (trend) => normalizeMedicalCategory(trend.category) === normalizedCategory
    );
}

function getTrendsCache(category) {
    const cacheKey = normalizeMedicalCategory(category) || 'Todas';
    const cached = trendsCacheByCategory.get(cacheKey);
    if (!cached || Date.now() - cached.timestamp > CACHE_TTL) {
        trendsCacheByCategory.delete(cacheKey);
        return null;
    }

    return cached.data;
}

function setTrendsCache(category, data) {
    const cacheKey = normalizeMedicalCategory(category) || 'Todas';
    trendsCacheByCategory.set(cacheKey, {
        data,
        timestamp: Date.now()
    });
}

function getCachedMedicalContext(doctorId) {
    try {
        const cacheKey = String(doctorId || '').trim();
        if (!cacheKey) return null;

        const cached = medicalContextCache.get(cacheKey);
        if (!cached) return null;

        if (Date.now() - cached.timestamp > MEDICAL_CONTEXT_CACHE_TTL) {
            medicalContextCache.delete(cacheKey);
            return null;
        }

        return cached.context || null;
    } catch (error) {
        console.warn('[AI] Falha ao ler cache de contexto medico:', error.message);
        return null;
    }
}

function setCachedMedicalContext(doctorId, context) {
    try {
        const cacheKey = String(doctorId || '').trim();
        if (!cacheKey || !context) return;

        medicalContextCache.set(cacheKey, {
            context,
            timestamp: Date.now()
        });
    } catch (error) {
        console.warn('[AI] Falha ao salvar cache de contexto medico:', error.message);
    }
}

function getCachedConversationContext(conversationId) {
    try {
        const cacheKey = String(conversationId || '').trim();
        if (!cacheKey) return null;

        const cached = conversationContextCache.get(cacheKey);
        if (!cached) return null;

        if (Date.now() - cached.timestamp > MEDICAL_CONTEXT_CACHE_TTL) {
            conversationContextCache.delete(cacheKey);
            return null;
        }

        return cached.context || null;
    } catch (error) {
        console.warn('[AI] Falha ao ler cache de contexto da conversa:', error.message);
        return null;
    }
}

function setCachedConversationContext(conversationId, doctorId, context) {
    try {
        const cacheKey = String(conversationId || '').trim();
        if (!cacheKey || !context) return;

        conversationContextCache.set(cacheKey, {
            doctorId: String(doctorId || '').trim(),
            context,
            timestamp: Date.now()
        });
    } catch (error) {
        console.warn('[AI] Falha ao salvar cache de contexto da conversa:', error.message);
    }
}

function invalidateMedicalContextCache(doctorId) {
    try {
        const cacheKey = String(doctorId || '').trim();
        if (!cacheKey) return;

        medicalContextCache.delete(cacheKey);
        for (const [conversationId, cached] of conversationContextCache.entries()) {
            if (String(cached?.doctorId || '') === cacheKey) {
                conversationContextCache.delete(conversationId);
            }
        }
    } catch (error) {
        console.warn('[AI] Falha ao invalidar cache de contexto medico:', error.message);
    }
}

function appendContentNotesToContext(context, contentNotes) {
    const notes = normalizeContentNotes(contentNotes, { truncate: true });
    if (!notes) return context;

    return `${context || ''}

--- OBSERVAÇÕES SOBRE CONTEÚDO DESEJADO ---
${notes}
`;
}

function initializeDoctorsTable() {
    db.run(`
        CREATE TABLE IF NOT EXISTS doctors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            specialty TEXT,
            drive_folder_id TEXT NOT NULL,
            instructions_doc_id TEXT NOT NULL,
            feedback_doc_id TEXT NOT NULL,
            content_notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) {
            console.error("[SQLite] Falha ao garantir a tabela 'doctors':", err.message);
            return;
        }
        console.log("[SQLite] Tabela 'doctors' pronta para uso.");
        ensureDoctorsContentNotesColumn()
            .catch((error) => console.error("[SQLite] Falha ao garantir coluna 'doctors.content_notes':", error.message));
    });
}

function initializeUsersTable() {
    db.serialize(() => {
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                google_id TEXT NOT NULL UNIQUE,
                email TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                avatar_url TEXT,
                refresh_token TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `, (err) => {
            if (err) {
                console.error("[SQLite] Falha ao garantir a tabela 'users':", err.message);
                return;
            }
            console.log("[SQLite] Tabela 'users' pronta para uso.");
        });

        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)`);
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
    });
}

function initializeContentChatTables() {
    db.serialize(() => {
        db.run(`
            CREATE TABLE IF NOT EXISTS content_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                doctor_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                original_prompt TEXT NOT NULL,
                original_content TEXT NOT NULL,
                current_content TEXT NOT NULL,
                trend_url TEXT,
                trend_title TEXT,
                drive_file_id TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `, (err) => {
            if (err) {
                console.error("[SQLite] Falha ao garantir a tabela 'content_sessions':", err.message);
                return;
            }
            console.log("[SQLite] Tabela 'content_sessions' pronta para uso.");
        });

        db.run(`
            CREATE TABLE IF NOT EXISTS content_chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                message TEXT NOT NULL,
                content_snapshot TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `, (err) => {
            if (err) {
                console.error("[SQLite] Falha ao garantir a tabela 'content_chat_messages':", err.message);
                return;
            }
            console.log("[SQLite] Tabela 'content_chat_messages' pronta para uso.");
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_content_sessions_user ON content_sessions(user_id, updated_at)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_content_chat_messages_session ON content_chat_messages(session_id, created_at)`);

        db.run(`
            CREATE TABLE IF NOT EXISTS content_conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                doctor_id INTEGER,
                user_id INTEGER,
                status TEXT DEFAULT 'active',
                original_prompt TEXT NOT NULL,
                content_type TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `, (err) => {
            if (err) {
                console.error("[SQLite] Falha ao garantir a tabela 'content_conversations':", err.message);
                return;
            }
            console.log("[SQLite] Tabela 'content_conversations' pronta para uso.");
        });

        db.run(`
            CREATE TABLE IF NOT EXISTS content_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                message TEXT NOT NULL,
                message_type TEXT DEFAULT 'content',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (conversation_id) REFERENCES content_conversations(id)
            )
        `, (err) => {
            if (err) {
                console.error("[SQLite] Falha ao garantir a tabela 'content_messages':", err.message);
                return;
            }
            console.log("[SQLite] Tabela 'content_messages' pronta para uso.");
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_content_conversations_user ON content_conversations(user_id, updated_at)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_content_messages_conversation ON content_messages(conversation_id, created_at)`);
    });
}

function buildGoogleCallbackUrl() {
    const explicitCallbackUrl = String(process.env.GOOGLE_CALLBACK_URL || '').trim();
    if (explicitCallbackUrl) return explicitCallbackUrl;

    const appUrl = String(process.env.APP_URL || '').trim();
    if (appUrl) {
        return new URL('/auth/google/callback', appUrl).toString();
    }

    return 'http://localhost:3000/auth/google/callback';
}

function extractProfileEmail(profile) {
    return String(profile?.emails?.[0]?.value || profile?._json?.email || '')
        .trim()
        .toLowerCase();
}

function extractProfileAvatar(profile) {
    return String(profile?.photos?.[0]?.value || '').trim();
}

const dbPath = resolveSqliteDbPath();
ensureDirectoryForFile(dbPath);

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error('ERRO AO CONECTAR NO SQLITE:', err.message);
    } else {
        console.log('SQLITE CONECTADO COM SUCESSO EM:', dbPath);
        initializeDoctorsTable();
        initializeUsersTable();
        initializeContentChatTables();
    }
});

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

async function ensureColumnExists(tableName, columnName, columnDefinition) {
    if (!/^[a-zA-Z0-9_]+$/.test(tableName) || !/^[a-zA-Z0-9_]+$/.test(columnName)) {
        throw new Error('Nome de tabela ou coluna invalido.');
    }

    const columns = await dbAll(`PRAGMA table_info(${tableName})`);
    const exists = columns.some((column) => column.name === columnName);

    if (!exists) {
        await dbRun(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
        console.log(`[SQLite] Coluna '${tableName}.${columnName}' adicionada.`);
    }
}

function ensureDoctorsContentNotesColumn() {
    if (!doctorsContentNotesColumnPromise) {
        doctorsContentNotesColumnPromise = ensureColumnExists('doctors', 'content_notes', 'TEXT')
            .catch((error) => {
                doctorsContentNotesColumnPromise = null;
                throw error;
            });
    }

    return doctorsContentNotesColumnPromise;
}

function normalizeAppUser(userRow) {
    return {
        id: userRow.id,
        googleId: String(userRow.google_id || '').trim(),
        email: String(userRow.email || '').trim().toLowerCase(),
        displayName: String(userRow.display_name || userRow.email || 'Usuário').trim(),
        avatarUrl: String(userRow.avatar_url || '').trim()
    };
}

async function getUserById(userId) {
    if (!userId) return null;
    return dbGet(`SELECT ${USER_SELECT_COLUMNS} FROM users WHERE id = ? LIMIT 1`, [userId]);
}

async function getUserByGoogleIdentity(googleId, email) {
    return dbGet(
        `SELECT ${USER_SELECT_COLUMNS}
         FROM users
         WHERE google_id = ? OR email = ?
         LIMIT 1`,
        [googleId, email]
    );
}

async function upsertGoogleUser(profile, refreshToken) {
    const googleId = String(profile?.id || '').trim();
    const email = extractProfileEmail(profile);
    const displayName = String(profile?.displayName || email || 'Usuário').trim();
    const avatarUrl = extractProfileAvatar(profile);

    if (!googleId || !email) {
        throw new Error('Perfil do Google sem identificadores obrigatórios.');
    }

    const existingUser = await getUserByGoogleIdentity(googleId, email);
    const effectiveRefreshToken = String(refreshToken || existingUser?.refresh_token || '').trim() || null;

    if (existingUser?.id) {
        await dbRun(
            `UPDATE users
             SET google_id = ?, email = ?, display_name = ?, avatar_url = ?, refresh_token = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [googleId, email, displayName, avatarUrl || null, effectiveRefreshToken, existingUser.id]
        );
        return getUserById(existingUser.id);
    }

    const insertResult = await dbRun(
        `INSERT INTO users (google_id, email, display_name, avatar_url, refresh_token)
         VALUES (?, ?, ?, ?, ?)`,
        [googleId, email, displayName, avatarUrl || null, effectiveRefreshToken]
    );

    return getUserById(insertResult.lastID);
}

async function clearUserRefreshToken(userId) {
    if (!userId) return;
    await dbRun(
        `UPDATE users
         SET refresh_token = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [userId]
    );
}

function createGoogleOAuthClient(credentials = {}) {
    const auth = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID || '',
        process.env.GOOGLE_CLIENT_SECRET || '',
        buildGoogleCallbackUrl()
    );
    auth.setCredentials(credentials);
    return auth;
}

function createDriveClient(auth) {
    return google.drive({ version: 'v3', auth });
}

function createGmailClient(auth) {
    return google.gmail({ version: 'v1', auth });
}

async function persistRefreshToken(userId, refreshToken) {
    const normalizedRefreshToken = String(refreshToken || '').trim();
    if (!userId || !normalizedRefreshToken) return;

    await dbRun(
        `UPDATE users
         SET refresh_token = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [normalizedRefreshToken, userId]
    );
}

async function getGoogleAuthClientForUser(userId) {
    const userRow = await getUserById(userId);
    if (!userRow?.id) {
        throw new GoogleReauthRequiredError('Usuário não encontrado no banco local.', 'user_not_found');
    }

    const refreshToken = String(userRow.refresh_token || '').trim();
    if (!refreshToken) {
        throw new GoogleReauthRequiredError('Usuário sem refresh token salvo.', 'missing_refresh_token');
    }

    const auth = createGoogleOAuthClient({ refresh_token: refreshToken });
    auth.on('tokens', (tokens) => {
        if (tokens?.refresh_token) {
            persistRefreshToken(userRow.id, tokens.refresh_token).catch((error) => {
                console.error('[Auth] Falha ao persistir refresh token rotacionado:', error.message);
            });
        }
    });

    await auth.getAccessToken();
    return auth;
}

function getGoogleAuthErrorText(error) {
    const responseError = error?.response?.data?.error;
    const responseDescription = error?.response?.data?.error_description;
    const nestedMessage = typeof responseError === 'object' ? responseError.message : responseError;

    return [
        error?.code,
        error?.message,
        nestedMessage,
        responseDescription
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

function isGoogleReauthError(error) {
    if (error instanceof GoogleReauthRequiredError) return true;

    const text = getGoogleAuthErrorText(error);
    return text.includes('invalid_grant')
        || text.includes('invalid credentials')
        || text.includes('token has been expired or revoked')
        || text.includes('reauth');
}

function shouldClearStoredRefreshToken(error) {
    if (error instanceof GoogleReauthRequiredError) return true;
    const text = getGoogleAuthErrorText(error);
    return text.includes('invalid_grant')
        || text.includes('invalid credentials')
        || text.includes('expired or revoked');
}

function isGoogleDriveWriteScopeError(error) {
    const text = getGoogleAuthErrorText(error);
    return text.includes('has not granted the app')
        || text.includes('appnotauthorizedtofile');
}

function saveSession(req) {
    return new Promise((resolve, reject) => {
        req.session.save((error) => {
            if (error) return reject(error);
            resolve();
        });
    });
}

function clearGoogleAuthFlowFlags(req) {
    if (!req.session) return;
    delete req.session.googleAuthForceConsent;
    delete req.session.googleAuthRepairAttempted;
}

function getSessionCookieOptions() {
    return {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/'
    };
}

function destroySession(req, res) {
    return new Promise((resolve, reject) => {
        if (!req.session) {
            res.clearCookie(SESSION_COOKIE_NAME, getSessionCookieOptions());
            return resolve();
        }

        req.session.destroy((error) => {
            if (error) return reject(error);
            res.clearCookie(SESSION_COOKIE_NAME, getSessionCookieOptions());
            resolve();
        });
    });
}

function logoutRequest(req) {
    return new Promise((resolve, reject) => {
        req.logout((error) => {
            if (error) return reject(error);
            resolve();
        });
    });
}

async function logoutAndDestroySession(req, res) {
    await logoutRequest(req);
    await destroySession(req, res);
}

async function handleGoogleApiAuthFailure(req, res, error) {
    if (!isGoogleReauthError(error)) return false;

    console.warn('[Auth] Credenciais Google indisponíveis. Forçando novo login:', error.message);

    if (req.user?.id && shouldClearStoredRefreshToken(error)) {
        try {
            await clearUserRefreshToken(req.user.id);
        } catch (dbError) {
            console.error('[Auth] Falha ao limpar refresh token salvo:', dbError.message);
        }
    }

    try {
        await logoutAndDestroySession(req, res);
    } catch (logoutError) {
        console.error('[Auth] Falha ao destruir sessão expirada:', logoutError.message);
    }

    res.status(401).json({
        error: 'Sua autorização do Google expirou ou foi revogada. Faça login novamente.',
        reauth: true,
        loginUrl: '/login?error=reauth'
    });
    return true;
}

async function handleGoogleDriveWriteScopeFailure(req, res, error) {
    if (!isGoogleDriveWriteScopeError(error)) return false;

    console.warn('[Auth] Escopo do Drive insuficiente para escrita. Solicitando novo consentimento:', error.message);

    if (req.user?.id) {
        try {
            await clearUserRefreshToken(req.user.id);
        } catch (dbError) {
            console.error('[Auth] Falha ao limpar refresh token apos erro de escopo do Drive:', dbError.message);
        }
    }

    try {
        await logoutAndDestroySession(req, res);
    } catch (logoutError) {
        console.error('[Auth] Falha ao destruir sessao apos erro de escopo do Drive:', logoutError.message);
    }

    res.status(403).json({
        error: 'Sua autorização do Google Drive precisa ser atualizada para salvar feedbacks. Faça login novamente e aceite as novas permissões.',
        reauth: true,
        loginUrl: '/auth/google?force_consent=1'
    });
    return true;
}

async function getGoogleAuthOrRespond(req, res) {
    try {
        return await getGoogleAuthClientForUser(req.user?.id);
    } catch (error) {
        const handled = await handleGoogleApiAuthFailure(req, res, error);
        if (handled) return null;
        throw error;
    }
}

function normalizeGenerationRequest(payload = {}) {
    return {
        doctorId: String(payload.doctorId || '').trim(),
        prompt: String(payload.prompt || '').trim(),
        trendUrl: String(payload.trendUrl || '').trim(),
        trendTitle: String(payload.trendTitle || '').trim(),
        trendCategory: normalizeMedicalCategory(payload.trendCategory || payload.category),
        previousCopy: String(payload.previousCopy || '').trim()
    };
}

function buildFeedbackHeader(userName, feedbackText) {
    const now = new Date();
    const HH = String(now.getHours()).padStart(2, '0');
    const MM = String(now.getMinutes()).padStart(2, '0');
    const DD = String(now.getDate()).padStart(2, '0');
    const MMm = String(now.getMonth() + 1).padStart(2, '0');
    const YYYY = now.getFullYear();

    return `\n[${userName}] deu feedback as ${HH}:${MM} ${DD}/${MMm}/${YYYY}: ${feedbackText}\n---`;
}

function buildGenerationPrompt(prompt, previousCopy = '', trendCategory = '') {
    const normalizedPrompt = String(prompt || '').trim();
    const normalizedPreviousCopy = String(previousCopy || '').trim();
    const normalizedTrendCategory = normalizeMedicalCategory(trendCategory);
    const instructionBlocks = [];

    if (normalizedTrendCategory) {
        instructionBlocks.push(`INSTRUÇÃO INTERNA SOBRE TREND MÉDICA:
- Adapte esta trend para a especialidade selecionada: ${normalizedTrendCategory}.
- Não force conexão se a trend não fizer sentido para essa especialidade.
- Prefira sugestões úteis, éticas e aplicáveis à comunicação médica.
- Se a trend tiver baixa aderência, use apenas como referência de formato, não de tema.`);
    }

    if (normalizedPreviousCopy) {
        instructionBlocks.push(`INSTRUÇÃO INTERNA ADICIONAL:
- Gere uma NOVA variação sobre o mesmo tema, mantendo o objetivo, o tom e o contexto do cliente.
- Priorize o feedback mais recente e as diretrizes anexadas no contexto.
- Não repita literalmente frases, gancho inicial, CTA, sequência narrativa ou estrutura dominante da versão anterior.
- Traga um ângulo novo, com desenvolvimento, exemplos e progressão diferentes.

VERSÃO ANTERIOR PARA EVITAR REPETIÇÃO LITERAL:
${normalizedPreviousCopy}`);
    }

    return [normalizedPrompt, ...instructionBlocks].filter(Boolean).join('\n\n');
}

async function getDoctorContextMetadata(doctorId) {
    await ensureDoctorsContentNotesColumn();
    const row = await dbGet(
        `SELECT id, drive_folder_id, instructions_doc_id, feedback_doc_id, content_notes
         FROM doctors
         WHERE id = ?`,
        [doctorId]
    );

    if (!row) {
        throw new Error('Failed to locate doctor metadata.');
    }

    return row;
}

async function resolveMedicalContextForDoctor({ doctorId, doctorRow = null, auth, conversationId = null }) {
    const resolvedDoctorId = String(doctorId || doctorRow?.doctor_id || doctorRow?.id || '').trim();
    if (!resolvedDoctorId) {
        throw new Error('Missing doctor ID for context retrieval.');
    }

    const cachedConversationContext = getCachedConversationContext(conversationId);
    if (cachedConversationContext) {
        console.log(`[AI] Context cache hit conversation=${conversationId}`);
        return cachedConversationContext;
    }

    const cachedMedicalContext = getCachedMedicalContext(resolvedDoctorId);
    if (cachedMedicalContext) {
        console.log(`[AI] Context cache hit doctor=${resolvedDoctorId}`);
        setCachedConversationContext(conversationId, resolvedDoctorId, cachedMedicalContext);
        return cachedMedicalContext;
    }

    const row = doctorRow || await getDoctorContextMetadata(resolvedDoctorId);
    console.log(`[AI] Context cache miss doctor=${resolvedDoctorId}`);
    const contextStr = await medicalController.fetchContext(
        row.instructions_doc_id,
        row.feedback_doc_id,
        auth,
        row.drive_folder_id
    );
    const contextWithNotes = appendContentNotesToContext(contextStr, row.content_notes);

    setCachedMedicalContext(resolvedDoctorId, contextWithNotes);
    setCachedConversationContext(conversationId, resolvedDoctorId, contextWithNotes);

    return contextWithNotes;
}

async function generateCopyFromRequest(requestPayload, auth, doctorRow = null, options = {}) {
    const request = normalizeGenerationRequest(requestPayload);

    if (!request.doctorId || !request.prompt) {
        throw new Error('Missing doctor ID or prompt.');
    }

    const row = doctorRow || await getDoctorContextMetadata(request.doctorId);
    const startedAt = Date.now();
    const contextStr = await resolveMedicalContextForDoctor({
        doctorId: request.doctorId,
        doctorRow: row,
        auth,
        conversationId: options.conversationId
    });

    let trendContext = '';
    if (request.trendUrl) {
        try {
            trendContext = await medicalController.fetchTrendArticleContext(request.trendUrl, request.trendTitle);
        } catch (trendError) {
            console.warn('[Trends] Falha ao anexar contexto da materia:', trendError.message);
        }
    }

    const generatedCopy = await medicalController.generateMedicalCopy(
        buildGenerationPrompt(request.prompt, request.previousCopy, request.trendCategory),
        contextStr,
        trendContext
    );
    console.log(`[AI] Generation finished doctor=${request.doctorId} in ${Date.now() - startedAt}ms`);

    return {
        copy: generatedCopy,
        doctorContextRetrieved: true,
        medicalContext: contextStr
    };
}

async function createContentSessionFromGeneration({ request, copy, userId }) {
    const result = await dbRun(
        `INSERT INTO content_sessions (
            doctor_id,
            user_id,
            original_prompt,
            original_content,
            current_content,
            trend_url,
            trend_title
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            request.doctorId,
            userId,
            request.prompt,
            copy,
            copy,
            request.trendUrl || null,
            request.trendTitle || null
        ]
    );

    return result.lastID;
}

async function getContentSessionForUser(sessionId, userId) {
    await ensureDoctorsContentNotesColumn();
    return dbGet(
        `SELECT
            cs.*,
            d.name AS doctor_name,
            d.specialty AS doctor_specialty,
            d.drive_folder_id,
            d.instructions_doc_id,
            d.feedback_doc_id,
            d.content_notes
         FROM content_sessions cs
         INNER JOIN doctors d ON d.id = cs.doctor_id
         WHERE cs.id = ? AND cs.user_id = ?
         LIMIT 1`,
        [sessionId, userId]
    );
}

async function getContentChatMessages(sessionId) {
    return dbAll(
        `SELECT id, role, message, content_snapshot, created_at
         FROM content_chat_messages
         WHERE session_id = ?
         ORDER BY id ASC`,
        [sessionId]
    );
}

async function addContentChatMessage({ sessionId, role, message, contentSnapshot = null }) {
    const normalizedRole = role === 'assistant' ? 'assistant' : 'user';
    return dbRun(
        `INSERT INTO content_chat_messages (session_id, role, message, content_snapshot)
         VALUES (?, ?, ?, ?)`,
        [sessionId, normalizedRole, message, contentSnapshot]
    );
}

async function updateContentSessionCurrentContent(sessionId, currentContent) {
    return dbRun(
        `UPDATE content_sessions
         SET current_content = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [currentContent, sessionId]
    );
}

async function touchContentSession(sessionId) {
    return dbRun(
        `UPDATE content_sessions
         SET updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [sessionId]
    );
}

async function markContentSessionExported(sessionId, driveFileId) {
    return dbRun(
        `UPDATE content_sessions
         SET drive_file_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [driveFileId, sessionId]
    );
}

function formatChatHistoryForPrompt(messages = []) {
    if (!messages.length) return '';

    return messages.map((message) => {
        const label = message.role === 'assistant' ? 'Editor' : 'Usuário';
        return `${label}:\n${message.message}`;
    }).join('\n\n---\n\n');
}

function formatBrazilianDateTime(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    return date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function buildSafeFileSlug(value, fallback = 'historico-chat') {
    const slug = String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .slice(0, 56);

    return slug || fallback;
}

function buildContentHistoryMarkdown({ session, messages, user }) {
    const createdAt = formatBrazilianDateTime(session.created_at);
    const updatedAt = formatBrazilianDateTime(session.updated_at);
    const userLabel = `${user?.displayName || 'Usuário'}${user?.email ? ` <${user.email}>` : ''}`;

    const messageBlocks = messages.length
        ? messages.map((message, index) => {
            const label = message.role === 'assistant' ? 'Gemini' : 'Usuário';
            return [
                `## ${index + 1}. ${label}`,
                '',
                `Data: ${formatBrazilianDateTime(message.created_at)}`,
                '',
                message.message
            ].join('\n');
        }).join('\n\n---\n\n')
        : 'Sem mensagens de ajuste nesta sessão.';

    return [
        '# Histórico de chat do conteúdo',
        '',
        `Cliente: ${session.doctor_name}`,
        `Especialidade: ${session.doctor_specialty || 'Não informada'}`,
        `Usuário: ${userLabel}`,
        `Criado em: ${createdAt}`,
        `Última atualização: ${updatedAt}`,
        session.trend_title ? `Trend vinculada: ${session.trend_title}` : '',
        session.trend_url ? `URL da trend: ${session.trend_url}` : '',
        '',
        '## Prompt original',
        '',
        session.original_prompt,
        '',
        '## Conteúdo original',
        '',
        session.original_content,
        '',
        '## Conversa de ajustes',
        '',
        messageBlocks,
        '',
        '## Versão mais recente',
        '',
        session.current_content
    ].join('\n');
}

function buildContentHistoryFileName(session) {
    const now = new Date();
    const YYYY = now.getFullYear();
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const DD = String(now.getDate()).padStart(2, '0');
    const HH = String(now.getHours()).padStart(2, '0');
    const MI = String(now.getMinutes()).padStart(2, '0');
    const doctorSlug = buildSafeFileSlug(session.doctor_name, 'cliente');
    return `historico-chat-${doctorSlug}-${YYYY}${MM}${DD}-${HH}${MI}.md`;
}

async function uploadContentHistoryToDrive({ session, messages, user, auth }) {
    const drive = createDriveClient(auth);
    const markdown = buildContentHistoryMarkdown({ session, messages, user });
    const media = {
        mimeType: 'text/markdown',
        body: Readable.from(Buffer.from(markdown, 'utf-8'))
    };

    if (session.drive_file_id) {
        const updateResponse = await drive.files.update({
            fileId: session.drive_file_id,
            media,
            requestBody: { mimeType: 'text/markdown' },
            fields: 'id, webViewLink',
            supportsAllDrives: true
        });
        return updateResponse.data;
    }

    const createResponse = await drive.files.create({
        requestBody: {
            name: buildContentHistoryFileName(session),
            parents: [session.drive_folder_id],
            mimeType: 'text/markdown'
        },
        media,
        fields: 'id, webViewLink',
        supportsAllDrives: true
    });

    await markContentSessionExported(session.id, createResponse.data.id);
    return createResponse.data;
}

function inferContentTypeFromCopy(copy, prompt = '') {
    const text = `${copy || ''}\n${prompt || ''}`.toUpperCase();

    if (/\bCARROSSEL\b/.test(text) || /\bTELA\s+0?\d+\s*:/i.test(text)) return 'Carrossel';
    if (/\bREELS\b/.test(text) || /\bROTEIRO\s*:/i.test(text) || /\bTAKE\s+0?\d+\s*:/i.test(text)) return 'Reels';
    if (/\bPOST FEED\b/.test(text) || /\bCOPY DA ARTE\s*:/i.test(text)) return 'Feed';
    if (/\bSTORY\s+0?\d+\s*:/i.test(text)) return 'Stories';
    if (/^\s*MENSAGEM\s*:/im.test(text) || /\bWHATSAPP\b/.test(text)) return 'WhatsApp';

    return 'Outro';
}

function normalizeContentMessageRole(role) {
    const normalizedRole = String(role || '').trim();
    return ['user', 'assistant', 'system_event'].includes(normalizedRole)
        ? normalizedRole
        : 'system_event';
}

function normalizeContentMessageType(messageType) {
    const normalizedType = String(messageType || '').trim();
    const acceptedTypes = [
        'initial_generation',
        'refinement',
        'regeneration',
        'positive_feedback',
        'negative_feedback',
        'system_notice',
        'content'
    ];

    return acceptedTypes.includes(normalizedType) ? normalizedType : 'content';
}

function serializeContentMessage(row) {
    if (!row) return null;
    return {
        id: row.id,
        conversationId: row.conversation_id,
        role: row.role,
        message: row.message,
        messageType: row.message_type || row.messageType || 'content',
        createdAt: row.created_at
    };
}

async function getContentMessageById(messageId) {
    const row = await dbGet(
        `SELECT id, conversation_id, role, message, message_type, created_at
         FROM content_messages
         WHERE id = ?
         LIMIT 1`,
        [messageId]
    );

    return serializeContentMessage(row);
}

async function touchContentConversation(conversationId, status = null) {
    if (status) {
        return dbRun(
            `UPDATE content_conversations
             SET status = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [status, conversationId]
        );
    }

    return dbRun(
        `UPDATE content_conversations
         SET updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [conversationId]
    );
}

async function addContentMessage({ conversationId, role, message, messageType = 'content' }) {
    const result = await dbRun(
        `INSERT INTO content_messages (conversation_id, role, message, message_type)
         VALUES (?, ?, ?, ?)`,
        [
            conversationId,
            normalizeContentMessageRole(role),
            String(message || '').trim(),
            normalizeContentMessageType(messageType)
        ]
    );

    await touchContentConversation(conversationId);
    return getContentMessageById(result.lastID);
}

async function createContentConversationFromGeneration({ request, copy, userId, medicalContext = '' }) {
    const contentType = inferContentTypeFromCopy(copy, request.prompt);
    const result = await dbRun(
        `INSERT INTO content_conversations (
            doctor_id,
            user_id,
            status,
            original_prompt,
            content_type
         ) VALUES (?, ?, ?, ?, ?)`,
        [
            request.doctorId,
            userId,
            'active',
            request.prompt,
            contentType
        ]
    );

    const assistantMessage = await addContentMessage({
        conversationId: result.lastID,
        role: 'assistant',
        message: copy,
        messageType: 'initial_generation'
    });

    setCachedConversationContext(result.lastID, request.doctorId, medicalContext);

    return {
        conversationId: result.lastID,
        contentType,
        assistantMessage
    };
}

async function getContentConversationForUser(conversationId, userId) {
    await ensureDoctorsContentNotesColumn();
    return dbGet(
        `SELECT
            cc.*,
            d.name AS doctor_name,
            d.specialty AS doctor_specialty,
            d.drive_folder_id,
            d.instructions_doc_id,
            d.feedback_doc_id,
            d.content_notes
         FROM content_conversations cc
         INNER JOIN doctors d ON d.id = cc.doctor_id
         WHERE cc.id = ? AND cc.user_id = ?
         LIMIT 1`,
        [conversationId, userId]
    );
}

async function getContentMessageForUser(messageId, userId) {
    await ensureDoctorsContentNotesColumn();
    return dbGet(
        `SELECT
            cm.id,
            cm.conversation_id,
            cm.role,
            cm.message,
            cm.message_type,
            cm.created_at,
            cc.doctor_id,
            cc.user_id,
            cc.original_prompt,
            cc.content_type,
            d.name AS doctor_name,
            d.specialty AS doctor_specialty,
            d.drive_folder_id,
            d.instructions_doc_id,
            d.feedback_doc_id,
            d.content_notes
         FROM content_messages cm
         INNER JOIN content_conversations cc ON cc.id = cm.conversation_id
         INNER JOIN doctors d ON d.id = cc.doctor_id
         WHERE cm.id = ? AND cc.user_id = ?
         LIMIT 1`,
        [messageId, userId]
    );
}

async function getContentConversationMessages(conversationId) {
    return dbAll(
        `SELECT id, conversation_id, role, message, message_type, created_at
         FROM content_messages
         WHERE conversation_id = ?
         ORDER BY id ASC`,
        [conversationId]
    );
}

async function getLatestAssistantContentMessage(conversationId) {
    const row = await dbGet(
        `SELECT id, conversation_id, role, message, message_type, created_at
         FROM content_messages
         WHERE conversation_id = ? AND role = 'assistant'
         ORDER BY id DESC
         LIMIT 1`,
        [conversationId]
    );

    return serializeContentMessage(row);
}

function formatConversationHistoryForPrompt(messages = []) {
    if (!messages.length) return 'Sem mensagens anteriores.';

    return messages.map((message) => {
        const type = message.message_type || message.messageType || 'content';
        const label = message.role === 'assistant'
            ? 'IA'
            : (message.role === 'user' ? 'Usuário' : 'Evento do sistema');
        return `${label} (${type}):\n${message.message}`;
    }).join('\n\n---\n\n');
}

function cleanCopyForFeedback(copy) {
    return String(copy || '')
        .replace(/\r\n/g, '\n')
        .trim();
}

function extractPositiveFeedbackCopy(message) {
    const text = String(message || '').trim();
    return text.replace(/^Usuário gostou da copy:\s*/i, '').trim();
}

function buildConversationHistoryMarkdown({ conversation, messages }) {
    const firstAssistant = messages.find((message) => (
        message.role === 'assistant' && message.message_type === 'initial_generation'
    ));
    const latestAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
    const adjustmentMessages = messages.filter((message) => (
        message.role !== 'system_event' && message.message_type !== 'initial_generation'
    ));
    const positiveFeedbacks = messages.filter((message) => message.message_type === 'positive_feedback');
    const negativeFeedbacks = messages.filter((message) => message.message_type === 'negative_feedback');

    const adjustmentBlocks = adjustmentMessages.length
        ? adjustmentMessages.map((message) => {
            const label = message.role === 'assistant' ? 'IA' : 'Usuário';
            return [`### ${label}`, '', message.message].join('\n');
        }).join('\n\n')
        : 'Sem ajustes registrados.';

    const feedbackBlocks = [
        ...positiveFeedbacks.map((message) => [
            '### Like',
            'Usuário gostou da copy:',
            '',
            extractPositiveFeedbackCopy(message.message)
        ].join('\n')),
        ...negativeFeedbacks.map((message) => [
            '### Dislike',
            message.message
        ].join('\n'))
    ].filter(Boolean).join('\n\n') || 'Sem feedbacks registrados.';

    return [
        '# Histórico de Criação',
        '',
        'Cliente:',
        conversation.doctor_name || `Médico ${conversation.doctor_id}`,
        '',
        'Formato:',
        conversation.content_type || 'Outro',
        '',
        'Data:',
        formatBrazilianDateTime(new Date()),
        '',
        '## Briefing original',
        '',
        conversation.original_prompt,
        '',
        '## Primeira resposta',
        '',
        firstAssistant?.message || '',
        '',
        '## Conversa de ajuste',
        '',
        adjustmentBlocks,
        '',
        '## Feedbacks',
        '',
        feedbackBlocks,
        '',
        '## Versão mais recente',
        '',
        latestAssistant?.message || firstAssistant?.message || ''
    ].join('\n');
}

function buildConversationHistoryFileName(conversation) {
    const now = new Date();
    const YYYY = now.getFullYear();
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const DD = String(now.getDate()).padStart(2, '0');
    const dateLabel = `${YYYY}${MM}${DD}`;
    const doctorSlug = buildSafeFileSlug(conversation.doctor_name || conversation.doctor_id, `medico-${conversation.doctor_id}`);

    return `historico-conteudo-${dateLabel}-${doctorSlug}-${conversation.id}.md`;
}

async function uploadConversationHistoryToDrive({ conversation, messages, auth }) {
    const drive = createDriveClient(auth);
    const markdown = buildConversationHistoryMarkdown({ conversation, messages });
    const media = {
        mimeType: 'text/markdown',
        body: Readable.from(Buffer.from(markdown, 'utf-8'))
    };

    const createResponse = await drive.files.create({
        requestBody: {
            name: buildConversationHistoryFileName(conversation),
            parents: [conversation.drive_folder_id],
            mimeType: 'text/markdown'
        },
        media,
        fields: 'id, webViewLink',
        supportsAllDrives: true
    });

    return createResponse.data;
}

async function tryUploadConversationHistory({ conversation, userId, auth }) {
    try {
        const freshConversation = await getContentConversationForUser(conversation.id, userId);
        const messages = await getContentConversationMessages(conversation.id);
        const driveFile = await uploadConversationHistoryToDrive({
            conversation: freshConversation || conversation,
            messages,
            auth
        });
        const driveUrl = driveFile.webViewLink || `https://drive.google.com/file/d/${driveFile.id}/view`;

        return {
            historySaved: true,
            driveFileId: driveFile.id,
            driveUrl
        };
    } catch (error) {
        console.error('[Content Chat] Falha ao salvar histórico da conversa:', error.message);
        await addContentMessage({
            conversationId: conversation.id,
            role: 'system_event',
            message: `Falha ao salvar histórico no Google Drive: ${error.message}`,
            messageType: 'system_notice'
        });

        return {
            historySaved: false,
            historyError: 'Histórico mantido no banco local, mas não foi possível salvar no Drive.'
        };
    }
}

async function persistDoctorFeedback({ doctorId, feedbackText, userName, auth }) {
    const row = await getDoctorContextMetadata(doctorId);
    const header = buildFeedbackHeader(userName, feedbackText);

    await medicalController.appendFeedback(row.feedback_doc_id, header, auth);
    invalidateMedicalContextCache(doctorId);

    return row;
}

function normalizeDriveFileName(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();
}

function extractSpecialtyFromInstructions(content) {
    const text = String(content || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
    const match = text.match(/##\s*Area\s+de\s+Atuacao\s*\n+([^\n#]+)/i);
    return match ? String(match[1]).trim() : '';
}

async function readDriveTextFile(drive, fileId) {
    try {
        const response = await drive.files.get(
            { fileId, alt: 'media' },
            { responseType: 'text' }
        );
        return typeof response.data === 'string' ? response.data : '';
    } catch (error) {
        console.warn(`[Drive Sync] Nao foi possivel ler o arquivo ${fileId}: ${error.message}`);
        return '';
    }
}

async function syncDoctorsFromDrive(auth) {
    const parentFolderId = String(process.env.GOOGLE_DRIVE_PARENT_ID || '').trim();
    if (!parentFolderId) {
        console.warn('[Drive Sync] GOOGLE_DRIVE_PARENT_ID nao configurado. Sincronizacao ignorada.');
        return { imported: 0, updated: 0, skipped: 0 };
    }

    const drive = createDriveClient(auth);
    const foldersResponse = await drive.files.list({
        q: `'${parentFolderId}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
        fields: 'files(id, name)',
        orderBy: 'name',
        pageSize: 200,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
    });

    const folders = Array.isArray(foldersResponse.data.files) ? foldersResponse.data.files : [];
    let imported = 0;
    let updated = 0;
    let skipped = 0;

    for (const folder of folders) {
        const folderId = String(folder.id || '').trim();
        const folderName = String(folder.name || '').trim();
        if (!folderId || !folderName) {
            skipped += 1;
            continue;
        }

        const filesResponse = await drive.files.list({
            q: `'${folderId}' in parents and trashed = false`,
            fields: 'files(id, name, mimeType)',
            pageSize: 100,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true
        });

        const files = Array.isArray(filesResponse.data.files) ? filesResponse.data.files : [];
        const instructionsFile = files.find((file) => {
            const normalized = normalizeDriveFileName(file.name);
            return normalized === 'instrucoes.md';
        });
        const feedbackFile = files.find((file) => normalizeDriveFileName(file.name) === 'feedback.md');

        if (!instructionsFile || !feedbackFile) {
            console.warn(`[Drive Sync] Pasta ignorada por falta de arquivos obrigatorios: ${folderName}`);
            skipped += 1;
            continue;
        }

        const instructionsContent = await readDriveTextFile(drive, instructionsFile.id);
        const specialty = extractSpecialtyFromInstructions(instructionsContent);

        const existingDoctor = await dbGet(
            `SELECT id FROM doctors WHERE drive_folder_id = ? OR name = ? LIMIT 1`,
            [folderId, folderName]
        );

        if (existingDoctor?.id) {
            await dbRun(
                `UPDATE doctors
                 SET name = ?, specialty = ?, drive_folder_id = ?, instructions_doc_id = ?, feedback_doc_id = ?
                 WHERE id = ?`,
                [
                    folderName,
                    specialty || null,
                    folderId,
                    instructionsFile.id,
                    feedbackFile.id,
                    existingDoctor.id
                ]
            );
            updated += 1;
            continue;
        }

        await dbRun(
            `INSERT INTO doctors (name, specialty, drive_folder_id, instructions_doc_id, feedback_doc_id)
             VALUES (?, ?, ?, ?, ?)`,
            [
                folderName,
                specialty || null,
                folderId,
                instructionsFile.id,
                feedbackFile.id
            ]
        );
        imported += 1;
    }

    console.log(`[Drive Sync] importados=${imported} atualizados=${updated} ignorados=${skipped}`);
    return { imported, updated, skipped };
}

async function ensureDoctorsSeeded(auth) {
    const countRow = await dbGet(`SELECT COUNT(*) AS total FROM doctors`);
    const total = Number(countRow?.total || 0);
    if (total > 0) return { seeded: false, total };

    const syncResult = await syncDoctorsFromDrive(auth);
    const refreshedCountRow = await dbGet(`SELECT COUNT(*) AS total FROM doctors`);
    return {
        seeded: true,
        total: Number(refreshedCountRow?.total || 0),
        ...syncResult
    };
}

function toBase64Url(input) {
    return Buffer.from(input)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

// Setup View Engine
app.set('views', path.join(__dirname, '../views'));
app.set('view engine', 'ejs');
app.set('trust proxy', 1);

const sessionStore = new SQLiteStore({
    db: path.basename(dbPath),
    dir: path.dirname(dbPath),
    table: 'sessions',
    concurrentDB: true
});

// Setup Session
app.use(session({
    store: sessionStore,
    name: SESSION_COOKIE_NAME,
    secret: process.env.SESSION_SECRET || 'fallback-secret-for-dev-only-change-me',
    resave: false,
    saveUninitialized: false,
    unset: 'destroy',
    cookie: getSessionCookieOptions()
}));

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

function buildGoogleAuthOptions(forceConsent = false) {
    const options = {
        scope: GOOGLE_AUTH_SCOPES,
        accessType: 'offline',
        includeGrantedScopes: true,
        hd: 'resultpubli.com.br'
    };

    if (forceConsent) {
        options.prompt = 'consent';
    }

    return options;
}

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    callbackURL: buildGoogleCallbackUrl(),
    passReqToCallback: true
},
    async function verifyGoogleUser(req, accessToken, refreshToken, profile, cb) {
        const email = extractProfileEmail(profile);
        const hostedDomain = String(profile?._json?.hd || '').trim().toLowerCase();
        const forceConsentFlow = Boolean(req.session?.googleAuthForceConsent);

        if (hostedDomain !== 'resultpubli.com.br' && !email.endsWith('@resultpubli.com.br')) {
            return cb(null, false, {
                code: 'domain_restricted',
                message: 'Acesso permitido apenas para contas @resultpubli.com.br'
            });
        }

        try {
            const userRecord = await upsertGoogleUser(profile, refreshToken);

            if (!String(userRecord?.refresh_token || '').trim()) {
                return cb(null, false, {
                    code: forceConsentFlow ? 'missing_refresh_token_after_consent' : 'missing_refresh_token',
                    message: 'Não foi possível obter refresh token do Google.'
                });
            }

            return cb(null, normalizeAppUser(userRecord));
        } catch (error) {
            return cb(error);
        }
    }
));

passport.serializeUser(function serializeUser(user, cb) {
    cb(null, user.id);
});

passport.deserializeUser(async function deserializeUser(userId, cb) {
    try {
        const userRow = await getUserById(userId);
        if (!userRow?.id) return cb(null, false);
        return cb(null, normalizeAppUser(userRow));
    } catch (error) {
        return cb(error);
    }
});

app.use(express.static(path.join(__dirname, '../views')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Authentication Middleware
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.redirect('/login');
}

// Authentication Routes
app.get('/login', (req, res) => {
    if (req.isAuthenticated()) return res.redirect('/');
    clearGoogleAuthFlowFlags(req);
    res.render('login', {
        error: String(req.query.error || '').trim()
    });
});

app.get('/auth/google', (req, res, next) => {
    const forceConsent = String(req.query.force_consent || '').trim() === '1';
    req.session.googleAuthForceConsent = forceConsent;

    saveSession(req)
        .then(() => passport.authenticate('google', buildGoogleAuthOptions(forceConsent))(req, res, next))
        .catch(next);
});

app.get('/auth/google/callback',
    (req, res, next) => {
        passport.authenticate('google', (err, user, info) => {
            if (err) {
                clearGoogleAuthFlowFlags(req);
                console.error('[Auth] Falha no callback do Google:', err.message);
                return res.redirect('/login?error=server');
            }

            if (!user) {
                if (info?.code === 'missing_refresh_token' && !req.session.googleAuthRepairAttempted) {
                    req.session.googleAuthRepairAttempted = true;
                    req.session.googleAuthForceConsent = false;

                    return saveSession(req)
                        .then(() => res.redirect('/auth/google?force_consent=1'))
                        .catch(next);
                }

                clearGoogleAuthFlowFlags(req);
                const reason = info?.code === 'domain_restricted' ? 'domain' : 'auth';
                return saveSession(req)
                    .catch(() => null)
                    .finally(() => res.redirect(`/login?error=${reason}`));
            }

            req.logIn(user, (loginErr) => {
                if (loginErr) {
                    console.error('[Auth] Falha ao salvar sessao do usuario:', loginErr.message);
                    return next(loginErr);
                }

                clearGoogleAuthFlowFlags(req);
                return saveSession(req)
                    .then(() => res.redirect('/'))
                    .catch(next);
            });
        })(req, res, next);
    }
);

app.get('/logout', async (req, res, next) => {
    try {
        clearGoogleAuthFlowFlags(req);
        await logoutAndDestroySession(req, res);
        res.redirect('/login');
    } catch (error) {
        next(error);
    }
});

function resolveDriveDatabaseUrl() {
    const driveParentId = String(process.env.GOOGLE_DRIVE_PARENT_ID || '').trim();
    return driveParentId
        ? `https://drive.google.com/drive/folders/${driveParentId}`
        : '';
}

function buildPageTitle(activePage, activeTool) {
    if (activeTool) return `ResultPubli - ${activeTool.name}`;

    switch (activePage) {
        case 'planejamento':
            return 'ResultPubli - Planejamento';
        case 'clientes':
            return 'ResultPubli - Clientes';
        case 'ferramentas':
            return 'ResultPubli - Ferramentas';
        default:
            return 'ResultPubli - Planejador';
    }
}

function renderMainPage(req, res, { activePage = 'dashboard', activeToolSlug = null } = {}) {
    const activeTool = activeToolSlug
        ? TOOL_DEFINITIONS.find((tool) => tool.slug === activeToolSlug) || null
        : null;

    res.render('index', {
        user: req.user,
        driveDatabaseUrl: resolveDriveDatabaseUrl(),
        activePage,
        activeToolSlug,
        activeTool,
        tools: TOOL_DEFINITIONS,
        medicalCategories: MEDICAL_CATEGORIES,
        pageTitle: buildPageTitle(activePage, activeTool)
    });
}

// Serve the Main UI (Protected)
app.get('/', ensureAuthenticated, (req, res) => {
    renderMainPage(req, res, { activePage: 'dashboard' });
});

app.get('/planejamento', ensureAuthenticated, (req, res) => {
    renderMainPage(req, res, { activePage: 'planejamento' });
});

app.get('/clientes', ensureAuthenticated, (req, res) => {
    renderMainPage(req, res, { activePage: 'clientes' });
});

app.get('/ferramentas', ensureAuthenticated, (req, res) => {
    renderMainPage(req, res, { activePage: 'ferramentas' });
});

app.get('/ferramentas/:toolSlug', ensureAuthenticated, (req, res) => {
    const requestedTool = TOOL_DEFINITIONS.find((tool) => tool.slug === req.params.toolSlug);
    if (!requestedTool) {
        return res.redirect('/ferramentas');
    }

    renderMainPage(req, res, {
        activePage: 'ferramentas',
        activeToolSlug: requestedTool.slug
    });
});

// API Routes (Tier 3 Execution)
// Get all doctors metadata (Protected API)
app.get('/api/doctors', ensureAuthenticated, async (req, res) => {
    try {
        const auth = await getGoogleAuthOrRespond(req, res);
        if (!auth) return;

        await ensureDoctorsSeeded(auth);
        await ensureDoctorsContentNotesColumn();
        const rows = await dbAll(
            `SELECT id, name, specialty, drive_folder_id, instructions_doc_id, feedback_doc_id, content_notes
             FROM doctors
             ORDER BY name COLLATE NOCASE ASC`
        );

        res.json({
            message: "success",
            data: rows
        });
    } catch (error) {
        if (await handleGoogleApiAuthFailure(req, res, error)) return;
        console.error('[Doctors] Falha ao carregar base de medicos:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/tools/text-correction', ensureAuthenticated, async (req, res) => {
    const text = String(req.body.text || '').trim();

    if (!text) {
        return res.status(400).json({ error: 'Envie um texto para corrigir.' });
    }

    try {
        const params = new URLSearchParams({
            text,
            language: 'pt-BR'
        });

        const { data } = await axios.post('https://api.languagetool.org/v2/check', params.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            timeout: 20000
        });

        res.json({
            matches: Array.isArray(data.matches) ? data.matches : []
        });
    } catch (error) {
        console.error('[LanguageTool] Falha ao corrigir texto:', error.message);
        res.status(502).json({
            error: 'Não foi possível consultar a ferramenta de correção agora. Tente novamente em instantes.'
        });
    }
});

// Tier 2 Orchestration Route
app.post('/api/orchestrate', ensureAuthenticated, async (req, res) => {
    const request = normalizeGenerationRequest(req.body);

    if (!request.doctorId || !request.prompt) {
        return res.status(400).json({ error: "Missing doctor ID or prompt." });
    }

    try {
        const auth = await getGoogleAuthOrRespond(req, res);
        if (!auth) return;
        const result = await generateCopyFromRequest(request, auth);
        const sessionId = await createContentSessionFromGeneration({
            request,
            copy: result.copy,
            userId: req.user.id
        });
        const conversation = await createContentConversationFromGeneration({
            request,
            copy: result.copy,
            userId: req.user.id,
            medicalContext: result.medicalContext
        });

        res.json({
            message: "Success",
            doctorContextRetrieved: result.doctorContextRetrieved,
            copy: result.copy,
            sessionId,
            conversationId: conversation.conversationId,
            assistantMessage: conversation.assistantMessage,
            contentType: conversation.contentType
        });
    } catch (orchestrationError) {
        if (await handleGoogleApiAuthFailure(req, res, orchestrationError)) return;
        res.status(500).json({ error: orchestrationError.message });
    }
});

app.post('/api/content/conversations', ensureAuthenticated, async (req, res) => {
    const request = normalizeGenerationRequest(req.body);

    if (!request.doctorId || !request.prompt) {
        return res.status(400).json({ error: 'doctorId and prompt are required.' });
    }

    try {
        const auth = await getGoogleAuthOrRespond(req, res);
        if (!auth) return;

        const result = await generateCopyFromRequest(request, auth);
        const sessionId = await createContentSessionFromGeneration({
            request,
            copy: result.copy,
            userId: req.user.id
        });
        const conversation = await createContentConversationFromGeneration({
            request,
            copy: result.copy,
            userId: req.user.id,
            medicalContext: result.medicalContext
        });

        return res.status(201).json({
            message: 'Conversa criada.',
            doctorContextRetrieved: result.doctorContextRetrieved,
            copy: result.copy,
            sessionId,
            conversationId: conversation.conversationId,
            assistantMessage: conversation.assistantMessage,
            contentType: conversation.contentType
        });
    } catch (error) {
        if (await handleGoogleApiAuthFailure(req, res, error)) return;
        console.error('[Content Chat] Falha ao criar conversa:', error.message);
        return res.status(500).json({ error: 'Falha ao gerar conteúdo: ' + error.message });
    }
});

app.post('/api/content/conversations/:id/messages', ensureAuthenticated, async (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    const userMessage = String(req.body.userMessage || req.body.userAdjustment || '').trim();

    if (!conversationId || !userMessage) {
        return res.status(400).json({ error: 'conversationId and userMessage are required.' });
    }

    try {
        const conversation = await getContentConversationForUser(conversationId, req.user.id);
        if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada.' });
        if (conversation.status === 'finished') {
            return res.status(409).json({ error: 'Esta conversa já foi finalizada. Comece um novo conteúdo para continuar.' });
        }

        const latestAssistant = await getLatestAssistantContentMessage(conversation.id);
        if (!latestAssistant) {
            return res.status(400).json({ error: 'Nenhuma resposta da IA encontrada para ajustar.' });
        }

        const savedUserMessage = await addContentMessage({
            conversationId: conversation.id,
            role: 'user',
            message: userMessage,
            messageType: 'refinement'
        });

        const validation = validateUserChatMessage(userMessage, 'refinement');
        if (!validation.ok) {
            const assistantMessage = await addContentMessage({
                conversationId: conversation.id,
                role: 'assistant',
                message: validation.message,
                messageType: 'system_notice'
            });

            return res.status(200).json({
                message: validation.message,
                blocked: true,
                blockCode: validation.code,
                userMessage: savedUserMessage,
                assistantMessage
            });
        }

        const auth = await getGoogleAuthOrRespond(req, res);
        if (!auth) return;

        const [medicalContext, conversationMessages] = await Promise.all([
            resolveMedicalContextForDoctor({
                doctorId: conversation.doctor_id,
                doctorRow: conversation,
                auth,
                conversationId: conversation.id
            }),
            getContentConversationMessages(conversation.id)
        ]);

        const refinedCopy = await medicalController.chatRefineMedicalCopy({
            medicalContext,
            originalPrompt: conversation.original_prompt,
            currentContent: latestAssistant.message,
            userMessage,
            conversationHistory: formatConversationHistoryForPrompt(conversationMessages)
        });
        const assistantMessage = await addContentMessage({
            conversationId: conversation.id,
            role: 'assistant',
            message: refinedCopy,
            messageType: 'refinement'
        });

        return res.status(200).json({
            message: 'Conteúdo ajustado.',
            copy: refinedCopy,
            userMessage: savedUserMessage,
            assistantMessage
        });
    } catch (error) {
        if (await handleGoogleApiAuthFailure(req, res, error)) return;
        console.error('[Content Chat] Falha ao ajustar conversa:', error.message);
        return res.status(500).json({ error: 'Falha ao ajustar o conteúdo: ' + error.message });
    }
});

app.post('/api/content/conversations/:id/regenerate', ensureAuthenticated, async (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'conversationId is required.' });

    try {
        const conversation = await getContentConversationForUser(conversationId, req.user.id);
        if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada.' });
        if (conversation.status === 'finished') {
            return res.status(409).json({ error: 'Esta conversa já foi finalizada. Comece um novo conteúdo para continuar.' });
        }

        const auth = await getGoogleAuthOrRespond(req, res);
        if (!auth) return;

        const latestAssistant = await getLatestAssistantContentMessage(conversation.id);
        const result = await generateCopyFromRequest(
            {
                doctorId: conversation.doctor_id,
                prompt: conversation.original_prompt,
                previousCopy: latestAssistant?.message || ''
            },
            auth,
            conversation,
            { conversationId: conversation.id }
        );
        const assistantMessage = await addContentMessage({
            conversationId: conversation.id,
            role: 'assistant',
            message: result.copy,
            messageType: 'regeneration'
        });

        return res.status(200).json({
            message: 'Nova versão gerada.',
            copy: result.copy,
            assistantMessage
        });
    } catch (error) {
        if (await handleGoogleApiAuthFailure(req, res, error)) return;
        console.error('[Content Chat] Falha ao regenerar conversa:', error.message);
        return res.status(500).json({ error: 'Falha ao gerar novamente: ' + error.message });
    }
});

app.post('/api/content/messages/:id/like', ensureAuthenticated, async (req, res) => {
    const messageId = String(req.params.id || '').trim();
    if (!messageId) return res.status(400).json({ error: 'messageId is required.' });

    try {
        const message = await getContentMessageForUser(messageId, req.user.id);
        if (!message) return res.status(404).json({ error: 'Mensagem não encontrada.' });
        if (message.role !== 'assistant') {
            return res.status(400).json({ error: 'Apenas mensagens da IA podem receber like.' });
        }

        const cleanCopy = cleanCopyForFeedback(message.message);
        const feedbackText = `Usuário gostou da copy: ${cleanCopy}`;
        const feedbackMessage = await addContentMessage({
            conversationId: message.conversation_id,
            role: 'system_event',
            message: feedbackText,
            messageType: 'positive_feedback'
        });

        const auth = await getGoogleAuthOrRespond(req, res);
        if (!auth) return;

        try {
            await persistDoctorFeedback({
                doctorId: message.doctor_id,
                feedbackText,
                userName: req.user?.displayName || 'Usuário',
                auth
            });
        } catch (feedbackError) {
            await addContentMessage({
                conversationId: message.conversation_id,
                role: 'system_event',
                message: `Falha ao registrar feedback positivo no arquivo do cliente: ${feedbackError.message}`,
                messageType: 'system_notice'
            });
            if (await handleGoogleDriveWriteScopeFailure(req, res, feedbackError)) return;
            if (await handleGoogleApiAuthFailure(req, res, feedbackError)) return;
            return res.status(500).json({
                error: 'Like salvo no histórico local, mas não foi possível registrar no feedback do cliente.',
                feedbackSavedLocal: true
            });
        }

        const conversation = await getContentConversationForUser(message.conversation_id, req.user.id);
        const historyResult = await tryUploadConversationHistory({ conversation, userId: req.user.id, auth });

        return res.status(200).json({
            message: 'Feedback positivo registrado.',
            feedbackMessage,
            ...historyResult
        });
    } catch (error) {
        if (await handleGoogleApiAuthFailure(req, res, error)) return;
        console.error('[Content Chat] Falha ao registrar like:', error.message);
        return res.status(500).json({ error: 'Falha ao registrar like: ' + error.message });
    }
});

app.post('/api/content/messages/:id/dislike', ensureAuthenticated, async (req, res) => {
    const messageId = String(req.params.id || '').trim();
    const feedbackText = String(req.body.feedbackText || '').trim();

    if (!messageId || !feedbackText) {
        return res.status(400).json({ error: 'messageId and feedbackText are required.' });
    }

    try {
        const message = await getContentMessageForUser(messageId, req.user.id);
        if (!message) return res.status(404).json({ error: 'Mensagem não encontrada.' });
        if (message.role !== 'assistant') {
            return res.status(400).json({ error: 'Apenas mensagens da IA podem receber dislike.' });
        }

        const cleanCopy = cleanCopyForFeedback(message.message);
        const clientFeedbackText = [
            'Usuário pediu melhoria para a copy:',
            '',
            cleanCopy,
            '',
            'Feedback do usuário:',
            feedbackText
        ].join('\n');
        const feedbackMessage = await addContentMessage({
            conversationId: message.conversation_id,
            role: 'system_event',
            message: feedbackText,
            messageType: 'negative_feedback'
        });

        const auth = await getGoogleAuthOrRespond(req, res);
        if (!auth) return;

        try {
            await persistDoctorFeedback({
                doctorId: message.doctor_id,
                feedbackText: clientFeedbackText,
                userName: req.user?.displayName || 'Usuário',
                auth
            });
        } catch (feedbackError) {
            await addContentMessage({
                conversationId: message.conversation_id,
                role: 'system_event',
                message: `Falha ao registrar feedback negativo no arquivo do cliente: ${feedbackError.message}`,
                messageType: 'system_notice'
            });
            if (await handleGoogleDriveWriteScopeFailure(req, res, feedbackError)) return;
            if (await handleGoogleApiAuthFailure(req, res, feedbackError)) return;
            return res.status(500).json({
                error: 'Dislike salvo no histórico local, mas não foi possível registrar no feedback do cliente.',
                feedbackSavedLocal: true
            });
        }

        const conversation = await getContentConversationForUser(message.conversation_id, req.user.id);
        const historyResult = await tryUploadConversationHistory({ conversation, userId: req.user.id, auth });

        return res.status(200).json({
            message: 'Feedback negativo registrado.',
            feedbackMessage,
            ...historyResult
        });
    } catch (error) {
        if (await handleGoogleApiAuthFailure(req, res, error)) return;
        console.error('[Content Chat] Falha ao registrar dislike:', error.message);
        return res.status(500).json({ error: 'Falha ao registrar dislike: ' + error.message });
    }
});

app.post('/api/content/conversations/:id/export', ensureAuthenticated, async (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'conversationId is required.' });

    try {
        const conversation = await getContentConversationForUser(conversationId, req.user.id);
        if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada.' });

        const auth = await getGoogleAuthOrRespond(req, res);
        if (!auth) return;

        const historyResult = await tryUploadConversationHistory({ conversation, userId: req.user.id, auth });

        return res.status(200).json({
            message: historyResult.historySaved
                ? 'Histórico salvo sem finalizar a conversa.'
                : 'Histórico mantido no banco local.',
            status: conversation.status || 'active',
            ...historyResult
        });
    } catch (error) {
        if (await handleGoogleApiAuthFailure(req, res, error)) return;
        console.error('[Content Chat] Falha ao exportar conversa:', error.message);
        return res.status(500).json({ error: 'Falha ao salvar histórico: ' + error.message });
    }
});

app.post('/api/content/conversations/:id/finish', ensureAuthenticated, async (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'conversationId is required.' });

    try {
        const conversation = await getContentConversationForUser(conversationId, req.user.id);
        if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada.' });

        await touchContentConversation(conversation.id, 'finished');

        const auth = await getGoogleAuthOrRespond(req, res);
        if (!auth) return;

        const historyResult = await tryUploadConversationHistory({ conversation, userId: req.user.id, auth });

        return res.status(200).json({
            message: historyResult.historySaved
                ? 'Conversa finalizada e histórico salvo.'
                : 'Conversa finalizada. Histórico mantido no banco local.',
            status: 'finished',
            ...historyResult
        });
    } catch (error) {
        if (await handleGoogleApiAuthFailure(req, res, error)) return;
        console.error('[Content Chat] Falha ao finalizar conversa:', error.message);
        return res.status(500).json({ error: 'Falha ao finalizar conversa: ' + error.message });
    }
});

app.post('/api/content-sessions/:sessionId/refine', ensureAuthenticated, async (req, res) => {
    const sessionId = String(req.params.sessionId || '').trim();
    const userAdjustment = String(req.body.userAdjustment || '').trim();

    if (!sessionId || !userAdjustment) {
        return res.status(400).json({ error: 'sessionId and userAdjustment are required.' });
    }

    try {
        const session = await getContentSessionForUser(sessionId, req.user.id);
        if (!session) return res.status(404).json({ error: 'Sessão de conteúdo não encontrada.' });

        const auth = await getGoogleAuthOrRespond(req, res);
        if (!auth) return;

        const [medicalContext, messages] = await Promise.all([
            resolveMedicalContextForDoctor({
                doctorId: session.doctor_id,
                doctorRow: session,
                auth
            }),
            getContentChatMessages(session.id)
        ]);

        const refinedCopy = await medicalController.refineMedicalCopy({
            originalPrompt: session.original_prompt,
            originalContent: session.original_content,
            currentContent: session.current_content,
            userAdjustment,
            medicalContext,
            chatHistory: formatChatHistoryForPrompt(messages)
        });

        const refused = medicalController.isRefinementRefusal(refinedCopy);

        await addContentChatMessage({
            sessionId: session.id,
            role: 'user',
            message: userAdjustment
        });
        await addContentChatMessage({
            sessionId: session.id,
            role: 'assistant',
            message: refinedCopy,
            contentSnapshot: refused ? session.current_content : refinedCopy
        });

        if (!refused) {
            await updateContentSessionCurrentContent(session.id, refinedCopy);
        } else {
            await touchContentSession(session.id);
        }

        return res.status(200).json({
            message: refused ? 'Pedido fora do escopo do modo chat.' : 'Conteúdo ajustado.',
            copy: refused ? session.current_content : refinedCopy,
            assistantMessage: refinedCopy,
            refused,
            updated: !refused
        });
    } catch (error) {
        if (await handleGoogleApiAuthFailure(req, res, error)) return;
        console.error('[Content Chat] Falha ao refinar conteúdo:', error.message);
        return res.status(500).json({ error: 'Falha ao ajustar o conteúdo: ' + error.message });
    }
});

app.post('/api/content-sessions/:sessionId/export', ensureAuthenticated, async (req, res) => {
    const sessionId = String(req.params.sessionId || '').trim();
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' });

    try {
        const session = await getContentSessionForUser(sessionId, req.user.id);
        if (!session) return res.status(404).json({ error: 'Sessão de conteúdo não encontrada.' });

        const auth = await getGoogleAuthOrRespond(req, res);
        if (!auth) return;

        const messages = await getContentChatMessages(session.id);
        const driveFile = await uploadContentHistoryToDrive({
            session,
            messages,
            user: req.user,
            auth
        });
        const driveUrl = driveFile.webViewLink || `https://drive.google.com/file/d/${driveFile.id}/view`;

        return res.status(200).json({
            message: 'Histórico salvo na pasta do cliente.',
            driveFileId: driveFile.id,
            driveUrl
        });
    } catch (error) {
        if (await handleGoogleDriveWriteScopeFailure(req, res, error)) return;
        if (await handleGoogleApiAuthFailure(req, res, error)) return;
        console.error('[Content Chat] Falha ao exportar histórico:', error.message);
        return res.status(500).json({ error: 'Falha ao salvar histórico no Drive: ' + error.message });
    }
});

app.post('/api/download-docx', ensureAuthenticated, async (req, res) => {
    const { doctorId, copyText } = req.body;
    if (!copyText || typeof copyText !== 'string') {
        return res.status(400).json({ error: 'copyText is required.' });
    }

    try {
        const now = new Date();
        const YYYY = now.getFullYear();
        const MM = String(now.getMonth() + 1).padStart(2, '0');
        const DD = String(now.getDate()).padStart(2, '0');
        const HH = String(now.getHours()).padStart(2, '0');
        const MI = String(now.getMinutes()).padStart(2, '0');

        let doctorName = 'copy';
        if (doctorId) {
            const doctorRow = await dbGet(`SELECT name FROM doctors WHERE id = ?`, [doctorId]);
            if (doctorRow && doctorRow.name) doctorName = doctorRow.name;
        }

        const safeDoctorName = doctorName
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-zA-Z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '')
            .toLowerCase() || 'copy';

        const filename = `${safeDoctorName}-${YYYY}${MM}${DD}-${HH}${MI}.docx`;
        const normalizedText = copyText.replace(/\r\n/g, '\n');
        const lines = normalizedText.split('\n');
        const paragraphs = lines.length
            ? lines.map((line) => new Paragraph({ children: [new TextRun(line)] }))
            : [new Paragraph('')];

        const doc = new Document({
            sections: [{ children: paragraphs }]
        });
        const fileBuffer = await Packer.toBuffer(doc);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.status(200).send(fileBuffer);
    } catch (err) {
        console.error('[Download] Failed to build .docx:', err.message);
        return res.status(500).json({ error: 'Falha ao gerar o arquivo .docx.' });
    }
});

app.post('/api/feedback', ensureAuthenticated, async (req, res) => {
    const doctorId = String(req.body.doctorId || '').trim();
    const feedbackText = String(req.body.feedbackText || '').trim();
    const regenerateRequest = req.body.regenerateRequest || null;

    if (!doctorId || !feedbackText) {
        return res.status(400).json({ error: 'doctorId and feedbackText are required.' });
    }

    try {
        const auth = await getGoogleAuthOrRespond(req, res);
        if (!auth) return;

        const userName = req.user?.displayName || 'Usuário';
        const doctorRow = await persistDoctorFeedback({ doctorId, feedbackText, userName, auth });

        if (!regenerateRequest) {
            return res.status(200).json({ message: 'Feedback synchronized with Drive.' });
        }

        try {
            const result = await generateCopyFromRequest(
                { ...regenerateRequest, doctorId },
                auth,
                doctorRow
            );

            return res.status(200).json({
                message: 'Feedback synchronized with Drive.',
                copy: result.copy
            });
        } catch (generationError) {
            if (await handleGoogleApiAuthFailure(req, res, generationError)) return;

            console.error('Error generating content after feedback sync:', generationError.message);
            return res.status(500).json({
                error: 'Feedback salvo, mas falhou ao gerar novamente: ' + generationError.message,
                feedbackSaved: true
            });
        }
    } catch (err2) {
        if (await handleGoogleDriveWriteScopeFailure(req, res, err2)) return;
        if (await handleGoogleApiAuthFailure(req, res, err2)) return;
        console.error('Error syncing feedback:', err2.message);
        return res.status(500).json({ error: 'Failed to synchronize feedback: ' + err2.message });
    }
});

app.post('/api/tool-feedback-email', ensureAuthenticated, async (req, res) => {
    const { message } = req.body;
    const trimmedMessage = typeof message === 'string' ? message.trim() : '';

    if (!trimmedMessage) {
        return res.status(400).json({ error: 'message is required.' });
    }

    const senderEmail = req.user?.email;
    if (!senderEmail) {
        return res.status(400).json({ error: 'Unable to detect logged user email.' });
    }

    try {
        const auth = await getGoogleAuthOrRespond(req, res);
        if (!auth) return;

        const senderName = req.user?.displayName || senderEmail.split('@')[0];
        const now = new Date();
        const dateLabel = now.toLocaleString('pt-BR');

        const rawEmail = [
            `From: "${senderName}" <${senderEmail}>`,
            `To: willian.gerei@resultpubli.com.br`,
            `Subject: Feedback da ferramenta - ${senderName}`,
            `Reply-To: ${senderEmail}`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            '',
            `Feedback enviado por: ${senderName} (${senderEmail})`,
            `Data: ${dateLabel}`,
            '',
            trimmedMessage
        ].join('\r\n');

        const gmail = createGmailClient(auth);

        await gmail.users.messages.send({
            userId: 'me',
            requestBody: { raw: toBase64Url(rawEmail) }
        });

        return res.status(200).json({ message: 'Feedback enviado com sucesso.' });
    } catch (err) {
        if (await handleGoogleApiAuthFailure(req, res, err)) return;
        console.error('[Tool Feedback] Failed to send email:', err.message);
        return res.status(500).json({ error: 'Falha ao enviar feedback por e-mail: ' + err.message });
    }
});

// ── Onboarding Route (Tier 3 Execution) ─────────────────────────────────────
app.post('/api/onboard-doctor', ensureAuthenticated, upload.array('files'), async (req, res) => {
    const { name, specialty, cs_responsible, briefing } = req.body;

    if (!name || !specialty) {
        return res.status(400).json({ error: 'Nome e especialidade são obrigatórios.' });
    }

    let contentNotes = '';
    try {
        contentNotes = normalizeContentNotes(req.body.content_notes || req.body.contentNotes || '');
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    try {
        const auth = await getGoogleAuthOrRespond(req, res);
        if (!auth) return;

        await ensureDoctorsContentNotesColumn();
        const drive = createDriveClient(auth);

        // a) Criar pasta no Drive com o nome do médico
        const folderMetadata = {
            name: name,
            mimeType: 'application/vnd.google-apps.folder'
        };

        // Se houver uma pasta pai configurada no .env, usá-la
        if (process.env.GOOGLE_DRIVE_PARENT_ID) {
            folderMetadata.parents = [process.env.GOOGLE_DRIVE_PARENT_ID];
        }

        const folderRes = await drive.files.create({
            requestBody: folderMetadata,
            fields: 'id'
        });
        const folderId = folderRes.data.id;
        console.log(`[Onboarding] Pasta criada: ${folderId} (${name})`);

        // b) Fazer upload dos arquivos .docx/.pdf para a pasta
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                const stream = Readable.from(file.buffer);
                await drive.files.create({
                    requestBody: {
                        name: file.originalname,
                        parents: [folderId]
                    },
                    media: { mimeType: file.mimetype, body: stream },
                    fields: 'id'
                });
                console.log(`[Onboarding] Arquivo enviado: ${file.originalname}`);
            }
        }

        // c) Criar instruções.md com área de atuação + mini-briefing
        const instructionsContent = `# Instruções do Paciente / Cliente\n\n## Área de Atuação\n${specialty}\n\n## Minibriefing\n${briefing || '(não preenchido)'}\n`;
        const instructionsStream = Readable.from(Buffer.from(instructionsContent, 'utf-8'));
        const instrRes = await drive.files.create({
            requestBody: { name: 'instruções.md', parents: [folderId] },
            media: { mimeType: 'text/plain', body: instructionsStream },
            fields: 'id'
        });
        const instructionsDocId = instrRes.data.id;
        console.log(`[Onboarding] instruções.md criado: ${instructionsDocId}`);

        // d) Criar feedback.md (vazio)
        const feedbackStream = Readable.from(Buffer.from('', 'utf-8'));
        const feedbackRes = await drive.files.create({
            requestBody: { name: 'feedback.md', parents: [folderId] },
            media: { mimeType: 'text/plain', body: feedbackStream },
            fields: 'id'
        });
        const feedbackDocId = feedbackRes.data.id;
        console.log(`[Onboarding] feedback.md criado: ${feedbackDocId}`);

        // e) INSERT no SQLite
        db.run(
            `INSERT INTO doctors (name, specialty, drive_folder_id, instructions_doc_id, feedback_doc_id, content_notes) VALUES (?, ?, ?, ?, ?, ?)`,
            [name, specialty, folderId, instructionsDocId, feedbackDocId, contentNotes || null],
            function (err) {
                if (err) {
                    console.error('[Onboarding] Erro no INSERT:', err.message);
                    return res.status(500).json({ error: 'Falha ao mapear médico no banco: ' + err.message });
                }
                console.log(`[Onboarding] Médico inserido no banco. ID: ${this.lastID}`);
                res.json({ success: true, doctorId: this.lastID, folderId });
            }
        );

    } catch (err) {
        if (await handleGoogleApiAuthFailure(req, res, err)) return;
        console.error('[Onboarding] Erro na API do Drive:', err.message);
        res.status(500).json({ error: 'Erro na API do Drive: ' + err.message });
    }
});

// ── Trends Scraper Route (Tier 2 AI Orchestration) ─────────────────────────
app.get('/api/trends', ensureAuthenticated, async (req, res) => {
    const forceRefresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
    const selectedCategory = normalizeMedicalCategory(req.query.category);

    const cachedTrends = getTrendsCache(selectedCategory);
    if (!forceRefresh && cachedTrends) {
        console.log(`[Trends] Servindo do cache category=${selectedCategory || 'Todas'}`);
        return res.json(cachedTrends);
    }

    try {
        console.log(forceRefresh ? '[Trends] Refresh forçado. Recoletando temas...' : '[Trends] Buscando novos temas...');
        const sources = [
            {
                url: 'https://www.byrdie.com/wellness-4628395',
                category: 'Bem-estar',
                selectors: [
                    { container: '.card', title: '.card__title-text' },
                    { container: 'a[data-doc-id]', title: '.card__title-text' },
                    { container: 'a[href*="/"]', title: 'h2, h3' }
                ]
            },
            {
                url: 'https://www.byrdie.com/hair-4628407',
                category: 'Cabelo',
                selectors: [
                    { container: '.card', title: '.card__title-text' },
                    { container: 'a[data-doc-id]', title: '.card__title-text' },
                    { container: 'a[href*="/"]', title: 'h2, h3' }
                ]
            },
            {
                url: 'https://www.theskimm.com/health',
                category: 'Saúde',
                selectors: [
                    { container: 'a.group', title: 'h3' },
                    { container: 'a[href*="/news"]', title: 'h2, h3, p' },
                    { container: 'article a', title: 'h2, h3' }
                ]
            },
            {
                url: 'https://labmuffin.com',
                category: 'Beleza',
                selectors: [
                    { container: 'article h2.entry-title a', title: null, directAnchor: true },
                    { container: 'article h3.entry-title a', title: null, directAnchor: true },
                    { container: 'article a', title: 'h2, h3, .entry-title' }
                ]
            },
            {
                url: 'https://www.allure.com/wellness/body-image',
                category: 'Bem-estar',
                selectors: [
                    { container: '.SummaryItemHedLink', title: '.SummaryItemHed' },
                    { container: 'a[href*="/story/"]', title: 'h2, h3, span' },
                    { container: 'article a', title: 'h2, h3' }
                ]
            },
            {
                url: 'https://www.allure.com/wellness/mental-health',
                category: 'Saúde mental',
                selectors: [
                    { container: '.SummaryItemHedLink', title: '.SummaryItemHed' },
                    { container: 'a[href*="/story/"]', title: 'h2, h3, span' },
                    { container: 'article a', title: 'h2, h3' }
                ]
            },
            {
                url: 'https://www.self.com/health',
                category: 'Saúde',
                selectors: [
                    { container: '.SummaryItemHedLink', title: '.SummaryItemHed' },
                    { container: 'a[href*="/story/"]', title: 'h2, h3, span' },
                    { container: 'article a', title: 'h2, h3' }
                ]
            },
            {
                url: 'https://www.self.com/beauty',
                category: 'Beleza',
                selectors: [
                    { container: '.SummaryItemHedLink', title: '.SummaryItemHed' },
                    { container: 'a[href*="/story/"]', title: 'h2, h3, span' },
                    { container: 'article a', title: 'h2, h3' }
                ]
            },
            {
                url: 'https://www.mindbodygreen.com/health',
                category: 'Saúde',
                selectors: [
                    { container: 'a[href*="/articles/"]', title: 'h2, h3, p' },
                    { container: 'article a', title: 'h2, h3' },
                    { container: '.card a', title: 'h2, h3' }
                ]
            },
            {
                url: 'https://www.mindbodygreen.com/beauty',
                category: 'Beleza',
                selectors: [
                    { container: 'a[href*="/articles/"]', title: 'h2, h3, p' },
                    { container: 'article a', title: 'h2, h3' },
                    { container: '.card a', title: 'h2, h3' }
                ]
            },
            {
                url: 'https://www.abcheartfailure.org/',
                category: 'Cardiologia',
                selectors: [
                    { container: 'article a', title: 'h1, h2, h3, .entry-title' },
                    { container: '.post a', title: 'h1, h2, h3, .entry-title' },
                    { container: 'a[href*="/"]', title: 'h1, h2, h3, .title' }
                ]
            },
            {
                url: 'https://ijcscardiol.org/#most-visited-list',
                category: 'Cardiologia',
                selectors: [
                    { container: '#most-visited-list a', title: null, directAnchor: true },
                    { container: '.most-visited a', title: null, directAnchor: true },
                    { container: 'article a', title: 'h2, h3, .article-title' }
                ]
            },
            {
                url: 'https://pubmed.ncbi.nlm.nih.gov/?term=cardiology&filter=hum_ani.humans&filter=other.excludepreprints&filter=years.2025-2028&size=100',
                category: 'Cardiologia',
                selectors: [
                    { container: 'a.docsum-title', title: null, directAnchor: true },
                    { container: '.docsum-content a.docsum-title', title: null, directAnchor: true },
                    { container: 'article.full-docsum', title: 'a.docsum-title' }
                ]
            },
            {
                url: 'https://pubmed.ncbi.nlm.nih.gov/?term=cardiology&filter=datesearch.y_1&filter=pubt.review&sort=date&size=100',
                category: 'Cardiologia',
                selectors: [
                    { container: 'a.docsum-title', title: null, directAnchor: true },
                    { container: '.docsum-content a.docsum-title', title: null, directAnchor: true },
                    { container: 'article.full-docsum', title: 'a.docsum-title' }
                ]
            }
        ];

        let trends = [];

        const addTrend = (bucket, source, title, href) => {
            const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim();
            const cleanHref = String(href || '').trim();
            if (!cleanTitle || cleanTitle.length < 18 || !cleanHref) return;
            try {
                const urlObj = new URL(cleanHref, source.url);
                if (!/^https?:$/.test(urlObj.protocol)) return;
                bucket.push({ title: cleanTitle, url: urlObj.href, category: source.category });
            } catch {
                // Ignore malformed URLs
            }
        };

        const extractFromSelectors = ($, source) => {
            const extracted = [];
            for (const rule of source.selectors || []) {
                $(rule.container).slice(0, 24).each((i, el) => {
                    if (rule.directAnchor) {
                        addTrend(extracted, source, $(el).text(), $(el).attr('href'));
                        return;
                    }
                    const anchor = $(el).is('a') ? $(el) : $(el).find('a').first();
                    const href = anchor.attr('href') || $(el).attr('href');
                    const title = rule.title
                        ? ($(el).find(rule.title).first().text().trim() || anchor.find(rule.title).first().text().trim() || anchor.text().trim())
                        : anchor.text().trim();
                    addTrend(extracted, source, title, href);
                });
                if (extracted.length >= 10) break;
            }
            return extracted;
        };

        const extractFromJsonLd = ($, source) => {
            const extracted = [];
            $('script[type="application/ld+json"]').each((i, el) => {
                const raw = $(el).contents().text();
                if (!raw) return;
                try {
                    const parsed = JSON.parse(raw);
                    const nodes = Array.isArray(parsed) ? parsed : [parsed];
                    nodes.forEach((node) => {
                        if (Array.isArray(node?.itemListElement)) {
                            node.itemListElement.forEach((item) => {
                                const candidate = item?.item || item;
                                addTrend(extracted, source, candidate?.headline || candidate?.name, candidate?.url);
                            });
                        }
                        addTrend(extracted, source, node?.headline || node?.name, node?.url);
                    });
                } catch {
                    // Ignore invalid JSON-LD blocks
                }
            });
            return extracted;
        };

        for (const source of sources) {
            try {
                const { data } = await axios.get(source.url, { timeout: 15000 });
                const $ = cheerio.load(data);
                const selectorItems = extractFromSelectors($, source);
                const jsonLdItems = extractFromJsonLd($, source);
                const fromSource = [...selectorItems, ...jsonLdItems];
                const sourceUnique = Array.from(
                    fromSource.reduce((map, item) => {
                        const key = `${item.title.toLowerCase()}::${item.url}`;
                        if (!map.has(key)) map.set(key, item);
                        return map;
                    }, new Map()).values()
                ).slice(0, 8);

                trends.push(...sourceUnique);
                console.log(`[Trends] Fonte ${source.url} -> ${sourceUnique.length} itens`);
            } catch (sourceErr) {
                console.warn(`[Trends] Falha na fonte ${source.url}: ${sourceErr.message}`);
            }
        }

        if (!trends.length) throw new Error('Nenhuma tendência encontrada nas fontes configuradas.');

        const uniqueTrends = Array.from(
            trends.reduce((map, item) => {
                const key = `${item.title.toLowerCase()}::${item.url}`;
                if (!map.has(key)) map.set(key, item);
                return map;
            }, new Map()).values()
        );

        const categoryScopedTrends = filterTrendsByMedicalCategory(uniqueTrends, selectedCategory);
        if (!categoryScopedTrends.length) {
            console.log(`[Trends] Nenhuma trend encontrada para category=${selectedCategory || 'Todas'}`);
            setTrendsCache(selectedCategory, []);
            return res.json([]);
        }

        const selectedTrends = categoryScopedTrends.sort(() => 0.5 - Math.random()).slice(0, MAX_TRENDS);

        // Tier 3 deterministic translation (no LLM): batch translate titles with Google Cloud Translation API.
        const originalTitles = selectedTrends.map((item) => item.title);
        const { translatedTexts, stats } = await translateBatch(originalTitles, { target: 'pt-BR', source: 'en' });

        const translatedTrends = selectedTrends.map((item, index) => ({
            ...item,
            title: translatedTexts[index] || item.title
        }));

        if (stats.reason === 'missing_api_key') {
            console.warn('[Trends][Translation] GOOGLE_TRANSLATE_API_KEY ausente; mantendo títulos originais.');
        } else if (stats.fallback === stats.requested && stats.requested > 0) {
            console.warn(`[Trends][Translation] Falha total; fallback aplicado em ${stats.fallback}/${stats.requested}. ${stats.errorMessage || ''}`.trim());
        } else if (stats.fallback > 0) {
            console.warn(`[Trends][Translation] Fallback parcial em ${stats.fallback}/${stats.requested}.`);
        }
        console.log(`[Trends][Translation] requested=${stats.requested} translated=${stats.translated} fallback=${stats.fallback}`);

        setTrendsCache(selectedCategory, translatedTrends);
        res.json(translatedTrends);

    } catch (err) {
        console.error('[Trends] Falha ao raspar temas:', err.message);
        res.status(500).json({ error: "Falha ao carregar tendências." });
    }
});

// Starts the Medical Controller Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            console.error(err.message);
        }
        console.log('Close the database connection.');
        process.exit(0);
    });
});
