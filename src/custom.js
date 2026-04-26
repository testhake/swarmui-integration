// Core OpenAI handling
import { getCustomModel, getCustomParameters } from '../index.js';
import { sendOpenAIRequest, oai_settings, getChatCompletionModel, chat_completion_sources } from '../../../../openai.js';

// Data extraction / cleanup helpers (same ones generateRaw uses)
import { main_api, amount_gen, max_context } from '../../../../../script.js';
import { cleanUpMessage, extractMessageFromData, extractJsonFromData, getGenerateUrl, getRequestHeaders, createRawPrompt } from '../../../../../script.js';

// Kobold/Novel/Textgen wrappers
import { kai_settings, koboldai_settings, koboldai_setting_names, getKoboldGenerationData } from '../../../../kai-settings.js';
import { novelai_settings, novelai_setting_names, nai_settings, getNovelGenerationData } from '../../../../nai-settings.js';
import { generateHorde } from '../../../../horde.js';
import { getTextGenGenerationData } from '../../../../textgen-settings.js';

// ============================================================
// SSE Streaming helpers
// ============================================================

/**
 * Extract the text delta from a single SSE data line across common provider formats.
 * Returns null if the line carries no text content (e.g. [DONE], role-only chunks).
 *
 * Supported formats:
 *   - OpenAI / Mistral / DeepSeek / xAI / Custom  →  choices[0].delta.content
 *   - Anthropic (Claude)                           →  delta.text  (type: content_block_delta)
 *   - Cohere                                       →  text  (event_type: text-generation)
 *   - Google Gemini / MakerSuite                   →  candidates[0].content.parts[0].text
 */
function extractDeltaFromSSELine(line) {
    if (!line.startsWith('data:')) return null;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') return null;
    let obj;
    try { obj = JSON.parse(raw); } catch { return null; }

    if (obj.choices?.[0]?.delta != null) {
        const delta = obj.choices[0].delta;
        if (delta.reasoning_content != null) return { text: delta.reasoning_content, thinking: true };
        if (delta.content != null) return { text: delta.content, thinking: false };
        return null;
    }
    if (obj.type === 'content_block_delta') {
        if (obj.delta?.type === 'thinking_delta' && obj.delta?.thinking != null)
            return { text: obj.delta.thinking, thinking: true };
        if (obj.delta?.text != null)
            return { text: obj.delta.text, thinking: false };
        return null;
    }
    if (obj.event_type === 'text-generation' && obj.text != null)
        return { text: obj.text, thinking: false };
    if (obj.candidates?.[0]?.content?.parts?.[0]?.text != null)
        return { text: obj.candidates[0].content.parts[0].text, thinking: false };
    if (obj.token != null)
        return { text: obj.token, thinking: false };
    return null;
}

/**
 * Parse a streaming HTTP response (SSE) from the ST backend proxy.
 * Calls `onToken(text)` for every text chunk received.
 * Returns the full accumulated text when the stream ends.
 *
 * The ST backend itself is the one that proxies to the real LLM, so we always
 * receive the same SSE format regardless of which provider is selected.
 *
 * @param {Response} response - Fetch Response with a readable body stream
 * @param {function(string): void} onToken - Called with each text chunk
 * @param {AbortSignal} [signal] - Optional abort signal
 * @returns {Promise<string>} Full accumulated response text
 */
async function readStreamingResponse(response, onToken, signal) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let accumulatedThinking = '';
    let accumulatedText = '';
    let lineBuffer = '';
    let wasThinking = false;

    const processChunk = (delta) => {
        if (!delta) return;
        const { text, thinking } = delta;
        if (!text) return;

        if (thinking) {
            accumulatedThinking += text;
            wasThinking = true;
            try { onToken({ text, thinking: true }); } catch { }
        } else {
            accumulatedText += text;
            try { onToken({ text, thinking: false }); } catch { }
        }
    };

    try {
        while (true) {
            if (signal?.aborted) { reader.cancel(); throw new DOMException('Aborted', 'AbortError'); }
            const { value, done } = await reader.read();
            if (done) break;

            lineBuffer += decoder.decode(value, { stream: true });
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() ?? '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                processChunk(extractDeltaFromSSELine(trimmed));
            }
        }
        if (lineBuffer.trim()) {
            processChunk(extractDeltaFromSSELine(lineBuffer.trim()));
        }
    } finally {
        try { reader.cancel(); } catch { }
    }

    // Combine: wrap thinking in <think> tags if present, then the real text
    const full = accumulatedThinking
        ? `<think>${accumulatedThinking}</think>${accumulatedText}`
        : accumulatedText;
    return full;
}

