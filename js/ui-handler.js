// DOM rendering + event handling
const UI = {
    el(id) { return document.getElementById(id); },

    markerInner(m) {
        const t = this.esc(m.text || '');
        if (m.deco === 'circle') return `<span class="deco-circle">${t}</span>`;
        if (m.deco === 'box') return `<span class="deco-box">${t}</span>`;
        if (m.deco === 'underline') return `<span class="deco-underline">${t}</span>`;
        return t;
    },

    monthTitle() {
        const { year, month, unit } = App.data;
        return `${Schedule.MONTH_NAMES[month - 1]} ${year}` + (unit ? ` — ${unit}` : '');
    },

    // ---- Top controls -------------------------------------------------
    renderControls() {
        const monthSel = this.el('monthSelect');
        monthSel.innerHTML = Schedule.MONTH_NAMES
            .map((n, i) => `<option value="${i + 1}">${n}</option>`).join('');
        monthSel.value = App.data.month;
        this.el('yearInput').value = App.data.year;
    },

    setSheetStatus(msg, kind) {
        const el = this.el('sheetStatus');
        if (!el) return;
        el.textContent = msg;
        el.className = 'sheet-status' + (kind ? ' ' + kind : '');
    },

    render() {
        this.renderControls();
        this.renderScheduleTab();
        this.renderStaffEditor();
        this.renderLeaveTab();
        this.renderPositionsManager();
        this.renderWorkplaces();
        this.renderMarkerSettings();
        this.renderSplits();
        this.renderHolidayManager();
        this.renderSwapHistory();
    },

    // ---- Swap history tab (staff shift-swaps, per month) ----
    renderSwapHistory() {
        const wrap = this.el('swapHistoryList');
        if (!wrap) return;
        const ym = App.currentKey();
        const log = (App.data.swapLog && App.data.swapLog[ym]) || [];
        const lbl = this.el('swapMonthLabel'); if (lbl) lbl.textContent = '· ' + this.monthTitle();
        const cnt = this.el('swapCount'); if (cnt) cnt.textContent = log.length ? `รวม ${log.length} ครั้ง` : '';
        if (!log.length) {
            wrap.innerHTML = '<div class="muted-note" style="padding:12px">ยังไม่มีการแลกเวรในเดือนนี้</div>';
            return;
        }
        const txt = ids => (ids && ids.length)
            ? ids.map(id => { const m = App.getMarker(id); return m ? this.esc(m.text) : '?'; }).join(' ')
            : '<span class="swap-empty">ว่าง</span>';
        wrap.innerHTML = log.slice().sort((a, b) => (b.at || '').localeCompare(a.at || '')).map(e => {
            let when = e.at || '';
            try { when = new Date(e.at).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (x) { /* keep raw */ }
            return `<div class="swap-row">
                <span class="swap-when">${this.esc(when)}</span>
                <span class="swap-who">${this.esc(e.byName || '?')}</span>
                <span class="swap-change">วันที่ ${e.day}: <b>${txt(e.before)}</b> <span class="swap-arrow">→</span> <b>${txt(e.after)}</b></span>
            </div>`;
        }).join('');
    },

    // ---- Schedule tab: one block per position -------------------------
    renderScheduleTab() {
        const c = this.el('scheduleContainer');
        let positions = App.data.positions;
        if (App.isStaff()) {   // staff see only groups that have been published
            positions = positions.filter(p => App.posPublished(p.id));
            if (!positions.length) {
                c.innerHTML = '<div class="content-box empty-hint">⏳ ตารางเวรยังไม่เผยแพร่ — รอผู้จัดตารางเผยแพร่ก่อน แล้วกด “⟳ ดึงล่าสุด”</div>';
                return;
            }
        }
        if (!positions.length) { c.innerHTML = ''; return; }
        c.innerHTML = positions.map(p => this.posBlock(p)).join('');
        this.fitCells(c);
    },

    posBlock(pos) {
        const staff = Schedule.staffForPos(pos.id);
        const markers = Schedule.markersForPos(pos.id);
        const body = staff.length
            ? this.buildScheduleTable(pos.id, staff)
            : `<p class="pos-empty">ยังไม่มีรายชื่อตำแหน่งนี้ — เพิ่มที่แท็บ “บุคลากร”</p>`;
        return `<div class="content-box pos-block" data-pos="${pos.id}">
            <div class="pos-inner">
                <div class="pos-head">
                    <h2>${this.esc(pos.name)} <span class="pos-sub">${this.monthTitle()}</span></h2>
                    <div class="pos-actions no-print">
                        <div class="draft-tabs admin-only" title="สุ่มเปรียบเทียบ 3 ร่างของตำแหน่งนี้ (วันลา+เวรที่ปักหมุด ใช้ร่วมทุกร่าง)">
                            ${[1, 2, 3].map(n => `<button class="draft-tab${App.activeDraftNum(pos.id) === n ? ' active' : ''}" data-pos="${pos.id}" data-draft="${n}" type="button">ร่าง ${n}</button>`).join('')}
                        </div>
                        <button class="pos-print btn-secondary" data-pos="${pos.id}" type="button">🖨 พิมพ์</button>
                        <button class="pos-random btn-primary admin-only" data-pos="${pos.id}" type="button">🎲 สุ่ม</button>
                        <button class="pos-clear btn-danger admin-only" data-pos="${pos.id}" type="button">🗑 ล้าง</button>
                        <button class="pos-save btn-secondary admin-only" data-pos="${pos.id}" type="button" title="บันทึกงานขึ้น Google Sheet (ไม่เผยแพร่ให้เจ้าหน้าที่)">💾 บันทึก</button>
                        <button class="pos-publish admin-only${App.posPublished(pos.id) ? ' is-pub' : ''}" data-pos="${pos.id}" type="button" title="${App.posPublished(pos.id) ? 'เผยแพร่แล้ว ' + (((App.data.publishedPos && App.data.publishedPos[App.currentKey()]) || {})[pos.id] || '') + ' — กดเพื่อเผยแพร่ซ้ำ' : 'เผยแพร่กลุ่มนี้ให้เจ้าหน้าที่ดู'}">${App.posPublished(pos.id) ? '✓ เผยแพร่แล้ว' : '🌐 เผยแพร่'}</button>
                        ${App.posPublished(pos.id) ? `<button class="pos-unpublish btn-danger admin-only" data-pos="${pos.id}" type="button" title="ยกเลิกเผยแพร่ — เจ้าหน้าที่จะไม่เห็นตารางกลุ่มนี้">↩ ยกเลิกเผยแพร่</button>` : ''}
                    </div>
                </div>
                <span class="table-hint no-print">คลิกช่อง = เลือกเวร (ใส่ได้ 2) · ดับเบิลคลิกชื่อ = แก้ไข${App.isAdmin() ? ' · คลิกหัววันที่ = เพิ่ม/ลบวันหยุด' : ''} · <span class="hint-wk">เสาร์-อาทิตย์</span> <span class="hint-hol">วันหยุด</span> (ชี้ดูชื่อวันหยุด)</span>
                ${body}
                <div class="legend-bar no-print">
                    <span class="legend-label">เครื่องหมาย:</span>
                    <div class="legend">${this.buildLegend(markers)}</div>
                </div>
            </div>
        </div>`;
    },

    buildLegend(markers) {
        if (!markers.length)
            return `<span class="muted-note">ยังไม่มีเครื่องหมายของตำแหน่งนี้ — เพิ่มที่แท็บ “ตั้งค่าเวร”</span>`;
        return markers.map(m =>
            `<span class="legend-item"><span class="mk-chip" style="background:${m.color}">${this.markerInner(m)}</span>${m.label ? `<span class="legend-text">${this.esc(m.label)}</span>` : ''}</span>`
        ).join('');
    },


    buildScheduleTable(posId, staff) {
        const { year, month } = App.data;
        const days = Schedule.daysInMonth(year, month);
        return `<div class="table-scroll"><table class="schedule-table" data-pos="${posId}">
            ${this.buildHead(year, month, days)}
            ${this.buildBody(year, month, days, staff)}
            ${this.buildFoot(posId, year, month, days)}
        </table></div>`;
    },

    buildHead(year, month, days) {
        let dayCols = '';
        for (let d = 1; d <= days; d++) {
            const hol = Holidays.get(year, month, d);
            const we = Schedule.isWeekend(year, month, d) ? ' weekend' : '';
            const hc = hol ? ' holiday' : '';
            const dow = Schedule.DOW_NAMES[Schedule.dayOfWeek(year, month, d)];
            const title = hol ? ` title="${this.esc(hol)}"` : (App.isAdmin() ? ' title="คลิกเพื่อเพิ่มวันหยุด"' : '');
            dayCols += `<th class="day-col${we}${hc}" data-day="${d}"${title}><span class="dnum">${d}</span><span class="dow">${dow}</span></th>`;
        }
        return `<thead><tr>
            <th class="staff-col">บุคลากร</th>
            ${dayCols}
            <th class="sum-col total-col">รวม</th>
        </tr></thead>`;
    },

    buildBody(year, month, days, staff) {
        const rows = staff.map(s => {
            let cells = '';
            for (let d = 1; d <= days; d++) {
                cells += this.cellHtml(s.id, d, year, month);
            }
            const sm = Schedule.staffSummary(s.id);
            const role = s.role ? `<span class="staff-role">${this.esc(s.role)}</span>` : '';
            const mine = App.isStaff() && s.id === App.session.staffId;
            const rowCls = [s.inactive ? 'staff-off' : '', mine ? 'row-mine' : '', (App.isStaff() && !mine) ? 'row-locked' : '']
                .filter(Boolean).join(' ');
            return `<tr data-staff="${s.id}"${rowCls ? ` class="${rowCls}"` : ''}>
                <td class="staff-col"><span class="staff-name" title="${this.esc(s.name)}">${this.esc(s.name)}</span>${role}</td>
                ${cells}
                <td class="sum-col total-col"><b>${sm._work || ''}</b></td>
            </tr>`;
        }).join('');
        return `<tbody>${rows}</tbody>`;
    },

    cellHtml(staffId, day, year, month) {
        const we = Schedule.isWeekend(year, month, day) ? ' weekend' : '';
        const hc = Holidays.get(year, month, day) ? ' holiday' : '';
        const lv = App.getLeave(App.currentKey(), staffId).includes(day) ? ' on-leave' : '';
        const lk = (App.isAdmin() && App.isLockedCell(App.currentKey(), staffId, day)) ? ' pinned' : '';
        return `<td class="cell${we}${hc}${lv}${lk}" data-staff="${staffId}" data-day="${day}">${this.cellInner(staffId, day)}</td>`;
    },

    cellInner(staffId, day) {
        const ids = App.getCell(staffId, day);
        if (!ids.length) return '';
        const staff = App.data.staff.find(s => s.id === staffId);
        const dup = staff ? Schedule.dupMarkersOnDay(staff.pos, day) : null;
        // always show เวรเช้า on the left, เวรบ่าย on the right (others in the middle)
        const cat = Schedule.dayCategory(App.data.year, App.data.month, day);
        const orderKey = id => { const m = App.getMarker(id); if (!m) return 1; const f = App.slotFlags(m, cat); return f.afternoon ? 2 : f.morning ? 0 : 1; };
        const chips = ids.slice().sort((a, b) => orderKey(a) - orderKey(b)).map(id => {
            const m = App.getMarker(id);
            if (!m) return '';
            const isDup = dup && dup.has(id);
            return `<span class="mk-chip${isDup ? ' dup' : ''}" style="background:${m.color}"${isDup ? ' title="เวรซ้ำกับคนอื่นในวันนี้"' : ''}>${this.markerInner(m)}</span>`;
        }).join('');
        return `<span class="cell-fit">${chips}</span>`;   // wrapper ให้ auto-fit ย่อพอดีช่อง
    },

    // auto-shrink each cell's content so it never spills past the cell edge (per-cell scale — sizes may differ)
    fitCells(scope) {
        const root = scope || this.el('scheduleContainer');
        if (!root) return;
        const fits = Array.prototype.slice.call(root.querySelectorAll('.cell-fit'));
        if (!fits.length) return;
        fits.forEach(f => { f.style.transform = ''; });               // reset to natural size
        const scales = fits.map(f => {                                // batch READ (single layout)
            const avail = f.parentElement.clientWidth - 2, w = f.scrollWidth;
            return (w > avail && avail > 0) ? Math.max(0.4, avail / w) : 1;
        });
        fits.forEach((f, i) => { if (scales[i] < 1) f.style.transform = `scale(${scales[i].toFixed(3)})`; });   // batch WRITE
    },

    buildFoot(posId, year, month, days) {
        let covCells = '', reqCells = '';
        for (let d = 1; d <= days; d++) {
            const we = Schedule.isWeekend(year, month, d) ? ' weekend' : '';
            const hc = Holidays.get(year, month, d) ? ' holiday' : '';
            covCells += `<td class="cov${we}${hc}" data-day="${d}">${Schedule.dayShiftsPos(posId, d) || ''}</td>`;
            const st = this.reqState(posId, d);
            reqCells += `<td class="${st.cls}${we}${hc}" data-day="${d}"${st.title ? ` title="${this.esc(st.title)}"` : ''}>${st.txt}</td>`;
        }
        return `<tfoot>
            <tr class="cov-row">
                <td class="staff-col cov-head">รวมเวร/วัน</td>
                ${covCells}
                <td class="sum-col total-col"></td>
            </tr>
            <tr class="req-row no-print">
                <td class="staff-col cov-head">ครบเวรบังคับ</td>
                ${reqCells}
                <td class="sum-col total-col"></td>
            </tr>
        </tfoot>`;
    },

    // ✓ = ครบ · ⚠ = ขาด (title บอกว่าขาดตัวไหน) · ว่าง = วันนี้ไม่ได้ตั้งบังคับ
    reqState(posId, day) {
        const { year, month } = App.data;
        const missing = Schedule.requiredMissing(posId, year, month, day);
        if (missing === null) return { cls: 'req', txt: '', title: '' };
        if (!missing.length) return { cls: 'req ok', txt: '✓', title: 'ครบเวรบังคับ' };
        return { cls: 'req bad', txt: '⚠', title: 'ขาด: ' + missing.map(m => m.text).join(' ') };
    },

    setReqCell(table, posId, day) {
        const td = table.querySelector(`.req[data-day="${day}"]`);
        if (!td) return;
        const st = this.reqState(posId, day);
        const keep = td.className.match(/\b(weekend|holiday)\b/g) || [];
        td.className = (st.cls + ' ' + keep.join(' ')).trim();
        td.textContent = st.txt;
        if (st.title) td.setAttribute('title', st.title); else td.removeAttribute('title');
    },

    // ---- Cell popover (pick up to 2 markers) --------------------------
    editing: null,   // { staffId, day, posId, cell }

    openCellPopover(td) {
        const staffId = td.dataset.staff;
        const day = parseInt(td.dataset.day, 10);
        const staff = App.data.staff.find(s => s.id === staffId);
        if (!staff || staff.inactive) return;
        if (App.isStaff() && staff.id !== App.session.staffId) return;   // staff edits own row only
        if (App.isStaff() && !App.posPublished(staff.pos)) return;       // เดือน/กลุ่มที่ยังไม่เผยแพร่ — แก้/แลกไม่ได้
        this.editing = { staffId, day, posId: staff.pos, cell: td };
        this.renderPopover();

        const pop = this.el('cellPopover');
        pop.hidden = false;
        const r = td.getBoundingClientRect();
        const pw = pop.offsetWidth, ph = pop.offsetHeight;
        let left = r.left + window.scrollX;
        let top = r.bottom + window.scrollY + 4;
        if (left + pw > window.scrollX + document.documentElement.clientWidth - 8)
            left = window.scrollX + document.documentElement.clientWidth - pw - 8;
        if (r.bottom + ph + 8 > document.documentElement.clientHeight)
            top = r.top + window.scrollY - ph - 4;
        pop.style.left = Math.max(8, left) + 'px';
        pop.style.top = top + 'px';
    },

    renderPopover() {
        if (!this.editing) return;
        const { staffId, day, posId } = this.editing;
        const arr = App.getCell(staffId, day);
        const markers = Schedule.markersForPos(posId);
        const staff = App.data.staff.find(s => s.id === staffId);

        const current = arr.length
            ? arr.map((id, idx) => {
                const m = App.getMarker(id);
                return `<span class="cp-chip" style="background:${m ? m.color : '#eee'}">${m ? this.markerInner(m) : '?'}<button class="cp-del" data-idx="${idx}" title="เอาออก">×</button></span>`;
            }).join('')
            : `<span class="muted-note">— ว่าง —</span>`;

        const full = arr.length >= 2;
        const cat = Schedule.dayCategory(App.data.year, App.data.month, day);
        const existing = arr.length === 1 ? App.getMarker(arr[0]) : null;
        const picks = markers.map(m => {
            const conflict = existing ? App.pairConflict(existing, m, cat) : false;
            const dis = full || arr.includes(m.id) || conflict ? ' disabled' : '';
            const tip = conflict ? this.conflictReason(existing, m, cat) : (m.label || m.text);
            return `<button class="cp-pick" data-id="${m.id}"${dis} style="background:${m.color}" title="${this.esc(tip)}">${this.markerInner(m)}</button>`;
        }).join('');

        this.el('cellPopover').innerHTML = `
            <div class="cp-head"><span class="cp-title">${this.esc(staff ? staff.name : '')} · วันที่ ${day}${full ? ' <span class="cp-full">(ครบ 2 แล้ว)</span>' : ''}</span><button class="cp-x" type="button" title="ปิด">×</button></div>
            <div class="cp-current">${current}</div>
            <div class="cp-pick-wrap">${picks || '<span class="muted-note">ไม่มีเครื่องหมาย</span>'}</div>
            <div class="cp-foot">
                ${App.isAdmin() ? `<button class="cp-pin${App.isLockedCell(App.currentKey(), staffId, day) ? ' on' : ''}" type="button" title="ปักหมุดกันสุ่มทับ (ตั้งก่อนกดสุ่ม)">${App.isLockedCell(App.currentKey(), staffId, day) ? '📌 ปักหมุดอยู่' : '📌 ปักหมุด'}</button>` : ''}
                <button class="cp-clear" type="button">ลบทั้งหมด</button>
                <button class="cp-close" type="button">เสร็จ</button>
            </div>`;
    },

    // a is the marker already in the cell, b is the one being added
    conflictReason(a, b, cat) {
        const fa = App.slotFlags(a, cat), fb = App.slotFlags(b, cat);
        if ((App.isNoAfternoonMarker(a) && fb.afternoon) || (App.isNoAfternoonMarker(b) && fa.afternoon))
            return 'X ห้ามอยู่ช่องเดียวกับเวรบ่าย';
        return 'ด ห้ามอยู่ช่องเดียวกับเวรเช้า/กลางวัน';
    },

    addToCell(markerId) {
        if (!this.editing) return;
        const { staffId, day } = this.editing;
        const arr = App.getCell(staffId, day);
        if (arr.length >= 2 || arr.includes(markerId)) return;
        const cat = Schedule.dayCategory(App.data.year, App.data.month, day);
        if (arr.length === 1 && App.pairConflict(App.getMarker(arr[0]), App.getMarker(markerId), cat)) return;
        arr.push(markerId);
        App.setCell(staffId, day, arr);
        this.autoLinkNight(markerId);
        this.afterCellChange();
    },

    // เวรดึกเป็นคู่: ลง ด วันนี้ → เติม X วันก่อน · ลง X วันนี้ → เติม ด วันถัดไป
    // find the target cell for the night partner (rolls over to prev/next month)
    nightPartnerTarget(m) {
        const { posId } = this.editing;
        let partnerText, delta;
        if (App.isNoMorningMarker(m)) { partnerText = 'x'; delta = -1; }       // ด → x เมื่อวาน
        else if (App.isNoAfternoonMarker(m)) { partnerText = 'ด'; delta = 1; } // x → ด พรุ่งนี้
        else return null;
        const partner = Schedule.markersForPos(posId).find(mk =>
            (mk.text || '').trim().toLowerCase() === partnerText.toLowerCase());
        if (!partner) return null;
        const t = Schedule.shiftDate(App.data.year, App.data.month, this.editing.day, delta);
        return { partner, key: App.ymKey(t.year, t.month), day: t.day };
    },

    autoLinkNight(markerId) {
        const m = App.getMarker(markerId);
        const tgt = m && this.nightPartnerTarget(m);
        if (!tgt) return;
        const { staffId, posId } = this.editing;
        const tArr = App.getCellIn(tgt.key, staffId, tgt.day);
        if (tArr.includes(tgt.partner.id) || tArr.length >= 2) return;
        const [ty, tm] = tgt.key.split('-').map(Number);
        const tCat = Schedule.dayCategory(ty, tm, tgt.day);
        if (tArr.length === 1 && App.pairConflict(App.getMarker(tArr[0]), tgt.partner, tCat)) return;
        tArr.push(tgt.partner.id);
        App.setCellIn(tgt.key, staffId, tgt.day, tArr);
        if (tgt.key === App.currentKey()) this.refreshCell(staffId, tgt.day, posId);
    },

    // repaint every staff cell in one day-column (dup highlight) + รวมคนทำงาน + บังคับ
    refreshDayColumn(posId, day) {
        const table = this.el('scheduleContainer').querySelector(`table[data-pos="${posId}"]`);
        if (!table) return;
        table.querySelectorAll(`td.cell[data-day="${day}"]`).forEach(td => {
            td.innerHTML = this.cellInner(td.dataset.staff, day);
            td.classList.toggle('pinned', App.isAdmin() && App.isLockedCell(App.currentKey(), td.dataset.staff, day));
        });
        const cov = table.querySelector(`.cov[data-day="${day}"]`);
        if (cov) cov.textContent = Schedule.dayShiftsPos(posId, day) || '';
        this.setReqCell(table, posId, day);
        this.fitCells(table);
    },

    // update one staff's total, then repaint the whole day column
    // pins are set explicitly via the popover 📌 button — clearing a cell drops its pin
    unpinIfEmpty(key, staffId, day) {
        if (!App.getCellIn(key, staffId, day).length) App.unlockCell(key, staffId, day);
    },

    // toggle pin on the editing cell (+ its night ด/x partner) — copies content to the shared base so it survives on every draft
    togglePin() {
        if (!this.editing || !App.isAdmin()) return;
        const { staffId, day } = this.editing;
        const key = App.currentKey();
        const on = !App.isLockedCell(key, staffId, day);
        const setPin = (k, sid, d) => {
            if (on) { App.setCellBase(k, sid, d, App.getCellIn(k, sid, d)); App.lockCell(k, sid, d); }
            else App.unlockCell(k, sid, d);
        };
        App.getCell(staffId, day).forEach(id => {   // ด/x pair shares the pin (partner may be another day/month)
            const tgt = this.nightPartnerTarget(App.getMarker(id));
            if (tgt) setPin(tgt.key, staffId, tgt.day);
        });
        setPin(key, staffId, day);
        this.afterCellChange();
    },

    refreshCell(staffId, day, posId) {
        const table = this.el('scheduleContainer').querySelector(`table[data-pos="${posId}"]`);
        if (!table) return;
        const tb = table.querySelector(`tr[data-staff="${staffId}"] .total-col b`);
        if (tb) tb.textContent = Schedule.staffSummary(staffId)._work || '';
        this.refreshDayColumn(posId, day);
    },

    // ลบคู่: เอา ด ออก → ลบ X วันก่อน · เอา X ออก → ลบ ด วันถัดไป
    autoUnlinkNight(markerId) {
        const m = App.getMarker(markerId);
        const tgt = m && this.nightPartnerTarget(m);
        if (!tgt) return;
        const { staffId, posId } = this.editing;
        const tArr = App.getCellIn(tgt.key, staffId, tgt.day);
        const i = tArr.indexOf(tgt.partner.id);
        if (i < 0) return;
        tArr.splice(i, 1);
        App.setCellIn(tgt.key, staffId, tgt.day, tArr);
        if (tgt.key === App.currentKey()) this.refreshCell(staffId, tgt.day, posId);
    },

    removeFromCell(idx) {
        if (!this.editing) return;
        const { staffId, day } = this.editing;
        const arr = App.getCell(staffId, day);
        const removed = arr[idx];
        arr.splice(idx, 1);
        App.setCell(staffId, day, arr);
        this.unpinIfEmpty(App.currentKey(), staffId, day);
        if (removed) this.autoUnlinkNight(removed);
        this.afterCellChange();
    },

    clearCell() {
        if (!this.editing) return;
        const { staffId, day } = this.editing;
        const removed = App.getCell(staffId, day);
        App.setCell(staffId, day, []);
        this.unpinIfEmpty(App.currentKey(), staffId, day);
        removed.forEach(id => this.autoUnlinkNight(id));
        this.afterCellChange();
    },

    afterCellChange() {
        const { staffId, day, posId } = this.editing;
        this.refreshCell(staffId, day, posId);
        this.renderPopover();
        if (App.isStaff()) Auth.queueSwap(staffId);
    },

    closePopover() {
        this.editing = null;
        const pop = this.el('cellPopover');
        if (pop) pop.hidden = true;
    },

    // ---- Staff editor (Excel-like, with position) ---------------------
    renderStaffEditor() {
        const tbl = this.el('staffTable');
        if (!tbl) return;
        const posOpt = s => App.data.positions.map(p =>
            `<option value="${p.id}"${s.pos === p.id ? ' selected' : ''}>${this.esc(p.name)}</option>`).join('');
        const wpOpt = s => `<option value=""${!s.workplace ? ' selected' : ''}>—</option>` +
            (App.data.workplaces || []).map(w =>
                `<option value="${w.id}"${s.workplace === w.id ? ' selected' : ''}>${this.esc(w.name)}</option>`).join('');
        const head = `<thead><tr>
            <th class="num-col">#</th><th class="name-col">ชื่อ-สกุล</th><th>สังกัด (ตาราง)</th><th title="สถานที่ทำงาน (OPD/IPD…) — ใช้กติกาวันที่ต้องมาครบ">สถานที่</th><th class="mk-center" title="เวรสูงสุด/เดือน (x+ด=1) · ว่าง=ไม่จำกัด">เวร/เดือน</th><th class="mk-center" title="ดึก (ด) สูงสุด/เดือน · ว่าง=ตามค่าเริ่มต้น (2)">ดึก/เดือน</th><th class="mk-center" title="ชนิดเวรที่คนนี้ขึ้นได้ + ห้ามเวรบางวัน">เวร/เงื่อนไข</th><th class="mk-center" title="ลาศึกษาต่อ / ไม่ลงเวร — แถวจะเป็นสีเทา">ไม่มีเวร</th><th class="act-col"></th>
        </tr></thead>`;
        const rows = App.data.staff.map((s, i) => {
            const mk = Schedule.markersForPos(s.pos);
            const nBlock = (s.blockedMarkers || []).filter(id => mk.some(m => m.id === id)).length;
            const cap = nBlock ? `${mk.length - nBlock}/${mk.length}` : 'ทั้งหมด';
            return `<tr data-id="${s.id}"${s.inactive ? ' class="staff-off-row"' : ''}>
            <td class="num-col">${i + 1}</td>
            <td><input class="staff-inp name-inp" data-field="name" value="${this.esc(s.name)}" placeholder="ชื่อ-สกุล"></td>
            <td><select class="staff-inp" data-field="pos">${posOpt(s)}</select></td>
            <td><select class="staff-inp" data-field="workplace">${wpOpt(s)}</select></td>
            <td class="mk-center"><input type="number" class="max-inp" data-id="${s.id}" min="0" value="${s.maxShifts || ''}" placeholder="∞"></td>
            <td class="mk-center"><input type="number" class="maxn-inp" data-id="${s.id}" min="0" value="${s.maxNights || ''}" placeholder="2"></td>
            <td class="mk-center"><button class="cap-btn${nBlock || (s.dayBans && Object.keys(s.dayBans).length) || (s.mustHave && s.mustHave.length) ? ' has' : ''}" data-id="${s.id}">${cap}</button></td>
            <td class="mk-center"><input type="checkbox" class="staff-chk" data-field="inactive"${s.inactive ? ' checked' : ''} title="ลาศึกษาต่อ / ไม่ลงเวร"></td>
            <td class="act-col"><button class="del-staff" data-id="${s.id}" title="ลบแถว">×</button></td>
        </tr>`;
        }).join('');
        tbl.innerHTML = head + `<tbody>${rows}</tbody>`;

        const c = this.el('staffCount');
        if (c) c.textContent = App.data.staff.length ? `รวม ${App.data.staff.length} คน` : 'ยังไม่มีรายชื่อ';
    },

    // ---- Positions manager -------------------------------------------
    renderPositionsManager() {
        const wrap = this.el('positionsList');
        if (!wrap) return;
        const canDel = App.data.positions.length > 1;
        wrap.innerHTML = App.data.positions.map(p => {
            const nStaff = Schedule.staffForPos(p.id).length;
            const nMk = Schedule.markersForPos(p.id).length;
            const mode = p.matchPair ? 'match' : p.noPair ? 'no' : 'auto';
            return `<div class="pos-row" data-id="${p.id}">
                <input class="pos-inp" value="${this.esc(p.name)}" placeholder="ชื่อตำแหน่ง">
                <span class="pos-meta">${nStaff} คน · ${nMk} เครื่องหมาย</span>
                <label class="pos-pairmode" title="เสาร์-อาทิตย์: จะให้คนขึ้น เช้า+บ่าย อย่างไร">ควบ ช+บ (ส-อา):
                    <select class="pos-pairmode-sel">
                        <option value="auto"${mode === 'auto' ? ' selected' : ''}>อัตโนมัติ</option>
                        <option value="match"${mode === 'match' ? ' selected' : ''}>ควบเส้นเดียวกัน (คนเดียวทั้งวัน)</option>
                        <option value="no"${mode === 'no' ? ' selected' : ''}>ไม่ควบ (คละคน)</option>
                    </select></label>
                <button class="del-pos" data-id="${p.id}" title="ลบตำแหน่ง"${canDel ? '' : ' disabled'}>×</button>
            </div>`;
        }).join('');
    },

    // ---- Workplaces manager (OPD/IPD…) + full-attendance dow (no ด) ----
    renderWorkplaces() {
        const wrap = this.el('workplacesList');
        if (!wrap) return;
        const wps = App.data.workplaces || [];
        if (!wps.length) {
            wrap.innerHTML = '<div class="muted-note" style="padding:8px">ยังไม่มีสถานที่ — กด “+ เพิ่มสถานที่”</div>';
            return;
        }
        wrap.innerHTML = wps.map(w => {
            const nStaff = App.data.staff.filter(s => s.workplace === w.id).length;
            const posChips = App.data.positions.map(p =>
                `<label class="wp-pos-chip"><input type="checkbox" class="wp-pos" data-pos="${p.id}"${(w.noNightPos || []).includes(p.id) ? ' checked' : ''}><span>${this.esc(p.name)}</span></label>`).join('');
            const dowChips = [1, 2, 3, 4, 5, 6, 0].map(d =>
                `<label class="mk-dow-chip"><input type="checkbox" class="wp-dow" data-dow="${d}"${(w.noNightDows || []).includes(d) ? ' checked' : ''}><span>${Schedule.DOW_NAMES[d]}</span></label>`).join('');
            const allPos = !(w.noNightPos && w.noNightPos.length);
            return `<div class="wp-row" data-id="${w.id}">
                <div class="wp-head">
                    <input class="pos-inp wp-name" value="${this.esc(w.name)}" placeholder="ชื่อสถานที่">
                    <span class="pos-meta">${nStaff} คน</span>
                    <button class="del-wp" data-id="${w.id}" title="ลบสถานที่">×</button>
                </div>
                <div class="wp-rule">
                    <span class="wp-dow-label" title="คนสังกัดนี้ (เฉพาะตำแหน่งที่เลือก) ต้องมาครบวันที่เลือก → สุ่มจะเลี่ยงลง ด">ต้องมาครบ (เลี่ยง ด)</span>
                    <div class="wp-sub"><span class="wp-sub-lbl">ตำแหน่ง${allPos ? ' <em>(ว่าง = ทุกตำแหน่ง)</em>' : ''}:</span>${posChips}</div>
                    <div class="wp-sub"><span class="wp-sub-lbl">วัน:</span>${dowChips}</div>
                </div>
            </div>`;
        }).join('');
    },

    // ---- Half-month split shifts (shared by 2 positions) ----
    renderSplits() {
        const wrap = this.el('splitsList');
        if (!wrap) return;
        const splits = App.data.splits || [];
        if (!splits.length) {
            wrap.innerHTML = '<div class="muted-note" style="padding:8px">ยังไม่มีเวรแชร์ — กด “+ เพิ่มเวรแชร์”</div>';
            return;
        }
        const ymKey = App.currentKey();
        const mkOpts = cur => '<option value="">— เลือกเวร —</option>' + App.data.markers.map(m =>
            `<option value="${m.id}"${cur === m.id ? ' selected' : ''}>${this.esc(m.text || m.label || m.id)}</option>`).join('');
        const posOpts = cur => App.data.positions.map(p =>
            `<option value="${p.id}"${cur === p.id ? ' selected' : ''}>${this.esc(p.name)}</option>`).join('');
        wrap.innerHTML = splits.map(sp => {
            const bnd = sp.boundary || 15;
            const flipped = App.splitFlipped(ymKey, sp.id);
            const firstPos = App.getPosition(flipped ? sp.posSecond : sp.posFirst);
            const secondPos = App.getPosition(flipped ? sp.posFirst : sp.posSecond);
            return `<div class="split-row" data-id="${sp.id}">
                <div class="split-head">
                    <select class="split-inp" data-field="markerId">${mkOpts(sp.markerId)}</select>
                    <label class="split-bnd">วันตัด <input type="number" class="split-inp" data-field="boundary" min="1" max="28" value="${bnd}"></label>
                    <button class="del-split" data-id="${sp.id}" title="ลบเวรแชร์">×</button>
                </div>
                <div class="split-rule">
                    <div class="split-sub"><span class="split-lbl">ครึ่งแรก 1–${bnd}:</span><select class="split-inp" data-field="posFirst">${posOpts(sp.posFirst)}</select></div>
                    <div class="split-sub"><span class="split-lbl">ครึ่งหลัง ${bnd + 1}–สิ้นเดือน:</span><select class="split-inp" data-field="posSecond">${posOpts(sp.posSecond)}</select></div>
                    <div class="split-month">
                        <span>เดือน ${this.monthTitle()}: <b>${firstPos ? this.esc(firstPos.name) : '?'}</b> = 1–${bnd} · <b>${secondPos ? this.esc(secondPos.name) : '?'}</b> = ${bnd + 1}–สิ้นเดือน</span>
                        <button class="swap-split btn-secondary" data-id="${sp.id}" type="button">⇄ สลับเดือนนี้</button>
                    </div>
                </div>
            </div>`;
        }).join('');
    },

    // ---- Marker settings (with position) ------------------------------
    renderMarkerSettings() {
        const tbl = this.el('markerTable');
        if (!tbl) return;
        const decoOpts = [['', 'ปกติ'], ['circle', 'วงกลม'], ['box', 'กรอบ'], ['underline', 'ขีดเส้นใต้']];

        const sorted = App.data.markers.slice().sort((a, b) =>
            App.colorIndex(a.color) - App.colorIndex(b.color));

        const slotOpts = [['', '—'], ['morning', 'เช้า'], ['afternoon', 'บ่าย'], ['night', 'ดึก'], ['day', 'กลางวัน']];
        const varSlotOpts = [['', 'เหมือนวันธรรมดา'], ['morning', 'เช้า'], ['afternoon', 'บ่าย'], ['night', 'ดึก'], ['day', 'กลางวัน']];
        const mkSel = (opts, field, cur) => opts.map(([v, l]) =>
            `<option value="${v}"${(cur || '') === v ? ' selected' : ''}>${l}</option>`).join('');

        const rows = sorted.map(m => {
            const decoSel = decoOpts.map(([v, l]) => `<option value="${v}"${m.deco === v ? ' selected' : ''}>${l}</option>`).join('');
            const slotSel = mkSel(slotOpts, 'slot', m.slot);
            const weSlotSel = mkSel(varSlotOpts, 'weSlot', m.weSlot);
            const phSlotSel = mkSel(varSlotOpts, 'phSlot', m.phSlot);
            const posChks = App.data.positions.map(p =>
                `<label class="mk-pos-opt"><input type="checkbox" class="mk-pos-chk" data-pos="${p.id}"${App.markerInPos(m, p.id) ? ' checked' : ''}> ${this.esc(p.name)}</label>`).join('');
            const colorSel = App.PRESET_COLORS.map(c => `<option value="${c.hex}"${m.color === c.hex ? ' selected' : ''}>${c.name}</option>`).join('');
            const dowChips = [1, 2, 3, 4, 5, 6, 0].map(d =>
                `<label class="mk-dow-chip"><input type="checkbox" class="mk-dow" data-dow="${d}"${(m.reqDows || []).includes(d) ? ' checked' : ''}><span>${Schedule.DOW_NAMES[d]}</span></label>`).join('');
            return `<tr data-id="${m.id}">
                <td class="mk-prev" style="background:${m.color}">${this.markerInner(m)}</td>
                <td><input class="mk-inp" data-field="text" value="${this.esc(m.text)}" placeholder="ช, บ..."></td>
                <td><select class="mk-inp" data-field="deco">${decoSel}</select></td>
                <td><input class="mk-inp mk-label" data-field="label" value="${this.esc(m.label || '')}" placeholder="ใส่ความหมาย..."></td>
                <td class="mk-pos">${posChks}</td>
                <td><select class="mk-inp mk-color" data-field="color" style="background:${m.color}">${colorSel}</select></td>
                <td class="mk-type">
                    <label class="mk-slot-row"><span>ธรรมดา</span><select class="mk-inp" data-field="slot">${slotSel}</select></label>
                    <label class="mk-slot-row"><span>เสาร์ อาทิตย์</span><select class="mk-inp" data-field="weSlot">${weSlotSel}</select></label>
                    <label class="mk-slot-row"><span>หยุดราชการ</span><select class="mk-inp" data-field="phSlot">${phSlotSel}</select></label>
                </td>
                <td class="mk-center"><input type="checkbox" class="mk-inp" data-field="work"${m.work ? ' checked' : ''}></td>
                <td class="mk-center"><input type="checkbox" class="mk-inp" data-field="light"${m.light ? ' checked' : ''}></td>
                <td class="mk-center"><input type="number" class="mk-inp mk-cap" data-field="maxPerMonth" min="0" value="${m.maxPerMonth || ''}" placeholder="∞"></td>
                <td class="mk-req">
                    <div class="mk-req-presets">
                        <label><input type="checkbox" class="mk-inp" data-field="reqWeekday"${m.reqWeekday ? ' checked' : ''}> ธรรมดา</label>
                        <label><input type="checkbox" class="mk-inp" data-field="reqWeekend"${m.reqWeekend ? ' checked' : ''}> ส-อา</label>
                        <label><input type="checkbox" class="mk-inp" data-field="reqPubHol"${m.reqPubHol ? ' checked' : ''}> ราชการ</label>
                    </div>
                    <div class="mk-dow-row">${dowChips}</div>
                </td>
                <td class="mk-center"><input type="checkbox" class="mk-random"${m.noRandom ? '' : ' checked'}></td>
                <td class="mk-center"><button class="del-marker" data-id="${m.id}" title="ลบ">×</button></td>
            </tr>`;
        }).join('');
        tbl.innerHTML = `<thead><tr>
            <th>ตัวอย่าง</th><th>ข้อความ</th><th>แบบ</th><th>ความหมาย</th><th>ตำแหน่งที่ใช้</th><th>สี</th><th title="ช่วงเวลาเวร (วันธรรมดา/วันหยุด) — ใช้กับกติกา X/ด + การจับคู่สุ่ม · กลางวัน = ครองช่วงกลางวัน">ช่วงเวลา</th><th title="นับเป็นวันทำงาน">นับงาน</th><th title="เวรครึ่งวัน/เบา (เช่น smc) — กติกาพักเสาร์-อาทิตย์: ถ้าทำเวรเต็มวันวันหนึ่ง อีกวันต้อง off (เวรเบาไม่นับเต็มวัน)">ครึ่งวัน</th><th title="จำกัดจำนวนครั้ง/เดือน/คน (ว่าง = ไม่จำกัด) — เช่น บางเวรไม่เกิน 1 ครั้ง/เดือน">จำกัด/เดือน</th><th title="เวรที่ต้องมีในแต่ละวัน — ธรรมดา/ส-อา/ราชการ · ราชการ = วันหยุดราชการเท่านั้น · เลือกวัน = จำกัดเฉพาะวันนั้น">บังคับให้มี</th><th title="ติ๊ก = สุ่มให้อัตโนมัติ · ไม่ติ๊ก = ไม่สุ่ม (ยังนับเป็นเวรบังคับ เตือนถ้าขาด — เติมเอง)">สุ่ม</th><th></th>
        </tr></thead><tbody>${rows}</tbody>`;
    },

    // ---- Leave days popup --------------------------------------------
    editingLeaveStaff: null,

    openLeaveModal(staffId) {
        const s = App.data.staff.find(x => x.id === staffId);
        if (!s) return;
        this.editingLeaveStaff = staffId;
        this.el('leaveModalTitle').textContent = `วันลา — ${s.name} · ${this.monthTitle()}`;
        this.renderLeaveDays();
        this.el('leaveModal').hidden = false;
    },

    renderLeaveDays() {
        const wrap = this.el('leaveDays'), sid = this.editingLeaveStaff;
        if (!wrap || !sid) return;
        const { year, month } = App.data;
        const days = Schedule.daysInMonth(year, month);
        const leave = new Set(App.getLeave(App.currentKey(), sid));
        let h = '';
        for (let d = 1; d <= days; d++) {
            const hol = Schedule.isWeekend(year, month, d) || !!Holidays.get(year, month, d);
            h += `<button class="leave-day${leave.has(d) ? ' on' : ''}${hol ? ' hol' : ''}" data-day="${d}">${d}</button>`;
        }
        wrap.innerHTML = h;
    },

    closeLeaveModal() {
        const m = this.el('leaveModal');
        if (!m || m.hidden) return;
        this.editingLeaveStaff = null;
        m.hidden = true;
        this.renderLeaveTab();
        this.renderScheduleTab();
    },

    // ---- Leave tab (priority list) -----------------------------------
    renderLeaveTab() {
        const tbl = this.el('leaveTable');
        if (!tbl) return;
        const ymKey = App.currentKey();
        const lbl = this.el('leaveMonthLabel'); if (lbl) lbl.textContent = '· ' + this.monthTitle();
        const order = App.getLeaveOrder(ymKey);

        const sel = this.el('leaveAddSelect');
        if (sel) {
            const avail = App.data.staff.filter(s => !s.inactive && !order.includes(s.id));
            sel.innerHTML = avail.length
                ? avail.map(s => `<option value="${s.id}">${this.esc(s.name)}</option>`).join('')
                : '<option value="">— ทุกคนอยู่ในรายการแล้ว —</option>';
        }

        if (!order.length) {
            tbl.innerHTML = '<tbody><tr><td class="muted-note" style="padding:14px">ยังไม่มีคนลาเดือนนี้ — เลือกชื่อด้านบนแล้วกด “เพิ่มคนลา”</td></tr></tbody>';
            return;
        }
        const head = `<thead><tr><th class="num-col">ลำดับ</th><th>ชื่อ</th><th>วันที่ลา</th><th class="act-col"></th></tr></thead>`;
        const rows = order.map((sid, i) => {
            const s = App.data.staff.find(x => x.id === sid); if (!s) return '';
            const chips = App.getLeave(ymKey, sid).slice().sort((a, b) => a - b).map(d => `<span class="leave-chip">${d}</span>`).join(' ');
            return `<tr data-id="${sid}">
                <td class="num-col leave-prio"><b>${i + 1}</b>
                    <button class="leave-move" data-dir="-1" title="เลื่อนขึ้น"${i === 0 ? ' disabled' : ''}>▲</button>
                    <button class="leave-move" data-dir="1" title="เลื่อนลง"${i === order.length - 1 ? ' disabled' : ''}>▼</button>
                </td>
                <td>${this.esc(s.name)}</td>
                <td class="leave-days-cell">${chips || '<span class="muted-note">—</span>'}</td>
                <td class="act-col">
                    <button class="leave-edit btn-secondary" data-id="${sid}">แก้วัน</button>
                    <button class="leave-clear" data-id="${sid}" title="ลบออกจากรายการลา">×</button>
                </td>
            </tr>`;
        }).join('');
        tbl.innerHTML = head + `<tbody>${rows}</tbody>`;
    },

    // ---- Randomize popup ---------------------------------------------
    randomPosId: null,   // null = ทุกตำแหน่ง · id = เฉพาะตำแหน่งนั้น
    openRandomModal(posId) {
        this.randomPosId = posId || null;
        const pos = posId ? App.getPosition(posId) : null;
        this.el('randomModalTitle').textContent = 'สุ่มเวร' + (pos ? ' — ' + this.esc(pos.name) : '') + ' · ' + this.monthTitle();
        const r = this.el('randomResult'); r.textContent = ''; r.className = 'random-result';
        this.renderRandomPickOwn();
        this.el('randomModal').hidden = false;
    },

    renderRandomPickOwn() {
        const wrap = this.el('randomPickOwn'); if (!wrap) return;
        const staff = App.data.staff.filter(s => !s.inactive && (!this.randomPosId || s.pos === this.randomPosId));
        wrap.innerHTML = staff.map(s =>
            `<label class="pickown-opt"><input type="checkbox" class="pickown-chk" data-id="${s.id}"${s.pickOwn ? ' checked' : ''}> ${this.esc(s.name)}</label>`
        ).join('');
    },

    closeRandomModal() { const m = this.el('randomModal'); if (m) m.hidden = true; },

    // print only one position's table (hide the others just for this print)
    printPos(posId) {
        const blocks = Array.from(document.querySelectorAll('.pos-block'));
        blocks.forEach(b => b.classList.toggle('print-skip', b.dataset.pos !== posId));
        const target = blocks.find(b => b.dataset.pos === posId);
        if (target) target.classList.add('print-solo');   // no trailing page-break when alone
        const cleanup = () => { blocks.forEach(b => b.classList.remove('print-skip', 'print-solo')); window.removeEventListener('afterprint', cleanup); };
        window.addEventListener('afterprint', cleanup);
        window.print();
        setTimeout(cleanup, 1000);   // fallback if afterprint doesn't fire
    },

    // ---- Capability (allowed markers) popup ----
    editingCapStaff: null,
    openCapModal(staffId) {
        const s = App.data.staff.find(x => x.id === staffId); if (!s) return;
        this.editingCapStaff = staffId;
        this.el('capModalTitle').textContent = 'เงื่อนไขเวร — ' + s.name;
        this.renderCapMarkers();
        this.el('capModal').hidden = false;
    },
    renderCapMarkers() {
        const wrap = this.el('capMarkers'), s = App.data.staff.find(x => x.id === this.editingCapStaff);
        if (!wrap || !s) return;
        const markers = Schedule.markersForPos(s.pos);
        const mustChips = markers.map(m =>
            `<label class="cap-must-chip"><input type="checkbox" class="cap-must-chk" data-marker="${m.id}"${App.mustHaveMarker(s, m.id) ? ' checked' : ''}><span class="mk-chip" style="background:${m.color}">${this.markerInner(m)}</span></label>`).join('');
        const rows = markers.map(m => {
            const allowed = App.canDoMarker(s, m.id);
            const bans = (s.dayBans && s.dayBans[m.id]) || [];
            const dowChips = [1, 2, 3, 4, 5, 6, 0].map(d =>
                `<label class="mk-dow-chip"><input type="checkbox" class="cap-dow" data-marker="${m.id}" data-dow="${d}"${bans.includes(d) ? ' checked' : ''}${allowed ? '' : ' disabled'}><span>${Schedule.DOW_NAMES[d]}</span></label>`).join('');
            return `<div class="cap-row${allowed ? '' : ' cap-off'}">
                <label class="cap-opt"><input type="checkbox" class="cap-chk" data-marker="${m.id}"${allowed ? ' checked' : ''}>
                    <span class="mk-chip" style="background:${m.color}">${this.markerInner(m)}</span>${m.label ? ' ' + this.esc(m.label) : ''}</label>
                <div class="cap-ban"><span class="cap-ban-lbl">ห้ามวัน:</span>${dowChips}</div>
            </div>`;
        }).join('');
        wrap.innerHTML = `<div class="cap-must-row"><span class="cap-must-lbl">ต้องได้ ≥1 เวร/เดือน:</span>${mustChips}</div>${rows}`;
    },
    closeCapModal() {
        const m = this.el('capModal'); if (!m || m.hidden) return;
        this.editingCapStaff = null; m.hidden = true;
        this.renderStaffEditor();
    },

    // ---- Change admin password ----
    openPassModal() {
        if (!App.isAdmin()) return;
        const hasPass = !!App.data.adminPass;
        this.el('passModalTitle').textContent = hasPass ? '🔑 เปลี่ยนรหัส Admin' : '🔑 ตั้งรหัส Admin';
        this.el('passCurrentWrap').hidden = !hasPass;
        this.el('passCurrent').value = '';
        this.el('passNew').value = '';
        this.el('passConfirm').value = '';
        this.el('passMsg').textContent = '';
        this.el('passModal').hidden = false;
    },
    closePassModal() { this.el('passModal').hidden = true; },
    savePassModal() {
        const msg = this.el('passMsg');
        const hasPass = !!App.data.adminPass;
        if (hasPass && !App.checkAdminPass(this.el('passCurrent').value)) { msg.textContent = 'รหัสเดิมไม่ถูกต้อง'; return; }
        const nw = this.el('passNew').value;
        if (!nw) { msg.textContent = 'กรอกรหัสใหม่'; return; }
        if (nw !== this.el('passConfirm').value) { msg.textContent = 'ยืนยันรหัสไม่ตรงกัน'; return; }
        App.setAdminPass(nw);
        this.closePassModal();
    },

    // ---- Custom holidays ---------------------------------------------
    editingHoliday: null,

    // Admin clicks a date header → open the holiday popup
    openHolidayModal(th) {
        const day = parseInt(th.dataset.day, 10);
        const { year, month } = App.data;
        const key = Holidays.pad(month) + '-' + Holidays.pad(day);
        const custom = (App.data.customHolidays && App.data.customHolidays[year]) || {};
        this.editingHoliday = { year, month, day, key };

        const mName = Schedule.MONTH_NAMES[month - 1];
        this.el('holModalTitle').textContent = `วันหยุด — ${day} ${mName} ${year}`;
        const nameInp = this.el('holModalName');
        const delBtn = this.el('holModalDelete');
        const saveBtn = this.el('holModalSave');
        const note = this.el('holModalNote');

        if (custom[key]) {
            nameInp.value = custom[key]; nameInp.disabled = false;
            delBtn.hidden = false;
            saveBtn.hidden = false; saveBtn.textContent = 'บันทึก';
            note.textContent = 'แก้ชื่อแล้วกดบันทึก · หรือกดลบเพื่อเอาออก';
        } else {
            const builtin = Holidays.get(year, month, day);
            if (builtin) {
                nameInp.value = builtin; nameInp.disabled = true;
                delBtn.hidden = true; saveBtn.hidden = true;
                note.textContent = 'วันหยุดของระบบ — แก้ไข/ลบไม่ได้';
            } else {
                nameInp.value = ''; nameInp.disabled = false;
                delBtn.hidden = true;
                saveBtn.hidden = false; saveBtn.textContent = '+ เพิ่ม';
                note.textContent = '';
            }
        }
        this.el('holidayModal').hidden = false;
        if (!nameInp.disabled) setTimeout(() => { nameInp.focus(); nameInp.select(); }, 0);
    },

    saveHolidayModal() {
        if (!this.editingHoliday) return;
        const { year, month, day } = this.editingHoliday;
        App.addHoliday(year, month, day, this.el('holModalName').value);
        this.closeHolidayModal();
        this.renderScheduleTab();
        this.renderHolidayManager();
    },

    deleteHolidayModal() {
        if (!this.editingHoliday) return;
        const { year, key } = this.editingHoliday;
        App.removeHoliday(year, key);
        this.closeHolidayModal();
        this.renderScheduleTab();
        this.renderHolidayManager();
    },

    closeHolidayModal() {
        this.editingHoliday = null;
        const m = this.el('holidayModal');
        if (m) m.hidden = true;
    },

    renderHolidayManager() {
        const monthSel = this.el('holMonth');
        if (!monthSel) return;
        if (!monthSel.options.length)
            monthSel.innerHTML = Schedule.MONTH_NAMES.map((n, i) => `<option value="${i + 1}">${n}</option>`).join('');
        const yEl = this.el('holYear');
        if (yEl && !yEl.value) yEl.value = App.data.year;

        const list = this.el('holidayList');
        const ch = App.data.customHolidays || {};
        const years = Object.keys(ch).sort();
        if (!years.length) { list.innerHTML = '<span class="muted-note">ยังไม่มีวันหยุดเพิ่มเติม</span>'; return; }
        list.innerHTML = years.map(y =>
            Object.keys(ch[y]).sort().map(k => {
                const [mm, dd] = k.split('-');
                return `<div class="holiday-item"><span>${parseInt(dd, 10)} ${Schedule.MONTH_NAMES[parseInt(mm, 10) - 1]} ${y} — ${this.esc(ch[y][k])}</span><button class="del-holiday" data-year="${y}" data-key="${k}" title="ลบ">×</button></div>`;
            }).join('')
        ).join('');
    },

    esc(s) {
        return String(s).replace(/[&<>"]/g, ch =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    }
};
