// ── Backend สำหรับ ShiftScheduler (วางใน Google Sheet → ส่วนขยาย → Apps Script) ──
// Deploy: Deploy → Manage deployments → ✏️ → Version: New version → Deploy
// ตั้ง Execute as: Me · Who has access: Anyone · URL (…/exec) ใส่ใน js/config.js
// เก็บข้อมูลทั้งชุดเป็น JSON ใน DATA!A1 + สร้างชีตอ่านง่าย 2 ชุด: "เผยแพร่" (admin) และ "แลกเปลี่ยน" (live/swap)

function doPost(e) {
  // serialize concurrent writes so multiple users don't corrupt / overwrite each other's data
  var lock = LockService.getDocumentLock();
  try { lock.waitLock(25000); } catch (le) { return json_({ ok: false, error: 'ระบบกำลังบันทึกของผู้อื่น กรุณาลองใหม่' }); }
  try {
    var body = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (body.action === 'publish') {
      var prev = getData_(ss) || {};
      body.data.swapLog = prev.swapLog || body.data.swapLog || {};   // swap history is staff-authored — never clobber it on admin publish
      setData_(ss, body.data);
      writeScheduleSheets_(ss, body.data);
      return json_({ ok: true });
    }
    // บันทึกร่าง (manual): เก็บ DATA blob อย่างเดียว — ไม่สร้างชีตคน (กันเวร/pin ของกลุ่มที่ยังไม่เผยแพร่หลุด)
    if (body.action === 'saveData') {
      var prevS = getData_(ss) || {};
      body.data.swapLog = prevS.swapLog || body.data.swapLog || {};
      setData_(ss, body.data);
      return json_({ ok: true });
    }
    if (body.action === 'swap') {
      var data = getData_(ss) || {};
      data.schedules = data.schedules || {};
      data.schedules[body.ym] = data.schedules[body.ym] || {};
      var oldCells = data.schedules[body.ym][body.staffId] || {};
      var newCells = (body.cells && Object.keys(body.cells).length) ? body.cells : {};
      // diff old→new per day → append to swap history (server timestamp + staff name)
      var nameOf = '';
      (data.staff || []).forEach(function (s) { if (s.id === body.staffId) nameOf = s.name; });
      data.swapLog = data.swapLog || {};
      var logArr = data.swapLog[body.ym] = data.swapLog[body.ym] || [];
      var seen = {}, d;
      for (d in oldCells) seen[d] = 1;
      for (d in newCells) seen[d] = 1;
      Object.keys(seen).forEach(function (dd) {
        var b = normArr_(oldCells[dd]), a = normArr_(newCells[dd]);
        if (b.join(',') !== a.join(',')) {
          logArr.push({ day: parseInt(dd, 10), staffId: body.staffId, byName: nameOf, before: b, after: a, at: new Date().toISOString() });
        }
      });
      if (logArr.length > 300) data.swapLog[body.ym] = logArr.slice(logArr.length - 300);
      // apply the swap
      if (Object.keys(newCells).length) data.schedules[body.ym][body.staffId] = newCells;
      else delete data.schedules[body.ym][body.staffId];
      setData_(ss, data);
      writeScheduleSheets_(ss, data);   // อัปเดตตาราง "แลกเปลี่ยน" ให้เห็นผลทันที
      return json_({ ok: true, swapLog: data.swapLog[body.ym] });
    }
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (e && e.parameter && e.parameter.mode === 'data') {
      return json_({ ok: true, data: getData_(ss) });
    }
    var sh = ss.getSheetByName('บุคลากร'), staff = [];
    if (sh) {
      var v = sh.getDataRange().getValues();
      for (var i = 1; i < v.length; i++) {
        var name = (v[i][0] || '').toString().trim();
        if (!name) continue;
        staff.push({ name: name, role: (v[i][1] || '').toString().trim(), pos: (v[i][2] || '').toString().trim() });
      }
    }
    return json_({ ok: true, staff: staff });
  } catch (err) { return json_({ ok: false, error: String(err) }); }
}

function normArr_(v) { if (v === null || v === undefined || v === '') return []; return Array.isArray(v) ? v : [v]; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function getData_(ss) { var sh = ss.getSheetByName('DATA'); if (!sh) return null; var v = sh.getRange('A1').getValue(); if (!v) return null; try { return JSON.parse(v); } catch (e) { return null; } }
function setData_(ss, data) { var sh = ss.getSheetByName('DATA') || ss.insertSheet('DATA'); sh.getRange('A1').setValue(JSON.stringify(data)); }

function writeOneSheet_(ss, name, values) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  if (values && values.length) sh.getRange(1, 1, values.length, values[0].length).setValues(values);
}

