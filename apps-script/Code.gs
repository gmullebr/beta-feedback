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

var REPORT_HEADERS = ['id', 'created_at', 'updated_at', 'name', 'type', 'level', 'text', 'device', 'deleted'];
var VOTE_HEADERS = ['report_id', 'name', 'created_at'];

var TYPES = ['bug', 'idea', 'other'];

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

  var t = readTable(REPORTS_TAB, REPORT_HEADERS);
  var now = new Date().toISOString();

  // Next id counts deleted rows too, so an id is never handed out twice.
  var maxId = 0;
  for (var i = 0; i < t.rows.length; i++) {
    var existing = num(cell(t.rows[i], t.col, 'id'));
    if (existing !== null && existing > maxId) maxId = existing;
  }
  var id = maxId + 1;

  var values = {
    id: id, created_at: now, updated_at: now, name: name, type: type,
    level: level, text: text, device: device, deleted: false
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
      level: level, text: text, device: device, votes: 0, voters: []
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
  var now = new Date().toISOString();

  // Name is deliberately not editable: it is the only thing tying a report to
  // its author, so letting it change would hand ownership to someone else.
  setCells(t, found.sheetRow, found.row,
    { type: type, level: level, text: text, updated_at: now });

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
      device: str(cell(found.row, t.col, 'device'))
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
