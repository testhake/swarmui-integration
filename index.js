import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders, substituteParams } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { oai_settings } from '../../../openai.js';
import { generateQuietPrompt, generateRaw } from '../../../../script.js';
import { debounce_timeout } from '../../../constants.js';
import { saveBase64AsFile, getBase64Async, getCharaFilename } from '../../../utils.js';
import { humanizedDateTime } from '../../../RossAscends-mods.js';
import { generateRawWithStops } from './src/custom.js';

// ============================================================
// Constants & Module State
// ============================================================

const MODULE_NAME = 'swarmui-integration';
const extensionFolderPath = `scripts/extensions/third-party/${MODULE_NAME}`;
const MAX_PROMPT_HISTORY = 50;

let settings = {};
let cachedSessionId = null;
let isShiftPressed = false;

// ============================================================
// Queue System
// ============================================================

const imageGenerationQueue = [];
let queueProcessorRunning = false;

// ============================================================
// Prompt History (persisted in extension_settings)
// ============================================================

function getPromptHistory() {
    return extension_settings[MODULE_NAME]?.prompt_history || [];
}

function savePromptToHistory(entry) {
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
    if (!extension_settings[MODULE_NAME].prompt_history) {
        extension_settings[MODULE_NAME].prompt_history = [];
    }
    extension_settings[MODULE_NAME].prompt_history.unshift(entry);
    if (extension_settings[MODULE_NAME].prompt_history.length > MAX_PROMPT_HISTORY) {
        extension_settings[MODULE_NAME].prompt_history.length = MAX_PROMPT_HISTORY;
    }
    saveSettingsDebounced();
    renderPromptHistory();
}

function clearPromptHistory() {
    if (extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME].prompt_history = [];
    }
    saveSettingsDebounced();
    renderPromptHistory();
}

// ============================================================
// Active Generation Tracker (for live streaming display)
// ============================================================

// Map of generationId -> { status, streamedText, prompt, messageIndex, type, abortController, chatAnchorId }
const activeGenerations = new Map();
let generationIdCounter = 0;

function createGeneration(type, messageIndex, chatAnchorId = null) {
    const id = ++generationIdCounter;
    const gen = {
        id,
        type,           // 'prompt_only' | 'prompt_then_image' | 'image_from_message' 
        messageIndex,
        chatAnchorId,   // stable anchor for chat insertion
        status: 'generating_prompt', // generating_prompt | awaiting_image | done | error | cancelled
        streamedText: '',
        streamedThinking: '',
        finalPrompt: null,
        error: null,
        abortController: new AbortController(),
        createdAt: Date.now(),
    };
    activeGenerations.set(id, gen);
    renderGenerationPanel();
    return gen;
}

function updateGeneration(id, patch) {
    const gen = activeGenerations.get(id);
    if (!gen) return;
    Object.assign(gen, patch);
    renderGenerationPanel();
}

function removeGeneration(id, delayMs = 0) {
    if (delayMs > 0) {
        setTimeout(() => {
            activeGenerations.delete(id);
            renderGenerationPanel();
        }, delayMs);
    } else {
        activeGenerations.delete(id);
        renderGenerationPanel();
    }
}

// ============================================================
// Chat Anchor System
// ============================================================

/**
 * Create a stable anchor ID for a chat message so we can find it
 * even after other messages are inserted before/after it.
 */
function createChatAnchorId(message) {
    const content = (message.mes || '').substring(0, 50);
    const name = message.name || '';
    const date = message.sendDate || message.send_date || Date.now();
    return `${name}_${date}_${content.length}_${content.substring(0, 10)}`;
}

/**
 * Find the current index of a message by its anchor ID.
 * Returns -1 if not found, falls back to originalIndex.
 */
function resolveAnchorIndex(anchorId, originalIndex) {
    if (!anchorId) return originalIndex;
    const context = getContext();
    const chat = context.chat;
    for (let i = 0; i < chat.length; i++) {
        if (createChatAnchorId(chat[i]) === anchorId) return i;
    }
    return originalIndex;
}

// ============================================================
// Settings
// ============================================================

async function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    settings = extension_settings[MODULE_NAME];

    const settingMappings = [
        { id: '#swarm_url', key: 'url', defaultValue: 'http://localhost:7801' },
        { id: '#swarm_session_id', key: 'session_id', defaultValue: '' },
        { id: '#swarm_llm_prompt', key: 'llm_prompt', defaultValue: 'Generate a detailed, descriptive prompt for an image generation AI based on this scene: {all_messages}' },
        { id: '#swarm_custom_model', key: 'custom_model', defaultValue: '' },
        { id: '#swarm_custom_parameters', key: 'custom_parameters', defaultValue: '' },
        { id: '#swarm_message_count', key: 'message_count', defaultValue: 5 },
        { id: '#swarm_prompt_name', key: 'prompt_name', defaultValue: '' },
    ];

    settingMappings.forEach(mapping => {
        $(mapping.id).val(settings[mapping.key] || mapping.defaultValue).trigger('input');
    });

    $('#swarm_append_prompt').prop('checked', !!settings.append_prompt);
    $('#swarm_use_raw').prop('checked', !!settings.use_raw);
    $('#swarm_use_prompt').prop('checked', !!settings.use_prompt);
    $('#swarm_use_custom_generate_raw').prop('checked', !!settings.use_custom_generate_raw);
    $('#swarm_show_prompt_modal').prop('checked', settings.show_prompt_modal !== false);

    cachedSessionId = settings.cached_session_id || null;
    renderPromptHistory();
}

function onInput(event) {
    const id = event.target.id.replace('swarm_', '');

    if (['append_prompt', 'use_raw', 'show_prompt_modal', 'use_custom_generate_raw', 'use_prompt'].includes(id)) {
        settings[id] = $(event.target).prop('checked');
    } else if (id === 'message_count') {
        const value = parseInt($(event.target).val());
        settings[id] = (!isNaN(value) && value >= 0) ? value : 5;
    } else {
        settings[id] = $(event.target).val();
    }

    extension_settings[MODULE_NAME] = settings;
    saveSettingsDebounced();

    if (id === 'url') {
        cachedSessionId = null;
        delete settings.cached_session_id;
    }
}

// ============================================================
// Session Management
// ============================================================

async function createNewSession() {
    const url = `${settings.url}/API/GetNewSession`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'skip_zrok_interstitial': '1', ...getRequestHeaders() },
        body: JSON.stringify({}),
        credentials: 'omit',
    });
    if (!response.ok) throw new Error('Failed to get session ID');
    const data = await response.json();
    return data.session_id;
}

