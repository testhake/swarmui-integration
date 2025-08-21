import {
    getVisibleMessages,
    getThumbnailUrl,
    Generate,
    getCharInfo,
} from '../../../../script.js';
import { extension_settings, getContext, loadExtensionSettings } from '../../../extensions.js';

const extensionName = 'swarmui-integration';
const logPrefix = `[${extensionName}]`;
let settings = {};
let isGenerating = false;

/**
 * Adds the image generation button to the UI.
 * This function will be called once the UI is ready.
 */
function addSwarmButton() {
    if ($('#swarm-button').length > 0) {
        console.log(`${logPrefix} Button already exists.`);
        return;
    }
    try {
        const buttonHtml = `<div id="swarm-button" class="fa-solid fa-palette" title="Generate image with SwarmUI"></div>`;
        $('#send_form').append(buttonHtml);
        $('#swarm-button').on('click', onSwarmButtonClick);
        console.log(`${logPrefix} Successfully added button to the UI.`);
    } catch (error) {
        console.error(`${logPrefix} Failed to add button to UI.`, error);
    }
}

/**
 * Displays or updates a message in the chat.
 * @param {string} id - A unique identifier for the message.
 * @param {string} htmlContent - The HTML content to display inside the message.
 */
function displayMessage(id, htmlContent) {
    const messageId = `swarm-message-${id}`;
    let messageElement = $(`#${messageId}`);

    if (messageElement.length === 0) {
        const chat = $('#chat');
        const html = `
            <div class="mes" mes-id="${messageId}" id="${messageId}">
                <div class="message_wrapper">
                    <div class="mes_block">
                        <div class="mes_avatar" style="background-image: url('${getThumbnailUrl('sys')}')"></div>
                        <div class="mes_content">
                            <div class="name">SwarmUI</div>
                            <div class="text">${htmlContent}</div>
                        </div>
                    </div>
                </div>
            </div>`;
        chat.append(html);
        window.scrollTo(0, document.body.scrollHeight);
    } else {
        messageElement.find('.text').html(htmlContent);
    }
}

/**
 * Main function to handle the image generation flow.
 */
async function onSwarmButtonClick() {
    if (isGenerating) return;

    isGenerating = true;
    $('#swarm-button').addClass('disabled').attr('title', 'Generation in progress...');
    const messageId = `generation-${Date.now()}`;

    try {
        // 1. Get prompt from LLM
        displayMessage(messageId, 'Asking LLM to create an image prompt...');
        const context = getContext();
        const lastUserMessage = context.chat.slice().reverse().find(msg => msg.is_user)?.mes || '';
        const charName = getCharInfo(context.characterId).name;
        const llmPrompt = settings.prompt.replace(/{{prompt}}/g, lastUserMessage).replace(/{{char}}/g, charName);
        const imagePromptRaw = await Generate(llmPrompt, 1, true);

        if (!imagePromptRaw || imagePromptRaw.trim() === '') {
            throw new Error('LLM returned an empty prompt.');
        }
        const imagePrompt = imagePromptRaw.trim().replace(/^"|"$/g, '');
        displayMessage(messageId, `<b>LLM Prompt:</b><br><em>${imagePrompt}</em><br><br>Connecting to SwarmUI...`);

        // 2. Fetch current SwarmUI user settings
        const response = await fetch(`${settings.swarmUrl}/API/GetUserSettings`);
        if (!response.ok) throw new Error(`SwarmUI connection failed: ${response.statusText}`);
        const userSettings = (await response.json()).settings;

        // 3. Construct the payload for SwarmUI API
        const payload = {};
        for (const [key, value] of Object.entries(userSettings)) {
            const newKey = key.startsWith('T2I_') ? key.substring(4) : key;
            payload[newKey] = value;
        }
        payload.images = Number(settings.numImages) || 1;
        const basePrompt = userSettings.T2I_prompt || '';
        payload.prompt = settings.appendPrompt && basePrompt ? `${basePrompt}, ${imagePrompt}` : imagePrompt;

        // 4. Connect via WebSocket and generate
        generateImageWithWebSocket(payload, messageId);

    } catch (error) {
        console.error(`${logPrefix} Generation failed.`, error);
        displayMessage(messageId, `<b>Error:</b> ${error.message}`);
        isGenerating = false;
        $('#swarm-button').removeClass('disabled').attr('title', 'Generate image with SwarmUI');
    }
}

