import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders, substituteParams } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { oai_settings } from '../../../openai.js';
import { generateQuietPrompt, generateRaw } from '../../../../script.js';
import { debounce_timeout } from '../../../constants.js';
import { saveBase64AsFile, getBase64Async, getCharaFilename } from '../../../utils.js';
import { humanizedDateTime } from '../../../RossAscends-mods.js';
import { generateRawWithStops } from './src/custom.js';

const MODULE_NAME = 'swarmui-integration';
const extensionFolderPath = `scripts/extensions/third-party/${MODULE_NAME}`;

let settings = {};
let cachedSessionId = null;
let promptModal = null;

const imageGenerationQueue = [];
let isProcessingQueue = false;
let queueProcessorRunning = false;

// Menu state
let activeMenu = null;

class QueueItem {
    constructor(type, messageIndex, prompt = null, customPrompt = false, savedParams = null, flipDimensions = false) {
        this.id = Date.now() + Math.random();
        this.type = type;
        this.messageIndex = messageIndex;
        this.originalMessageId = null;
        this.prompt = prompt;
        this.customPrompt = customPrompt;
        this.savedParams = savedParams;
        this.flipDimensions = flipDimensions; // New flag for dimension swapping
        this.status = 'pending';
        this.error = null;
        this.createdAt = Date.now();
        this.abortController = null;

        if (messageIndex !== null && messageIndex >= 0) {
            const context = getContext();
            const chat = context.chat;
            if (messageIndex < chat.length && chat[messageIndex]) {
                this.originalMessageId = this.createMessageId(chat[messageIndex]);
            }
        }
    }

    createMessageId(message) {
        const content = (message.mes || '').substring(0, 50);
        const name = message.name || '';
        const date = message.sendDate || message.send_date || Date.now();
        return `${name}_${date}_${content.length}_${content.substring(0, 10)}`;
    }

    getCurrentMessageIndex() {
        if (this.originalMessageId === null) {
            return this.messageIndex;
        }

        const context = getContext();
        const chat = context.chat;

        for (let i = 0; i < chat.length; i++) {
            if (this.createMessageId(chat[i]) === this.originalMessageId) {
                return i;
            }
        }
        return this.messageIndex;
    }
}

async function addToQueue(type, messageIndex = null, prompt = null, customPrompt = false, flipDimensions = false) {
    let savedParams = null;
    try {
        const sessionId = await validateAndGetSessionId();
        savedParams = await getSavedT2IParams(sessionId);
    } catch (error) {
        console.warn('[swarmUI-integration] Failed to fetch parameters for queue item:', error);
    }

    const queueItem = new QueueItem(type, messageIndex, prompt, customPrompt, savedParams, flipDimensions);
    imageGenerationQueue.push(queueItem);

    updateQueueDisplay();
    processQueue();

    return queueItem.id;
}

function removeFromQueue(itemId) {
    const index = imageGenerationQueue.findIndex(item => item.id === itemId);
    if (index !== -1) {
        imageGenerationQueue.splice(index, 1);
        updateQueueDisplay();
    }
}

function cancelQueueItem(itemId) {
    const item = imageGenerationQueue.find(item => item.id === itemId);
    if (!item) return;

    if (item.abortController) {
        item.abortController.abort();
        item.abortController = null;
    }

    updateQueueStatus(itemId, 'cancelled', 'Cancelled by user');

    setTimeout(() => {
        removeFromQueue(itemId);
    }, 2000);
}

function updateQueueStatus(itemId, status, error = null) {
    const item = imageGenerationQueue.find(item => item.id === itemId);
    if (item) {
        item.status = status;
        item.error = error;
        updateQueueDisplay();
    }
}

