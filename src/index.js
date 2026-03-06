require('dotenv').config();
const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { google } = require('googleapis');
const multer = require('multer');
const { Readable } = require('stream');
const axios = require('axios');
const cheerio = require('cheerio');
const medicalController = require('./MedicalController');

const upload = multer({ storage: multer.memoryStorage() });

// Trends Cache (30 min)
let trendsCache = { data: null, timestamp: 0 };
const CACHE_TTL = 0; // Disabled cache to ensure dynamic updates per session as requested

const app = express();
const PORT = process.env.PORT || 3000;
const dbPath = path.join(__dirname, '../database/metadata.db');

// Connect to SQLite Database
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => {
    if (err) {
        console.error('Could not connect to database', err.message);
    } else {
        console.log('Connected to SQLite metadata indexer.');
    }
});

// Setup View Engine
app.set('views', path.join(__dirname, '../views'));
app.set('view engine', 'ejs');

// Setup Session
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-for-dev-only-change-me',
    resave: false,
    saveUninitialized: false
}));

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Passport Google Strategy mapping to ResultPubli Corporate Restrictions
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || 'your-client-id',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'your-client-secret',
    callbackURL: "http://localhost:3000/auth/google/callback"
},
    function (accessToken, refreshToken, profile, cb) {
        // Hosted Domain Restriction check (Tier 1 compliance)
        if (profile._json.hd === 'resultpubli.com.br' || profile.emails[0].value.endsWith('@resultpubli.com.br')) {
            // Attach token to profile so we can use it for Drive API
            profile.accessToken = accessToken;
            return cb(null, profile);
        } else {
            // Failure: user is not from the authorized domain
            return cb(new Error("Unauthorized domain. ResultPubli corporate accounts only."), null);
        }
    }
));

passport.serializeUser(function (user, cb) {
    cb(null, user);
});

passport.deserializeUser(function (obj, cb) {
    cb(null, obj);
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
    res.render('login');
});

app.get('/auth/google',
    passport.authenticate('google', {
        scope: [
            'profile',
            'email',
            'https://www.googleapis.com/auth/documents',
            'https://www.googleapis.com/auth/drive.readonly',
            'https://www.googleapis.com/auth/drive.file'
        ]
    })
);

app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/login?error=domain' }),
    function (req, res) {
        res.redirect('/');
    }
);

app.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) { return next(err); }
        res.redirect('/login');
    });
});

// Serve the Main UI (Protected)
app.get('/', ensureAuthenticated, (req, res) => {
    res.render('index', { user: req.user });
});

// API Routes (Tier 3 Execution)
// Get all doctors metadata (Protected API)
app.get('/api/doctors', ensureAuthenticated, (req, res) => {
    db.all(`SELECT id, name, specialty, drive_folder_id, instructions_doc_id, feedback_doc_id FROM doctors`, [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({
            message: "success",
            data: rows
        });
    });
});

// Tier 2 Orchestration Route
app.post('/api/orchestrate', ensureAuthenticated, async (req, res) => {
    const { doctorId, prompt } = req.body;

    if (!doctorId || !prompt) {
        return res.status(400).json({ error: "Missing doctor ID or prompt." });
    }

    db.get(`SELECT id, drive_folder_id, instructions_doc_id, feedback_doc_id FROM doctors WHERE id = ?`, [doctorId], async (err, row) => {
        if (err || !row) {
            return res.status(500).json({ error: "Failed to locate doctor metadata." });
        }

        try {
            // Tier 2 execution sequence - Passing User Access Token for Drive authorization
            const contextStr = await medicalController.fetchContext(row.instructions_doc_id, row.feedback_doc_id, req.user.accessToken, row.drive_folder_id);
            const generatedCopy = await medicalController.generateMedicalCopy(prompt, contextStr);

            res.json({
                message: "Success",
                doctorContextRetrieved: true,
                copy: generatedCopy
            });

        } catch (orchestrationError) {
            res.status(500).json({ error: orchestrationError.message });
        }
    });
});

