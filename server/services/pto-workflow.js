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
 * 7. Edit/cancel: free while fully pending. Approved PTO can also be edited (resets to pending)
 *    or cancelled by employee (with confirmation) or by executive (see executiveCancelPTO).
 * 8. Stubs for: Viventium PTO balance, auto-cancel, insufficient balance lockout, partial-day PTO.
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

// ── Cancel PTO (legacy wrapper — routes still call cancelPTO) ──

async function cancelPTO(requestId, userId, forceCancel) {
  return cancelPTOv2(requestId, userId, forceCancel);
}

// ── Edit PTO ──
//
// Two cases:
//   1. Fully pending (no approvals at any level) — free edit, no warnings needed
//   2. Approved PTO — resets to pending, re-enters approval pipeline, employee gets warning
//      The frontend must show a confirmation dialog before submitting with force_edit=true
//
// Partially approved (L2 approved, awaiting L1) — treated same as approved: resets all.

async function editPTO(requestId, userId, updates) {
  const request = db.findOne('pto_requests', (r) => r.id === requestId);
  if (!request) return { error: 'Request not found' };
  if (request.requester_id !== userId) return { error: 'You can only edit your own requests' };

  // Cancelled and denied requests cannot be edited
  if (request.status === 'cancelled' || request.status === 'denied') {
    return { error: `Cannot edit a ${request.status} request` };
  }

  const wasApproved = request.status === 'approved';
  const hadPartialApproval = request.l2_status === 'approved' || request.l1_status === 'approved';

  // If request was approved or partially approved, require force_edit flag
  if ((wasApproved || hadPartialApproval) && !updates.force_edit) {
    return {
      error: 'CONFIRM_REQUIRED',
      message: wasApproved
        ? 'This PTO has already been approved. Editing it will reset it to pending and require re-approval from all levels.'
        : 'This PTO has partial approval. Editing it will reset all approvals and require re-approval.',
      requires_confirmation: true,
    };
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

  // Build update object — always reset approval status when editing
  const updateObj = {
    start_date: newStart,
    end_date: newEnd,
    reason: updates.reason !== undefined ? updates.reason : request.reason,
    pto_hours: newHours,
    pto_days: newDays,
    status: 'pending',
    needs_l2: path.needsL2 || false,
    needs_l1: path.needsL1 || false,
    l2_status: path.needsL2 ? 'pending' : 'not_required',
    l1_status: path.needsL1 ? 'pending' : 'not_required',
    l2_approved_by: null,
    l1_approved_by: null,
    approval_path: path.type,
    l2_approver_id: path.l2Approver?.id || request.l2_approver_id || null,
    escalation_reason: path.escalationReason || holidayCheck.reason || null,
    denial_reason: null,
    denied_by: null,
  };

  // Track that this was re-submitted after approval
  if (wasApproved || hadPartialApproval) {
    updateObj.edited_after_approval = true;
    updateObj.previous_approval_status = wasApproved ? 'approved' : 'partially_approved';
  }

  db.update('pto_requests', requestId, updateObj);

  const updatedRequest = db.findOne('pto_requests', (r) => r.id === requestId);

  // Notify relevant people about the edit
  const notifyEmails = [];
  if (updatedRequest.l2_approver_id) {
    const mgr = db.findOne('users', (u) => u.id === updatedRequest.l2_approver_id);
    if (mgr) notifyEmails.push(mgr.email);
  }
  if (wasApproved || hadPartialApproval) {
    // Also notify executives if this was an approved PTO being reset
    db.findAll('users', (u) => u.level === 1).forEach((e) => notifyEmails.push(e.email));
  }

  if (notifyEmails.length > 0) {
    await email.ptoEditedEmail(updatedRequest, requester, [...new Set(notifyEmails)]);
  }

  return {
    success: true,
    request: updatedRequest,
    was_reset: wasApproved || hadPartialApproval,
  };
}

// ── Cancel PTO (employee) ──
//
// Employees can cancel freely while fully pending.
// Approved PTO: employees CAN cancel their own approved PTO, but get a confirmation warning.
// The frontend must show a dialog before submitting with force_cancel=true.

async function cancelPTOv2(requestId, userId, forceCancel) {
  const request = db.findOne('pto_requests', (r) => r.id === requestId);
  if (!request) return { error: 'Request not found' };
  if (request.requester_id !== userId) return { error: 'You can only cancel your own requests' };

  if (request.status === 'cancelled' || request.status === 'denied') {
    return { error: `Request is already ${request.status}` };
  }

  const wasApproved = request.status === 'approved';
  const hadPartialApproval = request.l2_status === 'approved' || request.l1_status === 'approved';

  // If approved or partially approved, require force_cancel flag
  if ((wasApproved || hadPartialApproval) && !forceCancel) {
    return {
      error: 'CONFIRM_REQUIRED',
      message: wasApproved
        ? 'This PTO has been approved. Are you sure you want to cancel it?'
        : 'This PTO has partial approval. Are you sure you want to cancel it?',
      requires_confirmation: true,
    };
  }

  db.update('pto_requests', requestId, { status: 'cancelled' });

  const requester = db.findOne('users', (u) => u.id === userId);
  const notifyEmails = [];
  if (request.l2_approver_id) {
    const mgr = db.findOne('users', (u) => u.id === request.l2_approver_id);
    if (mgr) notifyEmails.push(mgr.email);
  }
  if (request.needs_l1 || wasApproved) {
    db.findAll('users', (u) => u.level === 1).forEach((e) => notifyEmails.push(e.email));
  }

  if (notifyEmails.length > 0) {
    await email.ptoCancelledEmail(request, requester, [...new Set(notifyEmails)]);
  }

  return { success: true, status: 'cancelled' };
}

// ── Stubs for future features ──

/**
 * STUB: Viventium PTO Balance
 * When integrated, this will fetch real-time PTO balance from Viventium API
 * for the given employee. Currently returns a placeholder.
 */
function getViventiumPTOBalance(/* userId */) {
  // TODO: Integrate with Viventium API
  // Expected response: { available_hours, used_hours, total_hours, accrual_rate }
  return { available_hours: null, used_hours: null, total_hours: null, source: 'not_connected' };
}

/**
 * STUB: Auto-cancel system
 * When a PTO request is not actioned within N days, it should be auto-cancelled
 * and the employee notified. This will be run as a daily cron job.
 */
function processAutoCancellations() {
  // TODO: Implement auto-cancel logic
  // 1. Find pending requests older than X days
  // 2. Cancel them
  // 3. Notify employees
  return { processed: 0, cancelled: 0 };
}

/**
 * STUB: Insufficient PTO balance lockout
 * Before submitting a PTO request, check if the employee has enough balance.
 * If not, block the submission with a clear error message.
 */
function checkSufficientBalance(/* userId, requestedHours */) {
  // TODO: Requires Viventium integration
  // For now, always allow submission
  return { sufficient: true, available: null, requested: null };
}

/**
 * STUB: Partial-day PTO
 * Allow employees to request PTO for a portion of a day (e.g., half-day).
 * Parked for executive discussion — will need UI changes and timecard logic.
 */
function validatePartialDayPTO(/* hours, date */) {
  // TODO: Define rules for partial-day PTO
  // - Minimum hours? (e.g., 1 hour minimum)
  // - Only specific increments? (1, 2, 4, 8)
  // - How does it interact with clock-in/clock-out for the remaining hours?
  return { allowed: false, reason: 'Partial-day PTO is not yet enabled' };
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
  // Stubs — exported for future use
  getViventiumPTOBalance, processAutoCancellations,
  checkSufficientBalance, validatePartialDayPTO,
};