function updateQueueDisplay() {
    const $queueWidget = $('#swarm_queue_widget');
    const $queueCount = $('.queue-count');
    const $queueList = $('#swarm_queue_list');

    $queueCount.text(imageGenerationQueue.length);

    if (imageGenerationQueue.length === 0) {
        $queueWidget.hide();
        return;
    }

    $queueWidget.show();
    $queueList.empty();

    imageGenerationQueue.forEach((item) => {
        const context = getContext();
        const chat = context.chat;

        let messageText = 'Unknown';
        const currentIndex = item.getCurrentMessageIndex();

        if (currentIndex !== null && currentIndex >= 0 && currentIndex < chat.length) {
            messageText = `Msg ${currentIndex + 1}: ${getMessageAtIndex(chat, currentIndex)?.substring(0, 25)}...`;
        } else if (currentIndex !== null) {
            messageText = `Msg ${currentIndex + 1}: (deleted)`;
        }

        const statusIcon = {
            'pending': 'fa-clock text-warning',
            'processing': 'fa-hourglass-half text-info',
            'completed': 'fa-check text-success',
            'error': 'fa-times text-danger',
            'cancelled': 'fa-ban text-muted'
        }[item.status];

        const typeIcon = {
            'generate_image': 'fa-wand-magic-sparkles',
            'generate_prompt': 'fa-pen-fancy',
            'generate_from_message': 'fa-image'
        }[item.type];

        const flipIcon = item.flipDimensions ? '<i class="fa-solid fa-rotate text-info" title="Dimensions Reversed"></i>' : '';

        const canCancel = (item.status === 'pending' || item.status === 'processing');

        const queueItemHtml = `
            <div class="swarm-queue-item" data-item-id="${item.id}">
                <div class="swarm-queue-item-header">
                    <div class="swarm-queue-icons">
                        <i class="fa-solid ${statusIcon}"></i>
                        <i class="fa-solid ${typeIcon}"></i>
                        ${flipIcon}
                    </div>
                    ${canCancel ?
                `<button class="swarm-queue-cancel" data-item-id="${item.id}" title="Cancel">
                            <i class="fa-solid fa-ban"></i>
                        </button>` : ''}
                </div>
                <div class="swarm-queue-message" title="${messageText}">${messageText}</div>
                ${item.error ? `<div class="swarm-queue-error">${item.error}</div>` : ''}
            </div>
        `;

        $queueList.append(queueItemHtml);
    });
}

function makeQueueWidgetDraggable() {
    const $widget = $('#swarm_queue_widget');
    const $header = $('#swarm_queue_header');

    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    $header.css('cursor', 'move');

    $header.on('mousedown', (e) => {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;

        const rect = $widget[0].getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        $widget.addClass('dragging');
        e.preventDefault();
    });

    $(document).on('mousemove', (e) => {
        if (!isDragging) return;

        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;

        const newLeft = Math.max(0, Math.min(window.innerWidth - $widget.outerWidth(), initialLeft + deltaX));
        const newTop = Math.max(0, Math.min(window.innerHeight - $widget.outerHeight(), initialTop + deltaY));

        $widget.css({
            left: newLeft + 'px',
            top: newTop + 'px',
            right: 'auto',
            bottom: 'auto'
        });
    });

    $(document).on('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            $widget.removeClass('dragging');
        }
    });
}

async function processQueue() {
    if (queueProcessorRunning) return;
    queueProcessorRunning = true;

    while (imageGenerationQueue.length > 0) {
        const item = imageGenerationQueue.find(item => item.status === 'pending');
        if (!item) break;

        updateQueueStatus(item.id, 'processing');

        try {
            await processQueueItem(item);

            if (item.status !== 'cancelled') {
                updateQueueStatus(item.id, 'completed');
                setTimeout(() => {
                    removeFromQueue(item.id);
                }, 2000);
            }

        } catch (error) {
            if (error.name === 'AbortError' || item.status === 'cancelled') {
                console.log(`[swarmUI-integration] Queue item ${item.id} was cancelled`);
            } else {
                console.error(`[swarmUI-integration] Queue item ${item.id} failed:`, error);
                updateQueueStatus(item.id, 'error', error.message);
                setTimeout(() => {
                    removeFromQueue(item.id);
                }, 5000);
            }
        } finally {
            if (item.abortController) {
                item.abortController = null;
            }
        }

        await new Promise(resolve => setTimeout(resolve, 100));
    }

    queueProcessorRunning = false;
}

