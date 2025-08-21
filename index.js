// SwarmUI extension (self-contained runtime script) -- safe, no top-level imports
console.log("RUNNING");
(function () {
    const MODULE = 'swarmui';
    const DEFAULTS = {
        swarm_base_url: 'http://127.0.0.1:8000',
        swarm_use_ws: true,
        swarm_auth_header: '',
        swarm_images: 1,
        swarm_llm_prompt_template: 'Create a detailed image prompt describing: {{last_message}}',
        swarm_append_swarm_prompt: true
    };

    function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
    function loadSettings() {
        try {
            if (window.extension_settings && window.extension_settings[MODULE]) return Object.assign({}, DEFAULTS, window.extension_settings[MODULE]);
            // fallback to localStorage
            const stored = localStorage.getItem('swarmui_settings');
            if (stored) return Object.assign({}, DEFAULTS, safeParse(stored) || {});
        } catch (e) { }
        return Object.assign({}, DEFAULTS);
    }
    function saveSettings(s) {
        try {
            if (typeof writeExtensionField === 'function') { writeExtensionField(MODULE, JSON.stringify(s)); }
            localStorage.setItem('swarmui_settings', JSON.stringify(s));
        } catch (e) { try { localStorage.setItem('swarmui_settings', JSON.stringify(s)); } catch (e) { } }
    }

    function createTopbarButton() {
        try {
            const container = document.querySelector('.topbar-actions, .app-actions, .nav-actions, .topbar-right');
            const btn = document.createElement('button');
            btn.className = 'swarmui-topbar-btn';
            btn.innerText = 'SwarmUI';
            btn.title = 'Open SwarmUI settings';
            btn.onclick = openSettingsModal;
            if (container) container.appendChild(btn);
            else document.body.appendChild(btn);
        } catch (e) { console.warn('swarmui: could not create topbar button', e); }
    }

    function createComposerButton() {
        try {
            const composerContainers = [document.querySelector('.composer .actions'), document.querySelector('.composer'), document.querySelector('.editor-controls'), document.querySelector('.input-actions'), document.querySelector('.send-area'), document.querySelector('.messages')];
            const container = composerContainers.find(c => c && c.appendChild);
            const btn = document.createElement('button');
            btn.className = 'swarmui-composer-btn';
            btn.innerText = 'Generate Image';
            btn.title = 'Generate an image using SwarmUI and the current LLM prompt';
            btn.onclick = runGenerateFlow;
            if (container) container.appendChild(btn);
            else document.body.appendChild(btn);
        } catch (e) { console.warn('swarmui: could not create composer button', e); }
    }

    function openSettingsModal() {
        const s = loadSettings();
        // modal DOM
        const overlay = document.createElement('div'); overlay.className = 'swarmui-modal';
        const panel = document.createElement('div'); panel.className = 'swarmui-panel';
        panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><h3 style="margin:0">SwarmUI Settings</h3><button id="swarmui-close">✕</button></div>
      <div class="swarmui-settings">
        <label>Swarm Base URL<br/><input id="swarm_base_url_in" type="text" value="${escapeHtml(s.swarm_base_url)}"/></label>
        <label>Use WebSocket<br/><input id="swarm_use_ws_in" type="checkbox" ${s.swarm_use_ws ? 'checked' : ''}/></label>
        <label>Auth Header (optional)<br/><input id="swarm_auth_header_in" type="text" value="${escapeHtml(s.swarm_auth_header)}"/></label>
        <label>Images per request<br/><input id="swarm_images_in" type="number" min="1" max="10" value="${escapeHtml(s.swarm_images)}"/></label>
        <label>LLM prompt template<br/><textarea id="swarm_llm_prompt_template_in">${escapeHtml(s.swarm_llm_prompt_template)}</textarea></label>
        <label>Append Swarm prompt (best-effort)<br/><input id="swarm_append_swarm_prompt_in" type="checkbox" ${s.swarm_append_swarm_prompt ? 'checked' : ''}/></label>
        <div style="margin-top:8px;"><button id="swarm_save_btn">Save</button> <button id="swarm_cancel_btn">Cancel</button></div>
      </div>
    `;
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        document.getElementById('swarmui-close').onclick = closeModal;
        document.getElementById('swarm_cancel_btn').onclick = closeModal;
        document.getElementById('swarm_save_btn').onclick = function () {
            const newS = {
                swarm_base_url: document.getElementById('swarm_base_url_in').value.trim(),
                swarm_use_ws: !!document.getElementById('swarm_use_ws_in').checked,
                swarm_auth_header: document.getElementById('swarm_auth_header_in').value.trim(),
                swarm_images: parseInt(document.getElementById('swarm_images_in').value, 10) || 1,
                swarm_llm_prompt_template: document.getElementById('swarm_llm_prompt_template_in').value,
                swarm_append_swarm_prompt: !!document.getElementById('swarm_append_swarm_prompt_in').checked
            };
            saveSettings(newS);
            closeModal();
            alert('Saved SwarmUI settings');
        };
        function closeModal() { try { overlay.remove(); } catch (e) { } }
    }

    function escapeHtml(s) { if (s == null) return ''; return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

    // Utilities for Swarm interaction
    function joinUrl(base, path) { if (!base) return path; return base.replace(/\/$/, '') + '/' + path.replace(/^\//, ''); }
    async function fetchImageDataUrl(baseUrl, imgPath, authHeader) { if (!imgPath) return null; if (imgPath.startsWith('data:')) return imgPath; try { const url = joinUrl(baseUrl, imgPath); const headers = {}; if (authHeader) headers['Authorization'] = authHeader; const r = await fetch(url, { headers }); if (!r.ok) return null; const blob = await r.blob(); return await new Promise(res => { const reader = new FileReader(); reader.onload = () => res(reader.result); reader.onerror = () => res(null); reader.readAsDataURL(blob); }); } catch (e) { console.warn('fetchImageDataUrl', e); return null; } }

    async function generateWithSwarmHTTP(baseUrl, authHeader, payload, onImage) { try { const url = joinUrl(baseUrl, '/API/GenerateText2Image'); const headers = { 'Content-Type': 'application/json' }; if (authHeader) headers['Authorization'] = authHeader; const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) }); if (!r.ok) throw new Error('HTTP error ' + r.status); const j = await r.json(); if (j.images && Array.isArray(j.images)) { for (const p of j.images) { const dataUrl = await fetchImageDataUrl(baseUrl, p, authHeader); await onImage(dataUrl, null); } } } catch (e) { throw e; } }

    // WS-based generator with preview callbacks (best-effort)
    async function generateWithSwarmWS(baseUrl, authHeader, payload, onPreview, onImage, onStatus) {
        return new Promise((resolve, reject) => {
            try {
                const wsBase = baseUrl.replace(/^https?:\/\//, (m) => m === 'http://' ? 'ws://' : 'wss://');
                const wsUrl = joinUrl(wsBase, '/API/GenerateText2ImageWS');
                const ws = new WebSocket(wsUrl);
                ws.onopen = () => { ws.send(JSON.stringify({ images: payload.images || 1, rawInput: payload.rawInput })); };
                ws.onmessage = async (ev) => {
                    let data = null;
                    try { data = JSON.parse(ev.data); } catch (e) { console.warn('swarm ws parse', e); }
                    if (!data) return;
                    if (data.gen_progress && data.gen_progress.preview) { onPreview && onPreview(data.gen_progress.preview, data.gen_progress); }
                    if (data.image && data.image.image) { const p = data.image.image; const d = await fetchImageDataUrl(baseUrl, p, authHeader); onImage && onImage(d, data.image.metadata); }
                    if (data.status) onStatus && onStatus(data.status);
                };
                ws.onerror = (ev) => { console.warn('swarm ws err', ev); reject(ev); };
                ws.onclose = () => { resolve(); };
            } catch (e) { reject(e); }
        });
    }

    // helper to append an image to the chat UI (DOM fallback)
    function insertImageIntoChat(dataUrl, caption) {
        try {
            // try the official helper first
            if (typeof appendMediaToMessage === 'function') {
                appendMediaToMessage(dataUrl, { text: caption || 'Generated by SwarmUI' });
                return;
            }
        } catch (e) { console.warn('appendMediaToMessage failed', e); }
        // DOM fallback: append an image block to visible messages container
        const candidates = [document.querySelector('.messages'), document.querySelector('.chat-messages'), document.querySelector('.message-list'), document.querySelector('.conversation'), document.querySelector('.messages-list')];
        const container = candidates.find(c => c && c.appendChild);
        const wrapper = document.createElement('div'); wrapper.className = 'swarmui-generated-message';
        wrapper.innerHTML = `<div style="margin:8px 0;">${caption ? '<div>' + escapeHtml(caption) + '</div>' : ''}<img src="${dataUrl}"/></div>`;
        if (container) container.appendChild(wrapper);
        else document.body.appendChild(wrapper);
    }

    // Try to obtain a 'last message' string (best-effort)
    function getLastMessageText() {
        try {
            // prefer built-in context helper if present
            if (typeof getContext === 'function') {
                try { const ctx = getContext(); if (ctx && ctx.last_message_text) return ctx.last_message_text; } catch (e) { }
            }
            // DOM fallbacks: look for common message selectors
            const selectors = ['.message .content', '.message .text', '.message .message-text', '.chat-message .text', '.message-body .text', '.message:last-child .text', '.messages .message:last-child .text'];
            for (const sel of selectors) { const el = document.querySelector(sel); if (el && el.innerText && el.innerText.trim()) return el.innerText.trim(); }
        } catch (e) { console.warn('getLastMessageText', e); }
        return '';
    }

    async function runGenerateFlow() {
        const s = loadSettings();
        if (!s.swarm_base_url) { alert('Set Swarm base URL in settings first.'); openSettingsModal(); return; }
        // Build LLM prompt template
        const promptTemplate = s.swarm_llm_prompt_template || DEFAULTS.swarm_llm_prompt_template;
        const last = getLastMessageText();
        const promptToSend = promptTemplate.replace(/\{\{last_message\}\}/g, last || '');

        let llmResult = '';
        try {
            if (typeof generateQuietPrompt === 'function') {
                const gen = await generateQuietPrompt({ prompt: promptToSend, quiet: true });
                if (!gen) llmResult = '';
                else if (typeof gen === 'string') llmResult = gen;
                else if (gen.text) llmResult = gen.text;
                else if (gen.result) llmResult = gen.result;
                else if (Array.isArray(gen)) llmResult = gen.join('\n');
                else llmResult = JSON.stringify(gen);
            } else {
                // If generateQuietPrompt isn't available, attempt to use a fallback: the LLM isn't accessible
                alert('generateQuietPrompt not available in this SillyTavern build. The extension needs ST runtime support to auto-generate prompts.');
                return;
            }
        } catch (e) { console.warn('LLM generation failed', e); alert('LLM prompt generation failed: ' + (e.message || e)); return; }

        // Try to fetch Swarm user settings (best-effort)
        let swarmUserSettings = null;
        try {
            const url = joinUrl(s.swarm_base_url, '/API/GetUserSettings');
            const headers = { 'Content-Type': 'application/json' };
            if (s.swarm_auth_header) headers['Authorization'] = s.swarm_auth_header;
            const r = await fetch(url, { method: 'GET', headers });
            if (r.ok) swarmUserSettings = await r.json();
        } catch (e) { console.warn('GetUserSettings failed', e); }

        // try to pull a current swarm prompt
        let swarmCurrentPrompt = '';
        if (swarmUserSettings && swarmUserSettings.settings) {
            const sset = swarmUserSettings.settings;
            const keys = ['prompt', 't2i_prompt', 'current_prompt', 'last_prompt', 'text_prompt'];
            for (const k of keys) if (sset[k]) { swarmCurrentPrompt = sset[k]; break; }
        }

        // final prompt
        let finalPrompt = llmResult;
        if (s.swarm_append_swarm_prompt && swarmCurrentPrompt) finalPrompt = (swarmCurrentPrompt + ' ' + llmResult).trim();

        // Build minimal rawInput
        const rawInput = Object.assign({}, {
            prompt: finalPrompt,
            model: (swarmUserSettings && swarmUserSettings.settings && swarmUserSettings.settings.model) || undefined,
            steps: (swarmUserSettings && swarmUserSettings.settings && parseInt(swarmUserSettings.settings.steps, 10)) || undefined,
            width: (swarmUserSettings && swarmUserSettings.settings && parseInt(swarmUserSettings.settings.width, 10)) || undefined,
            height: (swarmUserSettings && swarmUserSettings.settings && parseInt(swarmUserSettings.settings.height, 10)) || undefined
        });

        const payload = { images: s.swarm_images || 1, rawInput };

        // status feedback
        try { insertImageIntoChat('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'SwarmUI: generation started (placeholder)'); } catch (e) { }

        try {
            if (s.swarm_use_ws) {
                await generateWithSwarmWS(s.swarm_base_url, s.swarm_auth_header, payload,
                    (previewDataUrl, progress) => { if (previewDataUrl) insertImageIntoChat(previewDataUrl, 'Swarm Preview'); },
                    (imgDataUrl, metadata) => { if (imgDataUrl) insertImageIntoChat(imgDataUrl, 'Swarm Image'); },
                    (status) => { console.log('Swarm status', status); }
                );
            } else {
                await generateWithSwarmHTTP(s.swarm_base_url, s.swarm_auth_header, payload, async (imgDataUrl, metadata) => { if (imgDataUrl) insertImageIntoChat(imgDataUrl, 'Swarm Image'); });
            }
        } catch (e) { console.warn('Swarm generation failed', e); alert('Swarm generation failed: ' + (e.message || e)); }
    }

    // initialize
    function init() {
        try { createTopbarButton(); } catch (e) { }
        try { createComposerButton(); } catch (e) { }
    }
    // Run after a short delay to let ST finish initial DOM rendering
    setTimeout(init, 800);
})();