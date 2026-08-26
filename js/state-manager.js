// Data model + localStorage persistence. Single shared global: App
const App = {
    STORAGE_KEY: 'detudom_shift_scheduler_v1',
    MAX_CELL: 4,   // เพดานจำนวนเวรต่อช่อง (หน้าแลกเปลี่ยนลงอิสระได้ถึงเท่านี้ · ตารางหลัก/สุ่มยังคุมที่ 2 เอง)

    data: {
        unit: '',
        sheetUrl: '',     // Google Apps Script web-app URL for push
        autoSync: false,  // auto pull on load + debounced push on change
        published: false, // admin has released the schedule to staff
        publishedAt: '',  // human-readable timestamp of last publish
        adminPass: '',    // hashed admin password ('' = not set yet → first login sets it)
        year: 0,          // พ.ศ.
        month: 0,         // 1-12
        positions: [],    // [{ id, name }] — เภสัชกร / เจ้าพนักงานเภสัชกรรม ...
        workplaces: [],   // [{ id, name, noNightDows:[] }] — OPD/IPD... · noNightDows = วันที่ต้องมาครบ (สุ่มเลี่ยง ด)
        staff: [],        // [{ id, name, role, pos, workplace }]
        markers: [],      // [{ id, text, deco, color, group, work, label, pos }]
        schedules: {},    // { 'YYYY-MM': { staffId: { day: markerId } } }
        customHolidays: {}, // { beYear: { 'MM-DD': name } } — user-added holidays for future years
        leaves: {},       // { 'YYYY-MM': { staffId: [dayNumbers] } } — leave days per month
        leaveOrder: {},   // { 'YYYY-MM': [staffId...] } — priority order (index 0 = requested first = most protected)
        splits: [],       // [{ id, markerId, posFirst, posSecond, boundary }] — shift shared by 2 positions, split by half-month
        splitFlip: {},    // { 'YYYY-MM': { splitId: true } } — true = swap which position takes the first half this month
        publishedSchedules: {}, // { 'YYYY-MM': snapshot } — admin's released schedule (frozen at publish, ignores staff swaps) for month-to-month rotation
        swapLog: {},            // { 'YYYY-MM': [{ day, staffId, byName, before:[ids], after:[ids], at }] } — staff shift-swap history (appended by backend)
        locks: {},              // { 'YYYY-MM': { staffId: [dayNumbers] } } — cells set manually by admin → preserved (not re-randomized), shared across drafts
        activeDraft: {},        // { posId: 1|2|3 } — draft ร่างสุ่มที่แต่ละตำแหน่งเลือกดู/แก้ (วันลา+pin ใช้ร่วมทุกร่าง)
        publishedPos: {},       // { posId: 'timestamp' } — เผยแพร่แยกต่อกลุ่ม/ตำแหน่ง (เจ้าหน้าที่เห็นเฉพาะกลุ่มที่เผยแพร่)
        boMarkers: [],          // [{ id, text, color, label }] — เครื่องหมายเวร back office (ชุดแยกจากเวรหลัก · ผู้ใช้กำหนดเอง)
        backoffice: {}          // { 'YYYY-MM': { staffId: { day: [boMarkerIds] } } } — เวรเบิก back office (บุคลากรลงเอง ไม่เกี่ยวการสุ่ม)
    },

    // ---- session (role login, not synced) ----
    SESSION_KEY: 'detudom_shift_session_v1',
    session: { role: null, staffId: null },   // role: 'admin' | 'staff' | null

    // session in sessionStorage → cleared when the browser/tab closes (auto-logout on reopen), kept across refresh
    loadSession() {
        try { const r = sessionStorage.getItem(this.SESSION_KEY); if (r) this.session = JSON.parse(r); }
        catch (e) { /* ignore */ }
    },
    saveSession() { try { sessionStorage.setItem(this.SESSION_KEY, JSON.stringify(this.session)); } catch (e) { /* ignore */ } },
    setSession(role, staffId) { this.session = { role, staffId: staffId || null }; this.saveSession(); },
    logout() { this.session = { role: null, staffId: null }; this.saveSession(); },
    // ---- admin password (basic obfuscation, synced via Sheet — not strong crypto) ----
    hashPass(str) {
        let h = 5381; str = String(str);
        for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
        return h.toString(36);
    },
    setAdminPass(p) { this.data.adminPass = p ? this.hashPass(p) : ''; this.save(); },
    checkAdminPass(p, storedHash) { return this.hashPass(p) === (storedHash || this.data.adminPass || ''); },

    isAdmin() { return this.session.role === 'admin'; },
    isStaff() { return this.session.role === 'staff'; },
    currentStaff() { return this.session.staffId ? this.data.staff.find(s => s.id === this.session.staffId) : null; },

    DEFAULT_POSITIONS: [
        { id: 'pharm', name: 'เภสัชกร' },
        { id: 'tech', name: 'เจ้าพนักงานเภสัชกรรม' }
    ],

    seedPositions() {
        this.data.positions = this.DEFAULT_POSITIONS.map(p => ({ ...p }));
    },

    firstPosId() {
        return this.data.positions[0] ? this.data.positions[0].id : '';
    },

    // ---- workplaces (OPD/IPD…) — orthogonal to positions; drive the "no ด" full-attendance rule ----
    // noNightDows = วันที่ต้องมาครบ · noNightPos = ตำแหน่งที่กติกาบังคับ (ว่าง = ทุกตำแหน่ง)
    DEFAULT_WORKPLACES: [
        { id: 'opd', name: 'OPD', noNightDows: [], noNightPos: [] },
        { id: 'ipd', name: 'IPD', noNightDows: [], noNightPos: [] }
    ],

    seedWorkplaces() {
        this.data.workplaces = this.DEFAULT_WORKPLACES.map(w =>
            ({ ...w, noNightDows: w.noNightDows.slice(), noNightPos: w.noNightPos.slice() }));
    },

    getWorkplace(id) { return (this.data.workplaces || []).find(w => w.id === id) || null; },

    addWorkplace(name) {
        const id = 'w' + Date.now() + Math.floor(Math.random() * 1000);
        if (!this.data.workplaces) this.data.workplaces = [];
        this.data.workplaces.push({ id, name: (name || '').trim(), noNightDows: [] });
        this.save();
        return id;
    },

    renameWorkplace(id, name) {
        const w = this.getWorkplace(id);
        if (w) { w.name = name.trim(); this.save(); }
    },

    removeWorkplace(id) {
        this.data.workplaces = (this.data.workplaces || []).filter(w => w.id !== id);
        this.data.staff.forEach(s => { if (s.workplace === id) s.workplace = ''; });
        this.save();
    },

    toggleWorkplaceDow(id, dow, on) {
        const w = this.getWorkplace(id);
        if (!w) return;
        if (!w.noNightDows) w.noNightDows = [];
        const has = w.noNightDows.includes(dow);
        if (on && !has) w.noNightDows.push(dow);
        else if (!on && has) w.noNightDows = w.noNightDows.filter(d => d !== dow);
        this.save();
    },

    toggleWorkplacePos(id, posId, on) {
        const w = this.getWorkplace(id);
        if (!w) return;
        if (!w.noNightPos) w.noNightPos = [];
        const has = w.noNightPos.includes(posId);
        if (on && !has) w.noNightPos.push(posId);
        else if (!on && has) w.noNightPos = w.noNightPos.filter(p => p !== posId);
        this.save();
    },

    // this staff must be present (no ด) on this day-of-week?
    //   workplace requires full attendance on this dow AND (no position filter, or this staff's position is included)
    staffNoNightOn(s, dow) {
        const w = s && s.workplace ? this.getWorkplace(s.workplace) : null;
        if (!w || !w.noNightDows || !w.noNightDows.includes(dow)) return false;
        return !w.noNightPos || !w.noNightPos.length || w.noNightPos.includes(s.pos);
    },

    getPosition(id) {
        return this.data.positions.find(p => p.id === id) || null;
    },

    addPosition(name) {
        const id = 'p' + Date.now() + Math.floor(Math.random() * 1000);
        this.data.positions.push({ id, name: (name || '').trim() });
        // a new position inherits the shared marker set by default
        this.data.markers.forEach(m => {
            if (!m.positions) m.positions = [];
            if (!m.positions.includes(id)) m.positions.push(id);
        });
        this.save();
        return id;
    },

    renamePosition(id, name) {
        const p = this.getPosition(id);
        if (p) { p.name = name.trim(); this.save(); }
    },

    removePosition(id) {
        if (this.data.positions.length <= 1) return false;   // keep at least one
        this.data.positions = this.data.positions.filter(p => p.id !== id);
        const fallback = this.firstPosId();
        this.data.staff.forEach(s => { if (s.pos === id) s.pos = fallback; });
        this.data.markers.forEach(m => {
            if (m.positions) m.positions = m.positions.filter(p => p !== id);
        });
        this.save();
        return true;
    },

    // fixed swatches — markers may only use these (keeps colours consistent);
    // array order = display sort order
    PRESET_COLORS: [
        { hex: '#fef3c7', name: 'เหลือง (เช้า)' },
        { hex: '#dbeafe', name: 'ฟ้า (บ่าย)' },
        { hex: '#e0e7ff', name: 'คราม (ดึก)' },
        { hex: '#ccfbf1', name: 'เขียวมิ้นต์' },
        { hex: '#d1fae5', name: 'เขียว' },
        { hex: '#ffedd5', name: 'ส้ม' },
        { hex: '#fee2e2', name: 'แดงอ่อน' },
        { hex: '#fce7f3', name: 'ชมพู' },
        { hex: '#ede9fe', name: 'ม่วง' },
        { hex: '#f1f5f9', name: 'เทา (หยุด)' }
    ],

    colorIndex(hex) {
        const i = this.PRESET_COLORS.findIndex(c => c.hex === hex);
        return i < 0 ? this.PRESET_COLORS.length : i;   // unknown colours sort last
    },

    DEFAULT_COLOR: '#f1f5f9',

    // seed list transcribed from the real roster (labels left blank for the user)
    // ช่วงเวลาแยกตามชนิดวัน: slot=ธรรมดา · weSlot=เสาร์อาทิตย์ · phSlot=หยุดราชการ (ว่าง = เหมือนธรรมดา)
    //   'morning'=เช้า 'afternoon'=บ่าย 'night'=ดึก 'day'=กลางวัน — ขับกติกา X/ด + การจับคู่สุ่ม
    DEFAULT_MARKERS: [
        { id: 'ช', text: 'ช', deco: '', color: '#fef3c7', work: true, slot: 'morning' },
        { id: 'cP', text: '(ช)', deco: '', color: '#fef3c7', work: true, slot: 'morning' },
        { id: 'cO', text: 'ช', deco: 'circle', color: '#fef3c7', work: true, slot: 'morning' },
        { id: 'cA', text: 'ช*', deco: '', color: '#fef3c7', work: true, slot: 'morning' },
        { id: 'cU', text: 'ช', deco: 'underline', color: '#fef3c7', work: true, slot: 'morning' },
        { id: 'cB', text: 'ช', deco: 'box', color: '#fef3c7', work: true, slot: 'morning' },
        { id: 'cPlus', text: 'ช+', deco: '', color: '#fef3c7', work: true, slot: 'morning' },
        { id: 'cDeg', text: '(ช°)', deco: '', color: '#fef3c7', work: true, slot: 'morning' },
        { id: 'cC', text: 'ชC', deco: '', color: '#fef3c7', work: true, slot: 'morning' },
        { id: 'บ', text: 'บ', deco: '', color: '#dbeafe', work: true, slot: 'afternoon' },
        { id: 'bP', text: '(บ)', deco: '', color: '#dbeafe', work: true, slot: 'afternoon' },
        { id: 'bB', text: 'บ', deco: 'box', color: '#dbeafe', work: true, slot: 'afternoon' },
        { id: 'bS', text: 'บส', deco: '', color: '#dbeafe', work: true, slot: 'afternoon' },
        { id: 'smc', text: 'smc', deco: '', color: '#ccfbf1', work: true, slot: 'afternoon', weSlot: 'day', phSlot: 'day', light: true },
        { id: 'ด', text: 'ด', deco: '', color: '#e0e7ff', work: true, slot: 'night' },
        { id: 'x', text: 'x', deco: '', color: '#f1f5f9', work: false, slot: '' }
    ],

    // ช่วงเวลาที่มีผลจริงในวันนั้น ตามชนิดวัน (cat: 'weekday'|'weekend'|'pubhol')
    // 'day' (กลางวัน) นับเป็นช่วงเช้าในเชิงกติกา (ครองช่วงกลางวัน → ชนกับ ด)
    slotFlags(m, cat) {
        let s = m ? (m.slot || '') : '';
        if (m) {
            if (cat === 'weekend' && m.weSlot) s = m.weSlot;
            else if (cat === 'pubhol' && m.phSlot) s = m.phSlot;
        }
        return { morning: s === 'morning' || s === 'day', afternoon: s === 'afternoon', night: s === 'night' };
    },

    allPosIds() {
        return this.data.positions.map(p => p.id);
    },

    seedMarkers() {
        const all = this.allPosIds();
        this.data.markers = this.DEFAULT_MARKERS.map(m => ({ ...m, label: '', positions: all.slice() }));
    },

    getMarker(id) {
        return this.data.markers.find(m => m.id === id) || null;
    },

    // X = ห้ามอยู่ช่องเดียวกับเวรบ่าย · ด = ห้ามอยู่ช่องเดียวกับเวรเช้า
    isNoAfternoonMarker(m) { return !!m && (m.text || '').trim().toLowerCase() === 'x'; },
    isNoMorningMarker(m) { return !!m && (m.text || '').trim() === 'ด'; },

    // true if two markers must not share one day-cell (day-type aware — smc = บ่าย/กลางวัน)
    pairConflict(a, b, cat) {
        if (!a || !b) return false;
        const fa = this.slotFlags(a, cat), fb = this.slotFlags(b, cat);
        if ((this.isNoAfternoonMarker(a) && fb.afternoon) || (this.isNoAfternoonMarker(b) && fa.afternoon)) return true;
        if ((this.isNoMorningMarker(a) && fb.morning) || (this.isNoMorningMarker(b) && fa.morning)) return true;
        return false;
    },

    markerInPos(m, posId) {
        return !!(m.positions && m.positions.includes(posId));
    },

    toggleMarkerPosition(id, posId, on) {
        const m = this.getMarker(id);
        if (!m) return;
        if (!m.positions) m.positions = [];
        const has = m.positions.includes(posId);
        if (on && !has) m.positions.push(posId);
        else if (!on && has) m.positions = m.positions.filter(p => p !== posId);
        this.save();
    },

    addMarker() {
        const id = 'm' + Date.now() + Math.floor(Math.random() * 1000);
        this.data.markers.push({ id, text: '', deco: '', work: true, label: '', color: this.DEFAULT_COLOR, positions: this.allPosIds() });
        this.save();
        return id;
    },

    updateMarker(id, patch) {
        const m = this.getMarker(id);
        if (!m) return;
        Object.assign(m, patch);
        this.save();
    },

    // required day-of-week (0=อา..6=ส) for coverage checking
    toggleMarkerDow(id, dow, on) {
        const m = this.getMarker(id);
        if (!m) return;
        if (!m.reqDows) m.reqDows = [];
        const has = m.reqDows.includes(dow);
        if (on && !has) m.reqDows.push(dow);
        else if (!on && has) m.reqDows = m.reqDows.filter(d => d !== dow);
        this.save();
    },

    removeMarker(id) {
        this.data.markers = this.data.markers.filter(m => m.id !== id);
        Object.values(this.data.schedules).forEach(month => {
            Object.values(month).forEach(days => {
                Object.keys(days).forEach(d => { if (days[d] === id) delete days[d]; });
            });
        });
        this.save();
    },

    // ---- Back office: เครื่องหมายชุดแยก + ตารางเบิกเวร (บุคลากรลงเอง ไม่ยุ่งการสุ่ม/เผยแพร่) ----
    getBoMarker(id) { return (this.data.boMarkers || []).find(m => m.id === id) || null; },
    addBoMarker() {
        const id = 'bo' + Date.now() + Math.floor(Math.random() * 1000);
        if (!this.data.boMarkers) this.data.boMarkers = [];
        this.data.boMarkers.push({ id, text: '', color: this.DEFAULT_COLOR, label: '' });
        this.save();
        return id;
    },
    updateBoMarker(id, patch) { const m = this.getBoMarker(id); if (m) { Object.assign(m, patch); this.save(); } },
    removeBoMarker(id) {
        this.data.boMarkers = (this.data.boMarkers || []).filter(m => m.id !== id);
        Object.values(this.data.backoffice || {}).forEach(month => Object.values(month).forEach(days => {
            Object.keys(days).forEach(d => {
                const kept = (Array.isArray(days[d]) ? days[d] : [days[d]]).filter(x => x !== id);
                if (kept.length) days[d] = kept; else delete days[d];
            });
        }));
        this.save();
    },

    getBoCell(ymKey, staffId, day) {
        const m = this.data.backoffice && this.data.backoffice[ymKey] && this.data.backoffice[ymKey][staffId];
        const v = m && m[day];
        return Array.isArray(v) ? v.slice() : (v ? [v] : []);
    },
    setBoCell(ymKey, staffId, day, ids) {
        if (!this.data.backoffice) this.data.backoffice = {};
        if (!this.data.backoffice[ymKey]) this.data.backoffice[ymKey] = {};
        const m = this.data.backoffice[ymKey];
        if (!m[staffId]) m[staffId] = {};
        if (ids && ids.length) m[staffId][day] = ids.slice(0, 2); else delete m[staffId][day];
        this.save();
    },

    // ราคาค่าเวร แยกตาม กลุ่มงาน (posId) + ชนิดวัน (cat: 'weekday'|'weekend'|'pubhol') — เตรียมสรุปยอด (marker + boMarker ใช้ร่วมกัน)
    rateOf(m, posId, cat) {
        const p = m && m.prices && m.prices[posId], v = p && p[cat];
        return (v === 0 || v) ? Number(v) : 0;
    },
    _setRate(m, posId, cat, val) {
        if (!m) return;
        if (!m.prices) m.prices = {};
        if (!m.prices[posId]) m.prices[posId] = {};
        if (val === '' || val == null) delete m.prices[posId][cat]; else m.prices[posId][cat] = val;
        this.save();
    },
    setMarkerRate(id, posId, cat, val) { this._setRate(this.getMarker(id), posId, cat, val); },
    setBoMarkerRate(id, posId, cat, val) { this._setRate(this.getBoMarker(id), posId, cat, val); },

    ymKey(year, month) {
        return year + '-' + String(month).padStart(2, '0');
    },

    currentKey() {
        return this.ymKey(this.data.year, this.data.month);
    },

    // ---- draft comparison: ร่าง 1/2/3 PER POSITION ------------------------------
    // base store (ymKey) = ร่าง 1 ของทุกตำแหน่ง + pin ทั้งหมด (แหล่งจริง) · ร่าง 2/3 (ymKey::d2/d3) = เวรสุ่มของตำแหน่งที่เลือกร่างนั้น
    // activeDraft = { posId: n } — แต่ละตำแหน่งเลือกร่างของตัวเองอิสระ · เซลล์ของ staff อ่านจาก store ตามร่างของ "ตำแหน่ง" ตัวเอง
    draftMap() { const a = this.data.activeDraft; return (a && typeof a === 'object') ? a : {}; },
    activeDraftNum(posId) { return this.draftMap()[posId] || 1; },
    anyDraftActive() { return Object.values(this.draftMap()).some(n => n > 1); },
    draftKeyFor(ymKey, posId) { const n = this.activeDraftNum(posId); return n === 1 ? ymKey : ymKey + '::d' + n; },
    setActiveDraft(posId, n) {
        n = Math.max(1, Math.min(3, n | 0));
        if (!this.data.activeDraft || typeof this.data.activeDraft !== 'object') this.data.activeDraft = {};
        this.data.activeDraft[posId] = n;
        if (n > 1) { const k = this.currentKey() + '::d' + n; if (!this.data.schedules[k]) this.data.schedules[k] = {}; }
        this.save();
    },
    // draft store a given staff's random cells live in (resolved from their position's active draft)
    staffDraftKey(ymKey, staffId) {
        const s = this.data.staff.find(x => x.id === staffId);
        return this.draftKeyFor(ymKey, s ? s.pos : null);
    },
    // shifts that are shared across every draft (pin หรือ เจ้าหน้าที่เลือกเวรเอง) → อ่านจาก base
    sharedCell(ymKey, staffId, day) {
        if (this.isLockedCell(ymKey, staffId, day)) return true;
        const s = this.data.staff.find(x => x.id === staffId);
        return !!(s && s.pickOwn);
    },

    prevKey() {
        let y = this.data.year, m = this.data.month - 1;
        if (m < 1) { m = 12; y -= 1; }
        return this.ymKey(y, m);
    },

    // merged board: each staff's cells read from THEIR position's active draft (+ shared pin/pickOwn from base)
    effectiveBoard(ymKey) {
        const base = this.data.schedules[ymKey] || {};
        if (!this.anyDraftActive()) return JSON.parse(JSON.stringify(base));
        const [y, m] = ymKey.split('-').map(Number);
        const days = Schedule.daysInMonth(y, m);
        const board = {};
        this.data.staff.forEach(s => {
            for (let d = 1; d <= days; d++) {
                const c = this.getCellIn(ymKey, s.id, d);
                if (c.length) (board[s.id] = board[s.id] || {})[d] = c;
            }
        });
        return board;
    },

    // promote every position's active draft to the live/base board (ร่างที่เลือก = ตารางจริง) — scratch drafts consumed, back to ร่าง 1
    promoteActiveDraft(ymKey) {
        const board = this.effectiveBoard(ymKey);
        this.data.schedules[ymKey] = board;
        delete this.data.schedules[ymKey + '::d2'];
        delete this.data.schedules[ymKey + '::d3'];
        this.data.activeDraft = {};
    },

    // ---- per-position + per-MONTH publish (แต่ละกลุ่ม/แต่ละเดือนปล่อยเอง) --------------------------------
    // เดือนที่ยังไม่เผยแพร่ → เจ้าหน้าที่ไม่เห็น/แก้ไม่ได้ (กันเผลอกดล็อกเวรเดือนถัดไป)
    posPublished(posId, ymKey) {
        ymKey = ymKey || this.currentKey();
        const pp = this.data.publishedPos && this.data.publishedPos[ymKey];
        if (pp && pp[posId]) return true;
        // legacy per-month: เดือนนี้มี snapshot เผยแพร่ แต่ไม่มี record รายกลุ่ม → ถือว่าเผยแพร่ทุกกลุ่ม (กันตารางเดิมหาย)
        const snap = this.data.publishedSchedules && this.data.publishedSchedules[ymKey];
        if ((!pp || !Object.keys(pp).length) && snap && Object.keys(snap).length) return true;
        return false;
    },

    // promote ONE position's active draft into the live/base board, then reset that position to ร่าง 1
    promoteActiveDraftPos(ymKey, posId) {
        const [y, m] = ymKey.split('-').map(Number);
        const days = Schedule.daysInMonth(y, m);
        const base = this.data.schedules[ymKey] || (this.data.schedules[ymKey] = {});
        this.data.staff.filter(s => s.pos === posId).forEach(s => {
            const cells = {};
            for (let d = 1; d <= days; d++) { const c = this.getCellIn(ymKey, s.id, d); if (c.length) cells[d] = c; }  // effective (pins+draft)
            base[s.id] = cells;
            ['::d2', '::d3'].forEach(sfx => { const st = this.data.schedules[ymKey + sfx]; if (st) delete st[s.id]; });
        });
        if (this.data.activeDraft && typeof this.data.activeDraft === 'object') this.data.activeDraft[posId] = 1;
    },

    // เผยแพร่ = COPY "ร่างที่ admin ดูอยู่" ไปเป็นตารางบุคลากร (publishedSchedules) — ไม่แตะร่าง 1-3 (แยกตารางกัน)
    snapshotPublishedPos(ymKey, posId) {
        if (!this.data.publishedSchedules) this.data.publishedSchedules = {};
        const snap = this.data.publishedSchedules[ymKey] || (this.data.publishedSchedules[ymKey] = {});
        const [y, m] = ymKey.split('-').map(Number);
        const days = Schedule.daysInMonth(y, m);
        this.data.staff.filter(s => s.pos === posId).forEach(s => {
            const cells = {};
            for (let d = 1; d <= days; d++) { const c = this.getCellIn(ymKey, s.id, d); if (c.length) cells[d] = c; }   // ร่างที่เลือกอยู่ (getCellIn)
            snap[s.id] = cells;
        });
    },

    markPosPublished(posId) {
        if (!this.data.publishedPos || typeof this.data.publishedPos !== 'object') this.data.publishedPos = {};
        const ymKey = this.currentKey();
        const mm = this.data.publishedPos[ymKey] || (this.data.publishedPos[ymKey] = {});
        mm[posId] = new Date().toISOString();   // ISO → ใช้เทียบกับเวลาที่ staff แลกเวร (กันเวรแลกเก่าทับตารางที่เผยแพร่ใหม่)
        this.data.published = true;   // legacy month-level flag (any group published → login shows released)
        this.data.publishedAt = new Date().toLocaleString('th-TH');
    },

    // ยกเลิกเผยแพร่กลุ่มนี้ (เดือนปัจจุบัน) — เจ้าหน้าที่จะไม่เห็นตารางกลุ่มนี้ (จอเปล่า)
    unmarkPosPublished(posId) {
        if (!this.data.publishedPos || typeof this.data.publishedPos !== 'object') this.data.publishedPos = {};
        const ymKey = this.currentKey();
        const mm = this.data.publishedPos[ymKey] || (this.data.publishedPos[ymKey] = {});
        const snap = this.data.publishedSchedules && this.data.publishedSchedules[ymKey];
        if (!Object.keys(mm).length && snap && Object.keys(snap).length) {
            // legacy: เผยแพร่แบบเดือน (เห็นทุกกลุ่ม) → บันทึกกลุ่มอื่นเป็น "เผยแพร่แล้ว" ก่อน แล้วค่อยเอากลุ่มนี้ออก
            const now = new Date().toISOString();
            this.data.positions.forEach(p => { if (p.id !== posId) mm[p.id] = now; });
        } else {
            delete mm[posId];
        }
        if (!Object.keys(mm).length) delete this.data.publishedPos[ymKey];
        this.data.published = Object.values(this.data.publishedPos).some(m => m && Object.keys(m).length > 0);
    },

    // freeze a month's schedule as "published by admin" (snapshot ≠ the swap-editable live schedule) — publishes the ACTIVE draft
    snapshotPublished(ymKey) {
        if (!this.data.publishedSchedules) this.data.publishedSchedules = {};
        this.data.publishedSchedules[ymKey] = this.effectiveBoard(ymKey);
    },

    // did this staff hold this marker in LAST month's published schedule? (for month-to-month rotation)
    hadMarkerLastPublished(staffId, markerId) {
        const ps = this.data.publishedSchedules;
        const days = ps && ps[this.prevKey()] && ps[this.prevKey()][staffId];
        if (!days) return false;
        return Object.keys(days).some(d => {
            const v = days[d];
            return (Array.isArray(v) ? v : [v]).includes(markerId);
        });
    },

    // LIVE (แลกแล้ว) cell ของวันในเดือนก่อน: การแลก (swapOverlay) ทับตารางที่เผยแพร่ (publishedSchedules) — คนไม่แลกก็เท่าตารางเผยแพร่
    liveCellPrevMonth(staffId, eveYear, eveMonth, day) {
        const pk = this.ymKey(eveYear, eveMonth);
        const ov = this.data.swapOverlay && this.data.swapOverlay[pk] && this.data.swapOverlay[pk][staffId];
        const src = ov || (this.data.publishedSchedules && this.data.publishedSchedules[pk] && this.data.publishedSchedules[pk][staffId]);
        const v = src && src[day];
        return Array.isArray(v) ? v.slice() : (v ? [v] : []);
    },

    // เวรบ่ายในวันนั้นของเดือนก่อน (ตารางที่แลกแล้ว) — ใช้กัน ดึกวันที่ 1 ชน บ่ายวันสุดท้ายเดือนก่อน (x ก่อนดึกจะทับบ่าย)
    prevMonthHasAfternoon(staffId, eve) {
        const ids = this.liveCellPrevMonth(staffId, eve.year, eve.month, eve.day);
        if (!ids.length) return false;
        const cat = Schedule.dayCategory(eve.year, eve.month, eve.day);
        return ids.some(id => this.slotFlags(this.getMarker(id), cat).afternoon);
    },

    // Assignment map for the active month (created lazily)
    currentSchedule() {
        const key = this.currentKey();
        if (!this.data.schedules[key]) this.data.schedules[key] = {};
        return this.data.schedules[key];
    },

    // a cell holds up to 2 marker ids; normalize legacy string values to array
    getCell(staffId, day) {
        return this.getCellIn(this.currentKey(), staffId, day);
    },

    // ตารางบุคลากร (staff) เก็บแยกจากร่าง admin — data.schedules ไม่ถูก staff แตะเด็ดขาด (กันตารางแลกทับร่าง)
    staffBoardRoot() { return this.data.staffBoard || (this.data.staffBoard = {}); },

    // MANUAL edit (current month): staff → staffBoard · admin: shared cell (pin/เลือกเวรเอง) → base · อื่น → draft store
    setCell(staffId, day, ids) {
        const key = this.currentKey();
        if (this.isStaff()) { this.setCellIn(key, staffId, day, ids); return; }
        if (this.sharedCell(key, staffId, day)) this.setCellBase(key, staffId, day, ids);
        else this.setCellIn(key, staffId, day, ids);
    },

    // read a cell: staff → staffBoard[ymKey] · admin → schedules (shared pin/pickOwn จาก base, อื่น = draft store ของตำแหน่ง)
    getCellIn(ymKey, staffId, day) {
        let root, store;
        if (this.isStaff()) { root = this.staffBoardRoot(); store = ymKey; }
        else {
            root = this.data.schedules; store = ymKey;   // fast path: ไม่มีร่าง active → base (hot path ตอนสุ่ม)
            if (this.anyDraftActive() && !this.sharedCell(ymKey, staffId, day)) store = this.staffDraftKey(ymKey, staffId);
        }
        const m = root[store];
        const v = m && m[staffId] && m[staffId][day];
        if (Array.isArray(v)) return v.slice();
        return v ? [v] : [];
    },

    // MANUAL write to base store (shared across drafts) — for pins incl. cross-month night pairs (admin เท่านั้น)
    setCellBase(ymKey, staffId, day, ids) {
        if (!this.data.schedules[ymKey]) this.data.schedules[ymKey] = {};
        const m = this.data.schedules[ymKey];
        if (!m[staffId]) m[staffId] = {};
        if (ids && ids.length) m[staffId][day] = ids.slice(0, this.MAX_CELL);
        else delete m[staffId][day];
        this.save();
    },

    // RANDOMIZER/draft write · staff แลกเวร → staffBoard[ymKey] · admin → draft store ของตำแหน่ง (ร่าง 2/3 แยก · ร่าง 1 = base)
    setCellIn(ymKey, staffId, day, ids) {
        const root = this.isStaff() ? this.staffBoardRoot() : this.data.schedules;
        const store = this.isStaff() ? ymKey : this.staffDraftKey(ymKey, staffId);
        if (!root[store]) root[store] = {};
        const m = root[store];
        if (!m[staffId]) m[staffId] = {};
        if (ids && ids.length) m[staffId][day] = ids.slice(0, this.MAX_CELL);
        else delete m[staffId][day];
        this.save();
    },

    // ---- manual locks: cells the admin picked by hand are pinned so สุ่ม keeps them ----
    lockCell(ymKey, staffId, day) {
        if (!this.data.locks) this.data.locks = {};
        if (!this.data.locks[ymKey]) this.data.locks[ymKey] = {};
        const arr = this.data.locks[ymKey][staffId] || (this.data.locks[ymKey][staffId] = []);
        if (!arr.includes(day)) { arr.push(day); this.save(); }
    },
    unlockCell(ymKey, staffId, day) {
        const m = this.data.locks && this.data.locks[ymKey] && this.data.locks[ymKey][staffId];
        if (!m) return;
        const i = m.indexOf(day);
        if (i >= 0) { m.splice(i, 1); this.save(); }
    },
    isLockedCell(ymKey, staffId, day) {
        const m = this.data.locks && this.data.locks[ymKey] && this.data.locks[ymKey][staffId];
        return !!(m && m.includes(day));
    },
    lockedDaysFor(ymKey, staffId) {
        const m = this.data.locks && this.data.locks[ymKey] && this.data.locks[ymKey][staffId];
        return m ? m.slice() : [];
    },
    clearLocksFor(ymKey, staffIds) {
        const m = this.data.locks && this.data.locks[ymKey];
        if (!m) return;
        staffIds.forEach(id => { delete m[id]; });
    },

    addStaff(name, role, pos) {
        const id = 's' + Date.now() + Math.floor(Math.random() * 1000);
        this.data.staff.push({ id, name: name.trim(), role: (role || '').trim(), pos: pos || this.firstPosId() });
        this.save();
        return id;
    },

    removeStaff(id) {
        this.data.staff = this.data.staff.filter(s => s.id !== id);
        // also drop this staff's assignments across all months
        Object.values(this.data.schedules).forEach(m => { delete m[id]; });
        this.save();
    },

    renameStaff(id, name, role) {
        const s = this.data.staff.find(x => x.id === id);
        if (!s) return;
        s.name = name.trim();
        if (role !== undefined) s.role = role.trim();
        this.save();
    },

    // per-person capability: which markers they may do (blocked = cannot)
    setBlockedMarker(staffId, markerId, blocked) {
        const s = this.data.staff.find(x => x.id === staffId);
        if (!s) return;
        if (!s.blockedMarkers) s.blockedMarkers = [];
        const i = s.blockedMarkers.indexOf(markerId);
        if (blocked && i < 0) s.blockedMarkers.push(markerId);
        else if (!blocked && i >= 0) s.blockedMarkers.splice(i, 1);
        this.save();
    },

    canDoMarker(s, markerId) {
        return !(s.blockedMarkers && s.blockedMarkers.includes(markerId));
    },

    // per-person day-specific ban: cannot do markerId on this day-of-week (e.g. ห้าม ด / บ วันจันทร์)
    toggleDayBan(staffId, markerId, dow, on) {
        const s = this.data.staff.find(x => x.id === staffId);
        if (!s) return;
        if (!s.dayBans) s.dayBans = {};
        const arr = s.dayBans[markerId] || [];
        const i = arr.indexOf(dow);
        if (on && i < 0) arr.push(dow);
        else if (!on && i >= 0) arr.splice(i, 1);
        if (arr.length) s.dayBans[markerId] = arr; else delete s.dayBans[markerId];
        this.save();
    },

    markerBannedOn(s, markerId, dow) {
        return !!(s.dayBans && s.dayBans[markerId] && s.dayBans[markerId].includes(dow));
    },

    // per-person "must get ≥1 of this marker per month" (e.g. บางคนต้องได้ smc 1 เวร)
    mustHaveMarker(s, markerId) {
        return !!(s.mustHave && s.mustHave.includes(markerId));
    },

    toggleMustHave(staffId, markerId, on) {
        const s = this.data.staff.find(x => x.id === staffId);
        if (!s) return;
        if (!s.mustHave) s.mustHave = [];
        const i = s.mustHave.indexOf(markerId);
        if (on && i < 0) s.mustHave.push(markerId);
        else if (!on && i >= 0) s.mustHave.splice(i, 1);
        this.save();
    },

    // ---- custom holidays (beYear -> { 'MM-DD': name }) ----
    addHoliday(year, month, day, name) {
        year = parseInt(year, 10); month = parseInt(month, 10); day = parseInt(day, 10);
        if (!year || !month || !day) return false;
        const key = String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
        if (!this.data.customHolidays) this.data.customHolidays = {};
        if (!this.data.customHolidays[year]) this.data.customHolidays[year] = {};
        this.data.customHolidays[year][key] = (name || '').trim() || 'วันหยุด';
        this.save();
        return true;
    },

    removeHoliday(year, key) {
        const y = this.data.customHolidays && this.data.customHolidays[year];
        if (!y) return;
        delete y[key];
        if (!Object.keys(y).length) delete this.data.customHolidays[year];
        this.save();
    },

    // ---- leave days per month (with priority order) ----
    getLeave(ymKey, staffId) {
        const m = this.data.leaves && this.data.leaves[ymKey];
        return (m && m[staffId]) ? m[staffId].slice() : [];
    },

    ensureLeaveOrder(ymKey) {
        if (!this.data.leaveOrder) this.data.leaveOrder = {};
        if (!this.data.leaveOrder[ymKey]) this.data.leaveOrder[ymKey] = [];
        return this.data.leaveOrder[ymKey];
    },

    // staff who have leave this month, in priority order (0 = most protected)
    getLeaveOrder(ymKey) {
        const ord = (this.data.leaveOrder && this.data.leaveOrder[ymKey]) || [];
        const lv = (this.data.leaves && this.data.leaves[ymKey]) || {};
        return ord.filter(id => lv[id] && lv[id].length);
    },

    leavePriority(ymKey, staffId) { return this.getLeaveOrder(ymKey).indexOf(staffId); },

    toggleLeave(ymKey, staffId, day) {
        if (!this.data.leaves) this.data.leaves = {};
        if (!this.data.leaves[ymKey]) this.data.leaves[ymKey] = {};
        const arr = this.data.leaves[ymKey][staffId] || [];
        const i = arr.indexOf(day);
        if (i < 0) arr.push(day); else arr.splice(i, 1);
        const ord = this.ensureLeaveOrder(ymKey);
        if (arr.length) {
            this.data.leaves[ymKey][staffId] = arr;
            if (!ord.includes(staffId)) ord.push(staffId);   // new requester → lowest priority
        } else {
            delete this.data.leaves[ymKey][staffId];
            const oi = ord.indexOf(staffId); if (oi >= 0) ord.splice(oi, 1);
        }
        this.save();
    },

    moveLeavePriority(ymKey, staffId, dir) {
        const ord = this.ensureLeaveOrder(ymKey);
        const i = ord.indexOf(staffId), j = i + dir;
        if (i < 0 || j < 0 || j >= ord.length) return;
        [ord[i], ord[j]] = [ord[j], ord[i]];
        this.save();
    },

    clearLeave(ymKey, staffId) {
        if (this.data.leaves && this.data.leaves[ymKey]) delete this.data.leaves[ymKey][staffId];
        const ord = this.ensureLeaveOrder(ymKey);
        const i = ord.indexOf(staffId); if (i >= 0) ord.splice(i, 1);
        this.save();
    },

    // ---- half-month split shifts (shared by 2 positions) ----
    splitForMarker(markerId) { return (this.data.splits || []).find(sp => sp.markerId === markerId) || null; },

    splitFlipped(ymKey, splitId) {
        return !!(this.data.splitFlip && this.data.splitFlip[ymKey] && this.data.splitFlip[ymKey][splitId]);
    },

    // which position covers this split marker on this day (respects the per-month flip)
    splitPosFor(sp, ymKey, day) {
        const flipped = this.splitFlipped(ymKey, sp.id);
        const inFirst = day <= (sp.boundary || 15);
        const first = flipped ? sp.posSecond : sp.posFirst;
        const second = flipped ? sp.posFirst : sp.posSecond;
        return inFirst ? first : second;
    },

    addSplit() {
        const id = 'sp' + Date.now() + Math.floor(Math.random() * 1000);
        if (!this.data.splits) this.data.splits = [];
        const p = this.data.positions;
        this.data.splits.push({
            id, markerId: '',
            posFirst: p[0] ? p[0].id : '',
            posSecond: p[1] ? p[1].id : (p[0] ? p[0].id : ''),
            boundary: 15
        });
        this.save();
        return id;
    },

    // keep the shared marker assigned to both positions so it appears in both tables
    _syncSplitMarkerPos(sp) {
        const m = this.getMarker(sp.markerId);
        if (!m) return;
        if (!m.positions) m.positions = [];
        [sp.posFirst, sp.posSecond].forEach(pid => { if (pid && !m.positions.includes(pid)) m.positions.push(pid); });
    },

    updateSplit(id, patch) {
        const sp = (this.data.splits || []).find(s => s.id === id);
        if (!sp) return;
        Object.assign(sp, patch);
        this._syncSplitMarkerPos(sp);
        this.save();
    },

    removeSplit(id) {
        this.data.splits = (this.data.splits || []).filter(s => s.id !== id);
        this.save();
    },

    toggleSplitFlip(ymKey, splitId) {
        if (!this.data.splitFlip) this.data.splitFlip = {};
        if (!this.data.splitFlip[ymKey]) this.data.splitFlip[ymKey] = {};
        this.data.splitFlip[ymKey][splitId] = !this.data.splitFlip[ymKey][splitId];
        this.save();
    },

    // remove the night-pair x sitting on the PREVIOUS month's last day (orphaned when this month is cleared/re-randomized)
    clearCrossMonthX(staffIds) {
        const prev = Schedule.shiftDate(this.data.year, this.data.month, 1, -1);
        const prevKey = this.ymKey(prev.year, prev.month);
        const xM = this.data.markers.find(m => (m.text || '').trim().toLowerCase() === 'x');
        if (!xM) return;
        staffIds.forEach(id => {
            if (this.isLockedCell(prevKey, id, prev.day)) return;   // manual pin (คู่ ด วันที่ 1) — คงไว้
            const arr = this.getCellIn(prevKey, id, prev.day);
            if (arr.includes(xM.id)) this.setCellIn(prevKey, id, prev.day, arr.filter(v => v !== xM.id));
        });
    },

    // clear the active-draft random cells for these staff (each in their position's draft store), KEEPING shared pin/pickOwn
    clearActiveDraftCells(ids) {
        const key = this.currentKey();
        ids.forEach(id => {
            const store = this.data.schedules[this.staffDraftKey(key, id)];
            if (!store || !store[id]) return;
            Object.keys(store[id]).forEach(dStr => { if (!this.sharedCell(key, id, +dStr)) delete store[id][+dStr]; });
            if (!Object.keys(store[id]).length) delete store[id];
        });
    },

    clearMonth() {
        const ids = this.data.staff.map(s => s.id);
        this.clearActiveDraftCells(ids);
        this.clearCrossMonthX(ids);
        this.save();
    },

    // clear this month's shifts for one position's staff only
    clearMonthPos(posId) {
        const ids = this.data.staff.filter(s => s.pos === posId).map(s => s.id);
        this.clearActiveDraftCells(ids);
        this.clearCrossMonthX(ids);
        this.save();
    },

    clearAllStaff() {
        this.data.staff = [];
        this.data.schedules = {};
        this.save();
    },

    save() {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.data));
        } catch (e) {
            console.warn('save failed', e);
        }
        if (typeof this.onChange === 'function') this.onChange();
    },

    load() {
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY);
            if (raw) Object.assign(this.data, JSON.parse(raw));
        } catch (e) {
            console.warn('load failed', e);
        }
        this._postLoad();
    },

    // replace the whole data set (e.g. pulled published state from Sheet) then persist
    // เดือน/ปีที่กำลังดู = view state ต่อเครื่อง — ไม่เอาค่าจากชีตมาทับ (กันเด้งกลับเดือนที่ admin เซฟไว้)
    loadFrom(obj) {
        const y = this.data.year, m = this.data.month, ad = this.data.activeDraft;
        Object.assign(this.data, obj);
        if (y) this.data.year = y;
        if (m) this.data.month = m;
        // ร่าง/เดือนที่กำลังดู = view state ต่อเครื่อง — คงของเครื่องตัวเอง ไม่รับของเครื่องอื่นมา
        // (admin คงร่างที่ทำอยู่ · staff ถูกล้างเป็น {} ใน applyRole เพราะไม่ใช้ระบบร่าง)
        this.data.activeDraft = (ad && typeof ad === 'object') ? ad : {};
        this._postLoad();
        this.applySwapOverlay();   // staff → สร้างตารางบุคลากร (เผยแพร่+แลก) · admin → คงร่าง 1-3
        this.save();
    },

    // staff: สร้าง "ตารางบุคลากร" ลง data.staffBoard (แยกจาก data.schedules = ร่าง admin) = publishedSchedules + การแลก (overlay)
    // admin: ไม่แตะทั้ง schedules(ร่าง) และ staffBoard → เห็นร่าง 1-3 · เก็บ swapOverlay ไว้ให้ตัวสุ่มอ่านเวรบ่ายวันสุดท้ายเดือนก่อน
    applySwapOverlay() {
        if (!this.isStaff()) return;
        const pub = this.data.publishedSchedules || {}, ov = this.data.swapOverlay || {};
        const board = this.data.staffBoard = {};   // สร้างใหม่ทุกครั้งจากต้นฉบับที่เผยแพร่ + การแลกล่าสุด
        Object.keys(pub).forEach(ym => { board[ym] = JSON.parse(JSON.stringify(pub[ym] || {})); });
        Object.keys(ov).forEach(ym => {
            const store = board[ym] = board[ym] || {};
            Object.keys(ov[ym]).forEach(sid => {
                const cells = ov[ym][sid];
                if (cells && Object.keys(cells).length) store[sid] = cells; else delete store[sid];
            });
        });
        this.data.swapOverlay = null;
    },

    _postLoad() {
        // default to current month (Buddhist year) when unset
        if (!this.data.year || !this.data.month) {
            const now = new Date();
            this.data.year = now.getFullYear() + 543;
            this.data.month = now.getMonth() + 1;
        }
        if (!this.data.positions || !this.data.positions.length) this.seedPositions();
        if (!this.data.boMarkers) this.data.boMarkers = [];
        if (!this.data.backoffice) this.data.backoffice = {};
        if (!this.data.staffBoard) this.data.staffBoard = {};   // ตารางบุคลากร (staff) แยกจากร่าง admin
        if (!this.data.workplaces) this.seedWorkplaces();
        this.data.workplaces.forEach(w => { if (!w.noNightDows) w.noNightDows = []; if (!w.noNightPos) w.noNightPos = []; });
        if (!this.data.markers || !this.data.markers.length) this.seedMarkers();

        // migrate publishedPos: global { posId: ts } → per-month { ymKey: { posId: ts } }
        if (!this.data.publishedPos || typeof this.data.publishedPos !== 'object') this.data.publishedPos = {};
        else {
            const vals = Object.values(this.data.publishedPos);
            if (vals.length && vals.every(v => typeof v === 'string')) this.data.publishedPos = { [this.currentKey()]: this.data.publishedPos };
        }

        // migrate records saved before the position dimension existed
        const fb = this.firstPosId();
        this.data.staff.forEach(s => { if (!s.pos) s.pos = fb; });
        // markers are shared across positions by default (use all current positions)
        const all = this.allPosIds();
        this.data.markers.forEach(m => {
            if (!m.positions) m.positions = all.slice();
            delete m.pos;
            // migrate morning/afternoon booleans → slot enum
            if (m.slot === undefined) {
                m.slot = m.morning ? 'morning' : m.afternoon ? 'afternoon'
                    : (m.text || '').trim() === 'ด' ? 'night' : '';
            }
            // migrate hSlot (หยุดรวม) → แยก เสาร์อาทิตย์ / หยุดราชการ
            if (m.weSlot === undefined) m.weSlot = m.hSlot || '';
            if (m.phSlot === undefined) m.phSlot = m.hSlot || '';
            // migrate reqHoliday (ส-อา+ราชการรวม) → แยก ส-อา / ราชการ
            if (m.reqWeekend === undefined) m.reqWeekend = !!m.reqHoliday;
            if (m.reqPubHol === undefined) m.reqPubHol = !!m.reqHoliday;
            // "ครึ่งวัน" (light) — smc เป็นเวรเบาโดยปริยาย (ใช้กับกติกาพักเสาร์-อาทิตย์)
            if (m.light === undefined) m.light = (m.text || '').trim().toLowerCase() === 'smc';
            // ราคาเดี่ยว (price) → prices { posId: { weekday } } แยกกลุ่มงาน + ชนิดวัน
            if (m.price != null && !m.prices) { m.prices = {}; (m.positions || all).forEach(pid => { m.prices[pid] = { weekday: m.price }; }); }
            delete m.price;
        });
        (this.data.boMarkers || []).forEach(m => {
            if (m.price != null && !m.prices) { m.prices = {}; all.forEach(pid => { m.prices[pid] = { weekday: m.price }; }); }
            delete m.price;
        });
    }
};
