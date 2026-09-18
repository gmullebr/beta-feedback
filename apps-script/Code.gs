/**
 * Walrus Club Beta - the door.
 *
 * This file is the source of truth and lives in the repo. Google does not read it
 * from here: it is pasted by hand into the Sheet's script editor (README, step 2).
 * Change it here, commit, paste, and redeploy a NEW VERSION, or the live door keeps
 * running the old code.
 *
 * Contract: every response is { ok: true, ... } or { ok: false, error: "message" }.
 */

var REPORTS_TAB = 'reports';
var VOTES_TAB = 'votes';

var REPORT_HEADERS = ['id', 'created_at', 'updated_at', 'name', 'type', 'level', 'text', 'device', 'images', 'deleted'];
var VOTE_HEADERS = ['report_id', 'name', 'created_at'];

var TYPES = ['bug', 'idea', 'other'];

// The letter in front of a report number (#B14). The page works this out too, but
// the door needs it as well to give an uploaded file a name a human can recognise.
var TYPE_LETTERS = { bug: 'B', idea: 'I', other: 'O' };

/*
 * Screenshots (decisions 27 to 31). Two per report, each already shrunk by the
 * page to 1280 px JPEG, so the cap below is generous: it is there to stop someone
 * posting a 40 MB file straight at the door, not to squeeze honest screenshots.
 */
var MAX_IMAGES = 2;
var MAX_IMAGE_BYTES = 1500000;
var IMAGE_FOLDER_NAME = 'Walrus Club Beta Feedback screenshots';

// Levels are per type. An empty array means the type carries no level at all.
var LEVELS = {
  bug: ['blocker', 'annoying', 'cosmetic'],
  idea: ['must', 'nice', 'maybe'],
  other: []
};

var DEVICES = ['iPhone', 'iPad', 'Android', 'Mac', 'Windows', 'Other'];

var LOCK_WAIT_MS = 20000;


/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

/**
 * GET: the whole list. No lock. A read that overlaps a write can miss a report
 * by a second, and the page refetches after every write anyway.
 */
