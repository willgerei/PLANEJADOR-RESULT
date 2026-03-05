# Planejador Result - Sistema Agentivo de Gestão Médica

Um sistema inteligente de gestão médica desenvolvido em **Node.js** e **Express**, focado na organização e automação de documentos médicos através da integração com **Google Drive API** e **IA Gemini**.

## 🚀 Funcionalidades

- **Integração com Google Drive:** Upload e organização automatizada de documentos.
- **Inteligência Artificial (Gemini):** Processamento e análise de conteúdo médico.
- **Gestão de Sessões:** Autenticação segura com Google OAuth2.
- **Banco de Dados Local:** Armazenamento persistente com SQLite3.
- **Interface Moderna:** Desenvolvida com EJS e CSS personalizado.

## 🛠️ Tecnologias Utilizadas

- [Node.js](https://nodejs.org/)
- [Express](https://expressjs.com/)
- [Google Generative AI (Gemini)](https://ai.google.dev/)
- [Google APIs (Drive & Auth)](https://developers.google.com/drive)
- [SQLite3](https://www.sqlite.org/)
- [EJS](https://ejs.co/)

## 📋 Pré-requisitos

- Node.js instalado (v16 ou superior)
- Uma conta Google Cloud com faturamento ativado (para Gemini e Google Drive)
- Credenciais OAuth 2.0 configuradas no Google Cloud Console

## 🔧 Como Rodar Localmente

1. **Clone o repositório:**
   ```bash
   git clone https://github.com/willgerei/PLANEJADOR-RESULT.git
   cd PLANEJADOR-RESULT
   ```

2. **Instale as dependências:**
   ```bash
   npm install
   ```

3. **Configure as Variáveis de Ambiente:**
   Crie um arquivo `.env` na raiz do projeto e adicione as seguintes chaves:
   ```env
   PORT=3000
   SESSION_SECRET=sua_chave_secreta_aqui
   GOOGLE_CLIENT_ID=seu_client_id_do_google
   GOOGLE_CLIENT_SECRET=seu_client_secret_do_google
   GEMINI_API_KEY=sua_gemini_api_key
   GOOGLE_DRIVE_PARENT_ID=id_da_pasta_no_google_drive
   ```

4. **Inicie o servidor:**
   ```bash
   npm start
   ```
   O sistema estará disponível em `http://localhost:3000`.

## 🔐 Segurança

Este repositório está configurado para **não** subir arquivos sensíveis. Certifique-se de que o seu arquivo `.gitignore` contenha:
- `node_modules/`
- `.env`
- `database/`
- `credentials.json`
- `token.json`

---
Desenvolvido por [willgerei](https://github.com/willgerei).
