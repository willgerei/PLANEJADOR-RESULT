const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'metadata.db');

// Ensure database directory exists
if (!fs.existsSync(__dirname)) {
    fs.mkdirSync(__dirname, { recursive: true });
}

// Connect to the database
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        setupTables();
    }
});

function setupTables() {
    db.serialize(() => {
        // Create table for Doctors and their Google Drive Info
        db.run(`CREATE TABLE IF NOT EXISTS doctors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            specialty TEXT,
            drive_folder_id TEXT NOT NULL,
            instructions_doc_id TEXT NOT NULL,
            feedback_doc_id TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) {
                console.error("Error creating 'doctors' table", err.message);
            } else {
                console.log("'doctors' table initialized.");

                // Add default test doctor if it doesn't exist to have something to show
                db.get(`SELECT count(*) as count FROM doctors`, [], (err, row) => {
                    if (err) return console.error(err.message);
                    if (row.count === 0) {
                        const initStmt = db.prepare(`INSERT INTO doctors (name, specialty, drive_folder_id, instructions_doc_id, feedback_doc_id) VALUES (?, ?, ?, ?, ?)`);
                        initStmt.run('Dr. Teste', 'Dermatologia', 'FOLDER_ID_EXAMPLE', 'INSTRUCTIONS_ID_EXAMPLE', 'FEEDBACK_ID_EXAMPLE');
                        initStmt.finalize();
                        console.log("Mock doctor added.");
                    }
                });
            }
        });
    });

    // Close the database connection after initialization
    db.close((err) => {
        if (err) {
            console.error('Error closing database', err.message);
        } else {
            console.log('Database connection closed.');
        }
    });
}
