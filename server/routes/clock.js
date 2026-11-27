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
  let openEntry = db.findOne('clock_entries', (e) =>
    e.user_id === authUser.id && !e.clock_out
  );
  // Also check Sheets in case DB was wiped (Render restart)
  if (!openEntry && sheets.isConfigured()) {
    try {
      const fullName = `${authUser.first_name} ${authUser.last_name}`;
      const sheetStatus = await sheets.getClockStatusFromSheets(fullName);
      if (sheetStatus.clocked_in) openEntry = sheetStatus.entry;
    } catch (err) { /* non-fatal */ }
  }
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
  const { latitude, longitude, comment, apply_flex_hours } = body;
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

  const clockOutTime = new Date().toISOString();
  const rawHours = (new Date(clockOutTime) - new Date(openEntry.clock_in)) / 3600000;

  // ── Lunch break auto-deduction ──
  // If shift >= 6 hours, auto-deduct 30 minutes (0.5 hours) for unpaid lunch
  let breakLength = null;
  let netHours = rawHours;
  if (rawHours >= 6) {
    breakLength = '30u';
    netHours = rawHours - 0.5;
  }

  // Build update — append comment if provided
  const updates = {
    clock_out: clockOutTime,
    clock_out_lat: latitude,
    clock_out_lng: longitude,
    clock_out_location: locationLabel,
    clock_out_address: clockOutAddress,
    break_length: breakLength,
    net_hours: netHours.toFixed(2),
  };

  // If a clock-out comment is provided, append to existing comment
  if (comment && comment.trim()) {
    const existingComment = openEntry.comment || '';
    const separator = existingComment ? ' | ' : '';
    updates.comment = existingComment + separator + comment.trim();
  }

  const updatedEntry = db.update('clock_entries', openEntry.id, updates);

  // ── Flex hours: if employee worked < 8 hours (net) and wants to apply flex ──
  let flexMessage = '';
  if (apply_flex_hours && apply_flex_hours > 0 && openEntry.job_code !== 'Flex Earned') {
    const flexBalance = getFlexBalance(authUser.id);
    const hoursToApply = Math.min(apply_flex_hours, flexBalance);
    if (hoursToApply > 0) {
      // Create a "Flex Used" entry for the applied hours
      const flexEntry = db.insert('clock_entries', {
        user_id: authUser.id,
        office_code: authUser.office_code,
        clock_in: openEntry.clock_in,
        clock_out: clockOutTime,
        clock_in_lat: latitude,
        clock_in_lng: longitude,
        clock_in_location: 'Flex Used',
        clock_in_address: null,
        clock_out_lat: latitude,
        clock_out_lng: longitude,
        clock_out_location: locationLabel,
        clock_out_address: null,
        job_code: 'Flex Used',
        comment: `Applied ${hoursToApply.toFixed(2)} flex hours`,
        net_hours: hoursToApply.toFixed(2),
        break_length: null,
      });

      // Write Flex Used entry to Sheets
      if (sheets.isConfigured()) {
        const user = db.findOne('users', (u) => u.id === authUser.id);
        const office = user ? db.findOne('offices', (o) => o.code === user.office_code) : null;
        const flexSheetEntry = { ...flexEntry, clock_in_location: 'Flex Used' };
        sheets.writeTimecardEntry(flexSheetEntry, user || authUser, office?.name || '').catch((err) => {
          console.error('[Clock] Sheets flex-used write failed (non-fatal):', err.message);
        });
      }

      flexMessage = ` | ${hoursToApply.toFixed(2)} flex hours applied`;
    }
  }

  // Update the existing "Currently Clocked In" row in Sheets (async, non-blocking)
  if (sheets.isConfigured()) {
    const user = db.findOne('users', (u) => u.id === authUser.id);
    const office = user ? db.findOne('offices', (o) => o.code === user.office_code) : null;
    sheets.updateTimecardClockOut(updatedEntry, user || authUser, office?.name || '').catch((err) => {
      console.error('[Clock] Sheets clock-out update failed (non-fatal):', err.message);
    });
  }

  // Check if employee should be prompted to use flex hours
  const shortfall = 8 - netHours;
  let flexPrompt = null;
  if (shortfall > 0.25 && openEntry.job_code !== 'Flex Earned' && !apply_flex_hours) {
    const flexBalance = getFlexBalance(authUser.id);
    if (flexBalance > 0) {
      flexPrompt = {
        shortfall: parseFloat(shortfall.toFixed(2)),
        flex_balance: parseFloat(flexBalance.toFixed(2)),
        suggested_hours: parseFloat(Math.min(shortfall, flexBalance).toFixed(2)),
      };
    }
  }

  return {
    status: 200,
    body: {
      success: true,
      message: `Clocked out — ${locationLabel}${clockOutAddress ? ` (${clockOutAddress})` : ''}${breakLength ? ' (30min lunch deducted)' : ''}${flexMessage}`,
      entry: updatedEntry,
      flex_prompt: flexPrompt,
    },
  };
}