// ============================================================
// Core request function (streaming-aware)
// ============================================================

/**
 * Send a request to the ST backend's chat-completions proxy.
 * When `onToken` is provided the request is made with `stream: true` and
 * each text chunk is forwarded to the callback; the full text is returned
 * when the stream ends.  Without `onToken` the old non-streaming path is used.
 *
 * @param {object[]} messages - Chat messages array
 * @param {string[]} stopStrings - Stop strings for the LLM
 * @param {object|null} jsonSchema - Optional JSON schema
 * @param {AbortSignal} signal - Abort signal
 * @param {function(string): void|null} onToken - Token streaming callback (null = no streaming)
 * @returns {Promise<object|string>} Full response data object (non-streaming) or text string (streaming)
 */
async function sendCustomOpenAIRequest(messages, stopStrings, jsonSchema, signal, onToken = null) {
    let model = getChatCompletionModel();
    if (getCustomModel() !== '') {
        model = getCustomModel();
    }

    const useStreaming = typeof onToken === 'function';

    const generateData = {
        model,
        messages,
        temperature: Number(oai_settings.temp_openai),
        top_p: Number(oai_settings.top_p_openai),
        frequency_penalty: Number(oai_settings.freq_pen_openai),
        presence_penalty: Number(oai_settings.pres_pen_openai),
        max_tokens: oai_settings.openai_max_tokens,
        stream: useStreaming,
        stop: stopStrings,
        chat_completion_source: oai_settings.chat_completion_source,
    };

    // Provider-specific tweaks
    if (oai_settings.chat_completion_source === chat_completion_sources.MISTRALAI) {
        generateData.safe_prompt = false;
    }
    if (oai_settings.chat_completion_source === chat_completion_sources.CUSTOM) {
        generateData.custom_url = oai_settings.custom_url;
        generateData.custom_include_body = getCustomParameters();
        generateData.custom_exclude_body = oai_settings.custom_exclude_body;
        generateData.custom_include_headers = oai_settings.custom_include_headers;
    }
    if (jsonSchema) {
        generateData.json_schema = jsonSchema;
    }

    // Proxy credentials
    const proxiedSources = [
        chat_completion_sources.CLAUDE,
        chat_completion_sources.OPENAI,
        chat_completion_sources.MISTRALAI,
        chat_completion_sources.MAKERSUITE,
        chat_completion_sources.VERTEXAI,
        chat_completion_sources.DEEPSEEK,
        chat_completion_sources.XAI,
    ];
    if (oai_settings.reverse_proxy && proxiedSources.includes(oai_settings.chat_completion_source)) {
        generateData.reverse_proxy = oai_settings.reverse_proxy;
        generateData.proxy_password = oai_settings.proxy_password;
    }

    console.log('[swarmUI-integration-custom] Request data (stream=%s):', useStreaming, generateData);

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        body: JSON.stringify(generateData),
        headers: getRequestHeaders(),
        signal,
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`Got response status ${response.status}: ${errorText}`);
    }

    // ---- Streaming path ----
    if (useStreaming) {
        const text = await readStreamingResponse(response, onToken, signal);
        return text;
    }

    // ---- Non-streaming path ----
    const data = await response.json();
    if (data.error) {
        throw new Error(data.error.message || response.statusText || 'Unknown error');
    }
    return data;
}

// ============================================================
// generateRawWithStops
// ============================================================

