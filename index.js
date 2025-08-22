// scripts/extensions/third-party/swarmui-integration/index.js

import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    getRequestHeaders,
    substituteParams,
    updateMessageBlock,
} from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { generateQuietPrompt } from '../../../../script.js';
import { debounce_timeout } from '../../../constants.js';
import { getCurrentEntityId } from '../../../chats.js';
import { saveBase64AsFile } from '../../../utils.js';

const MODULE_NAME = 'swarmui-integration';
const extensionFolderPath = `scripts/extensions/third-party/${MODULE_NAME}`;

let settings = {};
let generatingMessageId = null;

/** ----------------------------- Settings UI ----------------------------- */

async function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    settings = extension_settings[MODULE_NAME];

    $('#swarm_url').val(settings.url || 'http://localhost:7801').trigger('input');
    $('#swarm_session_id').val(settings.session_id || '').trigger('input');
    $('#swarm_llm_prompt')
        .val(settings.llm_prompt || 'Generate a detailed, descriptive prompt for an image generation AI based on this scene: {description}')
        .trigger('input');
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

/** ------------------------- SwarmUI helpers ----------------------------- */

async function getSessionId() {
    if (settings.session_id) return settings.session_id;

    const url = `${trimSlash(settings.url)}/API/GetNewSession`;
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
    const url = `${trimSlash(settings.url)}/API/GetSavedT2IParams?skip_zrok_interstitial=1`;
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

/** ------------------------- Image pipeline ------------------------------ */

/**
 * Normalize various API return shapes into a usable reference:
 * - data:... (data URL)
 * - http(s) URL
 * - relative path -> resolved against settings.url
 * - object with .url or .path
 */
function normalizeImageRef(img) {
    let ref = img;

    if (img && typeof img === 'object') {
        ref = img.url || img.path || img.href || '';
    }

    if (typeof ref !== 'string') return '';

    // If relative path (no scheme/host and not data:)
    if (!ref.startsWith('http') && !ref.startsWith('data:')) {
        ref = `${trimSlash(settings.url)}/${stripLeadingSlash(ref)}`;
    }
    return ref;
}

/**
 * Attempts to fetch a URL and return a Data URL string.
 * If URL is already a data URL, returns it as-is.
 * If fetch is blocked by CORS or fails, returns null so the caller can fall back to external URL attachment.
 */
async function toDataURLFromRef(imageUrl) {
    try {
        if (imageUrl.startsWith('data:')) return imageUrl;

        // Try to download the image bytes
        const response = await fetch(addZrokBypass(imageUrl), {
            method: 'GET',
            headers: {
                'skip_zrok_interstitial': '1',
                ...getRequestHeaders(),
            },
            credentials: settings.use_auth ? 'include' : 'omit',
        });

        if (!response.ok) throw new Error(`Download HTTP ${response.status}`);

        const contentType = response.headers.get('Content-Type') || 'image/png';
        const arrayBuffer = await response.arrayBuffer();
        const base64 = arrayBufferToBase64(arrayBuffer);
        return `data:${contentType};base64,${base64}`;
    } catch (err) {
        console.warn('[swarmui] Download failed (likely CORS). Falling back to external URL attachment.', err);
        return null;
    }
}

/** Save a data URL into the current character’s folder and return a local path. */
async function saveImageToCharacter(dataUrl, preferredExt = 'png') {
    const characterId = getCurrentEntityId?.() ?? getContext()?.characterId ?? null;
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-'); // safe-ish
    const ext = getExtFromDataUrl(dataUrl) || preferredExt || 'png';
    const filename = `swarmui-${stamp}.${ext}`;

    // saveBase64AsFile returns a relative path inside the ST public dir (e.g. /user/images/char-xxx/file.png)
    const savedPath = await saveBase64AsFile(dataUrl, { filename, characterId });

    return { path: savedPath, name: filename, mime: getMimeFromDataUrl(dataUrl) || `image/${ext}` };
}

/** ----------------------- Chat message helpers -------------------------- */

/** Insert a transient "generating…" message and return its id */
function insertGeneratingMessage(context) {
    const generatingMessage = {
        name: context.name2 || 'System',
        is_system: true,
        mes: 'Generating image…',
        sendDate: Date.now(),
    };

    // Push to chat model
    context.chat.push(generatingMessage);
    const messageId = context.chat.length - 1;

    // Render it
    eventSource.emit(event_types.MESSAGE_RECEIVED, messageId);
    context.addOneMessage(generatingMessage);
    eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId);

    return messageId;
}

/** Safely replace the generating message with final content + attachments */
async function finalizeImageMessage(messageId, text, attachments) {
    const context = getContext();
    const msg = context.chat[messageId];
    if (!msg) return;

    msg.mes = text;
    // Use ST’s standard attachments field so the renderer shows the image inline
    msg.attachments = attachments;

    // Re-render this block and persist
    updateMessageBlock?.(messageId, msg);
    await context.saveChat();
}

