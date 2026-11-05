/**
 * แสงวัฒน์ POS – Google Apps Script (เชื่อมแอปกับ Google Sheet แบบอ่าน+เขียน)
 *
 * วิธีติดตั้ง: ดู google-apps-script/README.md
 *
 * สิ่งที่สคริปต์นี้ทำ
 *  - GET  : ส่งรายการสินค้า + ออเดอร์ทั้งหมดให้แอป
 *  - POST : รับคำสั่งจากแอป (บันทึกออเดอร์ / ลบออเดอร์ / บันทึกสินค้า / ลบสินค้า)
 *           ตัดสต็อกในชีตสินค้า และสร้างชีตสรุป "สรุปรายวัน" กับ "สรุปตามลูกค้า" ใหม่ทุกครั้ง
 */

// ชื่อชีตสินค้า: ถ้าไม่พบชื่อใดในรายการนี้ จะใช้ชีตแรกของไฟล์
var PRODUCT_SHEET_NAMES = ['สินค้า', 'Products', 'products', 'Product'];
var ORDER_SHEET = 'ออเดอร์';
// โฟลเดอร์ Google Drive ที่เก็บรูปสินค้า (ID จากลิงก์ drive.google.com/drive/folders/<ID>)
var IMAGE_FOLDER_ID = '1Tva0JIfdJw6qOxY6Vj8l0FTjeUoxg9JS';
var IMAGE_FOLDER = 'แสงวัฒน์ POS - รูปสินค้า'; // ใช้เมื่อเปิดโฟลเดอร์ด้านบนไม่ได้
var VERSION = 4;
var WARNINGS = []; // ปัญหาที่ไม่ร้ายแรง (เช่น อัปโหลดรูปไม่ได้) ส่งกลับไปแสดงในแอป
var DAILY_SHEET = 'สรุปรายวัน';
var CUSTOMER_SHEET = 'สรุปตามลูกค้า';

// คอลัมน์ในชีตสินค้า (ชื่อหัวคอลัมน์ที่รองรับ – ตัวแรกคือชื่อที่ใช้ตอนสร้างคอลัมน์ใหม่)
// ลำดับในรายการนี้ = ลำดับคอลัมน์ตอนสร้างชีตใหม่
var PRODUCT_FIELDS = {
  id: ['id', 'ID', 'รหัส'],
  name: ['ชื่อสินค้า', 'name', 'productName'],
  brand: ['แบรนด์', 'brand', 'ตรา'],
  category: ['หมวดหมู่', 'category', 'type'],
  bagPrice: ['ราคาขายต่อถุง', 'bagPrice', 'retailPrice'],
  kgPrice: ['ราคาขายต่อกก.', 'kgPrice', 'pricePerKg'],
  bagStock: ['สต็อกถุง', 'bagStock', 'stockBags', 'stock'],
  kgStock: ['สต็อกกก.', 'kgStock', 'stockKg'],
  status: ['สถานะ', 'status'],
  cost: ['ราคาทุน', 'cost', 'baseCost'],
  labor: ['ค่าคนงาน', 'labor', 'laborCost'],
  freight: ['ค่าบรรทุก', 'freight', 'transportCost'],
  unitCost: ['ต้นทุนรวม', 'unitCost', 'totalCost'],
  kgPerBag: ['กก.ต่อถุง', 'kgPerBag', 'bagSize', 'weight'],
  img: ['รูปภาพ', 'img', 'imageUrl', 'รูป'],
};
var NUMBER_FIELDS = ['cost', 'labor', 'freight', 'unitCost', 'kgPerBag', 'bagPrice', 'kgPrice', 'bagStock', 'kgStock'];

var ORDER_HEADERS = ['เลขที่ออเดอร์', 'createdAt', 'วันที่', 'ลูกค้า', 'productId', 'สินค้า', 'หน่วย', 'จำนวน',
  'ราคา/หน่วย', 'ยอดขาย', 'ต้นทุน/หน่วย', 'ต้นทุน', 'กำไร'];

// ------------------------------------------------------------------ entry points

function doGet(e) {
  // เปิด URL นี้ต่อท้ายด้วย ?diag=1 ในเบราว์เซอร์ เพื่อตรวจระบบเก็บรูป
  if (e && e.parameter && e.parameter.diag) return json_(diagnose_());
  return json_({ ok: true, version: VERSION, products: readProducts_(), orders: readOrders_() });
}

