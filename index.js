import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders, substituteParams } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { generateQuietPrompt, generateRaw } from '../../../../script.js';
import { debounce_timeout } from '../../../constants.js';
import { saveBase64AsFile, getBase64Async, getCharaFilename } from '../../../utils.js';
import { humanizedDateTime } from '../../../RossAscends-mods.js';
import { generateRawWithStops } from './src/custom.js';

const MODULE_NAME = 'swarmui-integration';
const extensionFolderPath = `scripts/extensions/third-party/${MODULE_NAME}`;

// Global state variables
let settings = {};
let generatingMessageId = null;
let cachedSessionId = null;
let mainButtonsBusy = false;
let promptModal = null;

// ===== NOTIFICATION & UI HELPERS =====

/**
 * Play notification sound when image generation completes
 */
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

/**
 * Update button states to show busy/loading indicators
 * @param {boolean} isBusy - Whether buttons should show busy state
 */
function setMainButtonsBusy(isBusy) {
    mainButtonsBusy = isBusy;

    // Update main control buttons
    const buttonConfigs = [
        { selector: '#swarm_generate_button', busyIcon: 'fa-hourglass-half', normalIcon: 'fa-wand-magic-sparkles' },
        { selector: '#swarm_generate_prompt_button', busyIcon: 'fa-hourglass-half', normalIcon: 'fa-pen-fancy' },
        { selector: '#swarm_generate_from_message_button', busyIcon: 'fa-hourglass-half', normalIcon: 'fa-image' }
    ];

    buttonConfigs.forEach(config => {
        $(`${config.selector} i`).toggleClass(config.normalIcon, !isBusy);
        $(`${config.selector} i`).toggleClass(config.busyIcon, isBusy);
    });
}

/**
 * Update individual message action button icon states
 * @param {jQuery} $icon - The icon element to update
 * @param {boolean} isBusy - Whether to show busy state
 * @param {string} originalClass - The original icon class
 */
function setBusyIcon($icon, isBusy, originalClass) {
    $icon.toggleClass(originalClass, !isBusy);
    $icon.toggleClass('fa-hourglass-half', isBusy);
}

// ===== SETTINGS MANAGEMENT =====

/**
 * Get custom model setting (exported for external use)
 * @returns {string} The custom model name or empty string
 */
export function getCustomModel() {
    if (!settings.custom_model) {
        return '';
    }
    return String(settings.custom_model);
}

/**
 * Load extension settings from storage and populate UI controls
 */
async function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    settings = extension_settings[MODULE_NAME];

    // Populate UI controls with current settings
    const settingMappings = [
        { id: '#swarm_url', key: 'url', defaultValue: 'http://localhost:7801' },
        { id: '#swarm_session_id', key: 'session_id', defaultValue: '' },
        { id: '#swarm_llm_prompt', key: 'llm_prompt', defaultValue: 'Generate a detailed, descriptive prompt for an image generation AI based on this scene: {all_messages}' },
        { id: '#swarm_custom_model', key: 'custom_model', defaultValue: '' },
        { id: '#swarm_message_count', key: 'message_count', defaultValue: 5 }
    ];

    settingMappings.forEach(mapping => {
        $(mapping.id).val(settings[mapping.key] || mapping.defaultValue).trigger('input');
    });

    // Handle checkbox settings
    $('#swarm_append_prompt').prop('checked', !!settings.append_prompt).trigger('input');
    $('#swarm_use_raw').prop('checked', !!settings.use_raw).trigger('input');
    $('#swarm_use_custom_generate_raw').prop('checked', !!settings.use_custom_generate_raw).trigger('input');
    $('#swarm_show_prompt_modal').prop('checked', !!settings.show_prompt_modal).trigger('input');

    // Load cached session ID if it exists in settings
    cachedSessionId = settings.cached_session_id || null;
}

/**
 * Handle input changes and save settings
 * @param {Event} event - The input change event
 */
function onInput(event) {
    const id = event.target.id.replace('swarm_', '');

    if (id === 'append_prompt' || id === 'use_raw' || id === 'show_prompt_modal' || id === 'use_custom_generate_raw') {
        settings[id] = $(event.target).prop('checked');
    } else if (id === 'message_count') {
        settings[id] = parseInt($(event.target).val()) || 5;
    } else {
        settings[id] = $(event.target).val();
    }

    extension_settings[MODULE_NAME] = settings;
    saveSettingsDebounced();

    // Clear cached session if URL changes
    if (id === 'url') {
        cachedSessionId = null;
        delete settings.cached_session_id;
    }
}

