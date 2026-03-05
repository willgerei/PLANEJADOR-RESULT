const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * ResultPubli Medical Controller (Tier 2 Orchestrator)
 * Deterministic bridging between Google Drive (Knowledge Base) and Gemini API (Generative Engine).
 */
class MedicalController {
    constructor() {
        if (!process.env.GEMINI_API_KEY) {
            throw new Error("Critical Error: GEMINI_API_KEY is missing from .env");
        }

        // Initialize Gemini
        this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        this.fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);

        // System Prompt as requested (Immutable - Strategic Layer)
        this.systemPrompt = `Você é o Agente de planejamento de conteúdos da ResultPubli.
Sua função é criar conteúdos de alto padrão, éticos e focados em Customer Success.
Você receberá um pedido de post e deverá cruzar esse pedido estritamente com os documentos de instruções e feedbacks do médico fornecidos no contexto.

ESTRUTURA OBRIGATÓRIA DE RESPOSTA:

1. Caso seja POST FEED:
POST FEED - [tema]
Copy:
[Texto do post direto, sem negritos (**) em excesso, sem títulos internos, linguagem humana e elegante]

- LEGENDA:
[Texto da legenda com hashtags ao final]

2. Caso seja CARROSSEL:
CARROSSEL [número/tema]
TELA 1 - [Título/Gancho]
[Textos curtos e diretos por tela...]
- LEGENDA:
[Texto da legenda]

3. Caso seja REELS/ROTEIRO:
SUGESTÃO DE REELS
COPY PARA CAPA: [Texto]
[SUGESTÃO DE IMAGEM/VÍDEO]
DIRECIONAMENTO: [Explicação da estratégia]
ROTEIRO:
[Cenas e falas detalhadas]

Responda apenas com o conteúdo final no formato acima.`;

