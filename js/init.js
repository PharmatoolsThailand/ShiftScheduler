// Bootstrap + event binding
(function () {
    App.loadSession();
    App.load();
    Auth.initUrl();
    UI.render();
    Auth.applyRole();

    // admin: any local edit auto-syncs to the Sheet (debounced)
    App.onChange = () => Auth.queueAdminPush();

    // --- Auth / role controls ---
    UI.el('loginAdminBtn').addEventListener('click', () => Auth.loginAdmin());
    UI.el('loginStaffBtn').addEventListener('click', () => Auth.loginStaff());
    UI.el('loginPos').addEventListener('change', () => Auth.fillGateNames());
    UI.el('logoutBtn').addEventListener('click', () => Auth.logout());
    UI.el('refreshBtn').addEventListener('click', () => Auth.refresh());
    UI.el('publishBtn').addEventListener('click', () => Auth.publish());

    // --- Tab switching ---
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === tab));
            if (tab === 'schedule') UI.renderScheduleTab();
            if (tab === 'leave') UI.renderLeaveTab();
        });
    });

    // --- General controls ---
    UI.el('unitInput').addEventListener('input', e => {
        App.data.unit = e.target.value;
        App.save();
        document.querySelectorAll('.pos-sub').forEach(el => el.textContent = UI.monthTitle());
    });
    UI.el('monthSelect').addEventListener('change', e => {
        App.data.month = parseInt(e.target.value, 10);
        App.save();
        UI.renderScheduleTab();
    });
    UI.el('yearInput').addEventListener('change', e => {
        const y = parseInt(e.target.value, 10);
        if (y >= 2500 && y <= 2700) {
            App.data.year = y;
            App.save();
            UI.renderScheduleTab();
        }
    });
    UI.el('printBtn').addEventListener('click', () => window.print());
    UI.el('randomBtn').addEventListener('click', () => UI.openRandomModal());

    // --- Randomize popup ---
    UI.el('randomCancel').addEventListener('click', () => UI.closeRandomModal());
    UI.el('randomModal').addEventListener('click', e => { if (e.target.id === 'randomModal') UI.closeRandomModal(); });
    UI.el('randomPickOwn').addEventListener('change', e => {
        const chk = e.target.closest('.pickown-chk');
        if (!chk) return;
        const s = App.data.staff.find(x => x.id === chk.dataset.id);
        if (s) { s.pickOwn = chk.checked; App.save(); }
    });
    UI.el('capMarkers').addEventListener('change', e => {
        const chk = e.target.closest('.cap-chk');
        if (chk && UI.editingCapStaff) App.setBlockedMarker(UI.editingCapStaff, chk.dataset.marker, !chk.checked);
    });
    UI.el('capClose').addEventListener('click', () => UI.closeCapModal());
    UI.el('capModal').addEventListener('click', e => { if (e.target.id === 'capModal') UI.closeCapModal(); });
    UI.el('randomRun').addEventListener('click', () => {
        if (!confirm('สุ่มเวรเดือนนี้? เวรของคนที่ถูกสุ่มจะถูกล้างแล้วสุ่มใหม่\n(คนเลือกเอง/ลาศึกษา ไม่ถูกแตะ)')) return;
        let filled = 0, total = 0, doubles = 0, nightViol = 0, aftViol = 0, consecViol = 0; const unfilled = [], broken = [], errs = [];
        App.data.positions.forEach(p => {
            const r = Randomizer.run(p.id);
            if (r.error) { errs.push(r.error); return; }
            filled += r.filled; total += r.total; doubles += r.doubles || 0; nightViol += r.nightViol || 0; aftViol += r.aftViol || 0; consecViol += r.consecViol || 0;
            r.unfilled.forEach(u => unfilled.push(u));
            r.broken.forEach(b => broken.push(b));
        });
        UI.renderScheduleTab();
        const el = UI.el('randomResult');
        if (total === 0) { el.textContent = 'สุ่มไม่ได้ — ' + (errs.join(' · ') || 'ไม่มีข้อมูล'); el.className = 'random-result err'; return; }
        let msg = '✓ เติม ' + filled + '/' + total + ' ช่อง';
        if (doubles) msg += ' · ขึ้นคู่ ' + doubles + ' ช่อง';
        if (nightViol) msg += ' · ดึกติดกัน<5วัน ' + nightViol;
        if (aftViol) msg += ' · บ่ายกระจุก ' + aftViol;
        if (consecViol) msg += ' · ทำงานเกิน ' + Randomizer.MAX_CONSEC + 'วันติด ' + consecViol + ' จุด';
        if (unfilled.length) msg += ' · เว้น ' + unfilled.length + ' (คนไม่พอจริง)';
        if (broken.length) {
            const by = {};
            broken.forEach(b => { const n = (App.data.staff.find(s => s.id === b.staffId) || {}).name || '?'; (by[n] = by[n] || []).push(b.day); });
            msg += ' · ดึงคนลามาลง: ' + Object.keys(by).map(n => n + ' (วัน ' + by[n].sort((a, c) => a - c).join(',') + ')').join(' · ');
        }
        el.textContent = msg; el.className = 'random-result ' + (unfilled.length || broken.length ? 'warn' : 'ok');
    });

    // --- Leave tab ---
    UI.el('leaveAddBtn').addEventListener('click', () => {
        const id = UI.el('leaveAddSelect').value;
        if (id) UI.openLeaveModal(id);
    });
    UI.el('leaveTable').addEventListener('click', e => {
        const mv = e.target.closest('.leave-move');
        if (mv) { App.moveLeavePriority(App.currentKey(), mv.closest('tr').dataset.id, parseInt(mv.dataset.dir, 10)); UI.renderLeaveTab(); return; }
        const ed = e.target.closest('.leave-edit');
        if (ed) { UI.openLeaveModal(ed.dataset.id); return; }
        const cl = e.target.closest('.leave-clear');
        if (cl) { App.clearLeave(App.currentKey(), cl.dataset.id); UI.renderLeaveTab(); UI.renderScheduleTab(); return; }
    });
    UI.el('clearMonthBtn').addEventListener('click', () => {
        if (confirm('ล้างเวรทั้งหมดของเดือนนี้? (รายชื่อบุคลากรยังอยู่)')) {
            App.clearMonth();
            UI.renderScheduleTab();
        }
    });

    // --- Schedule container: cell popover + staff actions (delegated) ---
    const container = UI.el('scheduleContainer');

    container.addEventListener('click', e => {
        const dayHead = e.target.closest('th.day-col');
        if (dayHead && App.isAdmin()) { UI.openHolidayModal(dayHead); return; }
        const cell = e.target.closest('td.cell');
        if (cell) { UI.openCellPopover(cell); e.stopPropagation(); }
    });

    // --- Cell popover actions ---
    const popover = UI.el('cellPopover');
    popover.addEventListener('click', e => {
        e.stopPropagation();
        const pick = e.target.closest('.cp-pick');
        if (pick && !pick.disabled) { UI.addToCell(pick.dataset.id); return; }
        const del = e.target.closest('.cp-del');
        if (del) { UI.removeFromCell(parseInt(del.dataset.idx, 10)); return; }
        if (e.target.closest('.cp-clear')) { UI.clearCell(); return; }
        if (e.target.closest('.cp-close')) { UI.closePopover(); return; }
    });
    document.addEventListener('click', () => UI.closePopover());
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { UI.closePopover(); UI.closeHolidayModal(); UI.closeLeaveModal(); UI.closeCapModal(); UI.closeRandomModal(); } });

    // --- Leave popup ---
    UI.el('leaveDays').addEventListener('click', e => {
        const b = e.target.closest('.leave-day');
        if (!b || !UI.editingLeaveStaff) return;
        App.toggleLeave(App.currentKey(), UI.editingLeaveStaff, parseInt(b.dataset.day, 10));
        UI.renderLeaveDays();
    });
    UI.el('leaveModalClose').addEventListener('click', () => UI.closeLeaveModal());
    UI.el('leaveModal').addEventListener('click', e => { if (e.target.id === 'leaveModal') UI.closeLeaveModal(); });

    // --- Holiday popup ---
    UI.el('holModalSave').addEventListener('click', () => UI.saveHolidayModal());
    UI.el('holModalDelete').addEventListener('click', () => UI.deleteHolidayModal());
    UI.el('holModalCancel').addEventListener('click', () => UI.closeHolidayModal());
    UI.el('holidayModal').addEventListener('click', e => { if (e.target.id === 'holidayModal') UI.closeHolidayModal(); });
    UI.el('holModalName').addEventListener('keydown', e => { if (e.key === 'Enter') UI.saveHolidayModal(); });

    container.addEventListener('dblclick', e => {
        const row = e.target.closest('tr[data-staff]');
        if (!row || !e.target.closest('.staff-col')) return;
        const s = App.data.staff.find(x => x.id === row.dataset.staff);
        if (!s) return;
        const name = prompt('ชื่อ-สกุล:', s.name);
        if (name === null) return;
        const role = prompt('ตำแหน่ง (เว้นว่างได้):', s.role || '');
        App.renameStaff(s.id, name || s.name, role === null ? s.role : role);
        UI.render();
    });

    // --- Staff editor tab ---
    const staffTable = UI.el('staffTable');

    function addRow() {
        const id = App.addStaff('', '');
        UI.renderStaffEditor();
        UI.renderScheduleTab();
        const inp = document.querySelector(`#staffTable tr[data-id="${id}"] .staff-inp[data-field="name"]`);
        if (inp) inp.focus();
    }
    UI.el('addRowBtn').addEventListener('click', addRow);
    UI.el('clearStaffBtn').addEventListener('click', () => {
        if (!App.data.staff.length) return;
        if (confirm('ลบรายชื่อบุคลากรทั้งหมด และตารางเวรทุกเดือน?')) {
            App.clearAllStaff();
            UI.render();
        }
    });

    staffTable.addEventListener('input', e => {
        const mi = e.target.closest('.max-inp');
        if (mi) {
            const s = App.data.staff.find(x => x.id === mi.dataset.id);
            if (s) { const v = parseInt(mi.value, 10); s.maxShifts = (v > 0) ? v : 0; App.save(); }
            return;
        }
        const inp = e.target.closest('.staff-inp');
        if (!inp) return;
        const s = App.data.staff.find(x => x.id === inp.closest('tr').dataset.id);
        if (!s) return;
        const f = inp.dataset.field;
        s[f] = inp.value;
        App.save();
        if (f === 'pos') { UI.renderScheduleTab(); UI.renderPositionsManager(); }
    });
    // <select> fires 'change'; reuse same logic for pos
    staffTable.addEventListener('change', e => {
        const chk = e.target.closest('.staff-chk');
        if (chk) {
            const st = App.data.staff.find(x => x.id === chk.closest('tr').dataset.id);
            if (st) { st[chk.dataset.field] = chk.checked; App.save(); UI.renderStaffEditor(); UI.renderScheduleTab(); }
            return;
        }
        const sel = e.target.closest('select.staff-inp');
        if (!sel) return;
        const s = App.data.staff.find(x => x.id === sel.closest('tr').dataset.id);
        if (!s) return;
        s[sel.dataset.field] = sel.value;
        App.save();
        UI.renderScheduleTab();
        UI.renderPositionsManager();
        UI.renderWorkplaces();
    });

    staffTable.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        const inp = e.target.closest('.staff-inp');
        if (inp && inp.dataset.field === 'name') { e.preventDefault(); addRow(); }
    });
    staffTable.addEventListener('click', e => {
        const cap = e.target.closest('.cap-btn');
        if (cap) { UI.openCapModal(cap.dataset.id); return; }
        const del = e.target.closest('.del-staff');
        if (!del) return;
        App.removeStaff(del.dataset.id);
        UI.renderStaffEditor();
        UI.renderScheduleTab();
    });
    staffTable.addEventListener('paste', e => {
        const text = (e.clipboardData || window.clipboardData).getData('text');
        if (!text || !/[\n\t]/.test(text)) return;
        e.preventDefault();
        text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(line => {
            const parts = line.split('\t');
            const name = (parts[0] || '').trim();
            const role = (parts[1] || '').trim();
            if (name) App.addStaff(name, role);
        });
        UI.renderStaffEditor();
        UI.renderScheduleTab();
    });

    // --- Positions manager ---
    const positionsList = UI.el('positionsList');
    positionsList.addEventListener('input', e => {
        const inp = e.target.closest('.pos-inp');
        if (!inp) return;
        App.renamePosition(inp.closest('.pos-row').dataset.id, inp.value);
        UI.renderScheduleTab();
        UI.renderStaffEditor();
        UI.renderMarkerSettings();
    });
    positionsList.addEventListener('click', e => {
        const del = e.target.closest('.del-pos');
        if (!del || del.disabled) return;
        const p = App.getPosition(del.dataset.id);
        if (p && confirm(`ลบตำแหน่ง "${p.name}"? บุคลากร/เครื่องหมายของตำแหน่งนี้จะย้ายไปตำแหน่งแรก`)) {
            App.removePosition(del.dataset.id);
            UI.render();
        }
    });
    UI.el('addPositionBtn').addEventListener('click', () => {
        const id = App.addPosition('ตำแหน่งใหม่');
        UI.render();
        const inp = document.querySelector(`#positionsList .pos-row[data-id="${id}"] .pos-inp`);
        if (inp) { inp.focus(); inp.select(); }
    });

    // --- Workplaces manager (OPD/IPD…) ---
    const workplacesList = UI.el('workplacesList');
    workplacesList.addEventListener('input', e => {
        const inp = e.target.closest('.wp-name');
        if (!inp) return;
        App.renameWorkplace(inp.closest('.wp-row').dataset.id, inp.value);
        UI.renderStaffEditor();
    });
    workplacesList.addEventListener('change', e => {
        const dow = e.target.closest('.wp-dow');
        if (dow) { App.toggleWorkplaceDow(dow.closest('.wp-row').dataset.id, parseInt(dow.dataset.dow, 10), dow.checked); return; }
        const pos = e.target.closest('.wp-pos');
        if (pos) { App.toggleWorkplacePos(pos.closest('.wp-row').dataset.id, pos.dataset.pos, pos.checked); UI.renderWorkplaces(); }
    });
    workplacesList.addEventListener('click', e => {
        const del = e.target.closest('.del-wp');
        if (!del) return;
        const w = App.getWorkplace(del.dataset.id);
        if (w && confirm(`ลบสถานที่ "${w.name}"? เจ้าหน้าที่ที่สังกัดจะถูกตั้งเป็น “—”`)) {
            App.removeWorkplace(del.dataset.id);
            UI.renderWorkplaces();
            UI.renderStaffEditor();
        }
    });
    UI.el('addWorkplaceBtn').addEventListener('click', () => {
        const id = App.addWorkplace('สถานที่ใหม่');
        UI.renderWorkplaces();
        UI.renderStaffEditor();
        const inp = document.querySelector(`#workplacesList .wp-row[data-id="${id}"] .wp-name`);
        if (inp) { inp.focus(); inp.select(); }
    });

    // --- Marker settings tab ---
    const markerTable = UI.el('markerTable');
    function onMarkerEdit(e) {
        const chk = e.target.closest('.mk-pos-chk');
        if (chk) {
            App.toggleMarkerPosition(chk.closest('tr').dataset.id, chk.dataset.pos, chk.checked);
            UI.renderScheduleTab();
            UI.renderPositionsManager();
            return;
        }
        const dow = e.target.closest('.mk-dow');
        if (dow) {
            App.toggleMarkerDow(dow.closest('tr').dataset.id, parseInt(dow.dataset.dow, 10), dow.checked);
            UI.renderScheduleTab();
            return;
        }
        const inp = e.target.closest('.mk-inp');
        if (!inp) return;
        const row = inp.closest('tr');
        const id = row.dataset.id;
        const field = inp.dataset.field;
        const val = inp.type === 'checkbox' ? inp.checked : inp.value;
        App.updateMarker(id, { [field]: val });

        const m = App.getMarker(id);
        const prev = row.querySelector('.mk-prev');
        prev.style.background = m.color;
        prev.innerHTML = UI.markerInner(m);
        if (field === 'color') inp.style.background = val;

        UI.renderScheduleTab();
        UI.renderPositionsManager();
        if (field === 'color') UI.renderMarkerSettings();
    }
    markerTable.addEventListener('input', onMarkerEdit);
    markerTable.addEventListener('change', onMarkerEdit);
    markerTable.addEventListener('click', e => {
        const del = e.target.closest('.del-marker');
        if (!del) return;
        const m = App.getMarker(del.dataset.id);
        if (m && confirm(`ลบเครื่องหมาย "${m.text || m.label}" และล้างเวรที่ใช้เครื่องหมายนี้?`)) {
            App.removeMarker(del.dataset.id);
            UI.render();
        }
    });
    UI.el('addMarkerBtn').addEventListener('click', () => {
        const id = App.addMarker();
        UI.renderMarkerSettings();
        UI.renderScheduleTab();
        const inp = document.querySelector(`#markerTable tr[data-id="${id}"] .mk-inp[data-field="text"]`);
        if (inp) inp.focus();
    });
    UI.el('resetMarkerBtn').addEventListener('click', () => {
        if (confirm('คืนค่าเครื่องหมายเริ่มต้น 16 ตัว (ใช้ร่วมทุกตำแหน่ง)? เครื่องหมายที่เพิ่ม/แก้เองจะหาย')) {
            App.seedMarkers();
            App.save();
            UI.render();
        }
    });

    // --- Custom holidays ---
    UI.el('addHolidayBtn').addEventListener('click', () => {
        const ok = App.addHoliday(UI.el('holYear').value, UI.el('holMonth').value, UI.el('holDay').value, UI.el('holName').value);
        if (!ok) return;
        UI.el('holDay').value = '';
        UI.el('holName').value = '';
        UI.renderHolidayManager();
        UI.renderScheduleTab();
    });
    UI.el('holidayList').addEventListener('click', e => {
        const del = e.target.closest('.del-holiday');
        if (!del) return;
        App.removeHoliday(parseInt(del.dataset.year, 10), del.dataset.key);
        UI.renderHolidayManager();
        UI.renderScheduleTab();
    });
})();