/** ตรวจว่าสคริปต์เข้าโฟลเดอร์รูป สร้างไฟล์ และแชร์ไฟล์ได้หรือไม่ */
function diagnose_() {
  var r = { ok: true, version: VERSION, folderIdSetting: IMAGE_FOLDER_ID };
  try {
    var f = DriveApp.getFolderById(IMAGE_FOLDER_ID);
    r.folderAccess = true; r.folderName = f.getName();
  } catch (err) { r.folderAccess = false; r.folderError = String(err && err.message || err); }
  try {
    var folder = imageFolder_();
    r.usingFolder = folder.getName(); r.usingFolderId = folder.getId();
    var file = folder.createFile(Utilities.newBlob('test', 'text/plain', '_ทดสอบระบบรูป.txt'));
    r.canWrite = true;
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); r.canShare = true; }
    catch (err) { r.canShare = false; r.shareError = String(err && err.message || err); }
    file.setTrashed(true);
  } catch (err) { r.canWrite = false; r.writeError = String(err && err.message || err); }
  try {
    var products = readProducts_();
    r.products = products.length;
    r.productsWithImage = products.filter(function (p) { return String(p.img || '').trim() !== ''; }).length;
  } catch (err) { r.sheetError = String(err && err.message || err); }
  return r;
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  WARNINGS = [];
  try {
    var action = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    switch (action.type) {
      case 'upsertOrders': upsertOrders_(action.orders || [], !!action.deductStock); break;
      case 'deleteOrders': deleteOrders_(action.ids || [], !!action.restock); break;
      case 'saveProduct': saveProduct_(action.product); break;
      case 'deleteProduct': deleteProduct_(action.id); break;
      case 'setProductImage': setProductImage_(action.id, action.img); break;
      case 'ping': break;
      default: throw new Error('unknown action: ' + action.type);
    }
    if (['upsertOrders', 'deleteOrders'].indexOf(action.type) >= 0) rebuildSummaries_();
    return json_({ ok: true, version: VERSION, warnings: WARNINGS, products: readProducts_(), orders: readOrders_() });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * รันฟังก์ชันนี้ครั้งแรกจากหน้าแก้ไขสคริปต์ (เลือก setup แล้วกด ▶ เรียกใช้)
 * จะสร้างชีตทั้งหมดพร้อมหัวตารางให้อัตโนมัติ: สินค้า, ออเดอร์, สรุปรายวัน, สรุปตามลูกค้า
 * รันซ้ำได้ ไม่ลบข้อมูลเดิม
 */
function setup() {
  var products = productSheet_();
  productColumns_(products, true);
  products.getRange(1, 1, 1, products.getLastColumn()).setFontWeight('bold').setBackground('#edf4ec');
  products.setFrozenRows(1);
  products.setColumnWidth(2, 200);
  orderSheet_();
  rebuildSummaries_();
  imageFolder_(); // ขอสิทธิ์ Google Drive สำหรับเก็บรูปสินค้า
  SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(products);
}

// ------------------------------------------------------------------ products

function productSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  for (var i = 0; i < PRODUCT_SHEET_NAMES.length; i++) {
    var s = ss.getSheetByName(PRODUCT_SHEET_NAMES[i]);
    if (s) return s;
  }
  var first = ss.getSheets()[0];
  var reserved = [ORDER_SHEET, DAILY_SHEET, CUSTOMER_SHEET].indexOf(first.getName()) >= 0;
  if (!reserved && first.getLastRow() === 0) {
    first.setName(PRODUCT_SHEET_NAMES[0]); // ไฟล์ใหม่ที่ยังว่าง: ใช้ชีตแรกเป็นชีตสินค้า
    return first;
  }
  if (reserved) return ss.insertSheet(PRODUCT_SHEET_NAMES[0], 0);
  return first; // ชีตแรกมีข้อมูลสินค้าอยู่แล้ว
}

/** หาเลขคอลัมน์ (เริ่ม 0) ของแต่ละฟิลด์ ถ้ายังไม่มีคอลัมน์และ create=true จะเพิ่มคอลัมน์ใหม่ท้ายตาราง */
function productColumns_(sheet, create) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  var lower = headers.map(function (h) { return h.toLowerCase(); });
  var cols = {};
  Object.keys(PRODUCT_FIELDS).forEach(function (field) {
    var aliases = PRODUCT_FIELDS[field];
    for (var i = 0; i < aliases.length; i++) {
      var idx = lower.indexOf(aliases[i].toLowerCase());
      if (idx >= 0) { cols[field] = idx; return; }
    }
    if (create) {
      var empty = headers.every(function (h) { return h === ''; });
      var col = empty && headers.length === 1 && Object.keys(cols).length === 0 ? 0 : headers.length;
      sheet.getRange(1, col + 1).setValue(aliases[0]).setFontWeight('bold');
      headers[col] = aliases[0];
      lower[col] = aliases[0].toLowerCase();
      cols[field] = col;
    }
  });
  return cols;
}

