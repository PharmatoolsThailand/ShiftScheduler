// ── Backend สำหรับ ShiftScheduler (วางใน Google Sheet → ส่วนขยาย → Apps Script) ──
// Deploy: Deploy → Manage deployments → ✏️ → Version: New version → Deploy
// ตั้ง Execute as: Me · Who has access: Anyone · URL (…/exec) ใส่ใน js/config.js
// เก็บข้อมูลทั้งชุดเป็น JSON ในชีต DATA!A1 + เขียนชีตอ่านง่ายรายเดือน/ตำแหน่ง

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (body.action === 'publish') {
      setData_(ss, body.data);
      writeSheets_(ss, body.sheets || []);
      return json_({ ok: true });
    }
    if (body.action === 'swap') {
      var data = getData_(ss) || {};
      data.schedules = data.schedules || {};
      data.schedules[body.ym] = data.schedules[body.ym] || {};
      if (body.cells && Object.keys(body.cells).length) data.schedules[body.ym][body.staffId] = body.cells;
      else delete data.schedules[body.ym][body.staffId];
      setData_(ss, data);
      return json_({ ok: true });
    }
    writeSheets_(ss, body.sheets || []); // legacy: human sheets only
    return json_({ ok: true, count: (body.sheets || []).length });
  } catch (err) { return json_({ ok: false, error: String(err) }); }
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

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function getData_(ss) { var sh = ss.getSheetByName('DATA'); if (!sh) return null; var v = sh.getRange('A1').getValue(); if (!v) return null; try { return JSON.parse(v); } catch (e) { return null; } }
function setData_(ss, data) { var sh = ss.getSheetByName('DATA') || ss.insertSheet('DATA'); sh.getRange('A1').setValue(JSON.stringify(data)); }
function writeSheets_(ss, sheets) { sheets.forEach(function (shd) { var sheet = ss.getSheetByName(shd.name) || ss.insertSheet(shd.name); sheet.clearContents(); if (shd.values && shd.values.length) { sheet.getRange(1, 1, shd.values.length, shd.values[0].length).setValues(shd.values); } }); }
