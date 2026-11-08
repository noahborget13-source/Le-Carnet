/* Mention du propriétaire : lit la ligne publique « ownership » (remise du Carnet à Camélia Borget) et adapte les pages statiques. */
(function () {
  var URL = 'https://ovkjhtqzbgdlylxhhkjc.supabase.co/rest/v1/platform_settings?select=value&key=eq.ownership&limit=1';
  fetch(URL, { headers: { apikey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im92a2podHF6YmdkbHlseGhoa2pjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0OTU4MTksImV4cCI6MjEwNjA3MTgxOX0.NQO0H7ZktUqfcot_eW6ApKSHOLaaS2Qc9xajCqeYjA4' } }).then(function (r) { return r.ok ? r.json() : []; }).then(function (rows) {
    var v = rows && rows[0] && rows[0].value; if (!v || !v.active) return;
    var name = String(v.name || 'Camélia Borget').replace(/[<>&"]/g, '');
    document.querySelectorAll('[data-owner-credit]').forEach(function (el) { el.textContent = 'Offert à ' + name + ' par Noah Borget, son créateur'; });
    document.querySelectorAll('[data-owner-intro]').forEach(function (el) { el.textContent = 'créée par Noah Borget et offerte à ' + name + ', qui en assure la direction'; });
    if (document.body.hasAttribute('data-owner-banner')) {
      var b = document.createElement('div'); b.setAttribute('data-owner-banner-msg', ''); b.setAttribute('role', 'note');
      b.style.cssText = 'background:#0B1E3F;color:#fff;text-align:center;font:500 14px/1.4 system-ui,sans-serif;padding:9px 14px';
      b.textContent = '🎂 Le Carnet est offert à ' + name + ', qui en prend la direction — un cadeau de Noah Borget, son créateur.';
      document.body.insertBefore(b, document.body.firstChild);
    }
  }).catch(function () {});
})();
