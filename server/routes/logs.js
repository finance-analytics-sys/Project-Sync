/**
 * Logs routes — executive-only view of all clock entries.
 * Reads from Google Sheets (source of truth) with JSON DB fallback.
 * Columns match the Timecard spreadsheet exactly:
 *   Name, Office, Clock in Location, Clock in time, Clock out time, Hours, Job Code, Comment, Clock in Address, Clock out Address, Break Length, Week Total
 */
const db = require('../db');
const sheets = require('../services/sheets');

/**
 * Calculate week totals (Monday-Sunday) for each employee.
 * Sets week_total on the LAST entry of each week per employee.
 */
function addWeekTotals(entries) {
  const TIMEZONE = process.env.APP_TIMEZONE || 'America/New_York';

  // Get the current Monday in TIMEZONE (start of the current week)
  const now = new Date();
  const localNow = new Date(now.toLocaleString('en-US', { timeZone: TIMEZONE }));
  const nowDay = localNow.getDay(); // 0=Sun, 1=Mon, ...
  const nowDiff = nowDay === 0 ? -6 : 1 - nowDay;
  const currentMonday = new Date(localNow);
  currentMonday.setDate(localNow.getDate() + nowDiff);
  currentMonday.setHours(0, 0, 0, 0);
  const currentMondayStr = currentMonday.toISOString().slice(0, 10);

  // For each entry, determine the Monday of its week
  function getWeekMonday(dateStr) {
    if (!dateStr) return null;
    // Use timezone-aware parsing for Sheets formatted dates
    const iso = sheets.parseSheetDateTime ? sheets.parseSheetDateTime(dateStr) : null;
    const d = iso ? new Date(iso) : new Date(dateStr);
    if (isNaN(d.getTime())) return null;

    const localDate = new Date(d.toLocaleString('en-US', { timeZone: TIMEZONE }));
    const dayOfWeek = localDate.getDay(); // 0=Sun, 1=Mon, ...
    const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(localDate);
    monday.setDate(localDate.getDate() + diff);
    return monday.toISOString().slice(0, 10);
  }

  // Sort chronologically (oldest first) for week grouping
  const chrono = [...entries].sort((a, b) => {
    const dateA = a.clock_in_time || a.clock_in || a.created_at || '';
    const dateB = b.clock_in_time || b.clock_in || b.created_at || '';
    return dateA.localeCompare(dateB);
  });

  // Build a map: employeeName|||weekMonday -> { totalHours, lastEntryId }
  const weekMap = {};
  chrono.forEach((e) => {
    const name = e.name || e.user_name || '';
    const dateStr = e.clock_in_time || e.clock_in || '';
    const monday = getWeekMonday(dateStr);
    if (!monday || !name) return;

    const key = `${name}|||${monday}`;
    if (!weekMap[key]) weekMap[key] = { totalHours: 0, lastEntryId: null, monday };

    const hrs = parseFloat(e.hours) || 0;
    weekMap[key].totalHours += hrs;
    weekMap[key].lastEntryId = e.id;
  });

  // Apply week_total only on completed weeks (not the current week)
  const idToWeekTotal = {};
  Object.values(weekMap).forEach(({ totalHours, lastEntryId, monday }) => {
    if (lastEntryId && totalHours > 0 && monday < currentMondayStr) {
      idToWeekTotal[lastEntryId] = totalHours.toFixed(2);
    }
  });

  return entries.map((e) => ({
    ...e,
    week_total: idToWeekTotal[e.id] || e.week_total || '',
  }));
}

async function handleGetLogs(authUser, query) {
  // Executive-only (L1 and CEO)
  if (authUser.level > 1) {
    return { status: 403, body: { error: 'Logs section is for executives only' } };
  }

  // Try Google Sheets first (persistent, survives deploys)
  if (sheets.isConfigured()) {
    try {
      // Map office code to office name for Sheets filtering
      let officeName = '';
      if (query.office) {
        const office = db.findOne('offices', (o) => o.code === query.office);
        officeName = office ? office.name : query.office;
      }

      // Map user_id to user name for Sheets filtering
      let userName = '';
      if (query.user_id) {
        const user = db.findOne('users', (u) => u.id === query.user_id);
        userName = user ? `${user.first_name} ${user.last_name}` : '';
      }

      let entries = await sheets.readTimecardEntries({
        start_date: query.start_date || '',
        end_date: query.end_date || '',
        office: officeName,
        user_name: userName,
        job_code: query.job_code || '',
      });

      // Calculate week totals for sheets entries
      entries = addWeekTotals(entries);

      return {
        status: 200,
        body: {
          entries: entries.slice(0, 1000),
          total: entries.length,
          source: 'sheets',
        },
      };
    } catch (err) {
      console.error('[Logs] Sheets read failed, falling back to DB:', err.message);
    }
  }

  // Fallback: read from local JSON database (only when Sheets is not configured)
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
      clock_in_address: e.clock_in_address || '',
      clock_out_address: e.clock_out_address || '',
      clock_in_lat: e.clock_in_lat || null,
      clock_in_lng: e.clock_in_lng || null,
      clock_out_lat: e.clock_out_lat || null,
      clock_out_lng: e.clock_out_lng || null,
      clock_in_time: e.clock_in || null,
      clock_out_time: e.clock_out || null,
      hours: e.net_hours || hours,
      job_code: e.job_code || 'Regular',
      comment: e.comment || '',
      user_id: e.user_id,
      created_at: e.created_at,
      break_length: e.break_length || '',
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

  // Calculate week totals (Mon-Sun) for DB entries
  entries = addWeekTotals(entries);

  return {
    status: 200,
    body: {
      entries: entries.slice(0, 1000),
      total: entries.length,
      source: 'db',
    },
  };
}

module.exports = { handleGetLogs };
