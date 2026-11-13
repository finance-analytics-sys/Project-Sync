/**
 * Clock-in / clock-out routes.
 * Simple timestamp logging with geofence validation.
 */
const db = require('../db');
const { validateLocation } = require('../services/geofence');

function handleClockIn(body, authUser) {
  const { latitude, longitude } = body;
  if (latitude == null || longitude == null) {
    return { status: 400, body: { error: 'Location (latitude, longitude) is required' } };
  }

  // Geofence check
  const geoResult = validateLocation(authUser.office_code, latitude, longitude);
  if (!geoResult.allowed) {
    return { status: 403, body: { error: geoResult.reason } };
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
    clock_out_lat: null,
    clock_out_lng: null,
  });

  return {
    status: 200,
    body: {
      success: true,
      message: `Clocked in at ${geoResult.office.name} (${geoResult.distance}m from office)`,
      entry,
    },
  };
}

function handleClockOut(body, authUser) {
  const { latitude, longitude } = body;
  if (latitude == null || longitude == null) {
    return { status: 400, body: { error: 'Location (latitude, longitude) is required' } };
  }

  // Geofence check
  const geoResult = validateLocation(authUser.office_code, latitude, longitude);
  if (!geoResult.allowed) {
    return { status: 403, body: { error: geoResult.reason } };
  }

  // Find open clock entry
  const openEntry = db.findOne('clock_entries', (e) =>
    e.user_id === authUser.id && !e.clock_out
  );
  if (!openEntry) {
    return { status: 400, body: { error: 'You are not currently clocked in.' } };
  }

  const updatedEntry = db.update('clock_entries', openEntry.id, {
    clock_out: new Date().toISOString(),
    clock_out_lat: latitude,
    clock_out_lng: longitude,
  });

  return {
    status: 200,
    body: {
      success: true,
      message: `Clocked out at ${geoResult.office.name}`,
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

  // Enrich with user names
  entries = entries.map((e) => {
    const user = db.findOne('users', (u) => u.id === e.user_id);
    return {
      ...e,
      user_name: user ? `${user.first_name} ${user.last_name}` : 'Unknown',
      user_email: user?.email,
    };
  });

  entries.sort((a, b) => new Date(b.clock_in) - new Date(a.clock_in));

  if (query.date) {
    entries = entries.filter((e) => e.clock_in.startsWith(query.date));
  }

  return { status: 200, body: { entries: entries.slice(0, 200) } };
}

module.exports = { handleClockIn, handleClockOut, handleGetStatus, handleGetHistory, handleGetAllEntries };