/**
 * Generates a message using the provided prompt with support for stop strings
 * and optional token-level streaming.
 *
 * @typedef {object} GenerateRawWithStopsParams
 * @prop {string | object[]} [prompt]          Prompt string or chat-style messages array
 * @prop {string}            [api]             API to use (defaults to main_api)
 * @prop {boolean}           [instructOverride] Override instruct mode
 * @prop {boolean}           [quietToLoud]     Generate in system vs character mode
 * @prop {string}            [systemPrompt]    System prompt
 * @prop {number}            [responseLength]  Max response length
 * @prop {boolean}           [trimNames]       Trim name prefixes from response
 * @prop {string}            [prefill]         Optional prefill text
 * @prop {object}            [jsonSchema]      JSON schema for structured output
 * @prop {string[]}          [stopStrings]     Strings that stop generation
 * @prop {AbortSignal}       [abortSignal]     External abort signal
 * @prop {function(string):void} [onToken]     Called with each streamed token (OpenAI/custom only)
 *
 * @param {GenerateRawWithStopsParams} params
 * @returns {Promise<string>} Generated text
 */
export async function generateRawWithStops({
    prompt = '',
    api = null,
    instructOverride = false,
    quietToLoud = false,
    systemPrompt = '',
    responseLength = null,
    trimNames = true,
    prefill = '',
    jsonSchema = null,
    stopStrings = [],
    abortSignal = null,
    onToken = null,
} = {}) {
    if (arguments.length > 0 && typeof arguments[0] !== 'object') {
        console.trace('[swarmUI-integration-custom] generateRawWithStops called with positional arguments. Please use an object instead.');
        [prompt, api, instructOverride, quietToLoud, systemPrompt, responseLength, trimNames, prefill, jsonSchema, stopStrings] = arguments;
    }

    if (!api) api = main_api;

    // We need our own AbortController so we can cancel internally; chain with external signal.
    const internalController = new AbortController();
    if (abortSignal) {
        if (abortSignal.aborted) { internalController.abort(); }
        else { abortSignal.addEventListener('abort', () => internalController.abort(), { once: true }); }
    }
    const signal = internalController.signal;

    const responseLengthCustomized = typeof responseLength === 'number' && responseLength > 0;
    let originalOpenAIMaxTokens = null;
    let originalAmountGen = null;

    prompt = createRawPrompt(prompt, api, instructOverride, quietToLoud, systemPrompt, prefill);

    try {
        if (responseLengthCustomized) {
            if (api === 'openai') {
                originalOpenAIMaxTokens = oai_settings.openai_max_tokens;
                oai_settings.openai_max_tokens = responseLength;
            } else {
                originalAmountGen = amount_gen;
                amount_gen = responseLength;
            }
        }

        // ---- Non-OpenAI paths (no streaming support yet) ----
        if (api !== 'openai') {
            let generateData = {};

            switch (api) {
                case 'kobold':
                case 'koboldhorde':
                    if (kai_settings.preset_settings === 'gui') {
                        generateData = {
                            prompt,
                            gui_settings: true,
                            max_length: amount_gen,
                            max_context_length: max_context,
                            api_server: kai_settings.api_server,
                        };
                        if (stopStrings.length > 0) generateData.stop_sequence = stopStrings;
                    } else {
                        const isHorde = api === 'koboldhorde';
                        const koboldSettings = koboldai_settings[koboldai_setting_names[kai_settings.preset_settings]];
                        generateData = getKoboldGenerationData(prompt.toString(), koboldSettings, amount_gen, max_context, isHorde, 'quiet');
                        if (stopStrings.length > 0) generateData.stop_sequence = stopStrings;
                    }
                    break;

                case 'novel': {
                    const novelSettings = novelai_settings[novelai_setting_names[nai_settings.preset_settings_novel]];
                    generateData = getNovelGenerationData(prompt, novelSettings, amount_gen, false, false, null, 'quiet');
                    if (stopStrings.length > 0) {
                        generateData.parameters = generateData.parameters || {};
                        generateData.parameters.stop = stopStrings;
                    }
                    break;
                }

                case 'textgenerationwebui':
                    generateData = await getTextGenGenerationData(prompt, amount_gen, false, false, null, 'quiet');
                    if (stopStrings.length > 0) generateData.stopping_strings = stopStrings;
                    break;
            }

            let data = {};
            if (api === 'koboldhorde') {
                data = await generateHorde(prompt.toString(), generateData, signal, false);
            } else {
                const generateUrl = getGenerateUrl(api);
                const response = await fetch(generateUrl, {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    cache: 'no-cache',
                    body: JSON.stringify(generateData),
                    signal,
                });
                if (!response.ok) throw await response.json();
                data = await response.json();
            }

            if (data.error) throw new Error(data.response);

            return _extractAndClean(data, api, jsonSchema, stopStrings, trimNames);
        }

        // ---- OpenAI path (streaming or non-streaming) ----
        const hasStopStrings = stopStrings.length > 0;
        const wantsStreaming = typeof onToken === 'function';

        if (hasStopStrings || wantsStreaming) {
            // Use our custom request that supports both streaming and stop strings
            const result = await sendCustomOpenAIRequest(
                prompt,         // already shaped as messages array by createRawPrompt
                stopStrings,
                jsonSchema,
                signal,
                wantsStreaming ? onToken : null,
            );

            if (wantsStreaming) {
                // result is already the full accumulated string from the stream
                let message = typeof result === 'string' ? result : '';
                message = _applyStopStrings(message, stopStrings);
                return _cleanMessage(message, trimNames);
            }

            // Non-streaming with stop strings: result is a full data object
            return _extractAndClean(result, api, jsonSchema, stopStrings, trimNames);
        }

        // Plain OpenAI, no stop strings, no streaming: use ST's built-in sendOpenAIRequest
        const data = await sendOpenAIRequest('quiet', prompt, signal, { jsonSchema });
        return _extractAndClean(data, api, jsonSchema, stopStrings, trimNames);

    } finally {
        if (responseLengthCustomized) {
            if (api === 'openai' && originalOpenAIMaxTokens !== null) {
                oai_settings.openai_max_tokens = originalOpenAIMaxTokens;
            } else if (originalAmountGen !== null) {
                amount_gen = originalAmountGen;
            }
        }
    }
}

