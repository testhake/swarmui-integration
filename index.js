import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders, substituteParams, getCurrentChatId } from '../../../../script.js';
import { getContext, extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { generateQuietPrompt } from '../../../../script.js';  // Assuming this exists for quiet LLM generation
import { debounce_timeout } from '../../../constants.js';

const MODULE_NAME = 'swarmui-integration';
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
        headers: { 'Content-Type': 'application/json', ...getRequestHeaders() },
        body: JSON.stringify({}),
        credentials: settings.use_auth ? 'include' : 'omit',
    });

    if (!response.ok) {
        throw new Error('Failed to get session ID');
    }

    const data = await response.json();
    return data.session_id;
}

async function getUserSettings(sessionId) {
    const url = `${settings.url}/API/GetUserSettings`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getRequestHeaders() },
        body: JSON.stringify({ session_id: sessionId }),
        credentials: settings.use_auth ? 'include' : 'omit',
    });

    if (!response.ok) {
        throw new Error('Failed to get user settings');
    }

    return await response.json();
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

    // Insert generating message
    const generatingMessage = {
        name: context.name2 || 'System',
        is_system: true,
        mes: 'Generating image... (0%)',
        sendDate: Date.now(),
        extra: {},
    };
    chat.push(generatingMessage);
    generatingMessageId = chat.length - 1;
    context.addOneMessage(generatingMessage);
    context.saveChat();

    try {
        const sessionId = await getSessionId();
        const userSettings = await getUserSettings(sessionId);
        let rawInput = userSettings.settings || {};

        let prompt = imagePrompt;
        if (settings.append_prompt && rawInput.prompt) {
            prompt = rawInput.prompt + ', ' + imagePrompt;
        }
        rawInput.prompt = prompt;

        // Use WebSocket for generation with updates
        const wsUrl = settings.url.replace(/^http/, 'ws') + '/API/GenerateText2ImageWS';
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            ws.send(JSON.stringify({
                session_id: sessionId,
                images: 1,
                rawInput: rawInput,
            }));
        };

        ws.onmessage = async (event) => {
            const data = JSON.parse(event.data);

            if (data.gen_progress) {
                const overallPercent = Math.round(data.gen_progress.overall_percent * 100);
                chat[generatingMessageId].mes = `Generating image... (${overallPercent}%)`;
                if (data.gen_progress.preview) {
                    chat[generatingMessageId].extra.image = data.gen_progress.preview;
                }
                context.addOneMessage(chat[generatingMessageId]);
            } else if (data.image) {
                let imageSrc = data.image.image;
                if (!imageSrc.startsWith('data:')) {
                    imageSrc = `${settings.url}/${imageSrc}`;
                }
                // Add final image in a new message
                const imageMessage = {
                    name: context.name2 || 'System',
                    is_system: true,
                    mes: 'Generated image:',
                    sendDate: Date.now(),
                    extra: { image: imageSrc },
                };
                chat.push(imageMessage);
                context.addOneMessage(imageMessage);
                context.saveChat();

                // Update generating message to done
                chat[generatingMessageId].mes = 'Image generation complete.';
                context.addOneMessage(chat[generatingMessageId]);
                ws.close();
            }
        };

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            chat[generatingMessageId].mes = 'Error generating image.';
            context.addOneMessage(chat[generatingMessageId]);
        };

        ws.onclose = () => {
            generatingMessageId = null;
        };
    } catch (error) {
        console.error('Generation error:', error);
        chat[generatingMessageId].mes = 'Failed to generate image.';
        context.addOneMessage(chat[generatingMessageId]);
        generatingMessageId = null;
    }
}