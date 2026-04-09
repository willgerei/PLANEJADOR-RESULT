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
const { translateBatch } = require('./services/translationExecutionService');

const upload = multer({ storage: multer.memoryStorage() });

// Trends Cache (30 min)
let trendsCache = { data: null, timestamp: 0 };
const CACHE_TTL = 30 * 60 * 1000;
const MAX_TRENDS = 12;

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
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.file',
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

function initializeDoctorsTable() {
    db.run(`
        CREATE TABLE IF NOT EXISTS doctors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            specialty TEXT,
            drive_folder_id TEXT NOT NULL,
            instructions_doc_id TEXT NOT NULL,
            feedback_doc_id TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) {
            console.error("[SQLite] Falha ao garantir a tabela 'doctors':", err.message);
            return;
        }
        console.log("[SQLite] Tabela 'doctors' pronta para uso.");
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

async function getGoogleAuthOrRespond(req, res) {
    try {
        return await getGoogleAuthClientForUser(req.user?.id);
    } catch (error) {
        const handled = await handleGoogleApiAuthFailure(req, res, error);
        if (handled) return null;
        throw error;
    }
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
        const rows = await dbAll(
            `SELECT id, name, specialty, drive_folder_id, instructions_doc_id, feedback_doc_id
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
    const { doctorId, prompt, trendUrl, trendTitle } = req.body;

    if (!doctorId || !prompt) {
        return res.status(400).json({ error: "Missing doctor ID or prompt." });
    }

    try {
        const auth = await getGoogleAuthOrRespond(req, res);
        if (!auth) return;

        const row = await dbGet(
            `SELECT id, drive_folder_id, instructions_doc_id, feedback_doc_id
             FROM doctors
             WHERE id = ?`,
            [doctorId]
        );

        if (!row) {
            return res.status(500).json({ error: "Failed to locate doctor metadata." });
        }

        const contextStr = await medicalController.fetchContext(
            row.instructions_doc_id,
            row.feedback_doc_id,
            auth,
            row.drive_folder_id
        );

        let trendContext = '';
        if (trendUrl) {
            try {
                trendContext = await medicalController.fetchTrendArticleContext(trendUrl, trendTitle);
            } catch (trendError) {
                console.warn('[Trends] Falha ao anexar contexto da materia:', trendError.message);
            }
        }

        const generatedCopy = await medicalController.generateMedicalCopy(prompt, contextStr, trendContext);

        res.json({
            message: "Success",
            doctorContextRetrieved: true,
            copy: generatedCopy
        });
    } catch (orchestrationError) {
        if (await handleGoogleApiAuthFailure(req, res, orchestrationError)) return;
        res.status(500).json({ error: orchestrationError.message });
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
    const { doctorId, feedbackText } = req.body;
    if (!doctorId || !feedbackText) {
        return res.status(400).json({ error: 'doctorId and feedbackText are required.' });
    }

    try {
        const auth = await getGoogleAuthOrRespond(req, res);
        if (!auth) return;

        // a) Captura usuário logado via OAuth e formata cabeçalho de log
        const userName = req.user?.displayName || 'Usuário';
        const now = new Date();
        const HH = String(now.getHours()).padStart(2, '0');
        const MM = String(now.getMinutes()).padStart(2, '0');
        const DD = String(now.getDate()).padStart(2, '0');
        const MMm = String(now.getMonth() + 1).padStart(2, '0');
        const YYYY = now.getFullYear();
        const header = `\n[${userName}] deu feedback as ${HH}:${MM} ${DD}/${MMm}/${YYYY}: ${feedbackText}\n---`;

        // b) Busca o feedback_doc_id exclusivo no SQLite
        const row = await dbGet(`SELECT feedback_doc_id FROM doctors WHERE id = ?`, [doctorId]);
        if (!row) return res.status(500).json({ error: "Failed to locate doctor metadata." });
        const feedbackDocId = row.feedback_doc_id;
        if (!feedbackDocId) return res.status(500).json({ error: 'Feedback document ID not mapped for this doctor.' });

        // c) Lê conteúdo atual do feedback.md no Drive (GET / alt=media)
        const drive = createDriveClient(auth);

        const getRes = await drive.files.get(
            { fileId: feedbackDocId, alt: 'media' },
            { responseType: 'text' }
        );
        const existingContent = typeof getRes.data === 'string' ? getRes.data : '';

        // d) Concatena o log no topo (ordem cronológica reversa)
        const updatedContent = `${header}\n${existingContent}`;

        // e) Atualiza o arquivo com PATCH na Drive API v3
        await drive.files.update({
            fileId: feedbackDocId,
            media: {
                mimeType: 'text/markdown',
                body: Readable.from(Buffer.from(updatedContent, 'utf-8'))
            },
            requestBody: { mimeType: 'text/markdown' }
        });

        // f) Retorna sucesso
        return res.status(200).json({ message: 'Feedback synchronized with Drive.' });
    } catch (err2) {
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

    try {
        const auth = await getGoogleAuthOrRespond(req, res);
        if (!auth) return;

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
            `INSERT INTO doctors (name, specialty, drive_folder_id, instructions_doc_id, feedback_doc_id) VALUES (?, ?, ?, ?, ?)`,
            [name, specialty, folderId, instructionsDocId, feedbackDocId],
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
    const now = Date.now();
    const forceRefresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());

    if (!forceRefresh && trendsCache.data && (now - trendsCache.timestamp < CACHE_TTL)) {
        console.log('[Trends] Servindo do cache');
        return res.json(trendsCache.data);
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

        const selectedTrends = uniqueTrends.sort(() => 0.5 - Math.random()).slice(0, MAX_TRENDS);

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

        trendsCache = { data: translatedTrends, timestamp: now };
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