// ── Flex Clock In ──
async function handleFlexClockIn(body, authUser) {
  const { latitude, longitude, comment } = body;
  if (latitude == null || longitude == null) {
    return { status: 400, body: { error: 'Location (latitude, longitude) is required' } };
  }

  const locResult = captureLocation(authUser.office_code, latitude, longitude);
  const locationLabel = formatLocationLabel(authUser.office_code, latitude, longitude);

  let clockInAddress = null;
  if (geocode.isConfigured()) {
    try {
      clockInAddress = await geocode.reverseGeocode(latitude, longitude);
    } catch (err) {
      console.error('[Clock] Flex geocode failed (non-fatal):', err.message);
    }
  }

  // Check if already clocked in (regular or flex)
  let openEntry = db.findOne('clock_entries', (e) =>
    e.user_id === authUser.id && !e.clock_out
  );
  // Also check Sheets in case DB was wiped (Render restart)
  if (!openEntry && sheets.isConfigured()) {
    try {
      const fullName = `${authUser.first_name} ${authUser.last_name}`;
      const sheetStatus = await sheets.getClockStatusFromSheets(fullName);
      if (sheetStatus.clocked_in) openEntry = sheetStatus.entry;
    } catch (err) { /* non-fatal */ }
  }
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
    job_code: 'Flex Earned',
    comment: comment && comment.trim() ? comment.trim() : null,
  });

  // Write to Google Sheets
  if (sheets.isConfigured()) {
    const user = db.findOne('users', (u) => u.id === authUser.id);
    const office = user ? db.findOne('offices', (o) => o.code === user.office_code) : null;
    sheets.writeTimecardEntry(entry, user || authUser, office?.name || '').catch((err) => {
      console.error('[Clock] Sheets flex clock-in write failed (non-fatal):', err.message);
    });
  }

  return {
    status: 200,
    body: {
      success: true,
      message: `Flex clocked in — ${locationLabel}${clockInAddress ? ` (${clockInAddress})` : ''}`,
      entry,
    },
  };
}

// ── Flex Clock Out ──
async function handleFlexClockOut(body, authUser) {
  const { latitude, longitude, comment } = body;
  if (latitude == null || longitude == null) {
    return { status: 400, body: { error: 'Location (latitude, longitude) is required' } };
  }

  const locationLabel = formatLocationLabel(authUser.office_code, latitude, longitude);

  let clockOutAddress = null;
  if (geocode.isConfigured()) {
    try {
      clockOutAddress = await geocode.reverseGeocode(latitude, longitude);
    } catch (err) {
      console.error('[Clock] Flex geocode clock-out failed (non-fatal):', err.message);
    }
  }

  // Find open flex entry
  const openEntry = db.findOne('clock_entries', (e) =>
    e.user_id === authUser.id && !e.clock_out && e.job_code === 'Flex Earned'
  );
  if (!openEntry) {
    return { status: 400, body: { error: 'You are not currently flex clocked in.' } };
  }

  const clockOutTime = new Date().toISOString();
  const rawHours = (new Date(clockOutTime) - new Date(openEntry.clock_in)) / 3600000;

  const updates = {
    clock_out: clockOutTime,
    clock_out_lat: latitude,
    clock_out_lng: longitude,
    clock_out_location: locationLabel,
    clock_out_address: clockOutAddress,
    net_hours: rawHours.toFixed(2),
    break_length: null,
  };

  if (comment && comment.trim()) {
    const existingComment = openEntry.comment || '';
    const separator = existingComment ? ' | ' : '';
    updates.comment = existingComment + separator + comment.trim();
  }

  const updatedEntry = db.update('clock_entries', openEntry.id, updates);

  // Update Sheets
  if (sheets.isConfigured()) {
    const user = db.findOne('users', (u) => u.id === authUser.id);
    const office = user ? db.findOne('offices', (o) => o.code === user.office_code) : null;
    sheets.updateTimecardClockOut(updatedEntry, user || authUser, office?.name || '').catch((err) => {
      console.error('[Clock] Sheets flex clock-out update failed (non-fatal):', err.message);
    });
  }

  return {
    status: 200,
    body: {
      success: true,
      message: `Flex clocked out — ${rawHours.toFixed(2)} hours banked`,
      entry: updatedEntry,
    },
  };
}