/** On error, replace placeholder with a failure notice */
async function failImageMessage(messageId, errText = 'Failed to generate image.') {
    const context = getContext();
    const msg = context.chat[messageId];
    if (!msg) return;
    msg.mes = errText;
    msg.attachments = [];
    updateMessageBlock?.(messageId, msg);
    await context.saveChat();
}

/** ----------------------------- Main flow ------------------------------- */

async function generateImage() {
    const context = getContext();
    const chat = context.chat;

    if (!Array.isArray(chat) || chat.length === 0) {
        toastr.error('No chat messages to base image on.');
        return;
    }

    // Build a prompt for your LLM that constructs an image prompt
    const lastMessage = String(chat[chat.length - 1].mes || '');
    const llmPrompt = substituteParams(settings.llm_prompt || '').replace('{description}', lastMessage);

    // 1) Ask the LLM to turn scene text into an image prompt
    let imagePrompt;
    try {
        imagePrompt = await generateQuietPrompt(llmPrompt);
    } catch {
        toastr.error('Failed to generate image prompt from LLM.');
        return;
    }

    // 2) Insert a placeholder message ("Generating…")
    generatingMessageId = insertGeneratingMessage(context);

    try {
        // 3) Prepare SwarmUI params
        const sessionId = await getSessionId();
        const savedParams = await getSavedT2IParams(sessionId);
        let rawInput = { ...savedParams };

        let prompt = imagePrompt;
        if (settings.append_prompt && rawInput.prompt) {
            prompt = `${rawInput.prompt}, ${imagePrompt}`;
        }
        rawInput.prompt = prompt;

        const apiUrl = `${trimSlash(settings.url)}/API/GenerateText2Image?skip_zrok_interstitial=1`;
        const requestBody = {
            session_id: sessionId,
            images: rawInput.images ?? 1,
            ...rawInput,
        };

        // 4) Call SwarmUI
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

        // 5) Normalize -> absolute URL or data URL
        const firstRef = normalizeImageRef(data.images[0]);
        if (!firstRef) throw new Error('Invalid image reference from API');

        // 6) Try to download and save into the character folder
        let dataUrl = await toDataURLFromRef(firstRef);

        // If CORS prevented downloading, we will fall back to an external URL attachment
        let attachments = [];
        if (dataUrl) {
            // Save locally (character folder) so it persists in the chat history
            const saved = await saveImageToCharacter(dataUrl, guessExtFromUrl(firstRef));
            attachments.push({
                type: 'image',
                path: saved.path,   // local path inside ST's public dir
                name: saved.name,
                mime: saved.mime,
            });
        } else {
            // Fallback: attach remote URL (subject to external media policy)
            attachments.push({
                type: 'image',
                url: firstRef,
                name: fileNameFromUrl(firstRef) || 'image.png',
            });
        }

        // 7) Replace the placeholder with the final message + attachment
        await finalizeImageMessage(generatingMessageId, 'Generated image:', attachments);
        generatingMessageId = null;
    } catch (error) {
        console.error('[swarmui] Generation error:', error);
        toastr.error('Failed to generate image.');
        await failImageMessage(generatingMessageId);
        generatingMessageId = null;
    }
}

/** ------------------------------- Utils -------------------------------- */

function trimSlash(s) {
    return String(s || '').replace(/\/+$/, '');
}
function stripLeadingSlash(s) {
    return String(s || '').replace(/^\/+/, '');
}
function addZrokBypass(url) {
    try {
        const u = new URL(url);
        if (!u.searchParams.has('skip_zrok_interstitial')) {
            u.searchParams.set('skip_zrok_interstitial', '1');
        }
        return u.toString();
    } catch {
        return url;
    }
}
function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}
function getExtFromDataUrl(dataUrl) {
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,/.exec(dataUrl || '');
    if (!m) return '';
    const mime = m[1];
    const ext = mime.split('/')[1].toLowerCase();
    // common normalizations
    if (ext.includes('jpeg')) return 'jpg';
    if (ext.includes('svg')) return 'svg';
    if (ext.includes('webp')) return 'webp';
    if (ext.includes('png')) return 'png';
    return ext || '';
}
function getMimeFromDataUrl(dataUrl) {
    const m = /^data:([^;]+);base64,/.exec(dataUrl || '');
    return m ? m[1] : '';
}
function guessExtFromUrl(u) {
    try {
        const p = new URL(u).pathname.toLowerCase();
        const ext = (p.split('.').pop() || '').split('?')[0];
        if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) {
            return ext === 'jpeg' ? 'jpg' : ext;
        }
        return 'png';
    } catch {
        return 'png';
    }
}
function fileNameFromUrl(u) {
    try {
        const p = new URL(u).pathname;
        const base = p.split('/').filter(Boolean).pop() || '';
        return base || '';
    } catch {
        return '';
    }
}

/** ------------------------------ Bootstrapping -------------------------- */

jQuery(async () => {
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $('#extensions_settings').append(settingsHtml);
    $('#swarm_settings input, #swarm_settings textarea').on('input', onInput);

    const buttonHtml = await $.get(`${extensionFolderPath}/button.html`);
    $('#send_but').before(buttonHtml);
    $('#swarm_generate_button').on('click', generateImage);

    await loadSettings();
});
