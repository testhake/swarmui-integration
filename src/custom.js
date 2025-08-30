import {
    createRawPrompt,
    getKoboldGenerationData,
    getNovelGenerationData,
    getTextGenGenerationData,
    sendOpenAIRequest,
    extractJsonFromData,
    extractMessageFromData,
    cleanUpMessage,
    getGenerateUrl,
    getRequestHeaders, } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';

// generateRawSafe.js
// A drop-in replacement for generateRaw that attempts to:
//  - Enforce a max completion length via per-request fields (max_tokens / max_length)
//  - Support explicit stop sequences
//  - Avoid relying solely on TempResponseLength (which in some setups may be ignored)
//  - Keep the same return behaviour as the original generateRaw (returns generated string or throws)

// Usage in your extension:
// import { generateRawSafe } from './src/generateRawSafe.js';
// const message = await generateRawSafe({ prompt: myPrompt, responseLength: 200, stops: ['<END>', '\n\n'] });

export async function generateRawSafe({
    prompt = '',
    api = null,
    instructOverride = false,
    quietToLoud = false,
    systemPrompt = '',
    responseLength = null, // numeric maximum completion tokens you want
    trimNames = true,
    prefill = '',
    jsonSchema = null,
    stops = null, // array of stop strings or a single string
} = {}) {
    if (arguments.length > 0 && typeof arguments[0] !== 'object') {
        console.trace('generateRawSafe called with positional arguments. Please use an object instead.');
        [prompt, api, instructOverride, quietToLoud, systemPrompt, responseLength, trimNames, prefill, jsonSchema, stops] = arguments;
    }

    if (!api) api = main_api; // reuse global main_api as the original function does

    const abortController = new AbortController();

    // Build the final prompt exactly like the original implementation does
    prompt = createRawPrompt(prompt, api, instructOverride, quietToLoud, systemPrompt, prefill);

    try {
        /**
         * We intentionally avoid exclusively relying on TempResponseLength.save/restore because
         * some backends (or gateway layers) may ignore that global shimming. Instead, we try to
         * append token/stop configuration directly into the payload that will be sent to the
         * model service (for example openai-compatible fields: max_tokens, stop).
         */

        let generateData = {};

        switch (api) {
            case 'kobold':
            case 'koboldhorde':
                // preserve existing behaviour but prefer to set max_length if provided
                if (kai_settings.preset_settings === 'gui') {
                    generateData = { prompt: prompt, gui_settings: true, max_length: responseLength || amount_gen, max_context_length: max_context, api_server: kai_settings.api_server };
                } else {
                    const isHorde = api === 'koboldhorde';
                    const koboldSettings = koboldai_settings[koboldai_setting_names[kai_settings.preset_settings]];
                    // try to pass responseLength as max_length (most kobold forks use numeric max_length)
                    generateData = getKoboldGenerationData(prompt.toString(), koboldSettings, responseLength || amount_gen, max_context, isHorde, 'quiet');
                }
                break;

            case 'novel': {
                const novelSettings = novelai_settings[novelai_setting_names[nai_settings.preset_settings_novel]];
                // novelai uses max_length style param
                generateData = getNovelGenerationData(prompt, novelSettings, responseLength || amount_gen, false, false, null, 'quiet');
                break;
            }

            case 'textgenerationwebui':
                generateData = await getTextGenGenerationData(prompt, responseLength || amount_gen, false, false, null, 'quiet');
                break;

            case 'openai': {
                // For openai/chat-like backends, the original code passes the prompt object directly.
                // Here we augment that object with explicit max_tokens and stop to force the completion limit.
                generateData = prompt; // should be a chat message object

                // If the caller asked for responseLength, prefer that as max_tokens
                if (typeof responseLength === 'number' && Number.isFinite(responseLength) && responseLength > 0) {
                    // Different gateways accept different main-field names; OpenAI accepts max_tokens
                    // Put it directly on the payload which sendOpenAIRequest will send through.
                    generateData.max_tokens = responseLength;
                }

                // Accept both array or single string stop sequences
                if (stops) {
                    generateData.stop = Array.isArray(stops) ? stops : [stops];
                }

                // Avoid depending solely on TempResponseLength; still keep eventHook compatibility
                var eventHook = TempResponseLength?.setupEventHook ? TempResponseLength.setupEventHook(api) : () => { };
                if (typeof responseLength === 'number' && TempResponseLength?.save) {
                    // This tries to preserve the original behavior for other parts of the frontend
                    TempResponseLength.save(api, responseLength);
                }

                try {
                    const data = await sendOpenAIRequest('quiet', generateData, abortController.signal, { jsonSchema });

                    // The rest of this block mirrors original extract/cleanup logic
                    if (data.error) {
                        throw new Error(data.response || JSON.stringify(data));
                    }

                    if (jsonSchema) {
                        return extractJsonFromData(data, { mainApi: api });
                    }

                    const message = cleanUpMessage({
                        getMessage: extractMessageFromData(data),
                        isImpersonate: false,
                        isContinue: false,
                        displayIncompleteSentences: true,
                        includeUserPromptBias: false,
                        trimNames: trimNames,
                        trimWrongNames: trimNames,
                    });

                    if (!message) {
                        throw new Error('No message generated');
                    }

                    return message;
                } finally {
                    // restore the TempResponseLength state if we changed it
                    if (typeof responseLength === 'number' && TempResponseLength?.isCustomized && TempResponseLength.isCustomized()) {
                        TempResponseLength.restore(api);
                        TempResponseLength.removeEventHook(api, eventHook);
                    }
                }
            }

            default: {
                // Generic HTTP generation path for other APIs
                const generateUrl = getGenerateUrl(api);

                // If a responseLength is provided, we try to inject it into the payload in a best-effort way
                // Many backends accept a field named max_length or max_tokens. We'll try both patterns.
                generateData = { prompt: prompt };
                if (typeof responseLength === 'number') {
                    generateData.max_length = responseLength;
                    generateData.max_tokens = responseLength;
                }
                if (stops) {
                    generateData.stop = Array.isArray(stops) ? stops : [stops];
                }

                const response = await fetch(generateUrl, {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    cache: 'no-cache',
                    body: JSON.stringify(generateData),
                    signal: abortController.signal,
                });

                if (!response.ok) {
                    // attempt to read the body for a helpful error
                    let body = '';
                    try { body = await response.text(); } catch (e) { /* ignore */ }
                    throw new Error(body || `Generation API returned ${response.status}`);
                }

                const data = await response.json();

                if (data.error) {
                    throw new Error(data.response || JSON.stringify(data));
                }

                if (jsonSchema) {
                    return extractJsonFromData(data, { mainApi: api });
                }

                const message = cleanUpMessage({
                    getMessage: extractMessageFromData(data),
                    isImpersonate: false,
                    isContinue: false,
                    displayIncompleteSentences: true,
                    includeUserPromptBias: false,
                    trimNames: trimNames,
                    trimWrongNames: trimNames,
                });

                if (!message) {
                    throw new Error('No message generated');
                }

                return message;
            }
        }
    } finally {
        // no-op; nothing special to clean up here in this wrapper
    }
}
