/**
 * Clock-in / clock-out routes.
 * Captures GPS location as metadata (no geofence enforcement).
 * Supports optional comment and job_code fields.
 */
const db = require('../db');
const { captureLocation, formatLocationLabel } = require('../services/geofence');
const sheets = require('../services/sheets');
const geocode = require('../services/geocode');

async function handleClockIn(body, authUser) {
  const { latitude, longitude, comment } = body;
  if (latitude == null || longitude == null) {
    return { status: 400, body: { error: 'Location (latitude, longitude) is required' } };
  }

  // Capture location metadata (no blocking)
  const locResult = captureLocation(authUser.office_code, latitude, longitude);
  const locationLabel = formatLocationLabel(authUser.office_code, latitude, longitude);

  // Reverse geocode to get street address (non-blocking — if it fails, we still proceed)
  let clockInAddress = null;
  if (geocode.isConfigured()) {
    try {
      clockInAddress = await geocode.reverseGeocode(latitude, longitude);
    } catch (err) {
      console.error('[Clock] Geocode failed (non-fatal):', err.message);
    }
  }

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
    clock_in_address: clockInAddress,
    clock_out_lat: null,
    clock_out_lng: null,
    clock_out_location: null,
    clock_out_address: null,
    job_code: 'Regular',
    comment: comment && comment.trim() ? comment.trim() : null,
  });

  // Write to Google Sheets immediately on clock-in (async, non-blocking)
  if (sheets.isConfigured()) {
    const user = db.findOne('users', (u) => u.id === authUser.id);
    const office = user ? db.findOne('offices', (o) => o.code === user.office_code) : null;
    sheets.writeTimecardEntry(entry, user || authUser, office?.name || '').catch((err) => {
      console.error('[Clock] Sheets clock-in write failed (non-fatal):', err.message);
    });
  }

  return {
    status: 200,
    body: {
      success: true,
      message: `Clocked in — ${locationLabel}${clockInAddress ? ` (${clockInAddress})` : ''}`,
      entry,
    },
  };
}

async function handleClockOut(body, authUser) {
  const { latitude, longitude, comment } = body;
  if (latitude == null || longitude == null) {
    return { status: 400, body: { error: 'Location (latitude, longitude) is required' } };
  }

  // Capture location metadata (no blocking)
  const locationLabel = formatLocationLabel(authUser.office_code, latitude, longitude);

  // Reverse geocode clock-out location
  let clockOutAddress = null;
  if (geocode.isConfigured()) {
    try {
      clockOutAddress = await geocode.reverseGeocode(latitude, longitude);
    } catch (err) {
      console.error('[Clock] Geocode clock-out failed (non-fatal):', err.message);
    }
  }

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
    clock_out_address: clockOutAddress,
  };

  // If a clock-out comment is provided, append to existing comment
  if (comment && comment.trim()) {
    const existingComment = openEntry.comment || '';
    const separator = existingComment ? ' | ' : '';
    updates.comment = existingComment + separator + comment.trim();
  }

  const updatedEntry = db.update('clock_entries', openEntry.id, updates);

  // Update the existing "Currently Clocked In" row in Sheets (async, non-blocking)
  if (sheets.isConfigured()) {
    const user = db.findOne('users', (u) => u.id === authUser.id);
    const office = user ? db.findOne('offices', (o) => o.code === user.office_code) : null;
    sheets.updateTimecardClockOut(updatedEntry, user || authUser, office?.name || '').catch((err) => {
      console.error('[Clock] Sheets clock-out update failed (non-fatal):', err.message);
    });
  }

  return {
    status: 200,
    body: {
      success: true,
      message: `Clocked out — ${locationLabel}${clockOutAddress ? ` (${clockOutAddress})` : ''}`,
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
// Reads from Google Sheets first (persistent), falls back to local DB.
async function handleGetAllEntries(authUser, query) {
  if (authUser.level > 2) {
    return { status: 403, body: { error: 'Insufficient permissions' } };
  }

  // Build a name→user lookup for mapping Sheets names back to user IDs
  const allUsers = db.findAll('users');
  const nameToUser = {};
  allUsers.forEach((u) => {
    const fullName = `${u.first_name} ${u.last_name}`.toLowerCase();
    nameToUser[fullName] = u;
  });

  // Office code→name and name→code maps
  const allOffices = db.findAll('offices');
  const codeToName = {};
  const nameToCode = {};
  allOffices.forEach((o) => { codeToName[o.code] = o.name; nameToCode[o.name.toLowerCase()] = o.code; });

  // Try Google Sheets first
  if (sheets.isConfigured()) {
    try {
      const sheetEntries = await sheets.readTimecardEntries({});

      let entries = sheetEntries.map((se) => {
        // Try to map name back to a user for user_id and office_code
        const matchedUser = nameToUser[se.name.toLowerCase()] || null;

        // Parse formatted dates into ISO for frontend date-slicing
        let clockIn = null;
        let clockOut = null;
        try { if (se.clock_in_time) clockIn = new Date(se.clock_in_time).toISOString(); } catch (e) {}
        try { if (se.clock_out_time) clockOut = new Date(se.clock_out_time).toISOString(); } catch (e) {}

        const officeCode = matchedUser?.office_code || nameToCode[se.office.toLowerCase()] || '';

        return {
          id: se.id,
          user_id: matchedUser?.id || se.name,
          user_name: se.name,
          user_email: matchedUser?.email || '',
          office_code: officeCode,
          office_name: se.office,
          clock_in: clockIn,
          clock_out: clockOut,
          clock_in_location: se.clock_in_location,
          clock_in_address: se.clock_in_address || '',
          clock_out_address: se.clock_out_address || '',
          hours: se.hours,
          job_code: se.job_code,
          comment: se.comment,
        };
      });

      // Manager filter: only their office
      if (authUser.level === 2) {
        const myOffice = authUser.office_code;
        entries = entries.filter((e) => e.office_code === myOffice);
      }

      // Apply query filters
      if (query.date) entries = entries.filter((e) => e.clock_in?.startsWith(query.date));
      if (query.office) entries = entries.filter((e) => e.office_code === query.office);
      if (query.user_id) entries = entries.filter((e) => e.user_id === query.user_id);

      entries.sort((a, b) => new Date(b.clock_in || 0) - new Date(a.clock_in || 0));

      return { status: 200, body: { entries: entries.slice(0, 500), source: 'sheets' } };
    } catch (err) {
      console.error('[Clock/All] Sheets read failed, falling back to DB:', err.message);
    }
  }

  // Fallback: local JSON DB
  let entries;
  if (authUser.level <= 1) {
    entries = db.findAll('clock_entries');
  } else {
    const officeUsers = db.findAll('users', (u) => u.office_code === authUser.office_code);
    const userIds = new Set(officeUsers.map((u) => u.id));
    entries = db.findAll('clock_entries', (e) => userIds.has(e.user_id));
  }

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
  if (query.date) entries = entries.filter((e) => e.clock_in.startsWith(query.date));
  if (query.office) entries = entries.filter((e) => e.office_code === query.office);
  if (query.user_id) entries = entries.filter((e) => e.user_id === query.user_id);

  return { status: 200, body: { entries: entries.slice(0, 500), source: 'db' } };
}

module.exports = { handleClockIn, handleClockOut, handleGetStatus, handleGetHistory, handleGetAllEntries };
