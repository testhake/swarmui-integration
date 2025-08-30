// Core OpenAI handling
import { sendOpenAIRequest, oai_settings } from '../../../../openai.js';

// Data extraction / cleanup helpers (same ones generateRaw uses)
import { main_api, amount_gen, max_context } from '../../../../../script.js';
import { cleanUpMessage, extractMessageFromData, extractJsonFromData, getGenerateUrl, getRequestHeaders, createRawPrompt } from '../../../../../script.js';

// Kobold/Novel/Textgen wrappers
import { kai_settings, koboldai_settings, koboldai_setting_names, getKoboldGenerationData } from '../../../../kai-settings.js';
import { novelai_settings, novelai_setting_names, nai_settings, getNovelGenerationData } from '../../../../nai-settings.js';
import { generateHorde } from '../../../../horde.js';
import { getTextGenGenerationData } from '../../../../textgen-settings.js';

/**
 * Generates a message using the provided prompt with support for stopping strings.
 * This is a modified version of generateRaw that includes stopping string functionality.
 * @typedef {object} GenerateRawWithStopsParams
 * @prop {string | object[]} [prompt] Prompt to generate a message from. Can be a string or an array of chat-style messages, i.e. [{role: '', content: ''}, ...]
 * @prop {string} [api] API to use. Main API is used if not specified.
 * @prop {boolean} [instructOverride] true to override instruct mode, false to use the default value
 * @prop {boolean} [quietToLoud] true to generate a message in system mode, false to generate a message in character mode
 * @prop {string} [systemPrompt] System prompt to use.
 * @prop {number} [responseLength] Maximum response length. If unset, the global default value is used.
 * @prop {boolean} [trimNames] Whether to allow trimming "{{user}}:" and "{{char}}:" from the response.
 * @prop {string} [prefill] An optional prefill for the prompt.
 * @prop {object} [jsonSchema] JSON schema to use for the structured generation. Usually requires a special instruction.
 * @prop {string[]} [stopStrings] Array of strings that should stop generation when encountered.
 * @param {GenerateRawWithStopsParams} params Parameters for generating a message
 * @returns {Promise<string>} Generated message
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
    stopStrings = []
} = {}) {
    if (arguments.length > 0 && typeof arguments[0] !== 'object') {
        console.trace('generateRawWithStops called with positional arguments. Please use an object instead.');
        [prompt, api, instructOverride, quietToLoud, systemPrompt, responseLength, trimNames, prefill, jsonSchema, stopStrings] = arguments;
    }

    // Handle the case where api might be an HTMLSelectElement
    if (api && typeof api === 'object' && api.value !== undefined) {
        api = api.value;
    }

    // Access main_api from global scope if not provided
    if (!api) {
        api = window.main_api || globalThis.main_api || 'openai'; // fallback to openai if main_api not found
    }

    const abortController = new AbortController();
    const responseLengthCustomized = typeof responseLength === 'number' && responseLength > 0;

    // Simplified response length handling without TempResponseLength dependency
    let originalResponseLength = null;
    let originalOpenAIMaxTokens = null;

    // construct final prompt from the input. Can either be a string or an array of chat-style messages.
    prompt = window.createRawPrompt ? window.createRawPrompt(prompt, api, instructOverride, quietToLoud, systemPrompt, prefill) : prompt;

    try {
        // Handle custom response length without TempResponseLength class
        if (responseLengthCustomized) {
            const oaiSettings = getOaiSettings();
            if (api === 'openai') {
                originalOpenAIMaxTokens = oaiSettings.openai_max_tokens;
                oaiSettings.openai_max_tokens = responseLength;
            } else {
                originalResponseLength = getCurrentAmountGen();
                if (window.amount_gen !== undefined) window.amount_gen = responseLength;
                else if (globalThis.amount_gen !== undefined) globalThis.amount_gen = responseLength;
            }
        }

        /** @type {object|any[]} */
        let generateData = {};
        const currentAmountGen = getCurrentAmountGen();
        const currentMaxContext = getCurrentMaxContext();

        switch (api) {
            case 'kobold':
            case 'koboldhorde':
                const kaiSettings = getKaiSettings();
                const koboldaiSettings = getKoboldaiSettings();
                const koboldaiSettingNames = getKoboldaiSettingNames();

                if (kaiSettings.preset_settings === 'gui') {
                    generateData = {
                        prompt: prompt,
                        gui_settings: true,
                        max_length: currentAmountGen,
                        max_context_length: currentMaxContext,
                        api_server: kaiSettings.api_server
                    };
                    // Add stop strings for Kobold
                    if (stopStrings.length > 0) {
                        generateData.stop_sequence = stopStrings;
                    }
                } else {
                    const isHorde = api === 'koboldhorde';
                    const koboldSettings = koboldaiSettings[koboldaiSettingNames[kaiSettings.preset_settings]];
                    // Try to use the global function if available, otherwise create basic data
                    if (window.getKoboldGenerationData) {
                        generateData = window.getKoboldGenerationData(prompt.toString(), koboldSettings, currentAmountGen, currentMaxContext, isHorde, 'quiet');
                    } else {
                        generateData = {
                            prompt: prompt.toString(),
                            max_length: currentAmountGen,
                            max_context_length: currentMaxContext,
                            ...koboldSettings
                        };
                    }
                    // Add stop strings for Kobold
                    if (stopStrings.length > 0) {
                        generateData.stop_sequence = stopStrings;
                    }
                }
                break;
            case 'novel': {
                const novelaiSettings = getNovelaiSettings();
                const novelaiSettingNames = getNovelaiSettingNames();
                const naiSettings = getNaiSettings();
                const novelSettings = novelaiSettings[novelaiSettingNames[naiSettings.preset_settings_novel]];

                // Try to use the global function if available, otherwise create basic data
                if (window.getNovelGenerationData) {
                    generateData = window.getNovelGenerationData(prompt, novelSettings, currentAmountGen, false, false, null, 'quiet');
                } else {
                    generateData = {
                        input: prompt,
                        model: novelSettings?.model || 'kayra-v1',
                        parameters: {
                            max_length: currentAmountGen,
                            ...novelSettings?.parameters
                        }
                    };
                }
                // Add stop strings for Novel AI (they use 'stop' parameter)
                if (stopStrings.length > 0) {
                    generateData.parameters = generateData.parameters || {};
                    generateData.parameters.stop = stopStrings;
                }
                break;
            }
            case 'textgenerationwebui':
                // Try to use the global function if available, otherwise create basic data
                if (window.getTextGenGenerationData) {
                    generateData = await window.getTextGenGenerationData(prompt, currentAmountGen, false, false, null, 'quiet');
                } else {
                    generateData = {
                        prompt: prompt,
                        max_length: currentAmountGen,
                        do_sample: true,
                        temperature: 0.7,
                        top_p: 0.9,
                        typical_p: 1,
                        repetition_penalty: 1,
                        encoder_repetition_penalty: 1,
                        top_k: 0,
                        min_length: 0,
                        no_repeat_ngram_size: 0,
                        num_beams: 1,
                        penalty_alpha: 0,
                        length_penalty: 1,
                        early_stopping: false,
                        seed: -1,
                        add_bos_token: true,
                        truncation_length: currentMaxContext,
                        ban_eos_token: false,
                        skip_special_tokens: true,
                    };
                }
                // Add stop strings for TextGenWebUI
                if (stopStrings.length > 0) {
                    generateData.stopping_strings = stopStrings;
                }
                break;
            case 'openai': {
                generateData = prompt;  // generateData is just the chat message object
                // Stop strings for OpenAI will be handled in sendOpenAIRequest
                break;
            }
        }

        let data = {};

        if (api === 'koboldhorde') {
            // Try to use the global function if available
            if (window.generateHorde) {
                data = await window.generateHorde(prompt.toString(), generateData, abortController.signal, false);
            } else {
                throw new Error('generateHorde function not available');
            }
        } else if (api === 'openai') {
            // For OpenAI, we need to modify the request to include stop strings
            const requestOptions = { jsonSchema };
            if (stopStrings.length > 0) {
                requestOptions.stop = stopStrings;
            }
            // Try to use the global function if available
            if (window.sendOpenAIRequest) {
                data = await window.sendOpenAIRequest('quiet', generateData, abortController.signal, requestOptions);
            } else {
                throw new Error('sendOpenAIRequest function not available');
            }
        } else {
            const generateUrl = window.getGenerateUrl ? window.getGenerateUrl(api) : '/api/v1/generate';
            const headers = window.getRequestHeaders ? window.getRequestHeaders() : { 'Content-Type': 'application/json' };

            const response = await fetch(generateUrl, {
                method: 'POST',
                headers: headers,
                cache: 'no-cache',
                body: JSON.stringify(generateData),
                signal: abortController.signal,
            });

            if (!response.ok) {
                throw await response.json();
            }

            data = await response.json();
        }

        // should only happen for text completions
        // other frontend paths do not return data if calling the backend fails,
        // they throw things instead
        if (data.error) {
            throw new Error(data.response);
        }

        if (jsonSchema) {
            return window.extractJsonFromData ? window.extractJsonFromData(data, { mainApi: api }) : JSON.stringify(data);
        }

        // format result, exclude user prompt bias
        const getMessage = window.extractMessageFromData ? window.extractMessageFromData(data) : (data.results?.[0]?.text || data.choices?.[0]?.message?.content || data.response || '');

        let message;
        if (window.cleanUpMessage) {
            message = window.cleanUpMessage({
                getMessage: getMessage,
                isImpersonate: false,
                isContinue: false,
                displayIncompleteSentences: true,
                includeUserPromptBias: false,
                trimNames: trimNames,
                trimWrongNames: trimNames,
            });
        } else {
            message = getMessage;
        }

        if (!message) {
            throw new Error('No message generated');
        }

        // Additional client-side stop string processing as fallback
        if (stopStrings.length > 0) {
            for (const stopString of stopStrings) {
                const stopIndex = message.indexOf(stopString);
                if (stopIndex !== -1) {
                    message = message.substring(0, stopIndex);
                    break;
                }
            }
        }

        return message;
    } finally {
        // Restore original response length settings
        if (responseLengthCustomized) {
            const oaiSettings = getOaiSettings();
            if (api === 'openai' && originalOpenAIMaxTokens !== null) {
                oaiSettings.openai_max_tokens = originalOpenAIMaxTokens;
            } else if (originalResponseLength !== null) {
                if (window.amount_gen !== undefined) window.amount_gen = originalResponseLength;
                else if (globalThis.amount_gen !== undefined) globalThis.amount_gen = originalResponseLength;
            }
        }
    }
}

// Alternative function with a more specific name for image prompt generation
export async function generateImagePromptWithStops(params = {}) {
    // Default stop strings commonly used for danbooru tag generation
    const defaultStops = ['\n\n', '###', 'USER:', 'ASSISTANT:', '<|im_end|>', '<|endoftext|>'];

    return generateRawWithStops({
        ...params,
        stopStrings: params.stopStrings || defaultStops
    });
}