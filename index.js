import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders, substituteParams } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
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

class QueueItem {
    constructor(type, messageIndex, prompt = null, customPrompt = false, savedParams = null) {
        this.id = Date.now() + Math.random();
        this.type = type;
        this.messageIndex = messageIndex;
        this.originalMessageId = null; // Store original message ID for tracking
        this.prompt = prompt;
        this.customPrompt = customPrompt;
        this.status = 'pending';
        this.error = null;
        this.createdAt = Date.now();
        this.savedParams = savedParams; // Store parameters at queue time

        // Store the original message ID if we have a valid message index
        if (messageIndex !== null && messageIndex >= 0) {
            const context = getContext();
            const chat = context.chat;
            if (messageIndex < chat.length && chat[messageIndex]) {
                // Create a unique identifier for the message based on content and timestamp
                this.originalMessageId = this.createMessageId(chat[messageIndex]);
            }
        }
    }

    createMessageId(message) {
        // Create a unique ID based on message content, name, and timestamp
        const content = (message.mes || '').substring(0, 50);
        const name = message.name || '';
        const date = message.sendDate || message.send_date || Date.now();
        return `${name}_${date}_${content.length}_${content.substring(0, 10)}`;
    }

    // Find the current index of the original message
    getCurrentMessageIndex() {
        if (this.originalMessageId === null) {
            return this.messageIndex;
        }

        const context = getContext();
        const chat = context.chat;

        // Search for the message with matching ID
        for (let i = 0; i < chat.length; i++) {
            if (this.createMessageId(chat[i]) === this.originalMessageId) {
                return i;
            }
        }

        // Fallback to original index if not found
        return this.messageIndex;
    }
}

async function addToQueue(type, messageIndex = null, prompt = null, customPrompt = false) {
    // Fetch parameters NOW, when adding to queue
    let savedParams = null;
    try {
        const sessionId = await validateAndGetSessionId();
        savedParams = await getSavedT2IParams(sessionId);
    } catch (error) {
        console.warn('[swarmUI-integration] Failed to fetch parameters for queue item:', error);
        // Continue anyway - generateAndSaveImage will fetch them if null
    }

    const queueItem = new QueueItem(type, messageIndex, prompt, customPrompt);
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

    imageGenerationQueue.forEach((item, index) => {
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
            'error': 'fa-times text-danger'
        }[item.status];

        const typeIcon = {
            'generate_image': 'fa-wand-magic-sparkles',
            'generate_prompt': 'fa-pen-fancy',
            'generate_from_message': 'fa-image'
        }[item.type];

        const queueItemHtml = `
            <div class="swarm-queue-item" data-item-id="${item.id}">
                <div class="swarm-queue-item-header">
                    <div class="swarm-queue-icons">
                        <i class="fa-solid ${statusIcon}"></i>
                        <i class="fa-solid ${typeIcon}"></i>
                    </div>
                    ${item.status === 'pending' ?
                `<button class="swarm-queue-remove" data-item-id="${item.id}" title="Remove">
                            <i class="fa-solid fa-times"></i>
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
            updateQueueStatus(item.id, 'completed');

            setTimeout(() => {
                removeFromQueue(item.id);
            }, 2000);

        } catch (error) {
            console.error(`[swarmUI-integration] Queue item ${item.id} failed:`, error);
            updateQueueStatus(item.id, 'error', error.message);

            setTimeout(() => {
                removeFromQueue(item.id);
            }, 5000);
        }

        await new Promise(resolve => setTimeout(resolve, 100));
    }

    queueProcessorRunning = false;
}