function ensureProductIds_(sheet, cols) {
  var last = sheet.getLastRow();
  if (last < 2) return;
  var ids = sheet.getRange(2, cols.id + 1, last - 1, 1).getValues();
  var names = sheet.getRange(2, cols.name + 1, last - 1, 1).getValues();
  var changed = false;
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === '' && String(names[i][0]).trim() !== '') {
      ids[i][0] = 'gs-' + String(names[i][0]).trim();
      changed = true;
    }
  }
  if (changed) sheet.getRange(2, cols.id + 1, ids.length, 1).setValues(ids);
}

function readProducts_() {
  var sheet = productSheet_();
  var cols = productColumns_(sheet, true);
  ensureProductIds_(sheet, cols);
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var values = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  return values
    .filter(function (row) { return String(row[cols.name]).trim() !== ''; })
    .map(function (row) {
      var p = {};
      Object.keys(cols).forEach(function (field) {
        var v = row[cols[field]];
        p[field] = NUMBER_FIELDS.indexOf(field) >= 0 ? (Number(v) || 0) : String(v === null || v === undefined ? '' : v);
      });
      return p;
    });
}

function findProductRow_(sheet, cols, id, name) {
  var last = sheet.getLastRow();
  if (last < 2) return -1;
  var ids = sheet.getRange(2, cols.id + 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  if (name) {
    var names = sheet.getRange(2, cols.name + 1, last - 1, 1).getValues();
    for (var j = 0; j < names.length; j++) if (String(names[j][0]).trim() === String(name).trim()) return j + 2;
  }
  return -1;
}

function saveProduct_(p) {
  if (!p || !p.name) throw new Error('product name is required');
  var sheet = productSheet_();
  var cols = productColumns_(sheet, true);
  var row = findProductRow_(sheet, cols, p.id, p.name);
  if (row < 0) row = sheet.getLastRow() + 1;
  var stock = (Number(p.bagStock) || 0) + (Number(p.kgStock) || 0);
  Object.keys(cols).forEach(function (field) {
    var v;
    if (field === 'status') v = stock > 0 ? 'มีสินค้า' : 'สินค้าหมด';
    else if (field === 'img') {
      v = String(p.img || '');
      if (v.indexOf('data:') === 0) {
        // รูปที่อัปโหลดจากเครื่อง → เก็บใน Google Drive แล้วใส่ลิงก์ (รูปเก่าของสินค้านี้ย้ายไปถังขยะ)
        var oldUrl = String(sheet.getRange(row, cols.img + 1).getValue());
        try {
          v = storeImage_(v, p.name, p.brand);
          if (v) trashImage_(oldUrl);
        } catch (err) {
          WARNINGS.push('อัปโหลดรูป "' + p.name + '" ไปที่ Google Drive ไม่สำเร็จ: ' + String(err && err.message || err));
          return; // บันทึกข้อมูลสินค้าอื่นตามปกติ ข้ามเฉพาะรูป
        }
      }
      if (v.length > 40000) return;
    } else v = p[field];
    if (v === undefined || v === null) v = NUMBER_FIELDS.indexOf(field) >= 0 ? 0 : '';
    sheet.getRange(row, cols[field] + 1).setValue(v);
  });
}

/** อัปโหลดรูปของสินค้าที่มีอยู่แล้ว (ใช้ตอนย้ายรูปเก่าจากเครื่องขึ้น Drive) แก้เฉพาะช่องรูป */
function setProductImage_(id, img) {
  var sheet = productSheet_();
  var cols = productColumns_(sheet, true);
  var row = findProductRow_(sheet, cols, id, null);
  if (row < 0 || !img) return;
  var cell = sheet.getRange(row, cols.img + 1);
  if (String(cell.getValue()).trim() !== '') return; // มีรูปอยู่แล้ว ไม่ทับ
  var name = String(sheet.getRange(row, cols.name + 1).getValue());
  var brand = cols.brand !== undefined ? String(sheet.getRange(row, cols.brand + 1).getValue()) : '';
  var url;
  try {
    url = String(img).indexOf('data:') === 0 ? storeImage_(img, name, brand) : String(img);
  } catch (err) {
    WARNINGS.push('อัปโหลดรูป "' + name + '" ไปที่ Google Drive ไม่สำเร็จ: ' + String(err && err.message || err));
    return;
  }
  if (url) cell.setValue(url);
}

function imageFolder_() {
  if (IMAGE_FOLDER_ID) {
    try { return DriveApp.getFolderById(IMAGE_FOLDER_ID); } catch (err) { /* ไม่มีสิทธิ์เข้าโฟลเดอร์ → ใช้โฟลเดอร์สำรอง */ }
  }
  var it = DriveApp.getFoldersByName(IMAGE_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(IMAGE_FOLDER);
}

/**
 * บันทึกรูป (data URL) ลง Google Drive เปิดให้ทุกคนที่มีลิงก์ดูได้ และคืนลิงก์สำหรับแสดงในแอป
 * ชื่อไฟล์: <ชื่อสินค้า> - <แบรนด์> - <วันเวลา>.jpg  เช่น "ข้าวเหนียว - ตราเสือดำ - 2026-11-05 1430.jpg"
 */
function storeImage_(dataUrl, name, brand) {
  var m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(String(dataUrl));
  if (!m) return '';
  var ext = m[1].split('/')[1].replace('jpeg', 'jpg');
  var clean = function (t) { return String(t || '').replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80); };
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyy-MM-dd HHmm');
  var parts = [clean(name) || 'สินค้า'];
  if (clean(brand)) parts.push(clean(brand));
  parts.push(stamp);
  var blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], parts.join(' - ') + '.' + ext);
  var file = imageFolder_().createFile(blob);
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (err) {
    // บางบัญชีองค์กรไม่อนุญาตให้แชร์สาธารณะ รูปจะยังถูกเก็บ แต่คนอื่นอาจเปิดไม่ได้
  }
  return 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w1000';
}