app.post('/api/feedback', ensureAuthenticated, async (req, res) => {
    const { doctorId, feedbackText } = req.body;
    if (!doctorId || !feedbackText) return res.status(400).json({ error: 'doctorId and feedbackText are required.' });

    db.get(`SELECT feedback_doc_id FROM doctors WHERE id = ?`, [doctorId], async (err, row) => {
        if (err || !row) return res.status(500).json({ error: "Failed to locate doctor metadata." });

        const feedbackDocId = row.feedback_doc_id;
        if (!feedbackDocId) return res.status(500).json({ error: 'Feedback document ID not mapped for this doctor.' });

        try {
            // Build header with user display name and formatted timestamp
            const userName = (req.user && (req.user.displayName || (req.user.name && req.user.name.givenName))) || 'Usuário';
            const now = new Date();
            const HH = String(now.getHours()).padStart(2, '0');
            const MM = String(now.getMinutes()).padStart(2, '0');
            const DD = String(now.getDate()).padStart(2, '0');
            const MMm = String(now.getMonth() + 1).padStart(2, '0');
            const YYYY = now.getFullYear();
            const header = `\n[${userName}] deu feedback as ${HH}:${MM} ${DD}/${MMm}/${YYYY}: ${feedbackText}\n---\n`;

            // Delegate to controller which handles Drive read+update
            await medicalController.appendFeedback(feedbackDocId, header, req.user.accessToken);
            res.status(200).json({ message: 'Feedback synchronized with Drive.' });
        } catch (err2) {
            console.error('Error syncing feedback:', err2.message);
            res.status(500).json({ error: 'Failed to synchronize feedback: ' + err2.message });
        }
    });
});

// ── Onboarding Route (Tier 3 Execution) ─────────────────────────────────────
app.post('/api/onboard-doctor', ensureAuthenticated, upload.array('files'), async (req, res) => {
    const { name, specialty, cs_responsible, briefing } = req.body;

    if (!name || !specialty) {
        return res.status(400).json({ error: 'Nome e especialidade são obrigatórios.' });
    }

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: req.user.accessToken });
    const drive = google.drive({ version: 'v3', auth });

    try {
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
        console.error('[Onboarding] Erro na API do Drive:', err.message);
        res.status(500).json({ error: 'Erro na API do Drive: ' + err.message });
    }
});

// ── Trends Scraper Route (Tier 2 AI Orchestration) ─────────────────────────
app.get('/api/trends', ensureAuthenticated, async (req, res) => {
    const now = Date.now();
    if (trendsCache.data && (now - trendsCache.timestamp < CACHE_TTL)) {
        console.log('[Trends] Servindo do cache');
        return res.json(trendsCache.data);
    }

    try {
        console.log('[Trends] Buscando novos temas no Byrdie...');
        const urls = [
            'https://www.byrdie.com/wellness-4628395',
            'https://www.byrdie.com/hair-4628407',
            'https://www.theskimm.com/health'
        ];

        let trends = [];

        for (const url of urls) {
            const { data } = await axios.get(url);
            const $ = cheerio.load(data);
            // Normalize category names to Portuguese for consistent UI
            const category = url.includes('wellness') ? 'Bem-estar' : url.includes('hair') ? 'Cabelo' : 'Saúde';

            // Scraper logic for both architectures
            const selector = url.includes('theskimm') ? 'a.group' : '.card';
            const titleSelector = url.includes('theskimm') ? 'h3' : '.card__title-text';

            $(selector).slice(0, 5).each((i, el) => {
                const title = $(el).find(titleSelector).text().trim();
                const link = url.includes('theskimm') ? 'https://www.theskimm.com' + $(el).attr('href') : $(el).attr('href');
                if (title && link) {
                    trends.push({ title, url: link, category });
                }
            });
        }

        // Shuffle
        trends = trends.sort(() => 0.5 - Math.random()).slice(0, 4);

        // Translate and refine with AI
        const translatedTrends = await Promise.all(trends.map(async (item) => {
            const translatedTitle = await medicalController.translateTrend(item.title);
            return { ...item, title: translatedTitle };
        }));

        trendsCache = { data: translatedTrends, timestamp: now };
        res.json(translatedTrends);

    } catch (err) {
        console.error('[Trends] Falha ao raspar temas:', err.message);
        res.status(500).json({ error: "Falha ao carregar tendências." });
    }
});

// Starts the Medical Controller Server
app.listen(PORT, () => {
    console.log(`ResultPubli Agentic System running on http://localhost:${PORT}`);
    console.log('Running in Corporate Mode. Premium Light Theme active.');
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
