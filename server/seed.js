/**
 * Seed script — populates the database with all Visiting Angels offices,
 * employees, and the default holiday list.
 *
 * Run:  node server/seed.js
 */
const crypto = require('crypto');
const db = require('./db');

// ── Simple password hashing (swap for bcryptjs in production) ──
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

// ── Offices ──
const offices = [
  { code: 'JT',  name: 'Jenkintown',      address: '1250 Greenwood Ave Unit 1A, Jenkintown, PA 19046',           lat: 40.0960, lng: -75.1257 },
  { code: 'CF',  name: 'Chadds Ford',     address: '1204 E Baltimore Pike #301, Chadds Ford, PA 19317',         lat: 39.8726, lng: -75.5910 },
  { code: 'ML',  name: 'Mainline',        address: '1950 Lawrence Rd First Floor, Havertown, PA 19083',         lat: 39.9727, lng: -75.3190 },
  { code: 'CC',  name: 'Center City',     address: '2 Franklin Town Blvd, Philadelphia, PA 19103',              lat: 39.9566, lng: -75.1640 },
  { code: 'KOP', name: 'King of Prussia', address: '2000 Valley Forge Cir Suite 118, King of Prussia, PA 19406', lat: 40.0893, lng: -75.3558 },
];

// ── Level 1 — Executives (final approvers) ──
const executives = [
  { first: 'Stephen', last: 'Maiale',  email: 'christophersmith0580+stephen@gmail.com'  },
  { first: 'Rochelle', last: 'Sajda',  email: 'rsajda@visitingangels.com'  },
  { first: 'Mona R',   last: 'Nandy',  email: 'christophersmith0580+mona@gmail.com'      },
];

// ── CEO (email-only visibility, not an approver) ──
const ceo = { first: 'Ananda', last: 'Nandy', email: 'christophersmith0580+ceo@gmail.com' };

// ── Level 2 — Office Managers (one per office) ──
const managers = [
  { first: 'Wayne',    last: 'Preno',     office: 'JT',  email: 'christophersmith0580+wayne@gmail.com'    },
  { first: 'Robert',   last: 'Hartzman',  office: 'CF',  email: 'christophersmith0580+robert@gmail.com' },
  { first: 'Austin',   last: 'Zuerlein',  office: 'ML',  email: 'christophersmith0580+austin@gmail.com' },
  { first: 'Kalpesh',  last: 'Patel',     office: 'CC',  email: 'christophersmith0580+kalpesh@gmail.com'   },
  { first: 'Leslie',   last: 'Ross',      office: 'KOP', email: 'christophersmith0580+leslie@gmail.com'     },
];

// ── Exempt employees (skip Level 2, go directly to all 3 executives) ──
const exemptEmployees = [
  { first: 'Kyle J',  last: 'Carter',  office: 'ML', email: 'kyle.carter@visitingangels.com'   },
  { first: 'Hannah M', last: 'Rice',   office: 'JT', email: 'hannah.rice@visitingangels.com'   },
];

// ── Level 3 — Office Employees ──
const level3Employees = [
  // JT (13)
  { first: 'Finance',   last: 'Analytics', office: 'JT', email: 'finance-analytics@ycvliving.com'     },
  { first: 'Jessica A', last: 'Feldman',   office: 'JT', email: 'jessica.feldman@visitingangels.com'  },
  { first: 'Lori W',    last: 'Kennedy',   office: 'JT', email: 'lori.kennedy@visitingangels.com'     },
  { first: 'Tracy',     last: 'Ramos',     office: 'JT', email: 'tracy.ramos@visitingangels.com'      },
  { first: 'Amanda',    last: 'Abate',     office: 'JT', email: 'amanda.abate@visitingangels.com'     },
  { first: 'Michell',   last: 'Dawson',    office: 'JT', email: 'michell.dawson@visitingangels.com'   },
  { first: 'Eric',      last: 'Pestrack',  office: 'JT', email: 'eric.pestrack@visitingangels.com'    },
  { first: 'Derek',     last: 'Bray',      office: 'JT', email: 'derek.bray@visitingangels.com'       },
  { first: 'Karyn',     last: 'Pless',     office: 'JT', email: 'karyn.pless@visitingangels.com'      },
  { first: 'Madison',   last: 'Gibbons',   office: 'JT', email: 'madison.gibbons@visitingangels.com'  },
  { first: 'Linda',     last: 'Becker',    office: 'JT', email: 'linda.becker@visitingangels.com'     },
  { first: 'Ogbogu',    last: 'Ochuole',   office: 'JT', email: 'ogbogu.ochuole@visitingangels.com'   },
  { first: 'Chinwendu', last: 'Achebe',    office: 'JT', email: 'chinwendu.achebe@visitingangels.com' },
  // CF (4)
  { first: 'Jennifer',  last: 'Carl',      office: 'CF', email: 'jennifer.carl@visitingangels.com'    },
  { first: 'Alexander', last: 'Valentin',  office: 'CF', email: 'alexander.valentin@visitingangels.com'},
  { first: 'Ziera',     last: 'Simmons',   office: 'CF', email: 'ziera.simmons@visitingangels.com'    },
  { first: 'Jill',      last: 'Rossnagle', office: 'CF', email: 'jill.rossnagle@visitingangels.com'   },
  // ML (6)
  { first: 'Louise',    last: 'Pappas',    office: 'ML', email: 'louise.pappas@visitingangels.com'    },
  { first: 'Jockel',    last: 'Sumpter-King', office: 'ML', email: 'jockel.sumpterking@visitingangels.com' },
  { first: 'Lindsay',   last: 'Hayes',     office: 'ML', email: 'lindsay.hayes@visitingangels.com'    },
  { first: 'Kathleen',  last: 'Cianfrani', office: 'ML', email: 'kathleen.cianfrani@visitingangels.com'},
  { first: 'Michael',   last: 'Collings',  office: 'ML', email: 'michael.collings@visitingangels.com' },
  { first: 'Christine', last: 'Amoriello', office: 'ML', email: 'christine.amoriello@visitingangels.com'},
  // CC (1)
  { first: 'Esther',    last: 'Labranch',  office: 'CC', email: 'esther.labranch@visitingangels.com'  },
  // KOP (3)
  { first: 'Vanecia',   last: 'Green',     office: 'KOP', email: 'vanecia.green@visitingangels.com'   },
  { first: 'Janet',     last: 'Mackay',    office: 'KOP', email: 'janet.mackay@visitingangels.com'    },
  { first: 'Nancy',     last: 'Kearney',   office: 'KOP', email: 'nancy.kearney@visitingangels.com'   },
];

