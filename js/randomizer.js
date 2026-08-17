// Auto shift randomizer: fill required slots for the pool, balanced per shift-type,
// respecting leave / conflicts / night pairing. Runs many attempts, keeps the best.
const Randomizer = {
    ATTEMPTS: 400,
    NIGHT_GAP: 6,       // preferred days between a person's night (ด) shifts (soft — relaxes toward MIN_NIGHT_GAP)
    MIN_NIGHT_GAP: 5,   // HARD floor: a person's nights must be ≥ this many days apart (ยอมเว้นช่องดีกว่าละเมิด)
    AFT_GAP: 2,     // minimum days between a person's weekday afternoon shifts (counts afternoons carried over from the weekend too)
    WEEKEND_PAIR_RATE: 0.5,  // chance a weekend afternoon pairs onto a morning-person (lower = fewer เช้า+บ่าย pairs)
    MAX_CONSEC: 4,  // max consecutive working days per person (soft — relaxes if forced)
    MAX_NIGHTS: 2,  // hard cap: nights (ด) per person per month — NEVER exceeded
    WP_NIGHT_BIAS: 2,  // workplace "must attend this dow": treat their night on that dow as +N already-done (spread, not block)
    WP_NIGHT_CAP: 2,   // soft cap: one workplace takes ≤ N nights on a must-attend dow/เดือน, then overflow to others

    poolStaff(posId) {
        return Schedule.activeStaffForPos(posId).filter(s => !s.pickOwn);
    },

    markerByText(posId, text) {
        return Schedule.markersForPos(posId).find(m => (m.text || '').trim().toLowerCase() === text.toLowerCase()) || null;
    },

    // "เช้าขีดเส้นใต้" = morning marker with underline decoration (coupled to 1-night rule)
    underlineMorningId(posId) {
        const cat = Schedule.dayCategory(App.data.year, App.data.month, 1);
        const m = Schedule.markersForPos(posId).find(mk => mk.deco === 'underline' && App.slotFlags(mk, cat).morning);
        return m ? m.id : '';
    },

    // required (day, markerId) slots for the month — x is excluded (placed as ด's night pair)
    buildSlots(posId) {
        const { year, month } = App.data;
        const days = Schedule.daysInMonth(year, month);
        const markers = Schedule.markersForPos(posId).filter(m => (m.text || '').trim().toLowerCase() !== 'x' && !m.noRandom);
        const ymKey = App.ymKey(year, month);
        const slots = [];
        for (let d = 1; d <= days; d++) {
            const cat = Schedule.dayCategory(year, month, d);
            const dow = Schedule.dayOfWeek(year, month, d);
            markers.forEach(m => {
                if (!Schedule.markerRequiredOn(m, cat, dow)) return;
                const sp = App.splitForMarker(m.id);   // shared shift → only fill this pos's assigned half
                if (sp && App.splitPosFor(sp, ymKey, d) !== posId) return;
                slots.push({ day: d, markerId: m.id });
            });
        }
        return slots;
    },

    // manual-pinned cells for the pool this month: which days are frozen, which slots are pre-covered, seed values
    gatherLocks(pool, ymKey) {
        const bySt = {}, slots = {}, seed = [];
        pool.forEach(s => {
            App.lockedDaysFor(ymKey, s.id).forEach(day => {
                const ids = App.getCellIn(ymKey, s.id, day);
                if (!ids.length) return;
                (bySt[s.id] = bySt[s.id] || new Set()).add(day);
                ids.forEach(mid => {
                    seed.push({ staffId: s.id, day, markerId: mid, isX: App.isNoAfternoonMarker(App.getMarker(mid)) });
                    (slots[day] = slots[day] || new Set()).add(mid);
                });
            });
        });
        return { bySt, slots, seed };
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
        const uId = this.underlineMorningId(posId);
        // rotate underline-morning: people who held it in LAST month's published schedule step aside this month
        const uPrev = uId ? new Set(pool.filter(s => App.hadMarkerLastPublished(s.id, uId)).map(s => s.id)) : new Set();
        const pos = App.getPosition(posId) || {};
        const noPair = !!pos.noPair;         // ไม่จับคู่ เช้า+บ่าย เสาร์อาทิตย์ (คละคน)
        const matchPair = !!pos.matchPair;   // ควบเต็มวัน เช้า+บ่าย เส้นเดียวกัน (ช*↔บ*) — คนเดียวทั้งวัน อีกวันหยุด
        const locks = this.gatherLocks(pool, ymKey);   // เวรที่จัดเอง (pin) — คงไว้ + เติมรอบ ๆ

        let best = null, bestScore = -Infinity;
        for (let a = 0; a < this.ATTEMPTS; a++) {
            const r = this.attempt(slots, pool, pickOwn, ymKey, dId, xId, uId, uPrev, noPair, matchPair, locks);
            const brokeCost = r.broken.reduce((s, b) => s + b.cost, 0);
            // coupling rules: 1-night person must get ≥1 underline-morning · per-person must-have markers
            const n1uGap = uId ? pool.filter(s => (r.count[s.id][dId] || 0) === 1 && !(r.count[s.id][uId] || 0)).length : 0;
            const mustGap = pool.reduce((n, s) => n + ((s.mustHave || []).filter(mid => !(r.count[s.id][mid] || 0)).length), 0);
            const score = -r.unfilled.length * 1e9 - brokeCost * 1e5 - (n1uGap + mustGap) * 8e3
                - r.wkRestLast * 2.5e3 - r.consecViol * 2e3 - r.rotRepeat * 1.5e3 - r.wdDoubles * 1e3 - r.nightViol * 1e2 - r.aftViol * 50
                - this.totalVariance(r, pool) * 150 - this.markerVar(r, pool, dId) * 60 - r.wkRestMild * 120
                - this.variance(r, pool) - this.wkVariance(r, pool) * 10;
            if (score > bestScore) { bestScore = score; best = r; }
            if (!r.unfilled.length && !r.broken.length && !n1uGap && !mustGap && !r.wkRestLast && !r.consecViol && !r.rotRepeat && !r.wdDoubles && !r.nightViol && !r.aftViol && this.variance(r, pool) === 0) break;
        }
        this.fillHoles(best, pool, dId, ymKey, locks);   // close leftover holes with safe reshuffles (no rule broken)
        this.rebalanceTotals(best, pool, dId, locks);    // tighten total-shift spread toward ±1
        this.apply(best, pool, posId, ymKey, dId);
        return { filled: best.assign.length, unfilled: best.unfilled, broken: best.broken, doubles: best.doubles, nightViol: best.nightViol, aftViol: best.aftViol, consecViol: best.consecViol, total: slots.length };
    },

    // weekend slots prefer people who worked fewer weekend-DAYS (rotate full-day-offs)
    cmpBalance(x, y, mid, count, total, weekend, wkDays) {
        if (weekend) { const wx = wkDays[x.id] || 0, wy = wkDays[y.id] || 0; if (wx !== wy) return wx - wy; }
        const cx = count[x.id][mid] || 0, cy = count[y.id][mid] || 0;
        if (cx !== cy) return cx - cy;                     // หมุนเวรตัวเดียวกันให้กระจายทั้งเดือน (คนได้เวรนี้น้อยสุดก่อน)
        if (total[x.id] !== total[y.id]) return total[x.id] - total[y.id];   // แล้วค่อยเกลี่ยจำนวนเวรรวม (±1 rebalance ทีหลัง)
        return Math.random() - 0.5;
    },

    // "เส้น" ของมาร์กเกอร์ = ข้อความที่ตัดตัวอักษรกะ (ช/บ/ด/x) ออก → ช*↔บ* = "*", (ช)↔(บ) = "()", ช↔บ = ""
    lineKey(m) { return m ? (m.text || '').replace(/[ชบดxX]/g, '').trim() : ''; },

    attempt(slots, pool, pickOwn, ymKey, dId, xId, uId, uPrev, noPair, matchPair, locks) {
        const { year, month } = App.data;
        const days = Schedule.daysInMonth(year, month);
        const day2 = {}, count = {}, total = {}, wkDays = {}, lastNight = {}, lastAft = {};  // day2 = staffId → {day:[markerIds]}
        const wpNightCnt = {};  // workplaceId → nights taken on a "must-attend" dow (spread those across depts)
        pool.forEach(s => { day2[s.id] = {}; count[s.id] = {}; total[s.id] = 0; wkDays[s.id] = 0; lastNight[s.id] = 0; lastAft[s.id] = 0; });
        // "นับงาน" off (work=false, เช่น บส) → ไม่นับเข้ายอดเวรรวมที่ใช้เกลี่ย
        const isWorkShift = mid => { const mk = App.getMarker(mid); return !!(mk && mk.work && !App.isNoAfternoonMarker(mk)); };

        // pre-seed admin-pinned cells so the fill works AROUND them (counts, night-gaps, weekend-rest all include them)
        const lockBy = (locks && locks.bySt) || {}, lockSlots = (locks && locks.slots) || {};
        (locks && locks.seed || []).forEach(l => {
            if (!day2[l.staffId]) return;
            const cell = day2[l.staffId][l.day] || (day2[l.staffId][l.day] = []);
            if (cell.includes(l.markerId)) return;
            cell.push(l.markerId);
            if (!l.isX) count[l.staffId][l.markerId] = (count[l.staffId][l.markerId] || 0) + 1;
            if (isWorkShift(l.markerId)) total[l.staffId]++;
        });
        pool.forEach(s => Object.keys(day2[s.id]).forEach(dStr => {
            const d = +dStr, cell = day2[s.id][d], cat = Schedule.dayCategory(year, month, d);
            if (cell.includes(dId)) lastNight[s.id] = Math.max(lastNight[s.id], d);
            if (cell.some(mid => App.slotFlags(App.getMarker(mid), cat).afternoon)) lastAft[s.id] = Math.max(lastAft[s.id], d);
            if (Schedule.isHoliday(year, month, d) && cell.some(mid => { const mk = App.getMarker(mid); return mk && mk.work && !App.isNoAfternoonMarker(mk); })) wkDays[s.id]++;
        }));
        const order = App.getLeaveOrder(ymKey);
        const prio = id => order.indexOf(id);
        const assign = [], unfilled = [], broken = [];
        let doubles = 0, wdDoubles = 0, nightViol = 0, aftViol = 0, consecViol = 0, wpNightViol = 0, wkRestLast = 0, wkRestMild = 0, rotRepeat = 0;
        const uRepeat = uPrev || new Set();

        // fill MOST-CONSTRAINED slots first (fewer holes): nights → weekend/holiday day-shifts → weekday day-shifts.
        // within a day: morning before afternoon on weekend/holiday (pairing), random order on weekdays (mix for capped people).
        const dayOrder = this.shuffle(Array.from({ length: days }, (_, i) => i + 1));
        const dayRank = {}, dayFlip = {};
        dayOrder.forEach((d, i) => { dayRank[d] = i; dayFlip[d] = Math.random() < 0.5; });
        const WEEKDAY_BASE = (days + 2) * 2;   // weekday day-shifts sort after all weekend/holiday ones
        const rank = s => {
            if (s.markerId === dId) return -1;                          // nights first
            const cat = Schedule.dayCategory(year, month, s.day);
            const isAft = App.slotFlags(App.getMarker(s.markerId), cat).afternoon;
            const holiday = Schedule.isHoliday(year, month, s.day);
            let sub = isAft ? 1 : 0;
            if (!holiday && dayFlip[s.day]) sub = isAft ? 0 : 1;        // weekday: sometimes afternoon first
            return (holiday ? 0 : WEEKDAY_BASE) + dayRank[s.day] * 2 + sub;   // weekend/holiday day-shifts before weekday
        };
        const ordered = this.shuffle(slots.slice()).sort((a, b) => rank(a) - rank(b));

        ordered.forEach(slot => {
            if (pickOwn.some(s => App.getCellIn(ymKey, s.id, slot.day).includes(slot.markerId))) return;
            if (lockSlots[slot.day] && lockSlots[slot.day].has(slot.markerId)) return;   // จัดเองไว้แล้ว — ข้าม

            const marker = App.getMarker(slot.markerId);
            const isNight = slot.markerId === dId;
            const holiday = Schedule.isHoliday(year, month, slot.day);
            const cat = Schedule.dayCategory(year, month, slot.day);
            const dow = Schedule.dayOfWeek(year, month, slot.day);
            const dowRestricted = isNight && (App.data.workplaces || []).some(w => (w.noNightDows || []).includes(dow));
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
                if (lockBy[s.id] && lockBy[s.id].has(slot.day)) return false;   // วันที่ pin ไว้ — ห้ามเติมทับ
                const c = cells(s); if (c.length !== 1) return false;
                const ex = App.getMarker(c[0]);
                if (!ex || ex.id === marker.id) return false;
                if (App.isNoAfternoonMarker(ex) && mf.morning) return true;   // เช้า/กลางวัน + x (ก่อนขึ้นดึก)
                const ef = App.slotFlags(ex, cat);
                if (App.pairConflict(ex, marker, cat)) return false;
                if (!((ef.morning && mf.afternoon) || (ef.afternoon && mf.morning))) return false;
                if (matchPair && this.lineKey(ex) !== this.lineKey(marker)) return false;   // ควบเส้นเดียวกัน: ช*↔บ* เท่านั้น
                return true;
            };
            // space out repeated shifts: nights ≥ NIGHT_GAP, weekday afternoons ≥ AFT_GAP (relax if forced)
            const nightGapOk = (sid, gap) => {
                for (let k = 1; k < gap; k++) {
                    if ((day2[sid][slot.day - k] || []).includes(dId)) return false;
                    if ((day2[sid][slot.day + k] || []).includes(dId)) return false;
                }
                return true;
            };
            const relax = list => {
                if (isNight) {
                    // keep the LARGEST feasible gap: try NIGHT_GAP down to MIN_NIGHT_GAP (< MIN is hard-blocked in canPick)
                    for (let g = this.NIGHT_GAP; g >= this.MIN_NIGHT_GAP; g--) {
                        const ok = list.filter(s => nightGapOk(s.id, g));
                        if (ok.length) return ok;
                    }
                    return list;
                }
                if (!holiday && mf.afternoon) {
                    const ok = list.filter(s => !lastAft[s.id] || (slot.day - lastAft[s.id]) >= this.AFT_GAP);
                    return ok.length ? ok : list;
                }
                return list;
            };

            // spread the SAME marker: avoid giving someone the exact same shift (เช่น ช+) they had the day before (relax if forced)
            const markerSpread = list => {
                if (isNight) return list;   // nights already spaced by NIGHT_GAP
                const ok = list.filter(s => !(day2[s.id][slot.day - 1] || []).includes(slot.markerId));
                return ok.length ? ok : list;
            };
            // rest the day after a night (ด), and keep working days ≤ MAX_CONSEC (relax if forced)
            const soft = list => {
                const f = list.filter(s => !((day2[s.id][slot.day - 1] || []).includes(dId))
                    && this.consecRun(day2, s.id, slot.day, days) <= this.MAX_CONSEC);
                return f.length ? f : list;
            };

            // (สถานที่ทำงานต้องมาครบวันนี้ = soft bias ตอนเลือกดึก ด้านล่าง ไม่ใช่ตัดออก — เกลี่ยดึกข้ามแผนกได้)

            // เวรเต็มวัน (เช้า/บ่าย ที่ไม่ใช่เวรเบา) — smc/ดึก ไม่นับ heavy
            const isHeavy = (mk, c) => {
                if (!mk || !mk.work || mk.light) return false;
                const f = App.slotFlags(mk, c);
                return f.morning || f.afternoon;
            };
            // paired weekend day (เสาร์↔อาทิตย์) within this month, else 0
            const wkPd = dow === 6 && slot.day + 1 <= days ? slot.day + 1
                : dow === 0 && slot.day - 1 >= 1 ? slot.day - 1 : 0;
            const wkPdCat = wkPd ? Schedule.dayCategory(year, month, wkPd) : '';
            // เวรเบากลางวัน (smc) — ทำกลางวันแต่ครึ่งวัน
            const isLightDay = (mk, c) => { if (!mk || !mk.work || !mk.light) return false; const f = App.slotFlags(mk, c); return f.morning || f.afternoon; };
            const mHeavy = isHeavy(marker, cat);
            const mNight = !!(marker.work && App.slotFlags(marker, cat).night);
            const mLightDay = isLightDay(marker, cat);
            // severity of giving this marker to s given the paired weekend day:
            //   0 = ok · 1 = mild (เต็มวัน+smc หรือ smc+smc → ยังไม่มีวันพักเต็ม) · 2 = severe (เต็มวัน + เต็มวัน/ดึก)
            const wkLevel = sid => {
                if (!wkPd) return 0;
                const other = day2[sid][wkPd] || [];
                if (!other.length) return 0;
                const oHeavy = other.some(id => isHeavy(App.getMarker(id), wkPdCat));
                const oNight = other.some(id => { const mm = App.getMarker(id); return mm && mm.work && App.slotFlags(mm, wkPdCat).night; });
                const oLightDay = other.some(id => isLightDay(App.getMarker(id), wkPdCat));
                const oWork = other.some(id => { const mm = App.getMarker(id); return mm && mm.work; });
                if ((mHeavy && oWork) || (marker.work && oHeavy)) {
                    if (mHeavy && oHeavy) return 3;                              // เต็มวัน 2 วัน → ห้ามเด็ดขาด
                    if ((mHeavy && oNight) || (mNight && oHeavy)) return 2;      // เต็มวัน + ดึก → ทางเลือกสุดท้าย
                    return 1;                                                    // เต็มวัน + smc → mild
                }
                if (mLightDay && oLightDay) return 1;   // smc ทั้งเสาร์และอาทิตย์ → ไม่มีวันพัก
                return 0;
            };
            // 1 วันหยุด/เสาร์-อาทิตย์: เลือก clean ก่อน → ถ้าไม่ได้ค่อย mild (เต็มวัน+smc) → severe เป็นทางสุดท้าย
            // per-person limits: monthly cap + allowed shift + not day-banned + hard night cap (per-person maxNights, else MAX_NIGHTS)
            const nightCap = s => (s.maxNights > 0) ? s.maxNights : this.MAX_NIGHTS;
            const canPick = s => (!s.maxShifts || total[s.id] < s.maxShifts)
                && App.canDoMarker(s, slot.markerId)
                && !App.markerBannedOn(s, slot.markerId, dow)
                && (!marker || !marker.maxPerMonth || (count[s.id][slot.markerId] || 0) < marker.maxPerMonth)
                && (!isNight || (count[s.id][dId] || 0) < nightCap(s))
                // HARD: ดึกต้องห่างกัน ≥ MIN_NIGHT_GAP วัน · ห้ามเวรเต็มวัน 2 วันของเสาร์-อาทิตย์ (lvl 3) — ยอมเว้นช่องดีกว่าละเมิด
                && (!isNight || nightGapOk(s.id, this.MIN_NIGHT_GAP))
                && wkLevel(s.id) < 3;
            const freeC = soft(relax(markerSpread(pool.filter(s => canPick(s) && emptyDay(s) && !onLeave(s)))));
            const dblC = soft(markerSpread(pool.filter(s => canPick(s) && canDouble(s) && !onLeave(s))));
            const leaveC = soft(relax(markerSpread(pool.filter(s => canPick(s) && emptyDay(s) && onLeave(s)))));

            // holiday afternoon (เสาร์-อาทิตย์ + วันหยุดราชการ) → sometimes PAIR onto a morning-person (frees others for a whole day off)
            const preferPair = holiday && mf.afternoon && !isNight && !noPair && (matchPair || Math.random() < this.WEEKEND_PAIR_RATE);
            const tiers = preferPair
                ? [[dblC, 'double'], [freeC, 'free'], [leaveC, 'leave']]
                : [[freeC, 'free'], [dblC, 'double'], [leaveC, 'leave']];

            // priority: people who still NEED this marker (1-night→underline, or per-person must-have) go first
            const need = s => {
                if (uId && slot.markerId === uId && (count[s.id][dId] || 0) === 1 && !(count[s.id][uId] || 0)) return true;
                if (App.mustHaveMarker(s, slot.markerId) && !(count[s.id][slot.markerId] || 0)) return true;
                return false;
            };
            // flatten all tiers, then choose across them by: weekend-rest level → tier priority → need → balance
            const cand = [];
            tiers.forEach(([list, m], ti) => list.forEach(s => cand.push({ s, m, ti })));
            let pick = null, mode = '';
            if (cand.length) {
                const rotU = slot.markerId === uId;
                cand.sort((a, b) => {
                    const la = wkLevel(a.s.id), lb = wkLevel(b.s.id);
                    if (la !== lb) return la - lb;
                    if (rotU) {   // underline: last month's holders go last (rotate to someone new)
                        const ra = uRepeat.has(a.s.id) ? 1 : 0, rb = uRepeat.has(b.s.id) ? 1 : 0;
                        if (ra !== rb) return ra - rb;
                    }
                    if (a.ti !== b.ti) return a.ti - b.ti;
                    if (isNight) {
                        // on a "must-attend" dow (เช่น จันทร์): spread that night ACROSS workplaces so one dept
                        // (e.g. IPD) isn't stuck with all of them; restricted depts get a soft bias (help, not block)
                        if (dowRestricted) {
                            // per-workplace: over the cap → sorts last (soft) · restricted dept → +bias
                            const capW = s => { const c = wpNightCnt[s.workplace || ''] || 0; return (c >= this.WP_NIGHT_CAP ? 1000 : 0) + c + (App.staffNoNightOn(s, dow) ? this.WP_NIGHT_BIAS : 0); };
                            const wa = capW(a.s), wb = capW(b.s);
                            if (wa !== wb) return wa - wb;
                        }
                        const pa = count[a.s.id][dId] || 0, pb = count[b.s.id][dId] || 0;   // then balance per-person night count
                        if (pa !== pb) return pa - pb;
                        if (total[a.s.id] !== total[b.s.id]) return total[a.s.id] - total[b.s.id];
                        return Math.random() - 0.5;
                    }
                    const na = need(a.s) ? 1 : 0, nb = need(b.s) ? 1 : 0;
                    if (na !== nb) return nb - na;
                    return this.cmpBalance(a.s, b.s, slot.markerId, count, total, holiday, wkDays);
                });
                pick = cand[0].s; mode = cand[0].m;
            }
            if (!pick) { unfilled.push(slot); return; }

            const wasEmpty = (day2[pick.id][slot.day] || []).length === 0;
            const exIsX = mode === 'double' && (day2[pick.id][slot.day] || []).some(id => App.isNoAfternoonMarker(App.getMarker(id)));
            assign.push({ day: slot.day, markerId: slot.markerId, staffId: pick.id, isNight, eve, eveSame });
            (day2[pick.id][slot.day] = day2[pick.id][slot.day] || []).push(slot.markerId);
            count[pick.id][slot.markerId] = (count[pick.id][slot.markerId] || 0) + 1;
            if (isWorkShift(slot.markerId)) total[pick.id]++;
            if (wasEmpty && this.consecRun(day2, pick.id, slot.day, days) > this.MAX_CONSEC) consecViol++;
            if (holiday && wasEmpty) wkDays[pick.id]++;
            const wl = wkLevel(pick.id);
            if (wl === 2) wkRestLast++; else if (wl === 1) wkRestMild++;   // lvl 3 (เต็มวัน 2 วัน) ถูกกันใน canPick แล้ว
            if (slot.markerId === uId && uRepeat.has(pick.id)) rotRepeat++;
            if (isNight) {
                if (lastNight[pick.id] && slot.day - lastNight[pick.id] < this.NIGHT_GAP) nightViol++;
                if (App.staffNoNightOn(pick, Schedule.dayOfWeek(year, month, slot.day))) wpNightViol++;
                if (dowRestricted) wpNightCnt[pick.workplace || ''] = (wpNightCnt[pick.workplace || ''] || 0) + 1;
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
        return { assign, unfilled, broken, doubles, wdDoubles, nightViol, aftViol, consecViol, wpNightViol, wkRestLast, wkRestMild, rotRepeat, count, total, wkDays, day2 };
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

    // does placing markerId on this person on this day break a HARD rule? (standalone — used by the hole-repair pass)
    _wkSevereFor(sid, markerId, day, day2, dId) {
        const { year, month } = App.data;
        const days = Schedule.daysInMonth(year, month);
        const dow = Schedule.dayOfWeek(year, month, day);
        let pd = 0;
        if (dow === 6 && day + 1 <= days) pd = day + 1;
        else if (dow === 0 && day - 1 >= 1) pd = day - 1;
        if (!pd) return false;
        const cat = Schedule.dayCategory(year, month, day), pdCat = Schedule.dayCategory(year, month, pd);
        const marker = App.getMarker(markerId);
        const isHeavy = (mk, c) => { if (!mk || !mk.work || mk.light) return false; const f = App.slotFlags(mk, c); return f.morning || f.afternoon; };
        const mHeavy = isHeavy(marker, cat), mNight = !!(marker.work && App.slotFlags(marker, cat).night);
        const other = day2[sid][pd] || [];
        if (!other.length) return false;
        const oHeavy = other.some(id => isHeavy(App.getMarker(id), pdCat));
        const oNight = other.some(id => { const mm = App.getMarker(id); return mm && mm.work && App.slotFlags(mm, pdCat).night; });
        const oWork = other.some(id => { const mm = App.getMarker(id); return mm && mm.work; });
        if (!((mHeavy && oWork) || (marker.work && oHeavy))) return false;
        return mHeavy && oHeavy;   // hard = เต็มวัน 2 วันเท่านั้น (เต็มวัน+ดึก ยอมได้เป็น last resort)
    },

    hardEligible(s, markerId, day, day2, count, total, dId, ymKey) {
        const { year, month } = App.data;
        const m = App.getMarker(markerId);
        if (day2[s.id][day] && day2[s.id][day].length) return false;                 // 1 เวร/วัน
        if (s.maxShifts && total[s.id] >= s.maxShifts) return false;                  // เพดานเวรรวม
        if (!App.canDoMarker(s, markerId)) return false;                              // เวรที่ทำได้
        if (App.markerBannedOn(s, markerId, Schedule.dayOfWeek(year, month, day))) return false;  // ห้ามรายวัน
        if (m.maxPerMonth && (count[s.id][markerId] || 0) >= m.maxPerMonth) return false;         // จำกัด/เดือน
        if (App.getLeave(ymKey, s.id).includes(day)) return false;                    // ไม่ดึงคนลา
        if (markerId === dId) {
            const cap = s.maxNights > 0 ? s.maxNights : this.MAX_NIGHTS;
            if ((count[s.id][dId] || 0) >= cap) return false;
            if ((day2[s.id][day - 1] || []).includes(dId) || (day2[s.id][day + 1] || []).includes(dId)) return false;
        }
        if (this._wkSevereFor(s.id, markerId, day, day2, dId)) return false;          // เสาร์-อาทิตย์เต็มวัน 2 วัน
        return true;
    },

    // Repair pass: fill leftover holes WITHOUT breaking any hard rule — by direct fill, or by moving one
    // weekday day-shift to another eligible person to free someone up (augmenting swap). Nights left to admin.
    fillHoles(best, pool, dId, ymKey, locks) {
        const { year, month } = App.data;
        const days = Schedule.daysInMonth(year, month);
        const { day2, count, total, assign } = best;
        const lockBy = (locks && locks.bySt) || {};
        const frozen = (sid, day) => !!(lockBy[sid] && lockBy[sid].has(day));   // pin ไว้ — ห้ามย้าย
        const movable = id => { const mk = App.getMarker(id); return !!(mk && mk.work && id !== dId && !App.isNoAfternoonMarker(mk) && !App.isNoMorningMarker(mk)); };
        const add = (sid, day, mid) => { (day2[sid][day] = day2[sid][day] || []).push(mid); count[sid][mid] = (count[sid][mid] || 0) + 1; total[sid]++; };
        const del = (sid, day, mid) => { const a = day2[sid][day] || []; const i = a.indexOf(mid); if (i >= 0) a.splice(i, 1); if (!a.length) delete day2[sid][day]; count[sid][mid]--; total[sid]--; };
        const consecOk = (sid, day) => this.consecRun(day2, sid, day, days) <= this.MAX_CONSEC;
        const still = [];
        best.unfilled.forEach(slot => {
            const { day, markerId } = slot;
            if (markerId === dId) { still.push(slot); return; }   // nights: leave to admin (x/eve linkage)
            // 1) direct fill — lowest-total eligible free person
            const cands = pool.filter(s => this.hardEligible(s, markerId, day, day2, count, total, dId, ymKey))
                .sort((a, b) => (total[a.id] - total[b.id]) || Math.random() - 0.5);
            for (const s of cands) {
                add(s.id, day, markerId);
                if (consecOk(s.id, day)) { assign.push({ day, markerId, staffId: s.id, isNight: false, eve: null, eveSame: false }); return; }
                del(s.id, day, markerId);
            }
            // 2) augmenting swap — X (working a movable shift m2 today) moves m2 to Y so X can take the hole
            for (const X of pool) {
                if (frozen(X.id, day)) continue;
                const cell = day2[X.id][day];
                if (!cell || cell.length !== 1 || !movable(cell[0])) continue;
                const m2 = cell[0];
                del(X.id, day, m2);
                if (!this.hardEligible(X, markerId, day, day2, count, total, dId, ymKey)) { add(X.id, day, m2); continue; }
                const Y = pool.find(s => s.id !== X.id && this.hardEligible(s, m2, day, day2, count, total, dId, ymKey));
                if (!Y) { add(X.id, day, m2); continue; }
                add(Y.id, day, m2);
                add(X.id, day, markerId);
                if (consecOk(Y.id, day) && consecOk(X.id, day)) {
                    const a = assign.find(z => z.day === day && z.markerId === m2 && z.staffId === X.id && !z.isNight);
                    if (a) a.staffId = Y.id;
                    assign.push({ day, markerId, staffId: X.id, isNight: false, eve: null, eveSame: false });
                    return;
                }
                del(X.id, day, markerId); del(Y.id, day, m2); add(X.id, day, m2);   // revert
            }
            still.push(slot);
        });
        best.unfilled = still;
    },

    // Post-pass: even out total shifts (target spread ≤ 1) by moving plain weekday morning/afternoon
    // shifts from over-loaded to under-loaded people — only where it breaks no rule. ด/x/pairs/weekends left alone.
    rebalanceTotals(best, pool, dId, locks) {
        const { year, month } = App.data;
        const days = Schedule.daysInMonth(year, month);
        const { day2, count, total, assign } = best;
        const lockBy = (locks && locks.bySt) || {};
        const frozen = (sid, day) => !!(lockBy[sid] && lockBy[sid].has(day));   // pin ไว้ — ห้ามย้าย
        const movable = id => {
            const m = App.getMarker(id);
            return !!(m && m.work && id !== dId && !App.isNoAfternoonMarker(m) && !App.isNoMorningMarker(m));
        };
        for (let iter = 0; iter < pool.length * 8; iter++) {
            // lowest-total person who still has capacity
            let lo = null;
            for (const s of pool) {
                if (s.maxShifts && total[s.id] >= s.maxShifts) continue;
                if (!lo || total[s.id] < total[lo.id]) lo = s;
            }
            if (!lo) break;
            let maxT = -Infinity;
            pool.forEach(s => { if (total[s.id] > maxT) maxT = total[s.id]; });
            if (maxT - total[lo.id] <= 1) break;   // already balanced

            let moved = false;
            for (let d = 1; d <= days && !moved; d++) {
                if (Schedule.isHoliday(year, month, d)) continue;             // weekday only
                if (day2[lo.id][d] && day2[lo.id][d].length) continue;        // lo already works that day
                const dow = Schedule.dayOfWeek(year, month, d);
                // pick the most over-loaded donor who has a single movable shift this day that lo can take
                let donor = null, donorMid = null;
                for (const s of pool) {
                    if (s.id === lo.id || total[s.id] <= total[lo.id] + 1) continue;
                    if (frozen(s.id, d)) continue;
                    const cell = day2[s.id][d];
                    if (!cell || cell.length !== 1 || !movable(cell[0])) continue;
                    const mid = cell[0], mk = App.getMarker(mid);
                    if (!App.canDoMarker(lo, mid) || App.markerBannedOn(lo, mid, dow)) continue;
                    if (mk.maxPerMonth && (count[lo.id][mid] || 0) >= mk.maxPerMonth) continue;
                    if (!donor || total[s.id] > total[donor.id]) { donor = s; donorMid = mid; }
                }
                if (!donor) continue;
                if ((day2[lo.id][d - 1] || []).includes(dId) || (day2[lo.id][d + 1] || []).includes(dId)) continue;  // keep rest around nights
                day2[lo.id][d] = [donorMid];
                if (this.consecRun(day2, lo.id, d, days) > this.MAX_CONSEC) { delete day2[lo.id][d]; continue; }
                delete day2[donor.id][d];
                count[donor.id][donorMid]--; count[lo.id][donorMid] = (count[lo.id][donorMid] || 0) + 1;
                total[donor.id]--; total[lo.id]++;
                const a = assign.find(x => x.day === d && x.markerId === donorMid && x.staffId === donor.id && !x.isNight);
                if (a) a.staffId = lo.id;
                moved = true;
            }
            if (!moved) break;
        }
    },

    apply(best, pool, posId, ymKey, dId) {
        const xId = (this.markerByText(posId, 'x') || {}).id;
        // clear pool cells in the ACTIVE draft's store, but KEEP admin-pinned days (pick-own untouched too)
        const monthSched = App.data.schedules[App.draftKey(ymKey)];
        if (monthSched) pool.forEach(s => {
            if (!monthSched[s.id]) return;
            const pinned = App.lockedDaysFor(ymKey, s.id);
            if (!pinned.length) { delete monthSched[s.id]; return; }
            Object.keys(monthSched[s.id]).forEach(dStr => { if (!pinned.includes(+dStr)) delete monthSched[s.id][+dStr]; });
        });
        App.clearCrossMonthX(pool.map(s => s.id));   // remove last month's leftover x paired with a day-1 night

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
