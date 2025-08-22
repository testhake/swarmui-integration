import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders, substituteParams } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { generateQuietPrompt } from '../../../../script.js';
import { debounce_timeout } from '../../../constants.js';
import { saveBase64AsFile, getBase64Async, getCharaFilename } from '../../../utils.js';
import { humanizedDateTime } from '../../../RossAscends-mods.js';

const MODULE_NAME = 'swarmui-integration';
const extensionFolderPath = `scripts/extensions/third-party/${MODULE_NAME}`;

let settings = {};
let generatingMessageId = null;
let cachedSessionId = null; // Cache the session ID

async function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    settings = extension_settings[MODULE_NAME];

    // Load cached session ID from settings
    cachedSessionId = settings.cached_session_id || null;

    $('#swarm_url').val(settings.url || 'http://localhost:7801').trigger('input');
    $('#swarm_session_id').val(settings.session_id || '').trigger('input');
    $('#swarm_llm_prompt').val(settings.llm_prompt || 'Generate a detailed, descriptive prompt for an image generation AI based on this scene: {description}').trigger('input');
    $('#swarm_append_prompt').prop('checked', !!settings.append_prompt).trigger('input');
    $('#swarm_use_auth').prop('checked', !!settings.use_auth).trigger('input');
}

function onInput(event) {
    const id = event.target.id.replace('swarm_', '');
    if (id === 'append_prompt' || id === 'use_auth') {
        settings[id] = $(event.target).prop('checked');
    } else {
        settings[id] = $(event.target).val();
    }
    extension_settings[MODULE_NAME] = settings;
    saveSettingsDebounced();
}

/**
 * Tests if a session ID is still valid by making a lightweight API call
 */
async function isSessionValid(sessionId) {
    if (!sessionId) return false;

    try {
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
            credentials: settings.use_auth ? 'include' : 'omit',
        });

        // If we get a successful response, the session is valid
        return response.ok;
    } catch (error) {
        console.warn('Session validation failed:', error);
        return false;
    }
}

/**
 * Gets a valid session ID, using cached one if available, or creating new one if needed
 */
async function getSessionId() {
    // If user has manually set a session_id in settings, prioritize that
    if (settings.session_id) return settings.session_id;

    // Check if we have a cached session and if it's still valid
    if (cachedSessionId && await isSessionValid(cachedSessionId)) {
        return cachedSessionId;
    }

    // Cache is invalid or doesn't exist, create a new session exactly like original
    console.log('Creating new SwarmUI session...');
    const url = `${settings.url}/API/GetNewSession`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'skip_zrok_interstitial': '1',
            ...getRequestHeaders(),
        },
        body: JSON.stringify({}),
        credentials: settings.use_auth ? 'include' : 'omit',
    });
    if (!response.ok) throw new Error('Failed to get session ID');
    const data = await response.json();
    const sessionId = data.session_id;

    // Cache the session ID
    cachedSessionId = sessionId;
    settings.cached_session_id = sessionId;
    extension_settings[MODULE_NAME] = settings;
    saveSettingsDebounced();

    return sessionId;
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
        credentials: settings.use_auth ? 'include' : 'omit',
    });

    if (!response.ok) {
        // If this fails, the session might be invalid - clear cache
        if (response.status === 401 || response.status === 403) {
            cachedSessionId = null;
            delete settings.cached_session_id;
            extension_settings[MODULE_NAME] = settings;
            saveSettingsDebounced();
        }
        throw new Error('Failed to get saved T2I params');
    }

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
                if (messageText === 'Generating image…' || messageText === 'Generating image...') {
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

async function generateImage() {
    const context = getContext();
    const chat = context.chat;

    if (!Array.isArray(chat) || chat.length === 0) {
        toastr.error('No chat messages to base image on.');
        return;
    }

    // Use the last message as the scene description
    const lastMessage = chat[chat.length - 1].mes || '';
    const llmPrompt = substituteParams(settings.llm_prompt || '').replace('{description}', lastMessage);

    // Generate the actual image prompt from the LLM
    let imagePrompt;
    try {
        imagePrompt = await generateQuietPrompt(llmPrompt);
    } catch {
        toastr.error('Failed to generate image prompt from LLM.');
        return;
    }

    // Insert a transient "Generating..." message
    const generatingMessage = {
        name: context.name2 || 'System',
        is_system: true,
        mes: 'Generating image…',
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
        let sessionId = await getSessionId();

        let savedParams;
        let retryCount = 0;
        const maxRetries = 2;

        // Try to get saved params, with retry logic for session issues
        while (retryCount < maxRetries) {
            try {
                savedParams = await getSavedT2IParams(sessionId);
                break; // Success, exit retry loop
            } catch (error) {
                retryCount++;
                if (retryCount >= maxRetries) {
                    throw error; // Give up after max retries
                }

                // If it failed, invalidate cache and try getting a fresh session
                console.warn(`getSavedT2IParams failed (attempt ${retryCount}), getting new session...`);
                cachedSessionId = null;
                delete settings.cached_session_id;
                extension_settings[MODULE_NAME] = settings;
                saveSettingsDebounced();

                sessionId = await getSessionId();
            }
        }

        let rawInput = { ...savedParams };

        // Build the prompt
        let prompt = imagePrompt;
        if (settings.append_prompt && rawInput.prompt) {
            prompt = `${rawInput.prompt}, ${imagePrompt}`;
        }
        rawInput.prompt = prompt;

        // Generate the image with retry logic
        const apiUrl = `${settings.url}/API/GenerateText2Image?skip_zrok_interstitial=1`;
        const requestBody = {
            session_id: sessionId,
            images: rawInput.images ?? 1,
            ...rawInput,
        };

        let response;
        retryCount = 0;

        while (retryCount < maxRetries) {
            try {
                response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'skip_zrok_interstitial': '1',
                        ...getRequestHeaders(),
                    },
                    body: JSON.stringify(requestBody),
                    credentials: settings.use_auth ? 'include' : 'omit',
                });

                if (response.ok) {
                    break; // Success, exit retry loop
                } else if (response.status === 401 || response.status === 403) {
                    // Session might be invalid, try with new session
                    retryCount++;
                    if (retryCount >= maxRetries) {
                        throw new Error(`HTTP ${response.status}`);
                    }

                    console.warn(`Image generation failed with ${response.status} (attempt ${retryCount}), getting new session...`);
                    cachedSessionId = null;
                    delete settings.cached_session_id;
                    extension_settings[MODULE_NAME] = settings;
                    saveSettingsDebounced();

                    sessionId = await getSessionId();
                    requestBody.session_id = sessionId;
                } else {
                    throw new Error(`HTTP ${response.status}`);
                }
            } catch (error) {
                retryCount++;
                if (retryCount >= maxRetries) {
                    throw error;
                }

                // For network errors, also try with a new session
                console.warn(`Image generation failed (attempt ${retryCount}), getting new session...`);
                cachedSessionId = null;
                delete settings.cached_session_id;
                extension_settings[MODULE_NAME] = settings;
                saveSettingsDebounced();

                sessionId = await getSessionId();
                requestBody.session_id = sessionId;
            }
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

        // Success notification
        toastr.success('Image generated successfully!');

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