        this.model = this.genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            // Injecting the system prompt into the model configuration
            systemInstruction: this.systemPrompt
        });

        // Helper to get authorized clients per request
        this.getAuthorizedDocs = (token) => {
            const auth = new google.auth.OAuth2();
            auth.setCredentials({ access_token: token });
            return google.docs({ version: 'v1', auth });
        };

        this.getAuthorizedDrive = (token) => {
            const auth = new google.auth.OAuth2();
            auth.setCredentials({ access_token: token });
            return google.drive({ version: 'v3', auth });
        };
    }

    /**
     * Traduz e sumariza um tópico do Byrdie para post de Instagram
     */
    async translateTrend(title) {
        try {
            const prompt = `Traduza OBRIGATORIAMENTE para o português do Brasil e adapte para um título de post de Instagram atraente (estilo trend): "${title}".
REGRAS:
1. Responda APENAS com o texto traduzido em português.
2. Seja criativo, use um tom profissional e direto (máximo 12 palavras).
3. Não use aspas ou explicações.
4. Se o termo original for técnico e não tiver tradução usual, mantenha o termo mas explique brevemente em português.`;
            const result = await this.model.generateContent(prompt);
            const text = result.response.text().trim();
            // Fallback: if result is empty or too short, return title
            return text.length > 3 ? text : title;
        } catch (err) {
            console.error('[AI] Erro ao traduzir trend:', err.message);
            return title; // Fallback
        }
    }

    /**
     * Extracts pure text content from a Google Docs document structure.
     */
    _extractTextFromDoc(docData) {
        let text = '';
        if (docData.body && docData.body.content) {
            docData.body.content.forEach(element => {
                if (element.paragraph && element.paragraph.elements) {
                    element.paragraph.elements.forEach(el => {
                        if (el.textRun && el.textRun.content) {
                            text += el.textRun.content;
                        }
                    });
                }
            });
        }
        return text;
    }

    /**
     * Fetches file content regardless of type (Google Doc or Binary/Text file).
     */
    async _fetchFileContent(fileId, accessToken) {
        const docsClient = this.getAuthorizedDocs(accessToken);
        const driveClient = this.getAuthorizedDrive(accessToken);

        try {
            // Try as Google Doc first
            const response = await docsClient.documents.get({ documentId: fileId });
            return this._extractTextFromDoc(response.data);
        } catch (docError) {
            // Fallback: Try as regular file (media download)
            try {
                const response = await driveClient.files.get({
                    fileId: fileId,
                    alt: 'media'
                }, { responseType: 'text' });
                return response.data;
            } catch (driveError) {
                console.error(`Failed to fetch content for ID ${fileId}:`, driveError.message);
                throw new Error(`Cloud Fetch Error: ${driveError.message}`);
            }
        }
    }

    /**
     * Fetches instructions and feedback documents and concatenates them into a single context string.
     */
    async fetchContext(instructionsDocId, feedbackDocId, accessToken, folderId) {
        if (!instructionsDocId || !feedbackDocId) {
            throw new Error("Missing Document IDs for context retrieval.");
        }

        try {
            const driveClient = this.getAuthorizedDrive(accessToken);
            console.log(`Diagnostic: Scanning folder ${folderId} for all files...`);

            const listRes = await driveClient.files.list({
                pageSize: 20,
                fields: 'files(id, name, mimeType)',
                q: `'${folderId}' in parents and trashed = false`
            });
            console.log(`Contents of folder [${folderId}]:`, listRes.data.files.map(f => `${f.name} (${f.mimeType}): ${f.id}`));

            console.log(`Fetching contexts for IDs: ${instructionsDocId}, ${feedbackDocId}`);

            const [instructionsText, feedbackText] = await Promise.all([
                this._fetchFileContent(instructionsDocId.trim(), accessToken),
                this._fetchFileContent(feedbackDocId.trim(), accessToken)
            ]);

            return `
            --- TONE OF VOICE & GUIDELINES ---
            ${instructionsText}
            
            --- PAST FEEDBACK (Chronological) ---
            ${feedbackText}
            `;

        } catch (error) {
            console.error("Error fetching context from Google Drive:", error.message);
            throw new Error(`Failed to fetch Google Drive context: ${error.message}`);
        }
    }

    /**
     * Synthesizes the final medical copy combining context and user prompt via Gemini File Search/RAG.
     */
    async generateMedicalCopy(userPrompt, medicalContext) {
        console.log(`Preparing context for Gemini File Search/RAG...`);

        const tempFilePath = path.join(os.tmpdir(), `context_${Date.now()}.txt`);

        try {
            // Write context to a temporary file to be uploaded to Gemini File API (File Search Tool equivalent)
            fs.writeFileSync(tempFilePath, medicalContext);

            console.log(`Uploading context to Gemini File Search repository...`);
            const uploadResult = await this.fileManager.uploadFile(tempFilePath, {
                mimeType: "text/plain",
                displayName: "Medical Context",
            });

            console.log(`Context uploaded: ${uploadResult.file.uri}. Generating content...`);

            const result = await this.model.generateContent([
                {
                    fileData: {
                        mimeType: uploadResult.file.mimeType,
                        fileUri: uploadResult.file.uri
                    }
                },
                { text: `PROMPT DO USUÁRIO: ${userPrompt}` }
            ]);

            // Optional: Cleanup local temporary file
            fs.unlinkSync(tempFilePath);

            return result.response.text();
        } catch (error) {
            console.error("Gemini Generation Error:", error.message);
            // Cleanup on error
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            throw new Error(`Failed to generate content with Gemini AI: ${error.message}`);
        }
    }

    /**
     * Appends new chronologic learning/feedback directly to the top of the Google Docs file.
     */
    async appendFeedback(feedbackDocId, newFeedbackText, accessToken) {
        if (!feedbackDocId) throw new Error("Missing Feedback Document ID.");

        try {
            const docsClient = this.getAuthorizedDocs(accessToken);
            const dateStr = new Date().toISOString().split('T')[0];
            const formattedFeedback = `\n[${dateStr}] - ${newFeedbackText}\n`;

            // Insert text at index 1 (right after the very beginning of the document body)
            await docsClient.documents.batchUpdate({
                documentId: feedbackDocId,
                requestBody: {
                    requests: [
                        {
                            insertText: {
                                location: { index: 1 },
                                text: formattedFeedback
                            }
                        }
                    ]
                }
            });
            console.log("Feedback synchronized with Google Drive.");
            return true;

        } catch (error) {
            console.error("Error patching document in Google Drive:", error.message);
            throw new Error("Failed to append feedback to Google Doc.");
        }
    }
}

module.exports = new MedicalController();
