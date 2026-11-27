/**
 * Project Sync — Single-page frontend
 * Vanilla JS, no build step required.
 */
(function () {
  'use strict';

  // ── State ──
  let token = localStorage.getItem('ps_token');
  let currentUser = null;
  let activeTab = 'home';
  let clockStatus = { clocked_in: false, current_entry: null };
  let clockInterval = null;
  let pendingCount = 0;
  let autoRefreshInterval = null;

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

  function showCommentModal(comment, employeeName) {
    // Remove any existing modal
    const existing = document.getElementById('comment-modal-overlay');
    if (existing) existing.remove();

    const overlay = h('div', {
      id: 'comment-modal-overlay',
      style: 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:9999;',
      onclick: (ev) => { if (ev.target === overlay) overlay.remove(); },
    },
      h('div', {
        style: 'background:#ffffff; border-radius:12px; padding:1.5rem; max-width:480px; width:90%; max-height:70vh; overflow-y:auto; box-shadow:0 8px 32px rgba(0,0,0,0.3); border:1px solid #e0e0e0;',
      },
        h('div', { style: 'display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;' },
          h('h3', { style: 'margin:0; font-size:1rem; color:#1a1a1a;' }, `Comment — ${employeeName}`),
          h('button', {
            style: 'background:none; border:none; font-size:1.3rem; cursor:pointer; color:#666; padding:0 0.25rem;',
            onclick: () => overlay.remove(),
          }, '✕'),
        ),
        h('p', { style: 'margin:0; color:#333; font-size:0.9rem; line-height:1.6; white-space:pre-wrap; word-break:break-word;' }, comment),
      ),
    );
    document.body.appendChild(overlay);
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

    const role = currentUser.display_role || (currentUser.level === 1 ? 'Executive' : currentUser.level === 2 ? 'Supervisor' : 'Employee');
    const menu = [
      ['home','⌂','Home'],
      ...(currentUser.level === 1 ? [] : [['clock','◷','Clock'],['flex-clock','⇄','Flex Clock In'],['pto','▦','Request PTO'],['my-pto','▤','My PTO']]),
      ...(canApprove ? [['approvals','☷',currentUser.level === 1 ? 'PTO Approvals' : 'Approvals']] : []),
      ...(currentUser.level === 1 ? [['reports','▥','Attendance']] : []),
      ...(currentUser.level !== 1 && canApprove ? [['reports','▥','Reports']] : []),
      ...(currentUser.level <= 1 ? [['logs','⊞','Logs']] : []),
      ['calendar','▦','PTO Calendar'],
    ];
    const shell = h('div', { className: 'sync-shell' });
    const sidebar = h('aside', { className: 'sync-sidebar' },
      h('div', { className: 'sync-brand' },
        h('img', { className: 'brand-logo-image', src: '/assets/visiting-angels-reference-logo.png', alt: 'Visiting Angels' }),
        h('div', { className: 'brand-divider' }),
        h('div', { className: 'brand-project' }, h('span', { className: 'brand-sync-symbol', 'aria-hidden': 'true' }, '⟳'), 'Project Sync'),
        h('div', { className: 'brand-caption' }, 'Workforce • Attendance • PTO')),
      h('nav', { className: 'sync-nav', 'aria-label': 'Main navigation' },
        ...menu.map(([id,icon,label]) => h('button', { className: `sync-nav-item${activeTab === id ? ' active' : ''}`, id: `tab-${id}`, onClick: () => switchTab(id) },
          h('span', { className: 'nav-icon', 'aria-hidden': 'true' }, icon), label,
          id === 'approvals' && pendingCount ? h('span', { className: 'count' }, String(pendingCount)) : null))),
      h('div', { className: 'sidebar-art', 'aria-hidden': 'true' }));
    const main = h('main', { className: 'sync-main' },
      h('header', { className: 'sync-header' },
        h('div', { className: 'welcome-copy' },
          h('span', { className: 'welcome-spark', 'aria-hidden': 'true' }, '✳'),
          h('h1', { id: 'welcome-heading' }, `Welcome back, ${currentUser.first_name}!`),
          h('p', { id: 'welcome-subtitle' }, role === 'Executive' ? 'Organization overview across all offices.' : role === 'Supervisor' ? "Here's your team overview." : "Here's your attendance and PTO overview.")),
        h('div', { className: 'header-right' },
          h('button', { className: 'refresh-btn', id: 'refresh-btn', title: 'Refresh data', 'aria-label': 'Refresh data', onClick: () => refreshCurrentTab() },
            h('span', { className: 'refresh-icon' }, '⟳')),
          h('div', { className: 'date-pill' }, h('span', { className: 'date-icon', 'aria-hidden': 'true' }, '▣'), new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })),
          h('div', { className: 'sync-user' },
            h('div', { className: 'user-avatar' }, (currentUser.first_name?.[0] || '') + (currentUser.last_name?.[0] || '')),
            h('div', { className: 'user-meta' }, h('strong', null, `${currentUser.first_name} ${currentUser.last_name}`), h('small', null, `${role}${currentUser.office_code ? ' – ' + currentUser.office_code : ''}`)),
            h('button', { className: 'profile-chevron', onClick: () => { const el = document.querySelector('.profile-menu'); if(el) el.hidden = !el.hidden; }, 'aria-label': 'Profile menu', 'aria-expanded': 'false' }, '⌄'),
            h('div', { className: 'profile-menu', hidden: true }, h('button', { onClick: logout }, 'Sign out'))))),
      h('div', { className: 'sync-content', id: 'tab-content' }));
    shell.append(sidebar, main);
    app.appendChild(shell);
    switchTab(activeTab);
    if (canApprove) loadPendingCount();
    startAutoRefresh();
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

  async function refreshCurrentTab() {
    const btn = document.getElementById('refresh-btn');
    if (btn) btn.classList.add('spinning');
    switchTab(activeTab);
    loadPendingCount();
    setTimeout(() => { if (btn) btn.classList.remove('spinning'); }, 600);
  }

  function startAutoRefresh() {
    if (autoRefreshInterval) clearInterval(autoRefreshInterval);
    autoRefreshInterval = setInterval(() => {
      refreshCurrentTab();
    }, 60000); // 1 minute
  }

  function switchTab(tabId) {
    if (clockInterval) { clearInterval(clockInterval); clockInterval = null; }
    if (tabId === 'approvals' && currentUser.level > 2 || tabId === 'reports' && currentUser.level > 2) tabId = 'home';
    if (tabId === 'logs' && currentUser.level > 1) tabId = 'home';
    activeTab = tabId;
    $$('.sync-nav-item').forEach((t) => t.classList.toggle('active', t.id === `tab-${tabId}`));
    const content = $('#tab-content');
    if (!content) return;
    content.innerHTML = '';
    const heading = $('#welcome-heading');
    if (heading) heading.textContent = tabId === 'home' ? `Welcome back, ${currentUser.first_name}!` : ({ clock:'Your Attendance','flex-clock':'Flex Clock In',pto:'Request Time Off','my-pto':'My PTO',approvals:'PTO Approvals',reports:'Reports',calendar:'PTO Calendar',logs:'Timecard Logs' }[tabId] || 'Project Sync');
    switch (tabId) {
      case 'home': renderHome(content); break;
      case 'clock': renderClockTab(content); break;
      case 'flex-clock': renderFlexClockTab(content); break;
      case 'pto': renderPTOTab(content); break;
      case 'my-pto': renderMyPTOTab(content); break;
      case 'approvals': renderApprovalsTab(content); break;
      case 'reports': renderReportsTab(content); break;
      case 'calendar': renderReportsTab(content); break;
      case 'logs': renderLogsTab(content); break;
    }
  }

  function syncCard(title, subtitle, className) {
    return h('section', { className: `sync-card ${className || ''}` },
      h('h2', null, title), subtitle ? h('p', { className: 'card-subtitle' }, subtitle) : null);
  }
  function syncMetric(value, label) {
    return h('div', { className: 'sync-metric' }, h('strong', null, String(value)), h('span', null, label));
  }
  function syncAction(label, target, className = '') {
    return h('button', { className: `sync-action ${className}`, onClick: () => switchTab(target) }, label + '  →');
  }
  function renderHome(container) {
    if (currentUser.level === 1) return renderExecutiveHome(container);
    if (currentUser.level === 2) return renderSupervisorHome(container);
    return renderEmployeeHome(container);
  }
  async function renderEmployeeHome(container) {
    const grid = h('div', { className: 'home-grid employee-grid' });
    const attendance = syncCard('◷  Your Attendance', 'Track your work hours for today.', 'attendance-card');
    const time = h('div', { className: 'hero-time' });
    const date = h('div', { className: 'hero-date' });
    function tick() { const now = new Date(); time.textContent = now.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit' }); date.textContent = now.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' }); }
    tick(); clockInterval = setInterval(tick, 1000);
    const status = h('div', { className: 'location-strip' }, 'Checking attendance status…');
    const action = h('button', { className: 'sync-action clock-home-button', disabled: 'true' }, 'Loading…');
    const homeComment = h('div', { className: 'comment-wrap', style: 'margin: 0.75rem 0; width: 100%; max-width: 400px;' },
      h('label', { style: 'font-size:0.8rem; color:var(--text-secondary); margin-bottom:4px; display:block;' }, 'Comment (optional)'),
      h('input', { type: 'text', id: 'home-clock-comment', placeholder: 'e.g. Working from satellite office', maxLength: '200', style: 'width:100%; padding:0.5rem 0.75rem; border:2px solid var(--border); border-radius:8px; font-size:0.9rem; background:var(--surface); color:var(--text);' }),
    );
    attendance.append(time, date, homeComment, action, status);
    const balance = syncCard('▦  My PTO Balance', null, 'balance-card');
    balance.append(h('div', { className: 'hero-balance' }, '—'), h('div', { className: 'balance-caption' }, 'Balance not available from current API'), syncAction('View My PTO', 'my-pto'));
    const upcoming = syncCard('▦  Upcoming Time Off', null, 'upcoming-card');
    upcoming.append(h('p', { className: 'text-muted' }, 'Loading requests…'));
    const activity = syncCard('⌁  Recent Activity', null, 'activity-card');
    activity.append(h('p', { className: 'text-muted' }, 'Loading activity…'));
    grid.append(attendance,balance,upcoming,activity); container.appendChild(grid);
    const [clock, requests, history] = await Promise.all([api('GET','/clock/status'), api('GET','/pto/my-requests'), api('GET','/clock/history')]);
    if (activeTab !== 'home' || !container.isConnected) return;
    if (clock?.ok) {
      clockStatus = clock.data;
      action.disabled = false;
      action.textContent = clockStatus.clocked_in ? '↪  Clock Out' : '⇥  Clock In';
      status.textContent = clockStatus.clocked_in ? `● Clocked in since ${formatTime(clockStatus.current_entry?.clock_in)}` : `${currentUser.office_code || 'Assigned office'} · GPS location captured at clock-in`;
      action.onclick = async () => {
        action.disabled = true; action.textContent = 'Checking location…';
        try {
          const location = await getLocation();
          const homeCommentInput = $('#home-clock-comment');
          if (homeCommentInput && homeCommentInput.value.trim()) {
            location.comment = homeCommentInput.value.trim();
          }
          const result = await api('POST', clockStatus.clocked_in ? '/clock/out' : '/clock/in', location);
          if (!result?.ok) throw new Error(result?.data?.error || 'Clock action failed');
          switchTab('home');
        } catch (error) { status.textContent = error.message; action.disabled = false; action.textContent = clockStatus.clocked_in ? '↪  Clock Out' : '⇥  Clock In'; }
      };
    } else { status.textContent = 'Attendance status unavailable'; action.textContent = 'Unavailable'; }
    upcoming.querySelector('p')?.remove();
    const today = [new Date().getFullYear(), String(new Date().getMonth()+1).padStart(2,'0'), String(new Date().getDate()).padStart(2,'0')].join('-');
    const next = requests?.ok ? requests.data.requests.filter(r => r.status === 'approved' && r.end_date >= today).sort((a,b) => a.start_date.localeCompare(b.start_date))[0] : null;
    if (next) upcoming.append(h('div', { className: 'upcoming-row' }, h('strong', null, `${next.start_date} – ${next.end_date}`), h('span', null, next.reason || 'Approved time off'), statusBadge('approved')));
    else upcoming.append(h('p', { className: 'text-muted' }, requests?.ok ? 'No upcoming approved time off.' : 'Unable to load time off.'));
    activity.querySelector('p')?.remove();
    if (history?.ok && history.data.entries.length) history.data.entries.slice(0,3).forEach(e => activity.append(h('div', { className: 'activity-row' }, h('span', null, e.clock_out ? '◷  Clocked out' : '◷  Clocked in'), h('small', null, formatTime(e.clock_out || e.clock_in)))));
    else activity.append(h('p', { className: 'text-muted' }, history?.ok ? 'No recent attendance activity.' : 'Activity unavailable.'));
  }
  async function renderSupervisorHome(container) {
    const grid = h('div', { className: 'home-grid supervisor-grid' });
    const team = syncCard('♙  Team Attendance', null, 'team-card');
    const approvals = syncCard('▦  Pending Approvals', null, 'approval-card');
    const overview = syncCard('▥  Team PTO Overview', null, 'overview-card');
    const recent = syncCard('⌁  Recent Team Activity', null, 'recent-card');
    [team,approvals,overview,recent].forEach(c => c.append(h('p', { className: 'text-muted' }, 'Loading…')));
    grid.append(team,approvals,overview,recent); container.appendChild(grid);
    const [entries,pending] = await Promise.all([api('GET','/clock/all'),api('GET','/pto/pending')]);
    if (activeTab !== 'home' || !container.isConnected) return;
    team.querySelector('p')?.remove(); approvals.querySelector('p')?.remove(); overview.querySelector('p')?.remove(); recent.querySelector('p')?.remove();
    if (entries?.ok) {
      const today = [new Date().getFullYear(), String(new Date().getMonth()+1).padStart(2,'0'), String(new Date().getDate()).padStart(2,'0')].join('-');
      const todayEntries = entries.data.entries.filter(e => e.clock_in?.slice(0,10) === today);
      const active = new Set(todayEntries.filter(e => !e.clock_out).map(e => e.user_id)).size;
      team.append(h('div', { className:'metric-row' }, syncMetric(active,'Currently Clocked In'),syncMetric(new Set(todayEntries.map(e=>e.user_id)).size,'Clocked In Today')));
      todayEntries.slice(0,3).forEach(e => recent.append(h('div',{className:'activity-row'}, h('span',null,e.user_name || 'Team member'),h('small',null,formatTime(e.clock_in)))));
      if (!todayEntries.length) recent.append(h('p',{className:'text-muted'},'No clock activity today.'));
    } else { team.append(h('p',null,'Attendance unavailable')); recent.append(h('p',null,'Activity unavailable')); }
    approvals.append(syncMetric(pending?.ok ? pending.data.requests.length : '—','Pending PTO Requests'),syncAction('Review All','approvals'));
    overview.append(h('p',{className:'text-muted'},'Review approved time off and team availability in reports.'),syncAction('View Reports','reports'));
  }
  async function renderExecutiveHome(container) {
    const grid = h('div', { className:'home-grid executive-grid' });
    const attendance = syncCard('▥  Organization Attendance', null, 'org-card');
    const approvals = syncCard('▦  PTO Approvals', null, 'approval-card');
    const metrics = syncCard('▥  Key Metrics', null, 'metrics-card');
    const recent = syncCard('⌁  Recent Activity', null, 'recent-card');
    [attendance,approvals,metrics,recent].forEach(c=>c.append(h('p',{className:'text-muted'},'Loading…')));
    grid.append(attendance,approvals,metrics,recent); container.appendChild(grid);
    const [users,entries,pending] = await Promise.all([api('GET','/admin/users'),api('GET','/clock/all'),api('GET','/pto/pending')]);
    if (activeTab !== 'home' || !container.isConnected) return;
    [attendance,approvals,metrics,recent].forEach(c=>c.querySelector('p')?.remove());
    if (users?.ok && entries?.ok) {
      const people = users.data.users || [];
      const today = [new Date().getFullYear(), String(new Date().getMonth()+1).padStart(2,'0'), String(new Date().getDate()).padStart(2,'0')].join('-');
      const todayEntries = entries.data.entries.filter(e=>e.clock_in?.slice(0,10)===today);
      const active = new Set(todayEntries.filter(e=>!e.clock_out).map(e=>e.user_id));
      const clockedToday = new Set(todayEntries.map(e=>e.user_id));
      const bars = h('div',{className:'office-bars'});
      [...new Set(people.map(u=>u.office_code).filter(Boolean))].sort().forEach(office=>{
        const officeUsers=people.filter(u=>u.office_code===office);
        const count=officeUsers.filter(u=>clockedToday.has(u.id)).length;
        const pct=officeUsers.length ? Math.round(count/officeUsers.length*100) : 0;
        bars.append(h('div',{className:'office-bar'},h('strong',null,`${pct}%`),h('div',{className:'bar-track'},h('div',{className:'bar-fill',style:`height:${pct}%`})),h('small',null,office)));
      });
      attendance.append(bars,syncAction('View Details','reports'));
      metrics.append(h('div',{className:'metric-row'},syncMetric(people.length,'Total Employees'),syncMetric(active.size,'Clocked In Now'),syncMetric(new Set(todayEntries.map(e=>e.user_id)).size,'Clocked In Today')));
      todayEntries.slice(0,3).forEach(e=>recent.append(h('div',{className:'activity-row'},h('span',null,e.user_name || 'Employee'),h('small',null,formatTime(e.clock_in)))));
      if (!todayEntries.length) recent.append(h('p',{className:'text-muted'},'No attendance activity today.'));
    } else { attendance.append(h('p',null,'Organization data unavailable')); metrics.append(h('p',null,'Metrics unavailable')); recent.append(h('p',null,'Activity unavailable')); }
    approvals.append(syncMetric(pending?.ok ? pending.data.requests.length : '—','Pending Requests'),syncAction('Review All','approvals'));
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

    // ── Lunch break eligibility banner ──
    let lunchBanner = null;
    if (clockStatus.clocked_in && clockStatus.current_entry) {
      const clockInTime = new Date(clockStatus.current_entry.clock_in);
      const hoursWorked = (Date.now() - clockInTime.getTime()) / 3600000;
      if (hoursWorked >= 6) {
        lunchBanner = h('div', {
          style: 'background: linear-gradient(135deg, #fef3c7, #fde68a); border: 1px solid #f59e0b; border-radius: 12px; padding: 14px 20px; margin: 12px auto; max-width: 440px; text-align: center;',
        },
          h('div', { style: 'font-size: 20px; margin-bottom: 6px;' }, '🍽️'),
          h('div', { style: 'font-weight: 600; color: #92400e; font-size: 14px;' }, "You've reached 6 hours — you're eligible for a 30-minute lunch break."),
          h('div', { style: 'font-size: 12px; color: #b45309; margin-top: 4px;' }, '30 minutes will be auto-deducted from your hours at clock-out.'),
        );
      }
    }

    // Comment field (optional)
    const commentWrap = h('div', { className: 'comment-wrap', style: 'margin: 1rem 0; width: 100%; max-width: 400px;' },
      h('label', { style: 'display:block; font-size:0.85rem; color:var(--muted); margin-bottom:0.3rem;' }, 'Comment (optional)'),
      h('input', { type: 'text', id: 'clock-comment', placeholder: 'e.g. Working from satellite office', maxLength: '200', style: 'width:100%; padding:0.5rem 0.75rem; border:2px solid var(--border); border-radius:8px; font-size:0.9rem; background:var(--surface); color:var(--text);' }),
    );

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
          const commentInput = $('#clock-comment');
          if (commentInput && commentInput.value.trim()) {
            loc.comment = commentInput.value.trim();
          }

          if (clockStatus.clocked_in) {
            // Clock out
            const result = await api('POST', '/clock/out', loc);
            if (result && result.ok) {
              // Check if flex prompt is needed
              if (result.data.flex_prompt) {
                const fp = result.data.flex_prompt;
                showFlexPromptModal(fp, loc, msgEl);
              } else {
                msgEl.innerHTML = `<div class="alert alert-success">${result.data.message}</div>`;
                setTimeout(() => switchTab('clock'), 1500);
              }
            } else {
              msgEl.innerHTML = `<div class="alert alert-error">${result?.data?.error || 'Failed'}</div>`;
              btnEl.disabled = false;
              btnEl.textContent = 'Clock Out';
            }
          } else {
            // Clock in
            const result = await api('POST', '/clock/in', loc);
            if (result && result.ok) {
              msgEl.innerHTML = `<div class="alert alert-success">${result.data.message}</div>`;
              setTimeout(() => switchTab('clock'), 1500);
            } else {
              msgEl.innerHTML = `<div class="alert alert-error">${result?.data?.error || 'Failed'}</div>`;
              btnEl.disabled = false;
              btnEl.textContent = 'Clock In';
            }
          }
        } catch (err) {
          msgEl.innerHTML = `<div class="alert alert-error">${err.message}</div>`;
          btnEl.disabled = false;
          btnEl.textContent = clockStatus.clocked_in ? 'Clock Out' : 'Clock In';
        }
      },
    }, clockStatus.clocked_in ? 'Clock Out' : 'Clock In');

    card.append(timeEl, dateEl, statusEl);
    if (lunchBanner) card.appendChild(lunchBanner);
    card.append(commentWrap, btnEl, msgEl);
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
                h('th', null, 'Date'), h('th', null, 'Location'), h('th', null, 'Clock In'), h('th', null, 'Clock Out'), h('th', null, 'Hours'), h('th', null, 'Job Code'), h('th', null, 'Break'), h('th', null, 'Comment'),
              ),
            ),
            h('tbody', null,
              ...histRes.data.entries.slice(0, 10).map((e) =>
                h('tr', null,
                  h('td', null, formatDate(e.clock_in)),
                  h('td', { style: 'font-size:0.8rem;' },
                    e.clock_in_address
                      ? h('div', null,
                          h('a', { href: (e.clock_in_lat != null && e.clock_in_lng != null) ? `https://www.google.com/maps?q=${e.clock_in_lat},${e.clock_in_lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.clock_in_address)}`, target: '_blank', rel: 'noopener noreferrer', style: 'font-weight:500; color:var(--primary); text-decoration:underline; cursor:pointer;' }, e.clock_in_address),
                          h('div', { style: 'font-size:0.75rem; color:var(--muted); margin-top:2px;' }, e.clock_in_location || '')
                        )
                      : (e.clock_in_location
                        ? h('a', { href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.clock_in_location)}`, target: '_blank', rel: 'noopener noreferrer', style: 'color:var(--primary); text-decoration:underline; cursor:pointer;' }, e.clock_in_location)
                        : '—')
                  ),
                  h('td', null, formatTime(e.clock_in)),
                  h('td', null, e.clock_out ? formatTime(e.clock_out) : h('span', { className: 'badge badge-pending' }, 'Active')),
                  h('td', null, e.clock_out ? formatDuration(e.clock_in, e.clock_out) : '—'),
                  h('td', null, h('span', { className: `badge ${e.job_code === 'PTO' ? 'badge-approved' : e.job_code === 'Holiday' ? 'badge-pending' : e.job_code === 'Flex Earned' ? 'badge-escalated' : e.job_code === 'Flex Used' ? 'badge-escalated' : ''}`, style: 'font-size:0.75rem;' }, e.job_code || 'Regular')),
                  h('td', { style: 'font-size:0.8rem;' }, e.break_length || '—'),
                  h('td', { style: 'font-size:0.8rem;' },
                    e.comment
                      ? h('button', {
                          className: 'btn btn-sm',
                          style: 'padding:0.2rem 0.6rem; font-size:0.75rem; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--primary); cursor:pointer;',
                          onclick: () => showCommentModal(e.comment, `${currentUser.first_name} ${currentUser.last_name}`),
                        }, 'View')
                      : '—'
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      container.appendChild(histCard);
    }
  }

  // ── Flex Clock Tab ──
  async function renderFlexClockTab(container) {
    // Show disclaimer modal EVERY TIME
    const overlay = h('div', {
      style: 'position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:1000; display:flex; align-items:center; justify-content:center;',
    });
    const modal = h('div', {
      style: 'background:var(--surface); border-radius:16px; padding:2rem; max-width:440px; width:90%; box-shadow:0 20px 60px rgba(0,0,0,0.3); text-align:center;',
    },
      h('div', { style: 'font-size:2rem; margin-bottom:0.75rem;' }, '⇄'),
      h('div', { style: 'font-weight:700; font-size:1.1rem; margin-bottom:1rem; color:var(--text);' }, 'Flex Clock In'),
      h('div', {
        style: 'background:linear-gradient(135deg, #fef3c7, #fde68a); border:1px solid #f59e0b; border-radius:10px; padding:1rem; margin-bottom:1.5rem;',
      },
        h('p', { style: 'color:#92400e; font-size:0.9rem; font-weight:600; margin:0;' },
          'Please only clock in to the Flex Clock In section if you intend to use these flex hours later.'),
      ),
      h('div', { style: 'font-size:0.85rem; color:var(--muted); margin-bottom:1.5rem;' },
        'Hours logged here will be banked as "Flex Earned" and can be applied when you clock out early on a regular workday.'),
      h('button', {
        className: 'btn btn-primary',
        style: 'width:100%; padding:0.75rem; font-size:1rem; font-weight:600; border-radius:10px;',
        onclick: () => {
          overlay.remove();
          renderFlexClockUI(container);
        },
      }, 'I Understand'),
    );
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  async function renderFlexClockUI(container) {
    // Check flex status (is there an open flex entry?)
    const statusRes = await api('GET', '/clock/status');
    const balRes = await api('GET', '/clock/flex-balance');
    const flexBalance = balRes?.ok ? balRes.data.balance : 0;

    // Determine if currently flex-clocked-in
    let flexClockedIn = false;
    let flexEntry = null;
    if (statusRes?.ok && statusRes.data.current_entry && statusRes.data.current_entry.job_code === 'Flex Earned') {
      flexClockedIn = true;
      flexEntry = statusRes.data.current_entry;
    }

    const card = h('div', { className: 'card clock-display' });

    // Live clock
    const timeEl = h('div', { className: 'time' }, new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    const dateEl = h('div', { className: 'date' }, new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }));

    if (clockInterval) clearInterval(clockInterval);
    clockInterval = setInterval(() => {
      timeEl.textContent = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }, 1000);

    // Flex balance display
    const balanceEl = h('div', {
      style: 'background:linear-gradient(135deg, var(--primary-light, #e0e7ff), var(--surface)); border:1px solid var(--primary); border-radius:12px; padding:14px 20px; margin:12px auto; max-width:300px; text-align:center;',
    },
      h('div', { style: 'font-size:0.8rem; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px;' }, 'Flex Balance'),
      h('div', { style: 'font-size:1.6rem; font-weight:700; color:var(--primary);' }, `${flexBalance.toFixed(2)} hrs`),
    );

    // Status
    const statusEl = h('div', {
      className: `status-badge ${flexClockedIn ? 'status-clocked-in' : 'status-clocked-out'}`,
    }, flexClockedIn ? `Flex clocked in since ${formatTime(flexEntry.clock_in)}` : 'Not flex clocked in');

    // Button
    const msgEl = h('div', { id: 'flex-msg', className: 'mt-4' });
    const btnEl = h('button', {
      className: `btn clock-btn ${flexClockedIn ? 'btn-danger' : 'btn-success'}`,
      onClick: async () => {
        btnEl.disabled = true;
        btnEl.textContent = 'Getting location...';
        msgEl.innerHTML = '';

        try {
          const loc = await getLocation();

          if (flexClockedIn) {
            const result = await api('POST', '/clock/flex-out', loc);
            if (result && result.ok) {
              msgEl.innerHTML = `<div class="alert alert-success">${result.data.message}</div>`;
              setTimeout(() => switchTab('flex-clock'), 1500);
            } else {
              msgEl.innerHTML = `<div class="alert alert-error">${result?.data?.error || 'Failed'}</div>`;
              btnEl.disabled = false;
              btnEl.textContent = 'Flex Clock Out';
            }
          } else {
            const result = await api('POST', '/clock/flex-in', loc);
            if (result && result.ok) {
              msgEl.innerHTML = `<div class="alert alert-success">${result.data.message}</div>`;
              setTimeout(() => switchTab('flex-clock'), 1500);
            } else {
              msgEl.innerHTML = `<div class="alert alert-error">${result?.data?.error || 'Failed'}</div>`;
              btnEl.disabled = false;
              btnEl.textContent = 'Flex Clock In';
            }
          }
        } catch (err) {
          msgEl.innerHTML = `<div class="alert alert-error">${err.message}</div>`;
          btnEl.disabled = false;
          btnEl.textContent = flexClockedIn ? 'Flex Clock Out' : 'Flex Clock In';
        }
      },
    }, flexClockedIn ? 'Flex Clock Out' : 'Flex Clock In');

    card.append(timeEl, dateEl, balanceEl, statusEl, btnEl, msgEl);
    container.appendChild(card);

    // Recent flex entries
    if (balRes?.ok && balRes.data.recent_entries && balRes.data.recent_entries.length > 0) {
      const histCard = h('div', { className: 'card' },
        h('h2', null, 'Recent Flex History'),
        h('div', { className: 'table-wrap' },
          h('table', null,
            h('thead', null,
              h('tr', null,
                h('th', null, 'Date'), h('th', null, 'Clock In'), h('th', null, 'Clock Out'), h('th', null, 'Hours'), h('th', null, 'Type'),
              ),
            ),
            h('tbody', null,
              ...balRes.data.recent_entries.map((e) =>
                h('tr', null,
                  h('td', null, formatDate(e.clock_in)),
                  h('td', null, formatTime(e.clock_in)),
                  h('td', null, e.clock_out ? formatTime(e.clock_out) : h('span', { className: 'badge badge-pending' }, 'Active')),
                  h('td', null, e.hours ? Number(e.hours).toFixed(2) : '—'),
                  h('td', null, h('span', { className: 'badge badge-escalated' }, e.job_code)),
                ),
              ),
            ),
          ),
        ),
      );
      container.appendChild(histCard);
    }
  }

  // ── Flex Prompt Modal (shown at regular clock-out when hours < 8) ──
  function showFlexPromptModal(fp, loc, msgEl) {
    const overlay = h('div', {
      style: 'position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:1000; display:flex; align-items:center; justify-content:center;',
    });
    const modal = h('div', {
      style: 'background:var(--surface); border-radius:16px; padding:2rem; max-width:440px; width:90%; box-shadow:0 20px 60px rgba(0,0,0,0.3); text-align:center;',
    },
      h('div', { style: 'font-size:2rem; margin-bottom:0.75rem;' }, '⏰'),
      h('div', { style: 'font-weight:700; font-size:1.1rem; margin-bottom:0.5rem; color:var(--text);' }, 'Apply Flex Hours?'),
      h('div', { style: 'font-size:0.9rem; color:var(--muted); margin-bottom:1rem;' },
        `You worked ${fp.hours_worked} hours today. You have ${fp.flex_balance} flex hours available.`),
      h('div', {
        style: 'background:linear-gradient(135deg, #e0e7ff, #c7d2fe); border:1px solid var(--primary); border-radius:10px; padding:1rem; margin-bottom:1.5rem;',
      },
        h('p', { style: 'color:var(--primary); font-size:0.95rem; font-weight:600; margin:0;' },
          `Apply ${fp.suggested_flex} flex hours to reach 8 hours?`),
      ),
      h('div', { style: 'display:flex; gap:0.75rem; justify-content:center;' },
        h('button', {
          className: 'btn btn-primary',
          style: 'flex:1; padding:0.65rem; font-weight:600; border-radius:10px;',
          onclick: async () => {
            overlay.remove();
            const result = await api('POST', '/clock/out', { ...loc, apply_flex_hours: fp.suggested_flex });
            if (result && result.ok) {
              msgEl.innerHTML = `<div class="alert alert-success">${result.data.message}<br><small>Applied ${fp.suggested_flex} flex hours</small></div>`;
              setTimeout(() => switchTab('clock'), 2000);
            } else {
              msgEl.innerHTML = `<div class="alert alert-error">${result?.data?.error || 'Failed to apply flex hours'}</div>`;
            }
          },
        }, `Yes, Apply ${fp.suggested_flex}h`),
        h('button', {
          className: 'btn btn-outline',
          style: 'flex:1; padding:0.65rem; font-weight:600; border-radius:10px;',
          onclick: () => {
            overlay.remove();
            msgEl.innerHTML = `<div class="alert alert-success">Clocked out successfully.</div>`;
            setTimeout(() => switchTab('clock'), 1500);
          },
        }, 'No Thanks'),
      ),
    );
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
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

              // Can cancel/edit if pending or approved (approved requires confirmation)
              const isActive = r.status === 'pending' || r.status === 'approved';
              const isApproved = r.status === 'approved';
              const hasPartialApproval = r.l2_status === 'approved' || r.l1_status === 'approved';

              const actions = h('td', null);
              if (isActive) {
                // Cancel button
                actions.appendChild(h('button', {
                  className: 'btn btn-outline btn-sm',
                  style: 'margin-right:6px;',
                  onClick: async (e) => {
                    const btn = e.currentTarget;
                    if (isApproved || hasPartialApproval) {
                      // First attempt without force — backend returns CONFIRM_REQUIRED
                      const check = await api('POST', '/pto/cancel', { request_id: r.id });
                      if (check?.data?.requires_confirmation) {
                        if (!confirm(check.data.message)) return;
                        // Re-submit with force_cancel
                        btn.disabled = true;
                        btn.innerHTML = '<span class="btn-spinner"></span> Cancelling…';
                        const result = await api('POST', '/pto/cancel', { request_id: r.id, force_cancel: true });
                        if (result && result.ok && result.data.status === 'cancelled') switchTab('my-pto');
                        else { btn.disabled = false; btn.textContent = 'Cancel'; alert(result?.data?.error || 'Failed to cancel'); }
                        return;
                      }
                    }
                    // Fully pending — simple confirm
                    if (confirm('Cancel this PTO request?')) {
                      btn.disabled = true;
                      btn.innerHTML = '<span class="btn-spinner"></span> Cancelling…';
                      const result = await api('POST', '/pto/cancel', { request_id: r.id });
                      if (result && result.ok) switchTab('my-pto');
                      else { btn.disabled = false; btn.textContent = 'Cancel'; alert(result?.data?.error || 'Failed to cancel'); }
                    }
                  },
                }, 'Cancel'));

                // Edit button
                actions.appendChild(h('button', {
                  className: 'btn btn-outline btn-sm',
                  onClick: async () => {
                    // Pre-fill PTO form with this request's data
                    switchTab('pto');
                    // Wait for the form to render then fill it
                    setTimeout(() => {
                      const startEl = $('#pto-start');
                      const endEl = $('#pto-end');
                      const hoursEl = $('#pto-hours');
                      const reasonEl = $('#pto-reason');
                      if (startEl) startEl.value = r.start_date;
                      if (endEl) endEl.value = r.end_date;
                      if (hoursEl) hoursEl.value = r.pto_hours || '';
                      if (reasonEl) reasonEl.value = r.reason || '';
                      updateHoursSummary();

                      // Replace form submit to call edit endpoint
                      const form = $('#pto-form');
                      if (form) {
                        const msgEl = $('#pto-msg');
                        const btn = $('#pto-btn');
                        if (btn) btn.textContent = 'Save Changes';
                        if (msgEl && (isApproved || hasPartialApproval)) {
                          msgEl.innerHTML = '<div class="alert alert-warning">⚠ Editing this approved PTO will reset it to pending and require re-approval.</div>';
                        } else if (msgEl) {
                          msgEl.innerHTML = '<div class="alert alert-info">Editing PTO request — update the fields and save.</div>';
                        }

                        form.onsubmit = async (e) => {
                          e.preventDefault();
                          const editPayload = {
                            request_id: r.id,
                            start_date: $('#pto-start').value,
                            end_date: $('#pto-end').value,
                            hours: Number($('#pto-hours').value),
                            reason: $('#pto-reason').value,
                          };

                          if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

                          // Try edit — may return CONFIRM_REQUIRED
                          let result = await api('POST', '/pto/edit', editPayload);
                          if (result?.data?.requires_confirmation) {
                            if (!confirm(result.data.message)) {
                              if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
                              return;
                            }
                            // Re-submit with force_edit
                            editPayload.force_edit = true;
                            result = await api('POST', '/pto/edit', editPayload);
                          }

                          if (result && result.ok && result.data.success) {
                            const info = result.data.was_reset
                              ? 'PTO updated and reset to pending — re-approval required.'
                              : 'PTO request updated successfully.';
                            if (msgEl) msgEl.innerHTML = `<div class="alert alert-success">${info}</div>`;
                            if (btn) { btn.disabled = false; btn.textContent = 'Submit Request'; }
                            setTimeout(() => switchTab('my-pto'), 1200);
                          } else {
                            if (msgEl) msgEl.innerHTML = `<div class="alert alert-error">${result?.data?.error || 'Failed to update'}</div>`;
                            if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
                          }
                        };
                      }
                    }, 100);
                  },
                }, 'Edit'));
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
          h('div', { className: 'flex-row mt-4 approval-actions' },
            h('button', {
              className: 'btn btn-success btn-sm',
              onClick: async (e) => {
                const btn = e.currentTarget;
                const actionsRow = btn.closest('.approval-actions');
                const denyBtn = actionsRow?.querySelector('.btn-danger');
                btn.disabled = true;
                if (denyBtn) denyBtn.disabled = true;
                btn.innerHTML = '<span class="btn-spinner"></span> Approving…';
                try {
                  const result = await api('POST', '/pto/approve', { request_id: r.id });
                  if (result && result.ok) {
                    btn.innerHTML = '✓ Approved';
                    btn.className = 'btn btn-success btn-sm btn-done';
                    if (denyBtn) denyBtn.style.display = 'none';
                    setTimeout(() => { switchTab('approvals'); loadPendingCount(); }, 800);
                  } else {
                    btn.disabled = false;
                    if (denyBtn) denyBtn.disabled = false;
                    btn.textContent = 'Approve';
                    alert(result?.data?.error || 'Failed to approve');
                  }
                } catch (err) {
                  btn.disabled = false;
                  if (denyBtn) denyBtn.disabled = false;
                  btn.textContent = 'Approve';
                  alert('Network error — please try again');
                }
              },
            }, 'Approve'),
            h('button', {
              className: 'btn btn-danger btn-sm',
              onClick: async (e) => {
                const reason = prompt('Reason for denial (optional):');
                if (reason === null) return; // cancelled prompt
                const btn = e.currentTarget;
                const actionsRow = btn.closest('.approval-actions');
                const approveBtn = actionsRow?.querySelector('.btn-success');
                btn.disabled = true;
                if (approveBtn) approveBtn.disabled = true;
                btn.innerHTML = '<span class="btn-spinner"></span> Denying…';
                try {
                  const result = await api('POST', '/pto/deny', { request_id: r.id, reason });
                  if (result && result.ok) {
                    btn.innerHTML = '✗ Denied';
                    btn.className = 'btn btn-danger btn-sm btn-done';
                    if (approveBtn) approveBtn.style.display = 'none';
                    setTimeout(() => { switchTab('approvals'); loadPendingCount(); }, 800);
                  } else {
                    btn.disabled = false;
                    if (approveBtn) approveBtn.disabled = false;
                    btn.textContent = 'Deny';
                    alert(result?.data?.error || 'Failed to deny');
                  }
                } catch (err) {
                  btn.disabled = false;
                  if (approveBtn) approveBtn.disabled = false;
                  btn.textContent = 'Deny';
                  alert('Network error — please try again');
                }
              },
            }, 'Deny'),
          ),
        );
        card.appendChild(item);
      });
    }

    container.appendChild(card);

    // Executive PTO Cancellation — L1 executives can cancel any approved PTO
    if (currentUser.level <= 1) {
      const cancelCard = h('div', { className: 'card', style: 'margin-top:16px;' },
        h('h2', null, 'Approved PTO — Executive Actions'),
        h('p', { className: 'text-sm text-muted', style: 'margin-bottom:12px;' }, 'Cancel any approved PTO request if circumstances require it.'),
      );

      const approvedRes = await api('GET', '/pto/all-approved');
      if (approvedRes?.ok && approvedRes.data.requests.length > 0) {
        approvedRes.data.requests.forEach((r) => {
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
            h('div', { className: 'flex-between', style: 'margin-top:12px;' },
              statusBadge('approved'),
              h('button', {
                className: 'btn btn-danger btn-sm',
                onClick: async (e) => {
                  const comment = prompt('Reason for cancelling this approved PTO (optional):');
                  if (comment === null) return; // cancelled prompt
                  const btn = e.currentTarget;
                  btn.disabled = true;
                  btn.innerHTML = '<span class="btn-spinner"></span> Cancelling…';
                  try {
                    const result = await api('POST', '/pto/executive-cancel', {
                      request_id: r.id,
                      cancel_comment: comment || '',
                    });
                    if (result && result.ok) {
                      btn.innerHTML = '✗ Cancelled';
                      btn.className = 'btn btn-danger btn-sm btn-done';
                      setTimeout(() => switchTab('approvals'), 800);
                    } else {
                      btn.disabled = false;
                      btn.textContent = 'Cancel PTO';
                      alert(result?.data?.error || 'Failed to cancel');
                    }
                  } catch (err) {
                    btn.disabled = false;
                    btn.textContent = 'Cancel PTO';
                    alert('Network error — please try again');
                  }
                },
              }, 'Cancel PTO'),
            ),
          );
          cancelCard.appendChild(item);
        });
      } else {
        cancelCard.appendChild(h('p', { className: 'text-muted' }, 'No approved PTO requests.'));
      }

      container.appendChild(cancelCard);
    }
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

  // ── Logs Tab (Executive Only) ──
  let logsFilters = { start_date: '', end_date: '', office: 'all', user_id: 'all', job_code: 'all' };

  async function renderLogsTab(container) {
    // Build filter bar
    const filterBar = h('div', { className: 'card', style: 'margin-bottom:16px;' },
      h('h2', null, 'Timecard Logs'),
      h('p', { className: 'text-sm text-muted', style: 'margin-bottom:12px;' }, 'View all employee timecards across offices. Columns match the Timecard spreadsheet.'),
    );

    // Fetch offices and users for filter dropdowns
    const [officeRes, userRes] = await Promise.all([api('GET', '/admin/offices'), api('GET', '/admin/users')]);
    const offices = officeRes?.ok ? officeRes.data.offices : [];
    const allUsers = userRes?.ok ? userRes.data.users : [];

    const filterRow = h('div', { style: 'display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end;' });

    // Auto-apply helper — refresh logs on any filter change
    const autoApply = () => { switchTab('logs'); };

    // Date range filters
    const startInput = h('input', {
      type: 'date', value: logsFilters.start_date,
      style: 'padding:6px 10px; border:1px solid var(--gray-300); border-radius:var(--radius); font-size:14px;',
      onChange: (e) => { logsFilters.start_date = e.target.value; autoApply(); },
    });
    const endInput = h('input', {
      type: 'date', value: logsFilters.end_date,
      style: 'padding:6px 10px; border:1px solid var(--gray-300); border-radius:var(--radius); font-size:14px;',
      onChange: (e) => { logsFilters.end_date = e.target.value; autoApply(); },
    });

    // Helper to populate employee dropdown based on selected office
    const userSelect = h('select', {
      style: 'padding:6px 10px; border:1px solid var(--gray-300); border-radius:var(--radius); font-size:14px;',
      onChange: (e) => { logsFilters.user_id = e.target.value; autoApply(); },
    });

    function populateUserSelect(officeCode) {
      userSelect.innerHTML = '';
      userSelect.appendChild(h('option', { value: 'all' }, 'All Employees'));
      let filtered = allUsers;
      if (officeCode && officeCode !== 'all') {
        filtered = allUsers.filter((u) => u.office_code === officeCode);
      }
      filtered.sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`)).forEach((u) => {
        userSelect.appendChild(h('option', { value: u.id, ...(logsFilters.user_id === u.id ? { selected: 'true' } : {}) }, `${u.first_name} ${u.last_name}`));
      });
    }

    // Office dropdown — changing office also filters the employee list
    const officeSelect = h('select', {
      style: 'padding:6px 10px; border:1px solid var(--gray-300); border-radius:var(--radius); font-size:14px;',
      onChange: (e) => {
        logsFilters.office = e.target.value;
        logsFilters.user_id = 'all'; // reset employee when office changes
        populateUserSelect(e.target.value);
        autoApply();
      },
    });
    officeSelect.appendChild(h('option', { value: 'all' }, 'All Offices'));
    offices.forEach((o) => {
      officeSelect.appendChild(h('option', { value: o.code, ...(logsFilters.office === o.code ? { selected: 'true' } : {}) }, `${o.name} (${o.code})`));
    });

    // Populate employee dropdown (filtered by current office selection)
    populateUserSelect(logsFilters.office);

    // Job Code dropdown
    const jobCodeSelect = h('select', {
      style: 'padding:6px 10px; border:1px solid var(--gray-300); border-radius:var(--radius); font-size:14px;',
      onChange: (e) => { logsFilters.job_code = e.target.value; autoApply(); },
    });
    jobCodeSelect.appendChild(h('option', { value: 'all' }, 'All Job Codes'));
    ['Regular', 'PTO', 'Holiday', 'Flex Earned', 'Flex Used'].forEach((jc) => {
      jobCodeSelect.appendChild(h('option', { value: jc, ...(logsFilters.job_code === jc ? { selected: 'true' } : {}) }, jc));
    });

    // Clear button
    const clearBtn = h('button', {
      className: 'btn btn-outline btn-sm',
      onClick: () => {
        logsFilters = { start_date: '', end_date: '', office: 'all', user_id: 'all', job_code: 'all' };
        switchTab('logs');
      },
    }, 'Clear');

    filterRow.append(
      h('div', { className: 'form-group', style: 'margin-bottom:0;' }, h('label', { style: 'font-size:12px;' }, 'Start Date'), startInput),
      h('div', { className: 'form-group', style: 'margin-bottom:0;' }, h('label', { style: 'font-size:12px;' }, 'End Date'), endInput),
      h('div', { className: 'form-group', style: 'margin-bottom:0;' }, h('label', { style: 'font-size:12px;' }, 'Office'), officeSelect),
      h('div', { className: 'form-group', style: 'margin-bottom:0;' }, h('label', { style: 'font-size:12px;' }, 'Employee'), userSelect),
      h('div', { className: 'form-group', style: 'margin-bottom:0;' }, h('label', { style: 'font-size:12px;' }, 'Job Code'), jobCodeSelect),
      h('div', { style: 'display:flex; gap:8px; padding-bottom:2px;' }, clearBtn),
    );

    filterBar.appendChild(filterRow);
    container.appendChild(filterBar);

    // Fetch logs
    const params = new URLSearchParams();
    if (logsFilters.start_date) params.set('start_date', logsFilters.start_date);
    if (logsFilters.end_date) params.set('end_date', logsFilters.end_date);
    if (logsFilters.office !== 'all') params.set('office', logsFilters.office);
    if (logsFilters.user_id !== 'all') params.set('user_id', logsFilters.user_id);
    if (logsFilters.job_code !== 'all') params.set('job_code', logsFilters.job_code);

    const qs = params.toString();
    const res = await api('GET', `/logs${qs ? '?' + qs : ''}`);
    if (!res || !res.ok) {
      container.appendChild(h('div', { className: 'card' }, h('p', { className: 'text-muted' }, 'Failed to load timecard logs.')));
      return;
    }

    const { entries, total } = res.data;

    // Results card
    const resultsCard = h('div', { className: 'card' });

    const countLabel = entries.length < total
      ? `Showing ${entries.length} of ${total} entries`
      : `${total} ${total === 1 ? 'entry' : 'entries'}`;
    resultsCard.appendChild(h('div', { className: 'flex-between', style: 'margin-bottom:12px;' },
      h('span', { className: 'text-sm text-muted' }, countLabel),
    ));

    if (entries.length === 0) {
      resultsCard.appendChild(h('p', { className: 'text-muted' }, 'No timecard entries found for the selected filters.'));
    } else {
      // Table with exact Timecard spreadsheet columns
      const table = h('div', { className: 'table-wrap' },
        h('table', null,
          h('thead', null,
            h('tr', null,
              h('th', null, 'Name'),
              h('th', null, 'Office'),
              h('th', null, 'Clock in Location'),
              h('th', null, 'Clock out Location'),
              h('th', null, 'Clock in time'),
              h('th', null, 'Clock out time'),
              h('th', null, 'Hours'),
              h('th', null, 'Job Code'),
              h('th', null, 'Break'),
              h('th', null, 'Week Total'),
              h('th', null, 'Comment'),
            ),
          ),
          h('tbody', null,
            ...entries.map((e) =>
              h('tr', null,
                h('td', null, e.name),
                h('td', null, e.office),
                h('td', { className: 'text-sm' },
                  e.clock_in_address
                    ? h('div', null,
                        h('a', { href: (e.clock_in_lat != null && e.clock_in_lng != null) ? `https://www.google.com/maps?q=${e.clock_in_lat},${e.clock_in_lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.clock_in_address)}`, target: '_blank', rel: 'noopener noreferrer', style: 'font-weight:500; color:var(--primary); text-decoration:underline; cursor:pointer;' }, e.clock_in_address),
                        h('div', { style: 'font-size:0.75rem; color:var(--muted); margin-top:2px;' }, e.clock_in_location || '')
                      )
                    : (e.clock_in_location
                      ? h('a', { href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.clock_in_location)}`, target: '_blank', rel: 'noopener noreferrer', style: 'color:var(--primary); text-decoration:underline; cursor:pointer;' }, e.clock_in_location)
                      : '—')
                ),
                h('td', { className: 'text-sm' },
                  e.clock_out_address
                    ? h('div', null,
                        h('a', { href: (e.clock_out_lat != null && e.clock_out_lng != null) ? `https://www.google.com/maps?q=${e.clock_out_lat},${e.clock_out_lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.clock_out_address)}`, target: '_blank', rel: 'noopener noreferrer', style: 'font-weight:500; color:var(--primary); text-decoration:underline; cursor:pointer;' }, e.clock_out_address),
                      )
                    : '—'
                ),
                h('td', { className: 'text-sm' }, e.clock_in_time ? (e.clock_in_time.includes('T') ? formatTime(e.clock_in_time) : e.clock_in_time) : '—'),
                h('td', { className: 'text-sm' }, e.clock_out_time ? (e.clock_out_time.includes('T') ? formatTime(e.clock_out_time) : e.clock_out_time) : '—'),
                h('td', null, e.hours || '—'),
                h('td', null,
                  h('span', {
                    className: 'badge ' + (e.job_code === 'PTO' ? 'badge-info' : e.job_code === 'Holiday' ? 'badge-holiday' : e.job_code === 'Flex Earned' ? 'badge-escalated' : e.job_code === 'Flex Used' ? 'badge-escalated' : 'badge-default'),
                  }, e.job_code),
                ),
                h('td', { className: 'text-sm' }, e.break_length || '—'),
                h('td', { className: 'text-sm', style: e.week_total ? 'font-weight:600; color:var(--primary);' : '' }, e.week_total || '—'),
                h('td', { className: 'text-sm text-muted' },
                  e.comment
                    ? h('button', {
                        className: 'btn btn-sm',
                        style: 'padding:0.2rem 0.6rem; font-size:0.75rem; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--primary); cursor:pointer;',
                        onclick: () => showCommentModal(e.comment, e.name),
                      }, 'View')
                    : '—'
                ),
              ),
            ),
          ),
        ),
      );
      resultsCard.appendChild(table);
    }

    container.appendChild(resultsCard);
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
