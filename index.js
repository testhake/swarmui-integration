import {
    getVisibleMessages,
    getThumbnailUrl,
    Generate,
    getCharInfo,
} from '../../../../script.js';
import { extension_settings, getContext, loadExtensionSettings } from '../../../extensions.js';

const extensionName = 'swarmui-integration';
let settings = {};
let isGenerating = false;
let swarmSocket = null;

// Function to create and inject the SwarmUI button
function addSwarmButton() {
    // Ensure the button doesn't already exist
    if ($('#swarm-button').length > 0) return;

    const buttonHtml = `
        <div id="swarm-button" class="fa-solid fa-palette" title="Generate image with SwarmUI"></div>
    `;
    $('#send_form').append(buttonHtml);
    $('#swarm-button').on('click', onSwarmButtonClick);
}

// Shows a message in the chat, returns the message element
function showMessage(msg, id) {
    const messageId = `swarm-message-${id}`;

    // Using a more robust way to add the message to the chat
    const lastMessage = getVisibleMessages().last();
    const chat = lastMessage.parent();

    const html = `
        <div class="mes" mes-id="${messageId}" id="${messageId}" style="display:none;">
            <div class="message_wrapper">
                <div class="mes_block">
                    <div class="mes_avatar" style="background-image: url('${getThumbnailUrl('sys')}')"></div>
                    <div class="mes_content">
                        <div class="name">SwarmUI</div>
                        <div class="text">${msg}</div>
                    </div>
                </div>
            </div>
        </div>`;

    chat.append(html);
    const newMessage = $(`#${messageId}`);
    newMessage.fadeIn();
    window.scrollTo(0, document.body.scrollHeight);

    return newMessage;
}

// Updates the content of a message created by showMessage
function updateMessage(id, newContent) {
    const messageEl = $(`#swarm-message-${id} .text`);
    if (messageEl) {
        messageEl.html(newContent);
    }
}

// Handles the main generation flow
async function onSwarmButtonClick() {
    if (isGenerating) return;

    isGenerating = true;
    $('#swarm-button').addClass('disabled').attr('title', 'Generation in progress...');

    const context = getContext();
    const lastUserMessage = context.chat.slice().reverse().find(msg => msg.is_user)?.mes || '';
    const charName = getCharInfo(context.characterId).name;

    try {
        // 1. Generate the image prompt using the LLM
        const messageId = Date.now();
        showMessage('Asking LLM to create an image prompt...', messageId);

        const llmPrompt = settings.prompt.replace(/{{prompt}}/g, lastUserMessage).replace(/{{char}}/g, charName);
        const imagePrompt = await Generate(llmPrompt, false, true, 1.0, 100);

        if (!imagePrompt || imagePrompt.trim() === '') {
            throw new Error('LLM returned an empty prompt.');
        }

        const cleanImagePrompt = imagePrompt.trim().replace(/^"|"$/g, ''); // Clean up quotes from LLM output
        updateMessage(messageId, `<b>LLM Prompt:</b><br><em>${cleanImagePrompt}</em><br><br>Connecting to SwarmUI...`);

        // 2. Get current settings from SwarmUI
        let userSettings;
        try {
            const response = await fetch(`${settings.swarmUrl}/API/GetUserSettings`);
            if (!response.ok) {
                throw new Error(`Failed to get SwarmUI settings. Status: ${response.status}`);
            }
            userSettings = (await response.json()).settings;
        } catch (error) {
            throw new Error(`Could not connect to SwarmUI at ${settings.swarmUrl}. Is it running and accessible?`);
        }

        // 3. Construct the payload
        const payload = { ...userSettings };
        payload.images = Number(settings.numImages);

        const basePrompt = payload.T2I_prompt || '';

        if (settings.appendPrompt && basePrompt) {
            payload.prompt = `${basePrompt}, ${cleanImagePrompt}`;
        } else {
            payload.prompt = cleanImagePrompt;
        }

        const finalPayload = {};
        for (const [key, value] of Object.entries(payload)) {
            const newKey = key.startsWith('T2I_') ? key.substring(4) : key;
            finalPayload[newKey] = value;
        }

        // 4. Generate image via WebSocket
        generateImageWithWebSocket(finalPayload, messageId);

    } catch (error) {
        console.error('[SwarmUI Extension]', error);
        showMessage(`<b>Error:</b> ${error.message}`, `error-${Date.now()}`);
        isGenerating = false;
        $('#swarm-button').removeClass('disabled').attr('title', 'Generate image with SwarmUI');
    }
}

// Handles the WebSocket connection and message events
function generateImageWithWebSocket(payload, messageId) {
    const wsUrl = settings.swarmUrl.replace(/^http/, 'ws') + '/API/GenerateText2ImageWS';
    swarmSocket = new WebSocket(wsUrl);

    swarmSocket.onopen = () => {
        console.log('[SwarmUI Extension] WebSocket connected.');
        updateMessage(messageId, `<b>LLM Prompt:</b><br><em>${payload.prompt}</em><br><br>Generating image...`);
        swarmSocket.send(JSON.stringify(payload));
    };

    swarmSocket.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.gen_progress) {
            const progressPercent = (data.gen_progress.current_percent * 100).toFixed(0);
            let progressHtml = `<b>LLM Prompt:</b><br><em>${payload.prompt}</em><br><br>Generating image... (${progressPercent}%)`;

            if (data.gen_progress.preview) {
                progressHtml += `<br><img src="${data.gen_progress.preview}" class="swarm-loading-image">`;
            }
            updateMessage(messageId, progressHtml);
        }

        if (data.image) {
            const imageUrl = data.image.image.startsWith('data:') ? data.image.image : `${settings.swarmUrl}/${data.image.image}`;
            const imageHtml = `
                <b>LLM Prompt:</b><br><em>${payload.prompt}</em><br><br>
                <a href="${imageUrl}" target="_blank" rel="noopener noreferrer">
                    <img src="${imageUrl}" alt="Generated by SwarmUI">
                </a>`;
            updateMessage(messageId, imageHtml);

            swarmSocket.close();
        }

        if (data.error) {
            throw new Error(data.error);
        }
    };

    swarmSocket.onerror = (error) => {
        console.error('[SwarmUI Extension] WebSocket Error:', error);
        updateMessage(messageId, `<b>Error:</b> WebSocket connection failed. Check the browser console for details.`);
        isGenerating = false;
        $('#swarm-button').removeClass('disabled').attr('title', 'Generate image with SwarmUI');
    };

    swarmSocket.onclose = () => {
        console.log('[SwarmUI Extension] WebSocket disconnected.');
        isGenerating = false;
        $('#swarm-button').removeClass('disabled').attr('title', 'Generate image with SwarmUI');
        swarmSocket = null;
    };
}


// Load settings and initialize the extension
jQuery(async () => {
    // Wait for SillyTavern's main UI to be ready
    await new Promise(resolve => setTimeout(resolve, 100));

    try {
        settings = extension_settings[extensionName] ?? {};
        if (Object.keys(settings).length === 0) {
            await loadExtensionSettings(extensionName);
            settings = extension_settings[extensionName];
        }

        if (settings.showButton) {
            addSwarmButton();
        }
    } catch (error) {
        console.error(`[${extensionName}] Failed to initialize:`, error);
    }
});