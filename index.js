import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders, substituteParams } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { generateQuietPrompt, generateRaw } from '../../../../script.js';
import { debounce_timeout } from '../../../constants.js';
import { saveBase64AsFile, getBase64Async, getCharaFilename } from '../../../utils.js';
import { humanizedDateTime } from '../../../RossAscends-mods.js';

const MODULE_NAME = 'swarmui-integration';
const extensionFolderPath = `scripts/extensions/third-party/${MODULE_NAME}`;

let settings = {};
let generatingMessageId = null;
let cachedSessionId = null; // Cache the session ID

// Method 1: Use SillyTavern's built-in notification system
function playNotificationSound() {
    // Try to trigger the browser's notification sound
    if (window.Notification && Notification.permission === 'granted') {
        // Create a silent notification that will trigger the system sound
        const notification = new Notification('Image Generated', {
            body: 'SwarmUI image generation completed',
            silent: false, // This ensures sound plays
            icon: 'favicon.ico'
        });

        // Auto-close after 3 seconds
        setTimeout(() => notification.close(), 3000);
        return;
    }

    // Fallback: Request notification permission first
    if (window.Notification && Notification.permission === 'default') {
        Notification.requestPermission().then(permission => {
            if (permission === 'granted') {
                const notification = new Notification('Image Generated', {
                    body: 'SwarmUI image generation completed',
                    silent: false,
                    icon: 'favicon.ico'
                });
                setTimeout(() => notification.close(), 3000);
            }
        });
    }
}

async function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    settings = extension_settings[MODULE_NAME];
    $('#swarm_url').val(settings.url || 'http://localhost:7801').trigger('input');
    $('#swarm_session_id').val(settings.session_id || '').trigger('input');
    $('#swarm_llm_prompt').val(settings.llm_prompt || 'Generate a detailed, descriptive prompt for an image generation AI based on this scene: {all_messages}').trigger('input');
    $('#swarm_append_prompt').prop('checked', !!settings.append_prompt).trigger('input');
    $('#swarm_use_raw').prop('checked', !!settings.use_raw).trigger('input');
    $('#swarm_message_count').val(settings.message_count || 5).trigger('input');
    $('#swarm_test_mode').prop('checked', !!settings.test_mode).trigger('input');

    // Load cached session ID if it exists in settings
    cachedSessionId = settings.cached_session_id || null;
}

function onInput(event) {
    const id = event.target.id.replace('swarm_', '');
    if (id === 'append_prompt' || id === 'use_raw' || id === 'test_mode') {
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
        credentials: 'omit', // Removed auth usage
    });
    if (!response.ok) throw new Error('Failed to get session ID');
    const data = await response.json();
    return data.session_id;
}

async function getSessionId() {
    // If user provided a manual session ID, use that
    if (settings.session_id && settings.session_id.trim()) {
        return settings.session_id.trim();
    }

    // If we have a cached session ID, try to use it first
    if (cachedSessionId) {
        return cachedSessionId;
    }

    // Create new session and cache it
    try {
        const newSessionId = await createNewSession();
        cachedSessionId = newSessionId;

        // Store in settings for persistence
        settings.cached_session_id = newSessionId;
        extension_settings[MODULE_NAME] = settings;
        saveSettingsDebounced();

        console.log(`SwarmUI: Created new session ID: ${newSessionId}`);
        return newSessionId;
    } catch (error) {
        console.error('SwarmUI: Failed to create new session:', error);
        throw error;
    }
}

async function validateAndGetSessionId() {
    let sessionId = await getSessionId();

    // Test the session ID by trying to get saved params
    try {
        await getSavedT2IParams(sessionId);
        return sessionId; // Session is valid
    } catch (error) {
        console.warn(`SwarmUI: Session ${sessionId} appears invalid, creating new one:`, error);

        // Clear cached session and create new one
        cachedSessionId = null;
        delete settings.cached_session_id;

        try {
            const newSessionId = await createNewSession();
            cachedSessionId = newSessionId;

            // Store in settings for persistence
            settings.cached_session_id = newSessionId;
            extension_settings[MODULE_NAME] = settings;
            saveSettingsDebounced();

            console.log(`SwarmUI: Created replacement session ID: ${newSessionId}`);
            return newSessionId;
        } catch (createError) {
            console.error('SwarmUI: Failed to create replacement session:', createError);
            throw createError;
        }
    }
}