async function getSessionId() {
    if (settings.session_id?.trim()) return settings.session_id.trim();
    if (cachedSessionId) return cachedSessionId;
    const newId = await createNewSession();
    cachedSessionId = newId;
    settings.cached_session_id = newId;
    extension_settings[MODULE_NAME] = settings;
    saveSettingsDebounced();
    return newId;
}

async function validateAndGetSessionId() {
    let sessionId = await getSessionId();
    try {
        await getSavedT2IParams(sessionId);
        return sessionId;
    } catch {
        cachedSessionId = null;
        delete settings.cached_session_id;
        const newId = await createNewSession();
        cachedSessionId = newId;
        settings.cached_session_id = newId;
        extension_settings[MODULE_NAME] = settings;
        saveSettingsDebounced();
        return newId;
    }
}

async function getSavedT2IParams(sessionId) {
    const url = `${settings.url}/API/GetSavedT2IParams?skip_zrok_interstitial=1`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'skip_zrok_interstitial': '1', ...getRequestHeaders() },
        body: JSON.stringify({ session_id: sessionId }),
        credentials: 'omit',
    });
    if (!response.ok) throw new Error('Failed to get saved T2I params');
    const data = await response.json();
    if (data?.error === 'no_saved_params') return {};
    const nested = data?.rawInput;
    if (nested && typeof nested === 'object') {
        if (nested.rawInput && typeof nested.rawInput === 'object') return { ...nested.rawInput };
        return { ...nested };
    }
    return {};
}

// ============================================================
// Message Helpers
// ============================================================

function isMessageInvisible(message) {
    return message.is_system ||
        message.extra?.isTemporary ||
        message.extra?.invisible ||
        ['Generating image…', 'Generating image...', 'Generating prompt…', 'Generating prompt...'].includes(message.mes);
}

function getVisibleMessagesUpTo(chat, count, upToIndex = chat.length) {
    const visibleMessages = [];
    const endIndex = Math.min(upToIndex, chat.length);
    const maxMessages = count === 0 ? Infinity : count;
    for (let i = endIndex - 1; i >= 0 && visibleMessages.length < maxMessages; i--) {
        const message = chat[i];
        if (isMessageInvisible(message)) continue;
        visibleMessages.unshift({ name: message.name, mes: message.mes });
    }
    return visibleMessages;
}

function getMessageAtIndex(chat, index) {
    if (!Array.isArray(chat) || index < 0 || index >= chat.length) return null;
    const message = chat[index];
    return message ? message.mes || '' : null;
}

function getPromptByName(promptName) {
    try {
        const prompts = oai_settings?.prompts;
        if (!prompts || !Array.isArray(prompts)) return null;
        const prompt = prompts.find(p => p && p.name === promptName);
        return prompt ? { identifier: prompt.identifier, content: prompt.content || '', promptData: prompt } : null;
    } catch {
        return null;
    }
}

function formatMessages(messages) {
    return messages.map(msg => `${msg.name}: ${msg.mes}`).join('\n\n');
}

function replaceMessageTags(template, messages) {
    let result = template;
    result = result.replace(/{all_messages}/g, formatMessages(messages));
    result = result.replace(/{description}/g, formatMessages(messages));
    if (settings.use_prompt) {
        result = result.replace(/{prompt}/g, getPromptByName(settings.prompt_name)?.content ?? '');
    }
    result = result.replace(/{previous_messages}/g, messages.length > 1 ? formatMessages(messages.slice(0, -1)) : '');
    result = result.replace(/{previous_messages2}/g, messages.length > 2 ? formatMessages(messages.slice(0, -2)) : '');
    if (messages.length > 0) {
        const last = messages[messages.length - 1];
        result = result.replace(/{message_last}/g, `${last.name}: ${last.mes}`);
    } else {
        result = result.replace(/{message_last}/g, '');
    }
    if (messages.length > 1) {
        const beforeLast = messages[messages.length - 2];
        result = result.replace(/{message_beforelast}/g, `${beforeLast.name}: ${beforeLast.mes}`);
    } else {
        result = result.replace(/{message_beforelast}/g, '');
    }
    return result;
}

function parsePromptTemplate(template, messages) {
    const processedTemplate = replaceMessageTags(template, messages);
    const messageRegex = /\[(system|user|assistant)\](.*?)\[\/\1\]/gs;
    const parsedMessages = [];
    let hasStructuredMessages = false;
    let match;

    while ((match = messageRegex.exec(processedTemplate)) !== null) {
        hasStructuredMessages = true;
        parsedMessages.push({ role: match[1], content: match[2].trim() });
    }

    if (!hasStructuredMessages) {
        const hasMessageTags = /{(all_messages|previous_messages|previous_messages2|message_last|message_beforelast|description)}/.test(processedTemplate);
        if (hasMessageTags) {
            const lines = processedTemplate.split('\n').filter(l => l.trim());
            if (lines.length > 1) {
                parsedMessages.push({ role: 'system', content: lines[0] });
                parsedMessages.push({ role: 'user', content: lines.slice(1).join('\n') });
            } else {
                parsedMessages.push({ role: 'user', content: processedTemplate });
            }
        } else {
            parsedMessages.push({ role: 'system', content: processedTemplate || 'Generate a detailed, descriptive prompt for an image generation AI based on the following conversation.' });
            parsedMessages.push({ role: 'user', content: formatMessages(messages) });
        }
    }
    return parsedMessages;
}

// ============================================================
// Prompt Generation (with streaming support)
// ============================================================

/**
 * Clean a raw LLM response into a usable image prompt.
 */
