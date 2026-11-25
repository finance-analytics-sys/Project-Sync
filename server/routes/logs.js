/**
 * Logs routes — executive-only view of all clock entries.
 * Columns match the Timecard spreadsheet exactly:
 *   Name, Office, Clock in Location, Clock in time, Clock out time, Hours, Job Code, Comment
 */
const db = require('../db');

function handleGetLogs(authUser, query) {
  // Executive-only (L1 and CEO)
  if (authUser.level > 1) {
    return { status: 403, body: { error: 'Logs section is for executives only' } };
  }

  let entries = db.findAll('clock_entries');

  // Enrich with user and office data
  entries = entries.map((e) => {
    const user = db.findOne('users', (u) => u.id === e.user_id);
    const office = user ? db.findOne('offices', (o) => o.code === user.office_code) : null;

    // Calculate hours
    let hours = null;
    if (e.clock_in && e.clock_out) {
      const ms = new Date(e.clock_out) - new Date(e.clock_in);
      hours = (ms / 3600000).toFixed(2);
    } else if (e.pto_hours) {
      hours = String(e.pto_hours);
    }

    return {
      id: e.id,
      name: user ? `${user.first_name} ${user.last_name}` : 'Unknown',
      office: office?.name || e.office_code || '—',
      office_code: e.office_code,
      clock_in_location: e.clock_in_location || '—',
      clock_in_time: e.clock_in || null,
      clock_out_time: e.clock_out || null,
      hours: hours,
      job_code: e.job_code || 'Regular',
      comment: e.comment || '',
      user_id: e.user_id,
      created_at: e.created_at,
    };
  });

  // Sort by clock_in descending
  entries.sort((a, b) => {
    const dateA = a.clock_in_time || a.created_at || '';
    const dateB = b.clock_in_time || b.created_at || '';
    return dateB.localeCompare(dateA);
  });

  // Filter: date range
  if (query.start_date) {
    entries = entries.filter((e) => {
      const d = (e.clock_in_time || e.created_at || '').slice(0, 10);
      return d >= query.start_date;
    });
  }
  if (query.end_date) {
    entries = entries.filter((e) => {
      const d = (e.clock_in_time || e.created_at || '').slice(0, 10);
      return d <= query.end_date;
    });
  }

  // Filter: specific office
  if (query.office) {
    entries = entries.filter((e) => e.office_code === query.office);
  }

  // Filter: specific employee
  if (query.user_id) {
    entries = entries.filter((e) => e.user_id === query.user_id);
  }

  // Filter: job code
  if (query.job_code) {
    entries = entries.filter((e) => e.job_code === query.job_code);
  }

  return {
    status: 200,
    body: {
      entries: entries.slice(0, 1000),
      total: entries.length,
    },
  };
}

module.exports = { handleGetLogs };
