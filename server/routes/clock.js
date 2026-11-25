/**
 * Clock-in / clock-out routes.
 * Captures GPS location as metadata (no geofence enforcement).
 * Supports optional comment and job_code fields.
 */
const db = require('../db');
const { captureLocation, formatLocationLabel } = require('../services/geofence');
const sheets = require('../services/sheets');

function handleClockIn(body, authUser) {
  const { latitude, longitude, comment } = body;
  if (latitude == null || longitude == null) {
    return { status: 400, body: { error: 'Location (latitude, longitude) is required' } };
  }

  // Capture location metadata (no blocking)
  const locResult = captureLocation(authUser.office_code, latitude, longitude);
  const locationLabel = formatLocationLabel(authUser.office_code, latitude, longitude);

  // Check if already clocked in (has an open entry with no clock_out)
  const openEntry = db.findOne('clock_entries', (e) =>
    e.user_id === authUser.id && !e.clock_out
  );
  if (openEntry) {
    return { status: 400, body: { error: 'You are already clocked in. Please clock out first.' } };
  }

  const entry = db.insert('clock_entries', {
    user_id: authUser.id,
    office_code: authUser.office_code,
    clock_in: new Date().toISOString(),
    clock_out: null,
    clock_in_lat: latitude,
    clock_in_lng: longitude,
    clock_in_location: locationLabel,
    clock_out_lat: null,
    clock_out_lng: null,
    clock_out_location: null,
    job_code: 'Regular',
    comment: comment && comment.trim() ? comment.trim() : null,
  });

  return {
    status: 200,
    body: {
      success: true,
      message: `Clocked in — ${locationLabel}`,
      entry,
    },
  };
}

function handleClockOut(body, authUser) {
  const { latitude, longitude, comment } = body;
  if (latitude == null || longitude == null) {
    return { status: 400, body: { error: 'Location (latitude, longitude) is required' } };
  }

  // Capture location metadata (no blocking)
  const locationLabel = formatLocationLabel(authUser.office_code, latitude, longitude);

  // Find open clock entry
  const openEntry = db.findOne('clock_entries', (e) =>
    e.user_id === authUser.id && !e.clock_out
  );
  if (!openEntry) {
    return { status: 400, body: { error: 'You are not currently clocked in.' } };
  }

  // Build update — append comment if provided
  const updates = {
    clock_out: new Date().toISOString(),
    clock_out_lat: latitude,
    clock_out_lng: longitude,
    clock_out_location: locationLabel,
  };

  // If a clock-out comment is provided, append to existing comment
  if (comment && comment.trim()) {
    const existingComment = openEntry.comment || '';
    const separator = existingComment ? ' | ' : '';
    updates.comment = existingComment + separator + comment.trim();
  }

  const updatedEntry = db.update('clock_entries', openEntry.id, updates);

  // Write to Google Sheets (async, non-blocking — don't fail clock-out if Sheets is down)
  if (sheets.isConfigured()) {
    const user = db.findOne('users', (u) => u.id === authUser.id);
    const office = user ? db.findOne('offices', (o) => o.code === user.office_code) : null;
    sheets.writeTimecardEntry(updatedEntry, user || authUser, office?.name || '').catch((err) => {
      console.error('[Clock] Sheets write failed (non-fatal):', err.message);
    });
  }

  return {
    status: 200,
    body: {
      success: true,
      message: `Clocked out — ${locationLabel}`,
      entry: updatedEntry,
    },
  };
}

function handleGetStatus(authUser) {
  const openEntry = db.findOne('clock_entries', (e) =>
    e.user_id === authUser.id && !e.clock_out
  );

  return {
    status: 200,
    body: {
      clocked_in: !!openEntry,
      current_entry: openEntry || null,
    },
  };
}

function handleGetHistory(authUser, query) {
  const entries = db.findAll('clock_entries', (e) => e.user_id === authUser.id);

  // Sort by clock_in descending
  entries.sort((a, b) => new Date(b.clock_in) - new Date(a.clock_in));

  // Optional date filter
  let filtered = entries;
  if (query.start_date) {
    filtered = filtered.filter((e) => e.clock_in >= query.start_date);
  }
  if (query.end_date) {
    filtered = filtered.filter((e) => e.clock_in <= query.end_date + 'T23:59:59Z');
  }

  return { status: 200, body: { entries: filtered.slice(0, 100) } };
}

// Admin: get all clock entries (for managers/executives)
function handleGetAllEntries(authUser, query) {
  let entries;

  if (authUser.level <= 1) {
    // Executives see all
    entries = db.findAll('clock_entries');
  } else if (authUser.level === 2) {
    // Managers see their office only
    const officeUsers = db.findAll('users', (u) => u.office_code === authUser.office_code);
    const userIds = new Set(officeUsers.map((u) => u.id));
    entries = db.findAll('clock_entries', (e) => userIds.has(e.user_id));
  } else {
    return { status: 403, body: { error: 'Insufficient permissions' } };
  }

  // Enrich with user names and office info
  entries = entries.map((e) => {
    const user = db.findOne('users', (u) => u.id === e.user_id);
    const office = user ? db.findOne('offices', (o) => o.code === user.office_code) : null;
    return {
      ...e,
      user_name: user ? `${user.first_name} ${user.last_name}` : 'Unknown',
      user_email: user?.email,
      office_name: office?.name || e.office_code || '—',
    };
  });

  entries.sort((a, b) => new Date(b.clock_in) - new Date(a.clock_in));

  if (query.date) {
    entries = entries.filter((e) => e.clock_in.startsWith(query.date));
  }

  // Filter by office
  if (query.office) {
    entries = entries.filter((e) => e.office_code === query.office);
  }

  // Filter by user
  if (query.user_id) {
    entries = entries.filter((e) => e.user_id === query.user_id);
  }

  return { status: 200, body: { entries: entries.slice(0, 500) } };
}

module.exports = { handleClockIn, handleClockOut, handleGetStatus, handleGetHistory, handleGetAllEntries };