function cleanImagePrompt(raw) {
    return raw
        .replace(/\*/g, '')
        .replace(/"/g, '')
        .replace(/`/g, '')
        .replace(/_/g, ' ')
        .replace(/buttocks/g, 'ass')
        .replace(/looking at viewer/g, 'eye contact')
        .trim();
}

/**
 * Generate an image prompt from chat context.
 * The `onToken` callback fires with each new streamed chunk so we can show live output.
 */
async function generateImagePromptFromChat(upToMessageIndex = null, abortController = null, onToken = null) {
    const context = getContext();
    const chat = context.chat;

    if (!Array.isArray(chat) || chat.length === 0) throw new Error('No chat messages to base prompt on.');

    let imagePrompt;

    if (settings.use_raw) {
        const messageCount = settings.message_count ?? 5;
        const visibleMessages = upToMessageIndex !== null
            ? getVisibleMessagesUpTo(chat, messageCount, upToMessageIndex + 1)
            : getVisibleMessagesUpTo(chat, messageCount);

        if (visibleMessages.length === 0) throw new Error('No visible messages found.');

        const instructionTemplate = settings.llm_prompt || 'Generate a detailed, descriptive prompt for an image generation AI based on this scene: {all_messages}';
        const parsedMessages = parsePromptTemplate(instructionTemplate, visibleMessages);

        let systemPrompt = '';
        let prompt;

        if (parsedMessages.some(msg => msg.role === 'system')) {
            const firstSystem = parsedMessages.find(msg => msg.role === 'system');
            systemPrompt = firstSystem.content;
            const chatMessages = [];
            let firstSystemFound = false;
            for (const msg of parsedMessages) {
                if (msg.role === 'system' && !firstSystemFound) { firstSystemFound = true; continue; }
                chatMessages.push({ role: msg.role, content: msg.content });
            }
            prompt = chatMessages;
        } else {
            prompt = parsedMessages.map(msg => ({ role: msg.role, content: msg.content }));
        }

        try {
            if (settings.use_custom_generate_raw) {
                imagePrompt = await generateRawWithStops({
                    systemPrompt,
                    prompt,
                    prefill: '',
                    stopStrings: ['<|im_end|>', '</s>', '[/INST]', '<|endoftext|>', '<END>'],
                    abortSignal: abortController?.signal,
                    onToken,
                });
            } else {
                imagePrompt = await generateRawWithStops({
                    systemPrompt,
                    prompt,
                    prefill: '',
                    abortSignal: abortController?.signal,
                    onToken,
                });
            }
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('Generation cancelled by user');
            throw error;
        }
    } else {
        // Non-raw path: use generateQuietPrompt (no streaming available here)
        let lastVisibleMessage = '';
        const searchUpTo = upToMessageIndex !== null ? upToMessageIndex + 1 : chat.length;
        for (let i = searchUpTo - 1; i >= 0; i--) {
            if (isMessageInvisible(chat[i])) continue;
            lastVisibleMessage = chat[i].mes || '';
            break;
        }
        if (!lastVisibleMessage) throw new Error('No visible messages found.');

        const messageCount = settings.message_count ?? 5;
        const visibleMessages = upToMessageIndex !== null
            ? getVisibleMessagesUpTo(chat, messageCount, upToMessageIndex + 1)
            : getVisibleMessagesUpTo(chat, messageCount);

        let llmPrompt = settings.llm_prompt || 'Generate a detailed, descriptive prompt for an image generation AI based on this scene: {all_messages}';
        if (/{(all_messages|previous_messages|previous_messages2|message_last|message_beforelast)}/.test(llmPrompt)) {
            llmPrompt = replaceMessageTags(llmPrompt, visibleMessages);
        } else {
            llmPrompt = substituteParams(llmPrompt).replace('{description}', lastVisibleMessage);
        }
        imagePrompt = await generateQuietPrompt(llmPrompt, false, false, abortController?.signal);
    }

    return cleanImagePrompt(imagePrompt);
}

// ============================================================
// Image Generation
// ============================================================

async function downloadImageAsBase64(imageUrl) {
    const response = await fetch(imageUrl, { method: 'GET', headers: { 'skip_zrok_interstitial': '1' } });
    if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);
    const blob = await response.blob();
    const base64 = await getBase64Async(blob);
    return base64.replace(/^data:image\/[a-z]+;base64,/, '');
}

async function generateAndSaveImage(imagePrompt, savedParams = null, shouldSwapDimensions = false) {
    const context = getContext();
    const sessionId = await validateAndGetSessionId();
    const params = savedParams ?? await getSavedT2IParams(sessionId);
    let rawInput = { ...params };

    if (shouldSwapDimensions && rawInput.width && rawInput.height) {
        [rawInput.width, rawInput.height] = [rawInput.height, rawInput.width];
    }

    let finalPrompt = imagePrompt;
    if (settings.append_prompt && rawInput.prompt) {
        finalPrompt = `${imagePrompt}, ${rawInput.prompt}`;
    }
    rawInput.prompt = finalPrompt;

    const response = await fetch(`${settings.url}/API/GenerateText2Image?skip_zrok_interstitial=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'skip_zrok_interstitial': '1', ...getRequestHeaders() },
        body: JSON.stringify({ session_id: sessionId, images: rawInput.images ?? 1, ...rawInput }),
        credentials: 'omit',
    });

    if (!response.ok) {
        if (response.status === 401 || response.status === 403) { cachedSessionId = null; delete settings.cached_session_id; }
        throw new Error(`HTTP ${response.status}`);
    }

    const data = JSON.parse(await response.text());
    if (!data?.images?.length) throw new Error('No images returned from API');

    let imageUrl = data.images[0];
    if (typeof imageUrl === 'string' && !imageUrl.startsWith('data:') && !imageUrl.startsWith('http')) {
        imageUrl = `${settings.url}/${imageUrl}`;
    }

    const base64Image = await downloadImageAsBase64(imageUrl);
    const characterName = context.characterId !== undefined ? getCharaFilename(context.characterId) : 'unknown';
    const filename = `swarm_${characterName}_${humanizedDateTime()}`;
    const savedImagePath = await saveBase64AsFile(base64Image, characterName, filename, 'png');

    return { savedImagePath, imagePrompt };
}

// ============================================================
// Chat Insertion (stable, anchor-based)
// ============================================================

/**
 * Insert an image message into the chat after a given anchor message.
 * Uses the anchor ID to find the current position even if indices shifted.
 * Returns the anchor ID of the newly inserted image message for chaining.
 */