// ===== SWARMUI API HELPERS =====

/**
 * Create a new SwarmUI session
 * @returns {Promise<string>} The new session ID
 */
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

/**
 * Get session ID (manual, cached, or create new)
 * @returns {Promise<string>} A valid session ID
 */
async function getSessionId() {
    // Priority: manual session ID > cached session ID > create new
    if (settings.session_id && settings.session_id.trim()) {
        return settings.session_id.trim();
    }

    if (cachedSessionId) {
        return cachedSessionId;
    }

    // Create new session and cache it
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

/**
 * Validate session and get a working session ID
 * @returns {Promise<string>} A validated session ID
 */
async function validateAndGetSessionId() {
    let sessionId = await getSessionId();

    // Test the session ID by trying to get saved params
    try {
        await getSavedT2IParams(sessionId);
        return sessionId; // Session is valid
    } catch (error) {
        console.warn(`[swarmUI-integration] Session ${sessionId} appears invalid, creating new one:`, error);

        // Clear cached session and create new one
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

/**
 * Get the last saved T2I parameters from SwarmUI
 * Handles the nested shape: { rawInput: { rawInput: {...}, *saved*at: "..." } }
 * @param {string} sessionId - The session ID to use
 * @returns {Promise<Object>} The saved parameters object
 */
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

/**
 * Download image from URL and convert to base64
 * @param {string} imageUrl - The URL of the image to download
 * @returns {Promise<string>} Base64 encoded image data
 */
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

        // Remove the data URL prefix to get just the base64 string
        return base64.replace(/^data:image\/[a-z]+;base64,/, '');
    } catch (error) {
        console.error('[swarmUI-integration] Error downloading image:', error);
        throw error;
    }
}

// ===== MESSAGE PROCESSING HELPERS =====

/**
 * Get visible messages from chat up to a specific index
 * @param {Array} chat - The chat array
 * @param {number} count - Number of messages to retrieve
 * @param {number} upToIndex - Maximum index to consider (exclusive)
 * @returns {Array} Array of visible messages
 */
function getVisibleMessagesUpTo(chat, count, upToIndex = chat.length) {
    const visibleMessages = [];
    const endIndex = Math.min(upToIndex, chat.length);

    for (let i = endIndex - 1; i >= 0 && visibleMessages.length < count; i--) {
        const message = chat[i];

        // Skip messages that are invisible to AI
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

/**
 * Get the last X visible messages from the chat
 * @param {Array} chat - The chat array
 * @param {number} count - Number of messages to retrieve
 * @returns {Array} Array of visible messages
 */
function getVisibleMessages(chat, count) {
    return getVisibleMessagesUpTo(chat, count, chat.length);
}

/**
 * Check if a message should be invisible to AI processing
 * @param {Object} message - The message object to check
 * @returns {boolean} True if message should be skipped
 */
function isMessageInvisible(message) {
    return message.is_system ||
        message.extra?.isTemporary ||
        message.extra?.invisible ||
        message.mes === 'Generating image…' ||
        message.mes === 'Generating image...' ||
        message.mes === 'Generating prompt…' ||
        message.mes === 'Generating prompt...';
}

/**
 * Get the last message from the chat (even if invisible)
 * @param {Array} chat - The chat array
 * @returns {string|null} The last message text or null
 */
function getLastMessage(chat) {
    if (!Array.isArray(chat) || chat.length === 0) {
        return null;
    }
    const lastMessage = chat[chat.length - 1];
    return lastMessage ? lastMessage.mes || '' : null;
}

/**
 * Get a specific message from the chat by index
 * @param {Array} chat - The chat array
 * @param {number} index - The message index
 * @returns {string|null} The message text or null
 */
function getMessageAtIndex(chat, index) {
    if (!Array.isArray(chat) || index < 0 || index >= chat.length) {
        return null;
    }
    const message = chat[index];
    return message ? message.mes || '' : null;
}

/**
 * Format messages for display in prompts
 * @param {Array} messages - Array of message objects
 * @returns {string} Formatted message string
 */
function formatMessages(messages) {
    return messages.map(msg => `${msg.name}: ${msg.mes}`).join('\n\n');
}

/**
 * Replace message tags in template with actual message content
 * @param {string} template - The template string with message tags
 * @param {Array} messages - Array of message objects
 * @returns {string} Template with message tags replaced
 */
function replaceMessageTags(template, messages) {
    let result = template;

    // Replace all message tags
    result = result.replace(/{all_messages}/g, formatMessages(messages));
    result = result.replace(/{description}/g, formatMessages(messages)); // Keep backward compatibility

    // Previous messages (all but last N)
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

    // Individual message tags
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

/**
 * Parse prompt template with message tags and structured messages
 * @param {string} template - The template to parse
 * @param {Array} messages - Array of message objects
 * @returns {Array} Array of parsed messages with role and content
 */
function parsePromptTemplate(template, messages) {
    // First replace message tags
    const processedTemplate = replaceMessageTags(template, messages);

    // Combined regex to match all message types while preserving order
    const messageRegex = /\[(system|user|assistant)\](.*?)\[\/\1\]/gs;

    const parsedMessages = [];
    let hasStructuredMessages = false;
    let match;

    // Process matches in the order they appear in the template
    while ((match = messageRegex.exec(processedTemplate)) !== null) {
        hasStructuredMessages = true;
        const role = match[1]; // system, user, or assistant
        const content = match[2].trim();

        parsedMessages.push({
            role: role,
            content: content
        });
    }

    // If no structured messages found, fall back to old behavior
    if (!hasStructuredMessages) {
        // Check for old-style {description} or new message tags
        const hasMessageTags = /{(all_messages|previous_messages|previous_messages2|message_last|message_beforelast|description)}/.test(processedTemplate);

        if (hasMessageTags) {
            // The template has been processed, use it as system + user format
            const lines = processedTemplate.split('\n').filter(line => line.trim());
            if (lines.length > 1) {
                // Multiple lines - first as system, rest as user
                parsedMessages.push({
                    role: 'system',
                    content: lines[0]
                });
                parsedMessages.push({
                    role: 'user',
                    content: lines.slice(1).join('\n')
                });
            } else {
                // Single line - use as user message
                parsedMessages.push({
                    role: 'user',
                    content: processedTemplate
                });
            }
        } else {
            // No message tags, use the whole template as system prompt
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

// ===== CHAT MANIPULATION HELPERS =====

/**
 * Safely remove the "Generating image..." message and refresh chat UI
 * @param {Object} context - The SillyTavern context object
 */
async function removeGeneratingSlice(context) {
    if (generatingMessageId === null) return;

    try {
        // Store the ID before clearing it
        const messageIdToRemove = generatingMessageId;
        generatingMessageId = null;

        // Remove from the chat array
        context.chat.splice(messageIdToRemove, 1);

        // Force a complete UI rebuild by triggering the chat changed event
        await eventSource.emit(event_types.CHAT_CHANGED, -1);

        // Save the chat to persist the changes
        await context.saveChat();

    } catch (error) {
        console.error('[swarmUI-integration] Error removing generating slice:', error);
        // Fallback: force a page refresh if all else fails
        // location.reload();
    }
}

/**
 * Add a "generating..." message to chat and return its ID
 * @returns {Promise<number>} The message ID of the generating message
 */
async function addGeneratingMessage() {
    const context = getContext();
    const chat = context.chat;

    const generatingMessage = {
        name: context.name2 || 'System',
        is_system: true,
        mes: 'Generating image…',
        sendDate: Date.now(),
        extra: { isTemporary: true },
    };

    chat.push(generatingMessage);
    generatingMessageId = chat.length - 1;

    // Render the generating message
    await eventSource.emit(event_types.MESSAGE_RECEIVED, generatingMessageId);
    context.addOneMessage(generatingMessage);
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, generatingMessageId);

    return generatingMessageId;
}

/**
 * Add final image message to chat at a specific position
 * @param {string} savedImagePath - Path to the saved image
 * @param {string} imagePrompt - The prompt used for generation
 * @param {string} messagePrefix - Prefix for the message text
 * @param {number|null} insertAfterIndex - Index of message to insert after (null = append to end)
 * @returns {Promise<number>} The message ID of the added image message
 */
async function addImageMessage(savedImagePath, imagePrompt, messagePrefix = 'Generated image', insertAfterIndex = null) {
    const context = getContext();
    const chat = context.chat;

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

    let imageMessageId;

    if (insertAfterIndex !== null && insertAfterIndex >= 0 && insertAfterIndex < chat.length) {
        // Insert after the specific message
        chat.splice(insertAfterIndex + 1, 0, imageMessage);
        imageMessageId = insertAfterIndex + 1;

        // Update all message IDs after the insertion point
        // This is important for maintaining proper message indexing
        await eventSource.emit(event_types.CHAT_CHANGED, -1);

        // Re-render the entire chat to ensure proper ordering
        context.clearChat();
        await context.printMessages();

    } else {
        // Fallback to appending at the end (original behavior)
        chat.push(imageMessage);
        imageMessageId = chat.length - 1;

        // Emit events to properly render the message with image
        await eventSource.emit(event_types.MESSAGE_RECEIVED, imageMessageId);
        context.addOneMessage(imageMessage);
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, imageMessageId);
    }

    await context.saveChat();
    return imageMessageId;
}

// ===== CORE GENERATION FUNCTIONS =====

/**
 * Common function to generate a prompt from chat messages using LLM
 * @param {number|null} upToMessageIndex - Optional index to treat as the last message (for message actions)
 * @returns {Promise<string>} The generated image prompt
 */
async function generateImagePromptFromChat(upToMessageIndex = null) {
    const context = getContext();
    const chat = context.chat;

    if (!Array.isArray(chat) || chat.length === 0) {
        throw new Error('No chat messages to base prompt on.');
    }

    let imagePrompt;

    if (settings.use_raw) {
        // Use generateRaw with multiple messages
        const messageCount = settings.message_count || 5;
        const visibleMessages = upToMessageIndex !== null
            ? getVisibleMessagesUpTo(chat, messageCount, upToMessageIndex + 1)
            : getVisibleMessages(chat, messageCount);

        if (visibleMessages.length === 0) {
            throw new Error('No visible messages found to base prompt on.');
        }

        // Get the instruction template and parse it with message tags
        const instructionTemplate = settings.llm_prompt || 'Generate a detailed, descriptive prompt for an image generation AI based on this scene: {all_messages}';
        const parsedMessages = parsePromptTemplate(instructionTemplate, visibleMessages);

        let systemPrompt = '';
        let prompt;

        if (parsedMessages.length > 0) {
            // Check if we have any system messages
            const hasSystemMessages = parsedMessages.some(msg => msg.role === 'system');

            if (hasSystemMessages) {
                // Find the first system message to use as systemPrompt parameter
                const firstSystemMessage = parsedMessages.find(msg => msg.role === 'system');
                systemPrompt = firstSystemMessage.content;

                // Create chat completion array preserving the original order
                // but exclude the first system message since it's used as systemPrompt
                const chatMessages = [];
                let firstSystemFound = false;

                for (const msg of parsedMessages) {
                    if (msg.role === 'system' && !firstSystemFound) {
                        // Skip the first system message as it's used for systemPrompt
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
                // No system messages, use all messages as-is
                systemPrompt = '';
                prompt = parsedMessages.map(msg => ({
                    role: msg.role,
                    content: msg.content
                }));
            }
        } else {
            // Fallback to simple string format
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
                        '<|im_end|>',     // ChatML end token (most important for Mistral)
                        '</s>',           // End of sequence token
                        '[/INST]',        // End of instruction token
                        '<|endoftext|>',  // Generic end token
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
        // Use the original method with generateQuietPrompt
        // Find the last message that is visible to the AI
        let lastVisibleMessage = '';
        const searchUpTo = upToMessageIndex !== null ? upToMessageIndex + 1 : chat.length;

        for (let i = searchUpTo - 1; i >= 0; i--) {
            const message = chat[i];

            // Skip messages that are invisible to AI
            if (isMessageInvisible(message)) {
                continue;
            }

            // Found the last visible message
            lastVisibleMessage = message.mes || '';
            break;
        }

        if (!lastVisibleMessage) {
            throw new Error('No visible messages found to base prompt on.');
        }

        // For backward compatibility, also check for new message tags in non-raw mode
        const messageCount = settings.message_count || 5;
        const visibleMessages = upToMessageIndex !== null
            ? getVisibleMessagesUpTo(chat, messageCount, upToMessageIndex + 1)
            : getVisibleMessages(chat, messageCount);

        let llmPrompt = settings.llm_prompt || 'Generate a detailed, descriptive prompt for an image generation AI based on this scene: {all_messages}';

        // Replace message tags if they exist
        if (/{(all_messages|previous_messages|previous_messages2|message_last|message_beforelast)}/.test(llmPrompt)) {
            llmPrompt = replaceMessageTags(llmPrompt, visibleMessages);
        } else {
            // Backward compatibility - replace {description} with last message
            llmPrompt = substituteParams(llmPrompt).replace('{description}', lastVisibleMessage);
        }

        imagePrompt = await generateQuietPrompt(llmPrompt);
    }

    // Clean up the generated prompt
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

/**
 * Common function to generate and save an image using SwarmUI API
 * @param {string} imagePrompt - The prompt to use for image generation
 * @returns {Promise<Object>} Object containing savedImagePath and imagePrompt
 */
async function generateAndSaveImage(imagePrompt) {
    const context = getContext();

    try {
        const sessionId = await validateAndGetSessionId();
        const savedParams = await getSavedT2IParams(sessionId);
        let rawInput = { ...savedParams };

        // Clean and build the prompt
        const cleanPrompt = imagePrompt;
        let finalPrompt = cleanPrompt;

        if (settings.append_prompt && rawInput.prompt) {
            finalPrompt = `${cleanPrompt}, ${rawInput.prompt}`;
        }
        rawInput.prompt = finalPrompt;

        // Generate the image
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
            // If the request fails, it might be due to an invalid session
            if (response.status === 401 || response.status === 403) {
                // Clear cached session for next attempt
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

        // Normalize image url
        let imageUrl = data.images[0];
        if (typeof imageUrl === 'string' && !imageUrl.startsWith('data:') && !imageUrl.startsWith('http')) {
            imageUrl = `${settings.url}/${imageUrl}`;
        }

        // Download the image and convert to base64
        const base64Image = await downloadImageAsBase64(imageUrl);

        // Get character name for filename
        const characterName = context.characterId !== undefined ?
            getCharaFilename(context.characterId) : 'unknown';

        // Save the image to SillyTavern's file system
        const filename = `swarm_${characterName}_${humanizedDateTime()}`;
        const savedImagePath = await saveBase64AsFile(base64Image, characterName, filename, 'png');

        return {
            savedImagePath: savedImagePath,
            imagePrompt: cleanPrompt
        };
    } catch (error) {
        // Re-throw with more context
        throw new Error(`Image generation failed: ${error.message}`);
    }
}

// ===== OPERATION HANDLERS =====

/**
 * Common handler for generation operations with error handling and busy state management
 * @param {Function} operation - The async operation to perform
 * @param {string} operationName - Name of the operation for logging/errors
 * @param {boolean} useMainBusy - Whether to use main button busy states
 * @param {jQuery|null} $icon - Icon element for message actions (or null for main buttons)
 * @param {string} originalIconClass - Original icon class for message actions
 * @returns {Promise<void>}
 */
async function handleGenerationOperation(operation, operationName, useMainBusy = true, $icon = null, originalIconClass = '') {
    // Check if already busy
    if (useMainBusy && mainButtonsBusy) {
        console.log(`[swarmUI-integration] ${operationName}: Previous generation still in progress...`);
        return;
    }

    if ($icon && $icon.hasClass('fa-hourglass-half')) {
        console.log(`[swarmUI-integration] ${operationName}: Previous generation still in progress...`);
        return;
    }

    try {
        // Set busy state
        if (useMainBusy) {
            setMainButtonsBusy(true);
        } else if ($icon) {
            setBusyIcon($icon, true, originalIconClass);
        }

        // Execute the operation
        await operation();

    } catch (error) {
        console.error(`[swarmUI-integration] ${operationName} failed:`, error);
        toastr.error(`Failed to ${operationName.toLowerCase()}: ${error.message}`);
    } finally {
        // Clear busy state
        if (useMainBusy) {
            setMainButtonsBusy(false);
        } else if ($icon) {
            setBusyIcon($icon, false, originalIconClass);
        }
    }
}

/**
 * Generate prompt only (test mode)
 * @param {number|null} upToMessageIndex - Optional index to treat as the last message
 * @returns {Promise<void>}
 */
async function generatePromptOnly(upToMessageIndex = null) {
    const operation = async () => {
        const imagePrompt = await generateImagePromptFromChat(upToMessageIndex);

        const context = getContext();
        const chat = context.chat;

        // Add the prompt test result message
        const testMessage = {
            name: context.name2 || 'System',
            is_system: true,
            mes: `${imagePrompt}`,
            sendDate: Date.now(),
        };

        let testMessageId;

        if (upToMessageIndex !== null && upToMessageIndex >= 0 && upToMessageIndex < chat.length) {
            // Insert after the specific message
            chat.splice(upToMessageIndex + 1, 0, testMessage);
            testMessageId = upToMessageIndex + 1;

            // Re-render the entire chat to ensure proper ordering
            await eventSource.emit(event_types.CHAT_CHANGED, -1);
            context.clearChat();
            await context.printMessages();

        } else {
            // Fallback to appending at the end
            chat.push(testMessage);
            testMessageId = chat.length - 1;

            // Render the test message
            await eventSource.emit(event_types.MESSAGE_RECEIVED, testMessageId);
            context.addOneMessage(testMessage);
            await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, testMessageId);
        }

        await context.saveChat();

        toastr.success('Prompt generated successfully!');
        playNotificationSound();
    };

    await handleGenerationOperation(operation, 'Generate prompt');
}

/**
 * Generate image from chat using LLM-generated prompt
 * @param {number|null} upToMessageIndex - Optional index to treat as the last message
 * @returns {Promise<void>}
 */
async function generateImage(upToMessageIndex = null) {
    const operation = async () => {
        // Generate the prompt first
        const imagePrompt = await generateImagePromptFromChat(upToMessageIndex);

        // Generate and save the image
        const result = await generateAndSaveImage(imagePrompt);

        // Add final image message - insert after the specific message if specified
        await addImageMessage(
            result.savedImagePath,
            result.imagePrompt,
            'Generated image',
            upToMessageIndex
        );

        playNotificationSound();
    };

    await handleGenerationOperation(operation, 'Generate image');
}

/**
 * Generate image directly from the last message (no LLM prompt generation)
 * @param {number|null} messageIndex - Optional specific message index
 * @returns {Promise<void>}
 */
async function generateImageFromMessage(messageIndex = null) {
    const operation = async () => {
        const context = getContext();
        const chat = context.chat;

        if (!Array.isArray(chat) || chat.length === 0) {
            throw new Error('No chat messages to base image on.');
        }

        // Get the message text - either from specific index or last message
        let messageText;
        let targetIndex = messageIndex;

        if (messageIndex !== null) {
            messageText = getMessageAtIndex(chat, messageIndex);
        } else {
            messageText = getLastMessage(chat);
            targetIndex = chat.length - 1; // Use last message index for positioning
        }

        if (!messageText || !messageText.trim()) {
            throw new Error('Message is empty or not found.');
        }

        // Use the message directly as prompt (no LLM processing)
        const imagePrompt = messageText.trim();

        // Generate and save the image
        const result = await generateAndSaveImage(imagePrompt);

        // Add final image message after the source message
        await addImageMessage(
            result.savedImagePath,
            result.imagePrompt,
            'Generated image from message',
            targetIndex
        );

        playNotificationSound();
    };

    await handleGenerationOperation(operation, 'Generate image from message');
}

// ===== MESSAGE ACTION HANDLERS =====

/**
 * Message action: Generate image with LLM prompt
 * @param {Event} e - The click event
 * @returns {Promise<void>}
 */
async function swarmMessageGenerateImage(e) {
    const $icon = $(e.currentTarget);
    const $mes = $icon.closest('.mes');
    const messageId = parseInt($mes.attr('mesid'));

    const operation = async () => {
        await generateImage(messageId);
    };

    await handleGenerationOperation(operation, 'Generate image', false, $icon, 'fa-wand-magic-sparkles');
}

/**
 * Message action: Generate prompt only
 * @param {Event} e - The click event
 * @returns {Promise<void>}
 */
async function swarmMessageGeneratePrompt(e) {
    const $icon = $(e.currentTarget);
    const $mes = $icon.closest('.mes');
    const messageId = parseInt($mes.attr('mesid'));

    const operation = async () => {
        await generatePromptOnly(messageId);
    };

    await handleGenerationOperation(operation, 'Generate prompt', false, $icon, 'fa-pen-fancy');
}

/**
 * Message action: Generate image from message directly
 * @param {Event} e - The click event
 * @returns {Promise<void>}
 */
async function swarmMessageGenerateFromMessage(e) {
    const $icon = $(e.currentTarget);
    const $mes = $icon.closest('.mes');
    const messageId = parseInt($mes.attr('mesid'));

    const operation = async () => {
        await generateImageFromMessage(messageId);
    };

    await handleGenerationOperation(operation, 'Generate image from message', false, $icon, 'fa-image');
}

// ===== UI INJECTION HELPERS =====

/**
 * Function to inject SwarmUI buttons into message actions
 */
function injectSwarmUIButtons() {
    // Add our buttons to any extraMesButtons containers that don't already have them
    $('.extraMesButtons').each(function () {
        const $container = $(this);

        // Skip if we've already added our buttons to this container
        if ($container.find('.swarm_mes_button').length > 0) {
            return;
        }

        // Create our three buttons
        const swarmButtons = `
            <div title="SwarmUI: Generate Image (LLM Prompt)" class="mes_button swarm_mes_button swarm_mes_gen_image fa-solid fa-wand-magic-sparkles" data-i18n="[title]SwarmUI: Generate Image (LLM Prompt)"></div>
            <div title="SwarmUI: Generate Prompt Only" class="mes_button swarm_mes_button swarm_mes_gen_prompt fa-solid fa-pen-fancy" data-i18n="[title]SwarmUI: Generate Prompt Only"></div>
            <div title="SwarmUI: Generate Image from Message" class="mes_button swarm_mes_button swarm_mes_gen_from_msg fa-solid fa-image" data-i18n="[title]SwarmUI: Generate Image from Message"></div>
        `;

        // Insert after the existing sd_message_gen button if it exists, or at the beginning
        const $sdButton = $container.find('.sd_message_gen');
        if ($sdButton.length > 0) {
            $sdButton.after(swarmButtons);
        } else {
            $container.prepend(swarmButtons);
        }
    });
}

/**
 * Function to observe for new messages and inject buttons
 */
function observeForNewMessages() {
    // Use MutationObserver to watch for new messages being added
    const observer = new MutationObserver(function (mutations) {
        let shouldInject = false;

        mutations.forEach(function (mutation) {
            if (mutation.type === 'childList') {
                // Check if any new nodes contain message structures
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
            // Small delay to ensure DOM is ready
            setTimeout(injectSwarmUIButtons, 50);
        }
    });

    // Observe the chat container for changes
    const chatContainer = document.getElementById('chat');
    if (chatContainer) {
        observer.observe(chatContainer, {
            childList: true,
            subtree: true
        });
    }
}

// ===== MODAL SYSTEM =====

/**
 * Modal class for prompt preview and editing
 */
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

    /**
     * Show the modal with a generated prompt
     * @param {string} prompt - The prompt to display
     * @param {number|null} upToMessageIndex - Optional message index context
     */
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

        // Focus the textarea and select all text
        setTimeout(() => {
            this.textarea = this.overlay.querySelector('.swarm-prompt-textarea');
            this.textarea.focus();
            this.textarea.select();
        }, 100);
    }

    /**
     * Hide and cleanup the modal
     */
    hide() {
        if (this.overlay) {
            document.body.removeChild(this.overlay);
            this.overlay = null;
        }
        this.isVisible = false;
        this.textarea = null;
    }

    /**
     * Bind event handlers for modal interactions
     */
    bindEvents() {
        const textarea = this.overlay.querySelector('.swarm-prompt-textarea');
        const charCount = this.overlay.querySelector('.char-count');
        const regenerateBtn = this.overlay.querySelector('.regenerate-btn');
        const generateBtn = this.overlay.querySelector('.generate-image-btn');
        const cancelBtn = this.overlay.querySelector('.cancel-btn');
        const closeBtn = this.overlay.querySelector('.swarm-modal-close');

        // Update character count
        const updateCharCount = () => {
            charCount.textContent = textarea.value.length;
        };

        textarea.addEventListener('input', updateCharCount);

        // Close modal handlers
        const closeModal = () => {
            this.hide();
            if (this.onCancel) this.onCancel();
        };

        closeBtn.addEventListener('click', closeModal);
        cancelBtn.addEventListener('click', closeModal);

        // Close on overlay click (but not on modal content)
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) {
                closeModal();
            }
        });

        // ESC key to close
        const handleEsc = (e) => {
            if (e.key === 'Escape' && this.isVisible) {
                closeModal();
                document.removeEventListener('keydown', handleEsc);
            }
        };
        document.addEventListener('keydown', handleEsc);

        // Regenerate prompt
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

        // Generate image with current prompt
        generateBtn.addEventListener('click', async () => {
            if (generateBtn.disabled) return;

            const finalPrompt = textarea.value.trim();
            if (!finalPrompt) {
                toastr.error('Please enter a prompt before generating.');
                textarea.focus();
                return;
            }

            generateBtn.disabled = true;
            generateBtn.innerHTML = '<span class="swarm-loading-spinner"></span> Generating Image...';

            try {
                // Hide modal first
                this.hide();

                // Call the generate function with the edited prompt
                if (this.onGenerate) {
                    await this.onGenerate(finalPrompt);
                }
            } catch (error) {
                console.error('[swarmUI-integration] Failed to generate image:', error);
                toastr.error(`Failed to generate image: ${error.message}`);
                generateBtn.disabled = false;
                generateBtn.innerHTML = '<i class="fa-solid fa-image"></i> Generate Image';
            }
        });
    }
}

// ===== MODAL-ENHANCED GENERATION FUNCTIONS =====

/**
 * Generate image with modal prompt review
 * @param {number|null} upToMessageIndex - Optional message index context
 * @returns {Promise<void>}
 */
async function generateImageWithModal(upToMessageIndex = null) {
    const operation = async () => {
        // Generate the initial prompt
        const imagePrompt = await generateImagePromptFromChat(upToMessageIndex);

        // Show modal with the generated prompt
        if (!promptModal) {
            promptModal = new SwarmPromptModal();
        }

        promptModal.onGenerate = async (finalPrompt) => {
            try {
                // Generate and save the image with the final prompt
                const result = await generateAndSaveImage(finalPrompt);

                // Add final image message - insert after the specific message if specified
                await addImageMessage(
                    result.savedImagePath,
                    result.imagePrompt,
                    'Generated image',
                    upToMessageIndex
                );

                playNotificationSound();

            } catch (error) {
                console.error('[swarmUI-integration] Generation error:', error);
                toastr.error(`Failed to generate image: ${error.message}`);
            } finally {
                setMainButtonsBusy(false);
            }
        };

        promptModal.onCancel = () => {
            setMainButtonsBusy(false);
        };

        promptModal.show(imagePrompt, upToMessageIndex);
    };

    await handleGenerationOperation(operation, 'Generate image with modal');
}

/**
 * Message action: Generate image with modal prompt review
 * @param {Event} e - The click event
 * @returns {Promise<void>}
 */
async function swarmMessageGenerateImageWithModal(e) {
    const $icon = $(e.currentTarget);
    const $mes = $icon.closest('.mes');
    const messageId = parseInt($mes.attr('mesid'));

    if ($icon.hasClass('fa-hourglass-half')) {
        console.log('[swarmUI-integration] SwarmUI: Previous generation still in progress...');
        return;
    }

    setBusyIcon($icon, true, 'fa-wand-magic-sparkles');

    try {
        // Generate the initial prompt
        const imagePrompt = await generateImagePromptFromChat(messageId);

        // Show modal with the generated prompt
        if (!promptModal) {
            promptModal = new SwarmPromptModal();
        }

        promptModal.onGenerate = async (finalPrompt) => {
            try {
                // Generate and save the image with the final prompt
                const result = await generateAndSaveImage(finalPrompt);

                // Add final image message - insert after the specific message
                await addImageMessage(
                    result.savedImagePath,
                    result.imagePrompt,
                    'Generated image',
                    messageId
                );

                playNotificationSound();

            } catch (error) {
                console.error('[swarmUI-integration] Generation error:', error);
                toastr.error(`Failed to generate image: ${error.message}`);
            } finally {
                setBusyIcon($icon, false, 'fa-wand-magic-sparkles');
            }
        };

        promptModal.onCancel = () => {
            setBusyIcon($icon, false, 'fa-wand-magic-sparkles');
        };

        promptModal.show(imagePrompt, messageId);

    } catch (error) {
        console.error('[swarmUI-integration] Failed to generate initial prompt:', error);
        toastr.error(`Failed to generate prompt: ${error.message}`);
        setBusyIcon($icon, false, 'fa-wand-magic-sparkles');
    }
}

// ===== INITIALIZATION =====

/**
 * Initialize the extension - load settings, inject UI, bind events
 */
jQuery(async () => {
    try {
        // Load and inject HTML templates
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(settingsHtml);
        $("#swarm_settings input, #swarm_settings textarea").on("input", onInput);

        const buttonHtml = await $.get(`${extensionFolderPath}/button.html`);
        $("#send_but").before(buttonHtml);

        // Bind main control buttons
        $("#swarm_generate_button").on("click", () => {
            if (settings.show_prompt_modal !== false) {
                generateImageWithModal();
            } else {
                generateImage();
            }
        });
        $("#swarm_generate_prompt_button").on("click", () => generatePromptOnly());
        $("#swarm_generate_from_message_button").on("click", () => generateImageFromMessage());

        // Bind message action buttons using event delegation
        $(document).on('click', '.swarm_mes_gen_image', (e) => {
            if (settings.show_prompt_modal !== false) { // Default to true
                swarmMessageGenerateImageWithModal(e);
            } else {
                swarmMessageGenerateImage(e);
            }
        });
        $(document).on('click', '.swarm_mes_gen_prompt', swarmMessageGeneratePrompt);
        $(document).on('click', '.swarm_mes_gen_from_msg', swarmMessageGenerateFromMessage);

        // Inject buttons into existing messages
        setTimeout(injectSwarmUIButtons, 100);

        // Set up observer for new messages
        observeForNewMessages();

        // Also inject buttons when chat changes (like switching characters)
        eventSource.on(event_types.CHAT_CHANGED, () => {
            setTimeout(injectSwarmUIButtons, 100);
        });

        // Load settings last to ensure UI is ready
        await loadSettings();

        console.log('[swarmUI-integration] Extension initialized successfully');
    } catch (error) {
        console.error('[swarmUI-integration] Failed to initialize extension:', error);
    }
});