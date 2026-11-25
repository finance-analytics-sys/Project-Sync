/**
 * PTO approval workflow engine.
 *
 * Business rules:
 * 1. L3 employees → L2 manager of their office → (sometimes) L1 executives
 * 2. 14-day advance notice: ≥14 days out = L2 only. <14 days = L2 then auto-escalate to L1.
 * 3. Holiday-adjacent: Christmas block (Dec 24–Jan 2) always escalates.
 *    Other holidays: PTO within ±5 days of a holiday escalates.
 * 4. Exempt employees (James Staats, Kyle Carter, Hannah Rice): skip L2, go directly to all 3 execs.
 * 5. L2 managers requesting PTO: go to L1 executives.
 * 6. L1 executives requesting PTO: go to the OTHER 2 executives + CEO email-only notification.
 * 7. Edit/cancel only allowed while fully pending (no approvals given at any level).
 */
const db = require('../db');
const email = require('./email');

// ── Date helpers ──

function daysBetween(dateStr1, dateStr2) {
  const d1 = new Date(dateStr1 + 'T00:00:00Z');
  const d2 = new Date(dateStr2 + 'T00:00:00Z');
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateRangeOverlaps(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

// ── Holiday check ──

function requiresHolidayEscalation(startDate, endDate) {
  const holidays = db.findAll('holidays');
  for (const h of holidays) {
    if (h.is_christmas_block) {
      // Christmas block: exact range check
      if (dateRangeOverlaps(startDate, endDate, h.start_date, h.end_date)) {
        return { escalate: true, reason: `Overlaps ${h.name}` };
      }
    } else if (h.date) {
      // Other holidays: ±5 day window
      const windowStart = addDays(h.date, -5);
      const windowEnd = addDays(h.date, 5);
      if (dateRangeOverlaps(startDate, endDate, windowStart, windowEnd)) {
        return { escalate: true, reason: `Within 5 days of ${h.name} (${h.date})` };
      }
    }
  }
  return { escalate: false };
}

// ── Determine approval path ──

function getApprovalPath(requester, startDate) {
  const daysUntil = daysBetween(today(), startDate);

  // Executive requesting PTO → other 2 executives
  if (requester.level === 1) {
    return {
      type: 'executive_self',
      needsL2: false,
      needsL1: true,
      approvers: db.findAll('users', (u) => u.level === 1 && u.id !== requester.id),
      notifyCeo: true,
    };
  }

  // Manager requesting PTO → executives
  if (requester.level === 2) {
    return {
      type: 'manager_self',
      needsL2: false,
      needsL1: true,
      approvers: db.findAll('users', (u) => u.level === 1),
      notifyCeo: false,
    };
  }

  // Exempt employees → skip L2, go directly to all executives
  if (requester.is_exempt) {
    return {
      type: 'exempt',
      needsL2: false,
      needsL1: true,
      approvers: db.findAll('users', (u) => u.level === 1),
      notifyCeo: false,
    };
  }

  // Regular L3 employee
  const manager = db.findOne('users', (u) => u.level === 2 && u.office_code === requester.office_code);
  if (!manager) {
    return { type: 'error', error: `No manager found for office ${requester.office_code}` };
  }

  // Default: L2 only
  let needsL1 = false;
  let escalationReason = null;

  // 14-day rule
  if (daysUntil < 14) {
    needsL1 = true;
    escalationReason = `Less than 14 days notice (${daysUntil} days)`;
  }

  return {
    type: 'standard',
    needsL2: true,
    needsL1,
    l2Approver: manager,
    l1Approvers: needsL1 ? db.findAll('users', (u) => u.level === 1) : [],
    escalationReason,
    notifyCeo: false,
  };
}

// ── Submit PTO ──

async function submitPTO(requesterId, startDate, endDate, reason, hours) {
  const requester = db.findOne('users', (u) => u.id === requesterId);
  if (!requester) return { error: 'User not found' };

  if (startDate > endDate) return { error: 'Start date must be before end date' };
  if (startDate < today()) return { error: 'Cannot request PTO in the past' };

  const path = getApprovalPath(requester, startDate);
  if (path.type === 'error') return { error: path.error };

  // Check holiday escalation (override if standard path doesn't already need L1)
  const holidayCheck = requiresHolidayEscalation(startDate, endDate);
  if (holidayCheck.escalate && path.type === 'standard' && !path.needsL1) {
    path.needsL1 = true;
    path.l1Approvers = db.findAll('users', (u) => u.level === 1);
    path.escalationReason = holidayCheck.reason;
  }

  // Calculate PTO hours and days
  // If hours not provided, calculate from date range (8 hours per day)
  const dateCount = daysBetween(startDate, endDate) + 1;
  const ptoHours = hours ? Number(hours) : dateCount * 8;
  const ptoDays = ptoHours / 8;

  const request = db.insert('pto_requests', {
    requester_id: requesterId,
    start_date: startDate,
    end_date: endDate,
    reason: reason || '',
    pto_hours: ptoHours,
    pto_days: ptoDays,
    status: 'pending',
    approval_path: path.type,
    needs_l2: path.needsL2 || false,
    needs_l1: path.needsL1 || false,
    l2_status: path.needsL2 ? 'pending' : 'not_required',
    l1_status: path.needsL1 ? 'pending' : 'not_required',
    l2_approver_id: path.l2Approver?.id || null,
    l2_approved_by: null,
    l1_approved_by: null,
    escalation_reason: path.escalationReason || holidayCheck.reason || null,
    denial_reason: null,
    denied_by: null,
  });

  // Determine who to notify on submission
  let approvers;
  if (path.type === 'standard') {
    approvers = path.needsL2 && !path.needsL1
      ? [path.l2Approver]
      : path.needsL2
        ? [path.l2Approver]  // L2 first, L1 after L2 approves
        : path.l1Approvers;
  } else if (path.type === 'exempt' || path.type === 'manager_self') {
    approvers = path.approvers || db.findAll('users', (u) => u.level === 1);
  } else if (path.type === 'executive_self') {
    approvers = path.approvers;
  } else {
    approvers = [];
  }

  await email.ptoSubmittedEmail(request, requester, approvers);

  // CEO notification for executive self-PTO
  if (path.notifyCeo) {
    await email.ceoNotificationEmail(request, requester);
  }

  return { success: true, request, path };
}

// ── Approve PTO ──

async function approvePTO(requestId, approverId) {
  const request = db.findOne('pto_requests', (r) => r.id === requestId);
  if (!request) return { error: 'Request not found' };
  if (request.status !== 'pending') return { error: `Request is already ${request.status}` };

  const approver = db.findOne('users', (u) => u.id === approverId);
  if (!approver) return { error: 'Approver not found' };

  const requester = db.findOne('users', (u) => u.id === request.requester_id);

  // Determine if this approver can approve
  if (approver.level === 2) {
    // L2 manager approval
    if (request.l2_status !== 'pending') {
      return { error: 'Manager approval not required or already given' };
    }
    if (approver.office_code !== requester.office_code) {
      return { error: 'You can only approve requests from your own office' };
    }

    db.update('pto_requests', requestId, {
      l2_status: 'approved',
      l2_approved_by: approverId,
    });

    if (request.needs_l1) {
      // Escalate to L1
      const executives = db.findAll('users', (u) => u.level === 1);
      const updatedRequest = db.findOne('pto_requests', (r) => r.id === requestId);
      await email.ptoApprovedEmail(updatedRequest, requester, approver, false);
      await email.ptoEscalatedEmail(updatedRequest, requester, executives);
      return { success: true, status: 'escalated_to_executive', request: updatedRequest };
    } else {
      // L2 only — fully approved
      db.update('pto_requests', requestId, { status: 'approved' });
      const updatedRequest = db.findOne('pto_requests', (r) => r.id === requestId);
      await email.ptoApprovedEmail(updatedRequest, requester, approver, true);
      return { success: true, status: 'approved', request: updatedRequest };
    }
  }

  if (approver.level === 1) {
    // L1 executive approval
    if (request.l1_status !== 'pending') {
      return { error: 'Executive approval not required or already given' };
    }
    // For standard path, L2 must be done first (unless not required)
    if (request.needs_l2 && request.l2_status !== 'approved') {
      return { error: 'Manager must approve first before executive review' };
    }
    // For executive self-PTO, cannot approve own request
    if (request.requester_id === approverId) {
      return { error: 'Cannot approve your own PTO request' };
    }

    db.update('pto_requests', requestId, {
      status: 'approved',
      l1_status: 'approved',
      l1_approved_by: approverId,
    });

    const updatedRequest = db.findOne('pto_requests', (r) => r.id === requestId);
    await email.ptoApprovedEmail(updatedRequest, requester, approver, true);
    return { success: true, status: 'approved', request: updatedRequest };
  }

  return { error: 'You do not have permission to approve this request' };
}

// ── Deny PTO ──

async function denyPTO(requestId, denierId, denialReason) {
  const request = db.findOne('pto_requests', (r) => r.id === requestId);
  if (!request) return { error: 'Request not found' };
  if (request.status !== 'pending') return { error: `Request is already ${request.status}` };

  const denier = db.findOne('users', (u) => u.id === denierId);
  if (!denier) return { error: 'Denier not found' };
  if (denier.level > 2) return { error: 'You do not have permission to deny requests' };

  const requester = db.findOne('users', (u) => u.id === request.requester_id);

  // L2 denying
  if (denier.level === 2) {
    if (request.l2_status !== 'pending') return { error: 'Manager approval stage is not pending' };
    if (denier.office_code !== requester.office_code) {
      return { error: 'You can only deny requests from your own office' };
    }
  }

  // L1 denying
  if (denier.level === 1) {
    if (request.l1_status !== 'pending') return { error: 'Executive approval stage is not pending' };
    if (request.requester_id === denierId) return { error: 'Cannot deny your own PTO request' };
  }

  db.update('pto_requests', requestId, {
    status: 'denied',
    denial_reason: denialReason || '',
    denied_by: denierId,
    l2_status: denier.level === 2 ? 'denied' : request.l2_status,
    l1_status: denier.level === 1 ? 'denied' : request.l1_status,
  });

  const updatedRequest = db.findOne('pto_requests', (r) => r.id === requestId);
  await email.ptoDeniedEmail(updatedRequest, requester, denier);
  return { success: true, status: 'denied', request: updatedRequest };
}

// ── Cancel PTO ──

async function cancelPTO(requestId, userId) {
  const request = db.findOne('pto_requests', (r) => r.id === requestId);
  if (!request) return { error: 'Request not found' };
  if (request.requester_id !== userId) return { error: 'You can only cancel your own requests' };
  if (request.status !== 'pending') return { error: 'Can only cancel pending requests' };

  // Check if any approval has been given
  if (request.l2_status === 'approved' || request.l1_status === 'approved') {
    return { error: 'Cannot cancel — approval has already been given at one or more levels' };
  }

  db.update('pto_requests', requestId, { status: 'cancelled' });

  const requester = db.findOne('users', (u) => u.id === userId);
  // Notify relevant approvers about cancellation
  const notifyEmails = [];
  if (request.l2_approver_id) {
    const mgr = db.findOne('users', (u) => u.id === request.l2_approver_id);
    if (mgr) notifyEmails.push(mgr.email);
  }
  if (request.needs_l1) {
    db.findAll('users', (u) => u.level === 1).forEach((e) => notifyEmails.push(e.email));
  }

  if (notifyEmails.length > 0) {
    await email.ptoCancelledEmail(request, requester, notifyEmails);
  }

  return { success: true, status: 'cancelled' };
}

// ── Edit PTO ──

async function editPTO(requestId, userId, updates) {
  const request = db.findOne('pto_requests', (r) => r.id === requestId);
  if (!request) return { error: 'Request not found' };
  if (request.requester_id !== userId) return { error: 'You can only edit your own requests' };
  if (request.status !== 'pending') return { error: 'Can only edit pending requests' };

  // Check if any approval has been given
  if (request.l2_status === 'approved' || request.l1_status === 'approved') {
    return { error: 'Cannot edit — approval has already been given at one or more levels' };
  }

  const newStart = updates.start_date || request.start_date;
  const newEnd = updates.end_date || request.end_date;
  if (newStart > newEnd) return { error: 'Start date must be before end date' };
  if (newStart < today()) return { error: 'Cannot set PTO dates in the past' };

  // Recalculate approval path with new dates
  const requester = db.findOne('users', (u) => u.id === userId);
  const path = getApprovalPath(requester, newStart);
  const holidayCheck = requiresHolidayEscalation(newStart, newEnd);

  if (holidayCheck.escalate && path.type === 'standard' && !path.needsL1) {
    path.needsL1 = true;
    path.escalationReason = holidayCheck.reason;
  }

  // Recalculate hours/days if hours changed, or recalculate from dates if not provided
  const dateCount = daysBetween(newStart, newEnd) + 1;
  const newHours = updates.hours !== undefined ? Number(updates.hours) : (request.pto_hours || dateCount * 8);
  const newDays = newHours / 8;

  db.update('pto_requests', requestId, {
    start_date: newStart,
    end_date: newEnd,
    reason: updates.reason !== undefined ? updates.reason : request.reason,
    pto_hours: newHours,
    pto_days: newDays,
    needs_l1: path.needsL1 || false,
    l1_status: path.needsL1 ? 'pending' : 'not_required',
    escalation_reason: path.escalationReason || holidayCheck.reason || null,
  });

  const updatedRequest = db.findOne('pto_requests', (r) => r.id === requestId);

  // Notify relevant people about the edit
  const notifyEmails = [];
  if (request.l2_approver_id) {
    const mgr = db.findOne('users', (u) => u.id === request.l2_approver_id);
    if (mgr) notifyEmails.push(mgr.email);
  }

  if (notifyEmails.length > 0) {
    await email.ptoEditedEmail(updatedRequest, requester, notifyEmails);
  }

  return { success: true, request: updatedRequest };
}

// ── Executive Cancel (approved PTO) ──

async function executiveCancelPTO(requestId, executiveId, cancelComment) {
  const request = db.findOne('pto_requests', (r) => r.id === requestId);
  if (!request) return { error: 'Request not found' };

  const executive = db.findOne('users', (u) => u.id === executiveId);
  if (!executive) return { error: 'User not found' };
  if (executive.level > 1) return { error: 'Only executives (L1) can cancel approved PTO' };

  if (request.status !== 'approved') {
    return { error: `Cannot cancel — request is ${request.status}, not approved` };
  }

  const requester = db.findOne('users', (u) => u.id === request.requester_id);

  db.update('pto_requests', requestId, {
    status: 'cancelled',
    cancelled_by: executiveId,
    cancel_comment: cancelComment || null,
    executive_cancelled: true,
  });

  await email.ptoExecutiveCancelledEmail(request, requester, executive, cancelComment);

  return { success: true, status: 'cancelled' };
}

module.exports = {
  submitPTO, approvePTO, denyPTO, cancelPTO, editPTO, executiveCancelPTO,
  getApprovalPath, requiresHolidayEscalation,
};
