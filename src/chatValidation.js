function validateUserChatMessage(userMessage, mode = 'refinement') {
    const text = String(userMessage || '').trim().toLowerCase();

    const injectionPatterns = [
        'ignore as instruções',
        'ignore todas as instruções',
        'esqueça as instruções',
        'esqueça todas as instruções',
        'desconsidere as instruções',
        'ignore previous instructions',
        'forget previous instructions',
        'system prompt',
        'developer message',
        'aja como',
        'você agora é',
        'não siga as regras'
    ];

    const unrelatedPatterns = [
        'receita de bolo',
        'receita',
        'bolo',
        'comida',
        'culinária',
        'poema',
        'piada',
        'história infantil'
    ];

    const hasInjection = injectionPatterns.some((pattern) => text.includes(pattern));
    const isClearlyUnrelated = unrelatedPatterns.some((pattern) => text.includes(pattern));

    if (hasInjection) {
        return {
            ok: false,
            code: 'prompt_injection',
            message: 'Não consigo atender esse pedido porque ele tenta substituir as instruções da ferramenta. Envie um ajuste relacionado ao conteúdo atual.'
        };
    }

    if (isClearlyUnrelated) {
        return {
            ok: false,
            code: 'out_of_scope',
            message: 'Esse pedido foge do escopo da ferramenta. Este chat é destinado a criar ou ajustar conteúdos médicos e estratégicos para redes sociais.'
        };
    }

    return { ok: true };
}

module.exports = {
    validateUserChatMessage
};
