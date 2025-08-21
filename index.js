import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders, substituteParams } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { generateQuietPrompt } from '../../../../script.js';
import { debounce_timeout } from '../../../constants.js';

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

async function getSessionId() {
    if (settings.session_id) return settings.session_id;

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
    return data.session_id;
}

/**
 * SwarmUI: Get the last saved T2I params for this user/session.
 * Handles the nested shape: { rawInput: { rawInput: {...}, _saved_at: "..." } }
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

    if (!response.ok) throw new Error('Failed to get saved T2I params');

    const data = await response.json();

    // Normalize possible shapes:
    //  - { error: "no_saved_params" }
    //  - { rawInput: { rawInput: {...}, _saved_at: "..." } }
    //  - { rawInput: {...} }
    if (data?.error === 'no_saved_params') return {};

    const nested = data?.rawInput;
    if (nested && typeof nested === 'object') {
        // Prefer deeply nested .rawInput if present
        if (nested.rawInput && typeof nested.rawInput === 'object') {
            return { ...nested.rawInput };
        }
        return { ...nested };
    }

    return {};
}

/** Safely remove the "Generating image..." slice and force the chat UI to refresh. */
async function removeGeneratingSlice(context) {
    if (generatingMessageId === null) return;
    // Remove from the in-memory chat
    context.chat.splice(generatingMessageId, 1);
    // Force a UI refresh so the deleted slice vanishes visually
    await eventSource.emit(event_types.CHAT_CHANGED);
    await context.saveChat();
    generatingMessageId = null;
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
        extra: {},
    };
    chat.push(generatingMessage);
    generatingMessageId = chat.length - 1;
    // Render + persist the new slice like core code does
    await eventSource.emit(event_types.MESSAGE_RECEIVED, generatingMessageId, 'extension');
    context.addOneMessage(generatingMessage);
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, generatingMessageId, 'extension');
    await context.saveChat();

    try {
        const sessionId = await getSessionId();

        // 1) Pull current params from SwarmUI
        const savedParams = await getSavedT2IParams(sessionId);
        let rawInput = { ...savedParams };

        // 2) Build the prompt (append if user requested and saved prompt exists)
        let prompt = imagePrompt;
        if (settings.append_prompt && rawInput.prompt) {
            prompt = `${rawInput.prompt}, ${imagePrompt}`;
        }
        rawInput.prompt = prompt;

        // 3) Generate
        const apiUrl = `${settings.url}/API/GenerateText2Image?skip_zrok_interstitial=1`;

        // Default images if not present in saved params
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

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        // Defensive parse in case server writes logs into body
        const responseText = await response.text();
        let data;
        try {
            data = JSON.parse(responseText);
        } catch {
            console.error('Invalid JSON response:', responseText);
            throw new Error('Invalid JSON response from server');
        }

        if (!data?.images?.length) throw new Error('No images returned from API');

        // Normalize image url (can be a path, remote URL, or data URL)
        let imageSrc = data.images[0];
        if (typeof imageSrc === 'string' && !imageSrc.startsWith('data:') && !imageSrc.startsWith('http')) {
            imageSrc = `${settings.url}/${imageSrc}`;
        }

        // Add the final image message
        const imageMessage = {
            name: context.name2 || 'System',
            is_system: true,
            mes: 'Generated image:',
            sendDate: Date.now(),
            extra: { image: imageSrc },
        };
        chat.push(imageMessage);
        const imageMessageId = chat.length - 1;
        await eventSource.emit(event_types.MESSAGE_RECEIVED, imageMessageId, 'extension');
        context.addOneMessage(imageMessage);
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, imageMessageId, 'extension');
        await context.saveChat();

        // Remove the transient "Generating…" slice and refresh UI
        await removeGeneratingSlice(context);
    } catch (error) {
        console.error('Generation error:', error);
        toastr.error('Failed to generate image.');
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