async function processQueueItem(item) {
    const context = getContext();
    const chat = context.chat;
    const currentMessageIndex = item.getCurrentMessageIndex();

    if (currentMessageIndex !== null && (currentMessageIndex < 0 || currentMessageIndex >= chat.length)) {
        throw new Error(`Invalid message index: ${currentMessageIndex}.`);
    }

    item.abortController = new AbortController();

    switch (item.type) {
        case 'generate_image': {
            let imagePrompt;

            if (item.customPrompt) {
                imagePrompt = item.prompt;
            } else {
                imagePrompt = await generateImagePromptFromChat(currentMessageIndex, item.abortController);
            }

            if (item.status === 'cancelled') {
                throw new Error('Generation cancelled');
            }

            // Pass the flipDimensions flag to the generator
            const result = await generateAndSaveImage(imagePrompt, item.savedParams, item.flipDimensions);

            await addImageMessage(
                result.savedImagePath,
                result.imagePrompt,
                'Generated image',
                currentMessageIndex
            );

            playNotificationSound();
            break;
        }

        case 'generate_prompt': {
            const imagePrompt = await generateImagePromptFromChat(currentMessageIndex, item.abortController);

            if (item.status === 'cancelled') {
                throw new Error('Generation cancelled');
            }

            const testMessage = {
                name: context.name2 || 'System',
                is_system: true,
                mes: `${imagePrompt}`,
                sendDate: Date.now(),
            };

            if (currentMessageIndex !== null && currentMessageIndex >= 0 && currentMessageIndex < chat.length) {
                const insertPosition = currentMessageIndex + 1;
                chat.splice(insertPosition, 0, testMessage);
            } else {
                chat.push(testMessage);
            }

            await eventSource.emit(event_types.CHAT_CHANGED, -1);
            context.clearChat();
            await context.printMessages();
            await context.saveChat();

            playNotificationSound();
            break;
        }

        case 'generate_from_message': {
            if (currentMessageIndex === null || currentMessageIndex < 0 || currentMessageIndex >= chat.length) {
                throw new Error(`Cannot generate from message: invalid index ${currentMessageIndex}`);
            }

            const messageText = getMessageAtIndex(chat, currentMessageIndex);
            if (!messageText || !messageText.trim()) {
                throw new Error('Message is empty or not found.');
            }

            const imagePrompt = messageText.trim();
            // Pass flipDimensions
            const result = await generateAndSaveImage(imagePrompt, item.savedParams, item.flipDimensions);

            await addImageMessage(
                result.savedImagePath,
                result.imagePrompt,
                'Generated image from message',
                currentMessageIndex
            );

            playNotificationSound();
            break;
        }
    }
}

function playNotificationSound() {
    try {
        const audio = new Audio();
        audio.src = `${extensionFolderPath}/message.mp3`;
        audio.volume = 0.5;
        audio.play().catch(error => {
            console.log('[swarmUI-integration] Could not play notification sound:', error);
        });
    } catch (error) {
        console.log('[swarmUI-integration] Audio notification failed:', error);
    }
}

// ... [Previous Settings/Session helper functions remain unchanged] ...
// I will include them for completeness but they are identical to previous version until generateAndSaveImage

export function getCustomModel() {
    if (!settings.custom_model) return '';
    return String(settings.custom_model);
}

export function getCustomParameters() {
    if (!settings.custom_parameters) return '';
    return String(settings.custom_parameters);
}

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

    $('#swarm_append_prompt').prop('checked', !!settings.append_prompt).trigger('input');
    $('#swarm_use_raw').prop('checked', !!settings.use_raw).trigger('input');
    $('#swarm_use_prompt').prop('checked', !!settings.use_prompt).trigger('input');
    $('#swarm_use_custom_generate_raw').prop('checked', !!settings.use_custom_generate_raw).trigger('input');
    $('#swarm_show_prompt_modal').prop('checked', !!settings.show_prompt_modal).trigger('input');

    cachedSessionId = settings.cached_session_id || null;
}