// ── Default holidays (2025–2026) ──
const holidays = [
  // Christmas blocks (always executive escalation)
  { name: 'Christmas Block 2025', start_date: '2025-12-24', end_date: '2026-01-02', is_christmas_block: true },
  { name: 'Christmas Block 2026', start_date: '2026-12-24', end_date: '2027-01-02', is_christmas_block: true },
  // Standard holidays (±5 day window triggers executive escalation)
  { name: "New Year's Day 2026",     date: '2026-01-01', is_christmas_block: false },
  { name: "Martin Luther King Jr. Day 2026", date: '2026-01-19', is_christmas_block: false },
  { name: "Presidents' Day 2026",    date: '2026-02-16', is_christmas_block: false },
  { name: 'Memorial Day 2026',       date: '2026-05-25', is_christmas_block: false },
  { name: 'Independence Day 2026',   date: '2026-07-04', is_christmas_block: false },
  { name: 'Labor Day 2026',          date: '2026-09-07', is_christmas_block: false },
  { name: 'Thanksgiving 2026',       date: '2026-11-26', is_christmas_block: false },
  { name: 'Day After Thanksgiving 2026', date: '2026-11-27', is_christmas_block: false },
];

// ── Seed ──
function seed() {
  db.resetDb();
  const defaultPassword = hashPassword('welcome123');

  // Insert offices
  const officeMap = {};
  for (const o of offices) {
    const record = db.insert('offices', {
      id: o.code,
      name: o.name,
      code: o.code,
      address: o.address,
      latitude: o.lat,
      longitude: o.lng,
    });
    officeMap[o.code] = record;
  }

  // Insert CEO as executive (level 1) with platform access but no email notifications
  db.insert('users', {
    first_name: ceo.first,
    last_name: ceo.last,
    email: ceo.email,
    password_hash: defaultPassword,
    role: 'executive',
    level: 1,
    office_code: null,
    is_exempt: false,
    no_email: true,
  });

  // Insert executives (Level 1)
  for (const e of executives) {
    db.insert('users', {
      first_name: e.first,
      last_name: e.last,
      email: e.email,
      password_hash: defaultPassword,
      role: 'executive',
      level: 1,
      office_code: null,
      is_exempt: false,
    });
  }

  // Insert managers (Level 2)
  for (const m of managers) {
    db.insert('users', {
      first_name: m.first,
      last_name: m.last,
      email: m.email,
      password_hash: defaultPassword,
      role: 'manager',
      level: 2,
      office_code: m.office,
      is_exempt: false,
    });
  }

  // Insert exempt employees (Level 3 but flagged exempt)
  for (const e of exemptEmployees) {
    db.insert('users', {
      first_name: e.first,
      last_name: e.last,
      email: e.email,
      password_hash: defaultPassword,
      role: 'employee',
      level: 3,
      office_code: e.office,
      is_exempt: true,
    });
  }

  // Insert regular Level 3 employees
  for (const e of level3Employees) {
    db.insert('users', {
      first_name: e.first,
      last_name: e.last,
      email: e.email,
      password_hash: defaultPassword,
      role: 'employee',
      level: 3,
      office_code: e.office,
      is_exempt: false,
    });
  }

  // Insert holidays
  for (const h of holidays) {
    db.insert('holidays', {
      name: h.name,
      date: h.date || null,
      start_date: h.start_date || null,
      end_date: h.end_date || null,
      is_christmas_block: h.is_christmas_block,
    });
  }

  const allUsers = db.findAll('users');
  console.log(`Seeded ${db.findAll('offices').length} offices`);
  console.log(`Seeded ${allUsers.length} users (${executives.length} execs, ${managers.length} managers, ${exemptEmployees.length} exempt, ${level3Employees.length} L3, 1 CEO)`);
  console.log(`Seeded ${db.findAll('holidays').length} holidays`);
  console.log('\nDefault password for all users: welcome123');
  console.log('Users can change their password after first login.');
}

seed();