async function processQueueItem(item) {
    const context = getContext();
    const chat = context.chat;

    // Get the current message index (accounting for any shifts)
    const currentMessageIndex = item.getCurrentMessageIndex();

    if (currentMessageIndex !== null && (currentMessageIndex < 0 || currentMessageIndex >= chat.length)) {
        throw new Error(`Invalid message index: ${currentMessageIndex}. Chat has ${chat.length} messages.`);
    }

    switch (item.type) {
        case 'generate_image': {
            let imagePrompt;

            if (item.customPrompt) {
                imagePrompt = item.prompt;
            } else {
                imagePrompt = await generateImagePromptFromChat(currentMessageIndex);
            }

            const result = await generateAndSaveImage(imagePrompt, item.savedParams);

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
            const imagePrompt = await generateImagePromptFromChat(currentMessageIndex);

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
            const result = await generateAndSaveImage(imagePrompt, item.savedParams);

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

export function getCustomModel() {
    if (!settings.custom_model) {
        return '';
    }
    return String(settings.custom_model);
}

export function getCustomParameters() {
    if (!settings.custom_parameters) {
        return '';
    }
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
        { id: '#swarm_message_count', key: 'message_count', defaultValue: 5 }
    ];

    settingMappings.forEach(mapping => {
        $(mapping.id).val(settings[mapping.key] || mapping.defaultValue).trigger('input');
    });

    $('#swarm_append_prompt').prop('checked', !!settings.append_prompt).trigger('input');
    $('#swarm_use_raw').prop('checked', !!settings.use_raw).trigger('input');
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
        // Allow 0 or any positive number, default to 5 if invalid
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
        headers: {
            'Content-Type': 'application/json',
            'skip_zrok_interstitial': '1',
            ...getRequestHeaders(),
        },
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

        console.log(`[swarmUI-integration] Created new session ID: ${newSessionId}`);
        return newSessionId;
    } catch (error) {
        console.error('[swarmUI-integration] Failed to create new session:', error);
        throw error;
    }
}

async function validateAndGetSessionId() {
    let sessionId = await getSessionId();

    try {
        await getSavedT2IParams(sessionId);
        return sessionId;
    } catch (error) {
        console.warn(`[swarmUI-integration] Session ${sessionId} appears invalid, creating new one:`, error);

        cachedSessionId = null;
        delete settings.cached_session_id;

        try {
            const newSessionId = await createNewSession();
            cachedSessionId = newSessionId;
            settings.cached_session_id = newSessionId;
            extension_settings[MODULE_NAME] = settings;
            saveSettingsDebounced();

            console.log(`[swarmUI-integration] Created replacement session ID: ${newSessionId}`);
            return newSessionId;
        } catch (createError) {
            console.error('[swarmUI-integration] Failed to create replacement session:', createError);
            throw createError;
        }
    }
}

async function getSavedT2IParams(sessionId) {
    const url = `${settings.url}/API/GetSavedT2IParams?skip_zrok_interstitial=1`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'skip_zrok_interstitial': '1',
            ...getRequestHeaders(),
        },
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

function getVisibleMessagesUpTo(chat, count, upToIndex = chat.length) {
    const visibleMessages = [];
    const endIndex = Math.min(upToIndex, chat.length);

    // If count is 0, include all visible messages
    const maxMessages = count === 0 ? Infinity : count;

    for (let i = endIndex - 1; i >= 0 && visibleMessages.length < maxMessages; i--) {
        const message = chat[i];

        if (isMessageInvisible(message)) {
            continue;
        }

        visibleMessages.unshift({
            name: message.name,
            mes: message.mes
        });
    }

    return visibleMessages;
}

function getVisibleMessages(chat, count) {
    return getVisibleMessagesUpTo(chat, count, chat.length);
}

function isMessageInvisible(message) {
    return message.is_system ||
        message.extra?.isTemporary ||
        message.extra?.invisible ||
        message.mes === 'Generating image…' ||
        message.mes === 'Generating image...' ||
        message.mes === 'Generating prompt…' ||
        message.mes === 'Generating prompt...';
}

function getLastMessage(chat) {
    if (!Array.isArray(chat) || chat.length === 0) {
        return null;
    }
    const lastMessage = chat[chat.length - 1];
    return lastMessage ? lastMessage.mes || '' : null;
}

function getMessageAtIndex(chat, index) {
    if (!Array.isArray(chat) || index < 0 || index >= chat.length) {
        return null;
    }
    const message = chat[index];
    return message ? message.mes || '' : null;
}

function formatMessages(messages) {
    return messages.map(msg => `${msg.name}: ${msg.mes}`).join('\n\n');
}

function replaceMessageTags(template, messages) {
    let result = template;

    result = result.replace(/{all_messages}/g, formatMessages(messages));
    result = result.replace(/{description}/g, formatMessages(messages));

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
        const role = match[1];
        const content = match[2].trim();

        parsedMessages.push({
            role: role,
            content: content
        });
    }

    if (!hasStructuredMessages) {
        const hasMessageTags = /{(all_messages|previous_messages|previous_messages2|message_last|message_beforelast|description)}/.test(processedTemplate);

        if (hasMessageTags) {
            const lines = processedTemplate.split('\n').filter(line => line.trim());
            if (lines.length > 1) {
                parsedMessages.push({
                    role: 'system',
                    content: lines[0]
                });
                parsedMessages.push({
                    role: 'user',
                    content: lines.slice(1).join('\n')
                });
            } else {
                parsedMessages.push({
                    role: 'user',
                    content: processedTemplate
                });
            }
        } else {
            parsedMessages.push({
                role: 'system',
                content: processedTemplate || 'Generate a detailed, descriptive prompt for an image generation AI based on the following conversation.'
            });
            parsedMessages.push({
                role: 'user',
                content: formatMessages(messages)
            });
        }
    }

    return parsedMessages;
}

