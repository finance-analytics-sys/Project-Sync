/**
 * Admin routes: list users, offices, holidays.
 */
const db = require('../db');

function handleGetUsers(authUser) {
  if (authUser.level > 2) {
    return { status: 403, body: { error: 'Insufficient permissions' } };
  }

  let users;
  if (authUser.level <= 1) {
    users = db.findAll('users');
  } else {
    // Managers see their office employees
    users = db.findAll('users', (u) => u.office_code === authUser.office_code);
  }

  // Strip password hashes
  const safe = users.map(({ password_hash, ...rest }) => rest);
  return { status: 200, body: { users: safe } };
}

function handleGetOffices() {
  return { status: 200, body: { offices: db.findAll('offices') } };
}

function handleGetHolidays() {
  return { status: 200, body: { holidays: db.findAll('holidays') } };
}

module.exports = { handleGetUsers, handleGetOffices, handleGetHolidays };
