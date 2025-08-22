import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders, substituteParams } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { generateQuietPrompt } from '../../../../script.js';
import { debounce_timeout } from '../../../constants.js';
import { saveBase64AsFile, getBase64Async, getCharaFilename } from '../../../utils.js';
import { humanizedDateTime } from '../../../RossAscends-mods.js';

const MODULE_NAME = 'swarmui-integration';
const extensionFolderPath = `scripts/extensions/third-party/${MODULE_NAME}`;

class SwarmInvalidSessionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SwarmInvalidSessionError';
    }
}
function setSessionId(id) {
    settings.session_id = id || '';
    extension_settings[MODULE_NAME] = settings;
    // update settings UI field so the user can see/reuse it
    $('#swarm_session_id').val(settings.session_id).trigger('input');
    saveSettingsDebounced();
}

/** Return true if the server response/content suggests the session is bad/expired */
function isInvalidSession(resp, data) {
    if (resp && [401, 403, 440].includes(resp.status)) return true;
    const msg = (
        (data && (data.error || data.message || data.reason)) ||
        ''
    ).toString().toLowerCase();
    return (
        msg.includes('invalid session') ||
        msg.includes('expired session') ||
        msg.includes('no session') ||
        msg.includes('session not found')
    );
}
js
Copy
Edit

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

async function getSessionId(forceRefresh = false) {
    if (!forceRefresh && settings.session_id) {
        return settings.session_id;
    }

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

    if (!response.ok) throw new Error(`Failed to get session ID (HTTP ${response.status})`);

    const data = await response.json();
    if (!data?.session_id) throw new Error('No session_id in GetNewSession response');

    setSessionId(data.session_id);
    return data.session_id;
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

    let data = null;
    try {
        data = await response.json();
    } catch {
        // ignore json parse error; we'll handle via response.ok below
    }

    if (!response.ok) {
        if (isInvalidSession(response, data)) {
            throw new SwarmInvalidSessionError('Saved params call: invalid/expired session');
        }
        throw new Error(`Failed to get saved T2I params (HTTP ${response.status})`);
    }

    if (isInvalidSession(null, data)) {
        throw new SwarmInvalidSessionError('Saved params call: invalid/expired session');
    }

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
async function generateText2ImageOnce(sessionId, rawInput) {
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
        credentials: settings.use_auth ? 'include' : 'omit',
    });

    const responseText = await response.text();
    let data;
    try {
        data = JSON.parse(responseText);
    } catch {
        console.error('Invalid JSON response:', responseText);
        throw new Error('Invalid JSON response from server');
    }

    if (!response.ok) {
        if (isInvalidSession(response, data)) {
            throw new SwarmInvalidSessionError('Generate call: invalid/expired session');
        }
        throw new Error(`HTTP ${response.status}`);
    }

    if (isInvalidSession(null, data)) {
        throw new SwarmInvalidSessionError('Generate call: invalid/expired session');
    }

    if (!data?.images?.length) throw new Error('No images returned from API');

    // Normalize image url
    let imageUrl = data.images[0];
    if (typeof imageUrl === 'string' && !imageUrl.startsWith('data:') && !imageUrl.startsWith('http')) {
        imageUrl = `${settings.url}/${imageUrl}`;
    }

    return { data, imageUrl };
}

async function generateImage() {
    const context = getContext();
    const chat = context.chat;

    if (!Array.isArray(chat) || chat.length === 0) {
        toastr.error('No chat messages to base image on.');
        return;
    }

    // Build the LLM prompt from the last message
    const lastMessage = chat[chat.length - 1].mes || '';
    const llmPrompt = substituteParams(settings.llm_prompt || '')
        .replace('{description}', lastMessage);

    // Ask LLM to craft the image prompt
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
        extra: { isTemporary: true },
    };

    chat.push(generatingMessage);
    generatingMessageId = chat.length - 1;

    await eventSource.emit(event_types.MESSAGE_RECEIVED, generatingMessageId);
    context.addOneMessage(generatingMessage);
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, generatingMessageId);

    try {
        // 1) get a session (use cached unless force-refresh is needed)
        let sessionId = await getSessionId();

        // 2) fetch saved params; if session invalid, refresh once and retry
        let savedParams = {};
        try {
            savedParams = await getSavedT2IParams(sessionId);
        } catch (err) {
            if (err instanceof SwarmInvalidSessionError) {
                sessionId = await getSessionId(true); // refresh
                savedParams = await getSavedT2IParams(sessionId); // retry once
            } else {
                throw err;
            }
        }

        // 3) build raw input and prompt
        let rawInput = { ...savedParams };
        let prompt = imagePrompt;
        if (settings.append_prompt && rawInput.prompt) {
            prompt = `${rawInput.prompt}, ${imagePrompt}`;
        }
        rawInput.prompt = prompt;

        // 4) generate; if session invalid, refresh once and retry
        let gen;
        try {
            gen = await generateText2ImageOnce(sessionId, rawInput);
        } catch (err) {
            if (err instanceof SwarmInvalidSessionError) {
                sessionId = await getSessionId(true); // refresh
                gen = await generateText2ImageOnce(sessionId, rawInput); // retry once
            } else {
                throw err;
            }
        }

        // Remove the generating message BEFORE adding the final image
        await removeGeneratingSlice(context);

        // Download the image and convert to base64
        const base64Image = await downloadImageAsBase64(gen.imageUrl);

        // Determine filename path
        const characterName = context.characterId !== undefined
            ? getCharaFilename(context.characterId)
            : 'unknown';
        const filename = `swarm_${characterName}_${humanizedDateTime()}`;
        const savedImagePath = await saveBase64AsFile(base64Image, characterName, filename, 'png');

        // Add the final image message
        const imageMessage = {
            name: context.name2 || 'System',
            is_system: true,
            mes: `Generated image: ${imagePrompt}`,
            sendDate: Date.now(),
            extra: {
                image: savedImagePath,
                title: imagePrompt,
            },
        };

        chat.push(imageMessage);
        const imageMessageId = chat.length - 1;

        await eventSource.emit(event_types.MESSAGE_RECEIVED, imageMessageId);
        context.addOneMessage(imageMessage);
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, imageMessageId);
        await context.saveChat();

        toastr.success('Image generated successfully!');
    } catch (error) {
        console.error('Generation error:', error);
        toastr.error(`Failed to generate image: ${error.message}`);
        await removeGeneratingSlice(context);
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