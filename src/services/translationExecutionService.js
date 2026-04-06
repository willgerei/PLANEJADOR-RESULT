const axios = require('axios');

const TRANSLATE_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
const DEFAULT_TIMEOUT_MS = Number(process.env.GOOGLE_TRANSLATE_TIMEOUT_MS || 8000);

function decodeHtmlEntities(text) {
    return String(text)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function buildFallbackResult(originalTexts, reason, errorMessage = '') {
    return {
        translatedTexts: [...originalTexts],
        stats: {
            requested: originalTexts.length,
            translated: 0,
            fallback: originalTexts.length,
            reason,
            errorMessage
        }
    };
}

async function translateBatch(texts, options = {}) {
    const normalizedTexts = Array.isArray(texts)
        ? texts.map((text) => String(text || '').trim())
        : [];

    if (!normalizedTexts.length) {
        return {
            translatedTexts: [],
            stats: {
                requested: 0,
                translated: 0,
                fallback: 0,
                reason: 'empty_input',
                errorMessage: ''
            }
        };
    }

    const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
    if (!apiKey) {
        return buildFallbackResult(normalizedTexts, 'missing_api_key');
    }

    const target = options.target || 'pt-BR';
    const source = options.source || 'en';

    try {
        const response = await axios.post(
            `${TRANSLATE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`,
            {
                q: normalizedTexts,
                target,
                source,
                format: 'text'
            },
            {
                timeout: Number.isFinite(DEFAULT_TIMEOUT_MS) && DEFAULT_TIMEOUT_MS > 0 ? DEFAULT_TIMEOUT_MS : 8000,
                headers: { 'Content-Type': 'application/json' }
            }
        );

        const translations = response.data?.data?.translations;
        if (!Array.isArray(translations)) {
            return buildFallbackResult(normalizedTexts, 'invalid_response');
        }

        let translated = 0;
        let fallback = 0;
        const translatedTexts = normalizedTexts.map((original, index) => {
            const translatedText = translations[index]?.translatedText;
            if (typeof translatedText === 'string' && translatedText.trim()) {
                translated += 1;
                return decodeHtmlEntities(translatedText.trim());
            }
            fallback += 1;
            return original;
        });

        return {
            translatedTexts,
            stats: {
                requested: normalizedTexts.length,
                translated,
                fallback,
                reason: fallback > 0 ? 'partial_fallback' : 'ok',
                errorMessage: ''
            }
        };
    } catch (error) {
        return buildFallbackResult(normalizedTexts, 'request_failed', error.message);
    }
}

module.exports = {
    translateBatch
};