// ── Flex Balance ──
function getFlexBalance(userId) {
  const allEntries = db.findAll('clock_entries', (e) => e.user_id === userId && e.clock_out);
  let earned = 0;
  let used = 0;
  allEntries.forEach((e) => {
    if (e.job_code === 'Flex Earned') {
      const hrs = e.net_hours ? parseFloat(e.net_hours) : (new Date(e.clock_out) - new Date(e.clock_in)) / 3600000;
      earned += hrs;
    } else if (e.job_code === 'Flex Used') {
      const hrs = e.net_hours ? parseFloat(e.net_hours) : 0;
      used += hrs;
    }
  });
  return Math.max(0, earned - used);
}

function handleGetFlexBalance(authUser) {
  const balance = getFlexBalance(authUser.id);
  const entries = db.findAll('clock_entries', (e) =>
    e.user_id === authUser.id && (e.job_code === 'Flex Earned' || e.job_code === 'Flex Used') && e.clock_out
  );
  entries.sort((a, b) => new Date(b.clock_in) - new Date(a.clock_in));
  return {
    status: 200,
    body: {
      balance: parseFloat(balance.toFixed(2)),
      entries: entries.slice(0, 50),
    },
  };
}

async function handleGetStatus(authUser) {
  // Check local DB first
  let openEntry = db.findOne('clock_entries', (e) =>
    e.user_id === authUser.id && !e.clock_out
  );

  // If no open entry in DB, fall back to Google Sheets (survives Render restarts)
  if (!openEntry && sheets.isConfigured()) {
    try {
      const fullName = `${authUser.first_name} ${authUser.last_name}`;
      const sheetStatus = await sheets.getClockStatusFromSheets(fullName);
      if (sheetStatus.clocked_in) {
        // Re-hydrate the entry into the local DB so clock-out works seamlessly
        const se = sheetStatus.entry;
        // Parse the sheet date format back to ISO (timezone-aware)
        let clockInISO = sheets.parseSheetDateTime(se.clock_in) || se.clock_in;

        openEntry = db.insert('clock_entries', {
          user_id: authUser.id,
          office_code: authUser.office_code || se.office,
          clock_in: clockInISO,
          clock_out: null,
          clock_in_lat: null,
          clock_in_lng: null,
          clock_in_location: se.clock_in_location || '',
          clock_in_address: se.clock_in_address || null,
          clock_out_lat: null,
          clock_out_lng: null,
          clock_out_location: null,
          clock_out_address: null,
          job_code: se.job_code || 'Regular',
          comment: se.comment || null,
          _restored_from_sheets: true,
        });
        console.log(`[Clock] Restored open clock entry from Sheets for ${fullName}`);
      }
    } catch (err) {
      console.error('[Clock] Sheets status fallback failed (non-fatal):', err.message);
    }
  }

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

        // Parse formatted dates into ISO for frontend date-slicing (timezone-aware)
        let clockIn = se.clock_in_time ? sheets.parseSheetDateTime(se.clock_in_time) : null;
        let clockOut = se.clock_out_time ? sheets.parseSheetDateTime(se.clock_out_time) : null;

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

module.exports = { handleClockIn, handleClockOut, handleGetStatus, handleGetHistory, handleGetAllEntries, handleFlexClockIn, handleFlexClockOut, handleGetFlexBalance };
