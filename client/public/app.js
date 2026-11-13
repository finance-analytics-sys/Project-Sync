/**
 * Project Sync — Single-page frontend
 * Vanilla JS, no build step required.
 */
(function () {
  'use strict';

  // ── State ──
  let token = localStorage.getItem('ps_token');
  let currentUser = null;
  let activeTab = 'clock';
  let clockStatus = { clocked_in: false, current_entry: null };
  let clockInterval = null;
  let pendingCount = 0;

  // ── API helper ──
  async function api(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`/api${path}`, opts);
    const data = await res.json();
    if (res.status === 401 && path !== '/auth/login') {
      logout();
      return null;
    }
    return { ok: res.ok, status: res.status, data };
  }

  // ── Geolocation ──
  function getLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
        (err) => reject(new Error(`Location error: ${err.message}. Please enable location services.`)),
        { enableHighAccuracy: true, timeout: 15000 }
      );
    });
  }

  // ── Render helpers ──
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'className') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v);
    });
    children.flat().forEach((c) => {
      if (c == null) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatTime(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function formatDuration(startStr, endStr) {
    if (!startStr || !endStr) return '—';
    const ms = new Date(endStr) - new Date(startStr);
    const hrs = Math.floor(ms / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    return `${hrs}h ${mins}m`;
  }

  function statusBadge(status) {
    const cls = {
      pending: 'badge-pending', approved: 'badge-approved',
      denied: 'badge-denied', cancelled: 'badge-cancelled',
    }[status] || 'badge-pending';
    return h('span', { className: `badge ${cls}` }, status);
  }

  // ── Google Sign-In callback ──
  window.handleGoogleCredential = async function (response) {
    const errDiv = $('#login-error');
    if (errDiv) errDiv.innerHTML = '<div class="alert" style="background:#e1effe;color:#1a56db;">Signing in with Google...</div>';

    const res = await api('POST', '/auth/google', { credential: response.credential });
    if (res && res.ok) {
      token = res.data.token;
      currentUser = res.data.user;
      localStorage.setItem('ps_token', token);
      renderApp();
    } else {
      if (errDiv) errDiv.innerHTML = `<div class="alert alert-error">${res?.data?.error || 'Google sign-in failed'}</div>`;
    }
  };

  // ── Login Page ──
  function renderLogin() {
    const app = $('#app');
    app.innerHTML = '';

    const form = h('div', { className: 'login-page' },
      h('div', { className: 'login-card' },
        h('h1', null, 'Project Sync'),
        h('p', null, 'Visiting Angels Employee Portal'),
        h('div', { id: 'login-error' }),

        // ── Google Sign-In button ──
        h('div', { className: 'google-btn-wrap', id: 'google-btn-container' }),

        h('div', { className: 'login-divider' }, 'or sign in with email'),

        // ── Email/password form ──
        h('form', {
          id: 'login-form',
          onSubmit: async (e) => {
            e.preventDefault();
            const email = $('#login-email').value.trim();
            const password = $('#login-password').value;
            const errDiv = $('#login-error');
            const btn = $('#login-btn');

            if (!email || !password) {
              errDiv.innerHTML = '<div class="alert alert-error">Please enter email and password.</div>';
              return;
            }

            btn.disabled = true;
            btn.textContent = 'Signing in...';

            const res = await api('POST', '/auth/login', { email, password });
            if (res && res.ok) {
              token = res.data.token;
              currentUser = res.data.user;
              localStorage.setItem('ps_token', token);
              renderApp();
            } else {
              errDiv.innerHTML = `<div class="alert alert-error">${res?.data?.error || 'Login failed'}</div>`;
              btn.disabled = false;
              btn.textContent = 'Sign In';
            }
          },
        },
          h('div', { className: 'form-group' },
            h('label', { for: 'login-email' }, 'Email'),
            h('input', { type: 'email', id: 'login-email', placeholder: 'you@visitingangels.com', required: 'true' }),
          ),
          h('div', { className: 'form-group' },
            h('label', { for: 'login-password' }, 'Password'),
            h('input', { type: 'password', id: 'login-password', placeholder: 'Enter password', required: 'true' }),
          ),
          h('button', { type: 'submit', id: 'login-btn', className: 'btn btn-primary', style: 'width:100%' }, 'Sign In'),
        ),
      ),
    );
    app.appendChild(form);

    // Initialize Google Sign-In button once the GSI library loads
    initGoogleButton();
  }

  function initGoogleButton() {
    const container = $('#google-btn-container');
    if (!container) return;

    if (typeof google !== 'undefined' && google.accounts) {
      renderGoogleButton(container);
    } else {
      // GSI library hasn't loaded yet — retry
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        if (typeof google !== 'undefined' && google.accounts) {
          clearInterval(interval);
          renderGoogleButton(container);
        } else if (attempts > 30) {
          clearInterval(interval);
          // GSI didn't load — just show email/password login
          container.style.display = 'none';
          const divider = document.querySelector('.login-divider');
          if (divider) divider.style.display = 'none';
        }
      }, 200);
    }
  }

  function renderGoogleButton(container) {
    // Read client ID from a meta tag or use a placeholder
    const clientId = document.querySelector('meta[name="google-client-id"]')?.content
      || window.GOOGLE_CLIENT_ID
      || '';

    if (!clientId) {
      // No client ID configured — hide Google button
      container.style.display = 'none';
      const divider = document.querySelector('.login-divider');
      if (divider) divider.style.display = 'none';
      return;
    }

    google.accounts.id.initialize({
      client_id: clientId,
      callback: handleGoogleCredential,
      auto_select: false,
    });

    google.accounts.id.renderButton(container, {
      theme: 'outline',
      size: 'large',
      width: 320,
      text: 'signin_with',
      shape: 'rectangular',
    });
  }

  // ── Main App ──
  async function renderApp() {
    if (!currentUser) {
      const res = await api('GET', '/auth/me');
      if (!res || !res.ok) { renderLogin(); return; }
      currentUser = res.data;
    }

    const app = $('#app');
    app.innerHTML = '';

    // Check if user has approval permissions
    const canApprove = currentUser.level <= 2;

    // Navbar
    const navbar = h('nav', { className: 'navbar' },
      h('h1', null, 'Project Sync'),
      h('div', { className: 'user-info' },
        h('span', null, `${currentUser.first_name} ${currentUser.last_name}`),
        currentUser.office_code ? h('span', { className: 'text-sm', style: 'opacity:.7' }, `(${currentUser.office_code})`) : null,
        h('button', { onClick: logout }, 'Sign Out'),
      ),
    );
    app.appendChild(navbar);

    // Container with tabs
    const container = h('div', { className: 'container' });
    app.appendChild(container);

    // Build tabs
    const tabList = [
      { id: 'clock', label: 'Clock In/Out' },
      { id: 'pto', label: 'Request PTO' },
      { id: 'my-pto', label: 'My Requests' },
    ];
    if (canApprove) tabList.push({ id: 'approvals', label: 'Approvals' });
    if (currentUser.level <= 2) tabList.push({ id: 'reports', label: 'Reports' });

    const tabsDiv = h('div', { className: 'tabs' });
    tabList.forEach((t) => {
      const btn = h('button', {
        className: `tab${activeTab === t.id ? ' active' : ''}`,
        id: `tab-${t.id}`,
        onClick: () => switchTab(t.id),
      }, t.label);
      if (t.id === 'approvals' && pendingCount > 0) {
        btn.appendChild(h('span', { className: 'count' }, String(pendingCount)));
      }
      tabsDiv.appendChild(btn);
    });
    container.appendChild(tabsDiv);

    // Tab content
    const content = h('div', { id: 'tab-content' });
    container.appendChild(content);

    // Load initial tab
    switchTab(activeTab);

    // Fetch pending count for approvals badge
    if (canApprove) loadPendingCount();
  }

  async function loadPendingCount() {
    const res = await api('GET', '/pto/pending');
    if (res && res.ok) {
      pendingCount = res.data.requests.length;
      const badge = document.querySelector('#tab-approvals .count');
      if (badge) {
        badge.textContent = pendingCount || '';
        if (!pendingCount) badge.style.display = 'none';
      } else if (pendingCount > 0) {
        const tabBtn = document.querySelector('#tab-approvals');
        if (tabBtn) tabBtn.appendChild(h('span', { className: 'count' }, String(pendingCount)));
      }
    }
  }

  function switchTab(tabId) {
    activeTab = tabId;
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${tabId}`));
    const content = $('#tab-content');
    content.innerHTML = '';

    switch (tabId) {
      case 'clock': renderClockTab(content); break;
      case 'pto': renderPTOTab(content); break;
      case 'my-pto': renderMyPTOTab(content); break;
      case 'approvals': renderApprovalsTab(content); break;
      case 'reports': renderReportsTab(content); break;
    }
  }

  // ── Clock Tab ──
  async function renderClockTab(container) {
    const res = await api('GET', '/clock/status');
    if (res && res.ok) clockStatus = res.data;

    const card = h('div', { className: 'card clock-display' });

    // Live clock
    const timeEl = h('div', { className: 'time' }, new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    const dateEl = h('div', { className: 'date' }, new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }));

    if (clockInterval) clearInterval(clockInterval);
    clockInterval = setInterval(() => {
      timeEl.textContent = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }, 1000);

    // Status
    const statusEl = h('div', {
      className: `status-badge ${clockStatus.clocked_in ? 'status-clocked-in' : 'status-clocked-out'}`,
    }, clockStatus.clocked_in ? `Clocked in since ${formatTime(clockStatus.current_entry?.clock_in)}` : 'Not clocked in');

    // Button
    const msgEl = h('div', { id: 'clock-msg', className: 'mt-4' });
    const btnEl = h('button', {
      className: `btn clock-btn ${clockStatus.clocked_in ? 'btn-danger' : 'btn-success'}`,
      onClick: async () => {
        btnEl.disabled = true;
        btnEl.textContent = 'Getting location...';
        msgEl.innerHTML = '';

        try {
          const loc = await getLocation();
          const endpoint = clockStatus.clocked_in ? '/clock/out' : '/clock/in';
          const result = await api('POST', endpoint, loc);

          if (result && result.ok) {
            msgEl.innerHTML = `<div class="alert alert-success">${result.data.message}</div>`;
            // Refresh
            setTimeout(() => switchTab('clock'), 1500);
          } else {
            msgEl.innerHTML = `<div class="alert alert-error">${result?.data?.error || 'Failed'}</div>`;
            btnEl.disabled = false;
            btnEl.textContent = clockStatus.clocked_in ? 'Clock Out' : 'Clock In';
          }
        } catch (err) {
          msgEl.innerHTML = `<div class="alert alert-error">${err.message}</div>`;
          btnEl.disabled = false;
          btnEl.textContent = clockStatus.clocked_in ? 'Clock Out' : 'Clock In';
        }
      },
    }, clockStatus.clocked_in ? 'Clock Out' : 'Clock In');

    card.append(timeEl, dateEl, statusEl, btnEl, msgEl);
    container.appendChild(card);

    // Recent history
    const histRes = await api('GET', '/clock/history');
    if (histRes && histRes.ok && histRes.data.entries.length > 0) {
      const histCard = h('div', { className: 'card' },
        h('h2', null, 'Recent Clock History'),
        h('div', { className: 'table-wrap' },
          h('table', null,
            h('thead', null,
              h('tr', null,
                h('th', null, 'Date'), h('th', null, 'Clock In'), h('th', null, 'Clock Out'), h('th', null, 'Duration'),
              ),
            ),
            h('tbody', null,
              ...histRes.data.entries.slice(0, 10).map((e) =>
                h('tr', null,
                  h('td', null, formatDate(e.clock_in)),
                  h('td', null, formatTime(e.clock_in)),
                  h('td', null, e.clock_out ? formatTime(e.clock_out) : h('span', { className: 'badge badge-pending' }, 'Active')),
                  h('td', null, e.clock_out ? formatDuration(e.clock_in, e.clock_out) : '—'),
                ),
              ),
            ),
          ),
        ),
      );
      container.appendChild(histCard);
    }
  }

  // ── PTO Request Tab ──
  function updateHoursSummary() {
    const startVal = $('#pto-start')?.value;
    const endVal = $('#pto-end')?.value;
    const hoursVal = $('#pto-hours')?.value;
    const summaryEl = $('#pto-hours-summary');
    if (!summaryEl) return;

    if (startVal && endVal && hoursVal) {
      const hours = Number(hoursVal);
      const days = hours / 8;
      const dateCount = Math.round((new Date(endVal + 'T00:00:00') - new Date(startVal + 'T00:00:00')) / 86400000) + 1;
      summaryEl.innerHTML = `<strong>${hours}h</strong> = <strong>${days}</strong> day${days !== 1 ? 's' : ''} of PTO across ${dateCount} calendar day${dateCount !== 1 ? 's' : ''}`;
      summaryEl.style.display = 'block';
    } else {
      summaryEl.style.display = 'none';
    }
  }

  function renderPTOTab(container) {
    const card = h('div', { className: 'card' },
      h('h2', null, 'Request Time Off'),
      h('div', { id: 'pto-msg' }),
      h('form', {
        id: 'pto-form',
        onSubmit: async (e) => {
          e.preventDefault();
          const start_date = $('#pto-start').value;
          const end_date = $('#pto-end').value;
          const hours = $('#pto-hours').value;
          const reason = $('#pto-reason').value;
          const msgEl = $('#pto-msg');
          const btn = $('#pto-btn');

          if (!start_date || !end_date) {
            msgEl.innerHTML = '<div class="alert alert-error">Please select start and end dates.</div>';
            return;
          }
          if (!hours || Number(hours) <= 0) {
            msgEl.innerHTML = '<div class="alert alert-error">Please enter PTO hours.</div>';
            return;
          }

          btn.disabled = true;
          btn.textContent = 'Submitting...';

          const res = await api('POST', '/pto/submit', { start_date, end_date, reason, hours: Number(hours) });
          if (res && res.ok) {
            const path = res.data.path;
            const ptoHours = Number(hours);
            const ptoDays = ptoHours / 8;
            let info = `Your PTO request has been submitted — ${ptoHours}h (${ptoDays} day${ptoDays !== 1 ? 's' : ''}).`;
            if (path.type === 'exempt') info += ' It has been sent directly to the executive team.';
            else if (path.type === 'executive_self') info += ' It has been sent to the other executives for approval.';
            else if (path.type === 'manager_self') info += ' It has been sent to the executive team for approval.';
            else if (path.needsL1) info += ` It will require executive approval (${path.escalationReason || 'urgent'}).`;

            msgEl.innerHTML = `<div class="alert alert-success">${info}</div>`;
            e.target.reset();
            const summaryEl = $('#pto-hours-summary');
            if (summaryEl) summaryEl.style.display = 'none';
            btn.disabled = false;
            btn.textContent = 'Submit Request';
          } else {
            msgEl.innerHTML = `<div class="alert alert-error">${res?.data?.error || 'Failed'}</div>`;
            btn.disabled = false;
            btn.textContent = 'Submit Request';
          }
        },
      },
        h('div', { style: 'display:flex; gap:16px;' },
          h('div', { className: 'form-group', style: 'flex:1' },
            h('label', { for: 'pto-start' }, 'Start Date'),
            h('input', { type: 'date', id: 'pto-start', required: 'true', onInput: () => {
              autoFillHours(); updateHoursSummary();
            }}),
          ),
          h('div', { className: 'form-group', style: 'flex:1' },
            h('label', { for: 'pto-end' }, 'End Date'),
            h('input', { type: 'date', id: 'pto-end', required: 'true', onInput: () => {
              autoFillHours(); updateHoursSummary();
            }}),
          ),
        ),
        // ── Hours selector ──
        h('div', { className: 'form-group' },
          h('label', { for: 'pto-hours' }, 'PTO Hours'),
          h('div', { style: 'display:flex; gap:12px; align-items:center;' },
            h('input', {
              type: 'number', id: 'pto-hours', placeholder: 'e.g. 8', step: '1', min: '1',
              required: 'true',
              style: 'width:120px;',
              onInput: updateHoursSummary,
            }),
            h('span', { className: 'text-sm text-muted' }, '8 hours = 1 day'),
          ),
          h('div', { id: 'pto-hours-summary', className: 'hours-summary', style: 'display:none;margin-top:8px;padding:10px 14px;background:var(--primary-50,#eef2ff);border-radius:var(--radius);font-size:14px;color:var(--primary-700,#4338ca);' }),
        ),
        h('div', { className: 'form-group' },
          h('label', { for: 'pto-reason' }, 'Reason (optional)'),
          h('textarea', { id: 'pto-reason', rows: '3', placeholder: 'Brief reason for time off...' }),
        ),
        h('button', { type: 'submit', id: 'pto-btn', className: 'btn btn-primary' }, 'Submit Request'),
      ),
    );
    container.appendChild(card);
  }

  function autoFillHours() {
    const startVal = $('#pto-start')?.value;
    const endVal = $('#pto-end')?.value;
    const hoursInput = $('#pto-hours');
    if (startVal && endVal && hoursInput && !hoursInput.value) {
      const dateCount = Math.round((new Date(endVal + 'T00:00:00') - new Date(startVal + 'T00:00:00')) / 86400000) + 1;
      if (dateCount > 0) hoursInput.value = dateCount * 8;
    }
  }

  // ── My PTO Requests Tab ──
  async function renderMyPTOTab(container) {
    const res = await api('GET', '/pto/my-requests');
    if (!res || !res.ok) return;

    const requests = res.data.requests;
    const card = h('div', { className: 'card' },
      h('h2', null, 'My PTO Requests'),
    );

    if (requests.length === 0) {
      card.appendChild(h('p', { className: 'text-muted' }, 'No PTO requests yet.'));
    } else {
      const table = h('div', { className: 'table-wrap' },
        h('table', null,
          h('thead', null,
            h('tr', null,
              h('th', null, 'Dates'), h('th', null, 'Hours / Days'), h('th', null, 'Reason'), h('th', null, 'Status'), h('th', null, 'Path'), h('th', null, 'Actions'),
            ),
          ),
          h('tbody', null,
            ...requests.map((r) => {
              const dateRange = r.start_date === r.end_date
                ? formatDate(r.start_date + 'T00:00:00')
                : `${formatDate(r.start_date + 'T00:00:00')} – ${formatDate(r.end_date + 'T00:00:00')}`;

              const hoursDisplay = r.pto_hours
                ? `${r.pto_hours}h (${r.pto_days}d)`
                : '—';

              const pathLabel = {
                standard: r.needs_l1 ? 'Manager → Executive' : 'Manager Only',
                exempt: 'Direct to Executives',
                executive_self: 'Executive Self',
                manager_self: 'To Executives',
              }[r.approval_path] || r.approval_path;

              let statusDisplay;
              if (r.status === 'pending' && r.l2_status === 'approved' && r.l1_status === 'pending') {
                statusDisplay = h('span', { className: 'badge badge-escalated' }, 'Awaiting Executive');
              } else {
                statusDisplay = statusBadge(r.status);
              }

              // Can cancel/edit only if fully pending
              const canModify = r.status === 'pending' && r.l2_status !== 'approved' && r.l1_status !== 'approved';

              const actions = h('td', null);
              if (canModify) {
                actions.appendChild(h('button', {
                  className: 'btn btn-outline btn-sm',
                  onClick: async () => {
                    if (confirm('Cancel this PTO request?')) {
                      const result = await api('POST', '/pto/cancel', { request_id: r.id });
                      if (result && result.ok) switchTab('my-pto');
                      else alert(result?.data?.error || 'Failed to cancel');
                    }
                  },
                }, 'Cancel'));
              }

              return h('tr', null,
                h('td', null, dateRange),
                h('td', null, hoursDisplay),
                h('td', null, r.reason || '—'),
                h('td', null, statusDisplay),
                h('td', { className: 'text-sm text-muted' }, pathLabel),
                actions,
              );
            }),
          ),
        ),
      );
      card.appendChild(table);
    }

    container.appendChild(card);
  }

  // ── Approvals Tab ──
  async function renderApprovalsTab(container) {
    const res = await api('GET', '/pto/pending');
    if (!res || !res.ok) return;

    const requests = res.data.requests;
    const card = h('div', { className: 'card' },
      h('h2', null, 'Pending Approvals'),
    );

    if (requests.length === 0) {
      card.appendChild(h('p', { className: 'text-muted' }, 'No pending approvals.'));
    } else {
      requests.forEach((r) => {
        const dateRange = r.start_date === r.end_date
          ? formatDate(r.start_date + 'T00:00:00')
          : `${formatDate(r.start_date + 'T00:00:00')} – ${formatDate(r.end_date + 'T00:00:00')}`;

        const item = h('div', { style: 'border:1px solid var(--gray-200); border-radius:var(--radius); padding:16px; margin-bottom:12px;' },
          h('div', { className: 'flex-between' },
            h('div', null,
              h('strong', null, r.requester_name),
              h('span', { className: 'text-sm text-muted', style: 'margin-left:8px' }, r.requester_office || ''),
            ),
            h('div', { style: 'text-align:right' },
              h('span', { className: 'text-sm text-muted' }, dateRange),
              r.pto_hours ? h('div', { className: 'text-sm', style: 'color:var(--primary-600,#4f46e5);font-weight:500;' }, `${r.pto_hours}h (${r.pto_days} day${r.pto_days !== 1 ? 's' : ''})`) : null,
            ),
          ),
          r.reason ? h('p', { className: 'text-sm mt-2' }, r.reason) : null,
          r.escalation_reason ? h('p', { className: 'text-sm mt-2', style: 'color:var(--warning)' }, `Escalation: ${r.escalation_reason}`) : null,
          h('div', { className: 'flex-row mt-4' },
            h('button', {
              className: 'btn btn-success btn-sm',
              onClick: async () => {
                const result = await api('POST', '/pto/approve', { request_id: r.id });
                if (result && result.ok) {
                  switchTab('approvals');
                  loadPendingCount();
                } else {
                  alert(result?.data?.error || 'Failed to approve');
                }
              },
            }, 'Approve'),
            h('button', {
              className: 'btn btn-danger btn-sm',
              onClick: async () => {
                const reason = prompt('Reason for denial (optional):');
                if (reason === null) return; // cancelled prompt
                const result = await api('POST', '/pto/deny', { request_id: r.id, reason });
                if (result && result.ok) {
                  switchTab('approvals');
                  loadPendingCount();
                } else {
                  alert(result?.data?.error || 'Failed to deny');
                }
              },
            }, 'Deny'),
          ),
        );
        card.appendChild(item);
      });
    }

    container.appendChild(card);
  }

  // ── Reports / Calendar Tab ──
  let calendarMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
  let calendarOffice = 'all';

  async function renderReportsTab(container) {
    const res = await api('GET', `/pto/calendar?month=${calendarMonth}&office=${calendarOffice}`);
    if (!res || !res.ok) return;

    const { requests, offices, todayOut, month, year, mon } = res.data;
    const todayStr = new Date().toISOString().slice(0, 10);

    // ── "Who's Out Today" card ──
    const whoOutCard = h('div', { className: 'card who-out-card' },
      h('div', { className: 'flex-between' },
        h('h2', null, "Who's Out Today"),
        h('span', { className: 'badge ' + (todayOut.length > 0 ? 'badge-pending' : 'badge-approved') },
          todayOut.length > 0 ? `${todayOut.length} out` : 'All in'),
      ),
    );

    if (todayOut.length === 0) {
      whoOutCard.appendChild(h('p', { className: 'text-muted' }, 'No one is on PTO today.'));
    } else {
      const list = h('div', { className: 'who-out-list' });
      todayOut.forEach((p) => {
        const dates = p.start_date === p.end_date
          ? formatDate(p.start_date + 'T00:00:00')
          : `${formatDate(p.start_date + 'T00:00:00')} – ${formatDate(p.end_date + 'T00:00:00')}`;
        list.appendChild(h('div', { className: 'who-out-item' },
          h('div', { className: `office-dot office-dot-${p.requester_office}` }),
          h('strong', null, p.requester_name),
          h('span', { className: 'text-sm text-muted' }, `${p.requester_office} · ${dates}`),
        ));
      });
      whoOutCard.appendChild(list);
    }
    container.appendChild(whoOutCard);

    // ── Stats row ──
    const thisMonth = requests.length;
    const uniquePeople = new Set(requests.map((r) => r.requester_name)).size;
    const officeBreakdown = {};
    requests.forEach((r) => {
      officeBreakdown[r.requester_office] = (officeBreakdown[r.requester_office] || 0) + 1;
    });

    const statsRow = h('div', { className: 'stats-row' },
      h('div', { className: 'stat-box' },
        h('div', { className: 'stat-number' }, String(todayOut.length)),
        h('div', { className: 'stat-label' }, 'Out Today'),
      ),
      h('div', { className: 'stat-box' },
        h('div', { className: 'stat-number' }, String(thisMonth)),
        h('div', { className: 'stat-label' }, 'This Month'),
      ),
      h('div', { className: 'stat-box' },
        h('div', { className: 'stat-number' }, String(uniquePeople)),
        h('div', { className: 'stat-label' }, 'People'),
      ),
    );
    container.appendChild(statsRow);

    // ── Calendar card ──
    const calCard = h('div', { className: 'card' });

    // Header with nav and filters
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const monthLabel = `${monthNames[mon - 1]} ${year}`;

    const filterSelect = h('select', {
      onChange: (e) => { calendarOffice = e.target.value; switchTab('reports'); },
    });

    if (currentUser.level <= 1) {
      // Executives see all offices
      filterSelect.appendChild(h('option', { value: 'all', ...(calendarOffice === 'all' ? { selected: 'true' } : {}) }, 'All Offices'));
      offices.forEach((o) => {
        filterSelect.appendChild(h('option', {
          value: o.code,
          ...(calendarOffice === o.code ? { selected: 'true' } : {}),
        }, `${o.name} (${o.code})`));
      });
    }

    const headerEl = h('div', { className: 'calendar-header' },
      h('div', { className: 'calendar-nav' },
        h('button', {
          onClick: () => {
            const d = new Date(year, mon - 2, 1);
            calendarMonth = d.toISOString().slice(0, 7);
            switchTab('reports');
          },
        }, '‹'),
        h('span', { className: 'month-label' }, monthLabel),
        h('button', {
          onClick: () => {
            const d = new Date(year, mon, 1);
            calendarMonth = d.toISOString().slice(0, 7);
            switchTab('reports');
          },
        }, '›'),
        h('button', {
          className: 'btn btn-outline btn-sm',
          onClick: () => {
            calendarMonth = new Date().toISOString().slice(0, 7);
            switchTab('reports');
          },
        }, 'Today'),
      ),
      currentUser.level <= 1
        ? h('div', { className: 'calendar-filters' },
            h('span', { className: 'text-sm text-muted' }, 'Office:'),
            filterSelect,
          )
        : null,
    );
    calCard.appendChild(headerEl);

    // Day-of-week headers
    const grid = h('div', { className: 'calendar-grid' });
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach((d) => {
      grid.appendChild(h('div', { className: 'calendar-day-header' }, d));
    });

    // Build calendar days
    const firstOfMonth = new Date(year, mon - 1, 1);
    const lastOfMonth = new Date(year, mon, 0);
    const startDay = firstOfMonth.getDay(); // 0=Sun
    const daysInMonth = lastOfMonth.getDate();

    // Previous month fill
    const prevMonth = new Date(year, mon - 1, 0);
    for (let i = startDay - 1; i >= 0; i--) {
      const dayNum = prevMonth.getDate() - i;
      const cell = h('div', { className: 'calendar-day other-month' },
        h('div', { className: 'day-number' }, String(dayNum)),
      );
      grid.appendChild(cell);
    }

    // Current month
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dayOfWeek = new Date(year, mon - 1, d).getDay();
      const isToday = dateStr === todayStr;
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

      let cls = 'calendar-day';
      if (isToday) cls += ' today';
      if (isWeekend) cls += ' weekend';

      const cell = h('div', { className: cls });

      if (isToday) {
        cell.appendChild(h('div', { className: 'day-number' }, String(d)));
      } else {
        cell.appendChild(h('div', { className: 'day-number' }, String(d)));
      }

      // Find PTOs on this day
      const dayPtos = requests.filter((r) => r.start_date <= dateStr && r.end_date >= dateStr);
      dayPtos.slice(0, 3).forEach((p) => {
        const hoursLabel = p.pto_hours ? ` · ${p.pto_hours}h (${p.pto_days}d)` : '';
        const chip = h('div', {
          className: `pto-chip office-${p.requester_office}`,
          title: `${p.requester_name} (${p.requester_office})${hoursLabel} — ${p.start_date} to ${p.end_date}${p.reason ? '\n' + p.reason : ''}`,
        }, p.requester_name);
        cell.appendChild(chip);
      });

      if (dayPtos.length > 3) {
        cell.appendChild(h('div', {
          className: 'text-sm text-muted',
          style: 'font-size:10px; text-align:center;',
        }, `+${dayPtos.length - 3} more`));
      }

      grid.appendChild(cell);
    }

    // Next month fill
    const totalCells = startDay + daysInMonth;
    const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let i = 1; i <= remaining; i++) {
      const cell = h('div', { className: 'calendar-day other-month' },
        h('div', { className: 'day-number' }, String(i)),
      );
      grid.appendChild(cell);
    }

    calCard.appendChild(grid);

    // Legend
    const legendOffices = currentUser.level <= 1
      ? [
          { code: 'JT', name: 'Jenkintown' },
          { code: 'CF', name: 'Chadds Ford' },
          { code: 'ML', name: 'Mainline' },
          { code: 'CC', name: 'Center City' },
          { code: 'KOP', name: 'King of Prussia' },
          { code: 'HQ', name: 'Headquarters' },
        ]
      : [{ code: currentUser.office_code, name: currentUser.office_code }];

    const legend = h('div', { className: 'legend' });
    legendOffices.forEach((o) => {
      legend.appendChild(h('div', { className: 'legend-item' },
        h('div', { className: `legend-dot pto-chip office-${o.code}` }),
        h('span', null, o.name),
      ));
    });
    calCard.appendChild(legend);

    container.appendChild(calCard);

    // ── PTO Request List (below calendar) ──
    const ptoRes = await api('GET', '/pto/all');
    if (ptoRes && ptoRes.ok) {
      const allRequests = ptoRes.data.requests;
      if (allRequests.length > 0) {
        const listCard = h('div', { className: 'card' },
          h('h2', null, 'All PTO Requests'),
          h('div', { className: 'table-wrap' },
            h('table', null,
              h('thead', null,
                h('tr', null,
                  h('th', null, 'Employee'), h('th', null, 'Office'), h('th', null, 'Dates'), h('th', null, 'Hours / Days'), h('th', null, 'Status'), h('th', null, 'Submitted'),
                ),
              ),
              h('tbody', null,
                ...allRequests.slice(0, 50).map((r) => {
                  const dateRange = r.start_date === r.end_date
                    ? r.start_date
                    : `${r.start_date} – ${r.end_date}`;
                  const requester = r.requester_name || 'Unknown';
                  const hoursCol = r.pto_hours
                    ? `${r.pto_hours}h (${r.pto_days}d)`
                    : '—';
                  return h('tr', null,
                    h('td', null, requester),
                    h('td', null, h('span', { className: `pto-chip office-${r.requester_office || 'HQ'}`, style: 'display:inline-block' }, r.requester_office || 'HQ')),
                    h('td', null, dateRange),
                    h('td', null, hoursCol),
                    h('td', null, statusBadge(r.status)),
                    h('td', { className: 'text-sm text-muted' }, formatDate(r.created_at)),
                  );
                }),
              ),
            ),
          ),
        );
        container.appendChild(listCard);
      }
    }
  }

  // ── Auth ──
  function logout() {
    token = null;
    currentUser = null;
    localStorage.removeItem('ps_token');
    if (clockInterval) clearInterval(clockInterval);
    renderLogin();
  }

  // ── Init ──
  if (token) {
    renderApp();
  } else {
    renderLogin();
  }
})();
