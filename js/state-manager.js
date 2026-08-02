// Data model + localStorage persistence. Single shared global: App
const App = {
    STORAGE_KEY: 'detudom_shift_scheduler_v1',

    data: {
        unit: '',
        sheetUrl: '',     // Google Apps Script web-app URL for push
        autoSync: false,  // auto pull on load + debounced push on change
        published: false, // admin has released the schedule to staff
        publishedAt: '',  // human-readable timestamp of last publish
        year: 0,          // พ.ศ.
        month: 0,         // 1-12
        positions: [],    // [{ id, name }] — เภสัชกร / เจ้าพนักงานเภสัชกรรม ...
        workplaces: [],   // [{ id, name, noNightDows:[] }] — OPD/IPD... · noNightDows = วันที่ต้องมาครบ (สุ่มเลี่ยง ด)
        staff: [],        // [{ id, name, role, pos, workplace }]
        markers: [],      // [{ id, text, deco, color, group, work, label, pos }]
        schedules: {},    // { 'YYYY-MM': { staffId: { day: markerId } } }
        customHolidays: {}, // { beYear: { 'MM-DD': name } } — user-added holidays for future years
        leaves: {},       // { 'YYYY-MM': { staffId: [dayNumbers] } } — leave days per month
        leaveOrder: {}    // { 'YYYY-MM': [staffId...] } — priority order (index 0 = requested first = most protected)
    },

    // ---- session (role login, not synced) ----
    SESSION_KEY: 'detudom_shift_session_v1',
    session: { role: null, staffId: null },   // role: 'admin' | 'staff' | null

    loadSession() {
        try { const r = localStorage.getItem(this.SESSION_KEY); if (r) this.session = JSON.parse(r); }
        catch (e) { /* ignore */ }
    },
    saveSession() { try { localStorage.setItem(this.SESSION_KEY, JSON.stringify(this.session)); } catch (e) { /* ignore */ } },
    setSession(role, staffId) { this.session = { role, staffId: staffId || null }; this.saveSession(); },
    logout() { this.session = { role: null, staffId: null }; this.saveSession(); },
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
        { id: 'smc', text: 'smc', deco: '', color: '#ccfbf1', work: true, slot: 'afternoon', weSlot: 'day', phSlot: 'day' },
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

    ymKey(year, month) {
        return year + '-' + String(month).padStart(2, '0');
    },

    currentKey() {
        return this.ymKey(this.data.year, this.data.month);
    },

    // Assignment map for the active month (created lazily)
    currentSchedule() {
        const key = this.currentKey();
        if (!this.data.schedules[key]) this.data.schedules[key] = {};
        return this.data.schedules[key];
    },

    // a cell holds up to 2 marker ids; normalize legacy string values to array
    getCell(staffId, day) {
        const sched = this.currentSchedule();
        const v = sched[staffId] && sched[staffId][day];
        if (Array.isArray(v)) return v.slice();
        return v ? [v] : [];
    },

    setCell(staffId, day, ids) {
        const sched = this.currentSchedule();
        if (!sched[staffId]) sched[staffId] = {};
        if (ids && ids.length) sched[staffId][day] = ids.slice(0, 2);
        else delete sched[staffId][day];
        this.save();
    },

    // read/write a cell in an arbitrary month (for cross-month night links)
    getCellIn(ymKey, staffId, day) {
        const m = this.data.schedules[ymKey];
        const v = m && m[staffId] && m[staffId][day];
        if (Array.isArray(v)) return v.slice();
        return v ? [v] : [];
    },

    setCellIn(ymKey, staffId, day, ids) {
        if (!this.data.schedules[ymKey]) this.data.schedules[ymKey] = {};
        const m = this.data.schedules[ymKey];
        if (!m[staffId]) m[staffId] = {};
        if (ids && ids.length) m[staffId][day] = ids.slice(0, 2);
        else delete m[staffId][day];
        this.save();
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

    clearMonth() {
        this.data.schedules[this.currentKey()] = {};
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
    loadFrom(obj) {
        Object.assign(this.data, obj);
        this._postLoad();
        this.save();
    },

    _postLoad() {
        // default to current month (Buddhist year) when unset
        if (!this.data.year || !this.data.month) {
            const now = new Date();
            this.data.year = now.getFullYear() + 543;
            this.data.month = now.getMonth() + 1;
        }
        if (!this.data.positions || !this.data.positions.length) this.seedPositions();
        if (!this.data.workplaces) this.seedWorkplaces();
        this.data.workplaces.forEach(w => { if (!w.noNightDows) w.noNightDows = []; if (!w.noNightPos) w.noNightPos = []; });
        if (!this.data.markers || !this.data.markers.length) this.seedMarkers();

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
        });
    }
};