/** ย้ายรูปเก่าที่สคริปต์เคยอัปโหลดไปถังขยะ (เฉพาะไฟล์ในโฟลเดอร์รูปสินค้า) */
function trashImage_(url) {
  var m = /[?&]id=([\w-]+)/.exec(String(url || ''));
  if (!m) return;
  try {
    var file = DriveApp.getFileById(m[1]);
    var folderId = imageFolder_().getId();
    var parents = file.getParents();
    while (parents.hasNext()) if (parents.next().getId() === folderId) { file.setTrashed(true); return; }
  } catch (err) { /* ไม่มีไฟล์ / ไม่มีสิทธิ์ – ข้ามไป */ }
}

function deleteProduct_(id) {
  var sheet = productSheet_();
  var cols = productColumns_(sheet, true);
  var row = findProductRow_(sheet, cols, id, null);
  if (row > 0) sheet.deleteRow(row);
}

/** sign = -1 ตัดสต็อก, +1 คืนสต็อก */
function adjustStock_(items, sign) {
  var sheet = productSheet_();
  var cols = productColumns_(sheet, true);
  items.forEach(function (i) {
    var row = findProductRow_(sheet, cols, i.id, i.name);
    if (row < 0) return;
    var col = (i.unit === 'kg' ? cols.kgStock : cols.bagStock) + 1;
    var cell = sheet.getRange(row, col);
    var next = Math.max(0, Math.round(((Number(cell.getValue()) || 0) + sign * (Number(i.qty) || 0)) * 100) / 100);
    cell.setValue(next);
    var bag = Number(sheet.getRange(row, cols.bagStock + 1).getValue()) || 0;
    var kg = Number(sheet.getRange(row, cols.kgStock + 1).getValue()) || 0;
    sheet.getRange(row, cols.status + 1).setValue(bag + kg > 0 ? 'มีสินค้า' : 'สินค้าหมด');
  });
}

// ------------------------------------------------------------------ orders

function orderSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ORDER_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(ORDER_SHEET);
    sheet.getRange(1, 1, 1, ORDER_HEADERS.length).setValues([ORDER_HEADERS]).setFontWeight('bold').setBackground('#edf4ec');
    sheet.setFrozenRows(1);
    sheet.getRange('B:C').setNumberFormat('@'); // เก็บวันที่เป็นข้อความ ไม่ให้ชีตแปลงรูปแบบ
  }
  return sheet;
}