/**
 * SwarmUI: Get the last saved T2I params for this user/session.
 * Handles the nested shape: { rawInput: { rawInput: {...}, *saved*at: "..." } }
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
        credentials: 'omit', // Removed auth usage
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
 * Get the last X visible messages from the chat
 */
function getVisibleMessages(chat, count) {
    const visibleMessages = [];

    for (let i = chat.length - 1; i >= 0 && visibleMessages.length < count; i--) {
        const message = chat[i];

        // Skip messages that are invisible to AI
        if (message.is_system ||
            message.extra?.isTemporary ||
            message.extra?.invisible ||
            message.mes === 'Generating image…' ||
            message.mes === 'Generating image...' ||
            message.mes === 'Generating prompt…' ||
            message.mes === 'Generating prompt...') {
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
 * Format messages for display
 */
function formatMessages(messages) {
    return messages.map(msg => `${msg.name}: ${msg.mes}`).join('\n\n');
}

/**
 * Replace message tags in template with actual message content
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
 * Download image from URL and convert to base64
 */
async function downloadImageAsBase64(imageUrl) {
    try {
        const response = await fetch(imageUrl, {
            method: 'GET',
            headers: {
                'skip_zrok_interstitial': '1',
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to download image: ${response.status}`);
        }

        const blob = await response.blob();
        const base64 = await getBase64Async(blob);

        // Remove the data URL prefix to get just the base64 string
        return base64.replace(/^data:image\/[a-z]+;base64,/, '');
    } catch (error) {
        console.error('Error downloading image:', error);
        throw error;
    }
}

/** Safely remove the "Generating image..." slice and force the chat UI to refresh. */
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

        // Additional DOM cleanup in case the above doesn't work
        setTimeout(() => {
            // Find and remove any remaining "Generating image" messages from the DOM
            $('#chat .mes').each(function () {
                const messageText = $(this).find('.mes_text').text().trim();
                if (messageText === 'Generating image…' || messageText === 'Generating image...' ||
                    messageText === 'Generating prompt…' || messageText === 'Generating prompt...') {
                    $(this).closest('.mes').remove();
                }
            });
        }, 50);

    } catch (error) {
        console.error('Error removing generating slice:', error);
        // Fallback: force a page refresh if all else fails
        // location.reload();
    }
}

// Enhanced function to parse the prompt template with message tags
function parsePromptTemplate(template, messages) {
    // First replace message tags
    const processedTemplate = replaceMessageTags(template, messages);

    // Regular expressions to match different message types
    const systemRegex = /\[system\](.*?)\[\/system\]/gs;
    const userRegex = /\[user\](.*?)\[\/user\]/gs;
    const assistantRegex = /\[assistant\](.*?)\[\/assistant\]/gs;

    const parsedMessages = [];
    let hasStructuredMessages = false;

    // Extract system messages
    let match;
    while ((match = systemRegex.exec(processedTemplate)) !== null) {
        hasStructuredMessages = true;
        const content = match[1].trim();
        parsedMessages.push({
            role: 'system',
            content: content
        });
    }

    // Extract user messages
    userRegex.lastIndex = 0; // Reset regex
    while ((match = userRegex.exec(processedTemplate)) !== null) {
        hasStructuredMessages = true;
        const content = match[1].trim();
        parsedMessages.push({
            role: 'user',
            content: content
        });
    }

    // Extract assistant messages
    assistantRegex.lastIndex = 0; // Reset regex
    while ((match = assistantRegex.exec(processedTemplate)) !== null) {
        hasStructuredMessages = true;
        const content = match[1].trim();
        parsedMessages.push({
            role: 'assistant',
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

// Modified generateImage function
async function generateImage() {
    const context = getContext();
    const chat = context.chat;

    if (!Array.isArray(chat) || chat.length === 0) {
        toastr.error('No chat messages to base image on.');
        return;
    }

    let imagePrompt;

    // Show processing message based on test mode
    const processingMessage = settings.test_mode ? 'Generating prompt…' : 'Generating image…';

    if (settings.use_raw) {
        // Use generateRaw with multiple messages
        const messageCount = settings.message_count || 5;
        const visibleMessages = getVisibleMessages(chat, messageCount);

        if (visibleMessages.length === 0) {
            toastr.error('No visible messages found to base image on.');
            return;
        }

        // Get the instruction template and parse it with message tags
        const instructionTemplate = settings.llm_prompt || 'Generate a detailed, descriptive prompt for an image generation AI based on this scene: {all_messages}';

        const parsedMessages = parsePromptTemplate(instructionTemplate, visibleMessages);

        try {
            let systemPrompt = '';
            let prompt;

            if (parsedMessages.length > 0) {
                // Find system messages (use first one for systemPrompt parameter)
                const systemMessages = parsedMessages.filter(msg => msg.role === 'system');
                if (systemMessages.length > 0) {
                    systemPrompt = systemMessages[0].content;
                }

                // Create chat completion array with all messages
                // If there are multiple system messages, include the rest in the chat array
                const chatMessages = [];

                // Add additional system messages (after the first one) to chat array
                if (systemMessages.length > 1) {
                    for (let i = 1; i < systemMessages.length; i++) {
                        chatMessages.push({
                            role: 'system',
                            content: systemMessages[i].content
                        });
                    }
                }

                // Add all non-system messages
                const otherMessages = parsedMessages.filter(msg => msg.role !== 'system');
                chatMessages.push(...otherMessages.map(msg => ({
                    role: msg.role,
                    content: msg.content
                })));

                prompt = chatMessages;
            } else {
                // Fallback to simple string format
                systemPrompt = 'Generate a detailed, descriptive prompt for an image generation AI based on the following conversation.';
                prompt = formatMessages(visibleMessages);
            }

            const result = await generateRaw({
                systemPrompt: systemPrompt,
                prompt: prompt,
                prefill: ''
            });
            imagePrompt = result;
        } catch (error) {
            console.error('GenerateRaw failed:', error);
            toastr.error('Failed to generate image prompt using generateRaw.');
            return;
        }
    } else {
        // Use the original method with generateQuietPrompt
        // Find the last message that is visible to the AI
        let lastVisibleMessage = '';
        for (let i = chat.length - 1; i >= 0; i--) {
            const message = chat[i];

            // Skip messages that are invisible to AI
            if (message.is_system ||
                message.extra?.isTemporary ||
                message.extra?.invisible ||
                message.mes === 'Generating image…' ||
                message.mes === 'Generating image...' ||
                message.mes === 'Generating prompt…' ||
                message.mes === 'Generating prompt...') {
                continue;
            }

            // Found the last visible message
            lastVisibleMessage = message.mes || '';
            break;
        }

        if (!lastVisibleMessage) {
            toastr.error('No visible messages found to base image on.');
            return;
        }

        // For backward compatibility, also check for new message tags in non-raw mode
        const messageCount = settings.message_count || 5;
        const visibleMessages = getVisibleMessages(chat, messageCount);

        let llmPrompt = settings.llm_prompt || 'Generate a detailed, descriptive prompt for an image generation AI based on this scene: {all_messages}';

        // Replace message tags if they exist
        if (/{(all_messages|previous_messages|previous_messages2|message_last|message_beforelast)}/.test(llmPrompt)) {
            llmPrompt = replaceMessageTags(llmPrompt, visibleMessages);
        } else {
            // Backward compatibility - replace {description} with last message
            llmPrompt = substituteParams(llmPrompt).replace('{description}', lastVisibleMessage);
        }

        try {
            imagePrompt = await generateQuietPrompt(llmPrompt);
        } catch (error) {
            console.error('GenerateQuietPrompt failed:', error);
            toastr.error('Failed to generate image prompt from LLM.');
            return;
        }
    }

    // If in test mode, just display the prompt and exit
    if (settings.test_mode) {
        // Add the prompt test result message
        const testMessage = {
            name: context.name2 || 'System',
            is_system: true,
            mes: `**Generated Prompt (Test Mode):**\n\n${imagePrompt.replace(/\*/g, "").replace(/\"/g, "").replace(/_/g, " ") }`,
            sendDate: Date.now(),
        };

        chat.push(testMessage);
        const testMessageId = chat.length - 1;

        // Render the test message
        await eventSource.emit(event_types.MESSAGE_RECEIVED, testMessageId);
        context.addOneMessage(testMessage);
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, testMessageId);
        await context.saveChat();

        //toastr.success('Prompt generated successfully (test mode)!');
        playNotificationSound();

        return;
    }

    // Insert a transient "Generating..." message
    const generatingMessage = {
        name: context.name2 || 'System',
        is_system: true,
        mes: processingMessage,
        sendDate: Date.now(),
        extra: { isTemporary: true }, // Mark as temporary for easier identification
    };

    chat.push(generatingMessage);
    generatingMessageId = chat.length - 1;

    // Render the generating message
    await eventSource.emit(event_types.MESSAGE_RECEIVED, generatingMessageId);
    context.addOneMessage(generatingMessage);
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, generatingMessageId);

    try {
        const sessionId = await validateAndGetSessionId();
        const savedParams = await getSavedT2IParams(sessionId);
        let rawInput = { ...savedParams };

        // Build the prompt
        imagePrompt = imagePrompt.replace(/\*/g, "").replace(/\"/g, "").replace(/_/g, " ");
        let prompt = imagePrompt;
        if (settings.append_prompt && rawInput.prompt) {
            prompt = `${imagePrompt}, ${rawInput.prompt}`;
        }
        rawInput.prompt = prompt;

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
            credentials: 'omit', // Removed auth usage
        });

        if (!response.ok) {
            // If the request fails, it might be due to an invalid session
            // The validateAndGetSessionId function will handle creating a new one on the next call
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
            console.error('Invalid JSON response:', responseText);
            throw new Error('Invalid JSON response from server');
        }

        if (!data?.images?.length) throw new Error('No images returned from API');

        // Normalize image url
        let imageUrl = data.images[0];
        if (typeof imageUrl === 'string' && !imageUrl.startsWith('data:') && !imageUrl.startsWith('http')) {
            imageUrl = `${settings.url}/${imageUrl}`;
        }

        // Remove the generating message BEFORE adding the final image
        await removeGeneratingSlice(context);

        // Download the image and convert to base64
        const base64Image = await downloadImageAsBase64(imageUrl);

        // Get character name for filename
        const characterName = context.characterId !== undefined ?
            getCharaFilename(context.characterId) : 'unknown';

        // Save the image to SillyTavern's file system
        const filename = `swarm_${characterName}_${humanizedDateTime()}`;
        const savedImagePath = await saveBase64AsFile(base64Image, characterName, filename, 'png');

        // Add the final image message with the saved image path
        const imageMessage = {
            name: context.name2 || 'System',
            is_system: true,
            mes: `Generated image: ${imagePrompt}`,
            sendDate: Date.now(),
            extra: {
                image: savedImagePath,
                title: imagePrompt
            },
        };

        chat.push(imageMessage);
        const imageMessageId = chat.length - 1;

        // Emit events to properly render the message with image
        await eventSource.emit(event_types.MESSAGE_RECEIVED, imageMessageId);
        context.addOneMessage(imageMessage);
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, imageMessageId);
        await context.saveChat();

    } catch (error) {
        console.error('Generation error:', error);
        toastr.error(`Failed to generate image: ${error.message}`);
        await removeGeneratingSlice(getContext());
    }
}

jQuery(async () => {
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings").append(settingsHtml);
    $("#swarm_settings input, #swarm_settings textarea").on("input", onInput);

    const buttonHtml = await $.get(`${extensionFolderPath}/button.html`);
    $("#send_but").before(buttonHtml);
    $("#swarm_generate_button").on("click", generateImage);

    await loadSettings();
});