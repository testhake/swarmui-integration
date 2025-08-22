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

/** Download and convert image to base64 data URL */
async function downloadImageAsBase64(imageUrl) {
    try {
        const response = await fetch(imageUrl, {
            credentials: settings.use_auth ? 'include' : 'omit',
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.status}`);
        }

        const blob = await response.blob();

        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('Error downloading image:', error);
        return null;
    }
}

/** Safely remove the "Generating image..." message */
async function removeGeneratingSlice(context) {
    if (generatingMessageId === null) return;

    try {
        // Store the ID before clearing it
        const messageIdToRemove = generatingMessageId;
        generatingMessageId = null;

        // Remove from the chat array
        context.chat.splice(messageIdToRemove, 1);

        // Force UI refresh
        await eventSource.emit(event_types.CHAT_CHANGED, -1);

        // Additional DOM cleanup
        setTimeout(() => {
            $('#chat .mes').each(function () {
                const messageText = $(this).find('.mes_text').text().trim();
                if (messageText === 'Generating image…' || messageText === 'Generating image...') {
                    $(this).remove();
                }
            });
        }, 100);

    } catch (error) {
        console.error('Error removing generating slice:', error);
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
        extra: { isTemporary: true },
    };

    chat.push(generatingMessage);
    generatingMessageId = chat.length - 1;

    // Trigger message display
    await eventSource.emit(event_types.MESSAGE_RECEIVED, generatingMessageId);
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
            credentials: settings.use_auth ? 'include' : 'omit',
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

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
        let imageSrc = data.images[0];
        if (typeof imageSrc === 'string' && !imageSrc.startsWith('data:') && !imageSrc.startsWith('http')) {
            imageSrc = `${settings.url}/${imageSrc}`;
        }

        // Download image and convert to base64 for better compatibility
        const base64Image = await downloadImageAsBase64(imageSrc);
        const finalImageSrc = base64Image || imageSrc;

        // Remove the generating message FIRST
        await removeGeneratingSlice(context);

        // Small delay to ensure DOM cleanup
        await new Promise(resolve => setTimeout(resolve, 150));

        // Create the image message with proper SillyTavern format
        const imageMessage = {
            name: context.name2 || 'System',
            is_system: true,
            mes: `<img src="${finalImageSrc}" alt="Generated image" style="max-width: 100%; height: auto; border-radius: 8px;">`,
            sendDate: Date.now(),
            extra: {
                image: finalImageSrc,
                type: 'swarm_generated_image',
                swarm_prompt: imagePrompt
            },
        };

        // Add to chat array
        chat.push(imageMessage);
        const imageMessageId = chat.length - 1;

        // Trigger events for proper rendering
        await eventSource.emit(event_types.MESSAGE_RECEIVED, imageMessageId);
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, imageMessageId);

        // Save chat
        await context.saveChat();

        // Force a final UI refresh
        setTimeout(async () => {
            await eventSource.emit(event_types.CHAT_CHANGED, -1);
        }, 200);

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