// Auto shift randomizer: fill required slots for the pool, balanced per shift-type,
// respecting leave / conflicts / night pairing. Runs many attempts, keeps the best.
const Randomizer = {
    ATTEMPTS: 400,
    NIGHT_GAP: 6,   // minimum days between a person's night (ด) shifts (soft — relaxes if forced)
    AFT_GAP: 2,     // minimum days between a person's weekday afternoon shifts (counts afternoons carried over from the weekend too)
    WEEKEND_PAIR_RATE: 0.5,  // chance a weekend afternoon pairs onto a morning-person (lower = fewer เช้า+บ่าย pairs)
    MAX_CONSEC: 4,  // max consecutive working days per person (soft — relaxes if forced)
    MAX_NIGHTS: 2,  // hard cap: nights (ด) per person per month — NEVER exceeded

    poolStaff(posId) {
        return Schedule.activeStaffForPos(posId).filter(s => !s.pickOwn);
    },

    markerByText(posId, text) {
        return Schedule.markersForPos(posId).find(m => (m.text || '').trim().toLowerCase() === text.toLowerCase()) || null;
    },

    // required (day, markerId) slots for the month — x is excluded (placed as ด's night pair)
    buildSlots(posId) {
        const { year, month } = App.data;
        const days = Schedule.daysInMonth(year, month);
        const markers = Schedule.markersForPos(posId).filter(m => (m.text || '').trim().toLowerCase() !== 'x');
        const slots = [];
        for (let d = 1; d <= days; d++) {
            const cat = Schedule.dayCategory(year, month, d);
            const dow = Schedule.dayOfWeek(year, month, d);
            markers.forEach(m => { if (Schedule.markerRequiredOn(m, cat, dow)) slots.push({ day: d, markerId: m.id }); });
        }
        return slots;
    },

    run(posId) {
        const pool = this.poolStaff(posId);
        if (!pool.length) return { error: 'ไม่มีเจ้าหน้าที่ใน pool (ทุกคนอาจติ๊กเลือกเวรเอง/ลาศึกษา)' };
        const slots = this.buildSlots(posId);
        if (!slots.length) return { error: 'ยังไม่ได้ตั้งเวรบังคับ — ตั้งใน ⚙️ ตั้งค่าเวร ก่อน' };

        const ymKey = App.currentKey();
        const pickOwn = Schedule.staffForPos(posId).filter(s => s.pickOwn && !s.inactive);
        const dId = (this.markerByText(posId, 'ด') || {}).id;
        const xId = (this.markerByText(posId, 'x') || {}).id;

        let best = null, bestScore = -Infinity;
        for (let a = 0; a < this.ATTEMPTS; a++) {
            const r = this.attempt(slots, pool, pickOwn, ymKey, dId, xId);
            const brokeCost = r.broken.reduce((s, b) => s + b.cost, 0);
            const score = -r.unfilled.length * 1e9 - brokeCost * 1e5 - r.wpNightViol * 4e3 - r.consecViol * 2e3 - r.wdDoubles * 1e3
                - r.nightViol * 1e2 - r.aftViol * 50
                - this.totalVariance(r, pool) * 30 - this.markerVar(r, pool, dId) * 60
                - this.variance(r, pool) - this.wkVariance(r, pool) * 10;
            if (score > bestScore) { bestScore = score; best = r; }
            if (!r.unfilled.length && !r.broken.length && !r.wpNightViol && !r.consecViol && !r.wdDoubles && !r.nightViol && !r.aftViol && this.variance(r, pool) === 0) break;
        }
        this.apply(best, pool, posId, ymKey, dId);
        return { filled: best.assign.length, unfilled: best.unfilled, broken: best.broken, doubles: best.doubles, nightViol: best.nightViol, aftViol: best.aftViol, consecViol: best.consecViol, total: slots.length };
    },

    // weekend slots prefer people who worked fewer weekend-DAYS (rotate full-day-offs)
    cmpBalance(x, y, mid, count, total, weekend, wkDays) {
        if (weekend) { const wx = wkDays[x.id] || 0, wy = wkDays[y.id] || 0; if (wx !== wy) return wx - wy; }
        const cx = count[x.id][mid] || 0, cy = count[y.id][mid] || 0;
        if (cx !== cy) return cx - cy;                     // balance this shift-type
        if (total[x.id] !== total[y.id]) return total[x.id] - total[y.id];
        return Math.random() - 0.5;
    },

    attempt(slots, pool, pickOwn, ymKey, dId, xId) {
        const { year, month } = App.data;
        const days = Schedule.daysInMonth(year, month);
        const day2 = {}, count = {}, total = {}, wkDays = {}, lastNight = {}, lastAft = {};  // day2 = staffId → {day:[markerIds]}
        pool.forEach(s => { day2[s.id] = {}; count[s.id] = {}; total[s.id] = 0; wkDays[s.id] = 0; lastNight[s.id] = 0; lastAft[s.id] = 0; });
        const order = App.getLeaveOrder(ymKey);
        const prio = id => order.indexOf(id);
        const assign = [], unfilled = [], broken = [];
        let doubles = 0, wdDoubles = 0, nightViol = 0, aftViol = 0, consecViol = 0, wpNightViol = 0;

        // process nights first (so day-shifts can rest after them), then morning, then afternoon (so afternoons can pair)
        const rank = s => {
            if (s.markerId === dId) return 0;
            const cat = Schedule.dayCategory(year, month, s.day);
            return App.slotFlags(App.getMarker(s.markerId), cat).morning ? 1 : 2;
        };
        const ordered = this.shuffle(slots.slice()).sort((a, b) => rank(a) - rank(b));

        ordered.forEach(slot => {
            if (pickOwn.some(s => App.getCellIn(ymKey, s.id, slot.day).includes(slot.markerId))) return;

            const marker = App.getMarker(slot.markerId);
            const isNight = slot.markerId === dId;
            const holiday = Schedule.isHoliday(year, month, slot.day);
            const cat = Schedule.dayCategory(year, month, slot.day);
            const mf = App.slotFlags(marker, cat);   // ช่วงเวลาจริงของเวรนี้ในวันนี้ (smc = บ่าย/กลางวัน)
            const eve = isNight ? Schedule.shiftDate(year, month, slot.day, -1) : null;
            const eveSame = eve && App.ymKey(eve.year, eve.month) === ymKey;

            const cells = s => day2[s.id][slot.day] || [];
            const emptyDay = s => cells(s).length === 0 && (!isNight || !eveSame || (day2[s.id][eve.day] || []).length === 0);
            const onLeave = s => App.getLeave(ymKey, s.id).includes(slot.day)
                || (isNight && eveSame && App.getLeave(ymKey, s.id).includes(eve.day));
            // one person can hold a compatible pair: morning+afternoon/smc, or morning+x (going on night — balancing only)
            const canDouble = s => {
                if (isNight) return false;
                const c = cells(s); if (c.length !== 1) return false;
                const ex = App.getMarker(c[0]);
                if (!ex || ex.id === marker.id) return false;
                if (App.isNoAfternoonMarker(ex) && mf.morning) return true;   // เช้า/กลางวัน + x (ก่อนขึ้นดึก)
                const ef = App.slotFlags(ex, cat);
                return !App.pairConflict(ex, marker, cat)
                    && ((ef.morning && mf.afternoon) || (ef.afternoon && mf.morning));
            };
            // space out repeated shifts: nights ≥ NIGHT_GAP, weekday afternoons ≥ AFT_GAP (relax if forced)
            const relax = list => {
                if (isNight) {
                    const ok = list.filter(s => !lastNight[s.id] || (slot.day - lastNight[s.id]) >= this.NIGHT_GAP);
                    return ok.length ? ok : list;
                }
                if (!holiday && mf.afternoon) {
                    const ok = list.filter(s => !lastAft[s.id] || (slot.day - lastAft[s.id]) >= this.AFT_GAP);
                    return ok.length ? ok : list;
                }
                return list;
            };

            // rest the day after a night (ด), and keep working days ≤ MAX_CONSEC (relax if forced)
            const soft = list => {
                const f = list.filter(s => !((day2[s.id][slot.day - 1] || []).includes(dId))
                    && this.consecRun(day2, s.id, slot.day, days) <= this.MAX_CONSEC);
                return f.length ? f : list;
            };

            // สถานที่ทำงานต้องมาครบวันนี้ → เลี่ยงลง ด ให้คนสังกัดนั้น (ผ่อนเฉพาะเมื่อไม่มีทางเลือก)
            const wpNight = list => {
                if (!isNight) return list;
                const dow = Schedule.dayOfWeek(year, month, slot.day);
                const ok = list.filter(s => !App.staffNoNightOn(s, dow));
                return ok.length ? ok : list;
            };

            // per-person limits: under monthly cap + allowed to do this shift + hard night cap (≤ MAX_NIGHTS, never relaxed)
            const canPick = s => (!s.maxShifts || total[s.id] < s.maxShifts)
                && App.canDoMarker(s, slot.markerId)
                && (!isNight || (count[s.id][dId] || 0) < this.MAX_NIGHTS);
            const freeC = soft(relax(wpNight(pool.filter(s => canPick(s) && emptyDay(s) && !onLeave(s)))));
            const dblC = soft(pool.filter(s => canPick(s) && canDouble(s) && !onLeave(s)));
            const leaveC = soft(relax(wpNight(pool.filter(s => canPick(s) && emptyDay(s) && onLeave(s)))));

            // holiday afternoon (เสาร์-อาทิตย์ + วันหยุดราชการ) → sometimes PAIR onto a morning-person (frees others for a whole day off)
            const preferPair = holiday && mf.afternoon && !isNight && Math.random() < this.WEEKEND_PAIR_RATE;
            const tiers = preferPair
                ? [[dblC, 'double'], [freeC, 'free'], [leaveC, 'leave']]
                : [[freeC, 'free'], [dblC, 'double'], [leaveC, 'leave']];

            let pick = null, mode = '';
            for (const [list, m] of tiers) {
                if (list.length) {
                    const c = list.slice();
                    c.sort((x, y) => this.cmpBalance(x, y, slot.markerId, count, total, holiday, wkDays));
                    pick = c[0]; mode = m; break;
                }
            }
            if (!pick) { unfilled.push(slot); return; }

            const wasEmpty = (day2[pick.id][slot.day] || []).length === 0;
            const exIsX = mode === 'double' && (day2[pick.id][slot.day] || []).some(id => App.isNoAfternoonMarker(App.getMarker(id)));
            assign.push({ day: slot.day, markerId: slot.markerId, staffId: pick.id, isNight, eve, eveSame });
            (day2[pick.id][slot.day] = day2[pick.id][slot.day] || []).push(slot.markerId);
            count[pick.id][slot.markerId] = (count[pick.id][slot.markerId] || 0) + 1;
            total[pick.id]++;
            if (wasEmpty && this.consecRun(day2, pick.id, slot.day, days) > this.MAX_CONSEC) consecViol++;
            if (holiday && wasEmpty) wkDays[pick.id]++;
            if (isNight) {
                if (lastNight[pick.id] && slot.day - lastNight[pick.id] < this.NIGHT_GAP) nightViol++;
                if (App.staffNoNightOn(pick, Schedule.dayOfWeek(year, month, slot.day))) wpNightViol++;
                lastNight[pick.id] = slot.day;
                if (eveSame) (day2[pick.id][eve.day] = day2[pick.id][eve.day] || []).push(xId || '__eve');
            }
            if (mf.afternoon && !isNight) {
                if (!holiday && lastAft[pick.id] && slot.day - lastAft[pick.id] < this.AFT_GAP) aftViol++;
                lastAft[pick.id] = slot.day;
            }
            if (mode === 'double') { doubles++; if (!holiday || exIsX) wdDoubles++; }   // weekday doubles + เช้า+x are discouraged
            if (mode === 'leave') broken.push({ staffId: pick.id, day: slot.day, cost: order.length - prio(pick.id) });
        });
        return { assign, unfilled, broken, doubles, wdDoubles, nightViol, aftViol, consecViol, wpNightViol, count, total, wkDays };
    },

    // length of the consecutive worked-day run if `day` is added (looks both directions)
    consecRun(day2, sid, day, maxDay) {
        const w = dd => (day2[sid][dd] || []).length > 0;
        let back = 0, dd = day - 1; while (dd >= 1 && w(dd)) { back++; dd--; }
        let fwd = 0; dd = day + 1; while (dd <= maxDay && w(dd)) { fwd++; dd++; }
        return back + 1 + fwd;
    },

    variance_(vals) {
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        return vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length;
    },
    wkVariance(r, pool) { return this.variance_(pool.map(s => r.wkDays[s.id] || 0)); },
    totalVariance(r, pool) { return this.variance_(pool.map(s => r.total[s.id] || 0)); },
    markerVar(r, pool, mid) { return this.variance_(pool.map(s => r.count[s.id][mid] || 0)); },

    // total variance of per-shift-type counts across the pool (lower = fairer)
    variance(r, pool) {
        const mids = {};
        pool.forEach(s => Object.keys(r.count[s.id]).forEach(mid => mids[mid] = true));
        let v = 0;
        Object.keys(mids).forEach(mid => {
            const vals = pool.map(s => r.count[s.id][mid] || 0);
            const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
            v += vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length;
        });
        return v;
    },

    shuffle(a) {
        for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
        return a;
    },

    apply(best, pool, posId, ymKey, dId) {
        const xId = (this.markerByText(posId, 'x') || {}).id;
        // clear pool cells for this month (keep pick-own / manual untouched)
        const monthSched = App.data.schedules[ymKey];
        if (monthSched) pool.forEach(s => { delete monthSched[s.id]; });

        best.assign.forEach(a => {
            const arr = App.getCellIn(ymKey, a.staffId, a.day);
            if (!arr.includes(a.markerId) && arr.length < 2) arr.push(a.markerId);
            App.setCellIn(ymKey, a.staffId, a.day, arr);
            if (a.isNight && xId && a.eve) {                 // place the night's x on the eve day (may be prev month)
                const key = App.ymKey(a.eve.year, a.eve.month);
                const earr = App.getCellIn(key, a.staffId, a.eve.day);
                if (!earr.includes(xId) && earr.length < 2) earr.push(xId);
                App.setCellIn(key, a.staffId, a.eve.day, earr);
            }
        });
        App.save();
    }
};