function onInput(event) {
    const id = event.target.id.replace('swarm_', '');

    if (id === 'append_prompt' || id === 'use_raw' || id === 'show_prompt_modal' || id === 'use_custom_generate_raw') {
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
    if (settings.session_id && settings.session_id.trim()) {
        return settings.session_id.trim();
    }
    if (cachedSessionId) {
        return cachedSessionId;
    }
    try {
        const newSessionId = await createNewSession();
        cachedSessionId = newSessionId;
        settings.cached_session_id = newSessionId;
        extension_settings[MODULE_NAME] = settings;
        saveSettingsDebounced();
        return newSessionId;
    } catch (error) {
        throw error;
    }
}

async function validateAndGetSessionId() {
    let sessionId = await getSessionId();
    try {
        await getSavedT2IParams(sessionId);
        return sessionId;
    } catch (error) {
        cachedSessionId = null;
        delete settings.cached_session_id;
        const newSessionId = await createNewSession();
        cachedSessionId = newSessionId;
        settings.cached_session_id = newSessionId;
        extension_settings[MODULE_NAME] = settings;
        saveSettingsDebounced();
        return newSessionId;
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
        if (nested.rawInput && typeof nested.rawInput === 'object') {
            return { ...nested.rawInput };
        }
        return { ...nested };
    }
    return {};
}

async function downloadImageAsBase64(imageUrl) {
    try {
        const response = await fetch(imageUrl, {
            method: 'GET',
            headers: { 'skip_zrok_interstitial': '1' },
        });

        if (!response.ok) {
            throw new Error(`Failed to download image: ${response.status}`);
        }

        const blob = await response.blob();
        const base64 = await getBase64Async(blob);
        return base64.replace(/^data:image\/[a-z]+;base64,/, '');
    } catch (error) {
        console.error('[swarmUI-integration] Error downloading image:', error);
        throw error;
    }
}

// ... [Message helpers: getVisibleMessagesUpTo, getVisibleMessages, isMessageInvisible, etc] ...
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

function getVisibleMessages(chat, count) {
    return getVisibleMessagesUpTo(chat, count, chat.length);
}

function isMessageInvisible(message) {
    return message.is_system || message.extra?.isTemporary || message.extra?.invisible ||
        message.mes === 'Generating image…' || message.mes === 'Generating image...' ||
        message.mes === 'Generating prompt…' || message.mes === 'Generating prompt...';
}

function getLastMessage(chat) {
    if (!Array.isArray(chat) || chat.length === 0) return null;
    const lastMessage = chat[chat.length - 1];
    return lastMessage ? lastMessage.mes || '' : null;
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
        if (prompt) return { identifier: prompt.identifier, content: prompt.content || '', promptData: prompt };
        return null;
    } catch (error) {
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

    if (messages.length > 1) {
        result = result.replace(/{previous_messages}/g, formatMessages(messages.slice(0, -1)));
    } else {
        result = result.replace(/{previous_messages}/g, '');
    }

    if (messages.length > 2) {
        result = result.replace(/{previous_messages2}/g, formatMessages(messages.slice(0, -2)));
    } else {
        result = result.replace(/{previous_messages2}/g, '');
    }

    if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        result = result.replace(/{message_last}/g, `${lastMessage.name}: ${lastMessage.mes}`);
    } else {
        result = result.replace(/{message_last}/g, '');
    }

    if (messages.length > 1) {
        const beforeLastMessage = messages[messages.length - 2];
        result = result.replace(/{message_beforelast}/g, `${beforeLastMessage.name}: ${beforeLastMessage.mes}`);
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
            const lines = processedTemplate.split('\n').filter(line => line.trim());
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

async function addImageMessage(savedImagePath, imagePrompt, messagePrefix = 'Generated image', insertAfterIndex = null) {
    const context = getContext();
    const chat = context.chat;

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

    setTimeout(() => {
        const $chatBlock = $('#chat');
        const $messages = $('.mes');
        if (insertPosition < $messages.length) {
            const $targetMessage = $messages.eq(insertPosition);
            if ($targetMessage.length > 0) {
                $targetMessage[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    }, 200);

    await context.saveChat();
}

async function generateImagePromptFromChat(upToMessageIndex = null, abortController = null) {
    const context = getContext();
    const chat = context.chat;

    if (!Array.isArray(chat) || chat.length === 0) throw new Error('No chat messages to base prompt on.');

    let imagePrompt;

    if (settings.use_raw) {
        const messageCount = settings.message_count ?? 5;
        const visibleMessages = upToMessageIndex !== null
            ? getVisibleMessagesUpTo(chat, messageCount, upToMessageIndex + 1)
            : getVisibleMessages(chat, messageCount);

        if (visibleMessages.length === 0) throw new Error('No visible messages found to base prompt on.');

        const instructionTemplate = settings.llm_prompt || 'Generate a detailed, descriptive prompt for an image generation AI based on this scene: {all_messages}';
        const parsedMessages = parsePromptTemplate(instructionTemplate, visibleMessages);

        let systemPrompt = '';
        let prompt;

        if (parsedMessages.length > 0) {
            const hasSystemMessages = parsedMessages.some(msg => msg.role === 'system');
            if (hasSystemMessages) {
                const firstSystemMessage = parsedMessages.find(msg => msg.role === 'system');
                systemPrompt = firstSystemMessage.content;
                prompt = parsedMessages.filter(msg => msg !== firstSystemMessage);
            } else {
                systemPrompt = '';
                prompt = parsedMessages;
            }
        } else {
            systemPrompt = 'Generate a detailed, descriptive prompt for an image generation AI based on the following conversation.';
            prompt = formatMessages(visibleMessages);
        }

        try {
            if (settings.use_custom_generate_raw === true) {
                imagePrompt = await generateRawWithStops({
                    systemPrompt: systemPrompt,
                    prompt: prompt,
                    prefill: '',
                    stopStrings: ['<|im_end|>', '</s>', '[/INST]', '<|endoftext|>', '<END>'],
                    abortSignal: abortController?.signal
                });
            } else {
                imagePrompt = await generateRaw({
                    systemPrompt: systemPrompt,
                    prompt: prompt,
                    prefill: '',
                    abortSignal: abortController?.signal
                });
            }
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('Generation cancelled by user');
            throw error;
        }
    } else {
        // Quiet prompt logic
        let lastVisibleMessage = '';
        const searchUpTo = upToMessageIndex !== null ? upToMessageIndex + 1 : chat.length;
        for (let i = searchUpTo - 1; i >= 0; i--) {
            if (!isMessageInvisible(chat[i])) {
                lastVisibleMessage = chat[i].mes || '';
                break;
            }
        }

        if (!lastVisibleMessage) throw new Error('No visible messages found to base prompt on.');

        const messageCount = settings.message_count ?? 5;
        const visibleMessages = upToMessageIndex !== null
            ? getVisibleMessagesUpTo(chat, messageCount, upToMessageIndex + 1)
            : getVisibleMessages(chat, messageCount);

        let llmPrompt = settings.llm_prompt || 'Generate a detailed, descriptive prompt for an image generation AI based on this scene: {all_messages}';
        if (/{(all_messages|previous_messages|previous_messages2|message_last|message_beforelast)}/.test(llmPrompt)) {
            llmPrompt = replaceMessageTags(llmPrompt, visibleMessages);
        } else {
            llmPrompt = substituteParams(llmPrompt).replace('{description}', lastVisibleMessage);
        }

        imagePrompt = await generateQuietPrompt(llmPrompt, false, false, abortController?.signal);
    }

    return imagePrompt.replace(/\*/g, "").replace(/\"/g, "").replace(/`/g, "").replace(/_/g, " ")
        .replace(/buttocks/g, "ass").replace(/looking at viewer/g, "eye contact").trim();
}

// MODIFIED: accepts flipDimensions parameter
async function generateAndSaveImage(imagePrompt, savedParamsFromQueue = null, flipDimensions = false) {
    const context = getContext();

    try {
        const sessionId = await validateAndGetSessionId();
        const savedParams = savedParamsFromQueue !== null
            ? savedParamsFromQueue
            : await getSavedT2IParams(sessionId);

        let rawInput = { ...savedParams };

        // IMPLEMENTED: Width/Height Swap Logic
        if (flipDimensions) {
            const width = rawInput.width;
            const height = rawInput.height;
            if (width && height) {
                rawInput.width = height;
                rawInput.height = width;
                console.log(`[swarmUI-integration] Swapped dimensions: ${width}x${height} -> ${rawInput.width}x${rawInput.height}`);
            }
        }

        const cleanPrompt = imagePrompt;
        let finalPrompt = cleanPrompt;

        if (settings.append_prompt && rawInput.prompt) {
            finalPrompt = `${cleanPrompt}, ${rawInput.prompt}`;
        }
        rawInput.prompt = finalPrompt;

        const apiUrl = `${settings.url}/API/GenerateText2Image?skip_zrok_interstitial=1`;
        const requestBody = {
            session_id: sessionId,
            images: rawInput.images ?? 1,
            ...rawInput,
        };

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'skip_zrok_interstitial': '1', ...getRequestHeaders() },
            body: JSON.stringify(requestBody),
            credentials: 'omit',
        });

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                cachedSessionId = null;
                delete settings.cached_session_id;
            }
            throw new Error(`HTTP ${response.status}`);
        }

        const responseText = await response.text();
        let data;
        try {
            data = JSON.parse(responseText);
        } catch {
            throw new Error('Invalid JSON response from server');
        }

        if (!data?.images?.length) throw new Error('No images returned from API');

        let imageUrl = data.images[0];
        if (typeof imageUrl === 'string' && !imageUrl.startsWith('data:') && !imageUrl.startsWith('http')) {
            imageUrl = `${settings.url}/${imageUrl}`;
        }

        const base64Image = await downloadImageAsBase64(imageUrl);
        const characterName = context.characterId !== undefined ? getCharaFilename(context.characterId) : 'unknown';
        const filename = `swarm_${characterName}_${humanizedDateTime()}`;
        const savedImagePath = await saveBase64AsFile(base64Image, characterName, filename, 'png');

        return { savedImagePath: savedImagePath, imagePrompt: cleanPrompt };
    } catch (error) {
        throw new Error(`Image generation failed: ${error.message}`);
    }
}

// --- Menu UI Logic ---

class SwarmMenu {
    constructor(targetElement, messageId) {
        this.target = targetElement;
        this.messageId = messageId;
        this.element = null;
        this.create();
    }

    create() {
        if (activeMenu) {
            activeMenu.destroy();
        }
        activeMenu = this;

        // Create container
        this.element = document.createElement('div');
        this.element.className = 'swarm-popup-menu';

        // Add options
        const options = [
            {
                label: 'Generate Image (LLM)',
                icon: 'fa-wand-magic-sparkles',
                class: 'swarm-item-generate',
                action: () => this.handleAction('generate_image', false)
            },
            {
                label: 'Generate Image (Reverse W/H)',
                icon: 'fa-rotate',
                class: 'swarm-item-generate-rev',
                action: () => this.handleAction('generate_image', true)
            },
            { separator: true },
            {
                label: 'From Message',
                icon: 'fa-image',
                class: 'swarm-item-msg',
                action: () => this.handleAction('generate_from_message', false)
            },
            {
                label: 'From Message (Reverse W/H)',
                icon: 'fa-rotate',
                class: 'swarm-item-msg-rev',
                action: () => this.handleAction('generate_from_message', true)
            },
            { separator: true },
            {
                label: 'Generate Prompt Only',
                icon: 'fa-pen-fancy',
                class: 'swarm-item-prompt',
                action: () => this.handleAction('generate_prompt', false)
            }
        ];

        options.forEach(opt => {
            if (opt.separator) {
                const sep = document.createElement('div');
                sep.className = 'swarm-menu-separator';
                this.element.appendChild(sep);
                return;
            }

            const item = document.createElement('div');
            item.className = `swarm-menu-item ${opt.class}`;
            item.innerHTML = `<i class="fa-solid ${opt.icon}"></i> <span>${opt.label}</span>`;
            item.onclick = (e) => {
                e.stopPropagation();
                opt.action();
                this.destroy();
            };
            this.element.appendChild(item);
        });

        document.body.appendChild(this.element);
        this.position();

        // Close on click outside
        setTimeout(() => {
            document.addEventListener('click', this.closeHandler);
        }, 0);
    }

    position() {
        const rect = this.target.getBoundingClientRect();
        const menuRect = this.element.getBoundingClientRect();

        // Position above by default
        let top = rect.top - menuRect.height - 5;
        let left = rect.left;

        // Check bounds
        if (top < 0) top = rect.bottom + 5; // Flip to bottom if no space top
        if (left + menuRect.width > window.innerWidth) left = window.innerWidth - menuRect.width - 10;

        this.element.style.top = `${top}px`;
        this.element.style.left = `${left}px`;
    }

    async handleAction(type, reverse) {
        if (type === 'generate_image' && settings.show_prompt_modal !== false) {
            // If modal is enabled, handle that flow (ignoring reverse for now or passing it through if we update modal)
            // For now, simpler to bypass modal for quick actions or adapt modal
            // Let's stick to direct queue for the slick menu as per "slick and minimal" request, 
            // OR open modal. Let's open modal for Generate Image if enabled.
            if (type === 'generate_image') {
                if (settings.show_prompt_modal) {
                    try {
                        const imagePrompt = await generateImagePromptFromChat(this.messageId);
                        if (!promptModal) promptModal = new SwarmPromptModal();

                        promptModal.onGenerate = async (finalPrompt) => {
                            await addToQueue(type, this.messageId, finalPrompt, true, reverse);
                            toastr.success('Image generation added to queue');
                        };
                        promptModal.show(imagePrompt, this.messageId);
                    } catch (e) {
                        toastr.error(e.message);
                    }
                    return;
                }
            }
        }

        await addToQueue(type, this.messageId, null, false, reverse);
        toastr.info('Added to queue');
    }

    closeHandler = (e) => {
        if (!this.element.contains(e.target)) {
            this.destroy();
        }
    }

    destroy() {
        if (this.element) {
            this.element.remove();
            this.element = null;
        }
        document.removeEventListener('click', this.closeHandler);
        activeMenu = null;
    }
}

// Modified injection to use single trigger
function injectSwarmUIButtons() {
    $('.extraMesButtons').each(function () {
        const $container = $(this);
        if ($container.find('.swarm_mes_trigger').length > 0) return;

        // Single trigger button
        const trigger = `
            <div title="SwarmUI Actions" class="mes_button swarm_mes_trigger fa-solid fa-wand-magic-sparkles" data-i18n="[title]SwarmUI Actions"></div>
        `;

        const $sdButton = $container.find('.sd_message_gen');
        if ($sdButton.length > 0) {
            $sdButton.after(trigger);
        } else {
            $container.prepend(trigger);
        }
    });
}

function observeForNewMessages() {
    const observer = new MutationObserver(function (mutations) {
        let shouldInject = false;
        mutations.forEach(function (mutation) {
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach(function (node) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        const $node = $(node);
                        if ($node.hasClass('mes') || $node.find('.mes').length > 0) shouldInject = true;
                    }
                });
            }
        });
        if (shouldInject) setTimeout(injectSwarmUIButtons, 50);
    });

    const chatContainer = document.getElementById('chat');
    if (chatContainer) observer.observe(chatContainer, { childList: true, subtree: true });
}

