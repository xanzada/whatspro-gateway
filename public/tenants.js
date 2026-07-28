(function () {
  'use strict';

  var $ = function (selector, root) { return (root || document).querySelector(selector); };
  var $$ = function (selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); };
  var viewEl = $('#view');
  var modalRoot = $('#modal-root');
  var appShell = $('#app-shell');
  var searchEl = $('#global-search');
  var report = { tenants: [], collisions: [], total: 0, ready: 0 };
  var settings = new Map();
  var statuses = new Map();
  var currentView = 'dashboard';
  var currentDetail = '';
  var searchQuery = '';
  var activeFilter = 'all';
  var defaults = { domainSuffix: '', workHours: '09:00 - 03:00' };
  var jobs = readStore('whatspro_jobs', []);
  var activity = readStore('whatspro_activity', []);
  var openMenuId = '';
  var loading = false;

  var ICONS = {
    plus: 'i-plus', store: 'i-store', power: 'i-power', plug: 'i-plug', clock: 'i-clock',
    eye: 'i-eye', edit: 'i-edit', restart: 'i-restart', link: 'i-link', qr: 'i-qr',
    trash: 'i-trash', check: 'i-check', close: 'i-close', alert: 'i-alert',
    activity: 'i-activity', arrow: 'i-arrow', back: 'i-arrow-left', refresh: 'i-refresh',
    copy: 'i-copy', spark: 'i-spark'
  };

  function icon(name) {
    return '<svg aria-hidden="true"><use href="#' + (ICONS[name] || name) + '"></use></svg>';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function attr(value) { return escapeHtml(value).replace(/`/g, '&#096;'); }

  function readStore(key, fallback) {
    try {
      var value = JSON.parse(localStorage.getItem(key) || 'null');
      return Array.isArray(value) ? value : fallback;
    } catch (error) { return fallback; }
  }

  function writeStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value.slice(0, 80))); } catch (error) { /* storage is optional */ }
  }

  function logActivity(type, title, detail, instanceId) {
    activity.unshift({
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      type: type || 'activity',
      title: title,
      detail: detail || '',
      instanceId: instanceId || '',
      time: new Date().toISOString()
    });
    writeStore('whatspro_activity', activity);
    if (currentView === 'activity') render();
  }

  function toast(title, message, bad) {
    var node = document.createElement('div');
    node.className = 'toast' + (bad ? ' bad' : '');
    node.innerHTML = '<span class="mark">' + icon(bad ? 'alert' : 'check') + '</span><div><strong>' +
      escapeHtml(title) + '</strong><span>' + escapeHtml(message || '') + '</span></div>';
    $('#toast-region').appendChild(node);
    window.setTimeout(function () {
      node.style.opacity = '0';
      node.style.transform = 'translateY(8px)';
      window.setTimeout(function () { node.remove(); }, 180);
    }, bad ? 5200 : 3000);
  }

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined
    }).then(function (response) {
      return response.text().then(function (raw) {
        var data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch (error) { data = { error: raw.slice(0, 240) }; }
        if (!response.ok) {
          var message = data.message || data.error || ('HTTP ' + response.status);
          if (response.status === 401) message = 'Your admin session has expired. Sign in again.';
          var requestError = new Error(message);
          requestError.fields = data.fields || [];
          requestError.status = response.status;
          throw requestError;
        }
        return data;
      });
    });
  }

  function initials(name) {
    var parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] || '?').slice(0, 2)).toUpperCase();
  }

  function slugify(value) {
    var translit = {
      'а':'a','ә':'a','б':'b','в':'v','г':'g','ғ':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z',
      'и':'i','й':'i','к':'k','қ':'q','л':'l','м':'m','н':'n','ң':'n','о':'o','ө':'o','п':'p',
      'р':'r','с':'s','т':'t','у':'u','ұ':'u','ү':'u','ф':'f','х':'h','һ':'h','ц':'c','ч':'ch',
      'ш':'sh','щ':'sch','ъ':'','ы':'y','і':'i','ь':'','э':'e','ю':'yu','я':'ya'
    };
    return String(value || '').toLowerCase().split('').map(function (letter) {
      return Object.prototype.hasOwnProperty.call(translit, letter) ? translit[letter] : letter;
    }).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
  }

  function formatTime(value) {
    if (!value) return '—';
    try {
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
    } catch (error) { return '—'; }
  }

  function relativeTime(value) {
    if (!value) return 'just now';
    var seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
    return Math.floor(seconds / 86400) + 'd ago';
  }

  function tenantState(tenant) {
    if (!tenant.active) return { label: 'Paused', cls: 'neutral' };
    if (tenant.summary && tenant.summary.ready) return { label: 'Connected', cls: 'success' };
    var session = (tenant.checks || []).find(function (check) { return check.id === 'whatsapp_session'; });
    if (session && String(session.code || '').indexOf('QR') >= 0) return { label: 'QR required', cls: 'warning' };
    return { label: 'Needs attention', cls: 'danger' };
  }

  function filteredTenants() {
    var query = searchQuery.trim().toLowerCase();
    return report.tenants.filter(function (tenant) {
      var state = tenantState(tenant);
      var detail = settings.get(tenant.instanceId) || {};
      var haystack = [tenant.brand, tenant.instanceId, detail.whatsappPhone, detail.domain, state.label].join(' ').toLowerCase();
      var queryMatch = !query || haystack.indexOf(query) >= 0;
      var filterMatch = activeFilter === 'all' ||
        (activeFilter === 'connected' && state.cls === 'success') ||
        (activeFilter === 'attention' && state.cls !== 'success');
      return queryMatch && filterMatch;
    });
  }

  function updateChrome() {
    $('#restaurant-count').textContent = String(report.total || 0);
    var activeJobs = jobs.filter(function (job) { return job.status === 'running'; }).length;
    var count = $('#job-count');
    count.textContent = String(activeJobs);
    count.hidden = activeJobs === 0;
    $('#last-sync').textContent = loading ? 'Synchronizing…' : 'Synced ' + relativeTime(window.__lastSync || new Date());
  }

  function pageHeader(eyebrow, title, copy, actionHtml) {
    return '<div class="page-header"><div><div class="eyebrow">' + escapeHtml(eyebrow) + '</div><h1>' +
      escapeHtml(title) + '</h1><p>' + escapeHtml(copy) + '</p></div><div class="header-actions">' +
      (actionHtml || '') + '</div></div>';
  }

  function addButton() {
    return '<button class="button primary" type="button" data-action="new">' + icon('plus') + '<span>Add restaurant</span></button>';
  }

  function statCard(label, value, copy, iconName, color) {
    return '<article class="stat-card"><span class="stat-label">' + escapeHtml(label) + '</span><span class="stat-icon ' +
      (color || '') + '">' + icon(iconName) + '</span><strong>' + escapeHtml(value) + '</strong><small>' +
      escapeHtml(copy) + '</small></article>';
  }

  function renderDashboard() {
    var connected = report.tenants.filter(function (tenant) { return tenantState(tenant).cls === 'success'; }).length;
    var active = report.tenants.filter(function (tenant) { return tenant.active; }).length;
    var running = jobs.filter(function (job) { return job.status === 'running'; }).length;
    var rows = restaurantRows(filteredTenants().slice(0, 6));
    return '<div class="page">' +
      pageHeader('Operations overview', 'Dashboard', 'Monitor every restaurant and act before service is interrupted.', addButton()) +
      collisionBanner() +
      '<section class="stats-grid">' +
        statCard('Restaurants', report.total, report.total ? 'Across this gateway' : 'Ready for your first location', 'store') +
        statCard('Active', active, active === report.total && report.total ? 'All locations enabled' : 'Currently accepting traffic', 'power') +
        statCard('Connected', connected, connected === report.total && report.total ? 'All sessions healthy' : 'WhatsApp sessions online', 'plug') +
        statCard('Running jobs', running, running ? 'Provisioning in progress' : 'No pending operations', 'clock', 'yellow') +
      '</section>' +
      '<section class="panel"><div class="panel-head"><strong>Recent restaurants</strong><span class="meta">' +
        escapeHtml(filteredTenants().length + ' shown') + '</span><span class="spacer"></span>' + addButton() +
      '</div>' + rows + '</section>' +
      '<section class="panel"><div class="panel-head"><strong>Recent activity</strong><span class="spacer"></span>' +
        '<button class="button ghost small" type="button" data-view-link="activity">View all</button></div>' +
        activityMarkup(activity.slice(0, 4), true) + '</section></div>';
  }

  function collisionBanner() {
    if (!report.collisions || !report.collisions.length) return '';
    return '<div class="error-banner">' + icon('alert') + '<div><strong>Configuration collision detected</strong><span>' +
      escapeHtml(report.collisions.map(function (entry) { return entry.detail; }).join(' · ')) +
      '</span></div></div>';
  }

  function restaurantRows(tenants) {
    if (!tenants.length) {
      return '<div class="empty-state"><div><span class="empty-icon">' + icon('store') +
        '</span><h3>No restaurants found</h3><p>Adjust the search or create a restaurant to start its WhatsApp workspace.</p></div></div>';
    }
    return '<div class="table-wrap"><table><colgroup><col style="width:25%"><col style="width:12%"><col style="width:13%"><col style="width:13%"><col style="width:25%"><col style="width:8%"><col style="width:52px"></colgroup>' +
      '<thead><tr><th>Restaurant</th><th>Instance</th><th>Phone</th><th>Status</th><th>AI prompt</th><th>Created</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>' +
      tenants.map(restaurantRow).join('') + '</tbody></table></div>';
  }

  function restaurantRow(tenant) {
    var detail = settings.get(tenant.instanceId) || {};
    var state = tenantState(tenant);
    var prompt = detail.systemPrompt || (tenant.promptMode === 'custom' ? 'Custom prompt configured' : 'Uses the shared restaurant prompt');
    var domain = detail.domain || '';
    var domainLabel = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    var menuOpen = openMenuId === tenant.instanceId;
    return '<tr data-instance="' + attr(tenant.instanceId) + '"><td><div class="restaurant-cell"><span class="restaurant-avatar">' +
      escapeHtml(initials(tenant.brand)) + '</span><span class="cell-stack"><strong>' + escapeHtml(tenant.brand || tenant.instanceId) +
      '</strong>' + (domain ? '<a href="' + attr(/^https?:/.test(domain) ? domain : 'https://' + domain) + '" target="_blank" rel="noopener">' +
      escapeHtml(domainLabel) + '</a>' : '<small>Domain not configured</small>') + '</span></div></td><td><span class="mono">' +
      escapeHtml(tenant.instanceId) + '</span></td><td><span class="mono">' + escapeHtml(detail.whatsappPhone || '—') +
      '</span></td><td><span class="badge ' + state.cls + '">' + escapeHtml(state.label) +
      '</span></td><td><div class="prompt-preview truncate">' + escapeHtml(prompt) +
      '</div></td><td><span class="cell-stack"><small>—</small></span></td><td class="action-cell">' +
      '<button class="dots-button" type="button" data-action="menu" data-instance="' + attr(tenant.instanceId) +
      '" aria-label="Restaurant actions" aria-expanded="' + String(menuOpen) + '">' + icon('i-dots') + '</button>' +
      (menuOpen ? actionMenu(tenant) : '') + '</td></tr>';
  }

  function actionMenu(tenant) {
    var id = attr(tenant.instanceId);
    return '<div class="action-menu popover" role="menu">' +
      menuButton('eye', 'View details', 'details', id) +
      menuButton('edit', 'Edit', 'edit', id) +
      '<div class="menu-rule"></div>' +
      menuButton('restart', 'Restart', 'restart', id) +
      menuButton('link', 'Reconnect', 'reconnect', id) +
      menuButton('qr', 'QR code', 'qr', id) +
      '<div class="menu-rule"></div>' +
      menuButton('trash', 'Delete', 'delete', id, 'danger') +
      '</div>';
  }

  function menuButton(iconName, label, action, instanceId, cls) {
    return '<button class="' + (cls || '') + '" type="button" role="menuitem" data-action="' + action +
      '" data-instance="' + instanceId + '">' + icon(iconName) + escapeHtml(label) + '</button>';
  }

  function renderRestaurants() {
    var tenants = filteredTenants();
    return '<div class="page">' +
      pageHeader('Restaurant network', 'Restaurants', 'Manage connected locations, prompts and WhatsApp sessions from one place.', addButton()) +
      collisionBanner() +
      '<div class="toolbar"><button class="filter ' + (activeFilter === 'all' ? 'active' : '') +
        '" type="button" data-filter="all">All</button><button class="filter" type="button" data-filter="connected">Connected</button>' +
        '<button class="filter" type="button" data-filter="attention">Needs attention</button><span class="results">' +
        escapeHtml(tenants.length + ' of ' + report.total + ' restaurants') + '</span></div>' +
      '<section class="panel">' + restaurantRows(tenants) + '</section></div>';
  }

  function renderJobs() {
    var cards = jobs.length ? jobs.map(jobMarkup).join('') :
      '<div class="empty-state"><div><span class="empty-icon">' + icon('clock') + '</span><h3>No provisioning jobs</h3>' +
      '<p>Restaurant creation and connection progress will appear here.</p></div></div>';
    return '<div class="page">' +
      pageHeader('Deployment pipeline', 'Provisioning jobs', 'Follow each restaurant from validation to a ready WhatsApp session.', addButton()) +
      '<div class="job-list">' + cards + '</div></div>';
  }

  function jobMarkup(job) {
    var cls = job.status === 'completed' ? 'success' : job.status === 'failed' ? 'danger' : 'warning';
    var label = job.status === 'completed' ? 'Completed' : job.status === 'failed' ? 'Failed' : 'In progress';
    var open = job.open ? ' open' : '';
    return '<article class="job-card' + open + '" data-job="' + attr(job.id) + '"><div class="job-main">' +
      '<span class="job-title"><strong>' + escapeHtml(job.restaurant || job.instanceId) + '</strong><small>' +
      escapeHtml(job.instanceId || 'Allocating instance') + ' · ' + escapeHtml(relativeTime(job.startedAt)) + '</small></span>' +
      '<div><div class="progress-track" style="--progress:' + Number(job.progress || 0) + '%"><i></i></div></div>' +
      '<span class="badge ' + cls + '">' + label + '</span>' +
      '<button class="button ghost small" type="button" data-action="toggle-job" data-job="' + attr(job.id) + '">Details</button></div>' +
      '<div class="job-timeline"><div><div class="timeline-list">' +
      (job.steps || []).map(function (step) {
        return '<div class="timeline-step ' + attr(step.state || '') + '"><span>' + escapeHtml(step.label) +
          '</span><time>' + escapeHtml(step.time ? relativeTime(step.time) : '') + '</time></div>';
      }).join('') + '</div></div></div></article>';
  }

  function activityMarkup(items, compact) {
    if (!items.length) {
      return '<div class="empty-state"><div><span class="empty-icon">' + icon('activity') +
        '</span><h3>No activity yet</h3><p>Actions taken in this workspace will be recorded here.</p></div></div>';
    }
    return '<div class="activity-list">' + items.map(function (item) {
      return '<div class="activity-row"><span class="activity-icon">' + icon(item.type === 'created' ? 'store' : item.type === 'failed' ? 'alert' : 'activity') +
        '</span><div><strong>' + escapeHtml(item.title) + '</strong><span>' + escapeHtml(item.detail) +
        '</span></div><time>' + escapeHtml(relativeTime(item.time)) + '</time></div>';
    }).join('') + '</div>';
  }

  function renderActivity() {
    return '<div class="page">' +
      pageHeader('Audit trail', 'Activity', 'A concise record of operator actions and gateway changes.',
        '<button class="button ghost" type="button" data-action="clear-activity">Clear activity</button>') +
      '<section class="panel"><div class="panel-head"><strong>Workspace activity</strong><span class="meta">' +
      escapeHtml(activity.length + ' events') + '</span></div>' + activityMarkup(activity) + '</section></div>';
  }

  function detailSection(id, title, subtitle, body) {
    return '<section class="detail-section" id="section-' + attr(id) + '"><div class="detail-section-head"><strong>' +
      escapeHtml(title) + '</strong><span>' + escapeHtml(subtitle || '') + '</span></div><div class="detail-body">' + body + '</div></section>';
  }

  function infoGrid(items) {
    return '<div class="info-grid">' + items.map(function (item) {
      return '<div class="info-item"><span>' + escapeHtml(item[0]) + '</span><strong title="' + attr(item[1] || '—') + '">' +
        escapeHtml(item[1] || '—') + '</strong></div>';
    }).join('') + '</div>';
  }

  function renderDetail() {
    var tenant = report.tenants.find(function (entry) { return entry.instanceId === currentDetail; });
    if (!tenant) return '<div class="page">' + pageHeader('Restaurant', 'Not found', 'This restaurant is no longer available.',
      '<button class="button" type="button" data-view-link="restaurants">' + icon('back') + 'Back</button>') + '</div>';
    var detail = settings.get(tenant.instanceId) || {};
    var status = statuses.get(tenant.instanceId) || {};
    var state = tenantState(tenant);
    var navItems = ['General', 'WhatsApp', 'Prompt', 'QR', 'Webhook', 'Redis', 'Logs', 'Activity', 'Health', 'Secrets', 'Configuration', 'Timeline'];
    var healthChecks = (tenant.checks || []).map(function (check) {
      return '<div class="health-check ' + (check.ok ? '' : 'bad') + '"><i>' + (check.ok ? '✓' : '!') +
        '</i><span>' + escapeHtml(check.column === '-' ? check.id.replace(/_/g, ' ') : check.column) + '</span><small>' +
        escapeHtml(check.ok ? 'Healthy' : check.code || 'Action required') + '</small></div>';
    }).join('');
    var qr = status.qr ? '<img src="' + attr(status.qr) + '" alt="WhatsApp connection QR code">' :
      '<div class="qr-placeholder">QR is not currently available.<br>Reconnect the instance to generate one.</div>';
    var instanceActivity = activity.filter(function (item) { return item.instanceId === tenant.instanceId; });
    var detailActivity = instanceActivity.length ? activityMarkup(instanceActivity.slice(0, 8), true) :
      '<p class="confirm-copy">No recorded operator activity for this restaurant.</p>';
    var timeline = jobs.filter(function (job) { return job.instanceId === tenant.instanceId; });
    var sections =
      detailSection('general', 'General', 'Restaurant profile', infoGrid([
        ['Restaurant', tenant.brand], ['Instance ID', tenant.instanceId], ['Domain', detail.domain],
        ['Address', detail.address], ['Working hours', detail.workHours], ['Admin phone', detail.adminPhone]
      ])) +
      detailSection('whatsapp', 'WhatsApp', 'Live session state', infoGrid([
        ['Phone', detail.whatsappPhone], ['Status', status.status || state.label],
        ['Stored session', status.hasStoredSession ? 'Available' : 'Not available'], ['WA state', status.waState || '—']
      ])) +
      detailSection('prompt', 'Prompt', detail.promptMode === 'custom' ? 'Custom restaurant prompt' : 'Shared prompt',
        '<pre class="prompt-block">' + escapeHtml(detail.systemPrompt || 'This restaurant inherits the shared WhatsPro prompt.') + '</pre>') +
      detailSection('qr', 'QR', status.status === 'qr_ready' ? 'Ready to scan' : 'Connection code',
        '<div class="qr-layout"><div class="qr-frame">' + qr + '</div><div><h3>Connect WhatsApp</h3>' +
        '<p class="confirm-copy">Open WhatsApp → Linked devices → Link a device, then scan this code. QR codes rotate automatically.</p>' +
        '<button class="button primary" type="button" data-action="reconnect" data-instance="' + attr(tenant.instanceId) + '">' +
        icon('refresh') + 'Generate / refresh QR</button></div></div>') +
      detailSection('webhook', 'Webhook', 'Generated endpoint', infoGrid([
        ['Endpoint', detail.domain ? detail.domain.replace(/\/$/, '') + '/api/whatsapp/webhook' : 'Generated by platform'],
        ['Secret', detail.secrets && detail.secrets.webhookSecret ? 'Configured' : 'Not reported']
      ])) +
      detailSection('redis', 'Redis', 'Runtime isolation',
        '<p class="confirm-copy">State is isolated under the <strong>' + escapeHtml(tenant.instanceId) +
        '</strong> namespace. Runtime values are intentionally not exposed in the browser.</p>') +
      detailSection('logs', 'Logs', 'Safe diagnostics',
        '<pre class="log-block">[' + escapeHtml(String(status.status || state.label).toUpperCase()) + '] Instance ' +
        escapeHtml(tenant.instanceId) + '\nHealth checks: ' + escapeHtml(String(tenant.summary.passed || 0)) + '/' +
        escapeHtml(String(tenant.summary.total || 0)) + ' passed\nSensitive server logs remain protected.</pre>') +
      detailSection('activity', 'Activity', 'Restaurant events', detailActivity) +
      detailSection('health', 'Health', 'Configuration checklist', '<div class="check-list">' + (healthChecks ||
        '<p class="confirm-copy">No health checks were reported.</p>') + '</div>') +
      detailSection('secrets', 'Secrets', 'Presence only', infoGrid([
        ['API token', detail.secrets && detail.secrets.apiToken ? 'Configured' : 'Not reported'],
        ['Webhook secret', detail.secrets && detail.secrets.webhookSecret ? 'Configured' : 'Not reported'],
        ['Kanban secret', detail.secrets && detail.secrets.kanbanSecret ? 'Configured' : 'Not reported']
      ])) +
      detailSection('configuration', 'Configuration', 'Runtime choices', infoGrid([
        ['Active', tenant.active ? 'Yes' : 'No'], ['Prompt mode', tenant.promptMode || 'shared'],
        ['Readiness', tenant.summary.ready ? 'Ready' : 'Needs attention'], ['Checks passed', (tenant.summary.passed || 0) + '/' + (tenant.summary.total || 0)]
      ])) +
      detailSection('timeline', 'Timeline', 'Provisioning history',
        timeline.length ? timeline.map(jobMarkup).join('') : '<p class="confirm-copy">No local provisioning timeline is available for this restaurant.</p>');
    return '<div class="page"><div class="detail-head"><button class="icon-button" type="button" data-view-link="restaurants" aria-label="Back">' +
      icon('back') + '</button><span class="restaurant-avatar">' + escapeHtml(initials(tenant.brand)) + '</span><div class="title"><h1>' +
      escapeHtml(tenant.brand) + '</h1><p>' + escapeHtml(tenant.instanceId) + ' · <span class="badge ' + state.cls + '">' +
      escapeHtml(state.label) + '</span></p></div><div class="header-actions"><button class="button" type="button" data-action="edit" data-instance="' +
      attr(tenant.instanceId) + '">' + icon('edit') + 'Edit</button><button class="button primary" type="button" data-action="reconnect" data-instance="' +
      attr(tenant.instanceId) + '">' + icon('link') + 'Reconnect</button></div></div><div class="detail-layout"><nav class="detail-nav" aria-label="Restaurant details">' +
      navItems.map(function (item, index) { return '<button class="' + (index === 0 ? 'active' : '') +
        '" type="button" data-section="' + item.toLowerCase() + '">' + item + '</button>'; }).join('') +
      '</nav><div class="detail-content">' + sections + '</div></div></div>';
  }

  function render() {
    updateChrome();
    $$('.nav-item[data-view]').forEach(function (button) {
      button.classList.toggle('active', button.dataset.view === currentView && !currentDetail);
    });
    if (currentDetail) viewEl.innerHTML = renderDetail();
    else if (currentView === 'restaurants') viewEl.innerHTML = renderRestaurants();
    else if (currentView === 'jobs') viewEl.innerHTML = renderJobs();
    else if (currentView === 'activity') viewEl.innerHTML = renderActivity();
    else viewEl.innerHTML = renderDashboard();
  }

  function loadData(silent) {
    if (loading) return Promise.resolve();
    loading = true;
    updateChrome();
    if (!silent) $('#refresh-button').classList.add('spinning');
    return Promise.all([
      api('GET', '/api/wa/tenants'),
      api('GET', '/api/wa/tenant-defaults').catch(function () { return {}; })
    ]).then(function (results) {
      report = results[0];
      defaults.domainSuffix = results[1].domainSuffix || defaults.domainSuffix;
      defaults.workHours = results[1].workHours || defaults.workHours;
      var requests = report.tenants.map(function (tenant) {
        return api('GET', '/api/wa/tenants/' + encodeURIComponent(tenant.instanceId) + '/settings')
          .then(function (data) { settings.set(tenant.instanceId, data.tenant || {}); })
          .catch(function () { settings.set(tenant.instanceId, {}); });
      });
      return Promise.all(requests);
    }).then(function () {
      window.__lastSync = new Date();
      render();
    }).catch(function (error) {
      viewEl.innerHTML = '<div class="page">' + pageHeader('Connection issue', 'Dashboard unavailable',
        'The gateway did not return restaurant data.', '<button class="button primary" type="button" data-action="refresh">' +
        icon('refresh') + 'Try again</button>') + '<div class="error-banner">' + icon('alert') +
        '<div><strong>Could not load workspace</strong><span>' + escapeHtml(error.message) + '</span></div></div></div>';
      toast('Could not refresh', error.message, true);
    }).finally(function () {
      loading = false;
      $('#refresh-button').classList.remove('spinning');
      updateChrome();
    });
  }

  function openModal(content, wide) {
    modalRoot.innerHTML = '<div class="modal-backdrop"><section class="modal' + (wide ? ' wide' : '') +
      '" role="dialog" aria-modal="true">' + content + '</section></div>';
    document.body.style.overflow = 'hidden';
    window.setTimeout(function () {
      var target = $('[autofocus]', modalRoot) || $('button, input, textarea', modalRoot);
      if (target) target.focus();
    }, 20);
  }

  function closeModal() {
    modalRoot.textContent = '';
    document.body.style.overflow = '';
  }

  function modalHeader(title, copy, closable) {
    return '<div class="modal-head"><div><h2>' + escapeHtml(title) + '</h2><p>' + escapeHtml(copy || '') +
      '</p></div>' + (closable === false ? '' : '<button class="icon-button modal-close" type="button" data-modal-close aria-label="Close">' +
      icon('close') + '</button>') + '</div>';
  }

  function field(name, label, value, placeholder, optional, full, type) {
    var tag = type === 'textarea' ? 'textarea' : 'input';
    var inputType = type && type !== 'textarea' ? type : 'text';
    return '<div class="field' + (full ? ' full' : '') + '" data-field="' + attr(name) + '"><label for="field-' +
      attr(name) + '">' + escapeHtml(label) + (optional ? ' <span class="optional">(optional)</span>' : '') +
      '</label><' + tag + (tag === 'input' ? ' type="' + attr(inputType) + '"' : '') + ' id="field-' + attr(name) +
      '" name="' + attr(name) + '" value="' + (tag === 'input' ? attr(value || '') : '') + '" placeholder="' +
      attr(placeholder || '') + '"' + (name === 'brand' ? ' autofocus' : '') + '>' +
      (tag === 'textarea' ? escapeHtml(value || '') + '</textarea>' : '') + '</div>';
  }

  function wizardSteps(step) {
    var labels = ['Name', 'Phone', 'Prompt', 'Review'];
    return '<div class="steps">' + labels.map(function (label, index) {
      var number = index + 1;
      var cls = number < step ? 'done' : number === step ? 'active' : '';
      return '<div class="step ' + cls + '"><span class="step-index">' + (number < step ? icon('check') : number) +
        '</span><span>' + label + '</span></div>';
    }).join('') + '</div>';
  }

  function openWizard(existing) {
    var data = existing ? Object.assign({}, existing) : {
      brand: '', address: '', whatsappPhone: '', workHours: defaults.workHours,
      domain: '', systemPrompt: '', promptMode: 'shared', active: true, startNow: true
    };
    var mode = existing ? 'edit' : 'create';
    var step = 1;

    function draw() {
      var body = '';
      if (step === 1) {
        body = '<div class="form-grid">' +
          field('brand', 'Restaurant name', data.brand, 'e.g. Crazy Sushi', false, true) +
          field('address', 'Address', data.address, 'e.g. Abay 12, Almaty', true, true) +
          '<div class="field full"><small>The instance ID is generated from the restaurant name. You never need to type it.</small></div></div>';
      } else if (step === 2) {
        body = '<div class="form-grid">' +
          field('whatsappPhone', 'WhatsApp number', data.whatsappPhone, '+7 700 000 00 00', true, true, 'tel') +
          field('workHours', 'Working hours', data.workHours, '09:00 - 23:00', true, false) +
          field('domain', 'Domain', data.domain, 'restaurant.example.com', true, false) +
          '<div class="field full"><small>Leave the number empty to connect later by scanning a QR code.</small></div></div>';
      } else if (step === 3) {
        body = '<div class="form-grid">' +
          field('systemPrompt', 'AI system prompt', data.systemPrompt, 'You are the restaurant assistant…', true, true, 'textarea') +
          '<div class="field full"><small>Leave empty to inherit the shared prompt used across the restaurant network.</small></div></div>';
      } else {
        var instanceId = existing ? existing.instanceId : slugify(data.brand);
        body = '<div class="review-grid">' +
          reviewRow('Name', data.brand) + reviewRow('Instance', instanceId) + reviewRow('Phone', data.whatsappPhone || 'Connect later') +
          reviewRow('Hours', data.workHours || 'Not set') + reviewRow('Domain', data.domain || 'Generated by platform') +
          reviewRow('Address', data.address || 'Not set') + reviewRow('Prompt', data.systemPrompt ? 'Custom prompt' : 'Shared prompt') +
          '</div>' + (mode === 'create' ? '<label class="checkbox"><input type="checkbox" name="startNow"' +
          (data.startNow ? ' checked' : '') + '>Start the WhatsApp instance immediately</label>' : '');
      }
      var footer = '<div class="modal-footer">' +
        (step === 1 ? '<button class="button ghost" type="button" data-modal-close>Cancel</button>' :
          '<button class="button ghost" type="button" data-wizard-back>' + icon('back') + 'Back</button>') +
        '<span class="spacer"></span><button class="button primary" type="button" data-wizard-next>' +
        (step === 4 ? (mode === 'edit' ? 'Save changes' : 'Create restaurant') : 'Continue' + icon('arrow')) + '</button></div>';
      openModal(modalHeader(mode === 'edit' ? 'Edit restaurant' : 'New restaurant',
        mode === 'edit' ? 'Update the restaurant configuration.' : 'Four short steps. Everything technical is handled for you.') +
        wizardSteps(step) + '<div class="modal-body">' + body + '</div>' + footer, false);
    }

    function collect() {
      $$('[name]', modalRoot).forEach(function (input) {
        data[input.name] = input.type === 'checkbox' ? input.checked : input.value.trim();
      });
      if (!existing && data.brand && !data.domain && defaults.domainSuffix) {
        data.domain = slugify(data.brand) + '.' + defaults.domainSuffix;
      }
      data.promptMode = data.systemPrompt ? 'custom' : 'shared';
    }

    function validate() {
      var required = step === 1 ? ['brand'] : [];
      var okay = true;
      required.forEach(function (name) {
        var input = $('[name="' + name + '"]', modalRoot);
        var wrap = input && input.closest('.field');
        var valid = Boolean(input && input.value.trim());
        if (wrap) wrap.classList.toggle('invalid', !valid);
        if (!valid) okay = false;
      });
      if (!okay) toast('Required field', 'Add the restaurant name to continue.', true);
      return okay;
    }

    function next() {
      if (!validate()) return;
      collect();
      if (step < 4) { step += 1; draw(); return; }
      if (mode === 'edit') saveExisting(data);
      else startProvisioning(data);
    }

    function back() {
      collect();
      step = Math.max(1, step - 1);
      draw();
    }

    modalRoot.onclick = function (event) {
      if (event.target.closest('[data-wizard-next]')) next();
      else if (event.target.closest('[data-wizard-back]')) back();
      else if (event.target.closest('[data-modal-close]') || event.target.classList.contains('modal-backdrop')) closeModal();
    };
    modalRoot.oninput = function (event) {
      if (event.target.name === 'brand' && !data.domain && defaults.domainSuffix) {
        data.domain = slugify(event.target.value) + '.' + defaults.domainSuffix;
      }
    };
    draw();
  }

  function reviewRow(label, value) {
    return '<div class="review-row"><span>' + escapeHtml(label) + '</span><strong title="' + attr(value) + '">' +
      escapeHtml(value || '—') + '</strong></div>';
  }

  function saveExisting(data) {
    var button = $('[data-wizard-next]', modalRoot);
    button.disabled = true;
    var payload = {
      instanceId: data.instanceId,
      brand: data.brand,
      whatsappPhone: data.whatsappPhone || '',
      domain: data.domain || '',
      address: data.address || '',
      workHours: data.workHours || '',
      adminPhone: data.adminPhone || data.whatsappPhone || '',
      promptMode: data.systemPrompt ? 'custom' : 'shared',
      systemPrompt: data.systemPrompt || '',
      active: data.active !== false
    };
    api('PATCH', '/api/wa/tenants/' + encodeURIComponent(data.instanceId), payload).then(function () {
      closeModal();
      logActivity('updated', data.brand + ' updated', 'Restaurant settings were saved.', data.instanceId);
      toast('Changes saved', data.brand + ' is up to date.');
      return loadData(true);
    }).catch(function (error) {
      button.disabled = false;
      (error.fields || []).forEach(function (name) {
        var wrap = $('[data-field="' + name + '"]', modalRoot);
        if (wrap) wrap.classList.add('invalid');
      });
      toast('Could not save', error.message, true);
    });
  }

  function startProvisioning(data) {
    var instanceId = slugify(data.brand);
    var labels = ['Validating details', 'Allocating instance ID', 'Generating secrets', 'Creating the record',
      'Verifying the record', 'Preparing Redis', 'Starting WhatsApp', 'Preparing the QR session'];
    var job = {
      id: 'job_' + Date.now(),
      restaurant: data.brand,
      instanceId: instanceId,
      status: 'running',
      progress: 0,
      startedAt: new Date().toISOString(),
      open: false,
      steps: labels.map(function (label) { return { label: label, state: 'pending', time: '' }; })
    };
    jobs.unshift(job);
    writeStore('whatspro_jobs', jobs);
    showProgress(job, data);
  }

  function showProgress(job, data) {
    function draw(result) {
      var completed = job.steps.filter(function (step) { return step.state === 'done'; }).length;
      var current = job.steps.findIndex(function (step) { return step.state === 'active'; });
      var title = job.status === 'completed' ? 'Ready' : job.status === 'failed' ? 'Provisioning failed' : 'Creating ' + data.brand;
      var footer = job.status === 'running' ? '' :
        '<div class="modal-footer"><span class="spacer"></span><button class="button primary" type="button" data-modal-close>' +
        (job.status === 'completed' ? 'Close' : 'Review details') + '</button></div>';
      var panel = job.status === 'completed' ?
        '<div class="success-panel"><span class="mark">' + icon('check') + '</span><div><strong>Restaurant is ready</strong><p>Instance ' +
        escapeHtml(job.instanceId) + ' was created. ' + (result && result.status === 'qr_ready' ? 'Scan its QR code to connect WhatsApp.' :
        'The WhatsApp session is starting.') + '</p></div></div>' :
        job.status === 'failed' ? '<div class="failure-panel"><span class="mark">' + icon('alert') +
        '</span><div><strong>Could not finish provisioning</strong><p>' + escapeHtml(job.error || 'Unknown gateway error') +
        '</p></div></div>' : '';
      openModal(modalHeader(title, job.status === 'running' ? 'You can close this window; the job remains in Provisioning jobs.' :
        'The provisioning timeline is saved in this session.', job.status !== 'running') +
        '<div class="modal-body"><div class="progress-head"><strong>' +
        escapeHtml(job.status === 'completed' ? 'Completed' : job.status === 'failed' ? 'Stopped' : labelsForProgress(current, job.steps.length)) +
        '</strong><span>' + Math.round(job.progress) + '%</span></div><div class="progress-track" style="--progress:' +
        Number(job.progress) + '%"><i></i></div><div class="provision-list">' + job.steps.map(function (step) {
          return '<div class="provision-step ' + step.state + '"><span class="mark">' +
            (step.state === 'done' ? icon('check') : step.state === 'failed' ? icon('close') : '') +
            '</span><span>' + escapeHtml(step.label) + '</span><small>' +
            (step.state === 'active' ? 'In progress' : step.state === 'done' ? 'Done' : '') + '</small></div>';
        }).join('') + '</div>' + panel + '</div>' + footer, true);
    }

    function persist() {
      job.progress = Math.round(job.steps.filter(function (step) { return step.state === 'done'; }).length / job.steps.length * 100);
      writeStore('whatspro_jobs', jobs);
      updateChrome();
    }

    function runStep(index, action) {
      if (index >= job.steps.length) return Promise.resolve({});
      job.steps[index].state = 'active';
      persist();
      draw();
      return Promise.resolve(action ? action() : delay(260 + index * 45)).then(function (result) {
        job.steps[index].state = 'done';
        job.steps[index].time = new Date().toISOString();
        persist();
        draw(result);
        return result;
      }).catch(function (error) {
        job.steps[index].state = 'failed';
        job.steps[index].time = new Date().toISOString();
        job.status = 'failed';
        job.error = error.message;
        persist();
        draw();
        logActivity('failed', data.brand + ' provisioning failed', error.message, job.instanceId);
        throw error;
      });
    }

    draw();
    runStep(0)
      .then(function () { return runStep(1); })
      .then(function () { return runStep(2); })
      .then(function () {
        return runStep(3, function () {
          var payload = {
            instanceId: job.instanceId,
            brand: data.brand,
            whatsappPhone: data.whatsappPhone || '',
            domain: data.domain || '',
            address: data.address || '',
            workHours: data.workHours || '',
            adminPhone: data.whatsappPhone || '',
            promptMode: data.systemPrompt ? 'custom' : 'shared',
            systemPrompt: data.systemPrompt || '',
            active: true
          };
          return api('POST', '/api/wa/tenants', payload).then(function (result) {
            if (result.instanceId) job.instanceId = result.instanceId;
            return result;
          });
        });
      })
      .then(function () { return runStep(4, function () { return api('GET', '/api/wa/tenants/' + encodeURIComponent(job.instanceId)); }); })
      .then(function () { return runStep(5); })
      .then(function () {
        return runStep(6, data.startNow ? function () {
          return api('POST', '/api/wa/start', { instanceId: job.instanceId, label: data.brand });
        } : function () { return Promise.resolve({ status: 'deferred' }); });
      })
      .then(function () {
        return runStep(7, data.startNow ? function () {
          return pollStatus(job.instanceId, 8);
        } : function () { return Promise.resolve({ status: 'deferred' }); });
      })
      .then(function (result) {
        job.status = 'completed';
        job.progress = 100;
        job.completedAt = new Date().toISOString();
        persist();
        draw(result);
        logActivity('created', data.brand + ' created', 'Instance ' + job.instanceId + ' completed provisioning.', job.instanceId);
        loadData(true);
      })
      .catch(function () { /* the progress dialog already shows the failure */ });
  }

  function labelsForProgress(current, total) {
    return current >= 0 ? 'Step ' + (current + 1) + ' of ' + total : 'Preparing';
  }

  function delay(ms) {
    return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
  }

  function pollStatus(instanceId, attempts) {
    return api('GET', '/api/wa/status/' + encodeURIComponent(instanceId)).then(function (status) {
      statuses.set(instanceId, status);
      if (status.status === 'qr_ready' || status.status === 'connected' || attempts <= 1) return status;
      return delay(700).then(function () { return pollStatus(instanceId, attempts - 1); });
    });
  }

  function openDelete(instanceId) {
    var tenant = report.tenants.find(function (item) { return item.instanceId === instanceId; });
    if (!tenant) return;
    openModal(modalHeader('Delete restaurant', 'This action removes the tenant record and its WhatsApp session.') +
      '<div class="modal-body"><p class="confirm-copy">Type <strong>' + escapeHtml(instanceId) +
      '</strong> to permanently delete <strong>' + escapeHtml(tenant.brand) + '</strong>.</p>' +
      '<div class="field"><label for="delete-confirm">Instance ID</label><input id="delete-confirm" name="confirm" autocomplete="off" placeholder="' +
      attr(instanceId) + '"></div></div><div class="modal-footer"><button class="button ghost" type="button" data-modal-close>Cancel</button>' +
      '<span class="spacer"></span><button class="button danger" type="button" data-delete-confirm data-instance="' +
      attr(instanceId) + '" disabled>' + icon('trash') + 'Delete permanently</button></div>');
    var input = $('[name="confirm"]', modalRoot);
    var button = $('[data-delete-confirm]', modalRoot);
    input.addEventListener('input', function () { button.disabled = input.value.trim() !== instanceId; });
  }

  function confirmDelete(instanceId) {
    var input = $('[name="confirm"]', modalRoot);
    var button = $('[data-delete-confirm]', modalRoot);
    if (!input || input.value.trim() !== instanceId) return;
    button.disabled = true;
    api('DELETE', '/api/wa/tenants/' + encodeURIComponent(instanceId), { confirm: instanceId }).then(function () {
      closeModal();
      logActivity('deleted', instanceId + ' deleted', 'Tenant and WhatsApp session were removed.', instanceId);
      toast('Restaurant deleted', instanceId + ' was removed.');
      return loadData(true);
    }).catch(function (error) {
      button.disabled = false;
      toast('Could not delete', error.message, true);
    });
  }

  function openEdit(instanceId) {
    var known = settings.get(instanceId);
    if (known && known.instanceId) { openWizard(known); return; }
    toast('Loading restaurant', 'Fetching the latest settings.');
    api('GET', '/api/wa/tenants/' + encodeURIComponent(instanceId) + '/settings').then(function (data) {
      settings.set(instanceId, data.tenant || {});
      openWizard(data.tenant);
    }).catch(function (error) { toast('Could not open editor', error.message, true); });
  }

  function runInstanceAction(instanceId, action) {
    var tenant = report.tenants.find(function (item) { return item.instanceId === instanceId; }) || { brand: instanceId };
    var request;
    var title;
    if (action === 'restart') {
      title = 'Restarting instance';
      request = api('POST', '/api/wa/restart/' + encodeURIComponent(instanceId), {});
    } else {
      title = 'Preparing connection';
      request = api('POST', '/api/wa/start', { instanceId: instanceId, label: tenant.brand });
    }
    toast(title, tenant.brand + ' will be available shortly.');
    return request.then(function () {
      logActivity('updated', tenant.brand + (action === 'restart' ? ' restarted' : ' reconnected'),
        'WhatsApp runtime action completed.', instanceId);
      return pollStatus(instanceId, 5);
    }).then(function () {
      toast(action === 'restart' ? 'Restart complete' : 'Connection prepared', tenant.brand + ' is responding.');
      if (currentDetail) render();
      else loadData(true);
    }).catch(function (error) { toast('Action failed', error.message, true); });
  }

  function openDetails(instanceId, jumpToQr) {
    currentDetail = instanceId;
    openMenuId = '';
    Promise.all([
      settings.has(instanceId) ? Promise.resolve() :
        api('GET', '/api/wa/tenants/' + encodeURIComponent(instanceId) + '/settings')
          .then(function (data) { settings.set(instanceId, data.tenant || {}); }),
      api('GET', '/api/wa/status/' + encodeURIComponent(instanceId))
        .then(function (status) { statuses.set(instanceId, status); }).catch(function () { statuses.set(instanceId, {}); })
    ]).finally(function () {
      render();
      viewEl.focus({ preventScroll: true });
      if (jumpToQr) window.setTimeout(function () {
        var section = $('#section-qr');
        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 30);
    });
    render();
  }

  function changeView(name) {
    currentDetail = '';
    currentView = name || 'dashboard';
    openMenuId = '';
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    closeMobileNav();
  }

  function closeMobileNav() {
    appShell.classList.remove('mobile-nav-open');
    $('#mobile-scrim').hidden = true;
  }

  document.addEventListener('click', function (event) {
    var nav = event.target.closest('[data-view]');
    if (nav) { changeView(nav.dataset.view); return; }
    var link = event.target.closest('[data-view-link]');
    if (link) { changeView(link.dataset.viewLink); return; }
    var action = event.target.closest('[data-action]');
    if (action) {
      var name = action.dataset.action;
      var instanceId = action.dataset.instance;
      if (name === 'new') openWizard();
      else if (name === 'refresh') loadData();
      else if (name === 'menu') {
        openMenuId = openMenuId === instanceId ? '' : instanceId;
        render();
      } else if (name === 'details') openDetails(instanceId);
      else if (name === 'qr') openDetails(instanceId, true);
      else if (name === 'edit') openEdit(instanceId);
      else if (name === 'restart' || name === 'reconnect') runInstanceAction(instanceId, name);
      else if (name === 'delete') openDelete(instanceId);
      else if (name === 'toggle-job') {
        var job = jobs.find(function (item) { return item.id === action.dataset.job; });
        if (job) { job.open = !job.open; writeStore('whatspro_jobs', jobs); render(); }
      } else if (name === 'clear-activity') {
        activity = [];
        writeStore('whatspro_activity', activity);
        render();
      }
      return;
    }
    var filter = event.target.closest('[data-filter]');
    if (filter) { activeFilter = filter.dataset.filter; render(); return; }
    var sectionButton = event.target.closest('[data-section]');
    if (sectionButton) {
      $$('.detail-nav button').forEach(function (button) { button.classList.toggle('active', button === sectionButton); });
      var section = $('#section-' + sectionButton.dataset.section);
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (!event.target.closest('.action-menu') && !event.target.closest('[data-action="menu"]') && openMenuId) {
      openMenuId = '';
      render();
    }
  });

  modalRoot.addEventListener('click', function (event) {
    if (event.target.closest('[data-modal-close]') || event.target.classList.contains('modal-backdrop')) closeModal();
    var confirm = event.target.closest('[data-delete-confirm]');
    if (confirm) confirmDelete(confirm.dataset.instance);
  });

  searchEl.addEventListener('input', function () {
    searchQuery = searchEl.value;
    if (currentDetail) return;
    if (currentView !== 'restaurants' && searchQuery) currentView = 'restaurants';
    render();
  });

  document.addEventListener('keydown', function (event) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      searchEl.focus();
    }
    if (event.key === 'Escape') {
      if (modalRoot.children.length) closeModal();
      else if (openMenuId) { openMenuId = ''; render(); }
      else closeMobileNav();
    }
  });

  $('#refresh-button').addEventListener('click', function () { loadData(); });
  $('#sidebar-toggle').addEventListener('click', function () {
    appShell.classList.toggle('collapsed');
    try { localStorage.setItem('whatspro_sidebar', appShell.classList.contains('collapsed') ? 'collapsed' : 'open'); } catch (error) { /* optional */ }
  });
  $('#mobile-menu').addEventListener('click', function () {
    appShell.classList.add('mobile-nav-open');
    $('#mobile-scrim').hidden = false;
  });
  $('#mobile-scrim').addEventListener('click', closeMobileNav);
  $('#locale-button').addEventListener('click', function () {
    var label = $('#locale-button span');
    label.textContent = label.textContent === 'EN' ? 'ҚАЗ' : 'EN';
    toast('Language preference', label.textContent === 'ҚАЗ' ? 'Қазақ тілі таңдалды.' : 'English selected.');
  });
  $('#profile-button').addEventListener('click', function () {
    var menu = $('#profile-menu');
    menu.hidden = !menu.hidden;
    $('#profile-button').setAttribute('aria-expanded', String(!menu.hidden));
  });
  $('#profile-menu').addEventListener('click', function (event) {
    var button = event.target.closest('[data-profile-action]');
    if (!button) return;
    if (button.dataset.profileAction === 'refresh') loadData();
    else if (button.dataset.profileAction === 'logout') {
      api('POST', '/api/whatspro/logout').then(function () { window.location.reload(); });
    }
  });

  try {
    if (localStorage.getItem('whatspro_sidebar') === 'collapsed') appShell.classList.add('collapsed');
  } catch (error) { /* optional */ }

  updateChrome();
  loadData();
}());
