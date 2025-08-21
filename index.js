import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders, substituteParams, getCurrentChatId } from '../../../../script.js';
import { getContext, extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { generateQuietPrompt } from '../../../../script.js';  // Assuming this exists for quiet LLM generation
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
    if (settings.session_id) {
        return settings.session_id;
    }

    const url = `${settings.url}/API/GetNewSession`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'skip_zrok_interstitial': '1',
            ...getRequestHeaders()
        },
        body: JSON.stringify({}),
        credentials: settings.use_auth ? 'include' : 'omit',
    });

    if (!response.ok) {
        throw new Error('Failed to get session ID');
    }

    const data = await response.json();
    return data.session_id;
}

// New function to get saved T2I parameters using your new API method
async function getSavedT2IParams(sessionId) {
    const url = `${settings.url}/API/GetSavedT2IParams`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'skip_zrok_interstitial': '1',
            ...getRequestHeaders()
        },
        body: JSON.stringify({ session_id: sessionId }),
        credentials: settings.use_auth ? 'include' : 'omit',
    });

    if (!response.ok) {
        throw new Error('Failed to get saved T2I parameters');
    }

    const data = await response.json();

    // Handle the nested rawInput structure from your API response
    if (data.rawInput && data.rawInput.rawInput) {
        return data.rawInput.rawInput;
    } else if (data.error === 'no_saved_params') {
        // Return default parameters if none saved
        return {
            prompt: "",
            negativeprompt: "",
            model: "(None)",
            images: "1",
            seed: "-1",
            steps: "30",
            cfgscale: "7",
            aspectratio: "1:1",
            width: "512",
            height: "512"
        };
    }

    throw new Error('Invalid response format from GetSavedT2IParams');
}

async function generateImage() {
    const context = getContext();
    const chat = context.chat;
    if (chat.length === 0) {
        toastr.error('No chat messages to base image on.');
        return;
    }

    // Get last message as description
    const lastMessage = chat[chat.length - 1].mes;
    const llmPrompt = substituteParams(settings.llm_prompt).replace('{description}', lastMessage);

    // Generate image prompt from LLM
    let imagePrompt;
    try {
        imagePrompt = await generateQuietPrompt(llmPrompt);
    } catch (error) {
        toastr.error('Failed to generate image prompt from LLM.');
        return;
    }

    // Insert generating message using proper SillyTavern format
    const generatingMessage = {
        name: context.name2 || 'System',
        is_user: false,
        is_system: true,
        send_date: new Date().getTime(),
        mes: 'Generating image...',
        extra: {},
    };

    chat.push(generatingMessage);
    generatingMessageId = chat.length - 1;

    // Use proper SillyTavern event sequence
    await eventSource.emit(event_types.MESSAGE_RECEIVED, generatingMessageId, 'extension');
    context.addOneMessage(generatingMessage);
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, generatingMessageId, 'extension');
    await context.saveChat();

    try {
        const sessionId = await getSessionId();

        // Use the new API method to get saved T2I parameters
        const savedParams = await getSavedT2IParams(sessionId);

        // Prepare the prompt
        let prompt = imagePrompt;
        if (settings.append_prompt && savedParams.prompt) {
            prompt = savedParams.prompt + ', ' + imagePrompt;
        }

        // Update the prompt in the parameters
        const requestParams = {
            ...savedParams,
            prompt: prompt,
            session_id: sessionId
        };

        const apiUrl = `${settings.url}/API/GenerateText2Image`;

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'skip_zrok_interstitial': '1',
                ...getRequestHeaders()
            },
            body: JSON.stringify(requestParams),
            credentials: settings.use_auth ? 'include' : 'omit'
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const responseText = await response.text();
        console.log('Raw response:', responseText);

        let data;
        try {
            data = JSON.parse(responseText);
        } catch (parseError) {
            console.error('Failed to parse JSON response:', responseText);
            throw new Error('Invalid JSON response from server');
        }

        if (data.images && data.images.length > 0) {
            let imageSrc = data.images[0];

            // If it's not already a data URL or full URL, prepend the base URL
            if (!imageSrc.startsWith('data:') && !imageSrc.startsWith('http')) {
                imageSrc = `${settings.url}/${imageSrc}`;
            }

            // Create the final image message using proper SillyTavern format
            const imageMessage = {
                name: context.name2 || 'System',
                is_user: false,
                is_system: true,
                send_date: new Date().getTime(),
                mes: 'Generated image:',
                extra: {
                    image: imageSrc,
                    title: prompt,
                    generationType: 'SwarmUI',
                    inline_image: false,
                    image_swipes: [imageSrc],
                },
            };

            // Replace the generating message in the chat array
            chat[generatingMessageId] = imageMessage;

            // Use proper SillyTavern event sequence for update
            await eventSource.emit(event_types.MESSAGE_RECEIVED, generatingMessageId, 'extension');
            context.addOneMessage(imageMessage);
            await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, generatingMessageId, 'extension');
            await context.saveChat();

        } else {
            throw new Error('No images returned from API');
        }

    } catch (error) {
        console.error('Generation error:', error);

        // Remove the generating message on error and refresh UI
        if (generatingMessageId !== null && generatingMessageId < chat.length) {
            chat.splice(generatingMessageId, 1);
            await context.saveChat();

            // Force a complete UI refresh
            await eventSource.emit(event_types.CHAT_CHANGED, getCurrentChatId());
        }

        toastr.error('Failed to generate image: ' + error.message);
    } finally {
        generatingMessageId = null;
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