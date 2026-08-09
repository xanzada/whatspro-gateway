(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var instanceId = new URLSearchParams(location.search).get('instance') || 'prestige';
  $('cw-instance').textContent = instanceId;

  var lastQr = null;

  function show(message) {
    $('cw-frame').replaceChildren(Object.assign(document.createElement('span'), {
      id: 'cw-status', textContent: message
    }));
  }

  function showDone() {
    var mark = document.createElement('span');
    mark.setAttribute('aria-hidden', 'true');
    mark.style.cssText = 'font-size:56px;color:#159c7c';
    mark.textContent = '✓';
    var text = document.createElement('p');
    text.textContent = 'Байланысты. Бот енді қоңырауды көреді.';
    $('cw-frame').replaceChildren(mark);
    $('cw-frame').appendChild(text);
  }

  // The socket, not this page, decides when onboarding is finished, so the poll
  // keeps running until the API reports connected.
  async function poll() {
    try {
      var response = await fetch('/api/wa/tenants/' + encodeURIComponent(instanceId) + '/call-watcher', {
        credentials: 'same-origin',
        cache: 'no-store'
      });
      if (response.status === 401) return show('Кіру қажет: әуелі /tenants бетіне кіріңіз.');
      var data = await response.json();

      if (data.connected) {
        showDone();
        return;
      }
      if (data.qr && data.qr !== lastQr) {
        lastQr = data.qr;
        var image = new Image();
        image.alt = 'QR';
        image.src = data.qr;
        $('cw-frame').replaceChildren(image);
      } else if (!data.qr && !lastQr) {
        show(data.watching ? 'QR дайындалуда…' : 'Бақылаушы іске қосылмаған.');
      }
    } catch (error) {
      show('Байланыс үзілді, қайта қосылуда…');
    }
    setTimeout(poll, 3000);
  }

  poll();
})();