function readOrders_() {
  var sheet = orderSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var values = sheet.getRange(2, 1, last - 1, ORDER_HEADERS.length).getValues();
  var byId = {};
  var list = [];
  values.forEach(function (r) {
    var id = String(r[0]);
    if (!id) return;
    var o = byId[id];
    if (!o) {
      o = byId[id] = { id: id, createdAt: String(r[1]), date: String(r[2]), customer: String(r[3]), items: [] };
      list.push(o);
    }
    o.items.push({ id: String(r[4]), name: String(r[5]), unit: r[6] === 'กก.' ? 'kg' : 'bag', qty: Number(r[7]) || 0, price: Number(r[8]) || 0, cost: Number(r[10]) || 0 });
  });
  list.forEach(function (o) {
    o.total = round2_(o.items.reduce(function (s, i) { return s + i.price * i.qty; }, 0));
    o.cost = round2_(o.items.reduce(function (s, i) { return s + i.cost * i.qty; }, 0));
    o.profit = round2_(o.total - o.cost);
  });
  return list.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
}

function upsertOrders_(orders, deductStock) {
  var sheet = orderSheet_();
  var existing = {};
  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().forEach(function (r) { existing[String(r[0])] = true; });
  }
  var rows = [];
  orders.forEach(function (o) {
    if (!o || !o.id || existing[o.id]) return; // บันทึกซ้ำไม่ได้
    (o.items || []).forEach(function (i) {
      var qty = Number(i.qty) || 0, price = Number(i.price) || 0, cost = Number(i.cost) || 0;
      rows.push([o.id, o.createdAt, o.date || String(o.createdAt).slice(0, 10), o.customer, i.id, i.name, i.unit === 'kg' ? 'กก.' : 'ถุง', qty,
        price, round2_(price * qty), cost, round2_(cost * qty), round2_((price - cost) * qty)]);
    });
    if (deductStock) adjustStock_(o.items || [], -1);
  });
  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, ORDER_HEADERS.length).setValues(rows);
}

function deleteOrders_(ids, restock) {
  var sheet = orderSheet_();
  var last = sheet.getLastRow();
  if (last < 2 || !ids.length) return;
  var wanted = {};
  ids.forEach(function (id) { wanted[String(id)] = true; });
  var values = sheet.getRange(2, 1, last - 1, ORDER_HEADERS.length).getValues();
  var returned = [];
  for (var i = values.length - 1; i >= 0; i--) {
    if (wanted[String(values[i][0])]) {
      if (restock) returned.push({ id: String(values[i][4]), name: String(values[i][5]), unit: values[i][6] === 'กก.' ? 'kg' : 'bag', qty: Number(values[i][7]) || 0 });
      sheet.deleteRow(i + 2);
    }
  }
  if (restock && returned.length) adjustStock_(returned, +1);
}

// ------------------------------------------------------------------ summaries

function rebuildSummaries_() {
  var orders = readOrders_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var daily = {};
  var customers = {};
  orders.forEach(function (o) {
    var dk = o.date || (o.createdAt ? localDate_(o.createdAt) : '');
    var d = daily[dk] || (daily[dk] = { key: dk, orders: 0, revenue: 0, cost: 0, profit: 0 });
    var c = customers[o.customer] || (customers[o.customer] = { key: o.customer, orders: 0, revenue: 0, cost: 0, profit: 0 });
    [d, c].forEach(function (s) { s.orders++; s.revenue += o.total; s.cost += o.cost; s.profit += o.profit; });
  });

  writeTable_(ss, DAILY_SHEET, ['วันที่', 'จำนวนออเดอร์', 'ยอดขาย', 'ต้นทุน', 'กำไร'],
    Object.keys(daily).sort().reverse().map(function (k) { var s = daily[k]; return [s.key, s.orders, round2_(s.revenue), round2_(s.cost), round2_(s.profit)]; }));
  writeTable_(ss, CUSTOMER_SHEET, ['ลูกค้า', 'จำนวนออเดอร์', 'ยอดขาย', 'ต้นทุน', 'กำไร'],
    Object.keys(customers).map(function (k) { return customers[k]; }).sort(function (a, b) { return b.revenue - a.revenue; })
      .map(function (s) { return [s.key, s.orders, round2_(s.revenue), round2_(s.cost), round2_(s.profit)]; }));
}

function writeTable_(ss, name, headers, rows) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#edf4ec');
  sheet.setFrozenRows(1);
  sheet.getRange('A:A').setNumberFormat('@');
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    sheet.getRange(2, 3, rows.length, 3).setNumberFormat('#,##0.00');
  }
}

// ------------------------------------------------------------------ helpers

function localDate_(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 10);
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyy-MM-dd');
}

function round2_(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