async function addImageMessage(savedImagePath, imagePrompt, messagePrefix = 'Generated image', insertAfterIndex = null) {
    const context = getContext();
    const chat = context.chat;

    if (insertAfterIndex === null || insertAfterIndex < 0 || insertAfterIndex >= chat.length) {
        console.warn('[swarmUI-integration] Invalid insert index, appending to end');
        insertAfterIndex = chat.length - 1;
    }

    const imageMessage = {
        name: context.name2 || 'System',
        is_system: true,
        mes: `${messagePrefix}: ${imagePrompt}`,
        sendDate: Date.now(),
        extra: {
            image: savedImagePath,
            title: imagePrompt
        },
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

    // Scroll to the newly generated image message
    setTimeout(() => {
        const $chatBlock = $('#chat');
        const $messages = $('.mes');

        // Find the message at the insert position (the newly added image)
        if (insertPosition < $messages.length) {
            const $targetMessage = $messages.eq(insertPosition);
            if ($targetMessage.length > 0) {
                // Scroll to the image message
                $targetMessage[0].scrollIntoView({
                    behavior: 'smooth',
                    block: 'center'
                });
            }
        }
    }, 200);

    await context.saveChat();

}

async function generateImagePromptFromChat(upToMessageIndex = null) {
    const context = getContext();
    const chat = context.chat;

    if (!Array.isArray(chat) || chat.length === 0) {
        throw new Error('No chat messages to base prompt on.');
    }

    let imagePrompt;

    if (settings.use_raw) {
        const messageCount = settings.message_count ?? 5;
        const visibleMessages = upToMessageIndex !== null
            ? getVisibleMessagesUpTo(chat, messageCount, upToMessageIndex + 1)
            : getVisibleMessages(chat, messageCount);

        if (visibleMessages.length === 0) {
            throw new Error('No visible messages found to base prompt on.');
        }

        const instructionTemplate = settings.llm_prompt || 'Generate a detailed, descriptive prompt for an image generation AI based on this scene: {all_messages}';
        const parsedMessages = parsePromptTemplate(instructionTemplate, visibleMessages);

        let systemPrompt = '';
        let prompt;

        if (parsedMessages.length > 0) {
            const hasSystemMessages = parsedMessages.some(msg => msg.role === 'system');

            if (hasSystemMessages) {
                const firstSystemMessage = parsedMessages.find(msg => msg.role === 'system');
                systemPrompt = firstSystemMessage.content;

                const chatMessages = [];
                let firstSystemFound = false;

                for (const msg of parsedMessages) {
                    if (msg.role === 'system' && !firstSystemFound) {
                        firstSystemFound = true;
                        continue;
                    }

                    chatMessages.push({
                        role: msg.role,
                        content: msg.content
                    });
                }

                prompt = chatMessages;
            } else {
                systemPrompt = '';
                prompt = parsedMessages.map(msg => ({
                    role: msg.role,
                    content: msg.content
                }));
            }
        } else {
            systemPrompt = 'Generate a detailed, descriptive prompt for an image generation AI based on the following conversation.';
            prompt = formatMessages(visibleMessages);
        }

        try {
            if (settings.use_custom_generate_raw === true) {
                const result = await generateRawWithStops({
                    systemPrompt: systemPrompt,
                    prompt: prompt,
                    prefill: '',
                    stopStrings: [
                        '<|im_end|>',
                        '</s>',
                        '[/INST]',
                        '<|endoftext|>',
                        '<END>'
                    ],
                });
                console.log('[swarmUI-integration] generateRawWithStops result:', result);
                imagePrompt = result;
            }
            else {
                const result = await generateRaw({
                    systemPrompt: systemPrompt,
                    prompt: prompt,
                    prefill: ''
                });
                console.log('[swarmUI-integration] generateRaw result:', result);
                imagePrompt = result;
            }
        } catch (error) {
            const methodName = settings.use_custom_generate_raw ? "generateRawWithStops" : "generateRaw";
            console.error(`[swarmUI-integration] ${methodName} failed:`, error);
            throw error;
        }
    } else {
        let lastVisibleMessage = '';
        const searchUpTo = upToMessageIndex !== null ? upToMessageIndex + 1 : chat.length;

        for (let i = searchUpTo - 1; i >= 0; i--) {
            const message = chat[i];

            if (isMessageInvisible(message)) {
                continue;
            }

            lastVisibleMessage = message.mes || '';
            break;
        }

        if (!lastVisibleMessage) {
            throw new Error('No visible messages found to base prompt on.');
        }

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

        imagePrompt = await generateQuietPrompt(llmPrompt);
    }

    imagePrompt = imagePrompt
        .replace(/\*/g, "")
        .replace(/\"/g, "")
        .replace(/`/g, "")
        .replace(/_/g, " ")
        .replace(/buttocks/g, "ass")
        .replace(/looking at viewer/g, "eye contact")
        .trim();

    return imagePrompt;
}

async function generateAndSaveImage(imagePrompt, savedParamsFromQueue = null) {
    const context = getContext();

    try {
        const sessionId = await validateAndGetSessionId();

        // Use parameters from queue if available, otherwise fetch fresh ones
        const savedParams = savedParamsFromQueue !== null
            ? savedParamsFromQueue
            : await getSavedT2IParams(sessionId);

        let rawInput = { ...savedParams };

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
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'skip_zrok_interstitial': '1',
                ...getRequestHeaders(),
            },
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
            console.error('[swarmUI-integration] Invalid JSON response:', responseText);
            throw new Error('Invalid JSON response from server');
        }

        if (!data?.images?.length) {
            throw new Error('No images returned from API');
        }

        let imageUrl = data.images[0];
        if (typeof imageUrl === 'string' && !imageUrl.startsWith('data:') && !imageUrl.startsWith('http')) {
            imageUrl = `${settings.url}/${imageUrl}`;
        }

        const base64Image = await downloadImageAsBase64(imageUrl);

        const characterName = context.characterId !== undefined ?
            getCharaFilename(context.characterId) : 'unknown';

        const filename = `swarm_${characterName}_${humanizedDateTime()}`;
        const savedImagePath = await saveBase64AsFile(base64Image, characterName, filename, 'png');

        return {
            savedImagePath: savedImagePath,
            imagePrompt: cleanPrompt
        };
    } catch (error) {
        throw new Error(`Image generation failed: ${error.message}`);
    }
}

async function swarmMessageGenerateImage(e) {
    const $icon = $(e.currentTarget);
    const $mes = $icon.closest('.mes');
    const messageId = parseInt($mes.attr('mesid'));

    if (settings.show_prompt_modal !== false) {
        swarmMessageGenerateImageWithModal(e);
    } else {
        await addToQueue('generate_image', messageId);
        toastr.info('Image generation added to queue');
    }
}

async function swarmMessageGeneratePrompt(e) {
    const $icon = $(e.currentTarget);
    const $mes = $icon.closest('.mes');
    const messageId = parseInt($mes.attr('mesid'));

    await addToQueue('generate_prompt', messageId);
    toastr.info('Prompt generation added to queue');
}

async function swarmMessageGenerateFromMessage(e) {
    const $icon = $(e.currentTarget);
    const $mes = $icon.closest('.mes');
    const messageId = parseInt($mes.attr('mesid'));

    await addToQueue('generate_from_message', messageId);
    toastr.info('Image generation from message added to queue');
}

function injectSwarmUIButtons() {
    $('.extraMesButtons').each(function () {
        const $container = $(this);

        if ($container.find('.swarm_mes_button').length > 0) {
            return;
        }

        const swarmButtons = `
            <div title="SwarmUI: Generate Image (LLM Prompt)" class="mes_button swarm_mes_button swarm_mes_gen_image fa-solid fa-wand-magic-sparkles" data-i18n="[title]SwarmUI: Generate Image (LLM Prompt)"></div>
            <div title="SwarmUI: Generate Prompt Only" class="mes_button swarm_mes_button swarm_mes_gen_prompt fa-solid fa-pen-fancy" data-i18n="[title]SwarmUI: Generate Prompt Only"></div>
            <div title="SwarmUI: Generate Image from Message" class="mes_button swarm_mes_button swarm_mes_gen_from_msg fa-solid fa-image" data-i18n="[title]SwarmUI: Generate Image from Message"></div>
        `;

        const $sdButton = $container.find('.sd_message_gen');
        if ($sdButton.length > 0) {
            $sdButton.after(swarmButtons);
        } else {
            $container.prepend(swarmButtons);
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
                        if ($node.hasClass('mes') || $node.find('.mes').length > 0) {
                            shouldInject = true;
                        }
                    }
                });
            }
        });

        if (shouldInject) {
            setTimeout(injectSwarmUIButtons, 50);
        }
    });

    const chatContainer = document.getElementById('chat');
    if (chatContainer) {
        observer.observe(chatContainer, {
            childList: true,
            subtree: true
        });
    }
}

class SwarmPromptModal {
    constructor() {
        this.isVisible = false;
        this.overlay = null;
        this.textarea = null;
        this.onGenerate = null;
        this.onCancel = null;
        this.currentPrompt = '';
        this.upToMessageIndex = null;
    }

    show(prompt, upToMessageIndex = null) {
        if (this.isVisible) {
            this.hide();
        }

        this.currentPrompt = prompt;
        this.upToMessageIndex = upToMessageIndex;
        this.isVisible = true;

        this.overlay = document.createElement('div');
        this.overlay.className = 'swarm-modal-overlay';

        this.overlay.innerHTML = `
            <div class="swarm-modal">
                <div class="swarm-modal-header">
                    <h3 class="swarm-modal-title">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> 
                        Review & Edit Prompt
                    </h3>
                    <button class="swarm-modal-close" type="button">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
                
                <div class="swarm-modal-body">
                    <div class="swarm-prompt-info">
                        <i class="fa-solid fa-info-circle"></i>
                        <strong>Generated Prompt:</strong> Review and edit the generated prompt before sending to SwarmUI. You can regenerate it or proceed with the current version.
                    </div>

                    <textarea 
                        class="swarm-prompt-textarea" 
                        placeholder="Generated prompt will appear here..."
                        spellcheck="false"
                    >${prompt}</textarea>
                    
                    <div class="swarm-char-count">
                        <span class="char-count">${prompt.length}</span> characters
                    </div>

                    <div class="swarm-modal-actions">
                        <button class="swarm-btn swarm-btn-warning regenerate-btn">
                            <i class="fa-solid fa-refresh"></i>
                            Regenerate Prompt
                        </button>
                        
                        <button class="swarm-btn swarm-btn-success generate-image-btn">
                            <i class="fa-solid fa-image"></i>
                            Generate Image
                        </button>
                        
                        <button class="swarm-btn swarm-btn-secondary cancel-btn">
                            <i class="fa-solid fa-times"></i>
                            Cancel
                        </button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(this.overlay);
        this.bindEvents();

        setTimeout(() => {
            this.textarea = this.overlay.querySelector('.swarm-prompt-textarea');
            this.textarea.focus();
            this.textarea.select();
        }, 100);
    }

    hide() {
        if (this.overlay) {
            document.body.removeChild(this.overlay);
            this.overlay = null;
        }
        this.isVisible = false;
        this.textarea = null;
    }

    bindEvents() {
        const textarea = this.overlay.querySelector('.swarm-prompt-textarea');
        const charCount = this.overlay.querySelector('.char-count');
        const regenerateBtn = this.overlay.querySelector('.regenerate-btn');
        const generateBtn = this.overlay.querySelector('.generate-image-btn');
        const cancelBtn = this.overlay.querySelector('.cancel-btn');
        const closeBtn = this.overlay.querySelector('.swarm-modal-close');

        const updateCharCount = () => {
            charCount.textContent = textarea.value.length;
        };

        textarea.addEventListener('input', updateCharCount);

        const closeModal = () => {
            this.hide();
            if (this.onCancel) this.onCancel();
        };

        closeBtn.addEventListener('click', closeModal);
        cancelBtn.addEventListener('click', closeModal);

        const handleEsc = (e) => {
            if (e.key === 'Escape' && this.isVisible) {
                closeModal();
                document.removeEventListener('keydown', handleEsc);
            }
        };
        document.addEventListener('keydown', handleEsc);

        regenerateBtn.addEventListener('click', async () => {
            if (regenerateBtn.disabled) return;

            regenerateBtn.disabled = true;
            regenerateBtn.innerHTML = '<span class="swarm-loading-spinner"></span> Regenerating...';

            try {
                const newPrompt = await generateImagePromptFromChat(this.upToMessageIndex);
                textarea.value = newPrompt;
                this.currentPrompt = newPrompt;
                updateCharCount();
                toastr.success('Prompt regenerated successfully!');
            } catch (error) {
                console.error('[swarmUI-integration] Failed to regenerate prompt:', error);
                toastr.error(`Failed to regenerate prompt: ${error.message}`);
            } finally {
                regenerateBtn.disabled = false;
                regenerateBtn.innerHTML = '<i class="fa-solid fa-refresh"></i> Regenerate Prompt';
            }
        });

        generateBtn.addEventListener('click', async () => {
            if (generateBtn.disabled) return;

            const finalPrompt = textarea.value.trim();
            if (!finalPrompt) {
                toastr.error('Please enter a prompt before generating.');
                textarea.focus();
                return;
            }

            generateBtn.disabled = true;
            generateBtn.innerHTML = '<span class="swarm-loading-spinner"></span> Adding to Queue...';

            try {
                this.hide();

                if (this.onGenerate) {
                    await this.onGenerate(finalPrompt);
                }
            } catch (error) {
                console.error('[swarmUI-integration] Failed to add to queue:', error);
                toastr.error(`Failed to add to queue: ${error.message}`);
                generateBtn.disabled = false;
                generateBtn.innerHTML = '<i class="fa-solid fa-image"></i> Generate Image';
            }
        });
    }
}

async function generateImageWithModal(upToMessageIndex = null) {
    try {
        const imagePrompt = await generateImagePromptFromChat(upToMessageIndex);

        if (!promptModal) {
            promptModal = new SwarmPromptModal();
        }

        promptModal.onGenerate = async (finalPrompt) => {
            await addToQueue('generate_image', upToMessageIndex, finalPrompt, true);
            toastr.success('Custom prompt image generation added to queue');
        };

        promptModal.onCancel = () => {
            console.log('Modal cancelled');
        };

        promptModal.show(imagePrompt, upToMessageIndex);
    } catch (error) {
        console.error('[swarmUI-integration] Failed to generate initial prompt:', error);
        toastr.error(`Failed to generate prompt: ${error.message}`);
    }
}

async function swarmMessageGenerateImageWithModal(e) {
    const $icon = $(e.currentTarget);
    const $mes = $icon.closest('.mes');
    const messageId = parseInt($mes.attr('mesid'));

    try {
        const imagePrompt = await generateImagePromptFromChat(messageId);

        if (!promptModal) {
            promptModal = new SwarmPromptModal();
        }

        promptModal.onGenerate = async (finalPrompt) => {
            await addToQueue('generate_image', messageId, finalPrompt, true);
            toastr.success('Custom prompt image generation added to queue');
        };

        promptModal.onCancel = () => {
            console.log('Modal cancelled');
        };

        promptModal.show(imagePrompt, messageId);

    } catch (error) {
        console.error('[swarmUI-integration] Failed to generate initial prompt:', error);
        toastr.error(`Failed to generate prompt: ${error.message}`);
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
                    <div class="swarm-queue-title">
                        <i class="fa-solid fa-list"></i>
                        <span class="queue-count">0</span>
                    </div>
                    <div class="swarm-queue-controls">
                        <button id="swarm_toggle_queue" class="swarm-queue-btn" title="Toggle Queue">
                            <i class="fa-solid fa-chevron-up"></i>
                        </button>
                        <button id="swarm_clear_queue" class="swarm-queue-btn" title="Clear Queue">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>
                <div id="swarm_queue_list" class="swarm-queue-body"></div>
            </div>
        `;
        $("body").append(queueHtml);

        $("#swarm_generate_button").on("click", async () => {
            const context = getContext();
            const latestMessageIndex = context.chat.length - 1;

            if (settings.show_prompt_modal !== false) {
                generateImageWithModal(latestMessageIndex);
            } else {
                await addToQueue('generate_image', latestMessageIndex);
                toastr.info('Image generation added to queue');
            }
        });

        $("#swarm_generate_prompt_button").on("click", async () => {
            const context = getContext();
            const latestMessageIndex = context.chat.length - 1;
            await addToQueue('generate_prompt', latestMessageIndex);
            toastr.info('Prompt generation added to queue');
        });

        $("#swarm_generate_from_message_button").on("click", async () => {
            const context = getContext();
            const latestMessageIndex = context.chat.length - 1;
            await addToQueue('generate_from_message', latestMessageIndex);
            toastr.info('Image generation from message added to queue');
        });

        $(document).on('click', '.swarm_mes_gen_image', swarmMessageGenerateImage);
        $(document).on('click', '.swarm_mes_gen_prompt', swarmMessageGeneratePrompt);
        $(document).on('click', '.swarm_mes_gen_from_msg', swarmMessageGenerateFromMessage);

        $(document).on('click', '.swarm-queue-remove', (e) => {
            const itemId = parseFloat($(e.target).closest('.swarm-queue-remove').data('item-id'));
            removeFromQueue(itemId);
            toastr.info('Item removed from queue');
        });

        $('#swarm_clear_queue').on('click', () => {
            imageGenerationQueue.length = 0;
            updateQueueDisplay();
            toastr.info('Queue cleared');
        });

        $('#swarm_toggle_queue').on('click', () => {
            const $queueBody = $('#swarm_queue_list');
            const $toggleBtn = $('#swarm_toggle_queue i');

            if ($queueBody.is(':visible')) {
                $queueBody.hide();
                $toggleBtn.removeClass('fa-chevron-up').addClass('fa-chevron-down');
            } else {
                $queueBody.show();
                $toggleBtn.removeClass('fa-chevron-down').addClass('fa-chevron-up');
            }
        });

        makeQueueWidgetDraggable();

        setTimeout(injectSwarmUIButtons, 100);
        observeForNewMessages();

        eventSource.on(event_types.CHAT_CHANGED, () => {
            setTimeout(injectSwarmUIButtons, 100);
        });

        await loadSettings();

        console.log('[swarmUI-integration] Extension initialized successfully with queue system');
    } catch (error) {
        console.error('[swarmUI-integration] Failed to initialize extension:', error);
    }
});