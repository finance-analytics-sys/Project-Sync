/**
 * PTO routes: submit, approve, deny, cancel, edit, list.
 */
const db = require('../db');
const workflow = require('../services/pto-workflow');

async function handleSubmit(body, authUser) {
  const { start_date, end_date, reason, hours } = body;
  if (!start_date || !end_date) {
    return { status: 400, body: { error: 'start_date and end_date are required' } };
  }
  const result = await workflow.submitPTO(authUser.id, start_date, end_date, reason, hours);
  if (result.error) return { status: 400, body: { error: result.error } };
  return { status: 201, body: result };
}

async function handleApprove(body, authUser) {
  const { request_id } = body;
  if (!request_id) return { status: 400, body: { error: 'request_id is required' } };
  const result = await workflow.approvePTO(request_id, authUser.id);
  if (result.error) return { status: 400, body: { error: result.error } };
  return { status: 200, body: result };
}

async function handleDeny(body, authUser) {
  const { request_id, reason } = body;
  if (!request_id) return { status: 400, body: { error: 'request_id is required' } };
  const result = await workflow.denyPTO(request_id, authUser.id, reason);
  if (result.error) return { status: 400, body: { error: result.error } };
  return { status: 200, body: result };
}

async function handleCancel(body, authUser) {
  const { request_id } = body;
  if (!request_id) return { status: 400, body: { error: 'request_id is required' } };
  const result = await workflow.cancelPTO(request_id, authUser.id);
  if (result.error) return { status: 400, body: { error: result.error } };
  return { status: 200, body: result };
}

async function handleEdit(body, authUser) {
  const { request_id, start_date, end_date, reason, hours } = body;
  if (!request_id) return { status: 400, body: { error: 'request_id is required' } };
  const result = await workflow.editPTO(request_id, authUser.id, { start_date, end_date, reason, hours });
  if (result.error) return { status: 400, body: { error: result.error } };
  return { status: 200, body: result };
}

function handleGetMyRequests(authUser) {
  const requests = db.findAll('pto_requests', (r) => r.requester_id === authUser.id);
  requests.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return { status: 200, body: { requests } };
}

function handleGetPendingApprovals(authUser) {
  let requests;

  if (authUser.level === 1) {
    // Executives see all requests pending L1 approval
    requests = db.findAll('pto_requests', (r) =>
      r.status === 'pending' &&
      r.needs_l1 &&
      r.l1_status === 'pending' &&
      r.requester_id !== authUser.id &&
      (r.l2_status === 'approved' || r.l2_status === 'not_required')
    );
  } else if (authUser.level === 2) {
    // Managers see pending L2 requests from their office
    const officeUsers = db.findAll('users', (u) => u.office_code === authUser.office_code && u.level === 3);
    const userIds = new Set(officeUsers.map((u) => u.id));
    requests = db.findAll('pto_requests', (r) =>
      r.status === 'pending' && r.l2_status === 'pending' && userIds.has(r.requester_id)
    );
  } else {
    return { status: 403, body: { error: 'You do not have approval permissions' } };
  }

  // Enrich with requester info
  const enriched = requests.map((r) => {
    const requester = db.findOne('users', (u) => u.id === r.requester_id);
    return {
      ...r,
      requester_name: requester ? `${requester.first_name} ${requester.last_name}` : 'Unknown',
      requester_email: requester?.email,
      requester_office: requester?.office_code,
    };
  });

  enriched.sort((a, b) => new Date(a.start_date) - new Date(b.start_date));
  return { status: 200, body: { requests: enriched } };
}

function handleGetAllRequests(authUser, query) {
  let requests;

  if (authUser.level <= 1) {
    requests = db.findAll('pto_requests');
  } else if (authUser.level === 2) {
    const officeUsers = db.findAll('users', (u) => u.office_code === authUser.office_code);
    const userIds = new Set(officeUsers.map((u) => u.id));
    requests = db.findAll('pto_requests', (r) => userIds.has(r.requester_id));
  } else {
    return { status: 403, body: { error: 'Insufficient permissions' } };
  }

  // Enrich
  const enriched = requests.map((r) => {
    const requester = db.findOne('users', (u) => u.id === r.requester_id);
    return {
      ...r,
      requester_name: requester ? `${requester.first_name} ${requester.last_name}` : 'Unknown',
      requester_email: requester?.email,
      requester_office: requester?.office_code || 'HQ',
    };
  });

  // Filter by status
  let filtered = enriched;
  if (query.status) filtered = filtered.filter((r) => r.status === query.status);

  filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return { status: 200, body: { requests: filtered.slice(0, 200) } };
}