class SwarmPromptModal {
    constructor() {
        this.isVisible = false;
        this.overlay = null;
        this.textarea = null;
        this.onGenerate = null;
        this.currentPrompt = '';
        this.upToMessageIndex = null;
    }
    // ... [Prompt Modal logic remains mostly the same, ensuring it calls callbacks]
    show(prompt, upToMessageIndex = null) {
        if (this.isVisible) this.hide();
        this.currentPrompt = prompt;
        this.upToMessageIndex = upToMessageIndex;
        this.isVisible = true;
        this.overlay = document.createElement('div');
        this.overlay.className = 'swarm-modal-overlay';
        this.overlay.innerHTML = `
            <div class="swarm-modal">
                <div class="swarm-modal-header">
                    <h3 class="swarm-modal-title"><i class="fa-solid fa-wand-magic-sparkles"></i> Review & Edit Prompt</h3>
                    <button class="swarm-modal-close" type="button"><i class="fa-solid fa-times"></i></button>
                </div>
                <div class="swarm-modal-body">
                    <div class="swarm-prompt-info"><i class="fa-solid fa-info-circle"></i> <strong>Generated Prompt:</strong> Review and edit the generated prompt before sending to SwarmUI.</div>
                    <textarea class="swarm-prompt-textarea" spellcheck="false">${prompt}</textarea>
                    <div class="swarm-char-count"><span class="char-count">${prompt.length}</span> characters</div>
                    <div class="swarm-modal-actions">
                        <button class="swarm-btn swarm-btn-warning regenerate-btn"><i class="fa-solid fa-refresh"></i> Regenerate Prompt</button>
                        <button class="swarm-btn swarm-btn-success generate-image-btn"><i class="fa-solid fa-image"></i> Generate Image</button>
                        <button class="swarm-btn swarm-btn-secondary cancel-btn"><i class="fa-solid fa-times"></i> Cancel</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(this.overlay);
        this.bindEvents();
    }
    hide() {
        if (this.overlay) { document.body.removeChild(this.overlay); this.overlay = null; }
        this.isVisible = false;
    }
    bindEvents() {
        const textarea = this.overlay.querySelector('.swarm-prompt-textarea');
        const charCount = this.overlay.querySelector('.char-count');
        const regenerateBtn = this.overlay.querySelector('.regenerate-btn');
        const generateBtn = this.overlay.querySelector('.generate-image-btn');
        const cancelBtn = this.overlay.querySelector('.cancel-btn');
        const closeBtn = this.overlay.querySelector('.swarm-modal-close');

        textarea.addEventListener('input', () => charCount.textContent = textarea.value.length);
        const closeModal = () => this.hide();
        closeBtn.addEventListener('click', closeModal);
        cancelBtn.addEventListener('click', closeModal);

        regenerateBtn.addEventListener('click', async () => {
            regenerateBtn.disabled = true;
            regenerateBtn.innerHTML = '<span class="swarm-loading-spinner"></span> Regenerating...';
            try {
                const newPrompt = await generateImagePromptFromChat(this.upToMessageIndex);
                textarea.value = newPrompt;
                charCount.textContent = newPrompt.length;
            } catch (error) { toastr.error(error.message); }
            finally { regenerateBtn.disabled = false; regenerateBtn.innerHTML = '<i class="fa-solid fa-refresh"></i> Regenerate Prompt'; }
        });

        generateBtn.addEventListener('click', async () => {
            const finalPrompt = textarea.value.trim();
            if (!finalPrompt) return toastr.error('Empty prompt');
            this.hide();
            if (this.onGenerate) await this.onGenerate(finalPrompt);
        });
    }
}

jQuery(async () => {
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(settingsHtml);
        $("#swarm_settings input, #swarm_settings textarea").on("input", onInput);

        const buttonHtml = await $.get(`${extensionFolderPath}/button.html`);
        $("#send_but").before(buttonHtml);

        const queueHtml = `
            <div id="swarm_queue_widget" style="display: none;">
                <div class="swarm-queue-header" id="swarm_queue_header">
                    <div class="swarm-queue-title"><i class="fa-solid fa-list"></i> <span class="queue-count">0</span></div>
                    <div class="swarm-queue-controls">
                        <button id="swarm_toggle_queue" class="swarm-queue-btn"><i class="fa-solid fa-chevron-up"></i></button>
                        <button id="swarm_clear_queue" class="swarm-queue-btn"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
                <div id="swarm_queue_list" class="swarm-queue-body"></div>
            </div>`;
        $("body").append(queueHtml);

        // Main input area trigger
        $("#swarm_main_trigger").on("click", function (e) {
            e.stopPropagation();
            const context = getContext();
            const latestMessageIndex = context.chat.length - 1;
            new SwarmMenu(this, latestMessageIndex);
        });

        // Chat message triggers
        $(document).on('click', '.swarm_mes_trigger', function (e) {
            e.stopPropagation();
            const $mes = $(this).closest('.mes');
            const messageId = parseInt($mes.attr('mesid'));
            new SwarmMenu(this, messageId);
        });

        $(document).on('click', '.swarm-queue-remove', (e) => {
            removeFromQueue(parseFloat($(e.target).closest('.swarm-queue-remove').data('item-id')));
        });
        $(document).on('click', '.swarm-queue-cancel', (e) => {
            cancelQueueItem(parseFloat($(e.target).closest('.swarm-queue-cancel').data('item-id')));
        });
        $('#swarm_clear_queue').on('click', () => { imageGenerationQueue.length = 0; updateQueueDisplay(); });
        $('#swarm_toggle_queue').on('click', function () {
            $('#swarm_queue_list').toggle();
            $(this).find('i').toggleClass('fa-chevron-up fa-chevron-down');
        });

        makeQueueWidgetDraggable();
        setTimeout(injectSwarmUIButtons, 100);
        observeForNewMessages();
        eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(injectSwarmUIButtons, 100));

        await loadSettings();
        console.log('[swarmUI-integration] Extension initialized successfully with slick menu');
    } catch (error) {
        console.error('[swarmUI-integration] Failed to initialize:', error);
    }
});