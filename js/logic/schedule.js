// Calendar helpers + per-marker summary calculations
const Schedule = {
    MONTH_NAMES: ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
        'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'],

    DOW_NAMES: ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'],

    // Buddhist year -> Gregorian for Date math
    gregYear(beYear) { return beYear - 543; },

    daysInMonth(beYear, month) {
        return new Date(this.gregYear(beYear), month, 0).getDate();
    },

    dayOfWeek(beYear, month, day) {
        return new Date(this.gregYear(beYear), month - 1, day).getDay();
    },

    // shift a Buddhist-year date by delta days, rolling over month/year → { year, month, day }
    shiftDate(beYear, month, day, delta) {
        const g = new Date(this.gregYear(beYear), month - 1, day + delta);
        return { year: g.getFullYear() + 543, month: g.getMonth() + 1, day: g.getDate() };
    },

    isWeekend(beYear, month, day) {
        const d = this.dayOfWeek(beYear, month, day);
        return d === 0 || d === 6;
    },

    // 3-way วันสำหรับเวรบังคับ: 'pubhol' (ราชการ, สำคัญสุด) > 'weekend' (ส-อา) > 'weekday'
    dayCategory(beYear, month, day) {
        if (Holidays.get(beYear, month, day)) return 'pubhol';
        if (this.isWeekend(beYear, month, day)) return 'weekend';
        return 'weekday';
    },

    // true = วันหยุด (ส-อา หรือ ราชการ) — ใช้กับช่วงเวลา smc + การจับคู่สุ่ม
    isHoliday(beYear, month, day) {
        return this.isWeekend(beYear, month, day) || !!Holidays.get(beYear, month, day);
    },

    isToday(beYear, month, day) {
        const now = new Date();
        return this.gregYear(beYear) === now.getFullYear()
            && month === now.getMonth() + 1
            && day === now.getDate();
    },

    // markers of one position, ordered by colour (palette / summary columns)
    markersForPos(posId) {
        return App.data.markers
            .filter(m => App.markerInPos(m, posId))
            .sort((a, b) => App.colorIndex(a.color) - App.colorIndex(b.color));
    },

    staffForPos(posId) {
        return App.data.staff.filter(s => s.pos === posId);
    },

    // staff who actually take shifts (exclude study-leave/no-shift) — for daily counts
    activeStaffForPos(posId) {
        return this.staffForPos(posId).filter(s => !s.inactive);
    },

    // per-staff counts: { markerId: n, ... , _work: total work-marker count }
    staffSummary(staffId) {
        const out = { _work: 0 };
        const days = this.daysInMonth(App.data.year, App.data.month);
        for (let day = 1; day <= days; day++) {
            App.getCell(staffId, day).forEach(id => {   // getCell overlays the active draft
                out[id] = (out[id] || 0) + 1;
                const m = App.getMarker(id);
                if (m && m.work && !App.isNoAfternoonMarker(m)) out._work++;   // x paired with ด → count the night once
            });
        }
        return out;
    },

    // required markers missing on a given day for one position:
    //   null  = nothing configured as required for this day-type
    //   []    = all required markers present
    //   [m..] = these required markers are not filled by anyone
    // required on this day? day-type must match ธรรมดา/ส-อา/ราชการ preset;
    // if specific days-of-week are chosen, also restrict to them (filter, not a separate rule)
    markerRequiredOn(m, cat, dow) {
        const typeOk = cat === 'pubhol' ? m.reqPubHol : cat === 'weekend' ? m.reqWeekend : m.reqWeekday;
        if (!typeOk) return false;
        if (m.reqDows && m.reqDows.length) return m.reqDows.includes(dow);
        return true;
    },

    requiredMissing(posId, year, month, day) {
        const cat = this.dayCategory(year, month, day);
        const dow = this.dayOfWeek(year, month, day);
        const ymKey = App.ymKey(year, month);
        const required = this.markersForPos(posId).filter(m => {
            if (!this.markerRequiredOn(m, cat, dow)) return false;
            const sp = App.splitForMarker(m.id);       // shared shift → required only on this pos's half
            return !sp || App.splitPosFor(sp, ymKey, day) === posId;
        });
        if (!required.length) return null;
        // มีเวรนี้ไหม (เทียบด้วย id — deco ต่างกันคือคนละเวร) · เวรแชร์ครึ่งเดือน (split) นับว่ามี ถ้าคนใน
        // "ตำแหน่งใดก็ได้ที่แชร์เวรกัน" ลงไว้ — หลังเผยแพร่ 2 กลุ่มแลกเวรข้ามกันได้ ฝั่งที่ขายไปไม่ควรขึ้นว่าขาด
        const has = m => {
            const sp = App.splitForMarker(m.id);
            const pids = sp ? [sp.posFirst, sp.posSecond] : [posId];
            return pids.some(pid => this.activeStaffForPos(pid).some(s => App.getCell(s.id, day).includes(m.id)));
        };
        return required.filter(m => !has(m));
    },

    // marker ids used by 2+ staff (same position) on one day → duplicate shift
    dupMarkersOnDay(posId, day) {
        const count = {};
        this.activeStaffForPos(posId).forEach(s =>
            App.getCell(s.id, day).forEach(id => { count[id] = (count[id] || 0) + 1; }));
        const dup = new Set();
        Object.keys(count).forEach(id => { if (count[id] >= 2) dup.add(id); });
        return dup;
    },

    // total work-shifts (of one position) on a given day — counts each shift (เช้า+บ่าย = 2), x ไม่นับ
    dayShiftsPos(posId, day) {
        let n = 0;
        this.activeStaffForPos(posId).forEach(s => {
            App.getCell(s.id, day).forEach(id => {
                const m = App.getMarker(id);
                if (m && m.work) n++;
            });
        });
        return n;
    }
};
