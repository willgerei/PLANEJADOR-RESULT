const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../database/metadata.db');
const db = new sqlite3.Database(dbPath);

const realDoctor = {
    name: 'Médico Teste (ResultPubli)',
    specialty: 'Marketing Médico RAG',
    drive_folder_id: '1JYlyhrfBqDuDgD9EPD4v_fmPchxk9VHX',
    instructions_doc_id: '13n-wOFSJdUx4ZDOPC35fp4uRZVDIIJSL',
    feedback_doc_id: '1PFfOY08dzD9ixGkXnPEoTpn9LC7VKP08'
};

db.serialize(() => {
    // Clear old mock data to avoid confusion
    db.run(`DELETE FROM doctors`);

    const stmt = db.prepare(`INSERT INTO doctors (name, specialty, drive_folder_id, instructions_doc_id, feedback_doc_id) VALUES (?, ?, ?, ?, ?)`);
    stmt.run(realDoctor.name, realDoctor.specialty, realDoctor.drive_folder_id, realDoctor.instructions_doc_id, realDoctor.feedback_doc_id);
    stmt.finalize();

    console.log("Real Template Doctor seeded successfully.");
});

db.close();