// ============================================================
// Private helpers
// ============================================================

function _applyStopStrings(text, stopStrings) {
    for (const s of stopStrings) {
        const idx = text.indexOf(s);
        if (idx !== -1) return text.substring(0, idx);
    }
    return text;
}

function _cleanMessage(raw, trimNames) {
    return cleanUpMessage({
        getMessage: raw,
        isImpersonate: false,
        isContinue: false,
        displayIncompleteSentences: true,
        includeUserPromptBias: false,
        trimNames,
        trimWrongNames: trimNames,
    });
}

function _extractAndClean(data, api, jsonSchema, stopStrings, trimNames) {
    if (jsonSchema) {
        return extractJsonFromData(data, { mainApi: api });
    }

    let extracted;
    try {
        extracted = extractMessageFromData(data);
    } catch {
        // Mistral / unusual format fallback
        if (data?.choices?.[0]?.message?.content != null) {
            const c = data.choices[0].message.content;
            if (Array.isArray(c)) {
                extracted = c[0]?.text ?? c[0] ?? '';
                if (typeof extracted !== 'string') extracted = JSON.stringify(extracted);
            } else {
                extracted = String(c);
            }
        }
    }

    if (!extracted) {
        console.error('[swarmUI-integration-custom] Failed to extract message from:', JSON.stringify(data, null, 2));
        throw new Error('No message generated');
    }

    extracted = _applyStopStrings(extracted, stopStrings);
    return _cleanMessage(extracted, trimNames) || extracted;
}

// ============================================================
// Convenience export
// ============================================================

export async function generateImagePromptWithStops(params = {}) {
    const defaultStops = ['\n\n', '###', 'USER:', 'ASSISTANT:', '<|im_end|>', '<|endoftext|>'];
    return generateRawWithStops({
        ...params,
        stopStrings: params.stopStrings || defaultStops,
    });
}