// สร้างชีตอ่านง่ายจาก DATA: บุคลากร + 2 ชุดตารางเวร (เผยแพร่ / แลกเปลี่ยน)
function writeScheduleSheets_(ss, data) {
  if (!data) return;
  var positions = data.positions || [];
  var staff = data.staff || [];
  var markers = data.markers || [];
  var mkText = {}, mkWork = {};
  markers.forEach(function (m) { mkText[m.id] = m.text || ''; mkWork[m.id] = !!m.work; });

  var posName = {};
  positions.forEach(function (p) { posName[p.id] = p.name; });
  var staffRows = [['ชื่อ-สกุล', 'ตำแหน่งงาน', 'สังกัด']];
  staff.forEach(function (s) { staffRows.push([s.name, s.role || '', posName[s.pos] || '']); });
  writeOneSheet_(ss, 'บุคลากร', staffRows);

  // เขียนชีตอ่านง่ายเฉพาะ "กลุ่มที่เผยแพร่ในเดือนนั้น" (per-month) — เดือน/กลุ่มที่ยังไม่ปล่อย ไม่หลุด
  var pubBy = data.publishedPos || {};
  var pubSnap = data.publishedSchedules || {};
  function pubPositionsFor(ym) {
    var pp = pubBy[ym] || {};
    if (Object.keys(pp).length) return positions.filter(function (p) { return !!pp[p.id]; });
    var snap = pubSnap[ym];
    if (snap && Object.keys(snap).length) return positions;   // legacy: เผยแพร่แบบเดือน (ไม่มี record รายกลุ่ม)
    return [];
  }
  writeSource_(ss, 'เผยแพร่', pubSnap, staff, mkText, mkWork, pubPositionsFor);
  writeSource_(ss, 'แลกเปลี่ยน', data.schedules || {}, staff, mkText, mkWork, pubPositionsFor);
  clearUnpublishedSheets_(ss, data, pubPositionsFor);   // เดือน/กลุ่มที่ยกเลิก/ยังไม่เผยแพร่ → เคลียร์ชีตให้ว่าง
}

// เคลียร์ชีตอ่านง่ายของกลุ่มที่ไม่ได้เผยแพร่ในเดือนนั้น (เช่น กดยกเลิกเผยแพร่ / เดือนถัดไป) ให้เป็นหน้าเปล่า
function clearUnpublishedSheets_(ss, data, pubPositionsFor) {
  var positions = data.positions || [];
  var months = {};
  Object.keys(data.schedules || {}).forEach(function (k) { if (k.indexOf('::') < 0) months[k] = 1; });
  Object.keys(data.publishedSchedules || {}).forEach(function (k) { months[k] = 1; });
  Object.keys(months).forEach(function (ym) {
    var pubIds = {};
    pubPositionsFor(ym).forEach(function (p) { pubIds[p.id] = 1; });
    positions.forEach(function (pos) {
      if (pubIds[pos.id]) return;
      ['เผยแพร่', 'แลกเปลี่ยน'].forEach(function (prefix) {
        var name = (prefix + ' · ' + ym + ' ' + pos.name).replace(/[:\\/?*\[\]]/g, '-').slice(0, 95);
        var sh = ss.getSheetByName(name);
        if (sh) sh.clearContents();
      });
    });
  });
}

function writeSource_(ss, prefix, src, staff, mkText, mkWork, pubPositionsFor) {
  Object.keys(src).sort().forEach(function (ym) {
    if (ym.indexOf('::') >= 0) return;   // draft ร่าง 2/3 (ymKey::d2) — เก็บใน DATA blob แต่ไม่สร้างชีทคน
    var positions = pubPositionsFor(ym);   // เฉพาะกลุ่มที่เผยแพร่ในเดือนนี้
    if (!positions.length) return;
    var parts = ym.split('-');
    var gy = parseInt(parts[0], 10) - 543, m = parseInt(parts[1], 10);
    var days = new Date(gy, m, 0).getDate();
    var monthSched = src[ym] || {};
    positions.forEach(function (pos) {
      var list = staff.filter(function (s) { return s.pos === pos.id; });
      if (!list.length) return;
      var header = ['ชื่อ-สกุล', 'ตำแหน่งงาน'], d;
      for (d = 1; d <= days; d++) header.push(d);
      header.push('รวมเวร');
      var rows = [header];
      list.forEach(function (s) {
        var cells = monthSched[s.id] || {};
        var row = [s.name, s.role || ''], total = 0;
        for (d = 1; d <= days; d++) {
          var v = cells[d];
          var arr = Array.isArray(v) ? v : (v ? [v] : []);
          var txt = [];
          arr.forEach(function (id) { if (mkText[id]) txt.push(mkText[id]); if (mkWork[id]) total++; });
          row.push(txt.join(' '));
        }
        row.push(total || '');
        rows.push(row);
      });
      var name = (prefix + ' · ' + ym + ' ' + pos.name).replace(/[:\\/?*\[\]]/g, '-').slice(0, 95);
      writeOneSheet_(ss, name, rows);
    });
  });
}
