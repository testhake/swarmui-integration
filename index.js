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

async function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    settings = extension_settings[MODULE_NAME];
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
 * Test if a session ID is still valid by making a lightweight API call
 */
async function isSessionValid(sessionId) {
    if (!sessionId) return false;

    try {
        // Use GetSavedT2IParams as a test call since it's lightweight and requires a valid session
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

        // If we get a 200 response, the session is valid
        // Even if there are no saved params, a valid session will return success
        return response.ok;

    } catch (error) {
        console.error('Session validation error:', error);
        return false;
    }
}

async function getSessionId(forceNew = false) {
    // If forcing a new session, clear the current one
    if (forceNew) {
        settings.session_id = '';
    }

    // If we have a session ID, test if it's still valid
    if (settings.session_id) {
        if (await isSessionValid(settings.session_id)) {
            return settings.session_id;
        } else {
            // Session is invalid, clear it and get a new one
            console.log('Stored session ID is invalid, getting new session...');
            settings.session_id = '';
        }
    }

    // Create a new session
    console.log('Creating new SwarmUI session...');
    const url = `${settings.url}/API/GetNewSession`;

    try {
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

        if (!response.ok) {
            throw new Error(`Failed to get session ID: HTTP ${response.status}`);
        }

        const data = await response.json();

        if (!data.session_id) {
            throw new Error('No session ID returned from server');
        }

        // Store the new session ID in settings and save
        settings.session_id = data.session_id;
        extension_settings[MODULE_NAME] = settings;
        saveSettingsDebounced();

        // Update the UI field
        $('#swarm_session_id').val(settings.session_id);

        console.log(`New SwarmUI session created: ${data.session_id}`);
        return data.session_id;

    } catch (error) {
        console.error('Error creating new session:', error);
        throw new Error(`Failed to get session ID: ${error.message}`);
    }
}

/**
 * Clear the current session and force getting a new one on next use
 */
function clearSession() {
    console.log('Clearing SwarmUI session...');
    settings.session_id = '';
    extension_settings[MODULE_NAME] = settings;
    saveSettingsDebounced();
    $('#swarm_session_id').val('');
}

/**
 * SwarmUI: Get the last saved T2I params for this user/session.
 * Handles the nested shape: { rawInput: { rawInput: {...}, *saved*at: "..." } }
 * Automatically retries with a new session if the current one fails.
 */
async function getSavedT2IParams(sessionId, retryCount = 0) {
    const maxRetries = 1; // Only retry once to avoid infinite loops

    const url = `${settings.url}/API/GetSavedT2IParams?skip_zrok_interstitial=1`;

    try {
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
            // If session is invalid and we haven't retried yet, get a new session and try again
            if ((response.status === 401 || response.status === 403 || response.status === 400) && retryCount < maxRetries) {
                console.log('Session appears invalid, retrying with new session...');
                const newSessionId = await getSessionId(true); // Force new session
                return await getSavedT2IParams(newSessionId, retryCount + 1);
            }
            throw new Error(`Failed to get saved T2I params: HTTP ${response.status}`);
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

    } catch (error) {
        // If we get a network error or other issue and haven't retried yet, try with a new session
        if (retryCount < maxRetries) {
            console.log('Error getting saved params, retrying with new session...', error.message);
            const newSessionId = await getSessionId(true); // Force new session
            return await getSavedT2IParams(newSessionId, retryCount + 1);
        }

        // If retry also failed, log and return empty params instead of throwing
        console.error('Failed to get saved T2I params after retry:', error);
        return {}; // Return empty params so image generation can continue
    }
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

/**
 * Generate image with automatic session retry logic
 */
async function generateImageWithSession(requestBody, sessionId, retryCount = 0) {
    const maxRetries = 1;

    const apiUrl = `${settings.url}/API/GenerateText2Image?skip_zrok_interstitial=1`;

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'skip_zrok_interstitial': '1',
                ...getRequestHeaders(),
            },
            body: JSON.stringify({ ...requestBody, session_id: sessionId }),
            credentials: settings.use_auth ? 'include' : 'omit',
        });

        if (!response.ok) {
            // If session is invalid and we haven't retried yet, get a new session and try again
            if ((response.status === 401 || response.status === 403 || response.status === 400) && retryCount < maxRetries) {
                console.log('Session invalid during image generation, retrying with new session...');
                const newSessionId = await getSessionId(true); // Force new session
                return await generateImageWithSession(requestBody, newSessionId, retryCount + 1);
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

        return data;

    } catch (error) {
        // If we get a network error or other issue and haven't retried yet, try with a new session
        if (retryCount < maxRetries && (error.message.includes('Failed to fetch') || error.message.includes('NetworkError'))) {
            console.log('Network error during image generation, retrying with new session...', error.message);
            const newSessionId = await getSessionId(true); // Force new session
            return await generateImageWithSession(requestBody, newSessionId, retryCount + 1);
        }

        throw error; // Re-throw if we can't retry
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
        const sessionId = await getSessionId();
        const savedParams = await getSavedT2IParams(sessionId);
        let rawInput = { ...savedParams };

        // Build the prompt
        let prompt = imagePrompt;
        if (settings.append_prompt && rawInput.prompt) {
            prompt = `${rawInput.prompt}, ${imagePrompt}`;
        }
        rawInput.prompt = prompt;

        // Generate the image using the retry-enabled function
        const requestBody = {
            images: rawInput.images ?? 1,
            ...rawInput,
        };

        const data = await generateImageWithSession(requestBody, sessionId);

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

// Export clearSession function for potential manual use
window.swarmUIClearSession = clearSession;