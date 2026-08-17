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

  writeSource_(ss, 'เผยแพร่', data.publishedSchedules || {}, positions, staff, mkText, mkWork);
  writeSource_(ss, 'แลกเปลี่ยน', data.schedules || {}, positions, staff, mkText, mkWork);
}

function writeSource_(ss, prefix, src, positions, staff, mkText, mkWork) {
  Object.keys(src).sort().forEach(function (ym) {
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