function handleGetCalendar(authUser, query) {
  // month format: YYYY-MM
  const month = query.month || new Date().toISOString().slice(0, 7);
  const office = query.office || null;
  const [year, mon] = month.split('-').map(Number);

  // Get first and last day of the month
  const firstDay = `${month}-01`;
  const lastDay = `${year}-${String(mon).padStart(2, '0')}-${new Date(year, mon, 0).getDate()}`;

  // Get approved PTOs that overlap this month
  let requests = db.findAll('pto_requests', (r) =>
    r.status === 'approved' &&
    r.start_date <= lastDay &&
    r.end_date >= firstDay
  );

  // Enrich with user info
  let enriched = requests.map((r) => {
    const requester = db.findOne('users', (u) => u.id === r.requester_id);
    return {
      id: r.id,
      start_date: r.start_date,
      end_date: r.end_date,
      reason: r.reason,
      pto_hours: r.pto_hours || null,
      pto_days: r.pto_days || null,
      requester_name: requester ? `${requester.first_name} ${requester.last_name}` : 'Unknown',
      requester_office: requester?.office_code || 'HQ',
      requester_level: requester?.level,
      requester_role: requester?.role,
    };
  });

  // Filter by office if specified
  if (office && office !== 'all') {
    enriched = enriched.filter((r) => r.requester_office === office);
  }

  // Permission check: L2 can only see their office
  if (authUser.level === 2) {
    enriched = enriched.filter((r) => r.requester_office === authUser.office_code);
  }

  // Get offices for filter dropdown
  const offices = db.findAll('offices');

  // Today's PTO (who is out today)
  const today = new Date().toISOString().slice(0, 10);
  let todayOut = db.findAll('pto_requests', (r) =>
    r.status === 'approved' &&
    r.start_date <= today &&
    r.end_date >= today
  ).map((r) => {
    const requester = db.findOne('users', (u) => u.id === r.requester_id);
    return {
      requester_name: requester ? `${requester.first_name} ${requester.last_name}` : 'Unknown',
      requester_office: requester?.office_code || 'HQ',
      start_date: r.start_date,
      end_date: r.end_date,
    };
  });

  if (authUser.level === 2) {
    todayOut = todayOut.filter((r) => r.requester_office === authUser.office_code);
  } else if (office && office !== 'all') {
    todayOut = todayOut.filter((r) => r.requester_office === office);
  }

  return {
    status: 200,
    body: { requests: enriched, offices, todayOut, month, year, mon },
  };
}

function handleGetAllApproved(authUser) {
  if (authUser.level > 1) {
    return { status: 403, body: { error: 'Insufficient permissions' } };
  }

  const requests = db.findAll('pto_requests', (r) => r.status === 'approved');
  const enriched = requests.map((r) => {
    const requester = db.findOne('users', (u) => u.id === r.requester_id);
    return {
      ...r,
      requester_name: requester ? `${requester.first_name} ${requester.last_name}` : 'Unknown',
      requester_email: requester?.email,
      requester_office: requester?.office_code || 'HQ',
    };
  });

  enriched.sort((a, b) => new Date(b.start_date) - new Date(a.start_date));
  return { status: 200, body: { requests: enriched } };
}

async function handleExecutiveCancel(body, authUser) {
  const { request_id, cancel_comment } = body;
  if (!request_id) return { status: 400, body: { error: 'request_id is required' } };
  const result = await workflow.executiveCancelPTO(request_id, authUser.id, cancel_comment);
  if (result.error) return { status: 400, body: { error: result.error } };
  return { status: 200, body: result };
}

module.exports = {
  handleSubmit, handleApprove, handleDeny, handleCancel, handleEdit,
  handleGetMyRequests, handleGetPendingApprovals, handleGetAllRequests,
  handleGetCalendar, handleGetAllApproved, handleExecutiveCancel,
};