/**
 * Handles the WebSocket connection to SwarmUI.
 * @param {object} payload - The generation parameters.
 * @param {string} messageId - The ID of the chat message to update.
 */
function generateImageWithWebSocket(payload, messageId) {
    const wsUrl = settings.swarmUrl.replace(/^http/, 'ws') + '/API/GenerateText2ImageWS';
    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        console.log(`${logPrefix} WebSocket connected.`);
        displayMessage(messageId, `<b>LLM Prompt:</b><br><em>${payload.prompt}</em><br><br>Generating image...`);
        socket.send(JSON.stringify(payload));
    };

    socket.onerror = (event) => {
        console.error(`${logPrefix} WebSocket Error`, event);
        displayMessage(messageId, `<b>Error:</b> WebSocket connection failed. Check SwarmUI is running and the URL is correct.`);
        isGenerating = false;
        $('#swarm-button').removeClass('disabled').attr('title', 'Generate image with SwarmUI');
    };

    socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        let statusHtml = `<b>LLM Prompt:</b><br><em>${payload.prompt}</em><br><br>`;

        if (data.gen_progress) {
            const percent = (data.gen_progress.current_percent * 100).toFixed(0);
            statusHtml += `Generating image... (${percent}%)`;
            if (data.gen_progress.preview) {
                statusHtml += `<br><img src="${data.gen_progress.preview}" class="swarm-loading-image">`;
            }
            displayMessage(messageId, statusHtml);
        }

        if (data.image) {
            const imageUrl = data.image.image.startsWith('data:') ? data.image.image : `${settings.swarmUrl}/${data.image.image}`;
            statusHtml += `<a href="${imageUrl}" target="_blank" rel="noopener noreferrer"><img src="${imageUrl}" alt="Generated by SwarmUI"></a>`;
            displayMessage(messageId, statusHtml);
            socket.close(); // End connection after receiving the final image
        }
    };

    socket.onclose = () => {
        console.log(`${logPrefix} WebSocket disconnected.`);
        isGenerating = false;
        $('#swarm-button').removeClass('disabled').attr('title', 'Generate image with SwarmUI');
    };
}

/**
 * This is the main entry point for the extension.
 * It waits for the UI to be ready before initializing.
 */
async function initialize() {
    console.log(`${logPrefix} Initializing...`);

    try {
        await loadExtensionSettings(extensionName);
        settings = extension_settings[extensionName];
        console.log(`${logPrefix} Settings loaded:`, settings);

        if (!settings.swarmUrl) {
            console.warn(`${logPrefix} SwarmUI URL is not set. Extension will not be fully active.`);
        }

        if (settings.showButton) {
            // We need to wait for the UI to be fully rendered.
            // We'll check every 100ms for the #send_form element.
            const maxTries = 50; // Try for 5 seconds
            let tries = 0;
            const interval = setInterval(() => {
                if ($('#send_form').length > 0) {
                    clearInterval(interval);
                    addSwarmButton();
                } else if (++tries > maxTries) {
                    clearInterval(interval);
                    console.error(`${logPrefix} Could not find #send_form to attach button after 5 seconds.`);
                }
            }, 100);
        }
        console.log(`${logPrefix} Initialization complete.`);
    } catch (error) {
        console.error(`${logPrefix} Failed to initialize.`, error);
    }
}

// Start the initialization process when the script is loaded
initialize();