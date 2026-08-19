// Login gate, role gating, and cross-device publish/sync via Google Sheet
const Auth = {
    _preview: null,   // published blob fetched for the login dropdowns (not loaded into App yet)

    // ---- Web-app URL: baked-in CONFIG > synced data > per-device localStorage ----
    URL_KEY: 'detudom_shift_sheeturl',
    bakedUrl() { return (typeof CONFIG !== 'undefined' && CONFIG.SHEET_URL) ? CONFIG.SHEET_URL.trim() : ''; },
    getUrl() { return (App.data.sheetUrl || localStorage.getItem(this.URL_KEY) || this.bakedUrl() || '').trim(); },
    // adopt the baked-in URL on first run so admin push/pull (which read data.sheetUrl) work too
    initUrl() { const c = this.bakedUrl(); if (c && !App.data.sheetUrl) this.setUrl(c); },
    validUrl(u) { return /^https:\/\/script\.google\.com\/.*\/exec$/.test((u || this.getUrl()).trim()); },
    setUrl(u) {
        u = (u || '').trim();
        App.data.sheetUrl = u;
        try { localStorage.setItem(this.URL_KEY, u); } catch (e) { /* ignore */ }
        App.save();
    },

    // ---- network helpers: retry + backoff so transient failures / server-busy don't lose data ----
    _delay(ms) { return new Promise(r => setTimeout(r, ms)); },

    async postJson(body, tries) {
        tries = tries || 3;
        let lastErr = 'ไม่ทราบสาเหตุ';
        for (let i = 0; i < tries; i++) {
            try {
                const res = await fetch(this.getUrl(), {
                    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                    body: JSON.stringify(body)
                });
                const json = await res.json().catch(() => null);
                if (json && json.ok) return json;
                lastErr = (json && json.error) || ('HTTP ' + res.status);
            } catch (e) { lastErr = e.message; }
            if (i < tries - 1) await this._delay(500 * (i + 1) + Math.random() * 300);   // backoff + jitter
        }
        return { ok: false, error: lastErr };
    },

    // ---- apply the current role to the DOM ----
    applyRole() {
        document.body.classList.toggle('role-admin', App.isAdmin());
        document.body.classList.toggle('role-staff', App.isStaff());
        const gate = UI.el('loginGate'), bar = UI.el('userBar');

        if (!App.session.role) {
            gate.hidden = false; bar.hidden = true;
            this.renderGate();
            if (this.validUrl()) this.loadGatePreview();
            return;
        }
        gate.hidden = true; bar.hidden = false;

        if (App.isAdmin()) {
            UI.el('userWho').textContent = '🛠️ ผู้จัดตารางเวร (Admin)';
        } else {
            const s = App.currentStaff(), p = s && App.getPosition(s.pos);
            UI.el('userWho').textContent = '👤 ' + (s ? s.name : '?') + (p ? ` · ${p.name}` : '');
            // force staff onto the schedule tab
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'schedule'));
            document.querySelectorAll('.tab-panel').forEach(pn => pn.classList.toggle('active', pn.dataset.panel === 'schedule'));
        }
        UI.el('adminPublish').hidden = !App.isAdmin();
        const cp = UI.el('changePassBtn'); if (cp) cp.hidden = !App.isAdmin();
        const sb = UI.el('saveSwapBtn'); if (sb) sb.hidden = !App.isStaff();
        const sw = UI.el('swapStatus'); if (sw && !App.isStaff()) { sw.textContent = ''; sw.className = 'publish-status'; }
        this.renderPublishStatus();
    },

    // stored admin-password hash from the best source (local data, else published preview)
    storedAdminPass() { return App.data.adminPass || (this._preview && this._preview.adminPass) || ''; },

    renderPublishStatus() {
        const el = UI.el('publishStatus');
        if (!el) return;
        const total = App.data.positions.length;
        const pub = App.data.positions.filter(p => App.posPublished(p.id)).length;
        if (!pub) { el.textContent = 'ยังไม่เผยแพร่ (ฉบับร่าง)'; el.className = 'publish-status'; }
        else { el.textContent = `เผยแพร่แล้ว ${pub}/${total} กลุ่ม · ${App.data.publishedAt || ''}`; el.className = 'publish-status' + (pub === total ? ' ok' : ''); }
    },

    // ---- login gate ----
    renderGate() { this.fillGateStaff(); this.updateAdminHint(); },

    updateAdminHint() {
        const el = UI.el('adminHint');
        if (!el) return;
        el.textContent = this.storedAdminPass() ? '' : '⚠ ยังไม่ได้ตั้งรหัส — พิมพ์รหัสที่ต้องการแล้วกดเข้าสู่ระบบเพื่อตั้งครั้งแรก';
    },

    // use published data from Sheet when available, otherwise the names typed on this device
    gateData() {
        return (this._preview && this._preview.positions && this._preview.positions.length) ? this._preview : App.data;
    },

    fillGateStaff() {
        const src = this.gateData();
        const posSel = UI.el('loginPos'), nameSel = UI.el('loginName');
        if (!src.positions || !src.positions.length) {
            posSel.innerHTML = '<option value="">— ยังไม่มีตำแหน่ง —</option>';
            nameSel.innerHTML = '';
            return;
        }
        posSel.innerHTML = src.positions.map(p => `<option value="${p.id}">${UI.esc(p.name)}</option>`).join('');
        this.fillGateNames();
    },

    fillGateNames() {
        const src = this.gateData();
        const nameSel = UI.el('loginName');
        const pos = UI.el('loginPos').value;
        const staff = (src.staff || []).filter(s => s.pos === pos && !s.inactive);
        nameSel.innerHTML = staff.length
            ? staff.map(s => `<option value="${s.id}">${UI.esc(s.name)}</option>`).join('')
            : '<option value="">— ไม่มีรายชื่อในตำแหน่งนี้ —</option>';
    },

    async loadGatePreview() {
        const msg = UI.el('loginMsg');
        if (!this.validUrl()) { msg.textContent = 'ใส่ลิงก์ Apps Script (.../exec) ก่อน'; return; }
        msg.textContent = 'กำลังดึงรายชื่อ...';
        try {
            const data = await this.fetchPublished();
            if (!data) { msg.textContent = 'ยังไม่มีตารางที่เผยแพร่ — ให้ Admin เผยแพร่ก่อน'; return; }
            this._preview = data;
            this.fillGateStaff();
            this.updateAdminHint();
            msg.textContent = data.published ? 'เลือกชื่อแล้วกดเข้าสู่ระบบ' : '⏳ ตารางยังไม่เผยแพร่ (เข้าได้แต่จะยังไม่เห็นเวร)';
        } catch (e) { msg.textContent = 'ดึงไม่สำเร็จ: ' + e.message; }
    },

    // fetch the published blob WITHOUT overwriting local App.data (retries on transient failure)
    async fetchPublished(tries) {
        tries = tries || 3;
        const url = this.getUrl();
        let lastErr;
        for (let i = 0; i < tries; i++) {
            try {
                const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'mode=data', { method: 'GET' });
                const json = await res.json();
                if (!json || !json.ok || !json.data) return null;
                return typeof json.data === 'string' ? JSON.parse(json.data) : json.data;
            } catch (e) { lastErr = e; if (i < tries - 1) await this._delay(500 * (i + 1)); }
        }
        throw lastErr || new Error('ดึงข้อมูลไม่สำเร็จ');
    },

    loginAdmin() { App.setSession('admin', null); this.afterLogin(); },

    loginStaff() {
        const id = UI.el('loginName').value;
        if (!id) { UI.el('loginMsg').textContent = 'เลือกชื่อก่อน'; return; }
        // adopt the published schedule only if it actually has data (don't wipe local names)
        if (this._preview && this._preview.staff && this._preview.staff.length) App.loadFrom(this._preview);
        App.setSession('staff', id);
        this.afterLogin();
    },

    afterLogin() { this.applyRole(); UI.render(); },
    logout() { App.logout(); this._preview = null; this.applyRole(); },

    // ---- publish (admin): per-position or all — promote each group's draft, snapshot, push full blob ----
    async _releasePositions(posIds) {
        if (!App.isAdmin()) return;
        if (!this.validUrl()) { alert('ตั้งค่าลิงก์ Google Sheet ก่อน (แท็บ ⚙️ ตั้งค่าเวร)'); return; }
        const ym = App.currentKey();
        posIds.forEach(pid => { App.promoteActiveDraftPos(ym, pid); App.snapshotPublishedPos(ym, pid); App.markPosPublished(pid); });
        App.save();
        UI.render();
        const st = UI.el('publishStatus');
        if (st) { st.textContent = 'กำลังเผยแพร่...'; st.className = 'publish-status'; }
        const json = await this.postJson({ action: 'publish', data: App.data });
        if (st) {
            if (json.ok) { st.textContent = `เผยแพร่แล้ว ✓ ${App.data.publishedAt}`; st.className = 'publish-status ok'; }
            else { st.textContent = 'เผยแพร่ไม่สำเร็จ: ' + json.error; st.className = 'publish-status err'; }
        }
        this.renderPublishStatus();
    },
    publishPos(posId) {
        const p = App.getPosition(posId);
        if (p && confirm(`เผยแพร่กลุ่ม "${p.name}" ให้เจ้าหน้าที่ดู?\n(ร่างที่เลือกอยู่ของกลุ่มนี้กลายเป็นตารางจริง · ร่างอื่นของกลุ่มถูกล้าง)`)) this._releasePositions([posId]);
    },
    async unpublishPos(posId) {
        if (!App.isAdmin()) return;
        if (!this.validUrl()) { alert('ตั้งค่าลิงก์ Google Sheet ก่อน (แท็บ ⚙️ ตั้งค่าเวร)'); return; }
        const p = App.getPosition(posId);
        if (!p || !confirm(`ยกเลิกการเผยแพร่กลุ่ม "${p.name}"?\nเจ้าหน้าที่จะไม่เห็นตารางกลุ่มนี้ (จอเปล่า) — ข้อมูลเวรยังอยู่ กดเผยแพร่ใหม่ได้`)) return;
        App.unmarkPosPublished(posId);
        App.save();
        UI.render();
        const st = UI.el('publishStatus');
        if (st) { st.textContent = 'กำลังยกเลิกเผยแพร่...'; st.className = 'publish-status'; }
        const json = await this.postJson({ action: 'publish', data: App.data });   // regen readable sheets (กลุ่มนี้ถูกเคลียร์)
        if (json.ok) this.setSyncStatus(`ยกเลิกเผยแพร่ "${p.name}" แล้ว ✓`, 'ok');
        else this.setSyncStatus('ไม่สำเร็จ: ' + json.error, 'err');
        this.renderPublishStatus();
    },

    // ---- manual save (admin): back up ALL working data (staff/ตั้งค่า/วันลา/ตาราง) to the Sheet
    //      WITHOUT publishing — action 'saveData' writes only the DATA blob, no readable sheets → nothing leaks ----
    async pushSave() {
        if (!App.isAdmin()) return;
        if (!this.validUrl()) { alert('ตั้งค่าลิงก์ Google Sheet ก่อน (แท็บ ⚙️ ตั้งค่าเวร)'); return; }
        App.save();
        const st = UI.el('publishStatus');
        if (st) { st.textContent = '💾 กำลังบันทึก...'; st.className = 'publish-status'; }
        const json = await this.postJson({ action: 'saveData', data: App.data });
        if (json.ok) this.setSyncStatus(`บันทึกแล้ว ✓ ${new Date().toLocaleTimeString('th-TH')}`, 'ok');
        else this.setSyncStatus('บันทึกไม่สำเร็จ: ' + json.error, 'err');
    },
    saveGroup() { return this.pushSave(); },   // per-position 💾 saves the whole working blob (atomic)

    setSyncStatus(msg, kind) {
        const el = UI.el('publishStatus');
        if (!el) return;
        el.textContent = (App.data.published ? '' : '(ฉบับร่าง) ') + msg;
        el.className = 'publish-status' + (kind ? ' ' + kind : '');
    },

    // ---- staff swap: MANUAL save (no auto-sync) — push only this staff's row ----
    _unsavedSwap: false,
    async saveMySwap() {
        if (!App.isStaff() || !App.session.staffId) return;
        if (!this.validUrl()) { alert('ยังไม่ได้ตั้งค่าลิงก์ Google Sheet'); return; }
        UI.setSwapStatus('กำลังบันทึก...', '');
        await this.pushSwap(App.session.staffId);
    },
    async pushSwap(staffId) {
        if (!this.validUrl()) return;
        const ym = App.currentKey();
        const cells = (App.data.schedules[ym] && App.data.schedules[ym][staffId]) || {};
        const json = await this.postJson({ action: 'swap', ym, staffId, cells });
        if (json.ok && json.swapLog) {
            if (!App.data.swapLog) App.data.swapLog = {};
            App.data.swapLog[ym] = json.swapLog;   // authoritative log (server timestamp + name) → show immediately
            App.save();
            UI.renderSwapHistory();
        }
        if (json.ok) { this._unsavedSwap = false; UI.setSwapStatus('บันทึกการแลกเวรแล้ว ✓', 'ok'); }
        else UI.setSwapStatus('บันทึกไม่สำเร็จ: ' + json.error + ' — กดบันทึกอีกครั้ง', 'err');
    },

    // ---- refresh: pull the latest published state into App.data ----
    async refresh() {
        if (!this.validUrl()) { alert('ยังไม่ได้ตั้งค่าลิงก์ Google Sheet'); return; }
        if (App.isAdmin() && !confirm('โหลดตารางที่เผยแพร่ล่าสุด? งานที่ยังไม่เผยแพร่ในเครื่องนี้จะถูกทับ')) return;
        if (App.isStaff() && this._unsavedSwap && !confirm('มีการแลกเวรที่ยังไม่บันทึก จะทิ้งแล้วดึงข้อมูลใหม่ไหม?')) return;
        const data = await this.fetchPublished();
        if (!data) { alert('ยังไม่มีตารางที่เผยแพร่'); return; }
        App.loadFrom(data);
        this._unsavedSwap = false;
        this.applyRole();
        UI.render();
        UI.setSwapStatus('', '');
    }
};
