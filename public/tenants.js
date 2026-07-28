/* WhatsPro restaurant dashboard.
 *
 * The operator never types an instance id, never sees a token, and never talks
 * to NocoDB. Everything here speaks only to the /api/wa and /api/whatspro
 * routes that Stage 4 exposed.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ utils

  var $ = function (sel, root) { return (root || document).querySelector(sel); };

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function debounce(fn, ms) {
    var timer;
    return function () {
      var args = arguments, self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function initials(name) {
    var parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function relTime(ts) {
    var secs = Math.max(1, Math.round((Date.now() - ts) / 1000));
    if (secs < 60) return secs + 's ago';
    if (secs < 3600) return Math.round(secs / 60) + 'm ago';
    if (secs < 86400) return Math.round(secs / 3600) + 'h ago';
    return Math.round(secs / 86400) + 'd ago';
  }

  // Inline icon set, so the page needs no network font or sprite.
  var ICONS = {
    logo: '<path d="M4 7h16M4 12h16M4 17h10"/>',
    dash: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    store: '<path d="M3 9l1.5-5h15L21 9M3 9h18M3 9v10a1 1 0 001 1h16a1 1 0 001-1V9M8 20v-6h8v6"/>',
    jobs: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    refresh: '<path d="M20 12a8 8 0 10-2.3 5.7M20 6v5h-5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    dots: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>',
    trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
    power: '<path d="M12 4v8"/><path d="M7.5 7a7 7 0 109 0"/>',
    logout: '<path d="M14 4h4a1 1 0 011 1v14a1 1 0 01-1 1h-4M10 8l-4 4 4 4M6 12h11"/>',
    theme: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    warn: '<path d="M12 8v5M12 17h.01"/><path d="M10.3 3.9L2.6 17a2 2 0 001.7 3h15.4a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/>',
    ok: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    plug: '<path d="M9 3v6M15 3v6M6 9h12v3a6 6 0 01-12 0V9zM12 18v3"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7"/>'
  };

  function ico(name, cls) {
    return '<svg class="ico ' + (cls || '') + '" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  // -------------------------------------------------------------------- api

  function request(method, url, body) {
    var opts = {
      method: method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (text) {
        var data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (err) { data = { error: 'BAD_RESPONSE', message: text.slice(0, 200) }; }
        if (res.ok) return data;
        var error = new Error(data.message || data.error || ('HTTP ' + res.status));
        error.status = res.status;
        error.code = data.error || 'HTTP_' + res.status;
        error.fields = data.fields;
        throw error;
      });
    });
  }

  var api = {
    get: function (url) { return request('GET', url); },
    post: function (url, body) { return request('POST', url, body || {}); },
    del: function (url, body) { return request('DELETE', url, body || {}); }
  };

  // ------------------------------------------------------------------ state

  var state = {
    user: '',
    view: 'dashboard',
    restaurants: [],
    stats: { total: 0, active: 0, connected: 0 },
    query: '',
    sort: { key: 'brand', dir: 1 },
    loading: true,
    error: '',
    jobs: [],      // { id, label, phase, steps[], pct, failed, done, startedAt }
    activity: []   // { icon, text, ts, tone }
  };

  var ACTIVITY_KEY = 'whatspro-activity';

  function loadActivity() {
    try { state.activity = JSON.parse(localStorage.getItem(ACTIVITY_KEY) || '[]'); }
    catch (err) { state.activity = []; }
  }

  function logActivity(icon, text, tone) {
    state.activity.unshift({ icon: icon, text: text, tone: tone || '', ts: Date.now() });
    state.activity = state.activity.slice(0, 60);
    try { localStorage.setItem(ACTIVITY_KEY, JSON.stringify(state.activity)); } catch (err) { /* quota */ }
    if (state.view === 'activity' || state.view === 'dashboard') render();
  }

  // ----------------------------------------------------------------- toasts

  function toast(kind, title, message) {
    var host = $('#toasts');
    var node = document.createElement('div');
    node.className = 'toast toast-' + kind;
    node.innerHTML = ico(kind === 'ok' ? 'ok' : kind === 'err' ? 'warn' : 'info') +
      '<div class="body"><b>' + esc(title) + '</b>' + (message ? '<p>' + esc(message) + '</p>' : '') + '</div>';
    host.appendChild(node);
    setTimeout(function () {
      node.classList.add('out');
      setTimeout(function () { node.remove(); }, 220);
    }, kind === 'err' ? 7000 : 4000);
  }

  // ----------------------------------------------------------------- modals

  var openModals = [];

  /* Returns a handle so callers can patch the body without rebuilding. */
  function modal(opts) {
    var overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML =
      '<div class="modal ' + (opts.wide ? 'modal-lg' : '') + '" role="dialog" aria-modal="true">' +
        '<div class="modal-head">' +
          '<div><h2>' + esc(opts.title) + '</h2>' + (opts.subtitle ? '<p>' + esc(opts.subtitle) + '</p>' : '') + '</div>' +
          (opts.dismissable === false ? '' : '<button class="icon-btn close" type="button" aria-label="Close">' + ico('x') + '</button>') +
        '</div>' +
        '<div class="rail-slot"></div>' +
        '<div class="modal-body"></div>' +
        '<div class="modal-foot"></div>' +
      '</div>';

    var handle = {
      overlay: overlay,
      body: $('.modal-body', overlay),
      foot: $('.modal-foot', overlay),
      rail: $('.rail-slot', overlay),
      head: $('.modal-head h2', overlay),
      close: function () {
        var idx = openModals.indexOf(handle);
        if (idx >= 0) openModals.splice(idx, 1);
        overlay.remove();
        if (typeof opts.onClose === 'function') opts.onClose();
      }
    };

    if (opts.dismissable !== false) {
      $('.close', overlay).addEventListener('click', handle.close);
      overlay.addEventListener('mousedown', function (event) {
        if (event.target === overlay) handle.close();
      });
    }

    document.getElementById('modal-host').appendChild(overlay);
    openModals.push(handle);
    setTimeout(function () {
      var focusable = overlay.querySelector('input, textarea, button.btn-primary');
      if (focusable) focusable.focus();
    }, 40);
    return handle;
  }

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || !openModals.length) return;
    var top = openModals[openModals.length - 1];
    if (top.locked) return;
    top.close();
  });

  function button(label, cls, onClick) {
    var node = document.createElement('button');
    node.type = 'button';
    node.className = 'btn ' + (cls || '');
    node.innerHTML = label;
    node.addEventListener('click', onClick);
    return node;
  }

  /* Small confirm dialog. Optional typed phrase gate for destructive actions. */
  function confirmDialog(opts) {
    return new Promise(function (resolve) {
      var settled = false;
      var handle = modal({
        title: opts.title,
        subtitle: opts.subtitle,
        onClose: function () { if (!settled) { settled = true; resolve(false); } }
      });
      handle.body.innerHTML = '<p style="margin:0 0 4px;font-size:13.5px;color:var(--text-2)">' + opts.body + '</p>' +
        (opts.phrase
          ? '<div class="field" style="margin-top:16px">' +
              '<label>Type <span class="mono">' + esc(opts.phrase) + '</span> to confirm</label>' +
              '<input class="input" id="confirm-input" autocomplete="off" spellcheck="false">' +
            '</div>'
          : '');

      var go = button(opts.confirmLabel || 'Confirm', opts.danger ? 'btn-danger' : 'btn-primary', function () {
        settled = true;
        handle.close();
        resolve(true);
      });

      if (opts.phrase) {
        go.disabled = true;
        var input = $('#confirm-input', handle.body);
        input.addEventListener('input', function () { go.disabled = input.value.trim() !== opts.phrase; });
        input.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' && !go.disabled) go.click();
        });
      }

      handle.foot.appendChild(button('Cancel', 'btn-ghost', handle.close));
      handle.foot.appendChild(Object.assign(document.createElement('div'), { className: 'spacer' }));
      handle.foot.appendChild(go);
    });
  }

  // ------------------------------------------------------------ status maps

  var STATUS_META = {
    connected:        { tone: 'green',  label: 'Connected' },
    qr_ready:         { tone: 'yellow', label: 'Scan QR' },
    qr_required:      { tone: 'yellow', label: 'Scan QR' },
    starting:         { tone: 'yellow', label: 'Starting' },
    restarting:       { tone: 'yellow', label: 'Restarting' },
    restoring_session:{ tone: 'yellow', label: 'Restoring' },
    disconnected:     { tone: 'red',    label: 'Disconnected' },
    stopped:          { tone: 'gray',   label: 'Stopped' },
    not_running:      { tone: 'gray',   label: 'Not running' }
  };

  function statusBadge(row) {
    if (!row.active) return '<span class="badge badge-gray"><i class="dot"></i>Disabled</span>';
    var meta = STATUS_META[row.status] || { tone: 'gray', label: row.status || 'Unknown' };
    return '<span class="badge badge-' + meta.tone + '"><i class="dot"></i>' + esc(meta.label) + '</span>';
  }

  /* The eight backend steps collapse into the five phases the operator sees. */
  var STEP_PHASE = {
    validate: 'Preparing', allocate_id: 'Preparing', generate_secrets: 'Preparing',
    create_record: 'Creating', verify_record: 'Creating', prepare_redis: 'Creating',
    start_instance: 'Connecting', prepare_qr: 'Connecting'
  };

  var STEP_LABEL = {
    validate: 'Validating details',
    allocate_id: 'Allocating instance id',
    generate_secrets: 'Generating secrets',
    create_record: 'Creating the record',
    verify_record: 'Verifying the record',
    prepare_redis: 'Preparing Redis',
    start_instance: 'Starting WhatsApp',
    prepare_qr: 'Preparing the QR session'
  };

  var ALL_STEPS = ['validate', 'allocate_id', 'generate_secrets', 'create_record', 'verify_record', 'prepare_redis', 'start_instance', 'prepare_qr'];

  // ------------------------------------------------------------------- data

  function loadRestaurants() {
    state.loading = true;
    state.error = '';
    render();
    return api.get('/api/wa/restaurants').then(function (data) {
      state.restaurants = data.restaurants || [];
      state.stats = data.stats || { total: 0, active: 0, connected: 0 };
      state.loading = false;
      render();
    }).catch(function (error) {
      state.loading = false;
      if (error.status === 401) return showLogin();
      state.error = error.message || 'Could not load restaurants';
      render();
    });
  }

  function visibleRows() {
    var query = state.query.trim().toLowerCase();
    var rows = state.restaurants.filter(function (row) {
      if (!query) return true;
      return [row.brand, row.instanceId, row.whatsappPhone, row.domain, row.address]
        .some(function (value) { return String(value || '').toLowerCase().indexOf(query) >= 0; });
    });
    var key = state.sort.key, dir = state.sort.dir;
    return rows.sort(function (a, b) {
      var av = a[key], bv = b[key];
      if (key === 'active') { av = a.active ? 1 : 0; bv = b.active ? 1 : 0; }
      if (typeof av === 'number' || typeof bv === 'number') return (av - bv) * dir;
      return String(av || '').localeCompare(String(bv || ''), undefined, { numeric: true }) * dir;
    });
  }

  // ------------------------------------------------------------------ table

  var COLUMNS = [
    { key: 'brand', label: 'Restaurant', sortable: true },
    { key: 'instanceId', label: 'Instance', sortable: true },
    { key: 'whatsappPhone', label: 'Phone', sortable: true },
    { key: 'status', label: 'Status', sortable: true },
    { key: 'systemPrompt', label: 'AI Prompt', sortable: false },
    { key: 'created', label: 'Created', sortable: false },
    { key: 'actions', label: '', sortable: false }
  ];

  function tableHead() {
    return '<thead><tr>' + COLUMNS.map(function (col) {
      if (col.key === 'actions') return '<th class="col-actions"></th>';
      var cls = col.sortable ? 'sortable' : '';
      if (col.sortable && state.sort.key === col.key) cls += state.sort.dir === 1 ? ' sort-asc' : ' sort-desc';
      return '<th class="' + cls + '"' + (col.sortable ? ' data-sort="' + col.key + '"' : '') + '>' +
        esc(col.label) + (col.sortable ? '<span class="arrow">&#9650;</span>' : '') + '</th>';
    }).join('') + '</tr></thead>';
  }

  function skeletonRows(count) {
    var cells = '<td class="col-name"><div class="cell-name"><div class="skeleton sk-av"></div>' +
      '<div style="flex:1"><div class="skeleton sk w60"></div><div class="skeleton sk w40" style="margin-top:6px;height:9px"></div></div></div></td>' +
      '<td><div class="skeleton sk w60"></div></td>' +
      '<td><div class="skeleton sk w80"></div></td>' +
      '<td><div class="skeleton sk w60"></div></td>' +
      '<td><div class="skeleton sk w80"></div></td>' +
      '<td><div class="skeleton sk w40"></div></td>' +
      '<td class="col-actions"><div class="skeleton sk w40" style="margin-left:auto;width:28px"></div></td>';
    var out = '';
    for (var i = 0; i < count; i++) out += '<tr>' + cells + '</tr>';
    return out;
  }

  function rowHtml(row) {
    var prompt = String(row.systemPrompt || '').trim();
    return '<tr data-id="' + esc(row.instanceId) + '">' +
      '<td class="col-name" data-label="Restaurant"><div class="cell-name">' +
        '<div class="av">' + esc(initials(row.brand)) + '</div>' +
        '<div style="min-width:0"><div class="nm truncate">' + esc(row.brand || 'Untitled') + '</div>' +
        '<div class="sub truncate">' + esc(row.domain || row.workHours || 'No domain') + '</div></div>' +
      '</div></td>' +
      '<td data-label="Instance"><span class="chip-id">' + esc(row.instanceId) + '</span></td>' +
      '<td data-label="Phone" class="mono">' + esc(row.whatsappPhone || '&mdash;') + '</td>' +
      '<td data-label="Status">' + statusBadge(row) + '</td>' +
      '<td data-label="AI Prompt" class="prompt-cell">' +
        (prompt
          ? '<div class="txt">' + esc(prompt.slice(0, 130)) + (prompt.length > 130 ? '&hellip;' : '') + '</div>'
          : '<span class="badge badge-gray">Shared prompt</span>') +
      '</td>' +
      '<td data-label="Created" class="dim">&mdash;</td>' +
      '<td class="col-actions"><div class="menu-wrap">' +
        '<button class="icon-btn row-menu" type="button" aria-label="Actions">' + ico('dots') + '</button>' +
      '</div></td>' +
    '</tr>';
  }

  function emptyState() {
    if (state.query) {
      return '<div class="empty"><div class="empty-ico">' + ico('search') + '</div>' +
        '<h3>Nothing matches &ldquo;' + esc(state.query) + '&rdquo;</h3>' +
        '<p>Try a different name, instance id, phone number or domain.</p>' +
        '<button class="btn" data-act="clear-search">Clear search</button></div>';
    }
    return '<div class="empty"><div class="empty-ico">' + ico('store') + '</div>' +
      '<h3>No restaurants yet</h3>' +
      '<p>Create the first one. The instance id, secrets and WhatsApp session are all prepared automatically.</p>' +
      '<button class="btn btn-primary" data-act="create">' + ico('plus') + 'Add restaurant</button></div>';
  }

  function tableCard(rows, opts) {
    var body;
    if (state.loading) body = '<div class="table-wrap"><table class="tbl">' + tableHead() + '<tbody>' + skeletonRows(4) + '</tbody></table></div>';
    else if (!rows.length) body = emptyState();
    else body = '<div class="table-wrap"><table class="tbl">' + tableHead() + '<tbody>' + rows.map(rowHtml).join('') + '</tbody></table></div>';

    return '<div class="card table-card">' +
      '<div class="card-head"><span class="card-title">' + esc(opts.title) + '</span>' +
        '<span class="muted" style="font-size:12.5px">' + (state.loading ? '' : rows.length + ' shown') + '</span>' +
        '<span class="spacer"></span>' +
        '<button class="btn btn-primary btn-sm" data-act="create">' + ico('plus', 'ico-sm') + 'Add restaurant</button>' +
      '</div>' + body + '</div>';
  }

  // ------------------------------------------------------------------ views

  function statCard(icoName, tone, value, label) {
    return '<div class="stat-card"><div class="stat-ico" style="background:var(--' + tone + '-soft);color:var(--' + tone + ')">' +
      ico(icoName) + '</div><div><div class="stat-value">' + value + '</div><div class="stat-label">' + esc(label) + '</div></div></div>';
  }

  function viewDashboard() {
    var running = state.jobs.filter(function (job) { return !job.done; }).length;
    var rows = visibleRows();
    return '<div class="page-head"><div><h1>Dashboard</h1>' +
      '<p>Every restaurant on this gateway, and what it is doing right now.</p></div>' +
      '<div class="spacer"><button class="btn btn-primary" data-act="create">' + ico('plus') + 'Add restaurant</button></div></div>' +
      '<div class="stats">' +
        statCard('store', 'accent', state.loading ? '&mdash;' : state.stats.total, 'Restaurants') +
        statCard('power', 'green', state.loading ? '&mdash;' : state.stats.active, 'Active') +
        statCard('plug', 'accent', state.loading ? '&mdash;' : state.stats.connected, 'Connected') +
        statCard('jobs', 'amber', running, 'Running jobs') +
      '</div>' +
      tableCard(rows.slice(0, 6), { title: 'Recent restaurants' }) +
      '<div style="height:16px"></div>' +
      activityCard(6);
  }

  function viewRestaurants() {
    return '<div class="page-head"><div><h1>Restaurants</h1>' +
      '<p>Create, duplicate, enable and remove restaurants.</p></div></div>' +
      tableCard(visibleRows(), { title: 'All restaurants' });
  }

  function viewJobs() {
    var body;
    if (!state.jobs.length) {
      body = '<div class="empty"><div class="empty-ico">' + ico('jobs') + '</div><h3>No provisioning jobs</h3>' +
        '<p>Jobs appear here while a restaurant is being created, and stay for this browser session.</p></div>';
    } else {
      body = state.jobs.map(function (job) {
        var tone = job.failed ? 'failed' : job.done ? 'done' : '';
        var badge = job.failed ? '<span class="badge badge-red"><i class="dot"></i>Failed</span>'
          : job.done ? '<span class="badge badge-green"><i class="dot"></i>Completed</span>'
          : '<span class="badge badge-yellow"><i class="dot"></i>' + esc(job.phase) + '</span>';
        return '<div class="job-row"><div class="grow">' +
          '<div class="nm">' + esc(job.label) + '</div>' +
          '<div class="mini-track"><div class="mini-fill ' + tone + '" style="width:' + job.pct + '%"></div></div>' +
          '</div>' + badge +
          '<button class="btn btn-sm" data-job="' + esc(job.id) + '">Details</button></div>';
      }).join('');
    }
    return '<div class="page-head"><div><h1>Provisioning jobs</h1>' +
      '<p>Live progress for every restaurant created in this session.</p></div></div>' +
      '<div class="card">' + body + '</div>';
  }

  function activityCard(limit) {
    var items = state.activity.slice(0, limit || 40);
    var body = items.length
      ? items.map(function (item) {
          return '<div class="act-row"><div class="act-ico">' + ico(item.icon || 'info', 'ico-sm') + '</div>' +
            '<div class="grow">' + esc(item.text) + '</div>' +
            '<div class="when">' + esc(relTime(item.ts)) + '</div></div>';
        }).join('')
      : '<div class="empty" style="padding:36px 20px"><div class="empty-ico">' + ico('activity') + '</div>' +
        '<h3>No activity yet</h3><p>Actions you take in this dashboard are recorded here.</p></div>';
    return '<div class="card"><div class="card-head"><span class="card-title">Activity</span></div>' + body + '</div>';
  }

  function viewActivity() {
    return '<div class="page-head"><div><h1>Activity</h1>' +
      '<p>A local record of what was done from this browser.</p></div>' +
      '<div class="spacer"><button class="btn btn-ghost" data-act="clear-activity">Clear</button></div></div>' +
      activityCard(40);
  }

  var VIEWS = { dashboard: viewDashboard, restaurants: viewRestaurants, jobs: viewJobs, activity: viewActivity };

  function render() {
    var host = $('#content');
    if (!host) return;
    var banner = state.error
      ? '<div class="banner">' + ico('warn') + '<div><b>Something went wrong</b><p>' + esc(state.error) + '</p></div>' +
        '<button class="icon-btn close btn-ghost" data-act="retry" title="Retry">' + ico('refresh') + '</button></div>'
      : '';
    host.innerHTML = banner + (VIEWS[state.view] || viewDashboard)();

    // Sidebar highlight and counters.
    Array.prototype.forEach.call(document.querySelectorAll('.side-link[data-view]'), function (link) {
      link.classList.toggle('is-active', link.getAttribute('data-view') === state.view);
    });
    var countNode = $('#count-restaurants');
    if (countNode) countNode.textContent = state.loading ? '' : String(state.restaurants.length);
    var jobsCount = $('#count-jobs');
    var running = state.jobs.filter(function (job) { return !job.done; }).length;
    if (jobsCount) jobsCount.textContent = state.jobs.length ? String(state.jobs.length) : '';

    var pill = $('#jobs-pill');
    pill.classList.toggle('is-hidden', running === 0);
    $('#jobs-pill-text').textContent = running + (running === 1 ? ' job running' : ' jobs running');
  }

  // -------------------------------------------------------- create wizard

  var WIZARD_STEPS = ['Name', 'Phone', 'Prompt', 'Review'];

  function railHtml(current) {
    var out = '<div class="wz-rail">';
    WIZARD_STEPS.forEach(function (label, index) {
      var cls = index < current ? 'done' : index === current ? 'now' : '';
      out += '<div class="wz-node ' + cls + '"><div class="wz-dot">' +
        (index < current ? '&#10003;' : index + 1) + '</div><span class="lbl">' + esc(label) + '</span></div>';
      if (index < WIZARD_STEPS.length - 1) out += '<div class="wz-bar ' + (index < current ? 'filled' : '') + '"></div>';
    });
    return out + '</div>';
  }

  function field(id, label, hint, html) {
    return '<div class="field" data-field="' + id + '">' +
      '<label for="wz-' + id + '">' + esc(label) + '</label>' + html +
      '<div class="err-text"></div>' +
      (hint ? '<div class="hint">' + hint + '</div>' : '') + '</div>';
  }

  function openWizard() {
    var draft = { brand: '', whatsappPhone: '', workHours: '', domain: '', address: '', systemPrompt: '', active: true };
    var step = 0;

    var handle = modal({ title: 'New restaurant', subtitle: 'Four short steps. Everything technical is handled for you.' });

    function setError(id, message) {
      var node = handle.body.querySelector('[data-field="' + id + '"]');
      if (!node) return;
      node.classList.toggle('invalid', Boolean(message));
      if (message) $('.err-text', node).textContent = message;
    }

    function collect() {
      ['brand', 'whatsappPhone', 'workHours', 'domain', 'address', 'systemPrompt'].forEach(function (key) {
        var input = handle.body.querySelector('#wz-' + key);
        if (input) draft[key] = input.value;
      });
      var activeBox = handle.body.querySelector('#wz-active');
      if (activeBox) draft.active = activeBox.checked;
    }

    // Only the rules the backend also enforces, so the two never disagree.
    function validate() {
      collect();
      if (step === 0) {
        if (!draft.brand.trim()) { setError('brand', 'Restaurant name is required'); return false; }
        if (draft.brand.trim().length > 120) { setError('brand', 'Restaurant name is too long'); return false; }
        setError('brand', '');
      }
      if (step === 1) {
        var digits = draft.whatsappPhone.replace(/\D/g, '');
        if (draft.whatsappPhone.trim() && (digits.length < 10 || digits.length > 15)) {
          setError('whatsappPhone', 'Enter a valid phone number, or leave it empty');
          return false;
        }
        setError('whatsappPhone', '');
        if (draft.workHours.trim() && !/^([01]\d|2[0-3]):[0-5]\d - ([01]\d|2[0-3]):[0-5]\d$/.test(draft.workHours.trim())) {
          setError('workHours', 'Use the format 09:00 - 23:00');
          return false;
        }
        setError('workHours', '');
      }
      return true;
    }

    function paint() {
      handle.rail.innerHTML = railHtml(step);

      if (step === 0) {
        handle.body.innerHTML =
          field('brand', 'Restaurant name', 'The instance id is generated from this name. You never type it.',
            '<input class="input" id="wz-brand" placeholder="Crazy Sushi" autocomplete="off" value="' + esc(draft.brand) + '">') +
          field('address', 'Address <span class="dim">(optional)</span>', '',
            '<input class="input" id="wz-address" placeholder="Abay 12, Almaty" autocomplete="off" value="' + esc(draft.address) + '">');
      } else if (step === 1) {
        handle.body.innerHTML =
          field('whatsappPhone', 'WhatsApp number <span class="dim">(optional)</span>',
            'Leave empty to attach the number later by scanning a QR code.',
            '<input class="input" id="wz-whatsappPhone" placeholder="+7 700 000 00 00" inputmode="tel" value="' + esc(draft.whatsappPhone) + '">') +
          field('workHours', 'Working hours <span class="dim">(optional)</span>', 'Format: 09:00 - 23:00',
            '<input class="input" id="wz-workHours" placeholder="09:00 - 23:00" autocomplete="off" value="' + esc(draft.workHours) + '">') +
          field('domain', 'Domain <span class="dim">(optional)</span>', 'Generated from the name when left empty.',
            '<input class="input" id="wz-domain" placeholder="crazy-sushi.bekaba.com" autocomplete="off" value="' + esc(draft.domain) + '">');
      } else if (step === 2) {
        handle.body.innerHTML =
          field('systemPrompt', 'AI system prompt <span class="dim">(optional)</span>',
            'Leave empty to use the shared prompt that all restaurants inherit.',
            '<textarea class="input" id="wz-systemPrompt" placeholder="You are the assistant for...">' + esc(draft.systemPrompt) + '</textarea>');
      } else {
        handle.body.innerHTML =
          '<dl class="kv">' +
            '<dt>Name</dt><dd>' + esc(draft.brand) + '</dd>' +
            '<dt>Phone</dt><dd>' + (draft.whatsappPhone ? esc(draft.whatsappPhone) : '<span class="dim">attach later by QR</span>') + '</dd>' +
            '<dt>Hours</dt><dd>' + (draft.workHours ? esc(draft.workHours) : '<span class="dim">default</span>') + '</dd>' +
            '<dt>Domain</dt><dd>' + (draft.domain ? esc(draft.domain) : '<span class="dim">generated</span>') + '</dd>' +
            '<dt>Address</dt><dd>' + (draft.address ? esc(draft.address) : '<span class="dim">none</span>') + '</dd>' +
            '<dt>Prompt</dt><dd>' + (draft.systemPrompt.trim() ? esc(draft.systemPrompt.trim().slice(0, 180)) + (draft.systemPrompt.length > 180 ? '…' : '') : '<span class="dim">shared prompt</span>') + '</dd>' +
          '</dl>' +
          '<label class="field" style="display:flex;gap:9px;align-items:center;margin-top:18px">' +
            '<input type="checkbox" id="wz-active" ' + (draft.active ? 'checked' : '') + '>' +
            '<span style="font-size:13.5px">Start the WhatsApp instance immediately</span>' +
          '</label>';
      }

      handle.foot.innerHTML = '';
      handle.foot.appendChild(button(step === 0 ? 'Cancel' : 'Back', 'btn-ghost', function () {
        if (step === 0) return handle.close();
        collect();
        step--;
        paint();
      }));
      handle.foot.appendChild(Object.assign(document.createElement('div'), { className: 'spacer' }));
      handle.foot.appendChild(button(step === 3 ? 'Create restaurant' : 'Continue', 'btn-primary', function () {
        if (!validate()) return;
        if (step < 3) { step++; return paint(); }
        submit();
      }));

      handle.body.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && event.target.tagName !== 'TEXTAREA') {
          event.preventDefault();
          handle.foot.querySelector('.btn-primary').click();
        }
      });
    }

    function submit() {
      collect();
      var payload = {
        brand: draft.brand.trim(),
        whatsappPhone: draft.whatsappPhone.trim(),
        workHours: draft.workHours.trim(),
        domain: draft.domain.trim(),
        address: draft.address.trim(),
        systemPrompt: draft.systemPrompt,
        active: draft.active
      };
      var go = handle.foot.querySelector('.btn-primary');
      go.disabled = true;
      go.textContent = 'Creating…';

      api.post('/api/wa/restaurants', payload).then(function (data) {
        handle.close();
        trackJob(data.jobId, payload.brand);
      }).catch(function (error) {
        go.disabled = false;
        go.textContent = 'Create restaurant';
        if (error.fields && typeof error.fields === 'object') {
          // Jump back to the step that owns the first rejected field.
          var first = Object.keys(error.fields)[0];
          var owner = { brand: 0, address: 0, whatsappPhone: 1, workHours: 1, domain: 1, systemPrompt: 2 }[first];
          if (owner !== undefined) {
            step = owner;
            paint();
            setError(first, error.fields[first]);
          }
        }
        toast('err', 'Could not create the restaurant', error.message);
      });
    }

    paint();
  }

  // -------------------------------------------------------- provision job

  function phaseOf(job) {
    if (job.failed) return 'Failed';
    if (job.done) return 'Completed';
    var last = job.steps[job.steps.length - 1];
    if (!last) return 'Queued';
    return STEP_PHASE[last.step] || 'Preparing';
  }

  function trackJob(jobId, label) {
    var job = { id: jobId, label: label, steps: [], pct: 0, phase: 'Queued', done: false, failed: false, startedAt: Date.now() };
    state.jobs.unshift(job);
    logActivity('plus', 'Started creating "' + label + '"');

    var ui = openJobModal(job);
    var source = new EventSource('/api/wa/restaurants/jobs/' + encodeURIComponent(jobId));

    source.onmessage = function (event) {
      var payload;
      try { payload = JSON.parse(event.data); } catch (err) { return; }

      if (payload.type === 'step') {
        var existing = job.steps.filter(function (item) { return item.step === payload.step; })[0];
        if (existing) { existing.status = payload.status; existing.detail = payload.detail; }
        else job.steps.push({ step: payload.step, status: payload.status, detail: payload.detail });
        var finished = job.steps.filter(function (item) { return item.status !== 'running'; }).length;
        job.pct = Math.round((finished / ALL_STEPS.length) * 100);
      } else if (payload.type === 'done') {
        job.done = true; job.pct = 100; job.tenant = payload.tenant; job.instanceId = payload.instanceId;
        source.close();
        toast('ok', 'Restaurant created', payload.instanceId);
        logActivity('ok', 'Created "' + label + '" as ' + payload.instanceId);
        loadRestaurants();
      } else if (payload.type === 'error') {
        job.done = true; job.failed = true; job.error = payload;
        source.close();
        toast('err', 'Provisioning failed at ' + (STEP_LABEL[payload.step] || payload.step), payload.message);
        logActivity('warn', 'Failed to create "' + label + '": ' + payload.message);
        loadRestaurants();
      }

      job.phase = phaseOf(job);
      ui.update();
      render();
    };

    source.onerror = function () {
      if (job.done) return;
      source.close();
      job.done = true;
      job.failed = true;
      job.error = { message: 'The progress stream was interrupted. The restaurant may still have been created — refresh to check.' };
      job.phase = 'Failed';
      ui.update();
      render();
      loadRestaurants();
    };
  }

  function openJobModal(job) {
    var handle = modal({
      title: 'Creating ' + job.label,
      subtitle: 'You can close this window; the job keeps running.',
      wide: true
    });

    function update() {
      var byName = {};
      job.steps.forEach(function (item) { byName[item.step] = item; });
      var tone = job.failed ? 'failed' : job.done ? 'done' : '';

      handle.body.innerHTML =
        '<div class="prov-phase">' +
          '<span class="lbl">' + esc(job.phase) + '</span>' +
          '<span class="prov-pct">' + job.pct + '%</span>' +
        '</div>' +
        '<div class="prov-track"><div class="prov-fill ' + tone + '" style="width:' + job.pct + '%"></div></div>' +
        '<div class="prov-steps">' + ALL_STEPS.map(function (name) {
          var entry = byName[name];
          var status = entry ? entry.status : 'idle';
          var mark = status === 'ok' ? '&#10003;' : status === 'failed' ? '!' : status === 'partial' ? '!' : '';
          return '<div class="prov-step" data-status="' + status + '">' +
            '<span class="mark">' + mark + '</span>' +
            '<span>' + esc(STEP_LABEL[name] || name) + '</span>' +
            (entry && entry.detail ? '<span class="detail">' + esc(entry.detail) + '</span>' : '') +
          '</div>';
        }).join('') + '</div>' +
        (job.failed && job.error
          ? '<div class="banner" style="margin-top:16px">' + ico('warn') +
            '<div><b>' + esc(job.error.error || 'Provisioning failed') + '</b><p>' + esc(job.error.message || '') +
            (job.error.rollback ? '<br>Rollback: ' + esc(String(job.error.rollback)) : '') + '</p></div></div>'
          : '') +
        (job.done && !job.failed
          ? '<div class="banner" style="margin-top:16px;background:var(--green-soft);border-color:var(--green)">' +
            ico('ok') + '<div><b>Ready</b><p>Instance <span class="mono">' + esc(job.instanceId || '') +
            '</span> was created. Scan its QR code from the restaurant row to connect WhatsApp.</p></div></div>'
          : '');

      handle.foot.innerHTML = '';
      handle.foot.appendChild(Object.assign(document.createElement('div'), { className: 'spacer' }));
      handle.foot.appendChild(button(job.done ? 'Close' : 'Run in background', job.done ? 'btn-primary' : 'btn-ghost', handle.close));
    }

    update();
    return { update: update };
  }

  // ------------------------------------------------------------- row actions

  function findRow(instanceId) {
    return state.restaurants.filter(function (row) { return row.instanceId === instanceId; })[0];
  }

  function openDetails(row) {
    var handle = modal({ title: row.brand || row.instanceId, subtitle: 'Instance ' + row.instanceId, wide: true });
    handle.body.innerHTML = '<dl class="kv">' +
      '<dt>Instance id</dt><dd><span class="chip-id">' + esc(row.instanceId) + '</span></dd>' +
      '<dt>Status</dt><dd>' + statusBadge(row) + '</dd>' +
      '<dt>WhatsApp</dt><dd class="mono">' + esc(row.whatsappPhone || '—') + '</dd>' +
      '<dt>Working hours</dt><dd>' + esc(row.workHours || '—') + '</dd>' +
      '<dt>Domain</dt><dd>' + esc(row.domain || '—') + '</dd>' +
      '<dt>Address</dt><dd>' + esc(row.address || '—') + '</dd>' +
      '<dt>Prompt</dt><dd>' + (row.systemPrompt ? esc(row.systemPrompt) : '<span class="dim">Uses the shared prompt</span>') + '</dd>' +
      '<dt>Credentials</dt><dd>' + (row.secrets && row.secrets.apiToken
        ? '<span class="badge badge-green"><i class="dot"></i>Provisioned</span>'
        : '<span class="badge badge-yellow"><i class="dot"></i>Incomplete</span>') +
        ' <span class="dim" style="font-size:12px">values are never shown</span></dd>' +
      '</dl>';
    handle.foot.appendChild(Object.assign(document.createElement('div'), { className: 'spacer' }));
    handle.foot.appendChild(button('Close', 'btn', handle.close));
  }

  function duplicateRow(row) {
    var handle = modal({ title: 'Duplicate restaurant', subtitle: 'Copies the name, hours, address and prompt. Nothing else is carried over.' });
    handle.body.innerHTML = field('dupname', 'Name for the copy', 'A fresh instance id and new secrets are generated. The copy starts disabled.',
      '<input class="input" id="wz-dupname" value="' + esc((row.brand || row.instanceId) + ' copy') + '">');

    var go = button('Duplicate', 'btn-primary', function () {
      var name = $('#wz-dupname', handle.body).value.trim();
      if (!name) {
        handle.body.querySelector('[data-field="dupname"]').classList.add('invalid');
        $('.err-text', handle.body).textContent = 'Give the copy a name';
        return;
      }
      go.disabled = true;
      go.textContent = 'Duplicating…';
      api.post('/api/wa/tenants/' + encodeURIComponent(row.instanceId) + '/duplicate', { brand: name })
        .then(function (data) {
          handle.close();
          toast('ok', 'Duplicated', data.instanceId);
          logActivity('copy', 'Duplicated "' + (row.brand || row.instanceId) + '" into ' + data.instanceId);
          loadRestaurants();
        })
        .catch(function (error) {
          go.disabled = false;
          go.textContent = 'Duplicate';
          toast('err', 'Could not duplicate', error.message);
        });
    });

    handle.foot.appendChild(button('Cancel', 'btn-ghost', handle.close));
    handle.foot.appendChild(Object.assign(document.createElement('div'), { className: 'spacer' }));
    handle.foot.appendChild(go);
  }

  function deleteRow(row) {
    confirmDialog({
      title: 'Delete ' + (row.brand || row.instanceId) + '?',
      subtitle: 'This cannot be undone.',
      body: 'The WhatsApp session, cached chats, Redis keys, QR session and the database record are all removed.',
      phrase: row.instanceId,
      confirmLabel: 'Delete permanently',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      api.del('/api/wa/tenants/' + encodeURIComponent(row.instanceId), { confirm: row.instanceId })
        .then(function () {
          toast('ok', 'Deleted', row.instanceId);
          logActivity('trash', 'Deleted "' + (row.brand || row.instanceId) + '"');
          loadRestaurants();
        })
        .catch(function (error) { toast('err', 'Could not delete', error.message); });
    });
  }

  function toggleActive(row) {
    var next = !row.active;
    api.post('/api/wa/tenants/' + encodeURIComponent(row.instanceId) + '/active', { active: next })
      .then(function () {
        toast('ok', next ? 'Enabled' : 'Disabled', row.instanceId);
        logActivity('power', (next ? 'Enabled' : 'Disabled') + ' "' + (row.brand || row.instanceId) + '"');
        loadRestaurants();
      })
      .catch(function (error) { toast('err', 'Could not update', error.message); });
  }

  function openRowMenu(anchor, row) {
    closeMenus();
    var menu = document.createElement('div');
    menu.className = 'menu';
    menu.innerHTML =
      '<button class="menu-item" data-do="view">' + ico('eye', 'ico-sm') + 'View details</button>' +
      '<button class="menu-item" data-do="duplicate">' + ico('copy', 'ico-sm') + 'Duplicate</button>' +
      '<button class="menu-item" data-do="toggle">' + ico('power', 'ico-sm') + (row.active ? 'Disable' : 'Enable') + '</button>' +
      '<div class="menu-sep"></div>' +
      '<button class="menu-item danger" data-do="delete">' + ico('trash', 'ico-sm') + 'Delete</button>';
    anchor.parentNode.appendChild(menu);

    menu.addEventListener('click', function (event) {
      var item = event.target.closest('[data-do]');
      if (!item) return;
      closeMenus();
      var action = item.getAttribute('data-do');
      if (action === 'view') openDetails(row);
      if (action === 'duplicate') duplicateRow(row);
      if (action === 'toggle') toggleActive(row);
      if (action === 'delete') deleteRow(row);
    });
  }

  function closeMenus() {
    Array.prototype.forEach.call(document.querySelectorAll('.menu'), function (node) { node.remove(); });
  }

  // ------------------------------------------------------------------- auth

  function showLogin() {
    $('#app').classList.add('is-hidden');
    $('#login').classList.remove('is-hidden');
    document.body.classList.remove('nav-open');
  }

  function showApp() {
    $('#login').classList.add('is-hidden');
    $('#app').classList.remove('is-hidden');
  }

  function bindLogin() {
    var form = $('#login-form');
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var user = $('#login-user').value.trim();
      var pass = $('#login-pass').value;
      var submit = $('#login-submit');
      var errBox = $('#login-error');
      errBox.classList.add('is-hidden');
      submit.disabled = true;
      submit.textContent = 'Signing in…';

      api.post('/api/whatspro/login', { username: user, password: pass })
        .then(function (data) {
          state.user = data.username || user;
          $('#login-pass').value = '';
          paintUser();
          showApp();
          loadRestaurants();
        })
        .catch(function (error) {
          var message = error.code === 'LOGIN_NOT_CONFIGURED'
            ? 'Login is not configured on the server.'
            : error.code === 'TOO_MANY_LOGIN_ATTEMPTS'
              ? 'Too many attempts. Wait a few minutes and try again.'
              : 'Wrong username or password.';
          errBox.textContent = message;
          errBox.classList.remove('is-hidden');
        })
        .then(function () {
          submit.disabled = false;
          submit.textContent = 'Sign in';
        });
    });
  }

  function paintUser() {
    $('#who').textContent = state.user || 'admin';
    $('#avatar').textContent = initials(state.user || 'admin');
  }

  function logout() {
    api.post('/api/whatspro/logout', {}).then(function () {
      state.restaurants = [];
      showLogin();
    }).catch(function () { showLogin(); });
  }

  // ------------------------------------------------------------------ theme

  var THEME_KEY = 'whatspro-theme';

  function applyTheme(name) {
    document.documentElement.setAttribute('data-theme', name);
    try { localStorage.setItem(THEME_KEY, name); } catch (err) { /* private mode */ }
  }

  // ------------------------------------------------------------------- wire

  function bindChrome() {
    document.addEventListener('click', function (event) {
      if (!event.target.closest('.menu-wrap')) closeMenus();

      var sideLink = event.target.closest('.side-link[data-view]');
      if (sideLink) {
        state.view = sideLink.getAttribute('data-view');
        document.body.classList.remove('nav-open');
        render();
        return;
      }

      var act = event.target.closest('[data-act]');
      if (act) {
        var action = act.getAttribute('data-act');
        if (action === 'create') openWizard();
        if (action === 'retry') loadRestaurants();
        if (action === 'clear-search') { state.query = ''; $('#search').value = ''; render(); }
        if (action === 'clear-activity') {
          state.activity = [];
          try { localStorage.removeItem(ACTIVITY_KEY); } catch (err) { /* ignore */ }
          render();
        }
        return;
      }

      var sortHead = event.target.closest('th[data-sort]');
      if (sortHead) {
        var key = sortHead.getAttribute('data-sort');
        state.sort = { key: key, dir: state.sort.key === key ? -state.sort.dir : 1 };
        render();
        return;
      }

      var menuBtn = event.target.closest('.row-menu');
      if (menuBtn) {
        event.stopPropagation();
        var id = menuBtn.closest('tr').getAttribute('data-id');
        var row = findRow(id);
        if (row) openRowMenu(menuBtn, row);
        return;
      }

      var jobBtn = event.target.closest('[data-job]');
      if (jobBtn) {
        var job = state.jobs.filter(function (item) { return item.id === jobBtn.getAttribute('data-job'); })[0];
        if (job) openJobModal(job);
      }
    });

    $('#search').addEventListener('input', debounce(function (event) {
      state.query = event.target.value;
      render();
    }, 120));

    $('#search-clear').addEventListener('click', function () {
      state.query = '';
      $('#search').value = '';
      render();
    });

    $('#refresh').addEventListener('click', function () {
      var btn = $('#refresh');
      btn.classList.add('spinning');
      loadRestaurants().then(function () {
        setTimeout(function () { btn.classList.remove('spinning'); }, 300);
      });
    });

    $('#jobs-pill').addEventListener('click', function () { state.view = 'jobs'; render(); });
    $('#logout').addEventListener('click', logout);
    $('#burger').addEventListener('click', function () { document.body.classList.toggle('nav-open'); });
    $('#scrim').addEventListener('click', function () { document.body.classList.remove('nav-open'); });
    $('#theme').addEventListener('click', function () {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });
  }

  function paintIcons() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-ico]'), function (node) {
      node.innerHTML = ico(node.getAttribute('data-ico')) + node.innerHTML;
    });
  }

  function boot() {
    try { applyTheme(localStorage.getItem(THEME_KEY) || 'light'); } catch (err) { applyTheme('light'); }
    loadActivity();
    paintIcons();
    bindChrome();
    bindLogin();

    api.get('/api/whatspro/session')
      .then(function (data) {
        state.user = data.username || 'admin';
        paintUser();
        showApp();
        loadRestaurants();
      })
      .catch(function () { showLogin(); });

    // Keep relative timestamps and live statuses honest without a page reload.
    setInterval(function () {
      if ($('#app').classList.contains('is-hidden')) return;
      if (openModals.length) return;
      loadRestaurants();
    }, 30000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
