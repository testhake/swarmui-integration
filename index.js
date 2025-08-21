// swarmui/index.js
import { Popper } from '../../../lib.js';
import {
    animation_duration,
    appendMediaToMessage,
    generateQuietPrompt,
    getCurrentChatId,
    getRequestHeaders,
    substituteParamsExtended,
    getContext
} from '../../../script.js';

import {
    doExtrasFetch,
    extension_settings,
    getApiUrl,
    renderExtensionTemplateAsync,
    writeExtensionField,
} from '../../extensions.js';

import { debounce, deepMerge, delay } from '../../utils.js';

export { MODULE_NAME };
const MODULE_NAME = 'swarmui';

const defaultSettings = {
    swarm_base_url: 'http://127.0.0.1:8000',
    swarm_use_ws: true,
    swarm_auth_header: '',
    swarm_images: 1,
    swarm_llm_prompt_template: 'Create a detailed image prompt describing: {{last_message}}',
    swarm_append_swarm_prompt: true
};

function getSettings() {
    return deepMerge(defaultSettings, (extension_settings && extension_settings[MODULE_NAME]) || {});
}

// small helper to safe-join URL parts
function joinUrl(base, path) {
    if (!base) return path;
    return base.replace(/\/$/, '') + '/' + path.replace(/^\//, '');
}

// Try to extract common T2I fields from Swarm user settings
async function getSwarmUserSettings(baseUrl, authHeader) {
    try {
        const url = joinUrl(baseUrl, '/API/GetUserSettings');
        const headers = { 'Content-Type': 'application/json' };
        if (authHeader) headers['Authorization'] = authHeader;
        const r = await fetch(url, { method: 'GET', headers });
        if (!r.ok) return null;
        const j = await r.json();
        // j.settings is usually a mapping of setting_name->value per Swarm docs
        return j;
    } catch (e) {
        console.warn('SwarmUI GetUserSettings failed', e);
        return null;
    }
}

// Build rawInput mapping for Swarm T2I - we fill common fields and let user settings override
function buildRawInputFromSwarmSettings(swarmSettings, prompt, images) {
    const out = {};
    // common names used by many T2I systems --- best-effort
    const s = swarmSettings && swarmSettings.settings ? swarmSettings.settings : {};
    // use model, steps, width, height, sampler, seed if present
    if (s.model) out.model = s.model;
    if (s.steps) out.steps = parseInt(s.steps, 10);
    if (s.width) out.width = parseInt(s.width, 10);
    if (s.height) out.height = parseInt(s.height, 10);
    if (s.sampler) out.sampler = s.sampler;
    if (s.seed) out.seed = parseInt(s.seed, 10);

    // always set prompt
    out.prompt = prompt;

    // images count at root (Swarm expects images + rawInput)
    // other parameters can be passed as needed by your Swarm config
    return out;
}

function createStatusMessage(text) {
    // create a small placeholder message in chat — uses internal API to create a message
    // NOTE: SillyTavern internals may differ between versions; appendMediaToMessage or updateMessageBlock functions may be used.
    // We'll attempt to use appendMediaToMessage with a 1x1 PNG as placeholder and a message text.
    const placeholder = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    // appendMediaToMessage(signature) - the exact signature might vary across ST versions.
    try {
        return appendMediaToMessage(placeholder, { text });
    } catch (e) {
        // fallback: just return an object we can update later
        return { fallbackText: text };
    }
}

function updateStatusMessage(messageObj, text, previewDataUrl) {
    // Update the placeholder message with new text or preview image
    try {
        if (previewDataUrl) {
            // append preview
            appendMediaToMessage(previewDataUrl, { text });
        } else {
            // try to update the placeholder message text via internal function if available
            if (messageObj && messageObj.updateText) messageObj.updateText(text);
        }
    } catch (e) {
        console.warn('updateStatusMessage fallback', e);
    }
}

async function fetchImageDataUrl(baseUrl, imgPath, authHeader) {
    // Swarm sometimes returns a path like "View/local/raw/2024-...png" — fetch from baseUrl/<path>
    if (!imgPath) return null;
    if (imgPath.startsWith('data:')) return imgPath;
    try {
        const url = joinUrl(baseUrl, imgPath);
        const headers = {};
        if (authHeader) headers['Authorization'] = authHeader;
        const r = await fetch(url, { headers });
        if (!r.ok) {
            console.warn('Fetching image failed', r.status, r.statusText);
            return null;
        }
        const blob = await r.blob();
        return await new Promise((res) => {
            const reader = new FileReader();
            reader.onload = () => res(reader.result);
            reader.onerror = () => res(null);
            reader.readAsDataURL(blob);
        });
    } catch (e) {
        console.warn('fetchImageDataUrl error', e);
        return null;
    }
}

async function generateWithSwarmWS(baseUrl, authHeader, rawPayload, onPreview, onImage, onStatus) {
    // convert http url to ws/ wss
    const wsBase = baseUrl.replace(/^https?:\/\//, (m) => (m === 'http://' ? 'ws://' : 'wss://'));
    const wsUrl = joinUrl(wsBase, '/API/GenerateText2ImageWS');

    return new Promise((resolve, reject) => {
        let resolved = false;
        try {
            const ws = new WebSocket(wsUrl);
            ws.onopen = () => {
                const sendObj = { images: rawPayload.images || 1, rawInput: rawPayload.rawInput };
                ws.send(JSON.stringify(sendObj));
                onStatus && onStatus('started');
            };
            ws.onmessage = async (ev) => {
                try {
                    const data = JSON.parse(ev.data);
                    if (data.gen_progress && data.gen_progress.preview) {
                        onPreview && onPreview(data.gen_progress.preview, data.gen_progress);
                    }
                    if (data.image && data.image.image) {
                        // final image path
                        const imagePath = data.image.image;
                        const imgDataUrl = await fetchImageDataUrl(baseUrl, imagePath, authHeader);
                        onImage && onImage(imgDataUrl, data.image.metadata);
                    }
                    if (data.status) {
                        onStatus && onStatus(JSON.stringify(data.status));
                    }
                    // some servers send a final 'done' or similar; not guaranteed. We'll leave resolution to onImage handler.
                } catch (e) {
                    console.warn('ws parse error', e);
                }
            };
            ws.onerror = (ev) => {
                console.warn('Swarm WS error', ev);
                if (!resolved) { resolved = true; reject(ev); }
            };
            ws.onclose = () => {
                if (!resolved) { resolved = true; resolve(); }
            };
        } catch (e) {
            reject(e);
        }
    });
}

async function generateWithSwarmHTTP(baseUrl, authHeader, rawPayload, onImage) {
    const url = joinUrl(baseUrl, '/API/GenerateText2Image');
    const headers = { 'Content-Type': 'application/json' };
    if (authHeader) headers['Authorization'] = authHeader;
    try {
        const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(rawPayload) });
        if (!r.ok) throw new Error('HTTP request failed ' + r.status);
        const j = await r.json();
        if (j.images && Array.isArray(j.images)) {
            for (const p of j.images) {
                const dataUrl = await fetchImageDataUrl(baseUrl, p, authHeader);
                await onImage(dataUrl, null);
            }
        }
    } catch (e) {
        console.warn('generateWithSwarmHTTP failed', e);
        throw e;
    }
}