async function addImageMessage(savedImagePath, imagePrompt, messagePrefix = 'Generated image', anchorId = null, originalIndex = null) {
    const context = getContext();
    const chat = context.chat;

    let insertAfterIndex = resolveAnchorIndex(anchorId, originalIndex);
    if (insertAfterIndex === null || insertAfterIndex < 0 || insertAfterIndex >= chat.length) {
        insertAfterIndex = chat.length - 1;
    }

    const imageMessage = {
        name: context.name2 || 'System',
        is_system: true,
        mes: `${messagePrefix}: ${imagePrompt}`,
        sendDate: Date.now(),
        extra: { image: savedImagePath, title: imagePrompt },
    };

    const insertPosition = insertAfterIndex + 1;
    if (insertPosition < chat.length) {
        chat.splice(insertPosition, 0, imageMessage);
    } else {
        chat.push(imageMessage);
    }

    await eventSource.emit(event_types.CHAT_CHANGED, -1);
    context.clearChat();
    await context.printMessages();

    // Scroll to the newly inserted image, not the end of chat
    setTimeout(() => {
        const $messages = $('#chat .mes');
        if (insertPosition < $messages.length) {
            $messages[insertPosition]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, 250);

    await context.saveChat();

    // Return the anchor ID of the new image message so callers can save it for history
    return createChatAnchorId(chat[insertPosition] ?? imageMessage);
}

/**
 * Insert a prompt-only system message after the anchor message.
 */
async function addPromptMessage(imagePrompt, anchorId = null, originalIndex = null) {
    const context = getContext();
    const chat = context.chat;

    let insertAfterIndex = resolveAnchorIndex(anchorId, originalIndex);
    if (insertAfterIndex === null || insertAfterIndex < 0 || insertAfterIndex >= chat.length) {
        insertAfterIndex = chat.length - 1;
    }

    const testMessage = {
        name: context.name2 || 'System',
        is_system: true,
        mes: imagePrompt,
        sendDate: Date.now(),
    };

    const insertPosition = insertAfterIndex + 1;
    if (insertPosition < chat.length) {
        chat.splice(insertPosition, 0, testMessage);
    } else {
        chat.push(testMessage);
    }

    await eventSource.emit(event_types.CHAT_CHANGED, -1);
    context.clearChat();
    await context.printMessages();

    setTimeout(() => {
        const $messages = $('#chat .mes');
        if (insertPosition < $messages.length) {
            $messages[insertPosition]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, 250);

    await context.saveChat();
    return createChatAnchorId(chat[insertPosition] ?? testMessage);
}

// ============================================================
// Notification
// ============================================================

function playNotificationSound() {
    try {
        const audio = new Audio();
        audio.src = `${extensionFolderPath}/message.mp3`;
        audio.volume = 0.5;
        audio.play().catch(() => { });
    } catch { }
}

// ============================================================
// High-Level Generation Actions
// ============================================================

/**
 * Generate prompts for multiple message indices SIMULTANEOUSLY,
 * then queue resulting images one-by-one (respects SwarmUI concurrency).
 */
async function generatePromptsParallel(indices, type, swapDimensions = false) {
    const context = getContext();
    const chat = context.chat;

    // Pre-fetch SwarmUI params once for all queue items
    let savedParams = null;
    try {
        const sessionId = await validateAndGetSessionId();
        savedParams = await getSavedT2IParams(sessionId);
    } catch (e) {
        console.warn('[swarmUI-integration] Could not pre-fetch T2I params:', e);
    }

    // Build anchor IDs for all target messages before any insertions happen
    const anchors = indices.map(idx => {
        const msg = chat[idx];
        return { originalIndex: idx, anchorId: msg ? createChatAnchorId(msg) : null };
    });

    // Launch all prompt generations simultaneously
    const genObjects = anchors.map(({ originalIndex, anchorId }) =>
        createGeneration(type, originalIndex, anchorId)
    );

    const promptResults = await Promise.allSettled(
        genObjects.map((gen, i) => generatePromptForGen(gen, anchors[i].originalIndex))
    );

    if (type === 'prompt_only') {
        // Insert all prompt messages (sequentially to keep order stable)
        for (let i = 0; i < genObjects.length; i++) {
            const gen = genObjects[i];
            const result = promptResults[i];
            if (result.status === 'fulfilled' && gen.status !== 'cancelled') {
                const prompt = result.value;
                const msgAnchorId = await addPromptMessage(prompt, gen.chatAnchorId, gen.messageIndex);
                savePromptToHistory({
                    id: Date.now() + Math.random(),
                    prompt,
                    type: 'prompt_only',
                    chatAnchorId: msgAnchorId,
                    createdAt: Date.now(),
                });
                updateGeneration(gen.id, { status: 'done', finalPrompt: prompt });
                removeGeneration(gen.id, 3000);
            } else if (result.status === 'rejected') {
                updateGeneration(gen.id, { status: 'error', error: result.reason?.message || 'Unknown error' });
            }
        }
        playNotificationSound();
    } else if (type === 'prompt_then_image') {
        // Queue image generations in order
        for (let i = 0; i < genObjects.length; i++) {
            const gen = genObjects[i];
            const result = promptResults[i];
            if (result.status === 'fulfilled' && gen.status !== 'cancelled') {
                const prompt = result.value;
                gen.finalPrompt = prompt;
                updateGeneration(gen.id, { status: 'awaiting_image', finalPrompt: prompt });
                imageGenerationQueue.push({ gen, savedParams, swapDimensions });
            } else if (result.status === 'rejected') {
                updateGeneration(gen.id, { status: 'error', error: result.reason?.message || 'Unknown error' });
            }
        }
        renderGenerationPanel();
        processImageQueue();
    }
}

/**
 * Generate prompt for a single gen object (streams tokens into the panel).
 */
async function generatePromptForGen(gen, messageIndex) {
    const onToken = ({ text, thinking }) => {
        if (gen.status === 'cancelled') return;
        if (thinking) {
            gen.streamedThinking = (gen.streamedThinking || '') + text;
        } else {
            gen.streamedText += text;
        }
        renderGenerationPanel();
    };

    try {
        const raw = await generateImagePromptFromChat(messageIndex, gen.abortController, onToken);
        // Strip <think>...</think> from the final prompt (cleanImagePrompt runs after this)
        const prompt = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        return prompt;
    } catch (error) {
        if (gen.status !== 'cancelled') {
            updateGeneration(gen.id, { status: 'error', error: error.message });
        }
        throw error;
    }
}

/**
 * Generate image directly from a message (no LLM step), multiple at once,
 * then queue them.
 */
async function generateImagesFromMessages(indices, swapDimensions = false) {
    const context = getContext();
    const chat = context.chat;

    let savedParams = null;
    try {
        const sessionId = await validateAndGetSessionId();
        savedParams = await getSavedT2IParams(sessionId);
    } catch { }

    const anchors = indices.map(idx => {
        const msg = chat[idx];
        return { originalIndex: idx, anchorId: msg ? createChatAnchorId(msg) : null };
    });

    for (const { originalIndex, anchorId } of anchors) {
        const msgText = getMessageAtIndex(chat, originalIndex);
        if (!msgText?.trim()) continue;

        const gen = createGeneration('image_from_message', originalIndex, anchorId);
        gen.finalPrompt = msgText.trim();
        gen.status = 'awaiting_image';
        gen.streamedText = msgText.trim();
        imageGenerationQueue.push({ gen, savedParams, swapDimensions });
        renderGenerationPanel();
    }

    processImageQueue();
}

// ============================================================
// Image Queue Processor
// ============================================================

async function processImageQueue() {
    if (queueProcessorRunning) return;
    queueProcessorRunning = true;

    while (imageGenerationQueue.length > 0) {
        const item = imageGenerationQueue.shift();
        const { gen, savedParams, swapDimensions } = item;

        if (gen.status === 'cancelled') continue;

        updateGeneration(gen.id, { status: 'awaiting_image' });

        try {
            const result = await generateAndSaveImage(gen.finalPrompt, savedParams, swapDimensions);
            const imgAnchorId = await addImageMessage(
                result.savedImagePath,
                result.imagePrompt,
                'Generated image',
                gen.chatAnchorId,
                gen.messageIndex
            );

            savePromptToHistory({
                id: Date.now() + Math.random(),
                prompt: gen.finalPrompt,
                type: gen.type,
                imagePath: result.savedImagePath,
                chatAnchorId: imgAnchorId,
                createdAt: Date.now(),
            });

            updateGeneration(gen.id, { status: 'done' });
            playNotificationSound();
            removeGeneration(gen.id, 3000);
        } catch (error) {
            if (gen.status !== 'cancelled') {
                updateGeneration(gen.id, { status: 'error', error: error.message });
            }
        }

        await new Promise(r => setTimeout(r, 100));
    }

    queueProcessorRunning = false;
}

// ============================================================
// Generation Panel UI (replaces queue widget)
// ============================================================
function patchStreamingItems() {
    activeGenerations.forEach(gen => {
        if (gen.status !== 'generating_prompt') return;
        const $item = $(`.swarm-gen-item[data-gen-id="${gen.id}"]`);
        if (!$item.length) return;

        // Patch thinking text without rebuilding DOM
        if (gen.streamedThinking) {
            let $thinking = $item.find('.swarm-thinking-text');
            if (!$thinking.length) {
                // First time thinking appears — need a full re-render of this item only
                return; // fall through to full render below
            }
            $thinking.text(gen.streamedThinking.slice(-300));
        }

        // Patch response text
        let $streamText = $item.find('.swarm-stream-text');
        if (gen.streamedText) {
            if (!$streamText.length) return; // needs full render
            $streamText.text(gen.streamedText);
            $streamText.append('<span class="swarm-cursor">▌</span>');
        }
    });
}
function renderGenerationPanel() {
    const $panel = $('#swarm_gen_panel');
    const $list = $('#swarm_gen_list');
    const generations = [...activeGenerations.values()];

    const hasActivity = generations.length > 0 || getPromptHistory().length > 0;
    if (!hasActivity) { $panel.addClass('swarm-panel--hidden'); return; }
    $panel.removeClass('swarm-panel--hidden');

    // Check if we can patch in place (all active gens already have DOM nodes)
    const allRendered = generations.every(gen =>
        gen.status !== 'generating_prompt' ||
        $list.find(`.swarm-gen-item[data-gen-id="${gen.id}"]`).length > 0
    );

    if (allRendered) {
        patchStreamingItems();
        // Still re-render items whose status changed (not generating_prompt)
        generations.forEach(gen => {
            if (gen.status === 'generating_prompt') return;
            const $existing = $list.find(`.swarm-gen-item[data-gen-id="${gen.id}"]`);
            if ($existing.length) $existing.replaceWith(buildGenItemHtml(gen));
        });
        renderPromptHistory();
        return;
    }

    // Full re-render
    $list.empty();
    if (generations.length === 0) {
        $list.html('<div class="swarm-gen-empty">No active generations</div>');
    } else {
        generations.forEach(gen => $list.append(buildGenItemHtml(gen)));
    }
    renderPromptHistory();
}
function buildGenItemHtml(gen) {
    const statusMeta = {
        generating_prompt: { icon: 'fa-brain', cls: 'swarm-status--thinking', label: 'Thinking' },
        awaiting_image: { icon: 'fa-hourglass-half', cls: 'swarm-status--queued', label: 'Queued' },
        done: { icon: 'fa-check', cls: 'swarm-status--done', label: 'Done' },
        error: { icon: 'fa-triangle-exclamation', cls: 'swarm-status--error', label: 'Error' },
        cancelled: { icon: 'fa-ban', cls: 'swarm-status--cancelled', label: 'Cancelled' },
    }[gen.status] || { icon: 'fa-circle', cls: '', label: gen.status };

    const typeLabel = {
        prompt_only: 'Prompt Only',
        prompt_then_image: 'Prompt → Image',
        image_from_message: 'Image from Msg',
    }[gen.type] || gen.type;

    const canCancel = gen.status === 'generating_prompt' || gen.status === 'awaiting_image';
    const canRetry = gen.status === 'error';
    const canDismiss = gen.status === 'done' || gen.status === 'error' || gen.status === 'cancelled';

    const displayText = (gen.finalPrompt || gen.streamedText || '').substring(0, 120);
    const displayTrunc = (gen.finalPrompt || gen.streamedText || '').length > 120 ? '…' : '';

    return `
        <div class="swarm-gen-item swarm-gen-item--${gen.status}" data-gen-id="${gen.id}">
            <div class="swarm-gen-item__header">
                <span class="swarm-gen-status ${statusMeta.cls}">
                    <i class="fa-solid ${statusMeta.icon}${gen.status === 'generating_prompt' ? ' swarm-spin' : ''}"></i>
                    ${statusMeta.label}
                </span>
                <span class="swarm-gen-type">${typeLabel}</span>
                <div class="swarm-gen-actions">
                    ${canCancel ? `<button class="swarm-icon-btn swarm-cancel-gen"  data-gen-id="${gen.id}" title="Cancel"><i class="fa-solid fa-xmark"></i></button>` : ''}
                    ${canRetry ? `<button class="swarm-icon-btn swarm-retry-gen"   data-gen-id="${gen.id}" title="Retry"><i class="fa-solid fa-rotate-right"></i></button>` : ''}
                    ${canDismiss ? `<button class="swarm-icon-btn swarm-dismiss-gen" data-gen-id="${gen.id}" title="Dismiss"><i class="fa-solid fa-xmark"></i></button>` : ''}
                </div>
            </div>
            ${gen.status === 'generating_prompt' ? `
                <div class="swarm-gen-stream">
                    ${gen.streamedThinking ? `
                        <div class="swarm-stream-thinking">
                            <span class="swarm-thinking-label"><i class="fa-solid fa-brain"></i> Thinking…</span>
                            <div class="swarm-thinking-text">${escapeHtml(gen.streamedThinking.slice(-300))}</div>
                        </div>
                    ` : ''}
                    ${gen.streamedText
                ? `<div class="swarm-stream-text">${escapeHtml(gen.streamedText)}<span class="swarm-cursor">▌</span></div>`
                : (!gen.streamedThinking ? `<span class="swarm-cursor">▌</span>` : '')
            }
                </div>
            ` : ''}
            ${displayText && gen.status !== 'generating_prompt' ? `
                <div class="swarm-gen-prompt-preview">${escapeHtml(displayText)}${displayTrunc}</div>
            ` : ''}
            ${gen.error ? `<div class="swarm-gen-error">${escapeHtml(gen.error)}</div>` : ''}
            ${gen.status === 'awaiting_image' ? `<div class="swarm-gen-queue-pos">In image queue</div>` : ''}
        </div>
    `;
}

function renderPromptHistory() {
    const $historyList = $('#swarm_history_list');
    if (!$historyList.length) return;

    const history = getPromptHistory();
    $historyList.empty();

    if (history.length === 0) {
        $historyList.html('<div class="swarm-gen-empty">No history yet</div>');
        return;
    }

    history.slice(0, 20).forEach(entry => {
        const timeAgo = formatTimeAgo(entry.createdAt);
        const typeLabel = {
            prompt_only: 'Prompt',
            prompt_then_image: 'Image',
            image_from_message: 'Img from Msg',
        }[entry.type] || entry.type;

        const preview = (entry.prompt || '').substring(0, 80) + ((entry.prompt || '').length > 80 ? '…' : '');

        $historyList.append(`
            <div class="swarm-history-item" data-anchor="${escapeHtml(entry.chatAnchorId || '')}">
                <div class="swarm-history-item__header">
                    <span class="swarm-history-type">${typeLabel}</span>
                    <span class="swarm-history-time">${timeAgo}</span>
                    <button class="swarm-icon-btn swarm-jump-to" data-anchor="${escapeHtml(entry.chatAnchorId || '')}" title="Jump to message">
                        <i class="fa-solid fa-arrow-right-to-bracket"></i>
                    </button>
                </div>
                <div class="swarm-history-prompt" title="${escapeHtml(entry.prompt || '')}">${escapeHtml(preview)}</div>
            </div>
        `);
    });
}

function formatTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function jumpToAnchor(anchorId) {
    if (!anchorId) return;
    const context = getContext();
    const chat = context.chat;
    const idx = resolveAnchorIndex(anchorId, -1);
    if (idx < 0) { toastr.warning('Message not found in current chat'); return; }

    const $messages = $('#chat .mes');
    if (idx < $messages.length) {
        $messages[idx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Brief highlight
        $messages.eq(idx).addClass('swarm-highlight-flash');
        setTimeout(() => $messages.eq(idx).removeClass('swarm-highlight-flash'), 1500);
    }
}

// ============================================================
// Prompt Preview Modal
// ============================================================

class SwarmPromptModal {
    constructor() {
        this.overlay = null;
        this.isVisible = false;
    }

    show(prompt, upToMessageIndex, onGenerate, onCancel) {
        if (this.isVisible) this.hide();
        this.isVisible = true;

        this.overlay = document.createElement('div');
        this.overlay.className = 'swarm-modal-overlay';
        this.overlay.innerHTML = `
            <div class="swarm-modal">
                <div class="swarm-modal-header">
                    <h3 class="swarm-modal-title"><i class="fa-solid fa-wand-magic-sparkles"></i> Review Prompt</h3>
                    <button class="swarm-modal-close" type="button"><i class="fa-solid fa-times"></i></button>
                </div>
                <div class="swarm-modal-body">
                    <div class="swarm-prompt-info">
                        <i class="fa-solid fa-info-circle"></i>
                        Edit the generated prompt before sending to SwarmUI.
                    </div>
                    <textarea class="swarm-prompt-textarea" spellcheck="false">${escapeHtml(prompt)}</textarea>
                    <div class="swarm-char-count"><span class="char-count">${prompt.length}</span> characters</div>
                    <div class="swarm-modal-actions">
                        <button class="swarm-btn swarm-btn-warning regenerate-btn"><i class="fa-solid fa-rotate-right"></i> Regenerate</button>
                        <button class="swarm-btn swarm-btn-success generate-image-btn"><i class="fa-solid fa-image"></i> Generate Image</button>
                        <button class="swarm-btn swarm-btn-secondary cancel-btn"><i class="fa-solid fa-times"></i> Cancel</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(this.overlay);
        this.bindEvents(upToMessageIndex, onGenerate, onCancel);

        setTimeout(() => {
            const ta = this.overlay.querySelector('.swarm-prompt-textarea');
            ta.focus(); ta.select();
        }, 100);
    }

    hide() {
        if (this.overlay) { document.body.removeChild(this.overlay); this.overlay = null; }
        this.isVisible = false;
    }

    bindEvents(upToMessageIndex, onGenerate, onCancel) {
        const textarea = this.overlay.querySelector('.swarm-prompt-textarea');
        const charCount = this.overlay.querySelector('.char-count');
        const regenerateBtn = this.overlay.querySelector('.regenerate-btn');
        const generateBtn = this.overlay.querySelector('.generate-image-btn');
        const cancelBtn = this.overlay.querySelector('.cancel-btn');
        const closeBtn = this.overlay.querySelector('.swarm-modal-close');

        textarea.addEventListener('input', () => { charCount.textContent = textarea.value.length; });

        const close = () => { this.hide(); if (onCancel) onCancel(); };
        closeBtn.addEventListener('click', close);
        cancelBtn.addEventListener('click', close);
        const handleEsc = (e) => { if (e.key === 'Escape' && this.isVisible) { close(); document.removeEventListener('keydown', handleEsc); } };
        document.addEventListener('keydown', handleEsc);

        regenerateBtn.addEventListener('click', async () => {
            if (regenerateBtn.disabled) return;
            regenerateBtn.disabled = true;
            regenerateBtn.innerHTML = '<span class="swarm-loading-spinner"></span> Regenerating…';
            try {
                const newPrompt = await generateImagePromptFromChat(upToMessageIndex);
                textarea.value = newPrompt;
                charCount.textContent = newPrompt.length;
                toastr.success('Prompt regenerated');
            } catch (e) {
                toastr.error(`Failed: ${e.message}`);
            } finally {
                regenerateBtn.disabled = false;
                regenerateBtn.innerHTML = '<i class="fa-solid fa-rotate-right"></i> Regenerate';
            }
        });

        generateBtn.addEventListener('click', async () => {
            if (generateBtn.disabled) return;
            const finalPrompt = textarea.value.trim();
            if (!finalPrompt) { toastr.error('Please enter a prompt.'); return; }
            generateBtn.disabled = true;
            generateBtn.innerHTML = '<span class="swarm-loading-spinner"></span> Queuing…';
            this.hide();
            if (onGenerate) await onGenerate(finalPrompt);
        });
    }
}

let promptModal = new SwarmPromptModal();

// ============================================================
// Button Click Handlers
// ============================================================

async function handleGenerateImage(messageIndex) {
    const capturedShift = isShiftPressed;
    if (settings.show_prompt_modal !== false) {
        try {
            const imagePrompt = await generateImagePromptFromChat(messageIndex);
            promptModal.show(
                imagePrompt,
                messageIndex,
                async (finalPrompt) => {
                    const context = getContext();
                    const chat = context.chat;
                    const anchorId = chat[messageIndex] ? createChatAnchorId(chat[messageIndex]) : null;
                    const gen = createGeneration('prompt_then_image', messageIndex, anchorId);
                    gen.finalPrompt = finalPrompt;
                    gen.streamedText = finalPrompt;
                    gen.status = 'awaiting_image';

                    let savedParams = null;
                    try { const sid = await validateAndGetSessionId(); savedParams = await getSavedT2IParams(sid); } catch { }

                    imageGenerationQueue.push({ gen, savedParams, swapDimensions: capturedShift });
                    renderGenerationPanel();
                    processImageQueue();
                    toastr.success('Added to image queue' + (capturedShift ? ' (dims swapped)' : ''));
                },
                null
            );
        } catch (e) {
            toastr.error(`Failed to generate prompt: ${e.message}`);
        }
    } else {
        await generatePromptsParallel([messageIndex], 'prompt_then_image', capturedShift);
        toastr.info('Image generation queued' + (capturedShift ? ' (dims swapped)' : ''));
    }
}

async function handleGeneratePrompt(messageIndex) {
    await generatePromptsParallel([messageIndex], 'prompt_only');
    toastr.info('Prompt generation started');
}

async function handleGenerateFromMessage(messageIndex) {
    const capturedShift = isShiftPressed;
    await generateImagesFromMessages([messageIndex], capturedShift);
    toastr.info('Image generation queued' + (capturedShift ? ' (dims swapped)' : ''));
}

// Message button handlers
async function swarmMessageGenerateImage(e) {
    const messageId = parseInt($(e.currentTarget).closest('.mes').attr('mesid'));
    await handleGenerateImage(messageId);
}
async function swarmMessageGeneratePrompt(e) {
    const messageId = parseInt($(e.currentTarget).closest('.mes').attr('mesid'));
    await handleGeneratePrompt(messageId);
}
async function swarmMessageGenerateFromMessage(e) {
    const messageId = parseInt($(e.currentTarget).closest('.mes').attr('mesid'));
    await handleGenerateFromMessage(messageId);
}

// ============================================================
// Button Injection
// ============================================================

function injectSwarmUIButtons() {
    $('.extraMesButtons').each(function () {
        const $container = $(this);
        if ($container.find('.swarm_mes_button').length > 0) return;
        const swarmButtons = `
            <div title="SwarmUI: Generate Image (LLM Prompt)" class="mes_button swarm_mes_button swarm_mes_gen_image fa-solid fa-wand-magic-sparkles"></div>
            <div title="SwarmUI: Generate Image from Message" class="mes_button swarm_mes_button swarm_mes_gen_from_msg fa-solid fa-image"></div>
            <div title="SwarmUI: Generate Prompt Only" class="mes_button swarm_mes_button swarm_mes_gen_prompt fa-solid fa-pen-fancy"></div>
        `;
        const $sdButton = $container.find('.sd_message_gen');
        if ($sdButton.length > 0) $sdButton.after(swarmButtons);
        else $container.prepend(swarmButtons);
    });
}

function observeForNewMessages() {
    const observer = new MutationObserver(mutations => {
        let shouldInject = false;
        mutations.forEach(m => {
            if (m.type === 'childList') {
                m.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        const $n = $(node);
                        if ($n.hasClass('mes') || $n.find('.mes').length > 0) shouldInject = true;
                    }
                });
            }
        });
        if (shouldInject) setTimeout(injectSwarmUIButtons, 50);
    });
    const chatContainer = document.getElementById('chat');
    if (chatContainer) observer.observe(chatContainer, { childList: true, subtree: true });
}

// ============================================================
// Shift State
// ============================================================

function updateButtonStates() {
    const els = ['#swarm_generate_button', '#swarm_generate_from_message_button', '.swarm_mes_gen_image', '.swarm_mes_gen_from_msg'];
    els.forEach(sel => {
        if (isShiftPressed) $(sel).addClass('shift-active');
        else $(sel).removeClass('shift-active');
    });
}

// ============================================================
// Panel Drag
// ============================================================

function makeGenPanelDraggable() {
    const $panel = $('#swarm_gen_panel');
    const $header = $('#swarm_panel_header');
    let isDragging = false, startX, startY, initL, initT;

    $header.css('cursor', 'move');
    $header.on('mousedown', e => {
        isDragging = true;
        startX = e.clientX; startY = e.clientY;
        const rect = $panel[0].getBoundingClientRect();
        initL = rect.left; initT = rect.top;
        $panel.addClass('swarm-panel--dragging');
        e.preventDefault();
    });
    $(document).on('mousemove', e => {
        if (!isDragging) return;
        const newL = Math.max(0, Math.min(window.innerWidth - $panel.outerWidth(), initL + e.clientX - startX));
        const newT = Math.max(0, Math.min(window.innerHeight - $panel.outerHeight(), initT + e.clientY - startY));
        $panel.css({ left: newL + 'px', top: newT + 'px', right: 'auto', bottom: 'auto' });
    });
    $(document).on('mouseup', () => { if (isDragging) { isDragging = false; $panel.removeClass('swarm-panel--dragging'); } });
}

// ============================================================
// Exported helpers (used by custom.js)
// ============================================================

export function getCustomModel() { return String(settings.custom_model || ''); }
export function getCustomParameters() { return String(settings.custom_parameters || ''); }

// ============================================================
// Initialisation
// ============================================================

jQuery(async () => {
    try {
        // Load settings panel HTML
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensions_settings').append(settingsHtml);
        $('#swarm_settings input, #swarm_settings textarea').on('input', onInput);

        // Load send-bar buttons
        const buttonHtml = await $.get(`${extensionFolderPath}/button.html`);
        $('#send_but').before(buttonHtml);

        // Build the Generation Panel
        const panelHtml = `
            <div id="swarm_gen_panel" class="swarm-panel swarm-panel--hidden">
                <div class="swarm-panel__header" id="swarm_panel_header">
                    <div class="swarm-panel__title">
                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                        <span>SwarmUI</span>
                    </div>
                    <div class="swarm-panel__controls">
                        <button id="swarm_panel_toggle_body" class="swarm-icon-btn" title="Toggle panel">
                            <i class="fa-solid fa-chevron-up"></i>
                        </button>
                        <button id="swarm_panel_close" class="swarm-icon-btn" title="Close panel">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>
                <div class="swarm-panel__body" id="swarm_panel_body">
                    <!-- Active Generations -->
                    <div class="swarm-panel__section-header">
                        <span><i class="fa-solid fa-bolt"></i> Active</span>
                    </div>
                    <div id="swarm_gen_list" class="swarm-panel__section-content"></div>
                    <!-- Prompt History -->
                    <div class="swarm-panel__section-header swarm-section-history">
                        <span><i class="fa-solid fa-clock-rotate-left"></i> History</span>
                        <button id="swarm_clear_history" class="swarm-text-btn" title="Clear history">Clear</button>
                    </div>
                    <div id="swarm_history_list" class="swarm-panel__section-content"></div>
                </div>
            </div>
        `;
        $('body').append(panelHtml);

        // ---- Panel Controls ----
        $('#swarm_panel_toggle_body').on('click', () => {
            const $body = $('#swarm_panel_body');
            const $icon = $('#swarm_panel_toggle_body i');
            if ($body.is(':visible')) {
                $body.hide();
                $icon.removeClass('fa-chevron-up').addClass('fa-chevron-down');
            } else {
                $body.show();
                $icon.removeClass('fa-chevron-down').addClass('fa-chevron-up');
            }
        });

        $('#swarm_panel_close').on('click', () => {
            activeGenerations.clear();
            renderGenerationPanel();
        });

        $('#swarm_clear_history').on('click', () => { clearPromptHistory(); toastr.info('History cleared'); });

        // ---- Generation action buttons (toolbar) ----
        $('#swarm_generate_button').on('click', async () => {
            const context = getContext();
            const latestMessageIndex = context.chat.length - 1;
            await handleGenerateImage(latestMessageIndex);
        });

        $('#swarm_generate_prompt_button').on('click', async () => {
            const context = getContext();
            const latestMessageIndex = context.chat.length - 1;
            await handleGeneratePrompt(latestMessageIndex);
        });

        $('#swarm_generate_from_message_button').on('click', async () => {
            const context = getContext();
            const latestMessageIndex = context.chat.length - 1;
            await handleGenerateFromMessage(latestMessageIndex);
        });

        // ---- Message buttons ----
        $(document).on('click', '.swarm_mes_gen_image', swarmMessageGenerateImage);
        $(document).on('click', '.swarm_mes_gen_prompt', swarmMessageGeneratePrompt);
        $(document).on('click', '.swarm_mes_gen_from_msg', swarmMessageGenerateFromMessage);

        // ---- Panel event delegation ----
        $(document).on('click', '.swarm-cancel-gen', (e) => {
            const genId = parseInt($(e.currentTarget).data('gen-id'));
            const gen = activeGenerations.get(genId);
            if (gen) {
                gen.abortController?.abort();
                updateGeneration(genId, { status: 'cancelled' });
                removeGeneration(genId, 2000);
            }
        });

        $(document).on('click', '.swarm-dismiss-gen', (e) => {
            const genId = parseInt($(e.currentTarget).data('gen-id'));
            removeGeneration(genId);
        });

        $(document).on('click', '.swarm-retry-gen', async (e) => {
            const genId = parseInt($(e.currentTarget).data('gen-id'));
            const gen = activeGenerations.get(genId);
            if (!gen) return;

            // Reset and retry
            gen.abortController = new AbortController();
            gen.status = 'generating_prompt';
            gen.streamedText = '';
            gen.error = null;
            renderGenerationPanel();

            try {
                const prompt = await generatePromptForGen(gen, gen.messageIndex);
                if (gen.type === 'prompt_only') {
                    await addPromptMessage(prompt, gen.chatAnchorId, gen.messageIndex);
                    savePromptToHistory({ id: Date.now(), prompt, type: gen.type, chatAnchorId: gen.chatAnchorId, createdAt: Date.now() });
                    updateGeneration(genId, { status: 'done', finalPrompt: prompt });
                    removeGeneration(genId, 3000);
                } else {
                    gen.finalPrompt = prompt;
                    gen.status = 'awaiting_image';
                    let savedParams = null;
                    try { const sid = await validateAndGetSessionId(); savedParams = await getSavedT2IParams(sid); } catch { }
                    imageGenerationQueue.push({ gen, savedParams, swapDimensions: false });
                    renderGenerationPanel();
                    processImageQueue();
                }
            } catch (err) {
                updateGeneration(genId, { status: 'error', error: err.message });
            }
        });

        $(document).on('click', '.swarm-jump-to', (e) => {
            const anchorId = $(e.currentTarget).data('anchor');
            jumpToAnchor(anchorId);
        });

        // ---- Shift key tracking ----
        $(document).on('keydown', (e) => { if (e.shiftKey && !isShiftPressed) { isShiftPressed = true; updateButtonStates(); } });
        $(document).on('keyup', (e) => { if (!e.shiftKey && isShiftPressed) { isShiftPressed = false; updateButtonStates(); } });
        $(window).on('blur', () => { if (isShiftPressed) { isShiftPressed = false; updateButtonStates(); } });

        // ---- Panel drag ----
        makeGenPanelDraggable();

        // ---- Chat events ----
        setTimeout(injectSwarmUIButtons, 100);
        observeForNewMessages();
        eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(injectSwarmUIButtons, 100));

        await loadSettings();
        console.log('[swarmUI-integration] Initialized successfully');
    } catch (error) {
        console.error('[swarmUI-integration] Initialization failed:', error);
    }
});