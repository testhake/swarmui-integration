import { generateRaw } from '../../../script.js';


// Add this custom generateRaw method to your script
async function customGenerateRaw({ prompt = '', systemPrompt = '', responseLength = 9000, prefill = '' } = {}) {
    const context = getContext();

    // Get the current API settings
    const api = context.main_api;

    if (api !== 'openai') {
        throw new Error('Custom generateRaw only supports OpenAI-compatible APIs');
    }

    // Prepare the messages array
    const messages = [];

    // Add system prompt if provided
    if (systemPrompt) {
        messages.push({
            role: 'system',
            content: systemPrompt
        });
    }

    // Handle prompt - can be string or array of messages
    if (Array.isArray(prompt)) {
        messages.push(...prompt);
    } else if (typeof prompt === 'string' && prompt.trim()) {
        messages.push({
            role: 'user',
            content: prompt
        });
    }

    // Prepare the request body with stopping sequences
    const requestBody = {
        model: context.openai_setting_names[context.oai_settings.openai_model] || 'gpt-3.5-turbo',
        messages: messages,
        max_tokens: responseLength,
        temperature: context.oai_settings.temp_openai || 0.7,
        top_p: context.oai_settings.top_p_openai || 1,
        frequency_penalty: context.oai_settings.freq_pen_openai || 0,
        presence_penalty: context.oai_settings.pres_pen_openai || 0,
        // Add stopping sequences to prevent runaway generation
        stop: [
            "\n\n\n", // Multiple newlines
            "###", // Common delimiter
            "---", // Another delimiter
            "[END]", // Explicit end marker
            "<|endoftext|>", // Common AI end token
            "\n\nUser:", // Conversation turn
            "\n\nHuman:", // Conversation turn
            "\n\nAssistant:", // Conversation turn
        ]
    };

    // Add prefill if provided (for Claude-style models)
    if (prefill) {
        messages.push({
            role: 'assistant',
            content: prefill
        });
    }

    try {
        // Get the API endpoint
        const apiUrl = context.api_server_openai + '/v1/chat/completions';

        // Make the request
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${context.oai_settings.api_key_openai}`,
                ...getRequestHeaders()
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`API request failed: ${response.status} - ${errorData.error?.message || response.statusText}`);
        }

        const data = await response.json();

        // Extract the generated content
        if (!data.choices || data.choices.length === 0) {
            throw new Error('No choices returned from API');
        }

        const choice = data.choices[0];
        let content = choice.message?.content || '';

        // If we have a prefill, remove it from the beginning of the response
        if (prefill && content.startsWith(prefill)) {
            content = content.substring(prefill.length);
        }

        // Clean up the response
        content = content.trim();

        // Remove any stop sequences that might have been included
        const stopSequences = requestBody.stop;
        for (const stopSeq of stopSequences) {
            if (content.endsWith(stopSeq)) {
                content = content.substring(0, content.length - stopSeq.length).trim();
            }
        }

        if (!content) {
            throw new Error('No content generated');
        }

        console.log('Custom generateRaw response:', {
            finish_reason: choice.finish_reason,
            content_length: content.length,
            usage: data.usage
        });

        return content;

    } catch (error) {
        console.error('Custom generateRaw failed:', error);
        throw error;
    }
}