/**
 * The main routine called when the user clicks the button.
 * Steps:
 *  - generate a prompt with the current LLM (quiet)
 *  - fetch Swarm user settings (best effort)
 *  - build rawInput merging swarm defaults + generated prompt (append if enabled)
 *  - call Swarm (ws preferred) and display previews + final images
 */
async function runGenerateFlow() {
    const s = getSettings();
    if (!s.swarm_base_url) {
        callGenericPopup('SwarmUI error', { text: 'Set Swarm base URL in the extension settings first.' });
        return;
    }

    // 1) use SillyTavern's generateQuietPrompt to ask the LLM to create a textual image prompt
    const ctx = getContext ? getContext() : {};
    // substitute last_message and other macros if needed
    const promptTemplate = s.swarm_llm_prompt_template || defaultSettings.swarm_llm_prompt_template;
    const subs = { last_message: (ctx && ctx.last_message_text) || '' };
    // substituteParamsExtended may be available in your ST build; else do a simple replacement
    const promptToSend = promptTemplate.replace(/\{\{last_message\}\}/g, subs.last_message);

    let llmResultText = '';
    try {
        // generateQuietPrompt returns a promise which resolves to an object with generated text in many ST versions
        // signature differs across ST releases; below is a best-effort call.
        // If your ST uses generateQuietPrompt({...}) with different args, adapt accordingly.
        const gen = await generateQuietPrompt({
            prompt: promptToSend,
            quiet: true,
            force_chid: getCurrentChatId ? getCurrentChatId() : undefined
        });
        // gen may be a string or an object
        if (!gen) {
            throw new Error('LLM returned empty result');
        }
        if (typeof gen === 'string') llmResultText = gen;
        else if (gen.text) llmResultText = gen.text;
        else if (gen.result) llmResultText = gen.result;
        else if (Array.isArray(gen) && gen.length) llmResultText = gen[0];
        else llmResultText = JSON.stringify(gen).slice(0, 2000);
    } catch (e) {
        console.warn('LLM prompt generation failed', e);
        callGenericPopup('LLM error', { text: 'Prompt generation failed: ' + e.message });
        return;
    }

    // show status in chat
    const statusMsg = createStatusMessage('Generating image prompt...');
    updateStatusMessage(statusMsg, 'Prompt from LLM: ' + llmResultText);

    // 2) Fetch Swarm user settings and try to reuse default generation settings
    const swarmUserSettings = await getSwarmUserSettings(s.swarm_base_url, s.swarm_auth_header);

    // 3) try to pick up a "current prompt" from Swarm settings if it exists
    let swarmCurrentPrompt = '';
    if (swarmUserSettings && swarmUserSettings.settings) {
        // best-effort: check several likely keys
        const candidates = ['prompt', 't2i_prompt', 'last_prompt', 'current_prompt', 'text_prompt'];
        for (const k of candidates) {
            if (k in swarmUserSettings.settings && swarmUserSettings.settings[k]) {
                swarmCurrentPrompt = swarmUserSettings.settings[k];
                break;
            }
        }
    }

    // Build final prompt: either append or replace
    let finalPrompt = llmResultText;
    if (s.swarm_append_swarm_prompt && swarmCurrentPrompt) {
        // append LLM result to current Swarm prompt so the user's UI settings are preserved
        finalPrompt = (swarmCurrentPrompt + ' ' + llmResultText).trim();
    }

    // Build rawInput payload
    const rawInput = buildRawInputFromSwarmSettings(swarmUserSettings, finalPrompt, s.swarm_images);

    const payload = { images: s.swarm_images || 1, rawInput };

    updateStatusMessage(statusMsg, 'Sending to SwarmUI...');

    // 4) Call Swarm: try WS first if configured, otherwise HTTP
    try {
        if (s.swarm_use_ws) {
            await generateWithSwarmWS(
                s.swarm_base_url,
                s.swarm_auth_header,
                payload,
                (previewDataUrl, progress) => {
                    // preview update callback
                    updateStatusMessage(statusMsg, 'Preview available (progress ' + (progress && progress.overall_percent) + ')', previewDataUrl);
                },
                async (imgDataUrl, metadata) => {
                    // final image: insert to chat
                    updateStatusMessage(statusMsg, 'Image ready; inserting into chat...');
                    if (imgDataUrl) {
                        try {
                            // appendMediaToMessage used to insert images into the current chat message
                            appendMediaToMessage(imgDataUrl, { text: 'Generated by SwarmUI' });
                        } catch (e) {
                            // fallback: attempt to send a markdown image link via a normal message send command
                            try {
                                // send as a message (some ST installs expose /api/send, other times you must use internal helper)
                                await doExtrasFetch(new URL(getApiUrl()), {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ cmd: 'send_message', text: `<img src="${imgDataUrl}" alt="swarm">` })
                                });
                            } catch (err) {
                                console.warn('Could not insert image via appendMediaToMessage or doExtrasFetch fallback', err);
                            }
                        }
                    }
                },
                (status) => {
                    updateStatusMessage(statusMsg, 'Swarm status: ' + status);
                }
            );
        } else {
            // HTTP (blocking) path
            await generateWithSwarmHTTP(
                s.swarm_base_url,
                s.swarm_auth_header,
                payload,
                async (imgDataUrl, metadata) => {
                    updateStatusMessage(statusMsg, 'Image arrived; inserting...');
                    if (imgDataUrl) {
                        appendMediaToMessage(imgDataUrl, { text: 'Generated by SwarmUI' });
                    }
                }
            );
        }
    } catch (e) {
        updateStatusMessage(statusMsg, 'Error: ' + (e && e.message ? e.message : String(e)));
        callGenericPopup('Swarm error', { text: 'Swarm generation failed: ' + (e && e.message ? e.message : String(e)) });
    }
}

// register UI: when the extension system initializes, add the button behavior
(async function init() {
    // Render / wire the small button added in button.html
    // SillyTavern loads the button.html for you into the extension area; we simply attach a click
    await delay(50);
    const btn = document.getElementById('swarmui-generate-btn');
    if (btn) {
        btn.onclick = async (ev) => {
            btn.disabled = true;
            try {
                await runGenerateFlow();
            } finally {
                btn.disabled = false;
            }
        };
    } else {
        // fallback: create a small action in the DOM (best-effort)
        const toolbar = document.querySelector('.app-actions, .topbar-actions, .nav-actions');
        if (toolbar) {
            const b = document.createElement('button');
            b.className = 'st-extension-btn';
            b.textContent = 'SwarmUI ➤';
            b.onclick = async () => {
                b.disabled = true;
                try { await runGenerateFlow(); } finally { b.disabled = false; }
            };
            toolbar.appendChild(b);
        }
    }
})();
