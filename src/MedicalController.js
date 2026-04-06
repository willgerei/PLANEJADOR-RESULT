const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');

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
        this.systemPrompt = `# INSTRUÇÃO GLOBAL DO AGENTE DE COPYWRITING

**SEU PAPEL:**
Você é um Copywriter Sênior atuando no sistema de uma agência. Sua missão é ler os documentos de contexto fornecidos (briefings, planejamentos passados, diretrizes de marca) e gerar roteiros de conteúdo para o Instagram com precisão absoluta, de acordo com o formato solicitado pelo Atendimento.

---

## PASSO 1: ABSORÇÃO DE CONTEXTO (PERSONA DINÂMICA)
Antes de escrever, analise os arquivos do cliente anexados na solicitação e extraia mentalmente:
* A especialidade médica ou nicho.
* O tom de voz exigido (ex: conservador, direto, comercial, acolhedor).
* Regras estritas e palavras proibidas.
O texto final gerado DEVE refletir perfeitamente o tom de voz e as regras desse cliente específico.
* Se houver uma matéria de trend anexada como contexto, use as informações dela como referência de pauta, mas adapte tudo ao contexto médico do cliente e nunca copie trechos literalmente.

---

## PASSO 2: REGRAS DE FORMATAÇÃO DO OUTPUT (CRÍTICO)
* **NUNCA** use colchetes \`[]\`, chaves \`{}\` ou parênteses \`()\` para dar explicações de bastidor na copy final (exceto onde o template pede).
* **NUNCA** crie títulos de metalinguagem (ex: "Foco no problema", "Conflito", "Resolução"). 
* A saída deve ser um texto limpo, pronto para ser copiado pelo cliente ou designer.
* Identifique qual formato foi pedido pelo Atendimento (Carrossel, Reels ou Feed) e use APENAS o template correspondente abaixo. A quantidade de Telas (Carrossel) ou Takes (Reels) é dinâmica: crie quantas forem necessárias para cobrir o assunto com qualidade, sem limites fixos.

---

## PASSO 3: TEMPLATES EXIGIDOS (Siga rigorosamente a estrutura do formato solicitado)

### OPÇÃO A: SE O PEDIDO FOR UM [CARROSSEL]
Todo carrossel deve ter a seguinte jornada lógica, MAS VOCÊ É ESTRITAMENTE PROIBIDO DE ESCREVER O NOME DESSAS ETAPAS NA SAÍDA FINAL:
- **(Conflito):** A dor, queixa ou gancho curto na Tela 1.
- **(Contexto+Conexão):** Empatia e aprofundamento do problema na Tela 2.
- **(Virada):** A causa real e a introdução da solução nas Telas centrais (Tela 3, 4, etc.).
- **(Resolução):** O benefício prático e a transformação na penúltima tela.
- **(CTA):** Chamada para ação alinhada ao tom do cliente na última tela.

CARROSSEL
DIRECIONAMENTO VISUAL: 
[Descreva brevemente a sugestão visual ou estética para as artes do carrossel]

TELA 1: [Escreva aqui apenas o texto final da arte]
TELA 2: [Escreva aqui apenas o texto final da arte]
...
TELA X: [Continue gerando as telas necessárias, respeitando a jornada lógica acima, até a tela final de CTA]

LEGENDA:
[Escreva a legenda completa e persuasiva aqui. Pule linhas para facilitar a leitura.]

Hashtags: #[HashtagDoCliente1] #[HashtagDoCliente2] #[HashtagDoTema]

---

### OPÇÃO B: SE O PEDIDO FOR UM [REELS / VÍDEO]

REELS
DIRECIONAMENTO VISUAL: 
[Descreva brevemente a sugestão de gravação. Ex: "Vídeo gravado no consultório, com a Dra. falando diretamente para a câmera, tom acolhedor."]

COPY CAPA: [Escreva a frase de gancho que ficará escrita no início do vídeo]

ROTEIRO:
TAKE 01: [Escreva a fala ou texto que vai na tela do primeiro corte]
TAKE 02: [Escreva a fala ou texto que vai na tela do segundo corte]
...
TAKE X: [Continue gerando os takes necessários até a conclusão do vídeo]

LEGENDA:
[Escreva a legenda completa e persuasiva aqui, aprofundando o tema do vídeo. Pule linhas para facilitar a leitura.]

Hashtags: #[HashtagDoCliente1] #[HashtagDoCliente2] #[HashtagDoTema]

---

### OPÇÃO C: SE O PEDIDO FOR UM [POST FEED / IMAGEM ÚNICA]

POST FEED
DIRECIONAMENTO VISUAL:
[Descreva o que deve estar na arte estática ou foto. Ex: "Foto profissional da médica sorrindo no consultório" ou "Arte clean com a frase X".]

COPY DA ARTE:
[Escreva a frase curta ou título que vai escrito em cima da imagem. Se for apenas uma foto sem texto, indique 'Apenas imagem'.]

LEGENDA:
[Escreva a legenda completa aqui. Como é um post estático, a legenda deve conter toda a jornada narrativa: Gancho forte na primeira linha, desenvolvimento empático e Chamada para Ação no final. Pule linhas para facilitar a leitura.]

Hashtags: #[HashtagDoCliente1] #[HashtagDoCliente2] #[HashtagDoTema]`;

        this.model = this.genAI.getGenerativeModel({
            model: "gemini-3.1-flash-lite-preview",
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

    _normalizeWhitespace(text) {
        return String(text || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _extractTrendArticleText($) {
        const selectors = [
            'article',
            'main',
            '[role="main"]',
            '.article-body',
            '.entry-content',
            '.post-content',
            '.post__content',
            '.content'
        ];

        const collectParagraphs = (root) => {
            const paragraphs = [];
            root.find('p').each((_, el) => {
                const text = this._normalizeWhitespace($(el).text());
                if (text.length >= 60) paragraphs.push(text);
            });
            return paragraphs;
        };

        for (const selector of selectors) {
            const root = $(selector).first();
            if (!root.length) continue;
            const paragraphs = collectParagraphs(root);
            if (paragraphs.length >= 3) {
                return paragraphs.slice(0, 18).join('\n');
            }
        }

        const fallbackParagraphs = collectParagraphs($.root());
        return fallbackParagraphs.slice(0, 18).join('\n');
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

    async fetchTrendArticleContext(trendUrl, trendTitle = '') {
        if (!trendUrl) return '';

        let normalizedUrl = '';
        try {
            const parsed = new URL(String(trendUrl).trim());
            if (!/^https?:$/.test(parsed.protocol)) {
                throw new Error('Unsupported protocol.');
            }
            normalizedUrl = parsed.href;
        } catch (error) {
            throw new Error(`Invalid trend URL: ${error.message}`);
        }

        try {
            const response = await axios.get(normalizedUrl, {
                timeout: 12000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; ResultPubliTrendFetcher/1.0)'
                }
            });

            const $ = cheerio.load(response.data);
            $('script, style, noscript, iframe, svg').remove();

            const pageTitle = this._normalizeWhitespace(
                $('meta[property="og:title"]').attr('content')
                || $('title').first().text()
                || $('h1').first().text()
                || trendTitle
            );
            const description = this._normalizeWhitespace(
                $('meta[name="description"]').attr('content')
                || $('meta[property="og:description"]').attr('content')
            );
            const articleText = this._extractTrendArticleText($);

            const sections = [
                '--- TREND REFERENCE ARTICLE ---',
                `Trend selecionada: ${this._normalizeWhitespace(trendTitle || pageTitle || 'Sem titulo')}`,
                `URL de origem: ${normalizedUrl}`
            ];

            if (pageTitle) sections.push(`Titulo da pagina: ${pageTitle}`);
            if (description) sections.push(`Resumo da pagina: ${description}`);
            if (articleText) sections.push(`Conteudo extraido da materia:\n${articleText.slice(0, 12000)}`);
            sections.push('Use esta materia apenas como contexto de pauta e adapte o conteudo ao posicionamento e as regras do medico.');

            return `\n${sections.join('\n\n')}\n`;
        } catch (error) {
            throw new Error(`Failed to fetch trend article context: ${error.message}`);
        }
    }

    /**
     * Synthesizes the final medical copy combining context and user prompt via Gemini File Search/RAG.
     */
    async generateMedicalCopy(userPrompt, medicalContext, trendContext = '') {
        console.log(`Preparing context for Gemini File Search/RAG...`);

        const tempFilePath = path.join(os.tmpdir(), `context_${Date.now()}.txt`);

        try {
            // Write context to a temporary file to be uploaded to Gemini File API (File Search Tool equivalent)
            const combinedContext = [medicalContext, trendContext].filter(Boolean).join('\n');
            fs.writeFileSync(tempFilePath, combinedContext);

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
    // Expects 'headerText' already formatted (includes timestamp and user info)
    async appendFeedback(feedbackDocId, headerText, accessToken) {
        if (!feedbackDocId) throw new Error("Missing Feedback Document ID.");

        try {
            const drive = this.getAuthorizedDrive(accessToken);

            // 1) Read existing file content (feedback.md is stored as plain text)
            let existing = '';
            try {
                const res = await drive.files.get({
                    fileId: feedbackDocId,
                    alt: 'media'
                }, { responseType: 'text' });
                existing = res.data || '';
            } catch (readErr) {
                console.warn(`Could not read existing feedback file ${feedbackDocId}:`, readErr.message);
                existing = '';
            }

            // 2) Prepend headerText at the top (chronological reverse). Ensure spacing.
            const combined = headerText + (existing ? '\n' + existing : '');

            // 3) Upload updated content replacing the existing file
            const media = {
                mimeType: 'text/markdown',
                body: Readable.from(Buffer.from(combined, 'utf-8'))
            };

            await drive.files.update({
                fileId: feedbackDocId,
                media,
                requestBody: { mimeType: 'text/markdown' }
            });

            console.log('Feedback file updated on Drive:', feedbackDocId);
            return true;

        } catch (error) {
            console.error('Error updating feedback on Google Drive:', error.message);
            throw new Error('Failed to append feedback to Drive file: ' + error.message);
        }
    }
}

module.exports = new MedicalController();