function doGet(e) {
  try {
    return respond({ ok: true, reports: listReports() });
  } catch (err) {
    return respond({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/**
 * POST: every write. The body arrives as text/plain (see README, "Why text/plain"),
 * so it is a plain string that we parse ourselves.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return respond({ ok: false, error: 'Empty request.' });
    }

    var body = JSON.parse(e.postData.contents);
    var action = str(body.action);

    // One script lock around every write. Without it, two phones posting in the
    // same second both read "the highest id is 13" and both write 14.
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_WAIT_MS)) {
      return respond({ ok: false, error: 'The store is busy. Try again.' });
    }

    try {
      switch (action) {
        case 'create': return respond(createReport(body));
        case 'update': return respond(updateReport(body));
        case 'delete': return respond(deleteReport(body));
        case 'vote':   return respond(setVote(body, true));
        case 'unvote': return respond(setVote(body, false));
        default:       return respond({ ok: false, error: 'Unknown action: ' + action });
      }
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return respond({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}


/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

function listReports() {
  var reports = readTable(REPORTS_TAB, REPORT_HEADERS);
  var votes = readTable(VOTES_TAB, VOTE_HEADERS);

  // Group voters by report id in one pass, so the page gets the filled "Me too"
  // state without a second request.
  var votersById = {};
  for (var v = 0; v < votes.rows.length; v++) {
    var voteRow = votes.rows[v];
    var reportId = num(cell(voteRow, votes.col, 'report_id'));
    if (reportId === null) continue;
    if (!votersById[reportId]) votersById[reportId] = [];
    votersById[reportId].push(str(cell(voteRow, votes.col, 'name')));
  }

  var out = [];
  for (var r = 0; r < reports.rows.length; r++) {
    var row = reports.rows[r];
    if (isTrue(cell(row, reports.col, 'deleted'))) continue;

    var id = num(cell(row, reports.col, 'id'));
    if (id === null) continue;

    var voters = votersById[id] || [];
    out.push({
      id: id,
      created_at: isoString(cell(row, reports.col, 'created_at')),
      updated_at: isoString(cell(row, reports.col, 'updated_at')),
      name: str(cell(row, reports.col, 'name')),
      type: str(cell(row, reports.col, 'type')),
      level: str(cell(row, reports.col, 'level')),
      text: str(cell(row, reports.col, 'text')),
      device: str(cell(row, reports.col, 'device')),
      images: parseImageIds(cell(row, reports.col, 'images')),
      votes: voters.length,
      voters: voters
    });
  }
  return out;
}


function createReport(body) {
  var name = requireName(body.name);
  var type = requireType(body.type);
  var level = requireLevel(type, body.level);
  var text = requireText(body.text);
  var device = DEVICES.indexOf(str(body.device)) === -1 ? 'Other' : str(body.device);
  // Decoded and checked before anything is written, so a bad picture fails the
  // whole create rather than leaving a report next to a half-done upload.
  var pictures = requireNewImages(body.images);

  var t = readTable(REPORTS_TAB, REPORT_HEADERS);
  var now = new Date().toISOString();

  // Next id counts deleted rows too, so an id is never handed out twice.
  var maxId = 0;
  for (var i = 0; i < t.rows.length; i++) {
    var existing = num(cell(t.rows[i], t.col, 'id'));
    if (existing !== null && existing > maxId) maxId = existing;
  }
  var id = maxId + 1;

  // Drive is only touched when there is something to put in it, so a report with
  // no picture costs exactly what it cost before this feature existed.
  var imageIds = pictures.length ? saveImages(type, id, pictures) : [];

  var values = {
    id: id, created_at: now, updated_at: now, name: name, type: type,
    level: level, text: text, device: device, images: imageIds.join(','), deleted: false
  };

  // Build the row in the sheet's own column order, not ours, so the columns can
  // be reordered in the Sheet later without touching this file.
  var rowOut = [];
  for (var h = 0; h < t.headers.length; h++) {
    var header = t.headers[h];
    rowOut.push(values.hasOwnProperty(header) ? values[header] : '');
  }
  t.sheet.appendRow(rowOut);

  return {
    ok: true,
    report: {
      id: id, created_at: now, updated_at: now, name: name, type: type,
      level: level, text: text, device: device, images: imageIds, votes: 0, voters: []
    }
  };
}


function updateReport(body) {
  var t = readTable(REPORTS_TAB, REPORT_HEADERS);
  var found = findReportRow(t, body.id);
  if (!found) return { ok: false, error: 'Report not found.' };

  var owner = str(cell(found.row, t.col, 'name'));
  if (!sameName(owner, body.name)) {
    return { ok: false, error: 'You can only edit your own reports.' };
  }

  var type = requireType(body.type);
  var level = requireLevel(type, body.level);
  var text = requireText(body.text);
  var currentImages = parseImageIds(cell(found.row, t.col, 'images'));
  var keptImages = requireKeptImages(currentImages, body.images);
  var now = new Date().toISOString();

  // Name is deliberately not editable: it is the only thing tying a report to
  // its author, so letting it change would hand ownership to someone else.
  //
  // Dropped pictures are forgotten here but left in Drive, the same way a deleted
  // report stays in the Sheet: the operator, not the tester, does the real
  // deleting. It also means a mis-tap is recoverable from the folder.
  setCells(t, found.sheetRow, found.row,
    { type: type, level: level, text: text, images: keptImages.join(','), updated_at: now });

  return {
    ok: true,
    report: {
      id: num(cell(found.row, t.col, 'id')),
      created_at: isoString(cell(found.row, t.col, 'created_at')),
      updated_at: now,
      name: owner,
      type: type,
      level: level,
      text: text,
      device: str(cell(found.row, t.col, 'device')),
      images: keptImages
    }
  };
}


function deleteReport(body) {
  var t = readTable(REPORTS_TAB, REPORT_HEADERS);
  var found = findReportRow(t, body.id);
  if (!found) return { ok: false, error: 'Report not found.' };

  if (!sameName(str(cell(found.row, t.col, 'name')), body.name)) {
    return { ok: false, error: 'You can only delete your own reports.' };
  }

  // Soft delete: the row stays in the Sheet and is filtered out on read.
  setCells(t, found.sheetRow, found.row,
    { deleted: true, updated_at: new Date().toISOString() });

  return { ok: true };
}


function setVote(body, wanted) {
  var name = requireName(body.name);

  var reports = readTable(REPORTS_TAB, REPORT_HEADERS);
  var found = findReportRow(reports, body.id);
  if (!found) return { ok: false, error: 'Report not found.' };
  var id = num(cell(found.row, reports.col, 'id'));

  var votes = readTable(VOTES_TAB, VOTE_HEADERS);

  // One vote per (report_id, name). Names are matched the same way ownership is,
  // so "Gui" and "gui " on two phones are the same person and count once.
  var existingSheetRow = null;
  for (var i = 0; i < votes.rows.length; i++) {
    var row = votes.rows[i];
    if (num(cell(row, votes.col, 'report_id')) === id && sameName(str(cell(row, votes.col, 'name')), name)) {
      existingSheetRow = i + 2;
      break;
    }
  }

  if (wanted) {
    if (existingSheetRow) return { ok: true };
    var values = { report_id: id, name: name, created_at: new Date().toISOString() };
    var rowOut = [];
    for (var h = 0; h < votes.headers.length; h++) {
      var header = votes.headers[h];
      rowOut.push(values.hasOwnProperty(header) ? values[header] : '');
    }
    votes.sheet.appendRow(rowOut);
  } else {
    if (!existingSheetRow) return { ok: true };
    votes.sheet.deleteRow(existingSheetRow);
  }

  return { ok: true };
}


/* ------------------------------------------------------------------ *
 * Sheet access
 * ------------------------------------------------------------------ */

/**
 * Reads a tab into { sheet, headers, col, rows }.
 *
 * col maps a header name to its 0-based position, so everything below addresses
 * columns by name. Reordering columns in the Sheet does not break the script;
 * renaming a header does, loudly and on purpose.
 */
var _book = null;

/** Opening the spreadsheet is itself a call, so do it once per request. */
function book() {
  if (!_book) _book = SpreadsheetApp.getActiveSpreadsheet();
  return _book;
}

function readTable(tabName, expectedHeaders) {
  var sheet = book().getSheetByName(tabName);
  if (!sheet) throw new Error('Missing tab "' + tabName + '". Check the Sheet setup.');

  // One call. getLastRow plus getLastColumn plus getRange is three, and every
  // one of them is a round trip to the Sheets backend.
  var all = sheet.getDataRange().getValues();
  if (!all.length || !all[0].length) throw new Error('Tab "' + tabName + '" has no header row.');
  var headers = [];
  var col = {};
  for (var c = 0; c < all[0].length; c++) {
    var header = String(all[0][c]).trim();
    headers.push(header);
    if (header) col[header] = c;
  }

  for (var h = 0; h < expectedHeaders.length; h++) {
    if (!col.hasOwnProperty(expectedHeaders[h])) {
      throw new Error('Tab "' + tabName + '" is missing the "' + expectedHeaders[h] + '" column.');
    }
  }

  return { sheet: sheet, headers: headers, col: col, rows: all.slice(1) };
}

function cell(row, col, header) {
  return col.hasOwnProperty(header) ? row[col[header]] : '';
}

/*
 * Writes the changed fields in a single call. Four setValue calls is four round
 * trips; this is one. The untouched columns are written back with the values
 * they already held.
 */
function setCells(t, sheetRow, row, updates) {
  var out = [];
  for (var c = 0; c < t.headers.length; c++) {
    out.push(row[c] === undefined ? '' : row[c]);
  }
  for (var header in updates) {
    if (updates.hasOwnProperty(header) && t.col.hasOwnProperty(header)) {
      out[t.col[header]] = updates[header];
    }
  }
  t.sheet.getRange(sheetRow, 1, 1, t.headers.length).setValues([out]);
}

/** Finds a live (non-deleted) report by id. sheetRow is the real row number. */
function findReportRow(t, rawId) {
  var id = num(rawId);
  if (id === null) return null;
  for (var i = 0; i < t.rows.length; i++) {
    var row = t.rows[i];
    if (num(cell(row, t.col, 'id')) === id && !isTrue(cell(row, t.col, 'deleted'))) {
      return { row: row, sheetRow: i + 2 };  // +2: one for the header, one for 1-based rows
    }
  }
  return null;
}


/* ------------------------------------------------------------------ *
 * Screenshots in Drive
 * ------------------------------------------------------------------ */

/**
 * The folder the door writes pictures into, created on the first upload.
 * Nothing to set up by hand.
 *
 * Why the id is remembered rather than the folder searched for by name: the
 * manifest grants the script the narrow drive.file scope, which covers only
 * files it created itself. Searching Drive by name is a "read all of Drive"
 * action and needs the wide scope, which is exactly the permission the manifest
 * exists to avoid. Opening a folder by id is allowed for a folder the script
 * made, so the id goes into the script's own key-value store (PropertiesService,
 * no scope needed) the moment the folder is created.
 *
 * If the operator trashes or deletes that folder, the stored id points at
 * nothing and a fresh folder is created on the next upload. Old pictures stay
 * where they were and their ids in the Sheet still resolve.
 *
 * Cached like _book: a create with two pictures would otherwise open the folder twice.
 */
var FOLDER_ID_KEY = 'imageFolderId';
var _imageFolder = null;

function imageFolder() {
  if (_imageFolder) return _imageFolder;

  var props = PropertiesService.getScriptProperties();
  var storedId = props.getProperty(FOLDER_ID_KEY);
  if (storedId) {
    try {
      var found = DriveApp.getFolderById(storedId);
      if (!found.isTrashed()) {
        _imageFolder = found;
        return _imageFolder;
      }
    } catch (err) {
      // Deleted for good, or never ours. Fall through and make a new one.
    }
  }

  _imageFolder = DriveApp.createFolder(IMAGE_FOLDER_NAME);
  // Same sharing as the files: the page shows pictures to testers who have no
  // Google account at all, so "anyone with the link can view" is what makes them
  // load. Accepted with decision 27: these images are reachable by URL.
  _imageFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  props.setProperty(FOLDER_ID_KEY, _imageFolder.getId());
  return _imageFolder;
}

/**
 * Writes the decoded pictures to Drive and hands back their file ids.
 * Names look like B14-1.jpg, so the operator opening the folder can tell at a
 * glance which report a picture belongs to without opening anything.
 */
function saveImages(type, id, pictures) {
  var folder = imageFolder();
  var ids = [];
  for (var i = 0; i < pictures.length; i++) {
    var name = (TYPE_LETTERS[type] || '') + id + '-' + (i + 1) + '.' + extensionFor(pictures[i].mime);
    var blob = Utilities.newBlob(pictures[i].bytes, pictures[i].mime, name);
    var file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    ids.push(file.getId());
  }
  return ids;
}

/** image/jpeg to jpg, and anything else to whatever follows the slash. */
function extensionFor(mime) {
  var subtype = str(mime).toLowerCase().split('/')[1] || 'img';
  if (subtype === 'jpeg') return 'jpg';
  return subtype.replace(/[^a-z0-9]/g, '') || 'img';
}

/** The cell holds "id1,id2". Empty cell, empty list. */
function parseImageIds(value) {
  var raw = str(value);
  if (!raw) return [];
  var parts = raw.split(',');
  var ids = [];
  for (var i = 0; i < parts.length; i++) {
    var id = parts[i].trim();
    if (id) ids.push(id);
  }
  return ids;
}


/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

function requireName(raw) {
  var name = str(raw);
  if (!name) throw new Error('A name is required.');
  return name;
}

function requireText(raw) {
  var text = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!text) throw new Error('The text is required.');
  return text;
}

function requireType(raw) {
  var type = str(raw).toLowerCase();
  if (TYPES.indexOf(type) === -1) throw new Error('Unknown type: ' + type);
  return type;
}

function requireLevel(type, raw) {
  var allowed = LEVELS[type];
  var level = str(raw).toLowerCase();
  if (allowed.length === 0) return '';                       // "other" carries no level
  if (allowed.indexOf(level) === -1) throw new Error('Unknown level for ' + type + ': ' + level);
  return level;
}

/**
 * Pictures arriving with a create: a list of { mime, data } with data base64 and
 * no data-URL prefix. Returns them decoded, ready for Drive.
 *
 * Anyone holding the page's link can call this door, so every one of these checks
 * is the only thing standing between a public URL and someone else's Drive quota.
 */
function requireNewImages(raw) {
  if (raw === null || raw === undefined || raw === '') return [];
  if (!isArray(raw)) throw new Error('Screenshots must be sent as a list.');
  if (raw.length > MAX_IMAGES) {
    throw new Error('At most ' + MAX_IMAGES + ' screenshots per report.');
  }

  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var item = raw[i] || {};
    var mime = str(item.mime).toLowerCase();
    if (mime.indexOf('image/') !== 0) throw new Error('Only images can be attached.');

    var bytes;
    try {
      bytes = Utilities.base64Decode(str(item.data));
    } catch (e) {
      throw new Error('A screenshot could not be read.');
    }
    if (!bytes || !bytes.length) throw new Error('A screenshot arrived empty.');
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('A screenshot is too large.');

    out.push({ mime: mime, bytes: bytes });
  }
  return out;
}

/**
 * Pictures arriving with an update: the ids to KEEP. Removal only, per decision
 * 30, so anything not already on the row is refused. Without the subset check the
 * field would be a way to point any report at any file in the folder.
 *
 * A missing field means "leave them alone": an older page that knows nothing
 * about pictures must not wipe them by staying silent.
 */
function requireKeptImages(currentIds, raw) {
  if (raw === null || raw === undefined) return currentIds;
  if (!isArray(raw)) throw new Error('Screenshots must be sent as a list.');

  var kept = [];
  for (var i = 0; i < raw.length; i++) {
    var id = str(raw[i]);
    if (!id) continue;
    if (currentIds.indexOf(id) === -1) {
      throw new Error('Screenshots can be removed on edit, not added.');
    }
    if (kept.indexOf(id) === -1) kept.push(id);
  }
  return kept;
}

/** Ownership and vote identity: trimmed, case-insensitive. */
function sameName(a, b) {
  return str(a).toLowerCase() === str(b).toLowerCase();
}


/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function str(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

/* JSON.parse hands back a real array, so this is only here to keep the two image
   checks readable and to say out loud that a bare object is not a list. */
function isArray(value) {
  return Object.prototype.toString.call(value) === '[object Array]';
}

function num(value) {
  if (value === '' || value === null || value === undefined) return null;
  var n = Number(value);
  return isNaN(n) ? null : n;
}

/** A checkbox reads back as a boolean, a typed cell as the text "TRUE". Accept both. */
function isTrue(value) {
  return value === true || String(value).trim().toUpperCase() === 'TRUE';
}

/**
 * Sheets often decides an ISO string is a date and stores it as one. Reading it
 * back then gives a Date object, not the string we wrote. Normalise on the way
 * out so the page always receives an ISO 8601 string.
 */
function isoString(value) {
  if (value instanceof Date) return value.toISOString();
  return str(value);
}

function respond(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
