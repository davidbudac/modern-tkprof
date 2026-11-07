// Download panel on the landing page.
//
// The HTML carries working links to a known release (the no-JS fallback).
// This script (1) picks the visitor's operating system and shows its panel,
// (2) asks GitHub for the latest release and, only if every installer is in
// it, points the links at that release. If the request fails the links keep
// the release written in the HTML.
(function () {
  'use strict';

  var REPO = 'davidbudac/modern-tkprof';
  var FALLBACK_VERSION = '0.5.0';

  // key -> file name for a version, what the button says, size in bytes (fallback)
  var ASSETS = {
    'dmg-arm':   { name: function (v) { return 'mtkprof_' + v + '_aarch64.dmg'; },      meta: 'Apple Silicon · .dmg', alt: 'Apple Silicon Mac', kind: '.dmg',      size: 10993997 },
    'dmg-x64':   { name: function (v) { return 'mtkprof_' + v + '_x64.dmg'; },          meta: 'Intel · .dmg',         alt: 'Intel Mac',         kind: '.dmg',      size: 11958398 },
    'win-setup': { name: function (v) { return 'mtkprof_' + v + '_x64-setup.exe'; },    meta: 'Windows 10/11 x64 · installer', kind: '.exe', size: 7691342 },
    'appimage':  { name: function (v) { return 'mtkprof_' + v + '_amd64.AppImage'; },   meta: 'x64 · AppImage',      kind: '.AppImage', size: 107067896 },
    'deb':       { name: function (v) { return 'mtkprof_' + v + '_amd64.deb'; },        alt: 'Debian and Ubuntu',    kind: '.deb',      size: 12216186 },
    'cli-darwin-arm64': { name: function () { return 'mtkprof-darwin-arm64'; } },
    'cli-darwin-amd64': { name: function () { return 'mtkprof-darwin-amd64'; } },
    'cli-linux-amd64':  { name: function () { return 'mtkprof-linux-amd64'; } },
    'cli-linux-arm64':  { name: function () { return 'mtkprof-linux-arm64'; } },
    'cli-win':          { name: function () { return 'mtkprof-windows-amd64.exe'; } }
  };
  var INSTALLERS = ['dmg-arm', 'dmg-x64', 'win-setup', 'appimage', 'deb'];

  var root = document.getElementById('download');
  if (!root) return;
  document.documentElement.classList.add('js');

  var sizes = {};
  Object.keys(ASSETS).forEach(function (k) { sizes[k] = ASSETS[k].size; });
  var version = FALLBACK_VERSION;

  function mb(bytes) { return (bytes / 1e6).toFixed(1) + ' MB'; }
  function url(key) {
    return 'https://github.com/' + REPO + '/releases/download/v' + version + '/' + ASSETS[key].name(version);
  }

  // Which of the two Mac builds comes first. Safari and Firefox hide the CPU,
  // so Apple Silicon is the default and the Intel build stays one click away.
  var macFirst = 'dmg-arm';

  function fill(el, key, asMain) {
    var a = ASSETS[key];
    el.href = url(key);
    el.setAttribute('data-asset', key);
    if (!a.size) return;
    if (asMain) {
      var meta = el.querySelector('[data-meta]');
      if (meta) meta.textContent = a.meta + ' · ' + mb(sizes[key]);
    } else {
      el.firstChild.textContent = a.alt + ' ';
      var s = el.querySelector('.dl-size');
      if (s) s.textContent = a.kind + ' · ' + mb(sizes[key]);
    }
  }

  function render() {
    root.querySelector('[data-dl-version]').textContent = version;
    var mac = root.querySelector('[data-os="mac"]');
    var other = macFirst === 'dmg-arm' ? 'dmg-x64' : 'dmg-arm';
    fill(mac.querySelector('.dl-main'), macFirst, true);
    fill(mac.querySelector('.dl-alt a'), other, false);
    fill(root.querySelector('[data-os="win"] .dl-main'), 'win-setup', true);
    fill(root.querySelector('[data-os="linux"] .dl-main'), 'appimage', true);
    fill(root.querySelector('[data-os="linux"] .dl-alt a'), 'deb', false);
    root.querySelectorAll('.dl-cli a[data-asset]').forEach(function (el) {
      el.href = url(el.getAttribute('data-asset'));
    });
  }

  // ---- operating system ----
  function detectOS() {
    var q = /[?&]os=(mac|win|linux)\b/.exec(location.search);
    if (q) return q[1];
    var uad = navigator.userAgentData;
    var p = (uad && uad.platform) || navigator.platform || '';
    var ua = navigator.userAgent || '';
    if (/win/i.test(p) || /Windows/.test(ua)) return 'win';
    if (/mac|iphone|ipad/i.test(p) || /Mac OS X/.test(ua)) return 'mac';
    if (/linux|x11|cros/i.test(p) || /Linux|X11|CrOS/.test(ua)) return 'linux';
    return 'mac';
  }

  var tabs = root.querySelectorAll('[data-os-tab]');
  var panels = root.querySelectorAll('.dl-panel');
  function show(os) {
    panels.forEach(function (p) { p.hidden = p.getAttribute('data-os') !== os; });
    tabs.forEach(function (t) { t.setAttribute('aria-pressed', String(t.getAttribute('data-os-tab') === os)); });
  }
  root.querySelector('.dl-tabs').hidden = false;
  tabs.forEach(function (t) {
    t.addEventListener('click', function () { show(t.getAttribute('data-os-tab')); });
  });

  var os = detectOS();
  var uad = navigator.userAgentData;
  if (os === 'mac' && uad && uad.getHighEntropyValues) {
    uad.getHighEntropyValues(['architecture']).then(function (v) {
      if (v.architecture === 'x86') { macFirst = 'dmg-x64'; render(); }
    }).catch(function () {});
  }
  render();
  show(os);

  // ---- copy the install command ----
  root.querySelectorAll('.dl-copy').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.parentNode.querySelector('pre').textContent.replace(/^\$ /, '').trim();
      var done = function () {
        btn.classList.add('copied');
        setTimeout(function () { btn.classList.remove('copied'); }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {});
      }
    });
  });

  // ---- latest release ----
  if (!window.fetch) return;
  fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
    .then(function (rel) {
      var v = String(rel.tag_name || '').replace(/^v/, '');
      if (!/^\d+\.\d+\.\d+/.test(v)) return;
      var have = {};
      (rel.assets || []).forEach(function (a) { have[a.name] = a.size; });
      // Use the release only when it has all the installers and CLI binaries.
      var complete = Object.keys(ASSETS).every(function (k) { return have[ASSETS[k].name(v)] !== undefined; });
      if (!complete) return;
      INSTALLERS.forEach(function (k) { sizes[k] = have[ASSETS[k].name(v)]; });
      version = v;
      render();
    })
    .catch(function () {});
})();
